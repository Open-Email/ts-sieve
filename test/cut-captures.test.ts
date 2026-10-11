// A match variable captured from an input the engine cut.
//
// A :matches or :regex over a cut input can still match soundly (a trailing
// "*", say), and the matcher keeps its captures. They come from the cut input:
// the last one may be a prefix of what the whole input holds, with nothing to
// say so. `if not string :contains "${1}" "unsubscribe" { discard; }` then
// discarded on a guess. Reading such a capture discloses it as indeterminate;
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
