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

import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { compileRegex } from "../src/interp/regex.js";
import * as regex from "../src/interp/regex.js";
import { ALL_EXTENSIONS, compile, parseEml, R, run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };
const fromKey = `require ["regex","variables","fileinto"];
  if header :matches "from" "*" { if header :regex "subject" "\${1}" { fileinto "X"; } }
  fileinto "Other";`;

// Finite bombs allow mutation checks with the work cap removed. The compiler
// must refuse them at the appropriate cap, rather than return an expensive
// program that only fails later when runtime budget accounting sees it.
const BOMBS = ["(?:(?:(?:){1000}){1000}){100}", "(?:(?:(?i){1000}){1000}){100}", "(?:(?:(?:(?:)*){1000}){1000}){1000}"];

describe("nested repeats of a node that emits nothing", () => {
  for (const bomb of BOMBS) {
    it(`a key from the message is refused by the compiler cap: ${bomb}`, () => {
      const spy = vi.spyOn(regex, "compileRegex");
      try {
        const r = run(fromKey, `From: ${bomb}\r\nSubject: x\r\n\r\nbody\r\n`, CORE);
        expect(r).toEqual(R({ fileinto: ["Other"], indeterminate: true }));
        const attempts = spy.mock.calls.flatMap(([pattern], i) => pattern === bomb ? [spy.mock.results[i]!] : []);
        // With the work cap removed the first two still return unknown at
        // runtime, but only AFTER compiling the whole bomb. Observe the
        // compile refusal itself, not the unchanged interpreter outcome.
        expect(attempts).toHaveLength(1);
        expect(attempts[0]!.type).toBe("throw");
        expect(String(attempts[0]!.value)).toContain(bomb === BOMBS[2] ? "program too large" : "pattern too complex");
      } finally { spy.mockRestore(); }
    });

    it(`a literal fails at the compiler cap: ${bomb}`, () => {
      expect(() => compile(`require "regex"; if header :regex "subject" "${bomb}" { keep; }`)).toThrow(
        bomb === BOMBS[2] ? /program too large/ : /pattern too complex/,
      );
    });
  }
});

describe("the cap", () => {
  it("is 100,000 compile calls", () => {
    expect(compileRegex("(?:(?:){48}){1000}").compileWork).toBe(98_001);
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

describe("a key whose expansion changes from value to value", () => {
  // deleteheader sets match variables on each match and goes on to the next
  // value, so a key built from ${1} can change between values.
  const script = `require ["editheader","variables","regex","fileinto"];
    if header :matches "x-key" "*" { deleteheader :regex "x-t" "\${1}"; }
    if exists "x-t" { fileinto "Left"; }`;

  it("is compiled again when its text changes", () => {
    // "^a(x)" deletes "ax" and captures "x", the key for the next value.
    expect(run(script, "X-Key: ^a(x)\r\nX-T: ax\r\nX-T: x\r\n\r\nbody\r\n")).toEqual(R({ implicitKeep: true }));
  });

  it("each compile is charged, so recompiling every value runs out of budget", () => {
    // Each value captures the other near-cap key: ~98,000 calls per value.
    const a = "(?:(?:){48}){1000}(.+)";
    const b = "(?:(?:){47}){1000}(.+)";
    const fields = Array.from({ length: 2000 }, (_, i) => `X-T: ${i % 2 ? a : b}`).join("\r\n");
    const { headers, size, body } = parseEml(`X-Key: ${a}\r\n${fields}\r\n\r\nbody\r\n`);
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
    s.execute(d);
    expect(d.budgetExhausted).toBe(true);
    expect(d.indeterminate).toBe(true);
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
