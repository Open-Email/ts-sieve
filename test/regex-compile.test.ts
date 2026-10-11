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
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { compileRegex } from "../src/interp/regex.js";
import { ALL_EXTENSIONS, compile, parseEml, R, run } from "./harness.js";

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

// Bombs that stay finite if the cap ever regresses (10^8 calls, under a
// second), so a regression fails here instead of hanging the run; the
// boundary test below pins the cap itself.
const BOMBS = ["(?:(?:(?:){1000}){1000}){100}", "(?:(?:(?i){1000}){1000}){100}", "(?:(?:(?:(?:)*){1000}){1000}){1000}"];

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

describe("the cap", () => {
  it("is 100,000 compile calls", () => {
    expect(() => compileRegex("(?:(?:){48}){1000}")).not.toThrow(); // 98,001 calls
    expect(() => compileRegex("(?:(?:){49}){1000}")).toThrow(/too complex/); // 100,001
  });
});

describe("a key from the message is compiled once per test, not per value", () => {
  it("5,000 Subject fields do not compile it 5,000 times", () => {
    // Each failing compile is charged as the whole cap; per value, 5,000 of
    // them would exhaust core's budget (and took 3.5 s uncharged).
    const eml = `From: (?:(?:(?:){1000}){1000}){100}\r\n${"Subject: x\r\n".repeat(5000)}\r\nbody\r\n`;
    const { headers, size, body } = parseEml(eml);
    const s = load(fromKey, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
    s.execute(d);
    expect(d.mailboxes).toEqual(["Other"]);
    expect(d.indeterminate).toBe(true);
    expect(d.budgetExhausted).toBe(false);
  });
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
