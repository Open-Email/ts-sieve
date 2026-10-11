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
    const set = (tail: string) => `require ["variables"]; set "p" "${"é".repeat(2000)}"; set "s" "\${p}${tail}"; if string :contains "\${s}" "~never~" { stop; }`;
    expect(run(set("")).indeterminate).toBe(false);
    expect(run(set("x")).indeterminate).toBe(true);
  });

  it("set :quotewildcard, cut back to the limit", () => {
    // 2,500 "*" quote to 5,000 bytes.
    expect(run(`require ["variables"]; set "p" "${"*".repeat(2500)}"; set :quotewildcard "u" "\${p}"; if string :contains "\${u}" "~never~" { stop; }`).indeterminate).toBe(true);
  });

  it("not a literal's cut: it is the same on every message, so nothing is guessed", () => {
    // A 5,000-byte template held in a variable would otherwise refuse every
    // discard the script makes.
    expect(run(`require ["variables"]; set "t" "${"x".repeat(5000)}";`).indeterminate).toBe(false);
    expect(run(`require ["variables"]; set :quotewildcard "t" "${"*".repeat(2500)}";`).indeterminate).toBe(false);
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
    // Stored from the message and cut: a rule that reads it cannot decide.
    const words = Array.from({ length: 1000 }, (_, i) => `f${i}`).join(" ");
    const read = 'if hasflag :contains "f" "~never~" { stop; }';
    const fromMessage = `require ["variables","imap4flags"]; if header :matches "x-w" "*" { setflag "f" "\${1}"; } ${read}`;
    expect(run(fromMessage, `From: a@x\r\nX-W: ${words}\r\n\r\nb\r\n`).indeterminate).toBe(true);
    // A literal list is the script's own value, cut the same way every time.
    expect(run(`require ["variables","imap4flags"]; setflag "f" "${words}"; ${read}`).indeterminate).toBe(false);
    expect(run(`require ["variables","imap4flags"]; setflag "f" "a b"; addflag "f" "c"; ${read}`).indeterminate).toBe(false);
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
    // :length stores a number: against a literal, the expansion and the walk.
    expect(extraInLoop('set :length "u" "${v}";', 'set :length "u" "x";', a)).toBeGreaterThanOrEqual(10 * 2 * (4000 >> 7));
  });

  it(":quotewildcard, by the escapes it adds", () => {
    // Each escape costs some 15 ns, a hundred times a character of the rest.
    expect(extraInLoop('set :quotewildcard "u" "${v}";', 'set "u" "${v}";', "*".repeat(2000))).toBeGreaterThanOrEqual(10 * (2000 >> 4));
  });

  it("an expansion's references, however little they produce", () => {
    // ${e} is unset: the 8,000-character template expands to nothing, and its
    // scan costs 15-100 ns a reference. A step per 64 characters of it.
    const empty = "${e}".repeat(2000);
    expect(extraInLoop(`set "u" "${empty}";`, 'set "u" "x";', a)).toBeGreaterThanOrEqual(10 * (empty.length >> 6));
    expect(extraInLoop(`fileinto "${empty}x";`, 'fileinto "x";', a)).toBeGreaterThanOrEqual(10 * (empty.length >> 6));
  });

  it("a literal set, by what it stores", () => {
    expect(extraInLoop(`set "u" "${"a".repeat(3999)}";`, 'set "u" "x";', a)).toBeGreaterThanOrEqual(10 * (3999 >> 7));
  });

  it("addheader, by the value it folds, and nothing once the ledger is full", () => {
    expect(extraInLoop(`addheader "X-A" "${"a".repeat(8000)}";`, 'addheader "X-A" "x";', a)).toBeGreaterThanOrEqual(10 * (8000 >> 7));
    // 1,200 one-byte edits fill the ledger's 1,024; past it, nothing is
    // folded for an edit that cannot be kept.
    const fill = 'foreverypart { addheader "X-A" "x"; addheader "X-A" "x"; }';
    const steps = (v: string) => stepsOf(`${REQ} ${fill} foreverypart { addheader "X-B" "${v}"; }`, flat(600, "s"));
    expect(steps("a".repeat(8000)) - steps("y")).toBeLessThan(600);
  });

  describe("the flag commands, by the flags they handle, held and new", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    // A step per 4 characters; the expansion alone is a step per 128.
    const min = 10 * (words.length >> 2);
    const held = 'setflag "${v}"; setflag "f" "${v}";';
    const inLoop = (setup: string, cmd: string, literal: string) => {
      const eml = flat(10, words);
      const steps = (c: string) => stepsOf(`${REQ} ${FROM_SUBJECT} ${setup} foreverypart { ${c} }`, eml);
      return steps(cmd) - steps(literal);
    };
    it("setflag", () => expect(inLoop("", 'setflag "${v}";', 'setflag "x";')).toBeGreaterThanOrEqual(min));
    it("addflag", () => expect(inLoop("", 'addflag "${v}";', 'addflag "x";')).toBeGreaterThanOrEqual(min));
    it("addflag, by the flags held", () => expect(inLoop(held, 'addflag "x";', 'setflag "x";')).toBeGreaterThanOrEqual(min));
    it("removeflag, by the flags held", () => expect(inLoop(held, 'removeflag "x";', 'setflag "x";')).toBeGreaterThanOrEqual(min));
    it("the variable forms", () => {
      expect(inLoop(held, 'addflag "f" "x";', 'setflag "g" "x";')).toBeGreaterThanOrEqual(min);
      expect(inLoop(held, 'removeflag "f" "x";', 'setflag "g" "x";')).toBeGreaterThanOrEqual(min);
    });
    it(":flags on keep and fileinto", () => {
      expect(inLoop("", 'keep :flags "${v}";', 'keep :flags "x";')).toBeGreaterThanOrEqual(min);
      // A repeated fileinto applies nothing: one part, so it files once.
      const one = flat(1, words);
      const steps = (c: string) => stepsOf(`${REQ} ${FROM_SUBJECT} foreverypart { ${c} }`, one);
      expect(steps('fileinto :flags "${v}" "X";') - steps('fileinto :flags "x" "X";')).toBeGreaterThanOrEqual(words.length >> 2);
    });
    it("hasflag's variable form", () => {
      // Beyond the step per flag each key's match costs.
      expect(inLoop(held, 'if hasflag "f" "zz" { stop; }', 'if hasflag "g" "zz" { stop; }')).toBeGreaterThanOrEqual(min + 10 * 799);
    });
    it("none of it outside a loop", () => {
      const eml = flat(1, words);
      expect(stepsOf(`${REQ} ${FROM_SUBJECT} addflag "\${v}";`, eml)).toBe(stepsOf(`${REQ} ${FROM_SUBJECT} addflag "x";`, eml));
    });
  });

  it("outside a loop nothing is charged by size: there, a charge could fail the script", () => {
    const eml = flat(1, a);
    expect(stepsOf(`${REQ} ${FROM_SUBJECT} set :upper "u" "\${v}";`, eml)).toBe(stepsOf(`${REQ} ${FROM_SUBJECT} set "u" "x";`, eml));
  });
});

