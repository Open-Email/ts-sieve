// #66: a large early match must not reduce ordinary later rules to a tiny
// fixed fraction of the budget, or take needed budget from a fitting match.
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { withShare } from "../src/interp/runtime.js";
import { ALL_EXTENSIONS } from "./harness.js";

const LIMIT = 200_000;
const REQ = 'require ["body", "fileinto", "regex", "relational", "variables", "editheader", "foreverypart", "index"];';
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


describe("reserve planning is bounded and follows runtime state", () => {
  it("does not inspect future headers when no test budget remains", () => {
    let reads = 0;
    const msg = message();
    const get = msg.headerGet.bind(msg);
    msg.headerGet = (name) => { reads++; return get(name); };
    const s = load(Array.from({ length: 100 }, (_, i) => `if header :is "x-${i}" "x" {}`).join("\n"), { maxExecSteps: LIMIT });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
    d.budget.remaining = s.commandCount;
    for (let i = 0; i < 100; i++) expect(withShare(d, i, () => true)).toBe("unknown");
    expect(reads).toBe(0);
    expect(d.budget.remaining).toBe(s.commandCount);
  });

  it("charges planning before reading each new field and propagates exhaustion", () => {
    let reads = 0;
    const msg = message();
    msg.headerGet = () => { reads++; return []; };
    const s = load(Array.from({ length: 100 }, (_, i) => `if header :is "x-${i}" "x" {}`).join("\n"), { maxExecSteps: LIMIT });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
    d.budget.remaining = s.commandCount + 6;
    expect(withShare(d, 0, () => true)).toBe("unknown");
    expect(reads).toBeLessThanOrEqual(4);
    expect(d.budget.remaining).toBe(s.commandCount);
  });

  it("refreshes estimates after virtual header edits", () => {
    const d = exec('if header :contains "subject" "ordinary" {} deleteheader "subject"; addheader "Subject" "' + "x".repeat(200) + ' viagra";' + EXPENSIVE + later('header :matches "subject" "*viagra*"'));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it.each([1, 3])("protects a later message rule across %i nested loop shares", (depth) => {
    let body = new TextDecoder().decode(message().bodyRaw()!);
    let boundary = "b";
    for (let i = 1; i < depth; i++) {
      body = `--outer${i}\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n${body}\r\n--outer${i}--\r\n`;
      boundary = `outer${i}`;
    }
    const msg = new MessageStatic(body.length, new Map([
      ["subject", ["x".repeat(200) + " viagra"]],
      ["content-type", [`multipart/mixed; boundary=${boundary}`]],
    ]), new TextEncoder().encode(body));
    const d = exec("foreverypart {".repeat(depth) + EXPENSIVE + "}".repeat(depth) + later('header :matches "subject" "*viagra*"'), msg);
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it("does not turn an unreadable but skipped future header into a runtime error", () => {
    const msg = message();
    msg.headerGet = () => { throw new Error("unreadable header"); };
    const d = exec('if size :over 0 { stop; } if header :is "x-unreadable" "x" { discard; }', msg);
    expect([d.indeterminate, d.budgetExhausted]).toEqual([false, false]);
  });
});


describe("reserve inputs and cache lifetime", () => {
  it("does not copy an oversized field list just to replay edits for an estimate", () => {
    let reads = 0;
    const values = new Proxy(Array<string>(5000).fill("x"), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const msg = message();
    msg.headerGet = () => values;
    const s = load('if header :is "subject" "x" {}', { maxExecSteps: LIMIT });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
    d.headerEdits.push({ action: "add", fieldName: "subject", value: "y", index: 0, last: false });
    expect(withShare(d, 0, () => true)).toBe(true);
    expect(reads).toBe(0);
  });

  it.each([false, true])("uses replacement message estimates in a %s clone", (clone) => {
    const s = load(REQ + EXPENSIVE + later('header :matches "subject" "*viagra*"'), { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: LIMIT, maxMatchInputLength: 16 * 1024 });
    let d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), message());
    expect(withShare(d, 0, () => true)).toBe(true);
    if (clone) d = d.clone();
    d.msg = message([["subject", ["x".repeat(200) + " viagra"]]]);
    s.execute(d);
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });

  it.each([false, true])("reserves only for the selected field (:last = %s)", (last) => {
    const values = Array.from({ length: 5000 }, () => "x".repeat(200));
    values[last ? values.length - 1 : 0] = "viagra";
    const d = exec(EXPENSIVE + later(`header :index 1 ${last ? ":last" : ""} :matches "subject" "*viagra*"`), message([["subject", values]]));
    expect(d.mailboxes).toEqual(["Later"]);
    expect(d.budgetExhausted).toBe(true);
  });
});
