// The linear (Pike-VM) regex engine, arm by arm.
//
// `regex-engine.test.ts` covers the shapes ordinary scripts use; this file
// walks the parser/compiler/VM branches those miss — escapes, classes,
// repetition forms, anchors, inline flags, astral code points, and every
// refusal. The engine is the one hand-rolled piece of machinery here that an
// attacker's PATTERN reaches directly (a script author's regex, run against a
// stranger's mail), so its edges deserve pins rather than inference.
//
// Driven through `:regex` on a header, exactly as delivery reaches it.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const REQ = 'require ["regex","fileinto","variables"];';

/** Does `pattern` match `value` (as an X-T header)? */
function m(pattern: string, value: string): boolean {
  const eml = ["From: a@x", "To: b@y", `X-T: ${value}`, "", "body"].join("\r\n");
  return run(`${REQ} if header :regex "x-t" "${pattern}" { fileinto "X"; }`, eml).fileinto.includes("X");
}

/** Same, under i;octet — no value folding, so case is observable. */
function mOctet(pattern: string, value: string): boolean {
  const eml = ["From: a@x", "To: b@y", `X-T: ${value}`, "", "body"].join("\r\n");
  return run(`${REQ} if header :comparator "i;octet" :regex "x-t" "${pattern}" { fileinto "X"; }`, eml).fileinto.includes(
    "X",
  );
}

/** Capture group N, or "" when the match failed. */
function cap(pattern: string, value: string, n = 1): string {
  const eml = ["From: a@x", "To: b@y", `X-T: ${value}`, "", "body"].join("\r\n");
  return (
    run(`${REQ} if header :regex "x-t" "${pattern}" { fileinto "\${${n}}"; }`, eml).fileinto[0] ?? ""
  );
}

/** Compile-only, for refusals. */
function compile(pattern: string): void {
  run(`${REQ} if header :regex "x-t" "${pattern}" { fileinto "X"; }`, "From: a@x\r\n\r\nb");
}

describe("escapes outside classes", () => {
  it("perl classes and their negations", () => {
    expect(m("^\\\\d+$", "12345")).toBe(true);
    expect(m("^\\\\d+$", "12a45")).toBe(false);
    expect(m("^\\\\D+$", "abc")).toBe(true);
    expect(m("^\\\\w+$", "a_9")).toBe(true);
    expect(m("^\\\\W+$", "!@ ")).toBe(true);
    expect(m("a\\\\s+b", "a \tb")).toBe(true);
    expect(m("^\\\\S+$", "abc")).toBe(true);
    expect(m("^\\\\S+$", "a c")).toBe(false);
  });

  it("control-character escapes", () => {
    // A header value's LEADING whitespace is stripped on parse (RFC 5322), so
    // control characters are asserted mid-value.
    expect(m("a\\\\tb", "a\tb")).toBe(true);
    expect(m("^x\\\\vy$", "x\vy")).toBe(true);
    expect(m("^x\\\\fy$", "x\fy")).toBe(true);
  });

  it("word-boundary and absolute anchors", () => {
    expect(m("\\\\bcat\\\\b", "the cat sat")).toBe(true);
    expect(m("\\\\bcat\\\\b", "concatenate")).toBe(false);
    expect(m("\\\\Bcat\\\\B", "concatenate")).toBe(true);
    expect(m("\\\\Acat", "cat sat")).toBe(true);
    expect(m("\\\\Acat", "the cat")).toBe(false);
    expect(m("sat\\\\z", "the cat sat")).toBe(true);
    expect(m("cat\\\\z", "the cat sat")).toBe(false);
  });

  it("an escaped metacharacter is a literal", () => {
    expect(m("^a\\\\.b$", "a.b")).toBe(true);
    expect(m("^a\\\\.b$", "axb")).toBe(false);
    expect(m("^\\\\$5$", "$5")).toBe(true);
    expect(m("^\\\\[x\\\\]$", "[x]")).toBe(true);
  });
});

