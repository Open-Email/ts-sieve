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
import * as mime from "../src/interp/mime.js";
import * as header from "../src/interp/header.js";
import * as mediatype from "../src/interp/mediatype.js";
import { MatcherTest } from "../src/interp/matcher.js";

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

// 600,000 characters under 98 ancestors exhaust the structural-scan budget
// before the loop body runs (#86). 60,000 reach the repeated reads we count.
const BIG = 60_000;

/** The steps one execution consumes, with a budget it cannot exhaust. */
function stepsOf(script: string, eml: string): number {
  const LIMIT = 100_000_000;
  const { headers, size, body } = parseEml(eml);
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxExecSteps: LIMIT, maxMatchInputLength: 16 * 1024 });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
  s.execute(d);
  return LIMIT - d.budget.remaining;
}

/** Observe the expensive transformations as well as repeated reads. A test
 * that never reaches the large field must fail instead of passing at zero. */
function cachedValue(script: string, eml: string, mode: "type" | "decode" | "param"): void {
  const values = vi.spyOn(mime.MimeOpts.prototype, "values");
  const decoded = vi.spyOn(header, "decodeHeaderValue");
  const params = vi.spyOn(mediatype, "contentParams");
  const originalTrim = String.prototype.trim;
  let mediaValues = 0;
  const trim = vi.spyOn(String.prototype, "trim").mockImplementation(function (this: string) {
    if (this === "text/plain") mediaValues++;
    return originalTrim.call(this);
  });
  try {
    expect(run(script, eml, CORE).fileinto).toEqual(["After"]);
    const reads = values.mock.calls.filter(([, , raw]) => raw.some((v) => v.length >= BIG)).length;
    expect(reads, "the loop must read the large value repeatedly").toBeGreaterThan(1);
    const decodes = decoded.mock.calls.filter(([v]) => v.length >= BIG).length;
    const parses = params.mock.calls.filter(([v]) => v.length >= BIG).length;
    expect([decodes, parses]).toEqual(mode === "decode" ? [1, 0] : mode === "param" ? [0, 1] : [0, 0]);
    if (mode === "type") {
      expect(mediaValues, "the media-value trim probe must run").toBeGreaterThan(0);
      expect(mediaValues, "the media value must be reused across reads").toBe(1);
    }
  } finally {
    values.mockRestore(); decoded.mockRestore(); params.mockRestore(); trim.mockRestore();
  }
}

describe("loops over a deep tree with a huge header value", () => {
  const big = chain(98, 1, BIG);
  const req = 'require ["mime","foreverypart","fileinto"];';

  it("two nested loops, :anychild :contenttype", () => {
    cachedValue(`${req} foreverypart { foreverypart { if header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "A"; } } } fileinto "After";`, big, "type");
  });

  it("three nested loops, :type", () => {
    cachedValue(`${req} foreverypart { foreverypart { foreverypart { if header :mime :type "content-type" "application" { fileinto "A"; } } } } fileinto "After";`, big, "type");
  });

  it("the default MIMEOPT decodes each value once, however many loops read it", () => {
    cachedValue(`${req} foreverypart { foreverypart { if header :mime :anychild :contains "content-type" "pdf" { fileinto "A"; } } } fileinto "After";`, big, "decode");
  });
});

describe("each kind of work is charged on its own", () => {
  const req = 'require ["mime","foreverypart","fileinto"];';

  it(":param values are decoded once and charged by size", () => {
    // A large RFC 2047 parameter value, read in nested loops.
    let body = "";
    for (let i = 1; i <= 98; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
    body += `--b98\r\nContent-Type: text/plain; x="=?utf-8?Q?${"=41".repeat(BIG / 3)}?="\r\n\r\nx\r\n`;
    for (let i = 98; i >= 0; i--) body += `--b${i}--\r\n`;
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
    cachedValue(`${req} foreverypart { foreverypart { if header :mime :anychild :param "x" "content-type" "zz" { fileinto "A"; } } } fileinto "After";`, eml, "param");
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
    const all = stepsOf('require "mime"; if exists :mime :anychild "x-none" { keep; }', small);
    const root = stepsOf('require "mime"; if exists :mime "x-none" { keep; }', small);
    // 98 containers + 200 leaves beyond the root: one step to select each
    // part and another to read the absent field. Structural work cancels.
    expect(all - root).toBe(2 * (98 + 200));
    const names = Array.from({ length: 8 }, (_, i) => `"x-none-${i}"`).join(",");
    const script = `require ["mime","foreverypart","fileinto"];
      foreverypart { foreverypart { foreverypart { foreverypart { if header :mime :anychild :contains [${names}] "z" { fileinto "A"; } } } } }
      fileinto "After";`;
    let reads = 0;
    const original = mime.partHeader;
    const spy = vi.spyOn(mime, "partHeader").mockImplementation((...args) => {
      if (++reads > CORE.options.maxExecSteps) throw new Error("unbudgeted MIME header reads");
      return original(...args);
    });
    try {
      expect(run(script, small, CORE).fileinto).toEqual(["After"]);
      expect(reads, "the part-header probe must observe the loop").toBeGreaterThan(1000);
    } finally { spy.mockRestore(); }
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
  function exec(script: string, eml: string, prepare?: (d: ReturnType<typeof newRuntimeData>) => void) {
    const { headers, size, body } = parseEml(eml);
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...OPTS });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
    prepare?.(d);
    s.execute(d);
    return d;
  }

  it("a fold found in the cache is still charged for the value it hashes", () => {
    const s = load("", { enabledExtensions: ALL_EXTENSIONS, ...OPTS });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map()));
    const matcher = new MatcherTest();
    matcher.setKey(s, ["zz"]);
    const value = "S".repeat(1_900_000);
    expect(matcher.tryMatch(d, value, {})).toBe(false);
    const cached = d.foldCache.get("ascii")!;
    expect(cached.has(value), "the second read must hit a retained fold").toBe(true);
    const before = d.budget.remaining;
    // Equal text built afresh must still pay for its hash on the cache hit.
    expect(matcher.tryMatch(d, ("!" + value).slice(1), {})).toBe(false);
    expect(before - d.budget.remaining).toBeGreaterThanOrEqual(value.length >> 10);
    expect(d.foldCache.get("ascii")).toBe(cached);
    expect(cached.size).toBe(1);
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
      let reads = 0;
      let ledger: ReturnType<typeof newRuntimeData>["headerEdits"];
      const d = exec(script, wide(60, 900, () => "Content-Type: text/plain"), (d) => {
        ledger = new Proxy(d.headerEdits, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key) && ++reads > 2048) throw new Error("header edits were replayed repeatedly");
            return Reflect.get(target, key, receiver);
          },
        });
        d.headerEdits = ledger;
      });
      expect(d.mailboxes).toContain("After");
      expect(d.headerEdits, "the interpreter must retain the counted ledger").toBe(ledger!);
      expect(d.headerEdits.length, "the edits must actually run").toBeGreaterThan(100);
      expect(reads).toBe(d.headerEdits.length);
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
