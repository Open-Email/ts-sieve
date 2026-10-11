// The regex engine must not overflow the call stack.
//
// A stack overflow is a RangeError, not a SieveError, and it escapes
// execute(): a host's fail-open then skips every rule. The VM added threads
// recursively, once per epsilon instruction (save, assert, jmp, split), and
// the program-size cap allows chains of about 9,000 of them, past where the
// stack runs out (about 8,000 in Node, fewer in a deeper Worker stack). The
// parser and compiler recursed once per nesting level. Thread expansion is
// iterative now, and nesting is capped well inside the stack.

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };
const fromKey = `require ["regex","variables","fileinto"];
  if header :matches "from" "*" { if header :regex "subject" "\${1}" { fileinto "X"; } }
  fileinto "Other";`;

describe("a long chain of epsilon instructions", () => {
  for (const key of ["(?:^{1000}){9}", "(?:(){1000}){4}", "(?:\\b{1000}){9}"]) {
    it(`runs without overflowing: a key from the message, ${key}`, () => {
      expect(run(fromKey, `From: ${key}\r\nSubject: x\r\n\r\nbody\r\n`, CORE)).toEqual(R({ fileinto: ["X", "Other"] }));
    });
  }

  it("runs without overflowing: the same key written in the script", () => {
    const script = 'require ["regex","fileinto"]; if header :regex "subject" "(?:^{1000}){9}" { fileinto "X"; }';
    expect(run(script, "Subject: x\r\n\r\nbody\r\n", CORE)).toEqual(R({ fileinto: ["X"] }));
  });

  it("thread priority is unchanged: leftmost-first captures", () => {
    const script = `require ["regex","variables","fileinto"];
      if header :regex "subject" "(a|ab)(c|bcd)(d*)" { fileinto "\${1}-\${2}-\${3}"; }`;
    expect(run(script, "Subject: abcd\r\n\r\nbody\r\n")).toEqual(R({ fileinto: ["a-bcd-"] }));
  });
});

describe("nesting", () => {
  const nest = (depth: number) => `${"(".repeat(depth)}a${")".repeat(depth)}`;

  it("a literal pattern nested past the cap fails at load", () => {
    expect(() => compile(`require "regex"; if header :regex "subject" "${nest(300)}" { keep; }`)).toThrow(/nest/);
  });

  it("a key from the message nested past the cap is unknown", () => {
    expect(run(fromKey, `From: ${nest(300)}\r\nSubject: a\r\n\r\nbody\r\n`, CORE)).toEqual(
      R({ fileinto: ["Other"], indeterminate: true }),
    );
  });

  it("nesting inside the cap still compiles and matches", () => {
    const script = `require ["regex","fileinto"]; if header :regex "subject" "${nest(200)}" { fileinto "X"; }`;
    expect(run(script, "Subject: a\r\n\r\nbody\r\n")).toEqual(R({ fileinto: ["X"] }));
  });
});
