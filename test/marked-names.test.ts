// Small fixes around marked values (#60) found in its reviews: mailboxexists
// expands variables (#63), test_set leaves no stale mark (#62), and a test
// that cannot set captures does not doubt them when it answers unknown (#61,
// F5).

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type RuntimeData } from "../src/index.js";
import { redirectsOnGuess } from "../src/interp/action.js";
import { runDovecotInline } from "./dovecot/harness.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

/** A header past maxVariableLen (4000): a variable set from it is a prefix. */
const LONG = "a".repeat(4500);
/** Sets "big", marked as a prefix. */
const MARK = 'if header :matches "x-long" "*" { set "big" "${1}"; }';

function exec(script: string, opts: { subject?: string; exists?: (name: string) => boolean } = {}): RuntimeData {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS });
  const { headers, size, body } = parseEml(`From: a@x\r\nTo: b@y\r\nX-Long: ${LONG}\r\nSubject: ${opts.subject ?? "s"}\r\n\r\nbody\r\n`);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
  if (opts.exists) d.mailboxChecker = { exists: opts.exists };
  s.execute(d);
  return d;
}

describe("mailboxexists expands variables (#63)", () => {
  it("asks the host about the expanded name", () => {
    const asked: string[] = [];
    const exists = (name: string) => (asked.push(name), name === "Archive");
    const d = exec('require ["mailbox","variables","fileinto"]; set "f" "Archive"; if mailboxexists "${f}" { fileinto "Yes"; }', { exists });
    expect([asked, d.mailboxes, d.indeterminate]).toEqual([["Archive"], ["Yes"], false]);
  });

  it("answers unknown for a name built from a marked value", () => {
    const d = exec(`require ["mailbox","variables","fileinto"]; ${MARK} if mailboxexists "\${big}" { fileinto "Yes"; }`, { exists: () => true });
    expect([d.mailboxes, d.indeterminate]).toEqual([[], true]);
  });

  it("does not ask the host about a marked name, whose answer it cannot use", () => {
    const asked: string[] = [];
    exec(`require ["mailbox","variables","fileinto"]; ${MARK} if mailboxexists ["\${big}", "Inbox"] { fileinto "Yes"; }`, { exists: (name) => (asked.push(name), true) });
    expect(asked).toEqual(["Inbox"]);
  });

  it("without a host to ask, every name exists, a marked one too", () => {
    const d = exec(`require ["mailbox","variables","fileinto"]; ${MARK} if mailboxexists "\${big}" { fileinto "Yes"; }`);
    expect([d.mailboxes, d.indeterminate]).toEqual([["Yes"], false]);
  });

  it("without variables, a name is literal", () => {
    const asked: string[] = [];
    exec('require ["mailbox","fileinto"]; if mailboxexists "${f}" { fileinto "Yes"; }', { exists: (name) => (asked.push(name), true) });
    expect(asked).toEqual(["${f}"]);
  });
});

describe("test_set stores a variable as set does (#62)", () => {
  const expectAllPass = (script: string) => {
    const r = runDovecotInline(script);
    expect(r.report()).toBe("");
    expect(r.passed.length).toBeGreaterThan(0);
  };

  it("with no mark left from an earlier value", () => {
    expectAllPass(`require ["vnd.dovecot.testsuite", "variables"];
test_set "message" text:
From: a@x
X-Long: ${LONG}

body
.
;
${MARK}
test_set "Big" "abc";
test "a variable test_set set reads whole" {
  if string :is "\${big}" "abc" { set "ok" "1"; }
  if not string :is "\${ok}" "1" { test_fail "read as a prefix"; }
}`);
  });

  it("under its name in any case", () => {
    expectAllPass(`require ["vnd.dovecot.testsuite", "variables"];
test_set "BIG" "abc";
test "variable names are case-insensitive" {
  if not string :is "\${big}" "abc" { test_fail "not found"; }
}`);
  });
});

describe("a test that cannot set captures leaves them whole when it is unknown (#61 F5)", () => {
  // ${1} is set definitely; then a test answers unknown (a field name built
  // from a marked value). A forward to ${1} is the whole input's either way.
  const forward = (unknownTest: string) =>
    exec(`require ["variables","mailbox"]; ${MARK} if header :matches "subject" "*" { } if ${unknownTest} { keep; } redirect "\${1}";`, {
      subject: "fwd@example.com",
      exists: () => true,
    });

  for (const test of ['exists "${big}"', 'mailboxexists "${big}"', 'not exists "${big}"', 'anyof (exists "${big}", false)', 'allof (exists "${big}", true)', 'anyof (exists "${big}", size :over 1G)']) {
    it(test, () => {
      const d = forward(test);
      expect([d.redirectAddr, redirectsOnGuess(d), d.indeterminate]).toEqual([["fwd@example.com"], [], true]);
    });
  }

  it("as an elsif", () => {
    const d = exec(`require ["variables"]; ${MARK} if header :matches "subject" "*" { } if false { } elsif exists "\${big}" { keep; } redirect "\${1}";`, {
      subject: "fwd@example.com",
    });
    expect([d.redirectAddr, redirectsOnGuess(d), d.indeterminate]).toEqual([["fwd@example.com"], [], true]);
  });

  // The direction that matters: over the whole input these may set ${1}, so a
  // forward to it must not go as if it were whole.
  for (const test of ['header :matches "${big}" "*"', 'not header :matches "${big}" "*"', 'anyof (false, header :matches "${big}" "*")']) {
    it(`and the control: ${test} may set them, and doubts them`, () => {
      const d = forward(test);
      expect([d.redirectAddr, d.indeterminate]).toEqual([[], true]);
    });
  }
});
