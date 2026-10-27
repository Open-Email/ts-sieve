// RFC 5429 reject / ereject. The library records the refusal and cancels the
// implicit keep; how the message is refused — a 5xx, a DSN, an MDN, or simply
// not delivering it — is the host's decision, read from RuntimeData.rejected,
// rejectReason and rejectExtended (go-sieve fe17968). §2.4 is enforced once the
// script has run, so the order of the actions does not matter.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type RuntimeData } from "../src/index.js";
import { mapNamespace, runDovecotInline } from "./dovecot/harness.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const EXT = ALL_EXTENSIONS;
const MSG = "From: stephan@example.org\r\nTo: nico@frop.example.org\r\nSubject: Test\r\n\r\nTest.\r\n";

function exec(script: string, message = MSG, from = "sirius@example.org", strictReject = false): RuntimeData {
  const { headers, size, body } = parseEml(message);
  const s = load(script, { enabledExtensions: EXT, strictReject });
  const env = new EnvelopeStatic(from, "timo@example.net");
  const d = newRuntimeData(s, new DummyPolicy(), env, new MessageStatic(size, headers, body));
  s.execute(d);
  return d;
}

describe("reject", () => {
  it("needs its require, and only 'reject' covers reject", () => {
    expect(() => load('reject "no";', { enabledExtensions: EXT })).toThrow(/missing require 'reject'/);
    expect(() => load('require "ereject"; reject "no";', { enabledExtensions: EXT })).toThrow(/missing require 'reject'/);
  });

  it("is gated by enabledExtensions", () => {
    expect(() => load('require "reject"; reject "no";', { enabledExtensions: ["fileinto"] })).toThrow(/reject/);
  });

  it("takes exactly one string", () => {
    expect(() => load('require "reject"; reject "a" "b";', { enabledExtensions: EXT })).toThrow(/too many arguments/);
    expect(() => load('require "reject"; reject;', { enabledExtensions: EXT })).toThrow(/argument is required/);
    expect(() => load('require "reject"; reject ["a", "b"];', { enabledExtensions: EXT })).toThrow(
      /wrong amount of string arguments/,
    );
  });

  it("records the refusal and cancels the implicit keep", () => {
    const d = exec('require "reject"; reject "Not wanted.";');
    expect(d.rejected).toBe(true);
    expect(d.rejectReason).toBe("Not wanted.");
    expect(d.rejectExtended).toBe(false);
    expect(d.implicitKeep).toBe(false);
    expect(d.keep).toBe(false);
    expect(d.mailboxes).toEqual([]);
  });

  it("expands variables in the reason", () => {
    const d = exec('require ["reject","variables"]; set "who" "Nico"; reject "${who} is away";');
    expect(d.rejectReason).toBe("Nico is away");
  });

  it("is not rejected when it does not run", () => {
    const d = exec('require "reject"; if false { reject "no"; }');
    expect(d.rejected).toBe(false);
    expect(d.implicitKeep).toBe(true);
  });
});

describe("ereject", () => {
  it("needs its own require", () => {
    expect(() => load('require "reject"; ereject "no";', { enabledExtensions: EXT })).toThrow(/missing require 'ereject'/);
  });

  it("records an extended refusal", () => {
    const d = exec('require "ereject"; ereject "550 5.7.1 go away";');
    expect(d.rejected).toBe(true);
    expect(d.rejectExtended).toBe(true);
    expect(d.rejectReason).toBe("550 5.7.1 go away");
    expect(d.implicitKeep).toBe(false);
  });
});

