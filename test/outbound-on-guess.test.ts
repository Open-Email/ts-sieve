// Which outbound actions an "unknown" decided.
//
// A forward or an auto-reply cannot be recalled, so a host withholds the ones
// a guess decided (core#256, core#263). Withholding every one in a run that
// guessed anywhere cost too much: a body rule that misses over a cut body
// stopped an unconditional forward that never read the body. An outbound
// action is on a guess when it ran in an arm an unknown chose, or after an
// unknown-decided arm or loop that could have changed what runs later.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, redirectsOnGuess } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const CORE = { maxMatchInputLength: 16 * 1024 };

function exec(script: string, message: string, bodyTruncated = false) {
  const { headers, size, body } = parseEml(message);
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...CORE });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, bodyTruncated));
  s.execute(d);
  return { redirect: d.redirectAddr, onGuess: redirectsOnGuess(d), vacation: d.vacationResponses.size > 0, vacationOnGuess: d.vacationOnGuess, indeterminate: d.indeterminate };
}

/** A Subject past the match cap: `header :matches "subject" "*zzz"` is unknown. */
const longSubject = `From: a@x\r\nTo: b@y\r\nSubject: ${"x".repeat(20_000)}\r\n\r\nbody\r\n`;
const U = 'header :matches "subject" "*zzz"';
/** A body the host cut: `body :contains "invoice"` is unknown. */
const cutBody = `From: a@x\r\nTo: b@y\r\nSubject: s\r\nContent-Type: text/plain\r\n\r\n${"y".repeat(2000)}`;

describe("a redirect an unknown decided", () => {
  it("in the else of an unknown branch is on a guess (core#256)", () => {
    const r = exec(`require ["fileinto","copy"]; if ${U} { fileinto "Junk"; } else { redirect :copy "a@x.test"; }`, longSubject);
    expect([r.redirect, r.onGuess]).toEqual([["a@x.test"], ["a@x.test"]]);
  });

  it("in an elsif taken after an unknown is on a guess", () => {
    const r = exec(`require "fileinto"; if ${U} { fileinto "A"; } elsif true { redirect "a@x.test"; }`, longSubject);
    expect(r.onGuess).toEqual(["a@x.test"]);
  });

  it("before the unknown is not", () => {
    const r = exec('require ["fileinto","copy","body"]; redirect :copy "a@x.test"; if body :contains "invoice" { fileinto "I"; }', cutBody, true);
    expect([r.indeterminate, r.redirect, r.onGuess]).toEqual([true, ["a@x.test"], []]);
  });

  it("after an unknown arm that only files is not: that arm changes nothing later", () => {
    const r = exec('require ["fileinto","copy","body"]; if body :contains "invoice" { fileinto "I"; } redirect :copy "a@x.test";', cutBody, true);
    expect([r.indeterminate, r.onGuess]).toEqual([true, []]);
  });

  it("after an unknown arm that could stop is", () => {
    const r = exec('require ["fileinto","copy","body"]; if body :contains "invoice" { fileinto "I"; stop; } redirect :copy "a@x.test";', cutBody, true);
    expect(r.onGuess).toEqual(["a@x.test"]);
  });

  it("after an unknown arm that sets a variable is", () => {
    const r = exec('require ["copy","body","variables"]; if body :contains "invoice" { set "v" "1"; } redirect :copy "a@x.test";', cutBody, true);
    expect(r.onGuess).toEqual(["a@x.test"]);
  });

  it("after an unknown arm holding a test, in a script with variables, is: the test may set captures", () => {
    const r = exec(`require ["copy","body","variables","fileinto"]; if body :contains "invoice" { if ${U} { fileinto "X"; } } redirect :copy "a@x.test";`, cutBody, true);
    expect(r.onGuess).toEqual(["a@x.test"]);
  });

  it("after an unknown arm that discards is, when a hasflag could read the flags it clears", () => {
    const withFlags = exec('require ["copy","body","imap4flags"]; if body :contains "invoice" { discard; } if hasflag "seen" { keep; } redirect :copy "a@x.test";', cutBody, true);
    expect(withFlags.onGuess).toEqual(["a@x.test"]);
    const without = exec('require ["copy","body","imap4flags"]; if body :contains "invoice" { discard; } redirect :copy "a@x.test";', cutBody, true);
    expect(without.onGuess).toEqual([]);
  });

  it("after an unknown arm that sets flags is only when a hasflag reads them (rules that only tag)", () => {
    const BS = String.fromCharCode(92);
    const tag = exec(`require ["copy","body","imap4flags"]; if body :contains "invoice" { addflag "${BS}${BS}Flagged"; } redirect :copy "a@x.test";`, cutBody, true);
    expect(tag.onGuess).toEqual([]);
    const read = exec(`require ["copy","body","imap4flags"]; if body :contains "invoice" { addflag "${BS}${BS}Flagged"; } if hasflag "x" { keep; } redirect :copy "a@x.test";`, cutBody, true);
    expect(read.onGuess).toEqual(["a@x.test"]);
  });

  it("after an unknown arm whose fileinto or keep :flags replaces the flags a hasflag reads, is", () => {
    const BS = String.fromCharCode(92);
    for (const act of [`fileinto :flags "${BS}${BS}Seen" "Done";`, `keep :flags "${BS}${BS}Seen";`]) {
      const r = exec(`require ["copy","fileinto","imap4flags"]; addflag "${BS}${BS}Flagged"; if ${U} { ${act} } if hasflag :is "${BS}${BS}Flagged" { redirect :copy "asst@x.test"; }`, longSubject);
      expect(r.onGuess).toEqual(["asst@x.test"]);
    }
  });

  it("after an unknown arm that redirects is, when the script can reach the redirect limit", () => {
    const six = Array.from({ length: 5 }, (_, i) => `redirect :copy "r${i}@x.test";`).join(" ");
    const r = exec(`require ["copy","body"]; if body :contains "invoice" { redirect :copy "first@x.test"; } ${six}`, cutBody, true);
    expect(r.onGuess.length).toBe(5);
    const few = exec('require ["copy","body"]; if body :contains "invoice" { redirect :copy "first@x.test"; } redirect :copy "a@x.test";', cutBody, true);
    expect(few.onGuess).toEqual([]);
  });

  it("an unknown absorbed by anyof is no guess", () => {
    const r = exec(`require ["copy","fileinto"]; if anyof (${U}, true) { fileinto "A"; } else { redirect :copy "a@x.test"; } redirect :copy "b@x.test";`, longSubject);
    expect([r.indeterminate, r.onGuess]).toEqual([false, []]);
  });

  it("past the redirect limit, the targets held are no guess: the limit drops the same one whole", () => {
    const six = Array.from({ length: 6 }, (_, i) => `redirect :copy "r${i}@x.test";`).join(" ");
    const r = exec(`require "copy"; ${six}`, "From: a@x\r\n\r\nb\r\n");
    expect([r.indeterminate, r.redirect.length, r.onGuess]).toEqual([true, 5, []]);
  });

  it("a target also redirected definitely is no guess", () => {
    const r = exec(`require ["fileinto","copy"]; if ${U} { fileinto "Junk"; } else { redirect :copy "a@x.test"; } if true { redirect :copy "a@X.TEST"; }`, longSubject);
    expect([r.redirect.length, r.onGuess]).toEqual([1, []]);
  });
});

