// Direct pins on the testString comparator arms (matching.ts) that the corpus
// exercises only through the two default comparators. Driven through the
// `string` test so the arms are hit exactly as delivery hits them.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const EML = ["From: a@x", "To: b@y", "Subject: hi", "", "body"].join("\r\n");

/** True iff the script's single `if` fired. */
const hit = (test: string): boolean =>
  run(`require ["fileinto","variables","relational","comparator-i;unicode-casemap","comparator-i;ascii-numeric"]; if ${test} { fileinto "X"; }`, EML)
    .fileinto.length > 0;

describe("i;unicode-casemap", () => {
  it(":is folds full Unicode, not just ASCII", () => {
    expect(hit('string :comparator "i;unicode-casemap" :is "ÜBER" "über"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :is "ÜBER" "unter"')).toBe(false);
  });

  it(":contains folds full Unicode (simple folding — ß stays distinct from ss)", () => {
    expect(hit('string :comparator "i;unicode-casemap" :contains "GRÖSSE MATTERS" "grösse"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :contains "GRÖSSE" "größe"')).toBe(false);
  });
});

describe("i;ascii-numeric (RFC 4790 §9.1.1)", () => {
  it(":is compares the longest leading digit runs", () => {
    expect(hit('string :comparator "i;ascii-numeric" :is "42abc" "42xyz"')).toBe(true);
    expect(hit('string :comparator "i;ascii-numeric" :is "042" "42"')).toBe(true);
    expect(hit('string :comparator "i;ascii-numeric" :is "42" "43"')).toBe(false);
  });

  it("non-numeric values are +infinity: two infinities are equal, one is not", () => {
    expect(hit('string :comparator "i;ascii-numeric" :is "abc" "def"')).toBe(true);
    expect(hit('string :comparator "i;ascii-numeric" :is "abc" "42"')).toBe(false);
    expect(hit('string :comparator "i;ascii-numeric" :is "42" "abc"')).toBe(false);
  });
});

describe("i;octet", () => {
  it(":is and :contains compare bytes without folding", () => {
    expect(hit('string :comparator "i;octet" :is "Ab" "Ab"')).toBe(true);
    expect(hit('string :comparator "i;octet" :is "Ab" "ab"')).toBe(false);
    expect(hit('string :comparator "i;octet" :contains "xAbx" "Ab"')).toBe(true);
    expect(hit('string :comparator "i;octet" :contains "xAbx" "ab"')).toBe(false);
  });
});
