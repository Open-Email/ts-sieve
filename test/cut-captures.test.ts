// A match variable captured from an input the engine cut.
//
// A :matches or :regex over a cut input can still match soundly (a trailing
// "*", say), and the matcher keeps its captures. They come from the cut input,
// and may differ from what the whole input gives (for :matches, ${0} and the
// last "*"; for :regex, any group), with nothing to say so:
// `if not string :contains "${1}" "unsubscribe" { discard; }` then discarded on
// a guess. Reading such a capture discloses it as indeterminate;
// a cut match whose captures nobody reads discloses nothing.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, run } from "./harness.js";

const CORE = { options: { maxMatchInputLength: 16 * 1024 } };
const subject = (s: string) => `From: a@x\r\nTo: b@y\r\nSubject: ${s}\r\n\r\nbody\r\n`;
const long = `${"x".repeat(18_000)} unsubscribe`;

describe("a capture from a cut input", () => {
  it("is disclosed when a rule reads it", () => {
    const script = 'require ["variables"]; if header :matches "subject" "*" { if not string :contains "${1}" "unsubscribe" { discard; } }';
    expect(run(script, subject(long), CORE)).toMatchObject({ indeterminate: true });
  });

  it("is disclosed through set as well", () => {
    const script = 'require ["variables"]; if header :matches "subject" "x*" { set "v" "${1}"; }';
    expect(run(script, subject(long), CORE).indeterminate).toBe(true);
  });

  it("and from :regex", () => {
    const script = 'require ["variables","regex","fileinto"]; if header :regex "subject" "^(x+)" { fileinto "${1}"; }';
    expect(run(script, subject(long), CORE).indeterminate).toBe(true);
  });

  it("is not disclosed when nothing reads it", () => {
    const script = 'require ["variables","fileinto"]; if header :matches "subject" "*" { fileinto "Long"; }';
    expect(run(script, subject(long), CORE)).toMatchObject({ fileinto: ["Long"], indeterminate: false });
  });

  it("a capture from a whole input is exact", () => {
    const script = 'require ["variables","fileinto"]; if header :matches "subject" "*" { fileinto "${1}"; }';
    expect(run(script, subject("short"), CORE)).toMatchObject({ fileinto: ["short"], indeterminate: false });
  });

  it("a later match over a whole input replaces the cut captures", () => {
    const script = `require ["variables","fileinto"];
      if header :matches "subject" "*" { if header :matches "from" "*" { fileinto "\${1}"; } }`;
    expect(run(script, subject(long), CORE)).toMatchObject({ fileinto: ["a@x"], indeterminate: false });
  });

  it("a clone carries the mark into a sub-run", () => {
    const s = load('require ["variables"]; if header :matches "subject" "*" { set "v" "x"; }', { enabledExtensions: ALL_EXTENSIONS, ...CORE.options });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map([["subject", [long]]]), null));
    s.execute(d);
    const c = d.clone();
    expect(c.indeterminate).toBe(false);
    c.matchVariable(1);
    expect(c.indeterminate).toBe(true);
  });
});