describe("other unknowns that change what later tests read", () => {
  it("a deleteheader that could not match puts what follows on a guess", () => {
    const r = exec(`require ["editheader","copy"]; deleteheader :matches "subject" "*zzz"; redirect :copy "a@x.test";`, longSubject);
    expect(r.onGuess).toEqual(["a@x.test"]);
  });

  it("an open MIME tree under a loop that sets flags a hasflag reads puts what follows on a guess", () => {
    const parts = Array.from({ length: 1030 }, () => "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n").join("") + "--b--\r\n";
    const m = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${parts}`;
    const flags = exec('require ["foreverypart","mime","imap4flags","copy"]; foreverypart { if header :mime :subtype "content-type" "pdf" { addflag "pdf"; } } if not hasflag "pdf" { redirect :copy "a@x.test"; }', m);
    expect([flags.indeterminate, flags.onGuess]).toEqual([true, ["a@x.test"]]);
    const files = exec('require ["foreverypart","mime","fileinto","copy"]; foreverypart { if header :mime :subtype "content-type" "pdf" { fileinto "Pdf"; } } redirect :copy "a@x.test";', m);
    expect([files.indeterminate, files.onGuess]).toEqual([true, []]);
  });
});

describe("a vacation an unknown decided", () => {
  it("after an unknown arm that could stop is on a guess", () => {
    const r = exec(`require "vacation"; if ${U} { stop; } vacation "Away.";`, longSubject);
    expect([r.vacation, r.vacationOnGuess]).toEqual([true, true]);
  });

  it("before it is not", () => {
    const r = exec(`require "vacation"; vacation "Away."; if ${U} { stop; }`, longSubject);
    expect([r.vacation, r.vacationOnGuess]).toEqual([true, false]);
  });

  it("one an unknown arm may have overwritten is: its text is a guess", () => {
    const elseArm = exec(`require "vacation"; vacation :subject "A" "generic"; if ${U} { keep; } else { vacation :subject "B" "else arm"; }`, longSubject);
    expect(elseArm.vacationOnGuess).toBe(true);
    const skipped = exec(`require "vacation"; vacation :subject "A" "generic"; if ${U} { vacation :subject "B" "if arm"; }`, longSubject);
    expect(skipped.vacationOnGuess).toBe(true);
  });

  it("decided definitely is not", () => {
    const r = exec('require "vacation"; vacation "Away.";', longSubject);
    expect(r.vacationOnGuess).toBe(false);
  });
});

describe("a reject an unknown may have skipped", () => {
  it("is reported, so a host can keep from answering that sender", () => {
    const r = load(`require ["reject"]; if ${U} { reject "no"; }`, { enabledExtensions: ALL_EXTENSIONS, ...CORE });
    const { headers, size, body } = parseEml(longSubject);
    const d = newRuntimeData(r, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, false));
    r.execute(d);
    expect([d.rejected, d.rejectOnGuess]).toEqual([false, true]);
  });

  it("is not reported when no reject could have run", () => {
    const r = load(`require ["fileinto"]; if ${U} { fileinto "X"; }`, { enabledExtensions: ALL_EXTENSIONS, ...CORE });
    const { headers, size, body } = parseEml(longSubject);
    const d = newRuntimeData(r, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, false));
    r.execute(d);
    expect(d.rejectOnGuess).toBe(false);
  });
});
