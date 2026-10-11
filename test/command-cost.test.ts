// What a command costs inside a foreverypart loop, and what a variable that
// cannot hold its value discloses.
//
// Commands were charged one dispatch step each, whatever they did. At top
// level that is sound: each runs once. A loop repeats them, and the work in a
// command is linear in what its ${...} expansion produces (a 4,000-byte
// variable twenty times over), in what set's modifiers walk, and for the flag
// commands in every flag held so far. Four nested loops at core's options
// took 12-15 s on one such command. Inside a loop each is charged by size now.
//
// A variable keeps at most maxVariableLen bytes, with no mark that what it
// holds is a prefix, so a rule testing it would stand on a guess: a cut is
// disclosed as indeterminate, as extracttext's is.

import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml, R, run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };

// These runs are heavy, and slower still under CI's coverage instrumentation.
vi.setConfig({ testTimeout: 60_000 });

/** The wall-clock bound for the cases that took 12-15 s before their fix:
 * loose enough for an instrumented CI run, far below the regression. */
const SLOW = 5000;

const REQ = 'require ["foreverypart","variables","fileinto","imap4flags","editheader"];';
const FROM_SUBJECT = 'if header :matches "subject" "*" { set "v" "${1}"; }';

/** A multipart of `parts` text parts. */
function flat(parts: number, subject: string): string {
  let body = "";
  for (let j = 0; j < parts; j++) body += "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n";
  return `From: a@x\r\nTo: b@y\r\nSubject: ${subject}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
}

/** `depth` nested multiparts around one text part: nested loops walk a part's
 * descendants, so this is what makes four of them iterate. */
function chain(depth: number, subject: string): string {
  let body = "";
  for (let i = 1; i <= depth; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
  body += `--b${depth}\r\nContent-Type: text/plain\r\n\r\nx\r\n`;
  for (let i = depth; i >= 0; i--) body += `--b${i}--\r\n`;
  return `From: a@x\r\nTo: b@y\r\nSubject: ${subject}\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
}

/** The steps one execution consumes, with a budget it cannot exhaust. */
function stepsOf(script: string, eml: string): number {
  const LIMIT = 100_000_000;
  const { headers, size, body } = parseEml(eml);
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: LIMIT, maxMatchInputLength: 16 * 1024 });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
  s.execute(d);
  return LIMIT - d.budget.remaining;
}

/** What `cmd` costs over `literal` in a loop over ten parts, ${v} holding the
 * Subject. */
function extraInLoop(cmd: string, literal: string, subject: string): number {
  const eml = flat(10, subject);
  return stepsOf(`${REQ} ${FROM_SUBJECT} foreverypart { ${cmd} }`, eml) - stepsOf(`${REQ} ${FROM_SUBJECT} foreverypart { ${literal} }`, eml);
}

function within(ms: number, f: () => unknown): void {
  const t0 = performance.now();
  f();
  expect(performance.now() - t0).toBeLessThan(ms);
}

describe("a value cut to the variable size limit is disclosed", () => {
  it("set, from a header", () => {
    // 4,512 characters: the variable keeps 4,000, and the not-guarded rule
    // must not stand on that as fact.
    const script = `require ["variables"]; ${FROM_SUBJECT} if not string :contains "\${v}" "unsubscribe" { discard; }`;
    const subject = `${"x".repeat(4500)} unsubscribe`;
    expect(run(script, flat(1, subject))).toMatchObject({ indeterminate: true });
  });

  it("the limit is in bytes: exactly maxVariableLen is exact, a byte more is disclosed", () => {
    const set = (v: string) => `require ["variables","fileinto"]; set "s" "${v}"; if string "\${s}" "" { fileinto "Empty"; }`;
    expect(run(set("é".repeat(2000))).indeterminate).toBe(false);
    expect(run(set(`${"é".repeat(2000)}x`)).indeterminate).toBe(true);
  });

  it("set :quotewildcard, cut back to the limit", () => {
    // 2,500 "*" quote to 5,000 bytes.
    expect(run(`require ["variables"]; set :quotewildcard "u" "${"*".repeat(2500)}";`).indeterminate).toBe(true);
  });

  it(":quotewildcard's cut keeps an escaped backslash whole and drops a separated escape", () => {
    const B = String.fromCharCode(92);
    const quoted = (tail: string) => {
      // The Sieve literal of tail: each backslash written as two.
      const script = `require ["variables","fileinto"]; set :quotewildcard "u" "${"x".repeat(3998)}${tail.replaceAll(B, B + B)}"; fileinto "\${u}";`;
      return run(script).fileinto[0]!.slice(3998);
    };
    // A backslash quotes to two, the cut falling after them.
    expect(quoted(`${B}y`)).toBe(B + B);
    // A "*" quotes to an escape and itself, the cut falling between.
    expect(quoted("x*")).toBe("x");
  });

  it("a flag variable", () => {
    const words = Array.from({ length: 1000 }, (_, i) => `f${i}`).join(" ");
    expect(run(`require ["variables","imap4flags"]; setflag "f" "${words}";`).indeterminate).toBe(true);
    expect(run(`require ["variables","imap4flags"]; setflag "f" "a b"; addflag "f" "c";`).indeterminate).toBe(false);
  });
});

