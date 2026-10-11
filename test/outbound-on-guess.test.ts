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

describe("an arm a definite test skipped over state a guess wrote", () => {
  const run1 = (script: string) => {
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...CORE });
    // X-Ok, like the Subject, is past the match cap: a deleteheader over it is unknown.
    const { headers, size, body } = parseEml(longSubject.replace("Subject: ", `X-Ok: ${"x".repeat(20_000)}zzz\r\nSubject: `));
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, false));
    s.execute(d);
    return d;
  };

  it("may be the whole input's: a reject in it is reported", () => {
    for (const script of [
      `require ["variables","reject"]; if ${U} { set "x" "1"; } if string :is "\${x}" "1" { reject "no"; }`,
      `require ["imap4flags","reject"]; if ${U} { addflag "spam"; } if hasflag "spam" { reject "no"; }`,
      `require ["editheader","reject"]; deleteheader :matches "x-ok" "*zzz"; if not exists "x-ok" { reject "no"; }`,
      `require ["variables","reject","fileinto"]; if ${U} { set "x" "1"; } if string :is "\${x}" "1" { fileinto "A"; } elsif true { keep; } else { reject "no"; }`,
      // The first arm is taken over a guessed variable: read whole it is not,
      // and the elsif holding the reject runs.
      `require ["variables","reject","fileinto"]; if ${U} { set "x" "1"; } if string :is "\${x}" "" { fileinto "A"; } elsif true { reject "no"; }`,
    ]) {
      const d = run1(script);
      expect([script.slice(0, 40), d.rejected, d.rejectOnGuess]).toEqual([script.slice(0, 40), false, true]);
    }
  });

  it("may be the whole input's: a vacation in it makes the one recorded a guess", () => {
    const d = run1(`require ["variables","vacation"]; vacation :subject "A" "generic"; if ${U} { set "x" "1"; } if string :is "\${x}" "1" { vacation :subject "B" "specific"; }`);
    expect(d.vacationOnGuess).toBe(true);
  });

  it("is no guess when no guess came before it", () => {
    const d = run1('require ["reject","vacation"]; vacation "A"; if false { reject "no"; } if false { vacation "B"; }');
    expect([d.rejectOnGuess, d.vacationOnGuess]).toEqual([false, false]);
  });
});

describe("a stop or break that ran while a guess is in force", () => {
  const exec2 = (script: string, message = longSubject) => {
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...CORE });
    const { headers, size, body } = parseEml(message);
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, false));
    s.execute(d);
    return d;
  };
  const STEER = `if ${U} { set "x" "1"; } if string :is "\${x}" "" { stop; }`;

  it("may cut off a reject the whole input runs", () => {
    const d = exec2(`require ["variables","reject"]; ${STEER} reject "No.";`);
    expect([d.rejected, d.rejectOnGuess]).toEqual([false, true]);
  });

  it("may cut off a vacation that would replace the one recorded", () => {
    const d = exec2(`require ["variables","vacation"]; vacation "GENERIC"; ${STEER} vacation "SPECIAL";`);
    expect(d.vacationOnGuess).toBe(true);
  });

  it("a break does too", () => {
    const m = "From: a@x\r\nTo: b@y\r\nSubject: " + "x".repeat(20_000) + "\r\nContent-Type: text/plain\r\n\r\nbody\r\n";
    const d = exec2(`require ["variables","reject","foreverypart"]; if ${U} { set "x" "1"; } foreverypart { if string :is "\${x}" "" { break; } reject "No."; }`, m);
    expect([d.rejected, d.rejectOnGuess]).toEqual([false, true]);
  });

  it("one that ran with no guess in force cuts off nothing a guess decided", () => {
    const d = exec2('require ["reject","vacation"]; vacation "A"; stop; reject "No."; vacation "B";');
    expect([d.rejectOnGuess, d.vacationOnGuess]).toEqual([false, false]);
  });
});

describe("the #69 review's oracle findings", () => {
  const execO = (script: string, message: string, options: Record<string, number> = {}, bodyTruncated = false) => {
    const { headers, size, body } = parseEml(message);
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...CORE, ...options });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body, bodyTruncated));
    s.execute(d);
    const guessed = redirectsOnGuess(d);
    return { d, sentUnflagged: d.redirectAddr.filter((a) => !guessed.includes(a)) };
  };

  it("an if whose test ran out of its budget doubts the captures it may have set", () => {
    const long = Array.from({ length: 3 }, () => `X-Long: ${"a".repeat(15_000)}q`).join("\r\n");
    const m = `From: a@x\r\nTo: b@y\r\nX-A: alice\r\n${long}\r\nSubject: s\r\n\r\nbody\r\n`;
    const script = 'require ["variables","fileinto","copy"]; if header :matches "x-a" "*" {} if header :matches "x-long" "*a*a*a*q" { fileinto "x"; } if string :is "${1}" "alice" { redirect :copy "boss@x.test"; }';
    const { d, sentUnflagged } = execO(script, m, { maxExecSteps: 200_000 });
    expect(d.indeterminate).toBe(true);
    expect(sentUnflagged).toEqual([]);
  });

  it("an if whose string test read a value in doubt doubts the captures it may have set", () => {
    const m = `From: a@x\r\nTo: b@y\r\nX-Long: ${"b".repeat(20_000)}q\r\nSubject: s\r\n\r\nbody\r\n`;
    const script = 'require ["variables","copy"]; if header :matches "x-long" "*" { set "v" "${1}x"; } if string :matches "${v}" "*q*" { } redirect :copy "${2}@x.test";';
    const { sentUnflagged } = execO(script, m);
    expect(sentUnflagged).toEqual([]);
  });

  it("a fileinto that could take the last slot is not inert when a hasflag reads what it pushes out", () => {
    const pis = Array.from({ length: 31 }, (_, i) => `fileinto "P${i}";`).join(" ");
    const script = `require ["fileinto","imap4flags","copy","body"]; ${pis} if body :contains "needle" { fileinto "A"; } fileinto :flags "flagged" "B"; if hasflag "flagged" { redirect :copy "boss@x.test"; }`;
    const { sentUnflagged } = execO(script, cutBody, { maxFileintos: 32 }, true);
    expect(sentUnflagged).toEqual([]);
  });

  it("a vacation built from a value the engine could not hold whole is on a guess", () => {
    const sub = execO('require ["variables","vacation"]; if header :matches "subject" "*" { vacation :subject "Re: ${1}" "away"; }', longSubject);
    expect(sub.d.vacationOnGuess).toBe(true);
    const handle = execO(`require ["variables","vacation"]; if header :matches "x-h" "*" { set "h" "\${1}"; } vacation :handle "\${h}" "away";`, `From: a@x\r\nTo: b@y\r\nX-H: ${"h".repeat(5000)}\r\nSubject: s\r\n\r\nbody\r\n`);
    expect(handle.d.vacationOnGuess).toBe(true);
  });
});