describe("character classes", () => {
  it("ranges, negation and literal edges", () => {
    expect(m("^[a-f]+$", "cafe")).toBe(true);
    expect(m("^[a-f]+$", "cafz")).toBe(false);
    expect(m("^[^0-9]+$", "abc")).toBe(true);
    expect(m("^[^0-9]+$", "ab3")).toBe(false);
    // A leading ] is a literal, and a trailing - is a literal.
    expect(m("^[]]$", "]")).toBe(true);
    expect(m("^[a-]+$", "a-a")).toBe(true);
  });

  it("perl classes inside a class, including negated ones", () => {
    expect(m("^[\\\\d]+$", "42")).toBe(true);
    expect(m("^[\\\\w.]+$", "a.b_9")).toBe(true);
    expect(m("a[\\\\s]+b", "a \tb")).toBe(true);
    expect(m("^[\\\\D]+$", "abc")).toBe(true);
    expect(m("^[\\\\W]+$", "!@")).toBe(true);
    expect(m("^[\\\\S]+$", "ab")).toBe(true);
  });

  it("escaped control characters inside a class", () => {
    expect(m("a[\\\\t]+b", "a\t\tb")).toBe(true);
    expect(m("^[\\\\v\\\\f]+$", "\v\f")).toBe(true);
    expect(m("^[\\\\-]+$", "--")).toBe(true);
  });

  it("case folding applies inside classes under (?i)", () => {
    expect(m("(?i)^[a-f]+$", "CAFE")).toBe(true);
    // The default comparator (i;ascii-casemap) pre-folds the VALUE, so
    // non-folding must be asserted under i;octet.
    expect(mOctet("^[a-f]+$", "CAFE")).toBe(false);
  });
});

describe("repetition", () => {
  it("greedy and lazy star/plus/quest", () => {
    expect(cap("^(a*)a", "aaa")).toBe("aa"); // greedy backs off one
    expect(cap("^(a*?)a", "aaa")).toBe(""); // lazy takes none
    expect(cap("^(a+?)a", "aaa")).toBe("a");
    expect(m("^ab?c$", "ac")).toBe(true);
    expect(m("^ab?c$", "abc")).toBe(true);
    expect(m("^ab??c$", "abc")).toBe(true);
  });

  it("counted repetition: {n}, {n,}, {n,m} — and their lazy forms", () => {
    expect(m("^a{3}$", "aaa")).toBe(true);
    expect(m("^a{3}$", "aa")).toBe(false);
    expect(m("^a{2,}$", "aaaa")).toBe(true);
    expect(m("^a{2,}$", "a")).toBe(false);
    expect(m("^a{2,3}$", "aaa")).toBe(true);
    expect(m("^a{2,3}$", "aaaa")).toBe(false);
    expect(cap("^(a{2,3}?)a", "aaaa")).toBe("aa"); // lazy takes the minimum
  });

  it("an unparseable brace is a literal brace, not an error", () => {
    // `{` with no valid count falls back to a literal — the Perl/PCRE habit.
    expect(m("^a{x}$", "a{x}")).toBe(true);
    expect(m("^a{$", "a{")).toBe(true);
    expect(m("^a{2$", "a{2")).toBe(true);
  });

  it("refuses counts that would blow up the program", () => {
    expect(() => compile("a{100000}")).toThrow(/repetition count too large/);
    expect(() => compile("a{1,100000}")).toThrow(/repetition count too large/);
    expect(() => compile("a{5,2}")).toThrow(/invalid repetition range/);
  });
});