describe("inside a loop, a command is charged by the size of its work", () => {
  const a = "a".repeat(4000);

  it("an expansion, by what it produces", () => {
    // A step per 128 characters, per part.
    expect(extraInLoop('set "u" "${v}";', 'set "u" "x";', a)).toBeGreaterThanOrEqual(10 * (4000 >> 7));
    expect(extraInLoop('fileinto "${v}";', 'fileinto "x";', a)).toBeGreaterThanOrEqual(10 * (4000 >> 7));
    expect(extraInLoop('addheader "X-A" "${v}";', 'addheader "X-A" "x";', a)).toBeGreaterThanOrEqual(10 * (4000 >> 7));
  });

  it("each modifier, by what it walks", () => {
    expect(extraInLoop('set :upper "u" "${v}";', 'set "u" "${v}";', a)).toBeGreaterThanOrEqual(10 * (4000 >> 7));
    expect(extraInLoop('set :length "u" "${v}";', 'set "u" "${v}";', a)).toBeGreaterThanOrEqual(10 * (4000 >> 7));
  });

  it(":quotewildcard, by the escapes it adds", () => {
    // Each escape costs some 15 ns, a hundred times a character of the rest.
    expect(extraInLoop('set :quotewildcard "u" "${v}";', 'set "u" "${v}";', "*".repeat(2000))).toBeGreaterThanOrEqual(10 * (2000 >> 4));
  });

  it("the flag commands, by the flags they handle", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    expect(extraInLoop('addflag "${v}";', 'addflag "x";', words)).toBeGreaterThanOrEqual(10 * (words.length >> 2));
  });

  it("outside a loop nothing is charged by size: there, a charge could fail the script", () => {
    const eml = flat(1, a);
    expect(stepsOf(`${REQ} ${FROM_SUBJECT} set :upper "u" "\${v}";`, eml)).toBe(stepsOf(`${REQ} ${FROM_SUBJECT} set "u" "x";`, eml));
  });
});

describe("four nested loops at core's options", () => {
  const loops = (body: string) => `${REQ} ${FROM_SUBJECT} foreverypart { foreverypart { foreverypart { foreverypart { ${body} } } } }`;

  it("set :quotewildcard over a variable of '*'", () => {
    within(SLOW, () => run(loops('set :quotewildcard "u" "${v}";'.repeat(50)), chain(30, "*".repeat(3990)), CORE));
  });

  it("an expansion twenty times the variable size limit", () => {
    within(SLOW, () => run(loops(`set "u" "${"${v}".repeat(20)}";`.repeat(50)), chain(30, "a".repeat(3990)), CORE));
  });

  it("addflag over 800 flags", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    within(SLOW, () => run(loops('addflag "${v}";'.repeat(50)), chain(30, words), CORE));
  });
});

describe("fileinto's duplicate check", () => {
  it("is not a scan: 100,000 distinct names in nested loops", () => {
    // Every part carries its own X-N, and each level of the loop keeps it.
    let body = "";
    for (let i = 1; i <= 30; i++) body += `--b${i - 1}\r\nX-N: n${i}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    body += "--b30\r\nX-N: leaf\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    for (let i = 30; i >= 0; i--) body += `--b${i}--\r\n`;
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
    const keep = (v: string) => `if header :mime :matches "x-n" "*" { set "${v}" "\${1}"; }`;
    const files = Array.from({ length: 50 }, (_, i) => `fileinto "\${a}.\${b}.\${c}.\${e}.${i}";`).join(" ");
    const script = `require ["mime","foreverypart","fileinto","variables"];
      foreverypart { ${keep("a")} foreverypart { ${keep("b")} foreverypart { ${keep("c")} foreverypart { ${keep("e")} ${files} } } } }`;
    within(SLOW, () => run(script, eml, CORE));
  });

  it("sees a name a host added to the list", () => {
    // The host's hook files the message itself, between two fileintos.
    const s = load('require ["fileinto"]; fileinto "A"; redirect "x@y"; fileinto "B";', { enabledExtensions: ALL_EXTENSIONS });
    const policy = new (class extends DummyPolicy {
      override redirectAllowed(d: { mailboxes: string[] }): boolean {
        d.mailboxes.push("B");
        return true;
      }
    })();
    const d = newRuntimeData(s, policy, new EnvelopeStatic("a@x", "b@y"), new MessageStatic(0, new Map(), null));
    d.mailboxes.push("Z");
    s.execute(d);
    expect(d.mailboxes).toEqual(["Z", "A", "B"]);
  });
});

describe(":upperfirst and :lowerfirst", () => {
  it("change a first character outside the BMP whole", () => {
    // DESERET SMALL LETTER LONG I and its capital: one character, two UTF-16 units.
    const small = String.fromCodePoint(0x10428);
    const capital = String.fromCodePoint(0x10400);
    const script = (m: string, v: string) => `require ["variables","fileinto"]; set ${m} "u" "${v}bc"; fileinto "\${u}";`;
    expect(run(script(":upperfirst", small))).toEqual(R({ fileinto: [`${capital}bc`] }));
    expect(run(script(":lowerfirst", capital))).toEqual(R({ fileinto: [`${small}bc`] }));
  });
});
