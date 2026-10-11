// The work a :mime test or a foreverypart loop does per part is charged to the
// step budget, so a message cannot make it burn CPU the budget does not see.
//
// The first cut of this port parsed every value of every part in scope on
// every evaluation, uncharged: inside nested loops, a 1 MB message of nested
// multiparts with one huge Content-Type parameter took 26 s at core's options.
// Values are parsed once per message now, a MIMEOPT that needs no parameter
// reads only the text before the first ";", and each part examined and each
// value read costs steps.

import { describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml, run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };

/** `depth` nested multiparts, the innermost holding `leaves` text parts, the
 * last with a `bigLen`-character Content-Type parameter. */
function chain(depth: number, leaves: number, bigLen: number): string {
  let body = "";
  for (let i = 1; i <= depth; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
  for (let j = 0; j < leaves; j++) {
    const big = j === leaves - 1 && bigLen > 0 ? `; x="${"a;".repeat(bigLen / 2)}"` : "";
    body += `--b${depth}\r\nContent-Type: text/plain${big}\r\n\r\nx\r\n`;
  }
  for (let i = depth; i >= 0; i--) body += `--b${i}--\r\n`;
  return `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
}

// These runs are heavy, and slower still under CI's coverage instrumentation.
vi.setConfig({ testTimeout: 60_000 });

/** The largest value a part's header can hold: core's walker refuses a part
 * header over 1 MiB as Go charges it (a field's length and half again), and
 * a refused part is no part at all. */
const BIG = 600_000;

/** The wall-clock bound for the cases that took 6–26 s before their fix:
 * loose enough for an instrumented CI run, far below the regression. Cheaper
 * defences are pinned by the steps they charge (stepsOf), not by time. */
const SLOW = 5000;

/** The steps one execution consumes, with a budget it cannot exhaust. */
function stepsOf(script: string, eml: string): number {
  const LIMIT = 100_000_000;
  const { headers, size, body } = parseEml(eml);
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: LIMIT, maxMatchInputLength: 16 * 1024 });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
  s.execute(d);
  return LIMIT - d.budget.remaining;
}

function within(ms: number, f: () => unknown): void {
  const t0 = performance.now();
  f();
  expect(performance.now() - t0).toBeLessThan(ms);
}

describe("loops over a deep tree with a huge header value", () => {
  const big = chain(98, 1, BIG);
  const req = 'require ["mime","foreverypart","fileinto"];';

  it("two nested loops, :anychild :contenttype", () => {
    within(SLOW, () =>
      run(`${req} foreverypart { foreverypart { if header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "A"; } } } fileinto "After";`, big, CORE),
    );
  });

  it("three nested loops, :type", () => {
    within(SLOW, () =>
      run(`${req} foreverypart { foreverypart { foreverypart { if header :mime :type "content-type" "application" { fileinto "A"; } } } } fileinto "After";`, big, CORE),
    );
  });

  it("the default MIMEOPT decodes each value once, however many loops read it", () => {
    within(SLOW, () =>
      run(`${req} foreverypart { foreverypart { if header :mime :anychild :contains "content-type" "pdf" { fileinto "A"; } } } fileinto "After";`, big, CORE),
    );
  });
});

describe("each kind of work is charged on its own", () => {
  const req = 'require ["mime","foreverypart","fileinto"];';

  it(":param values are decoded once and charged by size", () => {
    // A 1 MB RFC 2047 parameter value, read in nested loops.
    let body = "";
    for (let i = 1; i <= 98; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    body += `--b98\r\nContent-Type: text/plain; x="=?utf-8?Q?${"=41".repeat(BIG / 3)}?="\r\n\r\nx\r\n`;
    for (let i = 98; i >= 0; i--) body += `--b${i}--\r\n`;
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
    within(SLOW, () =>
      run(`${req} foreverypart { foreverypart { if header :mime :anychild :param "x" "content-type" "zz" { fileinto "A"; } } } fileinto "After";`, eml, CORE),
    );
  });

  it("address :mime values are charged by size", () => {
    let body = "";
    for (let i = 1; i <= 98; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    body += `--b98\r\nContent-Type: text/plain\r\nX-Big: ${"a".repeat(BIG)}@b\r\n\r\nx\r\n`;
    for (let i = 98; i >= 0; i--) body += `--b${i}--\r\n`;
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
    // One read of the big value: a step per 64 characters.
    expect(stepsOf('require "mime"; if address :mime :anychild :is "x-big" "z@b" { keep; }', eml)).toBeGreaterThan(BIG >> 6);
  });
});

describe("many parts, four nested loops", () => {
  it("absent headers are still charged per part", () => {
    const small = chain(98, 200, 0);
    // Every part in scope costs a step: one :anychild test over ~300 parts.
    expect(stepsOf('require "mime"; if exists :mime :anychild "x-none" { keep; }', small)).toBeGreaterThan(290);
    const names = Array.from({ length: 8 }, (_, i) => `"x-none-${i}"`).join(",");
    const script = `require ["mime","foreverypart","fileinto"];
      foreverypart { foreverypart { foreverypart { foreverypart { if header :mime :anychild :contains [${names}] "z" { fileinto "A"; } } } } }
      fileinto "After";`;
    within(SLOW, () => expect(run(script, small, CORE).fileinto).toEqual(["After"]));
  });
});

describe("what loops can make an execution hold", () => {
  const OPTS = { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 };
  /** `depth` nested multiparts and `leaves` leaves, with a long Subject. */
  function wide(depth: number, leaves: number, leaf: (j: number) => string): string {
    let body = "";
    for (let i = 1; i <= depth; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    for (let j = 0; j < leaves; j++) body += `--b${depth}\r\n${leaf(j)}\r\n\r\nx\r\n`;
    for (let i = depth; i >= 0; i--) body += `--b${i}--\r\n`;
    return `From: a@x\r\nTo: b@y\r\nSubject: ${"S".repeat(3900)}\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
  }
  function exec(script: string, eml: string) {
    const { headers, size, body } = parseEml(eml);
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...OPTS });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
    s.execute(d);
    return d;
  }

  it("a fold found in the cache is still charged for the value it hashes", () => {
    // A string built afresh each evaluation (4M characters) hit the fold cache
    // uncharged, and hashing it is linear: 24 s.
    const refs = Array.from({ length: 1000 }, () => "${a}").join("");
    const script = `require ["foreverypart","mime","variables","fileinto"];
      if header :matches "subject" "*" { set "a" "\${1}"; }
      foreverypart { foreverypart { if string :is "${refs}" "zz" { fileinto "A"; } } } fileinto "After";`;
    within(SLOW, () => exec(script, wide(60, 900, () => "Content-Type: text/plain")));
  });

  it("the fold cache holds a bounded amount", () => {
    const tests = "abcdefghijklmnopqrst"
      .split("")
      .map((c) => `if string :contains "${c}\${acc}\${acc}\${acc}" "zz" { fileinto "A"; }`)
      .join(" ");
    const script = `require ["foreverypart","mime","variables","fileinto"]; set "acc" "";
      foreverypart { foreverypart { if header :mime :matches "x-id" "*" { set "acc" "\${1}\${acc}"; } ${tests} } }
      fileinto "After";`;
    const d = exec(script, wide(60, 950, (j) => `X-Id: i${j}-${"X".repeat(30)}`));
    let units = 0;
    for (const m of d.foldCache.values()) for (const [k, v] of m) units += k.length + v.length;
    expect(units).toBeLessThanOrEqual(2 * 4 * 1024 * 1024);
  });

  for (const [label, body] of [
    ["exists after edits", `foreverypart { addheader :last "X-A" "v"; } foreverypart { foreverypart { if exists "x-a" { fileinto "A"; } } }`],
    ["header :count after edits", `foreverypart { addheader :last "X-A" "v"; } foreverypart { foreverypart { if header :count "eq" "x-a" "5" { fileinto "A"; } } }`],
    ["edits and reads interleaved", `foreverypart { foreverypart { addheader :last "X-A" "v"; if exists "x-a" { fileinto "A"; } } }`],
  ] as const) {
    it(`reading edited headers in loops: ${label}`, () => {
      // Every read replayed the whole edit list, copying the result per add:
      // quadratic per read and uncharged, multiplied by the loops (20 s).
      const script = `require ["foreverypart","mime","fileinto","editheader","relational","comparator-i;ascii-numeric"]; ${body} fileinto "After";`;
      within(SLOW, () => exec(script, wide(60, 900, () => "Content-Type: text/plain")));
    });
  }

  it("header edits are capped, and an edit past the cap is disclosed", () => {
    const script = `require ["foreverypart","mime","variables","fileinto","editheader"];
      if header :matches "subject" "*" { set "v" "\${1}"; }
      foreverypart { foreverypart { addheader "X-Part" "\${v}"; } } fileinto "After";`;
    const d = exec(script, wide(60, 900, () => "Content-Type: text/plain"));
    expect(d.headerEdits.length).toBeLessThanOrEqual(1024);
    expect(d.headerEdits.reduce((n, e) => n + e.value.length, 0)).toBeLessThanOrEqual(1024 * 1024);
    expect(d.indeterminate).toBe(true);
    expect(d.mailboxes).toEqual(["After"]);
  });
});
