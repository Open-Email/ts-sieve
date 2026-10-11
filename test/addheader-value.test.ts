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

  it("no CR, LF or NUL reaches the edit a host would serialise", async () => {
    const { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } = await import("../src/index.js");
    const script = load('require ["editheader","variables"]; if header :matches "subject" "*" { addheader "X-Orig" "${1}"; }', {
      enabledExtensions: ["editheader", "variables"],
    });
    const headers = new Map([["subject", ["=?utf-8?Q?a=0D=0Abcc:_x=00y?="]]]);
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, headers));
    script.execute(d);
    expect(d.headerEdits.map((e) => e.value)).toEqual(["a bcc: xy"]);
  });
});

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
