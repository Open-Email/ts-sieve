// Direct pins on the testString comparator arms (matching.ts) that the corpus
// exercises only through the two default comparators. Driven through the
// `string` test so the arms are hit exactly as delivery hits them.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const EML = ["From: a@x", "To: b@y", "Subject: hi", "", "body"].join("\r\n");

/** True iff the script's single `if` fired. */
const hit = (test: string): boolean =>
  run(`require ["fileinto","variables","relational","regex","comparator-i;unicode-casemap","comparator-i;ascii-numeric"]; if ${test} { fileinto "X"; }`, EML)
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

  it("folds Greek final sigma context-free (RFC 5051)", () => {
    // σ (U+03C3) and ς (U+03C2) map to the same titlecase Σ (U+03A3)
    expect(hit('string :comparator "i;unicode-casemap" :is "ς" "σ"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :is "ΑΣ" "Ασ"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :is "ΑΣ" "Ας"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :contains "βς" "βσ"')).toBe(true);
    expect(hit('string :comparator "i;unicode-casemap" :is "ΟΣ ΟΣ" "οσ οσ"')).toBe(true); // every ς, not the first
  });

  it(":regex folds the pattern's ς as it folds the input's", () => {
    expect(hit('string :regex :comparator "i;unicode-casemap" "ΟΔΟΣ" "οδος"')).toBe(true);
    expect(hit('string :regex :comparator "i;unicode-casemap" "οδός" "οδός"')).toBe(true);
    expect(hit('string :regex :comparator "i;unicode-casemap" "ΟΔΟΣ" "^οδο[^ς]$"')).toBe(false);
    expect(hit('string :regex :comparator "i;unicode-casemap" "ΟΣ ΟΣ" "^ος ος$"')).toBe(true); // every ς in the pattern
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
