// #83: test_set must update readable fixture state, or reject the name.
// Pigeonhole's envelope "to" test reads the original recipient; this harness
// models that one Sieve-visible recipient, not separate SMTP delivery state.

import { describe, expect, it } from "vitest";
import { load } from "../../src/index.js";
import { ALL_EXTENSIONS } from "../harness.js";
import { Reporter, runDovecotInline } from "./harness.js";

const REQ = 'require ["vnd.dovecot.testsuite", "variables", "envelope"];';

function expectPass(commands: string): void {
  const r = runDovecotInline(`${REQ} ${commands}`);
  expect(r.report()).toBe("");
  expect(r.passed).toHaveLength(1);
}

describe("test_set fixture names (#83)", () => {
  it.each(["message", "Message", "MESSAGE"])("sets the message through %s", (name) => {
    expectPass(`test_set "${name}" "Subject: new message\r\n\r\nbody";
      test "message replaced" {
        if not header :is "subject" "new message" { test_fail "message was not replaced"; }
        if not string :is "\${message}" "" { test_fail "special name became a variable"; }
      }`);
  });

  it.each([
    ["Envelope.From", "from", "sender@example.net"],
    ["ENVELOPE.TO", "to", "final@example.net"],
    ["envelope.orig_to", "to", "original@example.net"],
    ["Envelope.Orig_To", "to", "original@example.net"],
    ["Envelope.Auth", "auth", "username"],
  ])("sets %s through an expanded value readable by envelope tests and variables", (name, part, value) => {
    expectPass(`set "value" "${value}";
      test_set "${name}" "\${value}";
      test "envelope replaced" {
        if not envelope :is "${part}" "${value}" { test_fail "envelope was not replaced"; }
        if not string :is "\${envelope.${part}}" "${value}" { test_fail "envelope variable disagrees"; }
      }`);
  });

  it("normalizes the original recipient and preserves it when sender or auth changes", () => {
    expectPass(`test_set "envelope.to" "final@example.net";
      test_set "envelope.orig_to" "<original@example.net>";
      test_set "envelope.from" "<sender@example.net>";
      test_set "envelope.auth" "user";
      test "original recipient" {
        if not allof (envelope :is "to" "original@example.net",
                      envelope :is "from" "sender@example.net",
                      envelope :is "auth" "user") { test_fail "original recipient was lost"; }
        test_set "envelope.to" "next@example.net";
        if not envelope :is "to" "next@example.net" { test_fail "recipient was not reset"; }
      }`);
  });

  it.each(["envelope.unknown", "unknown.member", "message.subject", "envelope.to.extra", "Envelope.OrigTo"])(
    "rejects unreachable dotted name %s at load, even in a skipped arm",
    (name) => {
      expect(() => load(`${REQ} if false { test_set "${name}" "value"; }`, {
        enabledExtensions: ALL_EXTENSIONS,
        testEnv: new Reporter(),
      })).toThrow(/test_set.*unsupported.*name/i);
    },
  );

  it("keeps raw, case-insensitive unqualified test variables", () => {
    expectPass(`test_set "Mixed" "literal \${not_expanded}";
      test "raw variable" {
        if not string :contains "\${mixed}" "not_expanded" { test_fail "raw value was expanded"; }
      }`);
  });
});