describe("RFC 5429 §2.4 conflicts, checked after the script runs", () => {
  // A throw fails the whole script, and a host that fails open turns that into
  // every rule skipped; the message picks the branches that reach a conflict,
  // and inside a foreverypart loop how many rejects run. So a second reject
  // adds nothing, and a reject beside a delivering action is disclosed as
  // indeterminate (a host then refuses the reject, as it would a discard).
  // strictReject throws instead, as Pigeonhole does.
  const conflicts: [string, string, RegExp][] = [
    ["keep after", 'require "reject"; reject "a"; keep;', /conflicts with the keep action/],
    ["keep before", 'require "reject"; keep; reject "a";', /conflicts with the keep action/],
    ["fileinto", 'require ["reject","fileinto"]; fileinto "X"; reject "a";', /conflicts with the fileinto action/],
    ["fileinto :copy", 'require ["reject","fileinto","copy"]; reject "a"; fileinto :copy "X";', /conflicts with the fileinto action/],
    ["redirect", 'require "reject"; redirect "a@b.example"; reject "a";', /conflicts with the redirect action/],
    ["redirect :copy", 'require ["reject","copy"]; reject "a"; redirect :copy "a@b.example";', /conflicts with the redirect action/],
    ["vacation", 'require ["reject","vacation"]; vacation "away"; reject "a";', /conflicts with the vacation action/],
    ["reject then vacation", 'require ["reject","vacation"]; reject "a"; vacation "away";', /conflicts with the vacation action/],
    ["ereject and fileinto", 'require ["ereject","fileinto"]; ereject "a"; fileinto "X";', /conflicts with the fileinto action/],
    ["after stop", 'require "reject"; keep; reject "a"; stop;', /conflicts with the keep action/],
  ];
  for (const [name, script, err] of conflicts) {
    it(`discloses ${name}, and strictReject refuses it`, () => {
      const d = exec(script);
      expect([d.rejected, d.indeterminate]).toEqual([true, true]);
      expect(() => exec(script, MSG, "sirius@example.org", true)).toThrow(err);
    });
  }

  it("beside a disclosed reject everything stands as if it had not run, and the conflict is named", () => {
    // [script, keep, implicitKeep, mailboxes, redirects, vacation responses, conflict]
    const rows: [string, boolean, boolean, string[], string[], number, string][] = [
      ['require ["reject","fileinto"]; fileinto "X"; reject "a"; fileinto "Y";', false, false, ["X", "Y"], [], 0, "fileinto"],
      // :copy asked for the implicit keep: a refused reject must not cancel it.
      ['require ["reject","fileinto","copy"]; fileinto :copy "X"; reject "a";', false, true, ["X"], [], 0, "fileinto"],
      ['require "reject"; keep; reject "a";', true, true, [], [], 0, "keep"],
      ['require "reject"; redirect "a@b.example"; reject "a";', false, false, [], ["a@b.example"], 0, "redirect"],
      ['require ["reject","copy"]; redirect :copy "a@b.example"; reject "a";', false, true, [], ["a@b.example"], 0, "redirect"],
      ['require ["reject","vacation"]; vacation "away"; reject "a";', false, true, [], [], 1, "vacation"],
    ];
    for (const [script, keep, implicitKeep, mailboxes, redirects, vacation, conflict] of rows) {
      const d = exec(script);
      expect([d.rejected, d.indeterminate, d.keep, d.implicitKeep, d.mailboxes, d.redirectAddr, d.vacationResponses.size, d.rejectConflict], script).toEqual([
        true,
        true,
        keep,
        implicitKeep,
        mailboxes,
        redirects,
        vacation,
        conflict,
      ]);
    }
  });

  it("a reject that stands cancels the implicit keep, and names no conflict", () => {
    for (const script of ['require "reject"; reject "a";', 'require "reject"; discard; reject "a";', 'require "reject"; reject "a"; reject "b";']) {
      const d = exec(script);
      expect([d.rejected, d.implicitKeep, d.indeterminate, d.rejectConflict], script).toEqual([true, false, false, ""]);
    }
  });

  it("names the first of keep, fileinto, redirect, vacation", () => {
    const all = 'fileinto "X"; redirect "a@b.example"; vacation "v"; reject "a";';
    const req = 'require ["reject","fileinto","vacation"];';
    expect(exec(`${req} keep; ${all}`).rejectConflict).toBe("keep");
    expect(exec(`${req} ${all}`).rejectConflict).toBe("fileinto");
    expect(exec(`${req} redirect "a@b.example"; vacation "v"; reject "a";`).rejectConflict).toBe("redirect");
  });

  it("flags stand beside a conflict too", () => {
    const d = exec('require ["reject","fileinto","imap4flags"]; addflag "\\\\Seen"; fileinto "X"; reject "a";');
    expect([d.flags, d.mailboxes, d.rejectConflict]).toEqual([["\\seen"], ["X"], "fileinto"]);
  });

  it("a second reject does not hide a conflict", () => {
    const d = exec('require "reject"; keep; reject "a"; reject "b";');
    expect([d.rejected, d.rejectReason, d.indeterminate, d.keep, d.rejectConflict]).toEqual([true, "a", true, true, "keep"]);
  });

  it("a reject that runs out of the loop's share has done nothing", () => {
    // Its reason is expanded first: a reject half-run recorded "" and
    // silenced the definite reject after the loop as "a second".
    const big = "x".repeat(4000);
    const script = `require ["reject","ereject","foreverypart","variables"]; set "big" "${big}";
      foreverypart { ereject "${"${big}".repeat(200)}"; } reject "definite";`;
    const s = load(script, { enabledExtensions: EXT, maxExecSteps: 3000 });
    const { headers, size, body } = parseEml("From: a@x\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n");
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
    s.execute(d);
    expect([d.budgetExhausted, d.rejected, d.rejectReason, d.rejectExtended]).toEqual([true, true, "definite", false]);
  });

  // A null envelope sender, or one listed in :addresses, gets no auto-reply,
  // but the action still ran, in either order (go-sieve 29d730a). The reject
  // is refused and the implicit keep stays.
  const sendsNothing: [string, string, string][] = [
    ["null sender, vacation first", 'require ["reject","vacation"]; vacation "away"; reject "a";', ""],
    ["null sender, reject first", 'require ["reject","vacation"]; reject "a"; vacation "away";', ""],
    [":addresses sender, vacation first", 'require ["reject","vacation"]; vacation :addresses "sirius@example.org" "away"; reject "a";', "sirius@example.org"],
    [":addresses sender, reject first", 'require ["reject","vacation"]; reject "a"; vacation :addresses "sirius@example.org" "away";', "sirius@example.org"],
  ];
  for (const [name, script, from] of sendsNothing) {
    it(`vacation conflicts even when it records no response: ${name}`, () => {
      const d = exec(script, MSG, from);
      expect([d.rejected, d.rejectConflict, d.indeterminate, d.implicitKeep, d.vacationResponses.size]).toEqual([true, "vacation", true, true, 0]);
      expect(() => exec(script, MSG, from, true)).toThrow(/conflicts with the vacation action/);
    });
  }

  for (const [name, script] of [
    ["a second reject", 'require "reject"; reject "a"; reject "b";'],
    ["reject then ereject", 'require ["reject","ereject"]; reject "a"; ereject "b";'],
  ]) {
    it(`${name}: the first stands, and strictReject refuses the second`, () => {
      const d = exec(script!);
      expect([d.rejected, d.rejectReason, d.rejectExtended, d.indeterminate]).toEqual([true, "a", false, false]);
      expect(() => exec(script!, MSG, "sirius@example.org", true)).toThrow(/more than one reject/);
    });
  }

  it("a loop rejecting once per matching part rejects once", () => {
    const two = [
      "From: a@x.example\r\nTo: b@y.example\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n",
      "--b\r\nContent-Type: application/x-a\r\n\r\nx\r\n",
      "--b\r\nContent-Type: application/x-b\r\n\r\ny\r\n--b--\r\n",
    ].join("");
    const script = 'require ["reject","mime","foreverypart","variables"]; foreverypart { if header :mime :type "content-type" "application" { reject "no executables"; } }';
    const d = exec(script, two);
    expect([d.rejected, d.rejectReason, d.indeterminate]).toEqual([true, "no executables", false]);
  });

  it("discard is not a conflict", () => {
    const d = exec('require "reject"; discard; reject "a";');
    expect([d.rejected, d.indeterminate]).toEqual([true, false]);
  });

  it("flags are not a conflict", () => {
    const d = exec('require ["reject","imap4flags"]; addflag "\\\\Seen"; reject "a";');
    expect([d.rejected, d.indeterminate]).toEqual([true, false]);
    expect(d.flags).toEqual(["\\seen"]);
  });
});

