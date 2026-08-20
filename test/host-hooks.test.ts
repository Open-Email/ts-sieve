// The two host-injected hooks, and the sub-script state clone.
//
// These are the seams a CONSUMER wires up rather than a script author reaching
// them, so the corpus never touches them: `MailboxChecker` (RFC 5490
// `mailboxexists`), `PolicyReader` (redirect gating), and `RuntimeData.clone()`
// (used by `test_script_run`, whose isolation guarantees are what stop a
// sub-script corrupting its parent's accumulated actions).

import { describe, expect, it } from "vitest";
import {
  DummyPolicy,
  EnvelopeStatic,
  MessageStatic,
  type MailboxChecker,
  type PolicyReader,
  type RuntimeData,
  load,
  newRuntimeData,
} from "../src/index.js";

const EXTS = ["fileinto", "mailbox", "imap4flags", "variables", "vacation", "copy"];

interface Ran {
  fileinto: string[];
  redirect: string[];
  keep: boolean;
  implicitKeep: boolean;
  d: RuntimeData;
}

function exec(
  script: string,
  opts: { checker?: MailboxChecker; policy?: PolicyReader; from?: string } = {},
): Ran {
  const s = load(script, { enabledExtensions: EXTS });
  const headers = new Map([
    ["from", ["a@x"]],
    ["subject", ["hi"]],
  ]);
  const d = newRuntimeData(
    s,
    opts.policy ?? new DummyPolicy(),
    new EnvelopeStatic(opts.from ?? "sender@remote.test", "rcpt@local.test"),
    new MessageStatic(100, headers, new TextEncoder().encode("body")),
  );
  if (opts.checker) d.mailboxChecker = opts.checker;
  s.execute(d);
  return { fileinto: d.mailboxes, redirect: d.redirectAddr, keep: d.keep, implicitKeep: d.implicitKeep, d };
}

/** A checker that knows exactly the names it was given. */
const checkerFor = (...names: string[]): MailboxChecker => ({
  exists: (m) => names.includes(m),
});

describe("MailboxChecker (RFC 5490 mailboxexists)", () => {
  const SCRIPT = 'require ["fileinto","mailbox"]; if mailboxexists "Archive" { fileinto "Archive"; }';

  it("is optimistic when the host injects no checker", () => {
    // The documented default: a consumer that cannot answer the question must
    // not have its scripts silently stop filing.
    expect(exec(SCRIPT).fileinto).toEqual(["Archive"]);
  });

  it("consults an injected checker for a single name", () => {
    expect(exec(SCRIPT, { checker: checkerFor("Archive") }).fileinto).toEqual(["Archive"]);
    expect(exec(SCRIPT, { checker: checkerFor("Other") }).fileinto).toEqual([]);
  });

  it("requires EVERY listed name to exist", () => {
    const multi =
      'require ["fileinto","mailbox"]; if mailboxexists ["A","B"] { fileinto "Both"; }';
    expect(exec(multi, { checker: checkerFor("A", "B") }).fileinto).toEqual(["Both"]);
    expect(exec(multi, { checker: checkerFor("A") }).fileinto).toEqual([]);
    expect(exec(multi, { checker: checkerFor() }).fileinto).toEqual([]);
  });

  it("refuses an empty name list at LOAD time, rather than being vacuously true", () => {
    // A vacuous `mailboxexists []` would silently always fire; the loader's
    // minimum-argument rule turns it into an upload-time error instead.
    const none = 'require ["fileinto","mailbox"]; if mailboxexists [] { fileinto "X"; }';
    expect(() => exec(none, { checker: checkerFor() })).toThrow(/wrong amount of string arguments/);
  });

  it("negates correctly — the :create idiom", () => {
    // `if not mailboxexists "X" { fileinto :create "X"; }` is the RFC's own
    // shape; the negation must reach the checker, not a constant.
    const script =
      'require ["fileinto","mailbox"]; if not mailboxexists "New" { fileinto :create "New"; }';
    expect(exec(script, { checker: checkerFor("Old") }).fileinto).toEqual(["New"]);
    expect(exec(script, { checker: checkerFor("New") }).fileinto).toEqual([]);
  });
});

