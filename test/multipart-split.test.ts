// What the multipart splitter costs. Issue #68.
//
// It found where each part ends with b.indexOf("\r\n--" + boundary), and
// V8's search compares a long boundary over and over where a body holds
// near-matches of it: a 4091-byte boundary over a 1 MB part of them took half
// a second, once per split, and every body test splits again. RFC 2231
// continuations build a boundary that long, and core takes it. The search
// hands indexOf at most the first 200 bytes of the boundary now (a short one
// whole, as before), compares the rest after each hit, and finds what indexOf
// found, in linear time. The preamble's comparison of each line with the
// boundary is linear now too: for a boundary with a line break in it
// (percent-encoded, as RFC 2231 allows) it ran on past the line, over the
// lines after it, and a 1 MB preamble took 2.3 s.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { indexOfDelimiter, type InputEnd, type Multipart, splitMultipart } from "../src/interp/body.js";

/** A deterministic generator: rnd(n) is in [0, n). Math.imul keeps the
 * product exact, and the high bits are the random ones. */
function rng(seed: number): (n: number) => number {
  return (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
}

describe("the delimiter search", () => {
  // It hands indexOf the first `head` bytes of the boundary (200 unless
  // given): a smaller head takes these short boundaries down the paths a long
  // one takes.
  const HEADS = [0, 1, 3, undefined];

  it("finds what indexOf finds, from anywhere, whatever the head", () => {
    const rnd = rng(68);
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
    const misses: string[] = [];
    let found = 0;
    let foundLf = 0;
    for (let t = 0; t < 12_000 && misses.length < 5; t++) {
      // Pieces that make near-matches and overlaps of the delimiter: CR, LF,
      // dashes, space, repeats. Every other boundary is only LF, "-" and "q",
      // whose delimiters overlap themselves the most.
      let boundary = "";
      if (t % 2) for (let i = 1 + rnd(8); i > 0; i--) boundary += pick(["\n", "-", "q"]);
      else for (let i = rnd(7); i > 0; i--) boundary += pick(["q", "q", "a", "-", "--", " ", "\r", "\n", "\r\n", "q\n--", "q\r\n--", "=_"]);
      const nl = rnd(2) ? "\r\n" : "\n";
      const prefix = () => boundary.slice(0, rnd(boundary.length + 1));
      const fragments = [
        () => "\r\n",
        () => "\n",
        () => "\r",
        () => "-",
        () => "--",
        () => "q",
        () => " ",
        () => nl,
        () => `${nl}--`,
        () => boundary,
        prefix,
        () => boundary.slice(rnd(boundary.length + 1)),
        () => `${nl}--${boundary}`,
        () => `${nl}--${prefix()}`,
      ];
      let b = "";
      for (let i = rnd(24); i > 0; i--) b += pick(fragments)();
      const delimiter = `${nl}--${boundary}`;
      const head = HEADS[(t >> 1) % HEADS.length];
      for (let from = 0; from <= b.length + 1; from++) {
        const want = b.indexOf(delimiter, from);
        const got = indexOfDelimiter(b, nl, boundary, from, head);
        if (got !== want) {
          misses.push(`${JSON.stringify({ b, nl, boundary, from, head })}: ${got}, not ${want}`);
          break;
        }
        if (want !== -1) {
          found++;
          if (boundary.includes("\n")) foundLf++;
        }
      }
    }
    expect(misses).toEqual([]);
    // The cases really find delimiters, with and without a line break in the
    // boundary.
    expect(found).toBeGreaterThan(50_000);
    expect(foundLf).toBeGreaterThan(30_000);
  });

  it("finds a delimiter after each partial one, for every short boundary of LF, dashes and q", () => {
    // Random bodies almost never hold the shape on which a wrong fallback in
    // the search's table misses a delimiter (the shortest has a 7-byte
    // boundary, "\n\n--\n-\n"), so every boundary up to 7 bytes is searched
    // for after each prefix of its delimiter, with each head.
    const misses: string[] = [];
    let boundaries = [""];
    for (let len = 1; len <= 7; len++) {
      boundaries = boundaries.flatMap((s) => [`${s}\n`, `${s}-`, `${s}q`]);
      for (const boundary of boundaries) {
        const delimiter = `\n--${boundary}`;
        for (let i = 0; i < delimiter.length; i++) {
          const b = delimiter.slice(0, i) + delimiter;
          for (const head of HEADS) {
            const got = indexOfDelimiter(b, "\n", boundary, 0, head);
            if (got !== b.indexOf(delimiter)) misses.push(`${JSON.stringify({ b, boundary, head })}: ${got}`);
          }
        }
      }
    }
    expect(misses).toEqual([]);
  });
});

/** The splitter's whole result, field by field. */
const show = (m: Multipart) =>
  JSON.stringify([
    m.prologue,
    m.prologueCut,
    m.epilogue,
    m.epilogueCut,
    m.open,
    m.parts.map((p) => [p.fields, p.contentType, p.cte, p.body, p.cut, p.ends]),
  ]);

/**
 * What the splitter gave for the multiparts below before #68, as a SHA-256
 * of each result in turn: the change is to what the splitting costs, never to
 * what it finds. A change meant to alter what the splitter lists (after
 * checking it against core's walker) records the new digest from the failure.
 */
const RECORDED = "d6a72f79a2f5c320b8aefee75bf99ae318a95fc71b5e15b5b46b2875348bc97e";

describe("the splitter's results", () => {
  it("are what they were, over bodies built from delimiters and near-matches of them", () => {
    const rnd = rng(2046);
    const pick = <T>(xs: T[]): T => xs[rnd(xs.length)]!;
    const hash = createHash("sha256");
    const seen = { many: 0, open: 0, ranOut: 0, cut: 0, long: 0, lf: 0 };
    for (let t = 0; t < 3000; t++) {
      // One in twenty a boundary whose delimiter line nears or fills the
      // reader's 4096-byte buffer; one in four of the rest with a line break.
      const long = rnd(20) === 0;
      let boundary = "";
      if (long) boundary = "q".repeat(4086 + rnd(10)) + pick(["", "", "\r", "\n"]);
      else for (let i = 1 + rnd(6); i > 0; i--) boundary += pick(["q", "b", "a", "-", "--", " ", "\r", "=_"]);
      if (!long && rnd(4) === 0) {
        const at = rnd(boundary.length + 1);
        boundary = boundary.slice(0, at) + pick(["\n", "\r\n", "\n--", "\n--q"]) + boundary.slice(at);
      }
      const nl = rnd(3) === 0 ? "\n" : "\r\n";
      const other = nl === "\n" ? "\r\n" : "\n";
      const pad = () => pick(["", " ", "\t", " \t ", " ".repeat(rnd(8))]);
      const prefix = () => boundary.slice(0, rnd(boundary.length + 1));
      // A part's text: bytes that make near-matches of a delimiter line.
      const text = () => {
        let s = "";
        for (let i = rnd(6); i > 0; i--) {
          s += pick([
            () => "hello",
            () => "hello",
            () => `hello${nl}`,
            () => nl,
            () => other,
            () => "\r",
            () => "\n",
            () => "-",
            () => "--",
            () => " ",
            () => boundary,
            prefix,
            () => `--${prefix()}`,
            () => `${nl}--${prefix()}`,
            () => `${other}--${boundary}`,
            () => `${nl}--${boundary}${pick(["x", "-alt", " junk", "--junk", other])}`,
          ])();
        }
        return s;
      };
      // Mostly a delimiter line, and the other lines that start that way.
      const delimiter = () =>
        pick([
          `--${boundary}${nl}`,
          `--${boundary}${nl}`,
          `--${boundary}${nl}`,
          `--${boundary}${nl}`,
          `--${boundary}${nl}`,
          `--${boundary}${pad()}${nl}`,
          `--${boundary}${other}`,
          `--${boundary}-alt${nl}`,
          `--${boundary} junk${nl}`,
          `--${boundary}--${nl}`,
        ]);
      // Mostly fields the reader takes, then the blank line.
      const header = () => {
        let s = "";
        for (let i = rnd(3); i > 0; i--) {
          s += pick([`Content-Type: text/plain${nl}`, `X-A: 1${nl}`, `X-A: 1${nl} folded${nl}`, `X-B: 2${other}`]);
        }
        if (rnd(8) === 0) s += pick([`JUNK${nl}`, ` folded${nl}`]);
        return rnd(12) === 0 ? s : s + nl;
      };
      let body = rnd(2) ? "" : text() + pick([nl, nl, other, ""]);
      for (let p = 1 + rnd(5); p > 0; p--) body += delimiter() + header() + text() + pick([nl, nl, nl, other, ""]);
      if (rnd(4) !== 0) body += `--${boundary}--${pad()}${pick([nl, nl, other, ""])}`;
      body += text();
      const cutAt = rnd(body.length + 1);
      for (const inputEnd of ["whole", "part", "ranOut"] as InputEnd[]) {
        for (const [b, cut] of [
          [body, false],
          [body, true],
          [body.slice(0, cutAt), true],
        ] as const) {
          const m = splitMultipart(b, boundary, cut, inputEnd);
          hash.update(`${show(m)}\n`);
          if (m.parts.length > 1) seen.many++;
          if (m.open) seen.open++;
          if (m.parts.some((p) => p.ends === "ranOut")) seen.ranOut++;
          if (m.parts.some((p) => p.cut && p.fields !== "")) seen.cut++;
          if (long && m.parts.some((p) => p.fields !== "" || p.body !== "")) seen.long++;
          if (boundary.includes("\n") && b.includes(`--${boundary}`)) seen.lf++;
        }
      }
    }
    expect(hash.digest("hex")).toBe(RECORDED);
    // The bodies really are lists of parts, open and closed, run out and cut,
    // with long boundaries, and lines that start a boundary with a line break.
    expect(seen.many).toBeGreaterThan(2000);
    expect(seen.open).toBeGreaterThan(5000);
    expect(seen.ranOut).toBeGreaterThan(300);
    expect(seen.cut).toBeGreaterThan(700);
    expect(seen.long).toBeGreaterThan(600);
    expect(seen.lf).toBeGreaterThan(4000);
  });
});

// A regression fails in the bound and one more run (see repeatedWithin),
// which took up to 40 s.
vi.setConfig({ testTimeout: 120_000 });

/** Each timed case below takes under 100 ms, and under 300 ms with coverage
 * on a loaded machine running other files; what each guards against took
 * 20-40 s for the same work, ten times the bound or more. */
const BOUND = 2000;

/** Runs `f` `times` times, stopping once `ms` has passed, and asserts that
 * all of them took under `ms`. */
function repeatedWithin(ms: number, times: number, f: () => void): void {
  const t0 = performance.now();
  for (let i = 0; i < times && performance.now() - t0 < ms; i++) f();
  expect(performance.now() - t0).toBeLessThan(ms);
}

describe("the splitter's cost", () => {
  it("searches a part for a short boundary whole: one indexOf, not one per line", () => {
    // indexOf skips most of these 4 MB when it looks for the whole delimiter
    // (0.1 ms a split). Looking for CRLF "--" alone stops it at each CR, and
    // the search goes on from each of the 262,144 hits (15 ms); a part's bytes
    // are split again at every level of nesting, by every body test. Counted,
    // not timed (a loaded runner under coverage came within 20% of a bound
    // the regression was only ten times over): the indexOf calls on the body.
    const boundary = "0123456789abcdefghijklmnopqrstuv";
    const part = "\r\n".repeat(3 << 19) + "\r\n--".repeat(1 << 18);
    const body = `--${boundary}\r\n\r\n${part}\r\n--${boundary}--\r\n`;
    const indexOf = vi.spyOn(String.prototype, "indexOf");
    let parts: string[];
    let reads: number;
    try {
      parts = splitMultipart(body, boundary, false).parts.map((p) => p.body);
      reads = indexOf.mock.contexts.filter((c) => String(c) === body).length;
    } finally {
      indexOf.mockRestore();
    }
    expect(parts).toEqual([part]);
    // At least one, so the count sees the search; the rest read its lines.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(10);
  });

  it("is linear in a part full of near-matches of a long boundary", () => {
    // The issue's 4091-byte boundary: 0.5 s a split before the fix.
    const boundary = "q".repeat(4091);
    const bodies = ["\r\n", "\n"].map((nl) => {
      const near = `${nl}--${boundary.slice(0, -1)}#`;
      const part = `--${boundary}${nl}${nl}${near.repeat(64)}${nl}`;
      const body = `${part.repeat(4)}--${boundary}--${nl}`;
      const m = splitMultipart(body, boundary, false);
      expect(m.parts.map((p) => p.body)).toEqual(Array(4).fill(near.repeat(64)));
      expect(body.length).toBeGreaterThan(1 << 20);
      return body;
    });
    repeatedWithin(BOUND, 25, () => {
      for (const body of bodies) splitMultipart(body, boundary, false);
    });
  });

  it("is linear in a preamble that repeats the lines of a boundary with a line break in it", () => {
    // Every line starts "--" boundary, which spans 1024 lines, and the
    // comparison ran over them at each: 2.3 s a split before the fix.
    const boundary = `q\n${"--q\n".repeat(1023)}#`;
    const body = "--q\n".repeat(1 << 18);
    const m = splitMultipart(body, boundary, false);
    expect(m.parts.length).toBe(1);
    expect(m.prologue).toBe(body);
    repeatedWithin(BOUND, 10, () => splitMultipart(body, boundary, false));
  });
});

describe("the delimiter search's cost", () => {
  // The splitter cannot reach the search with a boundary that holds a line
  // break (no line can hold a delimiter then), but the search is linear on
  // its own terms. Over 1 MB of the first boundary's near-matches indexOf
  // took 30 s; over half a megabyte of the second's, comparing the rest of
  // the boundary after each hit of its head took 20 s, as a comparison runs
  // on over the hits after it.
  const cases = ["\n".repeat(262_144), `${"q\n--".repeat(32_768)}q`].map((boundary) => {
    const b = `\n--${boundary.slice(0, -1)}#`.repeat(4) + `\n--${boundary}`;
    return { b, boundary, at: b.length - boundary.length - 3 };
  });

  it("is linear over near-matches of a long boundary with a line break in it", () => {
    repeatedWithin(BOUND, 1, () => {
      for (const { b, boundary, at } of cases) expect(indexOfDelimiter(b, "\n", boundary, 0)).toBe(at);
    });
  });
});