const CORPUS = path.resolve(__dirname, "corpus-src/tests");
const hasCorpus = fs.existsSync(CORPUS);

describe.skipIf(!hasCorpus)("Pigeonhole reject fixtures", () => {
  const fixtures = [
    "execute/errors/conflict-reject-keep.sieve",
    "execute/errors/conflict-reject-fileinto.sieve",
    "execute/errors/conflict-reject-redirect.sieve",
    "execute/errors/action-duplicates.sieve",
    "extensions/vacation/errors/conflict-reject.sieve",
  ];
  for (const f of fixtures) {
    it(`${f} fails at run time under strictReject, and is otherwise disclosed or refused once`, () => {
      const src = fs.readFileSync(path.join(CORPUS, f), "utf8");
      expect(() => exec(src, MSG, "sirius@example.org", true)).toThrow(/conflicts with the|more than one reject/);
      expect(() => exec(src)).not.toThrow();
    });
  }
});

describe.skipIf(!hasCorpus)("Pigeonhole reject/execute/basic.sieve", () => {
  const src = fs.readFileSync(path.join(CORPUS, "extensions/reject/execute/basic.sieve"), "utf8");

  it("rejects a matching message and stops before keep", () => {
    const d = exec(src);
    expect(d.rejected).toBe(true);
    expect(d.rejectReason).toBe("Don't send unrequested messages.");
    expect(d.keep).toBe(false);
    expect(d.implicitKeep).toBe(false);
  });

  it("keeps any other message", () => {
    const d = exec(src, "From: a@x.example\r\nTo: b@y.example\r\nSubject: hi\r\n\r\nhi\r\n");
    expect(d.rejected).toBe(false);
    expect(d.keep).toBe(true);
  });
});

