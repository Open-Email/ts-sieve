// The step budget bounds a test; running out does not end the script.
//
// maxExecSteps bounds the CPU one execution spends, and exhausting it threw.
// A message can drive that: three 16 KB parts under one `body :matches`, or a
// :regex key built from a header, exhaust core's budget. A thrown execute()
// skips every rule (the host's fail-open), so a sender could bypass filtering
// on purpose. Now each test (and deleteheader's matching) runs under a share of
// the budget, and a test that runs out of its share answers "unknown": the
// rule does not fire, `indeterminate` discloses the guess when it decides a
// branch, and `budgetExhausted` records why. The total stays bounded. A test
// may spend everything left except a reserve for each test after it, so one
// expensive test cannot starve the rest of the script.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

/** Core's options. */
const CORE = { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 };

function exec(script: string, eml: string, options: object = CORE) {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...options });
  const { headers, size, body } = parseEml(eml);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
  s.execute(d);
  return {
    fileinto: d.mailboxes,
    implicitKeep: d.implicitKeep,
    indeterminate: d.indeterminate,
    budgetExhausted: d.budgetExhausted,
  };
}

/** A multipart/mixed message with `n` text/plain parts of `size` bytes; part
 * `at` ends with `token`. */
function parts(n: number, size: number, at = -1, token = ""): string {
  let body = "";
  for (let i = 0; i < n; i++) body += `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(size)}${i === at ? token : ""}\r\n`;
  return `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
}

describe("a test that runs out of its share is unknown, not an error", () => {
  it("the issue's case: a glob over three 16 KB parts", () => {
    const script = 'require ["body","fileinto"]; if body :matches "*casino*" { fileinto "Junk"; } fileinto "Other";';
    expect(exec(script, parts(3, 16_000))).toEqual({
      fileinto: ["Other"],
      implicitKeep: false,
      indeterminate: true,
      budgetExhausted: true,
    });
  });

  it("a literal :regex over many parts", () => {
    const script = 'require ["body","fileinto","regex"]; if body :regex "casino" { fileinto "Junk"; } fileinto "Other";';
    expect(exec(script, parts(40, 16_000))).toMatchObject({ fileinto: ["Other"], indeterminate: true, budgetExhausted: true });
  });

  it("stays unknown under not, so a not-guarded discard does not fire", () => {
    const script = 'require "body"; if not body :matches "*casino*" { discard; }';
    expect(exec(script, parts(3, 16_000))).toMatchObject({ implicitKeep: true, indeterminate: true });
  });

  it("a :regex key built from a header", () => {
    const script = `require ["regex","variables","fileinto"];
      if header :matches "x-a" "*" { if header :regex "subject" "\${1}" { fileinto "X"; } }
      fileinto "Other";`;
    const eml = `X-A: (?:a|b){990}\r\nSubject: ${"a".repeat(1000)}\r\n\r\nbody\r\n`;
    expect(exec(script, eml)).toMatchObject({ fileinto: ["Other"], indeterminate: true, budgetExhausted: true });
  });

  it("deleteheader deletes nothing and discloses the guess", () => {
    const values = Array.from({ length: 12 }, () => `X-Big: ${"x".repeat(16_000)}`).join("\r\n");
    const script = `require ["editheader","fileinto"];
      deleteheader :matches "x-big" "*casino*";
      if exists "x-big" { fileinto "Still"; }`;
    expect(exec(script, `${values}\r\nSubject: hi\r\n\r\nbody\r\n`)).toEqual({
      fileinto: ["Still"],
      implicitKeep: false,
      indeterminate: true,
      budgetExhausted: true,
    });
  });
});

describe("later tests keep their budget", () => {
  it("a header rule after an exhausted body test still decides", () => {
    const script = `require ["body","fileinto"];
      if body :matches "*casino*" { fileinto "Junk"; }
      if header :contains "subject" "hi" { fileinto "Hi"; }`;
    expect(exec(script, parts(3, 16_000))).toMatchObject({ fileinto: ["Hi"], budgetExhausted: true });
  });

  it("five exhausted body tests, then a header :matches still decides", () => {
    const rules = Array.from({ length: 5 }, (_, i) => `if body :matches "*w${i}*" { fileinto "B${i}"; }`).join("\n");
    const script = `require ["body","fileinto"]; ${rules}
      if header :matches "subject" "h*" { fileinto "Hi"; }`;
    expect(exec(script, parts(3, 16_000))).toMatchObject({ fileinto: ["Hi"], budgetExhausted: true });
  });

  it("anyof: a sibling that decides makes the result definite", () => {
    const script = `require ["body","fileinto"];
      if anyof (body :matches "*casino*", header :contains "subject" "hi") { fileinto "Any"; }`;
    expect(exec(script, parts(3, 16_000))).toEqual({
      fileinto: ["Any"],
      implicitKeep: false,
      indeterminate: false,
      budgetExhausted: true,
    });
  });
});

describe("what does not change", () => {
  it("a test within its share answers definitely", () => {
    const script = 'require ["body","fileinto"]; if body :matches "*casino*" { fileinto "Junk"; }';
    expect(exec(script, parts(1, 8_000, 0, "casino"))).toEqual({
      fileinto: ["Junk"],
      implicitKeep: false,
      indeterminate: false,
      budgetExhausted: false,
    });
  });

  it("one expensive test may use most of the budget, not only half of it", () => {
    // Two 16 KB parts: about 196k of core's 200k steps, which completed before.
    const script = 'require ["body","fileinto"]; if body :matches "*casino*" { fileinto "Junk"; }';
    expect(exec(script, parts(2, 15_000, 1, "casino"))).toMatchObject({ fileinto: ["Junk"], budgetExhausted: false });
  });

  it("with no budget set, nothing is cut short", () => {
    const script = 'require ["body","fileinto"]; if body :matches "*casino*" { fileinto "Junk"; }';
    expect(exec(script, parts(3, 16_000, 2, "casino"), { maxMatchInputLength: 16 * 1024 })).toMatchObject({
      fileinto: ["Junk"],
      budgetExhausted: false,
    });
  });

  it("a budget smaller than the script's own commands is still an error", () => {
    expect(() => exec("keep; keep; keep; keep; keep;", "Subject: hi\r\n\r\nx\r\n", { maxExecSteps: 3 })).toThrow(/budget/);
  });
});