describe("captures an absorbed unknown leaves behind", () => {
  // An unknown member of anyof/allof, or an unknown key or value before a
  // definite one, is evaluated past: over the whole input it could have set
  // its own captures, or ended the test before a later member set these.
  // Reading them then is a guess too.
  const msg = (headers: string) => `${headers}\r\n\r\nbody\r\n`;
  const cutSubject = `Subject: ${"x".repeat(18_000)} (fine)`;

  it("anyof: a later member's captures", () => {
    const script = 'require ["variables"]; if anyof (header :matches "subject" "*(*)", header :matches "from" "*@*") { if string :is "${2}" "spam.example" { discard; } }';
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE).indeterminate).toBe(true);
  });

  it("a later header name's captures", () => {
    const script = 'require ["variables"]; if header :matches ["reply-to","from"] "*<*>" { if string :is "${2}" "boss@corp.example" { discard; } }';
    const headers = `Reply-To: ${"n".repeat(17_000)} <other@corp.example>\r\nFrom: Boss <boss@corp.example>`;
    expect(run(script, msg(headers), CORE).indeterminate).toBe(true);
  });

  it("allof absorbed by a false member: the captures already in force", () => {
    const script = `require ["variables"]; if header :matches "from" "*@*" { }
      if allof (header :matches "subject" "*(*)", header :is "x-none" "z") { }
      if string :is "\${2}" "spam.example" { discard; }`;
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE).indeterminate).toBe(true);
  });

  // A member out of its share of the budget is unknown with no match run.
  let parts = "";
  for (let i = 0; i < 40; i++) parts += `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(16_000)}\r\n`;
  const heavy = (headers: string) => `${headers}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${parts}--b--\r\n`;
  const BUDGET = { options: { ...CORE.options, maxExecSteps: 200_000 } };

  it("anyof: a member out of its budget share", () => {
    const script = 'require ["variables","body","regex"]; if anyof (body :regex "casino", header :matches "from" "*@*") { if string :is "${2}" "spam.example" { discard; } }';
    expect(run(script, heavy("From: a@spam.example"), BUDGET)).toMatchObject({ indeterminate: true });
  });

  it("allof: a member that could set captures, out of its budget share, absorbed by a false one", () => {
    // Over the whole input the :regex matches and its captures replace From's.
    const script = `require ["variables","regex","fileinto"]; if header :matches "from" "*@*" { }
      if allof (header :regex "subject" "((a|b|c|d|e|f|g|h)+)c", header :is "x-none" "z") { }
      fileinto "\${2}";`;
    const eml = msg(`From: a@spam.example\r\nSubject: ${"ab".repeat(8000)}c`);
    expect(run(script, eml, { options: { ...CORE.options, maxExecSteps: 100_000 } })).toMatchObject({ fileinto: ["spam.example"], indeterminate: true });
  });

  it("an out-of-range read of them too: over the whole input there may be such a group", () => {
    const script = 'require ["variables"]; if anyof (header :matches "subject" "*(*)", header :matches "from" "*@*") { if string :is "${5}" "" { discard; } }';
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE).indeterminate).toBe(true);
  });

  it("a clone of exact captures reads them exactly", () => {
    const s = load('require ["variables"]; if header :matches "subject" "*" { }', { enabledExtensions: ALL_EXTENSIONS, ...CORE.options });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map([["subject", ["short"]]]), null));
    s.execute(d);
    const c = d.clone();
    expect([c.matchVariable(1), c.indeterminate]).toEqual(["short", false]);
  });

  it("a clone carries them into a sub-run", () => {
    const s = load('require ["variables"]; if anyof (header :matches "subject" "*(*)", header :matches "from" "*@*") { }', { enabledExtensions: ALL_EXTENSIONS, ...CORE.options });
    const headers = new Map([["subject", [`${"x".repeat(18_000)} (fine)`]], ["from", ["a@spam.example"]]]);
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, headers, null));
    s.execute(d);
    const c = d.clone();
    c.matchVariable(1);
    expect(c.indeterminate).toBe(true);
  });

  it("an unknown in a member that still answered is no doubt: the whole input answers it alike", () => {
    // allof(a header test true after an unknown value, a fresh match).
    const script = `require ["variables"];
      if allof (header :matches ["reply-to","from"] "*<*>", header :matches "x-list" "*@*") { if string :is "\${2}" "spam.example" { discard; } }`;
    const headers = `Reply-To: ${"n".repeat(17_000)} <other@corp.example>\r\nFrom: Boss <boss@corp.example>\r\nX-List: a@spam.example`;
    expect(run(script, msg(headers), CORE).indeterminate).toBe(false);
  });

  describe("a body test's unknown is no doubt: it restores the captures it found", () => {
    const LONG = "x".repeat(18_000);
    const mp = (headers: string) =>
      `${headers}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n${LONG}\r\n--b\r\nContent-Type: text/plain\r\n\r\nthe END\r\n--b--\r\n`;
    it("as an allof member that answered after an unknown part", () => {
      const script = `require ["variables","body"];
        if allof (body :text :matches "*END", header :matches "from" "*@*") { if string :is "\${2}" "spam.example" { discard; } }`;
      expect(run(script, mp("From: a@spam.example"), CORE).indeterminate).toBe(false);
    });
    it("as an anyof member that stayed unknown", () => {
      const script = `require ["variables","body"]; if header :matches "from" "*@*" { }
        if anyof (body :raw :matches "*NOPE", true) { }
        if string :is "\${2}" "spam.example" { discard; }`;
      expect(run(script, `From: a@spam.example\r\n\r\n${LONG} END\r\n`, CORE).indeterminate).toBe(false);
    });
    it("but it doubts what the members after it set: over the whole input it may have ended the test", () => {
      const script = `require ["variables","body"];
        if anyof (body :raw :matches "*NOPE", header :matches "from" "*@*") { if string :is "\${2}" "spam.example" { discard; } }`;
      expect(run(script, `From: a@spam.example\r\n\r\n${LONG} END\r\n`, CORE).indeterminate).toBe(true);
    });
    it("as an if's own test, true after an unknown part", () => {
      const script = `require ["variables","body"];
        if header :matches "from" "*@*" { if body :text :matches "*END" { } if string :is "\${2}" "spam.example" { discard; } }`;
      expect(run(script, mp("From: a@spam.example"), CORE).indeterminate).toBe(false);
    });
  });

  it("an earlier key's unknown doubts a later key's captures, :matches and :regex", () => {
    const subject = `From: a@x\r\nSubject: ${"x".repeat(18_000)} (fine)`;
    const m = 'require ["variables"]; if header :matches "subject" ["*(*)", "x*"] { if string :is "${2}" "" { discard; } }';
    expect(run(m, msg(subject), CORE).indeterminate).toBe(true);
    const r = 'require ["variables","regex"]; if header :regex "subject" ["[(]([a-z]+)[)]$", "^x"] { if string :is "${1}" "" { discard; } }';
    expect(run(r, msg(subject), CORE).indeterminate).toBe(true);
  });

  it("anyof: a later :regex member's captures", () => {
    const script = 'require ["variables","regex"]; if anyof (header :matches "subject" "*(*)", header :regex "from" "(.*)@(.*)") { if string :is "${2}" "spam.example" { discard; } }';
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE).indeterminate).toBe(true);
  });

  it("nothing is disclosed when nothing reads them, or a later rule matches afresh", () => {
    const absorbed = 'if allof (header :matches "subject" "*(*)", header :is "x-none" "z") { }';
    expect(run(`require ["variables","fileinto"]; ${absorbed} fileinto "X";`, msg(cutSubject), CORE).indeterminate).toBe(false);
    const fresh = `require ["variables","fileinto"]; ${absorbed} if header :matches "from" "*@*" { fileinto "\${2}"; }`;
    expect(run(fresh, msg(`From: a@spam.example\r\n${cutSubject}`), CORE)).toMatchObject({ fileinto: ["spam.example"], indeterminate: false });
  });

  it("a doubt ends with its test: a match in the block it chose is exact", () => {
    const script = `require ["variables","fileinto","editheader"];
      if anyof (header :matches "subject" "*(*)", true) { deleteheader :matches "from" "*@*"; fileinto "\${2}"; }`;
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE)).toMatchObject({ fileinto: ["spam.example"], indeterminate: false });
  });

  it("and in the block an elsif chose", () => {
    const script = `require ["variables","fileinto","editheader"];
      if false { } elsif anyof (header :matches "subject" "*(*)", true) { deleteheader :matches "from" "*@*"; fileinto "\${2}"; }`;
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE)).toMatchObject({ fileinto: ["spam.example"], indeterminate: false });
  });

  it("a deleteheader after an unknown still files by the next rule's captures", () => {
    const script = `require ["variables","fileinto","editheader"]; deleteheader :matches "subject" "*(*)";
      if header :matches "from" "*@*" { fileinto "\${2}"; }`;
    expect(run(script, msg(`From: a@spam.example\r\n${cutSubject}`), CORE)).toMatchObject({ fileinto: ["spam.example"] });
  });
});

describe("the mark, more closely", () => {
  it("a body test in between restores the mark with the captures", () => {
    const script = 'require ["variables","body"]; if header :matches "subject" "*" { if body :raw :matches "*" { } set "v" "${1}"; }';
    expect(run(script, subject(long), CORE).indeterminate).toBe(true);
  });

  it("${0} of a cut match is disclosed", () => {
    const script = 'require ["variables"]; if header :matches "subject" "x*" { set "v" "${0}"; }';
    expect(run(script, subject(long), CORE).indeterminate).toBe(true);
  });

  it("an index the pattern has no group for is exact", () => {
    const script = 'require ["variables"]; if header :matches "subject" "x*" { set "v" "${5}"; }';
    expect(run(script, subject(long), CORE).indeterminate).toBe(false);
  });
});