describe("vnd.dovecot.testsuite", () => {
  it("attributes a conflict to the test block it happens in", () => {
    const r = runDovecotInline(`
require "vnd.dovecot.testsuite";
require "reject";
test "A" { reject "x"; keep; }
`);
    expect(r.failures.map((f) => f.name)).toEqual(["A"]);
    expect(r.report()).toMatch(/conflicts with the keep action/);
  });

  it("refuses a second reject in a block", () => {
    const r = runDovecotInline(`
require "vnd.dovecot.testsuite";
require "reject";
test "A" { reject "x"; reject "y"; }
`);
    expect(r.failures.map((f) => f.name)).toEqual(["A"]);
    expect(r.report()).toMatch(/more than one reject/);
  });

  it("a sub-run checks the refusal it inherits as strictly", () => {
    const r = runDovecotInline(
      `
require "vnd.dovecot.testsuite";
require "reject";
test "A" {
  reject "x";
  if not test_script_compile "k.sieve" { test_fail "compile failed"; }
  if test_script_run { test_fail "sub-run succeeded"; }
}
`,
      mapNamespace({ "k.sieve": "keep;" }),
    );
    expect(r.failures).toEqual([]);
  });

  it("checks a block that ends in stop too", () => {
    const r = runDovecotInline(`
require "vnd.dovecot.testsuite";
require "reject";
test "A" { reject "x"; keep; stop; }
`);
    expect(r.failures.map((f) => f.name)).toEqual(["A"]);
  });
});

describe("RuntimeData.clone()", () => {
  it("carries a vacation that ran into a sub-run's conflict check", () => {
    const d = exec('require "vacation"; vacation "away";');
    const s = load('require "reject"; reject "no";', { enabledExtensions: EXT });
    const c = d.clone(s);
    s.execute(c);
    expect(c.indeterminate).toBe(true);
    const strict = load('require "reject"; reject "no";', { enabledExtensions: EXT, strictReject: true });
    expect(() => strict.execute(d.clone(strict))).toThrow(/conflicts with the vacation action/);
  });

  it("carries the refusal, and a conflict it met, into a sub-run", () => {
    const d = exec('require "ereject"; ereject "why";');
    const c = d.clone();
    expect([c.rejected, c.rejectReason, c.rejectExtended]).toEqual([true, "why", true]);
    expect(exec('require "reject"; keep; reject "a";').clone().rejectConflict).toBe("keep");
  });
});
