import { describe, expect, it } from "vitest";
import { compileRegex, patternToRegex } from "../src/interp/regex.js";

function m(pattern: string, input: string): string[] | null {
  return compileRegex(pattern).findSubmatch(input);
}

describe("regex engine", () => {
  it("glob captures leftmost-lazy (*-* on foo-bar)", () => {
    expect(m(patternToRegex("*-*", false), "foo-bar")).toEqual(["foo-bar", "foo", "bar"]);
  });
  it("glob anchored no-match", () => {
    expect(m(patternToRegex("foo*", false), "xfoo")).toBeNull();
  });
  it("glob ? single char", () => {
    expect(m(patternToRegex("h?llo", false), "hello")).toEqual(["hello", "e"]);
  });
  it("regex greedy capture", () => {
    expect(m("I have a (.*) for you", "I have a present for you")).toEqual(["I have a present for you", "present"]);
  });
  it("regex case-insensitive inline flag", () => {
    expect(m("(?i)I HAVE A (.*) FOR YOU", "I have a present for you")).toEqual(["I have a present for you", "present"]);
  });
  it("regex no match", () => {
    expect(m("No match pattern", "I have a present for you")).toBeNull();
  });
  it("alternation + quantifiers", () => {
    expect(m("^(a|b)+$", "abba")).not.toBeNull();
    expect(m("^(a|b)+$", "abc")).toBeNull();
    expect(m("x{2,3}", "xxxx")).not.toBeNull();
    expect(m("x{2,3}", "x")).toBeNull();
  });
  it("char classes + \\d", () => {
    expect(m("[0-9]+", "abc123")).toEqual(["123"]);
    expect(m("\\d{3}", "ab12cd")).toBeNull();
    expect(m("[^a-z]+", "ABC")).toEqual(["ABC"]);
  });
  it("rejects backreferences and lookaround", () => {
    expect(() => compileRegex("(a)\\1")).toThrow();
    expect(() => compileRegex("(?=a)")).toThrow();
  });
  it("oversized pattern rejected", () => {
    expect(() => compileRegex("a".repeat(1001))).toThrow();
  });
  it("input byte-truncation drops trailing match", () => {
    expect(compileRegex("b$").findSubmatch("aaaaaaaa" + "b", { maxInputLength: 8 })).toBeNull();
    expect(compileRegex("b$").findSubmatch("aaaaaaa" + "b", { maxInputLength: 8 })).not.toBeNull();
  });

  // The class instructions of a compiled program, through its private fields.
  const classes = (re: unknown) =>
    ((re as { prog: { op: string; ranges?: [number, number][] }[] }).prog).filter((i) => i.op === "class");
  const distinct = (n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + 2 * i)).join("");

  it("a class is matched by binary search over its ranges", () => {
    // 990 ranges that cannot merge: a linear scan reads ~990 per character.
    const re = compileRegex(`[^${distinct(990)}]*`);
    const inst = classes(re)[0]!;
    let reads = 0;
    inst.ranges = new Proxy(inst.ranges!, {
      get(target, key, recv) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, recv);
      },
    });
    re.findSubmatch("a".repeat(1000));
    expect(reads).toBeLessThanOrEqual(1001 * 11);
  });

  it("a class's ranges are sorted and merged once", () => {
    expect(classes(compileRegex(`[^${"\\W".repeat(400)}]`))[0]!.ranges).toHaveLength(5);
    expect(m("^[ac]$", "b")).toBeNull(); // adjacent only when they touch
    expect(m("^[a-zc]$", "z")).not.toBeNull(); // a range inside another keeps the outer end
    expect(m("^\\W$", "_")).toBeNull(); // \w's constant is unsorted ("_" last); its class is not
  });

  it("every copy of a repeated class shares one ranges array", () => {
    // Normalizing per emitted copy allocated a fresh array for each of 9,900
    // copies: 720 MB for a 990-character pattern.
    const re = compileRegex(`(?:[${distinct(975)}]{100}){99}`);
    expect(new Set(classes(re).map((i) => i.ranges)).size).toBe(1);
  });

  it("normalizing character class ranges does not mutate shared WORD_RANGES tuples", () => {
    // [\\w P-d] merges [65, 90] with [80, 100]. If WORD_RANGES was mutated in-place,
    // [65, 90] becomes [65, 100], which would falsely include '[' (ASCII 91).
    compileRegex("[\\w P-d]");
    expect(compileRegex("^\\w$").findSubmatch("[")).toBeNull();
  });
});