describe("a message cannot buy its way past later rules", () => {
  // Charges on what a test reads apply inside loops, where they multiply. At
  // top level a test runs once, and a size charge there let a big header,
  // with a body test that spends the budget, cost the rules after it their
  // reserve: a message-driven way to skip them.
  const opts = { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 };
  const exec = (script: string, eml: string) => {
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...opts });
    const { headers, size, body } = parseEml(eml);
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
    s.execute(d);
    return d;
  };

  it("ten Subject rules decide over a Subject of 30,000 bare '=?'", () => {
    const rules = Array.from({ length: 10 }, (_, i) => `if header :contains "subject" "word${i}" { fileinto "R${i}"; }`).join(" ");
    const subject = `${Array.from({ length: 10 }, (_, i) => `word${i}`).join(" ")} ${"=?".repeat(30_000)}`;
    const d = exec(`require ["fileinto"]; ${rules} if header :is "x-spam-flag" "yes" { fileinto "Junk"; }`, `From: a@x\r\nSubject: ${subject}\r\nX-Spam-Flag: yes\r\n\r\nbody\r\n`);
    expect(d.mailboxes).toEqual([...Array.from({ length: 10 }, (_, i) => `R${i}`), "Junk"]);
  });

  it("a Subject rule over 60 KB of '=?' decides after a body test spent the budget", () => {
    let body = "";
    for (let i = 0; i < 40; i++) body += `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(16_000)}\r\n`;
    const script = `require ["fileinto","body","regex"];
      if body :regex "casino" { fileinto "Body"; }
      if header :contains "subject" "word" { fileinto "Junk"; }`;
    const d = exec(script, `From: a@x\r\nSubject: word ${"=?".repeat(30_000)}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`);
    expect(d.budgetExhausted).toBe(true);
    expect(d.mailboxes).toEqual(["Junk"]);
  });

  it("rules over 5,000 copies of a header decide after a body test spent the budget", () => {
    // Repeating a header was the other lever: a step per value found, at top
    // level, where finding them costs nothing per value.
    let body = "";
    for (let i = 0; i < 40; i++) body += `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(16_000)}\r\n`;
    const listIds = Array.from({ length: 5000 }, (_, i) => `List-Id: l${i}`).join("\r\n");
    const tags = Array.from({ length: 5000 }, (_, i) => `X-Tag: t${i}`).join("\r\n");
    const froms = ["boss@x.com", ...Array.from({ length: 2999 }, (_, i) => `u${i}@x.com`)].map((f) => `From: ${f}`).join("\r\n");
    const script = `require ["fileinto","body","regex"];
      if body :regex "casino" { fileinto "Body"; }
      if exists "list-id" { fileinto "Lists"; }
      if address :is "from" "boss@x.com" { fileinto "Boss"; }
      if header :is "x-tag" "t0" { fileinto "Tag"; }`;
    const d = exec(script, `${froms}\r\n${listIds}\r\n${tags}\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`);
    expect(d.budgetExhausted).toBe(true);
    expect(d.mailboxes).toEqual(["Lists", "Boss", "Tag"]);
  });

  it("an address rule over a 60 KB From decides after a body test spent the budget", () => {
    // 150 long addresses: each probe costs a step, as it always has; the
    // 60 KB parse is what no longer fits the rule's reserve.
    const from = Array.from({ length: 150 }, (_, i) => `${"u".repeat(380)}${i}@example.com`).join(", ");
    let body = "";
    for (let i = 0; i < 40; i++) body += `--b\r\nContent-Type: text/plain\r\n\r\n${"x".repeat(16_000)}\r\n`;
    const script = `require ["fileinto","body","regex"];
      if body :regex "casino" { fileinto "Body"; }
      if address :is "from" "${"u".repeat(380)}149@example.com" { fileinto "Junk"; }`;
    const d = exec(script, `From: ${from}\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`);
    expect(d.budgetExhausted).toBe(true);
    expect(d.mailboxes).toEqual(["Junk"]);
  });
});

