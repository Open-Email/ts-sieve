// Compile work is bounded.
//
// Repeats compile by expansion, and the program-size cap is what bounded that
// work: every copy emits instructions. A repeat of a node that emits nothing
// ("(?:)", "(?i)") adds nothing to the program, so nested repeats of one ran
// unchecked: "(?:(?:(?:){1000}){1000}){100}" made 10^8 compile calls (most of
// a second), and one more level made 10^12 (hours), uncharged to the step
// budget. Through a key built from the message that is a sender's CPU; as a
// literal it hangs load() at upload and at every delivery. Compile calls are
// now counted, and a pattern past the limit does not compile: a literal fails
// at load, a key from the message is "unknown" (#19).

import { describe, expect, it } from "vitest";
import { compile, R, run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };
const fromKey = `require ["regex","variables","fileinto"];
  if header :matches "from" "*" { if header :regex "subject" "\${1}" { fileinto "X"; } }
  fileinto "Other";`;

function within<T>(ms: number, f: () => T): T {
  const t0 = performance.now();
  const r = f();
  expect(performance.now() - t0).toBeLessThan(ms);
  return r;
}

const BOMBS = [
  "(?:(?:(?:){1000}){1000}){100}",
  "(?:(?:(?:(?:){1000}){1000}){1000}){1000}",
  "(?:(?:(?:(?i){1000}){1000}){1000}){1000}",
  "(?:(?:(?:(?:)*){1000}){1000}){1000}",
];

describe("nested repeats of a node that emits nothing", () => {
  for (const bomb of BOMBS) {
    it(`a key from the message is unknown, quickly: ${bomb}`, () => {
      const r = within(500, () => run(fromKey, `From: ${bomb}\r\nSubject: x\r\n\r\nbody\r\n`, CORE));
      expect(r).toEqual(R({ fileinto: ["Other"], indeterminate: true }));
    });

    it(`a literal fails at load, quickly: ${bomb}`, () => {
      within(500, () =>
        expect(() => compile(`require "regex"; if header :regex "subject" "${bomb}" { keep; }`)).toThrow(
          /too complex|too large/,
        ),
      );
    });
  }
});

describe("what still compiles", () => {
  it("a repeat of an empty group that stays small", () => {
    const script = 'require ["regex","fileinto"]; if header :regex "subject" "a(?:){1000}b" { fileinto "X"; }';
    expect(run(script, "Subject: ab\r\n\r\nbody\r\n")).toEqual(R({ fileinto: ["X"] }));
  });

  it("a heavily wrapped pattern near the program-size cap", () => {
    // 9,000 instructions, about 81,000 compile calls.
    const key = "(?:(?:(?:(?:(?:(?:(?:(?:[a-z])))))))){1000}){9}";
    expect(() => compile(`require "regex"; if header :regex "subject" "(?:${key}" { keep; }`)).not.toThrow();
  });
});
