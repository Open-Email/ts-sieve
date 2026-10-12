// #75: match the header text Core exposes, including malformed/overlapping
// words. Fixtures were evaluated by Core itself at the recorded commit.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { decodeHeaderValue } from "../src/interp/header.js";
import { ALL_EXTENSIONS } from "./harness.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/encoded-words-core.json", import.meta.url), "utf8")) as {
  cases: { name: string; input: string; expected: string }[];
};

function exec(commands: string, subject: string, budget = 200_000) {
  const s = load(`require ["fileinto", "mime", "editheader", "foreverypart"]; ${commands}`, {
    enabledExtensions: ALL_EXTENSIONS, maxExecSteps: budget,
  });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map([["subject", [subject]]]), new Uint8Array()));
  s.execute(d);
  return d;
}

describe("Core-compatible encoded headers (#75)", () => {
  it.each(fixture.cases)("$name", ({ input, expected }) => {
    expect(decodeHeaderValue(input)).toBe(expected);
  });

  for (const { name, input } of fixture.cases.slice(0, 4)) {
    it.each([
      'if header :contains "subject" "viagra" { fileinto "Hit"; }',
      'if header :mime :contains "subject" "viagra" { fileinto "Hit"; }',
      'deleteheader :contains "subject" "viagra"; if not exists "subject" { fileinto "Hit"; }',
    ])(`exposes ${name} through %s`, (commands) => {
      const d = exec(commands, input);
      expect(d.mailboxes).toEqual(["Hit"]);
      expect(d.indeterminate).toBe(false);
    });
  }

  it("charges Q words containing question marks inside part loops", () => {
    const n = 1024;
    const d = exec('foreverypart { if header :is "subject" "missing" { keep; } }', '=?utf-8?q?x??='.repeat(n));
    expect(200_000 - d.budget.remaining).toBeGreaterThanOrEqual(n);
    expect(d.budgetExhausted).toBe(false);
  });

  it("does linear work over overlapping malformed words with one distant closing marker", () => {
    // A payload after the opening delimiter keeps adjacent candidates from
    // forming extra `?=` markers at their joins.
    const prefix = "=?utf-8?B?AAAA";
    const input = prefix.repeat(256) + "?=";
    const original = String.prototype.charCodeAt;
    let inspected = 0;
    const codes = vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (this: string, index: number) {
      inspected++;
      return original.call(this, index);
    });
    const searches = vi.spyOn(String.prototype, "indexOf");
    let decoded: string;
    let closings: number;
    try {
      decoded = decodeHeaderValue(input);
      closings = searches.mock.calls.filter(([needle]) => needle === "?=").length;
    } finally {
      codes.mockRestore();
      searches.mockRestore();
    }
    expect(decoded!).toBe(prefix.repeat(255) + "\0\0\0");
    expect(inspected).toBeLessThan(input.length * 10);
    expect(closings!).toBeLessThanOrEqual(2);
  });
});
