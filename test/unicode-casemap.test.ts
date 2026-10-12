import { describe, expect, it } from "vitest";
import { toUnicodeCasemapFold as fold, testStringPrefix } from "../src/interp/matching.js";
import { run } from "./harness.js";

const require = 'require ["variables", "fileinto", "body", "relational", "comparator-i;unicode-casemap"];';
const quote = (s: string) => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
const hit = (kind: string, a: string, b: string) => run(require + `if string :comparator "i;unicode-casemap" ${kind} ${quote(a)} ${quote(b)} { fileinto "hit"; }`).fileinto;

// RFC 5051 §2 applies UnicodeData's simple titlecase ONCE, then recursively
// decomposes without reordering or titlecasing the resulting characters.
it.each([
  ["é", "E\u0301"], ["ｓｐａｍ", "SPAM"], ["ﬁ", "fi"],
  ["𝓼𝓹𝓪𝓶", "spam"], ["Ǆ", "Dz\u030c"], ["ά\u0316", "Α\u0301\u0316"],
  ["ß", "ß"], ["ẞ", "ẞ"], ["ა", "ა"], ["Ა", "Ა"],
])("prepares %s as the RFC specifies", (input, expected) => expect(fold(input)).toBe(expected));

const equivalent = [
  ["é", "e\u0301"], ["ｓｐａｍ", "spam"], ["𝓢𝓟𝓐𝓜", "spam"],
  ["ı", "i"], ["ſ", "s"], ["µ", "μ"], ["\u0345", "ι"], ["ι", "ι"],
  ["ϐ", "β"], ["ϵ", "ε"], ["ϑ", "θ"], ["ϰ", "κ"], ["ϖ", "π"],
  ["ϱ", "ρ"], ["ϕ", "φ"], ["ẛ", "ṡ"], ["ᲀ", "в"], ["ᲁ", "д"],
  ["ᲂ", "о"], ["ᲃ", "с"], ["ᲄ", "т"], ["ᲅ", "т"], ["ᲆ", "ъ"], ["ᲇ", "ѣ"], ["ᲈ", "ꙋ"],
];
describe.each([":is", ':value "eq"', ":matches"])("%s uses the same Unicode preparation", (kind) => {
  it.each(equivalent)("equates %s with %s", (a, b) => expect(hit(kind, a!, b!)).toEqual(["hit"]));
  it.each([["ß", "ẞ"], ["ა", "Ა"], ["ﬁ", "fi"], ["𝓼", "s"]])("keeps %s distinct from %s", (a, b) => expect(hit(kind, a!, b!)).toEqual([]));
});

it("substring matching decomposes fullwidth words", () => expect(hit(":contains", "buy ｓｐａｍ today", "spam")).toEqual(["hit"]));
it("Unicode ordering is UTF-8 ordering after preparation", () => {
  expect(hit(':value "lt"', "é", "f")).toEqual(["hit"]);
  expect(hit(':value "gt"', "\u{10000}", "\ue000")).toEqual(["hit"]);
});
it("preparation is stable when a later combining mark extends the input", () => {
  const prefix = "á";
  expect(fold(prefix + "\u0316").startsWith(fold(prefix))).toBe(true);
  expect(testStringPrefix("i;unicode-casemap", "contains", prefix, "a\u0301")).toBe(true);
});
it("wildcards capture original text and question-mark consumes one source character", () => {
  const r = run(require + 'if string :comparator "i;unicode-casemap" :matches "ÉTÉ-ß" "été-?" { fileinto "${1}"; }');
  expect(r.fileinto).toEqual(["ß"]);
  expect(hit(":matches", "é", "?")).toEqual(["hit"]);
  expect(hit(":matches", "e\u0301", "??")).toEqual(["hit"]);
  expect(hit(":matches", "é", "??")).toEqual([]);
  expect(run(require + 'if string :comparator "i;unicode-casemap" :matches "ÉTÉ-Mixed" "été-*" { fileinto "${1}"; }').fileinto).toEqual(["Mixed"]);
});
it("decomposition cannot turn a fullwidth literal into wildcard syntax", () => {
  expect(hit(":matches", "other", "＊")).toEqual([]);
  expect(hit(":matches", "*", "＊")).toEqual(["hit"]);
  expect(hit(":matches", "?", "？")).toEqual(["hit"]);
});
it("dynamic glob keys use the same fold", () => {
  expect(run(require + 'set "p" "été-*"; if string :comparator "i;unicode-casemap" :matches "ÉTÉ-Mixed" "${p}" { fileinto "${1}"; }').fileinto).toEqual(["Mixed"]);
});
it("a trailing wildcard proves a match over a cut Unicode prefix", () => {
  const result = run(require + 'if body :comparator "i;unicode-casemap" :matches "été*" { fileinto "hit"; }', '\r\n\r\nÉTÉ', { bodyTruncated: true });
  expect(result.fileinto).toEqual(["hit"]);
});

it("Unicode globs retain the existing lazy wildcard and capture choices", () => {
  const values = ["", "a", "b", "A", "*", "?", "\\"];
  for (let n = 2; n <= 4; n++) for (let i = 0; i < 2 ** n; i++) values.push(i.toString(2).padStart(n, "0").replaceAll("0", "a").replaceAll("1", "b"));
  const patterns = ["", "*", "?", "??", "?*", "*?", "*?*", "a*b", "**", "*a*", "*a?*", "?a*", "\\*", "\\?", "\\"];
  for (const value of values) for (const pattern of patterns) {
    const capture = (comparator: string) => run(require + `if string :comparator "${comparator}" :matches ${quote(value)} ${quote(pattern)} { fileinto "matched:${'${0}|${1}|${2}|${3}'}"; }`).fileinto;
    expect(capture("i;unicode-casemap"), JSON.stringify({ value, pattern })).toEqual(capture("i;ascii-casemap"));
  }
});
it("a byte cap cannot make a whole-input Unicode glob match definite", () => {
  const result = run(require + 'if body :comparator "i;unicode-casemap" :matches "été" { fileinto "hit"; }', '\r\n\r\nÉTÉ and more', { options: { maxMatchInputLength: 5 } });
  expect(result.fileinto).toEqual([]);
  expect(result.indeterminate).toBe(true);
});
it("Unicode glob work yields unknown on budget exhaustion", () => {
  const result = run(require + 'if body :comparator "i;unicode-casemap" :matches "*never*" { fileinto "hit"; }', '\r\n\r\n' + "é".repeat(10_000), { options: { maxExecSteps: 500 } });
  expect(result.fileinto).toEqual([]);
  expect(result.indeterminate).toBe(true);
});
