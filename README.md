# @openemail/sieve

An RFC 5228 **Sieve** interpreter for TypeScript, hardened for untrusted scripts
and untrusted mail. Framework-agnostic: you implement
`Message`/`Envelope`/`PolicyReader`, `load()` a script, execute it, and read the
accumulated actions. Runs in Cloudflare Workers, Node, Deno, and the browser —
no Node built-ins, no MIME-parser dependency, no I/O inside the library.

## Why native TypeScript (not WASM)

The delivery pipeline that consumes this library runs in a V8 isolate (a
Cloudflare Worker), where a WASM-compiled interpreter is awkward and heavy. A
native TypeScript engine keeps everything on the host and — importantly — lets
it stay **ReDoS-safe**: `:matches` and `:regex` never touch JavaScript's
backtracking `RegExp`. They run on a built-in linear-time engine (Thompson NFA +
Pike VM, RE2-style), with caps on pattern length, compiled-program size,
repetition counts, and input length, plus a cooperative CPU budget. Behaviour is
validated against an extensive conformance corpus (see [Development](#development)).

## Usage

```ts
import { load, newRuntimeData, DummyPolicy, EnvelopeStatic, MessageStatic } from "@openemail/sieve";

const script = load(
  `require ["fileinto", "imap4flags"];
   if header :contains "subject" "[urgent]" {
     setflag "\\\\Flagged";
     fileinto "Important";
   }`,
  {
    enabledExtensions: ["fileinto", "envelope", "imap4flags", "subaddress", "copy"],
    maxExecSteps: 100_000, // deterministic CPU cap — recommended in a Worker
  },
);

const headers = new Map([["subject", ["[URGENT] deploy is down"]]]);
const d = newRuntimeData(
  script,
  new DummyPolicy(),
  new EnvelopeStatic("a@x.example", "b@y.example"),
  new MessageStatic(1024, headers),
);
script.execute(d);

d.mailboxes;     // ["Important"]
d.flags;         // ["\\flagged"]
d.implicitKeep;  // false
d.redirectAddr;  // []
```

`load()` throws a `SieveError` (with `line`/`col` when known) on any lex, parse,
or load failure — including a `require` for an extension you did not enable —
so a user uploading a script learns exactly what won't run *before* mail
arrives. `execute()` throws `SieveError` on runtime errors (a `maxExecSteps`
smaller than the script's own commands, conflicting reject actions under
`strictReject`, …); treat
that as "script failed, fall back to implicit keep". Because a throw skips every
rule, message content must not cause one: the `body` test does not throw on
malformed MIME (broken transfer encodings decode leniently, and structure past
the caps below is "unknown"), and a test that runs out of its share of
`maxExecSteps` answers "unknown" while the script runs on (`budgetExhausted`).
A `:matches`/`:regex` key holding a variable reference compiles when the test
runs; if the expanded text does not compile, or is past the pattern-length
cap, the comparison is "unknown" rather than an error. An `envelope`
envelope-part built from a variable that names no part the test reads has no
value, like a missing header. No other value from the message is known to
reach a throw; by default the runtime error left (a `maxExecSteps` below the
commands a run dispatches) is the script's own. Past `maxRedirects` or
`maxFileintos` a target is dropped and sets `indeterminate`, not thrown; a
second reject is not executed, and a reject beside `keep`, `fileinto`,
`redirect` or `vacation` (RFC 5429 §2.4) sets `indeterminate` and
`rejectConflict`, not thrown, unless `strictReject` asks for Pigeonhole's
error.

### What the host implements

| Interface | Purpose |
| --- | --- |
| `Message` | `headerGet(name)` (case-insensitive, values in order), `messageSize()`, `bodyRaw()` (`null` ⇒ `body` test never matches, and a multipart message's parts are unseen to `:mime`/`foreverypart`). Implement over your MIME source (e.g. `postal-mime`). |
| `Envelope` | SMTP `MAIL FROM`, `RCPT TO`, and the authenticated username. |
| `PolicyReader` | `redirectAllowed(d, addr)` — gate/rate-limit/validate redirect targets. `DummyPolicy` allows everything. |
| `MailboxChecker` (optional, `d.mailboxChecker`) | Backs `mailboxexists`; when absent the test is optimistic ("exists"). |

### What the host reads back from `RuntimeData`

| Field | Meaning |
| --- | --- |
| `implicitKeep` | `true` unless a canonical action (`fileinto`/`redirect`/`discard` without `:copy`, a `reject`/`ereject` that stands) cancelled it. Decided when `execute()` returns: a reject cancels it only once the script has run. If `implicitKeep \|\| keep`, deliver to INBOX. |
| `keep` | An explicit `keep;` ran. |
| `mailboxes` / `mailboxesCreate` | `fileinto` targets (deduped, at most `maxFileintos`); the subset flagged `:create` (RFC 5490) should be auto-created. A host may append to `mailboxes` or `redirectAddr` during a run (from its policy), but not edit or remove an entry: the commands index both lists by their length. |
| `redirectAddr` | `redirect` targets that passed your policy: one per address, at most `maxRedirects`. A bare address is the same whatever its surrounding space and its domain's case, and the first spelling is kept; any other form (display name, angle brackets, quotes, a comment or group) is its own spelling. An address the policy allowed is not shown to it again; one it refused is asked again. |
| `flags` | The final IMAP flag set (RFC 5232), canonicalised: lowercased, deduped, sorted. |
| `headerEdits` | The RFC 5293 `addheader`/`deleteheader` ledger. Tests inside the script already see the edits; apply the ledger yourself if the *stored* message should change. An added value holds no CR, LF or NUL, but is otherwise as the script built it: fold and encode it when you serialise it (it may pass RFC 5322's 998-octet line limit, carry non-ASCII text, or Unicode separators such as U+2028). An edit's `mark` says an added value was built from one the engine could not hold whole (see `indeterminate`), and on a delete by value, which occurrence it matched: a host replaying by text alone may remove another of the same text. |
| `indeterminate` | An "unknown" decided a branch: a comparison over a cut input, structure past the MIME caps, a key that did not compile, a test out of its budget share, or a test reading a value the engine could not hold whole. Such a value is marked, not the run: a variable cut to `maxVariableLen`, `extracttext`'s text from a cut part, a match variable captured from a cut input, or one an "unknown" may have changed: earlier in its own test, or in the test of an `if`/`elsif` that answered unknown. A test that reads a value marked as a prefix answers what the prefix proves (a `:contains` that finds its key is true), and one in doubt (text after the prefix, its `:length`, a `:regex` capture) is unknown; storing, filing by or using such a value decides nothing and discloses nothing, except a `redirect` to it, or a field name `addheader` or `deleteheader` builds from it, which is dropped and disclosed. A field `addheader` adds from it keeps the mark for every later `header`, `address`, `date` and `deleteheader` read of the field (a prefix holding an encoded word is in doubt), and so does the internal flag set for `hasflag`. (A `set` of a literal, or a `setflag` of a literal list, is cut the same way every time and is not marked; `addflag` joins onto what the variable held, so its cut is.) Also set when a `fileinto` or `redirect` past its limit was dropped, and when a reject stood beside a delivering action (`rejectConflict`). The actions are a best-effort reading: refuse the irreversible ones (discard, redirect without keep, reject) and let the rest stand. |
| `redirectsOnGuess(d)` / `vacationOnGuess` / `rejectOnGuess` | The redirect targets, and whether the vacation response, that an unknown decided, and whether a reject may have run over the whole input. A redirect or vacation is on a guess when it ran in an arm an unknown chose, or after an unknown-decided arm, loop or header edit that could change what runs after it: a `stop`, a variable or header write, a `reject`, a test whose captures a later reference reads, a redirect that counts toward `maxRedirects`, or a flag write (`setflag`/`addflag`/`removeflag`, `discard`, and the `:flags` of `keep` and `fileinto`) in a script with a `hasflag` test. An arm that only files, keeps or tags changes nothing after it, so a body rule that misses over a cut body does not put an unrelated forward after it on a guess (a `fileinto` does count in a script that tests flags and can reach `maxFileintos`, since it decides whether a later one and its `:flags` are dropped). The vacation response is the last one recorded: it is on a guess when that one ran on a guess or was built from a value the engine could not hold whole (its text, `:handle` or `:addresses`; or a later vacation recorded nothing because an `:addresses` entry in doubt matched the sender), or an arm that may be the whole input's was skipped after it holding a vacation that could have replaced it. `rejectOnGuess` is set when such an arm or loop holds a `reject`. An arm may be the whole input's when an unknown decided it, or when it was skipped while a guess was in force: by a definite test over state a guess wrote, or because an earlier arm of its chain ran on a guess. A `stop` or `break` that runs while a guess is in force may cut off what the whole input runs after it: the script's rejects and vacations count as skipped. A forward or an auto-reply cannot be recalled: a host that refuses the irreversible outcomes of an indeterminate run can withhold these and send the rest, and keep from answering a sender the script may have refused. A target also redirected to outside a guess is no guess. |
| `budgetExhausted` | A test ran out of its share of `maxExecSteps` and answered "unknown". The script completed; this says why it guessed. |
| `vacationResponses` | RFC 5230 vacation **intents**, keyed by envelope-from. The host owns the actual send, the `:days`/`:handle` dedup database, and the RFC 5230 §4.5 loop-prevention checks (`Auto-Submitted`, list headers, "am I in To/Cc?"). |
| `rejected` / `rejectReason` / `rejectExtended` / `rejectConflict` | RFC 5429: a `reject` (or, with `rejectExtended`, an `ereject`) ran, with its reason after variable expansion; when it stands, the implicit keep is cancelled. Beside `keep`, `fileinto`, `redirect` or `vacation` it does not stand: `rejectConflict` names the action, `indeterminate` is set, and everything else is as if the reject had not run, so refuse the reject and deliver the rest. Otherwise the host refuses the message — RFC 5429 asks for a protocol-level 5xx where possible, else a DSN (ereject) or failure MDN (reject), never to a null or forged sender; a host that can only drop it departs from the RFC (§2.1: no ereject without protocol refusal) and leaves the sender uninformed. `rejectReason` is **untrusted text**: variables can carry decoded CR/LF and non-ASCII from the message, so a host writing it into an SMTP reply must apply §2.5's multi-line and §2.1.1's ASCII rules. Header edits (`headerEdits`) must not reach a generated MDN/DSN (§2.4). Treat a reject like a discard when `indeterminate` is set. |

## Supported extensions

Everything below is implemented and require-gated. A `require` for anything
else — or for a name you left out of `enabledExtensions` — fails at load.

| `require` name | RFC | Notes |
| --- | --- | --- |
| *(core)* | 5228 | `if`/`elsif`/`else`, `stop`, `keep`, `discard`; `address`, `header`, `exists`, `size`, `allof`, `anyof`, `not`, `true`, `false`; `:is`/`:contains`/`:matches` |
| `encoded-character` | 5228 §2.4.2.4 | `${hex:…}`/`${unicode:…}` decoded at load |
| `fileinto` | 5228 | plus `:flags`, `:copy`, `:create` (gated on their extensions) |
| `envelope` | 5228 | parts: `from`, `to`, `auth` |
| `copy` | 3894 | `:copy` on `fileinto`/`redirect` |
| `body` | 5173 | `:raw`/`:text`/`:content`; hand-rolled byte-level MIME walker that lists a multipart's parts as core's walker does (see Known limitations), QP/base64 + charset decode, HTML→text for `:text` (tokenizer rules: attribute-aware tags, script/style/comments and the hidden raw-text elements dropped, textarea/xmp kept, every WHATWG character reference decoded). Content is dropped up to a far terminator only where the browser's tokenizer state is decidable here; from the first `svg`, `math`, `select` or `noscript` tag or escaped script on, nothing is dropped beyond the next `>` and raw text is kept (a region holding `&` both literally and decoded) — so markup cannot hide the rest of the body, at the cost of matching stylesheets in such mail, where a whole-part `:is` can also miss |
| `variables` | 5229 | `set` + modifiers, `string` test, `${name}`, match variables `${0}…${N}`, `envelope.*` namespace (needs `require "envelope"`; any other namespace is refused at load, RFC 5229 §3) |
| `vacation` | 5230 | records intent only — see table above |
| `reject` / `ereject` | 5429 | records the refusal only — see table above. §2.4 is enforced. A second reject is not executed when it runs: the first's reason and kind stand (§2.3 never turns one into the other). A reject next to `vacation`, `keep`, `fileinto` or `redirect` (`:copy` included) is found once the script has run, whatever the order (in a testsuite script, at the end of each `test` block): it does not stand, and sets `rejectConflict` (the first of keep, fileinto, redirect, vacation) and `indeterminate`. Under `strictReject`, and in a testsuite script, both are runtime errors, as in Pigeonhole |
| `relational` | 5231 | `:value`/`:count` on `address`/`envelope`/`header`/`string`/`hasflag`/`date`/`currentdate`/`body` |
| `imap4flags` | 5232 | `setflag`/`addflag`/`removeflag` (incl. the `<variablename>` form), `hasflag` (incl. the variable-list form, with per-flag membership matching), `:flags` on `keep`/`fileinto` |
| `subaddress` | 5233 | `:user`/`:detail` (separator `+`) |
| `date` | 5260 | `date`/`currentdate`, all date-parts, `:zone`/`:originalzone`; `Received:` headers extract the date after the final `;` |
| `index` | 5260 | `:index`/`:last` on `header`, `address`, and `date` |
| `mime` / `foreverypart` / `extracttext` | 5703 | `:mime` and `:anychild` on `header`, `address` and `exists`; `:type`, `:subtype`, `:contenttype` and `:param` (RFC 2231 continuations and charsets) on `header`; `foreverypart [:name]` (nested up to four deep, as in Pigeonhole) and `break [:name]`. `address :mime` reads any header field, not only the address headers; `:index`/`:last` are ignored with `:mime` (as in go-sieve). The part tree is built once per message from the same Content-Type field, boundary parameter and splitter the `body` test uses, under the same caps, so the two never disagree about which parts exist; a multipart with no part found (or no boundary) has the one `text/plain; charset=utf-8` child core synthesizes, with no header fields. Over a cut body — or a body the host did not read (`bodyRaw()` null) under a multipart root — every unseen part comes after the seen ones, so an `:anychild` miss that may continue is "unknown", and a loop that reaches the end of a part list that may continue sets `indeterminate`. Each part a test examines, each header value it reads (sized on first parse) and each part a loop walks costs steps, and loop iterations spend a share of `maxExecSteps`: a loop that runs out stops, disclosed the same way. With `foreverypart` enabled, set `maxExecSteps`: nested loops over a deep tree are otherwise unbounded in practice. `extracttext [:first N] [modifiers] var` (inside a loop; needs `foreverypart` and `variables`) stores the current part's text: transfer- and charset-decoded, HTML reduced to text, at most `maxMatchInputLength` octets (or the engine's default); a part holding parts, or a charset the runtime cannot decode, gives "". A value the read-window cut, that limit or the variable's own `maxVariableLen` left incomplete is marked as a prefix of the real one (see `indeterminate`), unless `:first` asked for no more than was read. Each call is charged by the text's size. `replace` and `enclose` are not implemented |
| `editheader` | 5293 | virtual: edits go to the `headerEdits` ledger and are replayed on every header read; protected headers (`Received`, `Auto-Submitted`) are immune. At most 1024 edits and 1 MiB of added values per execution (`foreverypart` repeats commands); an edit past either is dropped and sets `indeterminate` |
| `mailbox` | 5490 | `mailboxexists`, `fileinto :create` |
| `regex` | draft-murchison-sieve-regex | on the linear engine: classes, alternation, bounded `{n,m}`, anchors, `\b`, inline `(?ism)` flags; **no** backreferences or lookaround (rejected at load). Over a cut input, a match is "unknown" when it relied on `$`, `\z`, `\b` or `\B` at the cut: those look at what follows, and the whole input goes on |
| `comparator-i;octet`, `comparator-i;ascii-casemap`, `comparator-i;ascii-numeric`, `comparator-i;unicode-casemap` | 4790/5228 | `i;octet` and `i;ascii-casemap` are built-in; the other two must be required (RFC 5228 §2.7.3) |

There is also a `vnd.dovecot.testsuite` gate (`Options.testEnv`) implementing the
in-Sieve test DSL (`test`/`test_set`/`test_fail`/`test_config_set`,
`test_script_compile`/`test_script_run`/`test_error`) used to run the Dovecot
Pigeonhole conformance corpus against the interpreter itself. `require
"vnd.dovecot.testsuite"` succeeds **only** when `Options.testEnv` is set, so the
DSL is a development/validation facility and is inert for production scripts.

## Options

All limits ship with safe defaults (shown); `0` means unlimited where noted.

| Option | Default | Purpose |
| --- | --- | --- |
| `maxTokens` | 5000 | lexer token cap |
| `maxBlockNesting` / `maxTestNesting` | 15 / 15 | parser nesting caps |
| `maxRedirects` / `maxFileintos` | 5 / 32 | distinct `redirect` addresses and `fileinto` targets per execution (`0` allows none). Inside a `foreverypart` loop the message decides how many a script files into or redirects to; one past the limit is dropped and sets `indeterminate`, and the rest of the script runs. A repeat of a target already held is not a new one. |
| `maxVariableCount` / `maxVariableNameLen` / `maxVariableLen` | 128 / 63 / 4000 | RFC 5229 limits; a value past the length limit is cut at a character boundary and marked as a prefix of the real one (see `indeterminate`), a name past it fails at load |
| `maxMatchInputLength` | 0 (engine default, 256 KiB) | truncate values before `:matches`/`:regex`; a comparison over a cut value is three-valued. Also the octets `extracttext` decodes per part |
| `maxExecSteps` | 0 (off) | cooperative CPU budget ticked in command dispatch, match loops, and the regex VM inner loop — **set this in a Worker**. Each test (and `deleteheader`'s matching) spends a share: everything left except one step per command and a reserve for each test after it (1/1024 of the budget, at most half of what is left). A test out of its share is "unknown" and the script runs on; one expensive test cannot starve the rest, but many in a row leave less for each test after them. A `foreverypart` loop spends a share the same way, and inside it a command is charged by the size of its work: the `${…}` templates it scans and what they expand to, `set`'s modifiers and the value it stores, the value `addheader` folds, and the flags an imap4flags command handles. A test is charged a step per field it names; inside a loop, and for a part's header read with `:mime`, also a step per value it finds and the size of each value it decodes or parses as addresses. At top level a test runs once, and a charge there by the values' count or size would let a repeated or large header, with a body test that spends the budget, cost the rules after it their reserve. A top-level command is charged one step: it runs once. |
| `strictReject` | `false` | RFC 5429 §2.4 conflicts throw, as in Pigeonhole: a second `reject`/`ereject`, or one beside `keep`, `fileinto`, `redirect` or `vacation`. Off, a second reject is not executed (the first's reason and kind stand) and a conflict sets `rejectConflict` and `indeterminate`. A testsuite script is always strict. A throw fails the whole script, the message picks the branches that reach a conflict, and inside a `foreverypart` loop it decides how many rejects run |
| `enabledExtensions` | `null` (none) | allow-list for `require` |

Independent of options, the regex engine enforces: pattern ≤ 1000 chars,
compiled program ≤ 10 000 instructions and ≤ 100 000 compile calls (a key
compiled at delivery is charged for them to the budget each time its
expansion changes), `{n,m}` counts ≤ 1000, ≤ 250 nested
groups and ≤ 500 levels of compiler recursion (quantifiers stacked on groups
deepen it too; a `{n,}` counts twice), input ≤ 256 KiB unless
`maxMatchInputLength` sets another cut (byte-truncated at a character
boundary, and evaluated as a cut), and it charges every VM step to the
execution budget.

## Robustness properties

- **No backtracking anywhere.** `:matches`/`:regex` compile to a Pike-VM
  program that is O(program × input); scanning (`${…}` expansion, RFC 2047
  decode, MIME walking and part headers, date parsing) is linear: no regular
  expression that can backtrack runs on attacker-controlled text.
- **Load-time failure over delivery-time failure.** Patterns without variable
  references (and all structural/require errors) fail at `load()` — i.e. at
  script upload, not when a message arrives. A pattern built from variables
  can only be compiled at delivery, and one that does not compile answers
  "unknown" instead of throwing.
- **Header-injection guard.** `addheader` puts its value on one line before it
  reaches `headerEdits` (a fold is removed, any other line break becomes a
  space, a NUL is dropped), so a variable smuggled out of a hostile message
  can't append extra header fields when the host serialises the ledger, nor
  make `execute()` throw. A NUL written in the script fails at `load()`.
- **Prototype-safety.** Attacker-keyed collections (variables, vacation
  responses, header maps) are `Map`s, never plain objects.
- **Deterministic.** No `Intl`, no locale, no system timezone: `date` defaults
  to UTC (`:zone`/`:originalzone` for offsets), so a Worker and a test machine
  agree. Only `currentdate` reads the clock.

## Deliberate RFC-correctness choices

A few behaviours are worth calling out explicitly, since implementations differ
on them and this one follows the RFC strictly:

- **Comparator gating (RFC 5228 §2.7.3):** `i;ascii-numeric` and
  `i;unicode-casemap` demand `require "comparator-i;…"`; a bare use fails at
  load.
- **`:regex` gating:** `require "regex"` is enforced centrally for every test,
  including `address` and `envelope`.
- **`i;ascii-numeric` (RFC 4790 §9.1.1):** values compare by their leading
  digit prefix (`"42 points"` = 42); non-numeric strings are +infinity — for
  `:is`, `:value`, and `:count` keys alike.
- **`hasflag` (RFC 5232 §5)** and **`:index`/`:last` on `header`/`address`
  (RFC 5260 §6)** are fully implemented.
- **imap4flags variable form (RFC 5232 §5):** `setflag`/`addflag`/`removeflag
  <variablename> <flags>` store an order-preserving, deduped flag string in the
  named variable, and `hasflag` splits its key list into individual flag names and
  matches by membership.
- **`date` on `Received:` headers (RFC 5260 §4):** the date-time is taken from the
  segment after the final semicolon, not the whole field.
- **Trailing backslash in `:matches`** stays a literal backslash with the match
  still anchored, rather than silently degrading the pattern to a prefix match.
- **Errors throw** (`SieveError` with `line`/`col`) rather than being returned
  alongside a value.
- The address-list parser is a compact RFC 5322 subset (no external MIME
  dependency): display-name and bare `<addr>` forms, quoted names, and groups,
  whose members are matched and whose name never is (RFC 5228 §5.1);
  unparseable values fall back to literal matching.

## Known limitations

- `Envelope` carries a single address per part, not a recipient list.
- The `address` test only inspects a fixed allow-list of address-bearing
  headers (From/To/Cc/…); other header names are silently skipped per RFC 5228
  §5.1's "MUST restrict" guidance.
- The `body` walker is an approximation of a full MIME parser (byte-exact
  boundaries). It lists a multipart's parts as core's MIME walker (a port of
  go-message) does, so a part the user's mail client shows is one a rule
  sees, and a part it does not show is not: the first delimiter line sets LF
  or CRLF for the multipart; a part ends where a line starts with the
  boundary and then `-`, padding or the line break (or anything, for a
  boundary of 4092 bytes, 4093 with LF, which with its line break and dashes
  fills core's 4096-byte buffer); and the list ends at the close delimiter,
  at any other line where a delimiter line should be (`--b-alt` under
  boundary `b`, `--b junk`, `--b--junk`, the other line ending), at a part
  whose header block core's reader refuses (a folded first line, a line with
  no colon, a field name byte outside printable ASCII, over 1 MiB as core's
  port charges it, which is never less than Go charges, a field whose first
  line ends at the end of the input on a 4096-byte boundary, or the end of a
  part that ran out with no boundary), or at a line between parts over 4096
  bytes. A multipart with no part has core's synthesized `text/plain` child,
  of what core's reader had not read: the whole body without a boundary,
  empty once the preamble runs out, the body past the first 4096 bytes of a
  preamble line longer than that, and the body past the 4096-byte piece of a
  first part's header line on which its budget ran out. Its text is unknown
  where it hinges on how much the reader had buffered, which depends on the
  size of the message's header: after a close delimiter, or a first part
  refused anywhere else. An embedded message's header ends at the line the
  reader refuses, and its body starts after that line. A part's Content-Type
  is read as core's walker reads it, so a part the client shows is one an
  attachment rule sees: the
  first of a repeated field, Go's media-type parser
  (quoted-pairs, RFC 2231 continuations, RFC 2047 encoded parameters), a
  bare `multipart`, and `message/global` descended like `message/rfc822`. It descends at most 100 levels (Dovecot's
  limit) and visits at most 1024 parts; a no-match that depends on structure
  past either cap is "unknown" (`indeterminate`), as for a body the host's read
  window cut. A part that window cut is decoded and reduced to text only as far
  as the cut proves: a character, quoted-printable escape, HTML construct or
  character reference left open at the cut is dropped, never guessed. Each
  part is decoded (and reduced from HTML) once per message and shared by every
  body test; a quoted-printable "=" that starts neither an escape (two hex
  digits) nor a soft line break is text.
- RFC 2047 decoding covers UTF-8/ASCII/Latin-1 plus whatever `TextDecoder`
  labels the runtime provides; unknown charsets fall back to UTF-8/raw.
- Named timezones in `Date:` headers (e.g. `MST`) are treated as UTC offsets of
  zero.
- `vacation` never sends mail — the host owns dedup, rate limits, and loop
  prevention (see the `RuntimeData` table).

## Development

```sh
npm test          # vitest — conformance corpus + RFC regression suite
npm run typecheck
npm run build     # tsc → dist/ (ESM + .d.ts)
```

The `lexer`, `parser`, and `execute` suites are focused unit fixtures for each
layer; `rfc-fixes.test.ts` pins the RFC-correctness behaviours listed above.

### Dovecot Pigeonhole conformance corpus

`test/dovecot/` runs the Dovecot Pigeonhole `.svtest` corpus (and its
`.svtest.in` templates verbatim, which leaves their `#UTF8#` lines as comments:
three assertions that a non-ASCII local part is invalid, which this RFC 6532
interpreter does not share) through the
`vnd.dovecot.testsuite` DSL — the gold-standard validation that stress-tests
every extension far beyond the focused unit fixtures. The corpus is **vendored**
under `test/corpus-src/tests/` as a pinned snapshot of the LGPL-licensed upstream
(see [`test/corpus-src/PROVENANCE.md`](test/corpus-src/PROVENANCE.md) for the
source commit, license, and re-sync steps) — no fetch step is required, and the
suite stays reproducible even if upstream disappears.

When the corpus is absent the corpus tests self-skip; the inline DSL tests
(`inline.test.ts`, `inline-compile.test.ts`) always run. `corpus.test.ts`
auto-classifies each
`.svtest`: in-scope files (every extension this interpreter implements) are run and must
report zero sub-test failures; files requiring an unimplemented extension
(`enotify`, `include`, `duplicate`, `extlists`, `metadata`, …), the
action-result DSL this interpreter does not implement
(`test_result_execute`/`test_message`), or a
Pigeonhole-only feature (`test_error` detail counts, `test_config_set` keys other
than `sieve_variables_max_variable_size`, the imap4flags variable-name form) are
skipped with a recorded reason. **49 in-scope corpus files pass**, covering core,
comparators, match-types, and the `body`, `date`, `encoded-character`, `envelope`,
`index`, `mime`, `foreverypart`, `extracttext`, `regex`, `relational`, `subaddress`, and
`variables` extensions.
