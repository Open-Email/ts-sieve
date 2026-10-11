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

describe("a cut value through the editheader ledger", () => {
  // The subject-rewrite idiom: the Subject is stored, deleted and added back
  // under a tag. What is added is a prefix of the whole, and every later read
  // of the field reads it.
  const REWRITE = 'if header :matches "subject" "*" { set "s" "${1}"; deleteheader "subject"; addheader "Subject" "[EXT] ${s}"; }';
  const ex = (rule: string) => `require ["variables","editheader","fileinto"]; ${REWRITE} ${rule}`;

  it("a header test over the field answers for the prefix only", () => {
    // The whole Subject holds "[ticket]".
    const r = run(ex('if not header :contains "subject" "[ticket]" { discard; }'), msg(`From: a@x\r\nSubject: ${"x".repeat(4500)} [ticket]`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a key the prefix holds is proven", () => {
    const r = run(ex('if header :contains "subject" "[EXT] xx" { fileinto "Ext"; }'), msg(`From: a@x\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect(r).toMatchObject({ fileinto: ["Ext"], indeterminate: false });
  });

  it("an encoded word in the prefix puts it in doubt: the whole may decode otherwise", () => {
    // X-S decodes to an encoded word, held literally and cut inside it. Whole,
    // the added field would decode again, to "... abcdefgh".
    const word = "=?utf-8?q?=3D=3Futf-8=3Fq=3Fabcdefgh=3F=3D?=";
    const script = 'require ["variables","editheader","fileinto"]; if header :matches "x-s" "*" { set "s" "${1}"; } addheader "X-T" "${s}"; if header :contains "x-t" "=?utf-8" { fileinto "Enc"; }';
    const r = run(script, msg(`From: a@x\r\nX-S: ${"x".repeat(3985)} ${word}`), CORE);
    expect(r).toMatchObject({ fileinto: [], indeterminate: true });
  });

  it("deleteheader cannot match the prefix: nothing is deleted, and it discloses", () => {
    const script = `require ["variables","editheader"]; ${STORE} addheader "X-S" "\${s}"; deleteheader :contains "x-s" "keep"; if exists "x-s" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)} keep`), CORE);
    expect(r.indeterminate).toBe(true);
  });

  it("an address test over it is unknown", () => {
    const script = `require ["variables","editheader"]; ${STORE} addheader "Reply-To" "\${s}"; if not address :domain :is "reply-to" "trusted.example" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"y".repeat(4500)} <boss@trusted.example>`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a date test over it is unknown", () => {
    const script = 'require ["variables","editheader","date"]; if header :matches "x-d" "*" { set "s" "${1}"; } addheader "X-Date" "${s}"; if not date :is "x-date" "year" "2024" { discard; }';
    const r = run(script, msg(`From: a@x\r\nX-D: Mon, 1 Jan 2024 10:00:00 +0000 (${"c".repeat(4500)})`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a :mime header test over it is unknown", () => {
    const script = `require ["variables","editheader","mime"]; ${STORE} addheader "X-S" "\${s}"; if not header :mime :contains "x-s" "unsubscribe" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(4500)} unsubscribe`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a field name built from a value in doubt is not added, and discloses", () => {
    const script = 'require ["variables","editheader","regex"]; if header :regex "x-route" "^([a-z-]+);" { set "h" "${1}"; } addheader "${h}" "1"; if exists "x-team" { discard; }';
    const r = run(script, msg(`From: a@x\r\nX-Route: x-team;${"y".repeat(20_000)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });
});

describe("a cut value in the internal flag set", () => {
  const KW = 'if header :matches "x-kw" "*" { set "kw" "${1}"; }';
  const kw = (tail: string) => msg(`From: a@x\r\nX-Kw: ${"x".repeat(4000)} ${tail}`);

  it("addflag of it puts the set in doubt", () => {
    const r = run(`require ["variables","imap4flags"]; ${KW} addflag "\${kw}"; if not hasflag "important" { discard; }`, kw("important"), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("removeflag of it too", () => {
    const r = run(`require ["variables","imap4flags"]; ${KW} setflag "junk"; removeflag "\${kw}"; if hasflag "junk" { discard; }`, kw("junk"), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a setflag of a literal clears the doubt", () => {
    const r = run(`require ["variables","imap4flags","fileinto"]; ${KW} addflag "\${kw}"; setflag "seen"; if hasflag "seen" { fileinto "Seen"; }`, kw("important"), CORE);
    expect(r).toMatchObject({ fileinto: ["Seen"], indeterminate: false });
  });
});

describe("addflag of a literal onto a held value", () => {
  it("marks the cut of what it joined", () => {
    // 3,995 + " \Flagged" is 4,004 bytes: the literal is what is cut.
    const BS = String.fromCharCode(92);
    const script = `require ["variables","imap4flags"]; if header :matches "x-kw" "*" { set "f" "\${1}"; } addflag "f" "${BS}${BS}Flagged"; if not hasflag "f" "${BS}${BS}flagged" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nX-Kw: ${"a".repeat(3995)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });
});

describe(":lower over a prefix", () => {
  it("does not read a capital sigma at the cut as the end of a word", () => {
    // Whole, the Subject lowers to "...σα"; its prefix ends in the Σ.
    const SIGMA = String.fromCharCode(0x3a3);
    const ALPHA = String.fromCharCode(0x391);
    const FINAL = String.fromCharCode(0x3c2);
    const script = `require ["variables","fileinto"]; ${STORE} set :lower "l" "\${s}"; if string :contains :comparator "i;octet" "\${l}" "${FINAL}" { fileinto "Final"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ${"x".repeat(3998)}${SIGMA}${ALPHA}`), CORE);
    expect(r).toMatchObject({ fileinto: [], indeterminate: true });
  });

  it("still proves a key the prefix holds", () => {
    const script = `require ["variables","fileinto"]; ${STORE} set :lower "l" "\${s}"; if string :contains "\${l}" "abc" { fileinto "Abc"; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: ABC${"x".repeat(4500)}`), CORE);
    expect(r).toMatchObject({ fileinto: ["Abc"], indeterminate: false });
  });
});

describe("a marked ledger value, by position and by count", () => {
  const long = (tail: string) => msg(`From: a@x\r\nSubject: ${"y".repeat(4500)} ${tail}`);
  const ADD = 'if header :matches "subject" "*" { set "s" "${1}"; } addheader "X-S" "${s}";';

  it(":index finds the marked value where it is", () => {
    const script = `require ["variables","editheader","index"]; ${ADD} if not header :index 1 :contains "x-s" "ticket" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nX-S: plain\r\nSubject: ${"y".repeat(4500)} ticket`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
    // The second is the message's own, held whole.
    const second = `require ["variables","editheader","index"]; ${ADD} if not header :index 2 :contains "x-s" "ticket" { discard; }`;
    const r2 = run(second, msg(`From: a@x\r\nX-S: plain\r\nSubject: ${"y".repeat(4500)} ticket`), CORE);
    expect([r2.implicitKeep, r2.indeterminate]).toEqual([false, false]);
  });

  it("an address :count over it is unknown", () => {
    const script = `require ["variables","editheader","relational","comparator-i;ascii-numeric","fileinto"]; ${ADD.replace('"X-S"', '"Reply-To"')} if address :count "ge" :comparator "i;ascii-numeric" "reply-to" "1" { fileinto "One"; }`;
    expect(run(script, long("<boss@trusted.example>"), CORE)).toMatchObject({ fileinto: [], indeterminate: true });
  });

  it("a date :count over it is unknown", () => {
    const script = 'require ["variables","editheader","relational","comparator-i;ascii-numeric","date","fileinto"]; if header :matches "x-d" "*" { set "s" "${1}"; } addheader "X-Date" "${s}"; if date :count "eq" :comparator "i;ascii-numeric" "x-date" "year" "0" { fileinto "None"; }';
    const r = run(script, msg(`From: a@x\r\nX-D: Mon, 1 Jan 2024 10:00:00 +0000 (${"c".repeat(4500)})`), CORE);
    expect(r).toMatchObject({ fileinto: [], indeterminate: true });
  });

  it("a header :count counts it: a marked value is still a field", () => {
    const script = `require ["variables","editheader","relational","comparator-i;ascii-numeric","fileinto"]; ${ADD} if header :count "eq" :comparator "i;ascii-numeric" "x-s" "1" { fileinto "One"; }`;
    expect(run(script, long("z"), CORE)).toMatchObject({ fileinto: ["One"], indeterminate: false });
  });

  it("deleteheader of a value removes that value, not a marked one of the same text", () => {
    // Added first: the Subject's 4,000-byte prefix. Then the message's own
    // X-S, the same text. :is proves only the message's own one equal.
    const x = "x".repeat(4000);
    const script = `require ["variables","editheader","fileinto"]; ${ADD} deleteheader :is "x-s" "${x}"; if header :is "x-s" "${x}" { fileinto "Same"; }`;
    const r = run(script, msg(`From: a@x\r\nX-S: ${x}\r\nSubject: ${"x".repeat(4500)}`), CORE);
    expect(r).toMatchObject({ fileinto: [], indeterminate: true });
  });
});

describe("the flag set after a discard", () => {
  it("holds nothing marked", () => {
    const script = 'require ["variables","imap4flags","fileinto"]; if header :matches "x-kw" "*" { set "kw" "${1}"; } addflag "${kw}"; discard; if not hasflag "important" { fileinto "F"; }';
    const r = run(script, msg(`From: a@x\r\nX-Kw: ${"x".repeat(4000)} important`), CORE);
    expect(r).toMatchObject({ fileinto: ["F"], indeterminate: false });
  });
});

describe("re-review of #60", () => {
  it("deleteheader deletes a marked value the prefix proves it matches", () => {
    const script = `require ["variables","editheader"]; ${STORE} addheader "X-S" "\${s}"; deleteheader :contains "x-s" "foo"; if exists "x-s" { discard; }`;
    const r = run(script, msg(`From: a@x\r\nSubject: foo ${"x".repeat(4500)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, false]);
    // Two of them, the same text: both go.
    const twice = `require ["variables","editheader"]; ${STORE} addheader "X-S" "\${s}"; addheader "X-S" "\${s}"; deleteheader :contains "x-s" "foo"; if exists "x-s" { discard; }`;
    const r2 = run(twice, msg(`From: a@x\r\nSubject: foo ${"x".repeat(4500)}`), CORE);
    expect([r2.implicitKeep, r2.indeterminate]).toEqual([true, false]);
  });

  it("fileinto :flags and keep :flags carry the mark into the flag set", () => {
    const KW = 'if header :matches "x-kw" "*" { set "kw" "${1}"; }';
    const m = msg(`From: a@x\r\nX-Kw: ${"x".repeat(4000)} important`);
    const filed = run(`require ["variables","imap4flags","fileinto","copy"]; ${KW} fileinto :copy :flags "\${kw}" "Archive"; if not hasflag "important" { discard; }`, m, CORE);
    expect([filed.implicitKeep, filed.indeterminate]).toEqual([true, true]);
    const kept = run(`require ["variables","imap4flags"]; ${KW} keep :flags "\${kw}"; if not hasflag "important" { redirect "triage@example.com"; }`, m, CORE);
    expect([kept.redirect, kept.indeterminate]).toEqual([[], true]);
  });

  it("a literal flag list on keep replaces the set, and its doubt", () => {
    const BS = String.fromCharCode(92);
    const script = `require ["variables","imap4flags","fileinto"]; if header :matches "x-kw" "*" { set "kw" "\${1}"; } addflag "\${kw}"; keep :flags "${BS}${BS}Seen"; if hasflag "${BS}${BS}seen" { fileinto "Seen"; }`;
    const r = run(script, msg(`From: a@x\r\nX-Kw: ${"x".repeat(4000)} important`), CORE);
    expect(r).toMatchObject({ fileinto: ["Seen"], indeterminate: false });
  });

  it("a prefix the cut ended at an '=' is in doubt: the whole may hold an encoded word there", () => {
    // X-Raw decodes to "<3,999 x>=?utf-8?q?Z?=", cut after the "=". Whole,
    // the added field decodes again, to "<3,999 x>Z".
    const script = 'require ["variables","editheader"]; if header :matches "x-raw" "*" { set "s" "${1}"; } addheader "X-S" "${s}"; if header :contains "x-s" "x=" { discard; }';
    const r = run(script, msg(`From: a@x\r\nX-Raw: ${"x".repeat(3999)}=?utf-8?b?PT91dGYtOD9xP1o/PQ==?=`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a prefix the cut ended after '?=' and white space is in doubt: the whole collapses it", () => {
    // X-Raw decodes to "<3,997 x>?= =?utf-8?q?Z?=", cut after the space.
    // Whole, the space between "?=" and "=?" is dropped: "<3,997 x>?=Z".
    const script = 'require ["variables","editheader"]; if header :matches "x-raw" "*" { set "s" "${1}"; } addheader "X-S" "${s}"; if header :contains "x-s" "?= " { discard; }';
    const r = run(script, msg(`From: a@x\r\nX-Raw: ${"x".repeat(3997)}=?utf-8?b?Pz0gPT91dGYtOD9xP1o/PQ==?=`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });
});
