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
arrives. `execute()` throws `SieveError` on runtime errors (too many
redirects, a `maxExecSteps` smaller than the script's own commands, …); treat
that as "script failed, fall back to implicit keep". Because a throw skips every
rule, message content must not cause one: the `body` test does not throw on
malformed MIME (broken transfer encodings decode leniently, and structure past
the caps below is "unknown"), and a test that runs out of its share of
`maxExecSteps` answers "unknown" while the script runs on (`budgetExhausted`).
A `:matches`/`:regex` key holding a variable reference compiles when the test
runs; if the expanded text does not compile, or is past the pattern-length
cap, the comparison is "unknown" rather than an error. An `envelope`
envelope-part built from a variable that names no part the test reads has no
value, like a missing header. No other path from message content to a throw
is known: report one as an issue.

### What the host implements

| Interface | Purpose |
| --- | --- |
| `Message` | `headerGet(name)` (case-insensitive, values in order), `messageSize()`, `bodyRaw()` (`null` ⇒ `body` test never matches). Implement over your MIME source (e.g. `postal-mime`). |
| `Envelope` | SMTP `MAIL FROM`, `RCPT TO`, and the authenticated username. |
| `PolicyReader` | `redirectAllowed(d, addr)` — gate/rate-limit/validate redirect targets. `DummyPolicy` allows everything. |
| `MailboxChecker` (optional, `d.mailboxChecker`) | Backs `mailboxexists`; when absent the test is optimistic ("exists"). |

### What the host reads back from `RuntimeData`

| Field | Meaning |
| --- | --- |
| `implicitKeep` | `true` unless a canonical action (`fileinto`/`redirect`/`discard` without `:copy`, `reject`/`ereject`) cancelled it. If `implicitKeep \|\| keep`, deliver to INBOX. |
| `keep` | An explicit `keep;` ran. |
| `mailboxes` / `mailboxesCreate` | `fileinto` targets (deduped); the subset flagged `:create` (RFC 5490) should be auto-created. |
| `redirectAddr` | `redirect` targets that passed your policy (capped by `maxRedirects`). |
| `flags` | The final IMAP flag set (RFC 5232), canonicalised: lowercased, deduped, sorted. |
| `headerEdits` | The RFC 5293 `addheader`/`deleteheader` ledger. Tests inside the script already see the edits; apply the ledger yourself if the *stored* message should change. An added value holds no CR, LF or NUL, but is otherwise as the script built it: fold and encode it when you serialise it (it may pass RFC 5322's 998-octet line limit, carry non-ASCII text, or Unicode separators such as U+2028). |
| `indeterminate` | An "unknown" decided a branch: a comparison over a cut input, structure past the MIME caps, a key that did not compile, or a test out of its budget share. The actions are a best-effort reading: refuse the irreversible ones (discard, redirect without keep, reject) and let the rest stand. |
| `budgetExhausted` | A test ran out of its share of `maxExecSteps` and answered "unknown". The script completed; this says why it guessed. |
| `vacationResponses` | RFC 5230 vacation **intents**, keyed by envelope-from. The host owns the actual send, the `:days`/`:handle` dedup database, and the RFC 5230 §4.5 loop-prevention checks (`Auto-Submitted`, list headers, "am I in To/Cc?"). |
| `rejected` / `rejectReason` / `rejectExtended` | RFC 5429: a `reject` (or, with `rejectExtended`, an `ereject`) ran, with its reason after variable expansion; the implicit keep is cancelled. The host refuses the message — RFC 5429 asks for a protocol-level 5xx where possible, else a DSN (ereject) or failure MDN (reject), never to a null or forged sender; a host that can only drop it departs from the RFC (§2.1: no ereject without protocol refusal) and leaves the sender uninformed. `rejectReason` is **untrusted text**: variables can carry decoded CR/LF and non-ASCII from the message, so a host writing it into an SMTP reply must apply §2.5's multi-line and §2.1.1's ASCII rules. Header edits (`headerEdits`) must not reach a generated MDN/DSN (§2.4). Treat a reject like a discard when `indeterminate` is set. |

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
| `body` | 5173 | `:raw`/`:text`/`:content`; hand-rolled byte-level MIME walker, QP/base64 + charset decode, HTML→text for `:text` (tokenizer rules: attribute-aware tags, script/style/comments and the hidden raw-text elements dropped, textarea/xmp kept, every WHATWG character reference decoded). Content is dropped up to a far terminator only where the browser's tokenizer state is decidable here; from the first `svg`, `math`, `select` or `noscript` tag or escaped script on, nothing is dropped beyond the next `>` and raw text is kept (a region holding `&` both literally and decoded) — so markup cannot hide the rest of the body, at the cost of matching stylesheets in such mail, where a whole-part `:is` can also miss |
| `variables` | 5229 | `set` + modifiers, `string` test, `${name}`, match variables `${0}…${N}`, `envelope.*` namespace (needs `require "envelope"`; any other namespace is refused at load, RFC 5229 §3) |
| `vacation` | 5230 | records intent only — see table above |
| `reject` / `ereject` | 5429 | records the refusal only — see table above. §2.4 is enforced: a second reject fails when it runs, and a reject next to `vacation`, `keep`, `fileinto` or `redirect` (`:copy` included) fails once the script has run, whatever the order (in a testsuite script, at the end of each `test` block) |
| `relational` | 5231 | `:value`/`:count` on `address`/`envelope`/`header`/`string`/`hasflag`/`date`/`currentdate`/`body` |
| `imap4flags` | 5232 | `setflag`/`addflag`/`removeflag` (incl. the `<variablename>` form), `hasflag` (incl. the variable-list form, with per-flag membership matching), `:flags` on `keep`/`fileinto` |
| `subaddress` | 5233 | `:user`/`:detail` (separator `+`) |
| `date` | 5260 | `date`/`currentdate`, all date-parts, `:zone`/`:originalzone`; `Received:` headers extract the date after the final `;` |
| `index` | 5260 | `:index`/`:last` on `header`, `address`, and `date` |
| `editheader` | 5293 | virtual: edits go to the `headerEdits` ledger and are replayed on every header read; protected headers (`Received`, `Auto-Submitted`) are immune |
| `mailbox` | 5490 | `mailboxexists`, `fileinto :create` |
| `regex` | draft-murchison-sieve-regex | on the linear engine: classes, alternation, bounded `{n,m}`, anchors, `\b`, inline `(?ism)` flags; **no** backreferences or lookaround (rejected at load) |
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
| `maxRedirects` | 5 | `redirect` actions per execution |
| `maxVariableCount` / `maxVariableNameLen` / `maxVariableLen` | 128 / 32 / 4000 | RFC 5229 limits (value truncation is UTF-8-safe) |
| `maxMatchInputLength` | 0 (engine default, 256 KiB) | truncate values before `:matches`/`:regex`; a comparison over a cut value is three-valued |
| `maxExecSteps` | 0 (off) | cooperative CPU budget ticked in command dispatch, match loops, and the regex VM inner loop — **set this in a Worker**. Each test (and `deleteheader`'s matching) spends a share: everything left except one step per command and a reserve for each test after it (1/1024 of the budget, at most half of what is left). A test out of its share is "unknown" and the script runs on; one expensive test cannot starve the rest, but many in a row leave less for each test after them. |
| `enabledExtensions` | `null` (none) | allow-list for `require` |

Independent of options, the regex engine enforces: pattern ≤ 1000 chars,
compiled program ≤ 10 000 instructions, `{n,m}` counts ≤ 1000, ≤ 250 nested
groups and ≤ 500 levels of compiler recursion (quantifiers stacked on groups
deepen it too; a `{n,}` counts twice), input ≤ 256 KiB unless
`maxMatchInputLength` sets another cut (byte-truncated at a character
boundary, and evaluated as a cut), and it charges every VM step to the
execution budget.

## Robustness properties

- **No backtracking anywhere.** `:matches`/`:regex` compile to a Pike-VM
  program that is O(program × input); scanning (`${…}` expansion, RFC 2047
  decode, MIME walking, date parsing) is linear and regex-free on
  attacker-controlled text.
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
  boundaries, last-value headers). It descends at most 100 levels (Dovecot's
  limit) and visits at most 1024 parts; a no-match that depends on structure
  past either cap is "unknown" (`indeterminate`), as for a body the host's read
  window cut. A part that window cut is decoded and reduced to text only as far
  as the cut proves: a character, quoted-printable escape, HTML construct or
  character reference left open at the cut is dropped, never guessed.
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
(`enotify`, `include`, `mime`, `duplicate`, `extlists`, `metadata`, …), the
action-result DSL this interpreter does not implement
(`test_result_execute`/`test_message`), or a
Pigeonhole-only feature (`test_error` detail counts, `test_config_set` keys other
than `sieve_variables_max_variable_size`, the imap4flags variable-name form) are
skipped with a recorded reason. **43 in-scope corpus files pass**, covering core,
comparators, match-types, and the `body`, `date`, `encoded-character`, `envelope`,
`index`, `regex`, `relational`, `subaddress`, and `variables` extensions.