describe("PolicyReader (redirect gating)", () => {
  const SCRIPT = 'require ["fileinto"]; redirect "forward@elsewhere.test";';

  it("DummyPolicy allows every redirect", () => {
    expect(exec(SCRIPT).redirect).toEqual(["forward@elsewhere.test"]);
  });

  it("a refusing policy drops the redirect and leaves implicit keep standing", () => {
    // The host's decision must not silently lose the message: refusing the
    // redirect leaves the implicit keep, so it is still delivered locally.
    const deny: PolicyReader = { redirectAllowed: () => false };
    const r = exec(SCRIPT, { policy: deny });
    expect(r.redirect).toEqual([]);
    expect(r.implicitKeep).toBe(true);
  });

  it("the policy sees the address and can decide per target", () => {
    const seen: string[] = [];
    const selective: PolicyReader = {
      redirectAllowed: (_d, addr) => {
        seen.push(addr);
        return addr.endsWith("@allowed.test");
      },
    };
    const two =
      'require ["fileinto"]; redirect "a@allowed.test"; redirect "b@blocked.test";';
    const r = exec(two, { policy: selective });
    expect(seen).toEqual(["a@allowed.test", "b@blocked.test"]);
    expect(r.redirect).toEqual(["a@allowed.test"]);
  });

  it("the policy receives the RuntimeData, so it can read envelope state", () => {
    let sawFrom = "";
    const p: PolicyReader = {
      redirectAllowed: (d) => {
        sawFrom = d.envelope.envelopeFrom();
        return true;
      },
    };
    exec(SCRIPT, { policy: p, from: "boss@corp.test" });
    expect(sawFrom).toBe("boss@corp.test");
  });
});

describe("RuntimeData.clone() — sub-script isolation", () => {
  function base(): RuntimeData {
    const s = load('require ["fileinto","imap4flags","variables"]; fileinto "Parent";', {
      enabledExtensions: EXTS,
    });
    const d = newRuntimeData(
      s,
      new DummyPolicy(),
      new EnvelopeStatic("a@x", "b@y"),
      new MessageStatic(10, new Map([["subject", ["hi"]]]), null),
    );
    s.execute(d);
    d.variables.set("v", "parent");
    d.matchVariables = ["whole", "one"];
    d.flags = ["\\Seen"];
    d.flagAliases.set("alias", "\\Flagged");
    d.headerEdits.push({ action: "add", fieldName: "X-A", value: "1", index: 0, last: false });
    return d;
  }

  it("copies the accumulators so a child cannot corrupt the parent", () => {
    const parent = base();
    const child = parent.clone();

    child.mailboxes.push("Child");
    child.redirectAddr.push("x@y");
    child.flags.push("\\Draft");
    child.variables.set("v", "child");
    child.matchVariables.push("two");
    child.flagAliases.set("alias2", "\\Seen");
    child.headerEdits.push({ action: "delete", fieldName: "X-B", value: "2", index: 0, last: false });
    child.keep = true;
    child.implicitKeep = false;

    expect(parent.mailboxes).toEqual(["Parent"]);
    expect(parent.redirectAddr).toEqual([]);
    expect(parent.flags).toEqual(["\\Seen"]);
    expect(parent.variables.get("v")).toBe("parent");
    expect(parent.matchVariables).toEqual(["whole", "one"]);
    expect(parent.flagAliases.size).toBe(1);
    expect(parent.headerEdits).toHaveLength(1);
    expect(parent.keep).toBe(false);
  });

  it("carries the parent's values INTO the child (a clone, not a reset)", () => {
    const parent = base();
    const child = parent.clone();
    expect(child.mailboxes).toEqual(["Parent"]);
    expect(child.variables.get("v")).toBe("parent");
    expect(child.matchVariables).toEqual(["whole", "one"]);
    expect(child.flags).toEqual(["\\Seen"]);
    expect(child.flagAliases.get("alias")).toBe("\\Flagged");
    expect(child.headerEdits).toHaveLength(1);
    expect(child.indeterminate).toBe(false);
  });

  it("SHARES the CPU budget, so a sub-script cannot buy more steps", () => {
    // The reason the budget is passed by reference: a nested run must draw on
    // the same allowance, or a script could recurse to evade the cap.
    const s = load("keep;", { enabledExtensions: EXTS, maxExecSteps: 50 });
    const d = newRuntimeData(
      s,
      new DummyPolicy(),
      new EnvelopeStatic("a@x", "b@y"),
      new MessageStatic(10, new Map(), null),
    );
    const child = d.clone();
    expect(child.budget).toBe(d.budget);
    d.budget.consume(40);
    expect(() => child.budget.consume(20)).toThrow(/budget exceeded/);
  });

  it("propagates the indeterminate flag to the child", () => {
    const parent = base();
    parent.indeterminate = true;
    expect(parent.clone().indeterminate).toBe(true);
  });

  it("shares envelope, message and policy by reference", () => {
    const parent = base();
    const child = parent.clone();
    expect(child.envelope).toBe(parent.envelope);
    expect(child.msg).toBe(parent.msg);
    expect(child.policy).toBe(parent.policy);
  });

  it("runs a different script when one is supplied", () => {
    const parent = base();
    const other = load('require "fileinto"; fileinto "Other";', { enabledExtensions: EXTS });
    const child = parent.clone(other);
    expect(child.script).toBe(other);
    expect(parent.script).not.toBe(other);
  });
});
