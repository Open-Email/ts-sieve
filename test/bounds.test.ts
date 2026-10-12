// Safety-bound tests: token/nesting/redirect caps and ReDoS-safety of :matches.

import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import * as regex from "../src/interp/regex.js";

function runMatch(pattern: string, subject: string): boolean {
  const script = load(`if header :matches "Subject" "${pattern}" { discard; }`, { enabledExtensions: [] });
  const headers = new Map([["subject", [subject]]]);
  const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(1, headers));
  script.execute(d);
  return !d.implicitKeep; // discard clears implicit keep only when the test matched
}

describe("bounds", () => {
  it("maxTokens rejects an over-long token stream at lex time", () => {
    expect(() => load(`keep; keep; keep;`, { maxTokens: 3, enabledExtensions: [] })).toThrow();
  });

  it("maxBlockNesting rejects blocks deeper than the cap", () => {
    expect(() => load(`if true { if true { keep; } }`, { maxBlockNesting: 1, enabledExtensions: [] })).toThrow();
  });

  it("maxTestNesting rejects tests deeper than the cap", () => {
    expect(() =>
      load(`if anyof (anyof (exists "a")) { keep; }`, { maxTestNesting: 1, enabledExtensions: [] }),
    ).toThrow();
  });

  it("maxRedirects caps redirect actions at execute time: the rest are dropped and disclosed", () => {
    const six = Array.from({ length: 6 }, (_, i) => `redirect "u${i}@x.com";`).join(" ");
    const script = load(six, { enabledExtensions: [] });
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(1, new Map()));
    script.execute(d);
    expect([d.redirectAddr.length, d.indeterminate]).toEqual([5, true]);
  });

  it("a redirect count within the cap succeeds", () => {
    const five = Array.from({ length: 5 }, (_, i) => `redirect "u${i}@x.com";`).join(" ");
    const script = load(five, { enabledExtensions: [] });
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(1, new Map()));
    script.execute(d);
    expect(d.redirectAddr.length).toBe(5);
  });

  it(":matches visits at most twice program × input instructions", () => {
    const pattern = "*a".repeat(20) + "*b";
    const subject = "a".repeat(5000);
    const original = regex.compileRegex;
    let reads = 0;
    let bound = 0;
    let counted: unknown[];
    let program: { prog: unknown[] };
    const spy = vi.spyOn(regex, "compileRegex").mockImplementation((...args) => {
      const re = original(...args);
      program = re as unknown as { prog: unknown[] };
      // One read during epsilon traversal and one during consuming traversal
      // per (program counter, input position). Stop a revisit regression by
      // work count before a pathological pattern can hang the test runner.
      bound = 2 * program.prog.length * (subject.length + 1);
      counted = new Proxy(program.prog, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key) && ++reads > bound) throw new Error("VM instruction visit bound exceeded");
          return Reflect.get(target, key, receiver);
        },
      });
      program.prog = counted;
      return re;
    });
    try {
      expect(runMatch(pattern, subject)).toBe(false);
      expect(reads, "the instruction probe must observe the actual matcher").toBeGreaterThan(subject.length);
      expect(program!.prog, "the matcher must retain the counted program").toBe(counted!);
      expect(reads).toBeLessThanOrEqual(bound);
    } finally { spy.mockRestore(); }
  });

  it("maxExecSteps stops a pathological match: the test is unknown, the script completes", () => {
    // It once threw, skipping every rule; see budget.test.ts.
    const headers = new Map([["subject", ["a".repeat(5000)]]]);
    const script = load(`if header :matches "Subject" "${"*a".repeat(20)}*b" { discard; }`, {
      enabledExtensions: [],
      maxExecSteps: 500,
    });
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(1, headers));
    script.execute(d);
    expect(d.budget.remaining).toBeGreaterThanOrEqual(0);
    expect(d.implicitKeep).toBe(true); // the discard did not fire
    expect(d.indeterminate).toBe(true);
    expect(d.budgetExhausted).toBe(true);
  });

  it("a generous budget completes normally", () => {
    const headers = new Map([["subject", ["hello world"]]]);
    const script = load(`if header :matches "Subject" "hello*" { discard; }`, {
      enabledExtensions: [],
      maxExecSteps: 1_000_000,
    });
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(1, headers));
    script.execute(d);
    expect(d.implicitKeep).toBe(false); // matched → discard ran
  });

  it(":matches ? wildcard matches exactly one char", () => {
    expect(runMatch("h?llo", "hello")).toBe(true);
    expect(runMatch("h?llo", "hllo")).toBe(false);
  });

  it(":matches * is a wildcard; \\\\* (source) is a literal star", () => {
    // Source "a*b": * is a wildcard.
    expect(runMatch("a*b", "axb")).toBe(true);
    // Source "a\\*b" (written "a\\\\*b" in this JS test): the quoted-string lexer
    // yields a\*b, and the glob treats \* as a literal star.
    expect(runMatch("a\\\\*b", "a*b")).toBe(true);
    expect(runMatch("a\\\\*b", "axb")).toBe(false);
  });
});
