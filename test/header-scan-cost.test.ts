// Address and date parsing run on raw header values, which no match-input cap
// bounds and whose work the step budget does not count. Two regular
// expressions there backtracked quadratically: comment stripping in addresses
// (`\([^)]*\)` against many "(" with no ")": 64k took 1.6 s) and the trailing
// comment of a Date (`\s*\([^()]*\)\s*$` against a long run of white space:
// 64k took 1.5 s). Both are single scans now, with the same output.

import { describe, expect, it } from "vitest";
import { stripRFC2822Comments } from "../src/interp/address.js";
import { stripTrailingComment } from "../src/interp/date.js";
import { run } from "./harness.js";

const OLD_ADDRESS = (s: string) => s.replace(/\([^)]*\)/g, "").trim();
const OLD_DATE = (s: string) => s.replace(/\s*\([^()]*\)\s*$/, "");

/** Random strings over an alphabet of the characters that matter. */
function* samples(alphabet: string[], count: number, maxLen: number): Generator<string> {
  let seed = 7;
  // Math.imul keeps the product exact (a plain multiply passes 2^53 and loses
  // the low bits), and the high bits are the random ones in this generator.
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
  for (let t = 0; t < count; t++) {
    let s = "";
    for (let i = rnd(maxLen); i > 0; i--) s += alphabet[rnd(alphabet.length)];
    yield s;
  }
}

function within(ms: number, f: () => unknown): unknown {
  const t0 = performance.now();
  const r = f();
  expect(performance.now() - t0).toBeLessThan(ms);
  return r;
}

describe("address comment stripping", () => {
  it("gives the regex's output", () => {
    const seen = new Set<string>();
    for (const s of samples(["(", ")", "a", "@", " ", "<", ">", "x"], 20_000, 14)) {
      seen.add(s);
      expect(stripRFC2822Comments(s)).toBe(OLD_ADDRESS(s));
    }
    expect(seen.size).toBeGreaterThan(10_000); // the samples really vary
  });

  it("is linear in the header", () => {
    const script = 'require "fileinto"; if address :is "from" "a@b" { fileinto "A"; }';
    const small = run(script, `From: ${"(".repeat(10)}a@b\r\n\r\nx\r\n`);
    const big = within(500, () => run(script, `From: ${"(".repeat(200_000)}a@b\r\n\r\nx\r\n`));
    expect(big).toEqual(small);
  });
});

describe("the trailing comment of a Date", () => {
  it("gives the regex's output", () => {
    const seen = new Set<string>();
    for (const s of samples(["(", ")", "a", " ", "\t", "\u00a0", "\ufeff", "\u2028", "x"], 20_000, 14)) {
      seen.add(s);
      expect(stripTrailingComment(s)).toBe(OLD_DATE(s));
    }
    expect(seen.size).toBeGreaterThan(10_000); // the samples really vary
  });

  it("is linear in the header", () => {
    const script = 'require ["date","fileinto"]; if date :is "date" "year" "2026" { fileinto "Y"; }';
    const date = (ws: number) => `Date: Thu, 20 Aug 2026 21:30:35${" ".repeat(ws)}(x +0000\r\n\r\nx\r\n`;
    const small = run(script, date(10));
    const big = within(500, () => run(script, date(200_000)));
    expect(big).toEqual(small);
  });
});
