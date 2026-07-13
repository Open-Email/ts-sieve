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
arrives. `execute()` throws `SieveError` on runtime errors (budget exhaustion,
too many redirects, an envelope-less `vacation`, …); treat that as "script
failed, fall back to implicit keep".

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
| `implicitKeep` | `true` unless a canonical action (`fileinto`/`redirect`/`discard` without `:copy`) cancelled it. If `implicitKeep \|\| keep`, deliver to INBOX. |
| `keep` | An explicit `keep;` ran. |
| `mailboxes` / `mailboxesCreate` | `fileinto` targets (deduped); the subset flagged `:create` (RFC 5490) should be auto-created. |
| `redirectAddr` | `redirect` targets that passed your policy (capped by `maxRedirects`). |
| `flags` | The final IMAP flag set (RFC 5232), canonicalised: lowercased, deduped, sorted. |
| `headerEdits` | The RFC 5293 `addheader`/`deleteheader` ledger. Tests inside the script already see the edits; apply the ledger yourself if the *stored* message should change. |
| `vacationResponses` | RFC 5230 vacation **intents**, keyed by envelope-from. The host owns the actual send, the `:days`/`:handle` dedup database, and the RFC 5230 §4.5 loop-prevention checks (`Auto-Submitted`, list headers, "am I in To/Cc?"). |

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
| `body` | 5173 | `:raw`/`:text`/`:content`; hand-rolled byte-level MIME walker, QP/base64 + charset decode, HTML→text for `:text` |
| `variables` | 5229 | `set` + modifiers, `string` test, `${name}`, match variables `${0}…${N}`, `envelope.*` namespace |
| `vacation` | 5230 | records intent only — see table above |
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
| `maxMatchInputLength` | 0 (off) | truncate values before `:matches`/`:regex` |
| `maxExecSteps` | 0 (off) | cooperative CPU budget ticked in command dispatch, match loops, and the regex VM inner loop — **set this in a Worker** |
| `enabledExtensions` | `null` (none) | allow-list for `require` |

Independent of options, the regex engine enforces: pattern ≤ 1000 chars,
compiled program ≤ 10 000 instructions, `{n,m}` counts ≤ 1000, input ≤ 256 KiB
(byte-truncated), and it charges every VM step to the execution budget.

## Robustness properties

- **No backtracking anywhere.** `:matches`/`:regex` compile to a Pike-VM
  program that is O(program × input); scanning (`${…}` expansion, RFC 2047
  decode, MIME walking, date parsing) is linear and regex-free on
  attacker-controlled text.
- **Load-time failure over delivery-time failure.** Patterns without variable
  references (and all structural/require errors) fail at `load()` — i.e. at
  script upload, not when a message arrives.
- **Header-injection guard.** `addheader` rejects values containing CR/LF/NUL,
  so a variable smuggled out of a hostile message can't append extra header
  fields when the host serialises `headerEdits`.
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
  dependency); unparseable values fall back to literal matching.

## Known limitations

- `Envelope` carries a single address per part, not a recipient list.
- The `address` test only inspects a fixed allow-list of address-bearing
  headers (From/To/Cc/…); other header names are silently skipped per RFC 5228
  §5.1's "MUST restrict" guidance.
- The `body` walker is an approximation of a full MIME parser (byte-exact
  boundaries, last-value headers); pathological nesting is bounded by the
  execution budget.
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

`test/dovecot/` runs the Dovecot Pigeonhole `.svtest` corpus through the
`vnd.dovecot.testsuite` DSL — the gold-standard validation that stress-tests
every extension far beyond the focused unit fixtures. The corpus is **not
vendored** (it is LGPL); fetch it once, gitignored, before running those tests:

```sh
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/dovecot/pigeonhole.git test/corpus-src
cd test/corpus-src && git sparse-checkout set tests   # → test/corpus-src/tests/**/*.svtest
```

`test/corpus-src/` is listed in `.gitignore`. When the corpus is absent the
corpus tests self-skip; the inline DSL tests (`inline.test.ts`,
`inline-compile.test.ts`) always run. `corpus.test.ts` auto-classifies each
`.svtest`: in-scope files (every extension this interpreter implements) are run and must
report zero sub-test failures; files requiring an unimplemented extension
(`enotify`, `include`, `mime`, `duplicate`, `extlists`, `metadata`, …), the
action-result DSL this interpreter does not implement
(`test_result_execute`/`test_message`), or a
Pigeonhole-only feature (`test_error` detail counts, `test_config_set` keys other
than `sieve_variables_max_variable_size`, the imap4flags variable-name form) are
skipped with a recorded reason. **42 in-scope corpus files pass**, covering core,
comparators, match-types, and the `body`, `date`, `encoded-character`, `envelope`,
`index`, `regex`, `relational`, `subaddress`, and `variables` extensions.