describe("groups, alternation and flags", () => {
  it("numbers capture groups left to right, and non-capturing groups do not consume a slot", () => {
    expect(cap("(a)(b)", "ab", 1)).toBe("a");
    expect(cap("(a)(b)", "ab", 2)).toBe("b");
    expect(cap("(?:a)(b)", "ab", 1)).toBe("b");
  });

  it("alternation picks the leftmost alternative that lets the whole match succeed", () => {
    expect(m("^(?:cat|dog)$", "dog")).toBe(true);
    expect(m("^(?:cat|dog)$", "cow")).toBe(false);
    expect(cap("^(cat|catalog)$", "catalog")).toBe("catalog");
  });

  it("inline flags: (?i) mid-pattern, (?s) for dot, scoped (?i:…)", () => {
    expect(m("(?i)abc", "ABC")).toBe(true);
    expect(mOctet("abc", "ABC")).toBe(false);
    // Scoped: folding applies inside the group only.
    expect(m("^(?i:ab)c$", "ABc")).toBe(true);
    expect(mOctet("^(?i:ab)c$", "ABC")).toBe(false);
    // (?s) makes . match a newline — headers are unfolded to one line, so
    // assert the flag parses and still matches ordinary text.
    expect(m("(?s)a.c", "abc")).toBe(true);
  });

  it("(?m) switches ^/$ to line anchors", () => {
    expect(m("(?m)^abc$", "abc")).toBe(true);
  });

  it("refuses lookaround, backreferences and unknown group types", () => {
    expect(() => compile("(?=foo)")).toThrow(/lookaround not supported/);
    expect(() => compile("(?!foo)")).toThrow(/lookaround not supported/);
    expect(() => compile("(?<=foo)")).toThrow(/lookaround not supported/);
    expect(() => compile("(a)\\\\1")).toThrow(/backreferences not supported/);
    expect(() => compile("(?P<n>a)")).toThrow(/unsupported group/);
  });

  it("refuses malformed patterns", () => {
    expect(() => compile("(abc")).toThrow(/missing \)/);
    expect(() => compile("[abc")).toThrow(/unterminated|missing/i);
    expect(() => compile("*abc")).toThrow(/unexpected token/);
    expect(() => compile("a\\\\")).toThrow(/trailing backslash/);
  });
});

describe("unicode and code points", () => {
  it("matches astral code points as single units, not surrogate halves", () => {
    // A pattern splitting the pair would make this unmatchable.
    expect(m("^\u{1F600}$", "\u{1F600}")).toBe(true);
    expect(m("^.$", "\u{1F600}")).toBe(true); // one code point, so `.` suffices
    expect(m("^[\u{1F600}\u{1F601}]$", "\u{1F601}")).toBe(true);
  });

  it("does NOT implement \\u{...} escapes — write the character itself", () => {
    // A documented limit rather than a silent surprise: `u` is not an escape
    // letter here, so it degrades to a literal `u` followed by a brace run
    // that is not a valid repetition (hence literal braces too).
    expect(m("^u\\\\{1f600\\\\}$", "u{1F600}")).toBe(true);
    expect(m("^\\\\u{1f600}$", "\u{1F600}")).toBe(false);
  });

  it("non-ASCII literals match verbatim, and (?i) folds only ASCII", () => {
    expect(m("^über$", "über")).toBe(true);
    expect(m("(?i)^UBER$", "uber")).toBe(true);
    // ASCII-only folding: Ü does not fold to ü in this engine.
    expect(m("(?i)^ÜBER$", "über")).toBe(false);
  });
});

describe("comparator folding is one-sided for :regex", () => {
  it("the VALUE is folded by the comparator; the PATTERN never is", () => {
    // A real gotcha worth pinning: under the default i;ascii-casemap the value
    // is lowercased before matching while the pattern is passed through
    // verbatim, so an UPPERCASE literal in a :regex pattern can never match.
    // The fix a script author wants is (?i) or a lowercase pattern.
    expect(m("^ABC$", "ABC")).toBe(false); // value folded to "abc" ≠ pattern
    expect(m("^abc$", "ABC")).toBe(true);
    expect(m("(?i)^ABC$", "ABC")).toBe(true);
    // Under i;octet neither side is folded, so the uppercase pattern works.
    expect(mOctet("^ABC$", "ABC")).toBe(true);
  });
});

describe("search vs anchor semantics", () => {
  it(":regex searches (unanchored) unless the pattern anchors itself", () => {
    expect(m("cat", "the cat sat")).toBe(true);
    expect(m("^cat", "the cat sat")).toBe(false);
    expect(m("sat$", "the cat sat")).toBe(true);
  });

  it("an empty pattern matches anything", () => {
    expect(m("", "whatever")).toBe(true);
  });
});
