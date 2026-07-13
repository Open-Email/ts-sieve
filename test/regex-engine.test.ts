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
});
