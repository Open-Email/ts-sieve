// RFC 5429 reject / ereject. The library records the refusal and cancels the
// implicit keep; how the message is refused — a 5xx, a DSN, an MDN, or simply
// not delivering it — is the host's decision, read from RuntimeData.rejected,
// rejectReason and rejectExtended (go-sieve fe17968). §2.4 is enforced once the
// script has run, so the order of the actions does not matter.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type RuntimeData } from "../src/index.js";
import { runDovecotInline } from "./dovecot/harness.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const EXT = ALL_EXTENSIONS;
const MSG = "From: stephan@example.org\r\nTo: nico@frop.example.org\r\nSubject: Test\r\n\r\nTest.\r\n";

function exec(script: string, message = MSG, from = "sirius@example.org"): RuntimeData {
  const { headers, size, body } = parseEml(message);
  const s = load(script, { enabledExtensions: EXT });
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
  const conflicts: [string, string, RegExp][] = [
    ["a second reject", 'require "reject"; reject "a"; reject "b";', /more than one reject/],
    ["reject then ereject", 'require ["reject","ereject"]; reject "a"; ereject "b";', /more than one reject/],
    ["keep after", 'require "reject"; reject "a"; keep;', /conflicts with the keep action/],
    ["keep before", 'require "reject"; keep; reject "a";', /conflicts with the keep action/],
    ["fileinto", 'require ["reject","fileinto"]; fileinto "X"; reject "a";', /conflicts with the fileinto action/],
    ["fileinto :copy", 'require ["reject","fileinto","copy"]; reject "a"; fileinto :copy "X";', /conflicts with the fileinto action/],
    ["redirect", 'require "reject"; redirect "a@b.example"; reject "a";', /conflicts with the redirect action/],
    ["redirect :copy", 'require ["reject","copy"]; reject "a"; redirect :copy "a@b.example";', /conflicts with the redirect action/],
    ["vacation", 'require ["reject","vacation"]; vacation "away"; reject "a";', /conflicts with the vacation action/],
  ];
  for (const [name, script, err] of conflicts) {
    it(`refuses ${name}`, () => {
      expect(() => exec(script)).toThrow(err);
    });
  }

  it("discard is not a conflict", () => {
    const d = exec('require "reject"; discard; reject "a";');
    expect(d.rejected).toBe(true);
  });

  it("flags are not a conflict", () => {
    const d = exec('require ["reject","imap4flags"]; addflag "\\\\Seen"; reject "a";');
    expect(d.rejected).toBe(true);
    expect(d.flags).toEqual(["\\seen"]);
  });

  it("reject then vacation conflicts too", () => {
    expect(() => exec('require ["reject","vacation"]; reject "a"; vacation "away";')).toThrow(
      /conflicts with the vacation action/,
    );
  });

  it("vacation conflicts even when it records no response", () => {
    // A null envelope sender gets no auto-reply, but the action still ran.
    expect(() => exec('require ["reject","vacation"]; vacation "away"; reject "a";', MSG, "")).toThrow(
      /conflicts with the vacation action/,
    );
  });

  it("ereject conflicts with delivering actions as reject does", () => {
    expect(() => exec('require ["ereject","fileinto"]; ereject "a"; fileinto "X";')).toThrow(
      /conflicts with the fileinto action/,
    );
  });

  it("is checked after stop as well", () => {
    expect(() => exec('require "reject"; keep; reject "a"; stop;')).toThrow(/conflicts with the keep action/);
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
    it(`${f} fails at run time`, () => {
      const src = fs.readFileSync(path.join(CORPUS, f), "utf8");
      expect(() => exec(src)).toThrow(/conflicts with the|more than one reject/);
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
});

describe("RuntimeData.clone()", () => {
  it("carries the refusal into a sub-run", () => {
    const d = exec('require "ereject"; ereject "why";');
    const c = d.clone();
    expect([c.rejected, c.rejectReason, c.rejectExtended]).toEqual([true, "why", true]);
  });
});
