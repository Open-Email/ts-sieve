// A value the engine could not hold whole is marked, not the run.
//
// A variable cut to its size limit, extracttext's text from a cut part, a
// match variable captured from a cut input, or one an unknown may have
// changed: each set `indeterminate` for the whole execution, which refuses
// every discard, reject and redirect without keep in it. A sender drove that
// on purpose: a long Subject, and the RFC 5229/5230 idiom that stores it,
// turned off a discard that never read it (ts-sieve #57).
//
// Now the value carries the mark. A test that reads it evaluates as it does
// over a cut header: over a prefix a :contains that finds its key is proven,
// a miss is unknown; a value in doubt (text after the prefix, :length of it, a
// :regex capture from a cut input, a stale capture) answers unknown. And
// `indeterminate` is set only when such an unknown decides a branch.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const CORE = { options: { maxMatchInputLength: 16 * 1024 } };
const msg = (headers: string) => `${headers}\r\n\r\nbody\r\n`;
const STORE = 'if header :matches "subject" "*" { set "s" "${1}"; }';

describe("a cut value stored in a variable", () => {
  it("does not touch a rule that never reads it", () => {
    // The review's case: stored past the variable limit, and past the match cut.
    const script = `require ["variables"]; ${STORE} if address :is "from" "bob@x.example" { discard; stop; }`;
    for (const n of [4500, 20_000]) {
      const r = run(script, msg(`From: bob@x.example\r\nSubject: ${"x".repeat(n)}`), CORE);
      expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
    }
  });

  it("decides a rule that reads it when the prefix proves the answer", () => {
    const script = `require ["variables"]; ${STORE} if not string :contains "\${s}" "unsubscribe" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: unsubscribe ${"x".repeat(5000)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, false]);
  });

  it("is unknown to a rule the prefix cannot decide, which discloses", () => {
    const script = `require ["variables"]; ${STORE} if not string :contains "\${s}" "unsubscribe" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)} unsubscribe`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("passes its mark to a variable copied from it", () => {
    const script = `require ["variables"]; ${STORE} set "t" "\${s}"; if not string :contains "\${t}" "unsubscribe" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)} unsubscribe`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("text after it puts a value in doubt: unknown even when the key is found", () => {
    const script = `require ["variables","fileinto"]; ${STORE} set "t" "\${s} tail"; if string :contains "\${t}" "x" { fileinto "X"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect([r.fileinto, r.indeterminate]).toEqual([[], true]);
  });

  it(":length of it is in doubt", () => {
    // "4000" holds a "4", but the whole value's length need not.
    const script = `require ["variables","fileinto"]; ${STORE} set :length "n" "\${s}"; if string :contains "\${n}" "4" { fileinto "Four"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect([r.fileinto, r.indeterminate]).toEqual([[], true]);
  });

  it("a key built from it is unknown", () => {
    const script = `require ["variables","fileinto"]; ${STORE} if header :contains "subject" "\${s}" { fileinto "Same"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect([r.fileinto, r.indeterminate]).toEqual([[], true]);
  });

  it("a header name built from it is unknown", () => {
    const script = `require ["variables","fileinto"]; ${STORE} if not exists "\${s}" { fileinto "Absent"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect([r.fileinto, r.indeterminate]).toEqual([[], true]);
  });

  it("deleteheader of a name built from it deletes nothing, and discloses", () => {
    const script = `require ["variables","editheader","fileinto"]; ${STORE} deleteheader "\${s}";`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect(r.indeterminate).toBe(true);
  });

  it("a flag variable keeps its mark through addflag", () => {
    const script = `require ["variables","imap4flags"]; ${STORE} setflag "f" "\${s}"; addflag "f" "seen"; if hasflag :contains "f" "~never~" { stop; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect(r.indeterminate).toBe(true);
  });

  it("a redirect to it is dropped and disclosed", () => {
    const script = 'require ["variables"]; if header :matches "x-to" "*" { set "a" "${1}"; } redirect "${a}";';
    const r = run(script, msg(`From: a@x\r\nX-To: ${"u".repeat(4500)}@example.com`), CORE);
    expect([r.redirect, r.indeterminate]).toEqual([[], true]);
  });

  it("a literal's own cut is no mark: it is the script's value", () => {
    const lit = "x".repeat(5000);
    const script = `require ["variables","fileinto"]; set "t" "${lit}"; if string :is "\${t}" "${"x".repeat(4000)}" { fileinto "Cut"; }`;
    expect(run(script, msg("From: a@x"), CORE)).toMatchObject({ fileinto: ["Cut"], indeterminate: false });
  });
});

describe("a match variable from a cut input", () => {
  const long = (head: string) => msg(`From: a@x\r\nSubject: ${head}${"x".repeat(20_000)}`);

  it("is not read: nothing is disclosed", () => {
    const script = `require ["variables","fileinto"]; ${STORE} fileinto "Stored";`;
    expect(run(script, long("free "), CORE)).toMatchObject({ fileinto: ["Stored"], indeterminate: false });
  });

  it(":matches' last capture is a prefix: a key found in it is proven", () => {
    const script = 'require ["variables","fileinto"]; if header :matches "subject" "*" { if string :contains "${1}" "free" { fileinto "Free"; } }';
    expect(run(script, long("free "), CORE)).toMatchObject({ fileinto: ["Free"], indeterminate: false });
  });

  it("a :regex capture is in doubt", () => {
    const script = 'require ["variables","fileinto","regex"]; if header :regex "subject" "^(x+)" { if string :contains "${1}" "x" { fileinto "X"; } }';
    expect(run(script, long(""), CORE)).toMatchObject({ fileinto: [], indeterminate: true });
  });
});

describe("extracttext's text from a cut part", () => {
  const cutPart = (text: string) => `From: a@x\r\nContent-Type: text/plain\r\n\r\n${text}`;
  const ex = (rule: string) => `require ["foreverypart","extracttext","variables","fileinto"]; foreverypart { extracttext "t"; ${rule} }`;

  it("is not disclosed by being stored or filed by", () => {
    const r = run(ex('fileinto "[${t}]";'), cutPart("hello"), { bodyTruncated: true });
    expect(r.indeterminate).toBe(false);
  });

  it("is a prefix to a rule that reads it", () => {
    const found = run(ex('if string :contains "${t}" "hell" { fileinto "Hi"; }'), cutPart("hello"), { bodyTruncated: true });
    expect(found).toMatchObject({ fileinto: ["Hi"], indeterminate: false });
    const missed = run(ex('if string :contains "${t}" "world" { fileinto "W"; }'), cutPart("hello"), { bodyTruncated: true });
    expect(missed).toMatchObject({ fileinto: [], indeterminate: true });
  });
});
