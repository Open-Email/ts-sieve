// Safety-bound tests: token/nesting/redirect caps and ReDoS-safety of :matches.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";

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

  it(":matches is linear — a catastrophic-backtracking pattern returns fast", () => {
    // A pattern that would blow up a backtracking regex engine, against a long
    // non-matching subject. The linear matcher returns false without hanging.
    const pattern = "*a".repeat(20) + "*b";
    const subject = "a".repeat(5000);
    const start = performance.now();
    expect(runMatch(pattern, subject)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
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