describe("vacation's :addresses", () => {
  it("are charged before vacation records that it ran", () => {
    const list = `[${Array.from({ length: 2000 }, (_, i) => `"a${i}@b.c"`).join(",")}]`;
    const s = load(`require ["foreverypart","vacation"]; foreverypart { vacation :addresses ${list} "away"; }`, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 1500 });
    const { headers, size, body } = parseEml(flat(1, "s"));
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
    s.execute(d);
    expect([d.budgetExhausted, d.vacationRan]).toEqual([true, false]);
  });

  it("are charged per address in a loop", () => {
    const list = (k: number) => `[${Array.from({ length: k }, (_, i) => `"a${i}@b.c"`).join(",")}]`;
    const steps = (k: number) => stepsOf(`require ["foreverypart","vacation"]; foreverypart { vacation :addresses ${list(k)} "away"; }`, flat(10, "s"));
    expect(steps(1000) - steps(1)).toBeGreaterThanOrEqual(10 * 999);
  });
});

describe("a command that runs out of the loop's share mid-way has done nothing", () => {
  it("vacation", () => {
    const script = `require ["foreverypart","variables","vacation"]; ${FROM_SUBJECT} foreverypart { vacation "${"${v}".repeat(2000)}"; }`;
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 5000 });
    const { headers, size, body } = parseEml(flat(1, "a".repeat(4000)));
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
    s.execute(d);
    expect([d.budgetExhausted, d.vacationRan, d.vacationResponses.size]).toEqual([true, false, 0]);
  });
});

