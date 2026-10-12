// #66: a large early match must not reduce ordinary later rules to a tiny
// fixed fraction of the budget, or take needed budget from a fitting match.
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS } from "./harness.js";

const LIMIT = 200_000;
const REQ = 'require ["body", "fileinto", "regex", "relational", "variables", "editheader", "foreverypart"];';
const EXPENSIVE = 'if body :matches "*casino*" { fileinto "Body"; }';

function message(fields: [string, string[]][] = [], sizes = [16_000, 16_000, 16_000], token = "") {
  const body = sizes.map((n, i) => `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(n)}${i === sizes.length - 1 ? token : ""}\r\n`).join("") + '--b--\r\n';
  return new MessageStatic(body.length, new Map([
    ["subject", ["ordinary subject"]], ["from", ["spammer@example.com"]],
    ["content-type", ["multipart/mixed; boundary=b"]], ...fields,
  ]), new TextEncoder().encode(body));
}

function exec(commands: string, msg = message(), limit = LIMIT) {
  const s = load(REQ + commands, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: limit, maxMatchInputLength: 16 * 1024 });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
  s.execute(d);
  expect(d.budget.remaining).toBeGreaterThanOrEqual(0);
  return d;
}

const later = (test: string) => `if ${test} { fileinto "Later"; }`;

describe("later ordinary rules keep useful budget (#66)", () => {
  it.each([1, 5, 20])("%i header globs still match after an exhausted body glob", (count) => {
    const commands = Array.from({ length: count }, (_, i) => `if header :matches "subject" "*viagra*" { fileinto "Later${i}"; }`).join("\n");
    const d = exec(EXPENSIVE + commands, message([["subject", ["x".repeat(200) + " viagra"]]]));
    expect(d.mailboxes).toEqual(Array.from({ length: count }, (_, i) => `Later${i}`));
    expect(d.budgetExhausted).toBe(true);
  });

  it.each(["matches", "regex"] as const)("a header :%s over an ordinary subject", (kind) => {
    const key = kind === "matches" ? "*viagra*" : ".*viagra.*";
    const d = exec(EXPENSIVE + later(`header :${kind} "subject" "${key}"`), message([["subject", ["x".repeat(80) + " viagra"]]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it("an address glob over a normal mailbox", () => {
    const d = exec(EXPENSIVE + later('address :matches "from" "*@remote-tr.test"'), message([["from", ["a".repeat(40) + "@remote-tr.test"]]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it.each(["is", "contains"] as const)("a header :%s through repeated fields", (kind) => {
    const fields = [...Array.from({ length: 250 }, () => "ordinary"), "viagra"];
    const d = exec(EXPENSIVE + later(`header :${kind} "subject" "viagra"`), message([["subject", fields]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it("the JSON-rule shape: large Subjects followed by a sender glob", () => {
    const d = exec('if header :matches "subject" "*sale*" { fileinto "Sale"; }' + later('address :matches "from" "*@remote-tr.test"'), message([
      ["subject", Array.from({ length: 3 }, () => "x".repeat(16_000))],
      ["from", ["a".repeat(40) + "@remote-tr.test"]],
    ]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it("several exhausted body globs do not keep halving the final rule's reserve", () => {
    const d = exec(EXPENSIVE.repeat(5) + later('header :matches "subject" "*viagra*"'), message([["subject", ["x".repeat(80) + " viagra"]]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it("an anyof sibling can prove the whole condition after budget exhaustion", () => {
    const d = exec(later('anyof (body :matches "*casino*", header :matches "subject" "*viagra*")'), message([["subject", ["x".repeat(80) + " viagra"]]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.indeterminate).toBe(false);
    expect(d.budgetExhausted).toBe(true);
  });
});

describe("reserving for later rules must leave fitting earlier rules definite (#66)", () => {
  it.each([50, 100])("a near-budget body miss, %i cheap rules, then a definite discard", (count) => {
    const cheap = Array.from({ length: count }, (_, i) => `if header :contains "subject" "missing${i}" { keep; }`).join("\n");
    const commands = EXPENSIVE + cheap + 'if address :is "from" "spammer@example.com" { discard; }';
    const roomy = exec(commands, message([], [16_000, 15_750]), 10 * LIMIT);
    expect([roomy.implicitKeep, roomy.indeterminate]).toEqual([false, false]);
    expect(10 * LIMIT - roomy.budget.remaining, "the complete cold run fits the real budget").toBeLessThan(LIMIT);
    const d = exec(commands, message([], [16_000, 15_750]));
    expect([d.implicitKeep, d.indeterminate, d.budgetExhausted]).toEqual([false, false, false]);
  });

  it("a fitting body hit followed by a sender glob keeps both answers", () => {
    const d = exec(EXPENSIVE + later('address :matches "from" "*@example.com"'), message([], [15_000, 15_000], "casino"));
    expect(d.mailboxes).toEqual(["Body", "Later"]);
    expect(d.indeterminate).toBe(false);
    expect(d.budgetExhausted).toBe(false);
  });

  it("a later miss does not turn into a match when more budget is available", () => {
    const d = exec(EXPENSIVE + later('header :matches "subject" "*viagra*"'), message([["subject", ["x".repeat(200)]]]));
    expect(d.mailboxes).toEqual([]);
    expect(d.budgetExhausted).toBe(true);
  });
});
