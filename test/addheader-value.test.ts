// addheader values carrying line breaks or NUL (RFC 5293 §4).
//
// A value holding a raw CR, LF or NUL used to throw at execution. Such a value
// can come from the message — a captured Subject whose encoded word decodes to
// CRLF — and a thrown execute() skips every rule (the host's fail-open), so one
// header let a sender bypass the recipient's filtering. RFC 5293 §4 lets an
// implementation flag an error or fold the value instead; Pigeonhole folds line
// breaks and refuses a NUL at compile time, and its corpus cases are ported
// below.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { compile, R, run } from "./harness.js";

const msg = (subject: string) => `From: a@x\r\nTo: b@y\r\nSubject: ${subject}\r\n\r\nbody\r\n`;
const echo = (check: string) =>
  `require ["editheader","variables","fileinto"];
   if header :matches "subject" "*" { addheader "X-Orig" "\${1}"; }
   if header :is "x-orig" "${check}" { fileinto "Echoed"; }
   fileinto "Other";`;

describe("a value from the message", () => {
  it("a Q-encoded CRLF folds into one line instead of throwing", () => {
    expect(run(echo("hi bcc: x@evil"), msg("=?utf-8?Q?hi=0D=0Abcc:_x@evil?="))).toEqual(
      R({ fileinto: ["Echoed", "Other"] }),
    );
  });

  it("a bare CR or LF folds the same way", () => {
    expect(run(echo("a b c"), msg("=?utf-8?Q?a=0Db=0Ac?="))).toEqual(R({ fileinto: ["Echoed", "Other"] }));
  });

  it("a line break before whitespace is a fold and is removed", () => {
    expect(run(echo("a b"), msg("=?utf-8?Q?a=0D=0A_b?="))).toEqual(R({ fileinto: ["Echoed", "Other"] }));
  });

  it("a B-encoded NUL is dropped", () => {
    // "hi\0there"
    expect(run(echo("hithere"), msg("=?utf-8?B?aGkAdGhlcmU=?="))).toEqual(R({ fileinto: ["Echoed", "Other"] }));
  });

  // Each subject (Q-encoded: "=0D" CR, "=0A" LF, "=00" NUL, "=09" tab, "_"
  // space) and the one line it folds to.
  const FOLDS: [string, string][] = [
    ["a=0Ab", "a b"],
    ["a=0Db", "a b"],
    ["a=0D=0Ab", "a b"],
    ["a=0A=0A=0Db", "a b"],
    ["a=00b", "ab"],
    ["=0D=0Aab", "ab"],
    ["=00=0Aab", "ab"],
    ["ab=0D=0A", "ab"],
    ["a=0D=0A_b", "a b"],
    ["a=0D=0A=09b", "a\tb"],
    ["a=0D=00=0A_b", "a b"],
    ["a=0D=0Abcc:_x=00y", "a bcc: xy"],
  ];

  for (const [subject, folded] of FOLDS) {
    it(`the edit a host would serialise: ${subject}`, () => {
      expect(ledger(`=?utf-8?Q?${subject}?=`)).toEqual([folded]);
    });
  }

  it("a break at the start is a fold, and reads back without a leading space", () => {
    expect(run(echo("hi"), msg("=?utf-8?Q?=0D=0Ahi?="))).toEqual(R({ fileinto: ["Echoed", "Other"] }));
  });

  it("folding is linear in the value", () => {
    // A run of line breaks before a word backtracked through a lookahead regex:
    // 64,000 took seconds, and the step budget does not see it. The run sits
    // mid-value, where no leading-break shortcut reaches it.
    const value = `a${"\n".repeat(50_000)}x${"\r\n".repeat(50_000)} y`;
    const t0 = performance.now();
    expect(ledger("", value)).toEqual(["a x y"]);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

/** The values `addheader "X-Orig" "${1}"` records, with ${1} captured from
 * `subject` — or set to `capture` directly, past any match-input cap. */
function ledger(subject: string, capture?: string): string[] {
  const add = 'addheader "X-Orig" "${1}";';
  const script = load(
    `require ["editheader","variables"]; ${capture === undefined ? `if header :matches "subject" "*" { ${add} }` : add}`,
    { enabledExtensions: ["editheader", "variables"] },
  );
  const headers = new Map([["subject", [subject]]]);
  const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, headers));
  if (capture !== undefined) d.matchVariables = ["", capture];
  script.execute(d);
  return d.headerEdits.map((e) => e.value);
}

describe("Pigeonhole editheader/addheader.svtest: Addheader - newlines", () => {
  it("a multi-line variable reads back unfolded", () => {
    const script = `require ["editheader","variables","fileinto"];
set "before" text:
This is very long header content
 containing newlines. This may
 cause some problems, so that
 is why it is tested here.
.
;
addheader "X-Some-Header-first" "\${before}";
if header :is "x-some-header-first"
    "This is very long header content containing newlines. This may cause some problems, so that is why it is tested here." {
  fileinto "Unfolded";
}`;
    expect(run(script, msg("Frop!"))).toEqual(R({ fileinto: ["Unfolded"] }));
  });
});

describe("Pigeonhole editheader/errors/field-value.sieve", () => {
  const head = 'require "editheader"; require "encoded-character";';

  it("a literal line break loads, and reads back folded", () => {
    expect(run(`${head} require "fileinto"; addheader "X-field" "Frop\r\nFrml"; if header :is "x-field" "Frop Frml" { fileinto "F"; }`)).toEqual(
      R({ fileinto: ["F"] }),
    );
  });

  it("a literal BELL is not an error", () => {
    expect(() => compile(`${head} addheader "X-field" "Yeah\${hex:07}!";`)).not.toThrow();
  });

  it("a literal NUL fails at load", () => {
    expect(() => compile(`${head} addheader "X-field" "Woah\${hex:00}!";`)).toThrow(/addheader/);
  });

  it("a NUL beside a variable reference is still literal, and fails at load", () => {
    expect(() =>
      compile(`${head} require "variables"; addheader "X-field" "\${hex:00}\${x}";`),
    ).toThrow(/addheader/);
  });
});