describe("a test is charged per header name, and per value by its size", () => {
  // A test names any number of fields, which a loop repeats, and decoding or
  // parsing a value is linear in it: a step per name and one per value, plus
  // a step per 64 characters parsed as addresses or decoded from RFC 2047.
  const from = Array.from({ length: 200 }, (_, i) => `u${i}@example.com`).join(", ");
  const eml = `From: ${from}\r\nTo: b@y\r\nSubject: ${"=?utf-8?q?a?= ".repeat(500)}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${"--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(10)}--b--\r\n`;
  const names = (n: string, k: number) => `[${Array.from({ length: k }, () => `"${n}"`).join(",")}]`;
  const extra = (test: (k: number) => string) => {
    const steps = (k: number) => stepsOf(`require ["foreverypart","envelope","relational"]; foreverypart { if ${test(k)} { stop; } }`, eml);
    return steps(100) - steps(1);
  };
  const parsed = (v: string) => 2 + (v.length >> 6);

  it("header", () => {
    const subject = parseEml(eml).headers.get("subject")![0]!;
    expect(extra((k) => `header :is ${names("subject", k)} "x"`)).toBeGreaterThanOrEqual(10 * 99 * parsed(subject));
    // Counting decodes nothing.
    expect(extra((k) => `header :count "ge" ${names("subject", k)} "99999999"`)).toBeGreaterThanOrEqual(10 * 99 * 2);
  });

  it("address", () => {
    expect(extra((k) => `address :count "ge" ${names("from", k)} "99999999"`)).toBeGreaterThanOrEqual(10 * 99 * parsed(from));
    // A field that is no address header still costs its name.
    expect(extra((k) => `address :is ${names("subject", k)} "x"`)).toBeGreaterThanOrEqual(10 * 99);
  });

  it("exists and envelope", () => {
    expect(extra((k) => `not exists ${names("from", k)}`)).toBeGreaterThanOrEqual(10 * 99 * 2);
    expect(extra((k) => `envelope :is ${names("from", k)} "x"`)).toBeGreaterThanOrEqual(10 * 99);
  });

  it(":mime: a step per name per part, and per field for exists", () => {
    const req = 'require ["foreverypart","mime"];';
    const steps = (t: string) => stepsOf(`${req} foreverypart { if ${t} { stop; } }`, eml);
    // The parts carry no Subject: only the names are charged.
    expect(steps(`header :mime :is ${names("subject", 100)} "x"`) - steps(`header :mime :is ${names("subject", 1)} "x"`)).toBeGreaterThanOrEqual(10 * 99);
    expect(steps(`not exists :mime ${names("content-type", 100)}`) - steps(`not exists :mime ${names("content-type", 1)}`)).toBeGreaterThanOrEqual(10 * 99 * 2);
  });

  it("address :count in a loop, a step per value however short", () => {
    const tos = Array.from({ length: 3000 }, (_, i) => `To: t${i}@x`).join("\r\n");
    const m = `From: a@x\r\n${tos}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${"--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(10)}--b--\r\n`;
    const steps = stepsOf('require ["foreverypart","relational"]; foreverypart { if address :count "ge" "to" "99999999" { stop; } }', m);
    expect(steps).toBeGreaterThanOrEqual(10 * 3000);
  });

  it("envelope :count, per field", () => {
    expect(extra((k) => `envelope :count "ge" ${names("from", k)} "99999999"`)).toBeGreaterThanOrEqual(10 * 99);
  });

  it(":count, per key", () => {
    const keys = (k: number) => `[${Array.from({ length: k }, () => '"99999999"').join(",")}]`;
    const steps = (k: number) => stepsOf(`require ["foreverypart","relational"]; foreverypart { if header :count "ge" "subject" ${keys(k)} { stop; } }`, eml);
    expect(steps(100) - steps(1)).toBeGreaterThanOrEqual(10 * 99);
  });

  it("RFC 2047: a bare '=?' is no word", () => {
    // The decoder searches it at the decode rate, and finds no word to charge.
    const junk = "=?".repeat(30_000);
    const m = `From: a@x\r\nSubject: ${junk}\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${"--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(10)}--b--\r\n`;
    const steps = stepsOf('require ["foreverypart"]; foreverypart { if header :contains "subject" "x" { stop; } }', m);
    // With :contains' own charge, some 1,200 a part; a step per "=?" was 30,000.
    expect(steps).toBeLessThan(10 * 2 * (junk.length >> 6));
    // But it is searched at the decode rate.
    expect(steps).toBeGreaterThanOrEqual(10 * (junk.length >> 6));
  });

  it("RFC 2047: a step per encoded word, and CR or LF decoded at its rate", () => {
    // A word costs a decoder, some 0.6 us, whatever its size.
    const words = "=?utf-8?q?a?=".repeat(1500);
    const crlf = "a\r\n".repeat(4000);
    const one = (subject: string) => {
      const m = `From: a@x\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${"--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(10)}--b--\r\n`;
      const s = load('require ["foreverypart"]; foreverypart { if header :is "subject" "x" { stop; } }', { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: 100_000_000 });
      const { headers, size, body } = parseEml(m);
      headers.set("subject", [subject]);
      const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
      s.execute(d);
      return 100_000_000 - d.budget.remaining;
    };
    expect(one(words) - one("s")).toBeGreaterThanOrEqual(10 * 1500);
    expect(one(crlf) - one("s")).toBeGreaterThanOrEqual(10 * (crlf.length >> 6));
    // The decoder resumes inside a word that does not decode (#67), so a
    // chain of them, each one's closing "=" opening the next, is a word a link.
    const chain = `${"=?x?b?!!!?".repeat(1500)}=`;
    expect(one(chain) - one("s")).toBeGreaterThanOrEqual(10 * 1500);
  });

  it("body :content, per type per part", () => {
    const types = (k: number) => `[${Array.from({ length: k }, (_, i) => `"x-${i}/y"`).join(",")}]`;
    const steps = (k: number) => stepsOf(`require ["body"]; if body :content ${types(k)} :contains "zz" { stop; }`, eml);
    expect(steps(100) - steps(1)).toBeGreaterThanOrEqual(11 * 99);
  });

  it("mailboxexists, per name the host is asked about", () => {
    const steps = (k: number) => {
      const list = `[${Array.from({ length: k }, (_, i) => `"m${i}"`).join(",")}]`;
      const s = load(`require ["foreverypart","mailbox"]; foreverypart { if not mailboxexists ${list} { stop; } }`, {
        enabledExtensions: ALL_EXTENSIONS,
        maxExecSteps: 100_000_000,
      });
      const { headers, size, body } = parseEml(eml);
      const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
      d.mailboxChecker = { exists: () => true };
      s.execute(d);
      return 100_000_000 - d.budget.remaining;
    };
    expect(steps(100) - steps(1)).toBeGreaterThanOrEqual(10 * 99);
  });

  it("string :count, per source", () => {
    const sources = (k: number) => `[${Array.from({ length: k }, (_, i) => `"s${i}"`).join(",")}]`;
    const steps = (k: number) => stepsOf(`require ["foreverypart","variables","relational"]; foreverypart { if string :count "ge" ${sources(k)} "9999" { stop; } }`, eml);
    expect(steps(100) - steps(1)).toBeGreaterThanOrEqual(10 * 99);
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

  it("a template of four thousand empty references", () => {
    within(SLOW, () => run(loops(`set "u" "${"${e}".repeat(4000)}";`.repeat(50)), chain(30, "a"), CORE));
  });

  it("an expansion past the longest string a runtime holds runs out of its share, not throws", () => {
    // 140,000 references to a 4,000-character variable: 560 M characters, past
    // V8's 2^29. Charged as it grows, the share runs out first.
    const script = `${REQ} ${FROM_SUBJECT} foreverypart { set "u" "${"${v}".repeat(140_000)}"; } fileinto "After";`;
    expect(run(script, flat(1, "a".repeat(4000)), CORE).fileinto).toEqual(["After"]);
  });

  it("addflag over 800 flags", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    within(SLOW, () => run(loops('addflag "${v}";'.repeat(50)), chain(30, words), CORE));
  });
});

describe("fileinto's duplicate check", () => {
  it("is not a scan: 25,000 distinct names in nested loops", () => {
    // Every part carries its own X-N, and each level of the loop keeps it.
    let body = "";
    for (let i = 1; i <= 30; i++) body += `--b${i - 1}\r\nX-N: n${i}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    body += "--b30\r\nX-N: leaf\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    for (let i = 30; i >= 0; i--) body += `--b${i}--\r\n`;
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
    const keep = (v: string) => `if header :mime :matches "x-n" "*" { set "${v}" "\${1}"; }`;
    const files = Array.from({ length: 10 }, (_, i) => `fileinto "\${a}.\${b}.\${c}.\${e}.${i}";`).join(" ");
    const script = `require ["mime","foreverypart","fileinto","variables"];
      foreverypart { ${keep("a")} foreverypart { ${keep("b")} foreverypart { ${keep("c")} foreverypart { ${keep("e")} ${files} } } } }`;
    // 30 ms; a scan took 3 s, and a set rebuilt per name 18 s.
    within(500, () => run(script, eml, CORE));
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
