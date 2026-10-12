// RFC 5173 body test.
//
// Uses a hand-rolled BYTE-level MIME walker (not a general parser), so it walks
// the body as a "binary string" (one char per byte, 0–255) to keep indexOf/slice
// offsets byte-exact. Leaf text parts are transfer-decoded (QP/base64) then
// charset-decoded to UTF-8; :text HTML parts are stripped to text. Everything is
// linear/bounded (no backtracking regex on body content).

import { contentType, rootHeaderBytes } from "./mediatype.js";
import { htmlToText } from "./htmltext.js";
import { MatcherTest } from "./matcher.js";
import type { Message, RuntimeData, Test, Tri } from "./runtime.js";

// -------- byte/binary-string helpers --------

export function bytesToBinary(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return s;
}
export function binaryToBytes(s: string): Uint8Array {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

// -------- transfer-encoding decode --------

/** `cut`: the bytes are a prefix of the encoded part, so an escape (or soft
 * break) the cut split is dropped: its meaning lies past the cut, and kept as
 * text it would be content the part does not have. */
function qpDecode(bytes: Uint8Array, cut: boolean): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x3d /* = */) {
      if (cut && i + 2 >= bytes.length) break;
      const h1 = bytes[i + 1];
      const h2 = bytes[i + 2];
      if (h1 === 0x0d && h2 === 0x0a) {
        i += 2; // soft break =\r\n
      } else if (h1 === 0x0a) {
        i += 1; // soft break =\n
      } else if (h1 !== undefined && h2 !== undefined && hexValue(h1) >= 0 && hexValue(h2) >= 0) {
        out.push(hexValue(h1) * 16 + hexValue(h2));
        i += 2;
      } else {
        out.push(b); // not an escape ("=4x", "= 4"): text, as in Pigeonhole
      }
    } else {
      out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** A hex digit's value, or -1. Number.parseInt took "4x" as 4, " 4" as 4 and
 * "-1" as -1, decoding text into stray bytes. */
function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

const B64_PAD = -2;
const B64_SKIP = -1;
const B64 = (() => {
  const t = new Int8Array(256).fill(B64_SKIP);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  t[0x3d /* = */] = B64_PAD;
  return t;
})();

/**
 * Lenient base64: never throws, because malformed mail must not fail the
 * script (a thrown execute() skips every rule — see the host's fail-open).
 * Characters outside the alphabet are skipped; "=" ends the current quantum,
 * keeping the octets it completes, and decoding resumes after it, so padded
 * segments concatenated by a broken mailer read as one stream; a dangling
 * single character (length 4n+1) carries no whole octet and is dropped. A
 * prefix of the encoding therefore decodes to a prefix of the content, which
 * the truncation semantics rely on.
 */
function base64Decode(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor((bytes.length * 3) / 4) + 3);
  let o = 0;
  let quad = 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = B64[bytes[i]!]!;
    if (v === B64_SKIP) continue;
    if (v === B64_PAD) {
      if (n === 2) out[o++] = quad >> 4;
      else if (n === 3) {
        out[o++] = quad >> 10;
        out[o++] = (quad >> 2) & 0xff;
      }
      quad = 0;
      n = 0;
      continue;
    }
    quad = (quad << 6) | v;
    if (++n === 4) {
      out[o++] = quad >> 16;
      out[o++] = (quad >> 8) & 0xff;
      out[o++] = quad & 0xff;
      quad = 0;
      n = 0;
    }
  }
  if (n === 2) out[o++] = quad >> 4;
  else if (n === 3) {
    out[o++] = quad >> 10;
    out[o++] = (quad >> 2) & 0xff;
  }
  return out.subarray(0, o);
}

/** Returns transfer-decoded bytes, or null on an unknown encoding (skip part).
 * `cut`: the bytes are a prefix of the part, and decode to a prefix of it. */
export function cteDecode(bytes: Uint8Array, cte: string, cut: boolean): Uint8Array | null {
  const e = cte.toLowerCase().trim();
  if (e === "" || e === "7bit" || e === "8bit" || e === "binary") return bytes;
  if (e === "base64") return base64Decode(bytes);
  if (e === "quoted-printable") return qpDecode(bytes, cut);
  return null;
}

// -------- charset decode --------

/** `cut`: the bytes are a prefix of the part, so a character the cut split is
 * dropped (a streaming decode holds it back) rather than decoded as U+FFFD,
 * which would be content the part does not have. */
export function charsetDecode(bytes: Uint8Array, charset: string, cut: boolean): string {
  const cs = charset.toLowerCase().trim();
  if (cs === "" || cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return new TextDecoder("utf-8").decode(bytes, { stream: cut });
  }
  if (cs === "utf-16" || cs === "utf16") {
    // RFC 2781 §4.3: a byte-order mark decides; without one, big-endian.
    // (TextDecoder's "utf-16" label means little-endian.)
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2), { stream: cut });
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2), { stream: cut });
    return new TextDecoder("utf-16be").decode(bytes, { stream: cut });
  }
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "iso8859-1") {
    // True Latin-1 (byte → code point). TextDecoder maps this label to cp1252.
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  try {
    return new TextDecoder(cs, { fatal: false }).decode(bytes, { stream: cut });
  } catch {
    return bytesToBinary(bytes); // unknown charset ⇒ keep raw (tolerate unknown charsets)
  }
}

// -------- media type + header parsing --------

/** A Content-Type as core's MIME walker reads it (see mediatype.ts): what the
 * user's mail client shows is what the engine splits. */
export function parseMediaType(ct: string): { mediaType: string; primary: string; params: Record<string, string> } {
  return contentType(ct);
}

/** Structural fields, unlike editheader's virtual values, are immutable for
 * the lifetime of a Message. Share parsed types across parts and both walkers;
 * the part caps bound the distinct headers encountered. Charge new parsing
 * before doing it, and publish nothing if the requesting share runs out. */
const mediaTypes = new WeakMap<Message, Map<string, ReturnType<typeof parseMediaType>>>();

export function parseMediaTypeForMessage(d: RuntimeData, ct: string): ReturnType<typeof parseMediaType> {
  let cache = mediaTypes.get(d.msg);
  const held = cache?.get(ct);
  if (held !== undefined) return held;
  d.budget.consume(1 + Math.floor(ct.length / 64));
  const parsed = parseMediaType(ct);
  if (cache === undefined) mediaTypes.set(d.msg, (cache = new Map()));
  cache.set(ct, parsed);
  return parsed;
}

/** Whether a part of this media type nests a message the walker descends. */
export function isMessage(mediaType: string): boolean {
  return mediaType === "message/rfc822" || mediaType === "message/global";
}

/** Parse a MIME header block (binary string) into a case-insensitive map of
 * each field's FIRST value, as core's walker reads a part's header. */
export function parseMimeHeader(block: string): Map<string, string> {
  const h = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  // A field's lines: its first, then its continuations. The value is each
  // line trimmed of space and tab only, the empty ones dropped, joined by a
  // space, as the walker's trimAroundNewlines does: JS trim() also took a
  // vertical tab or a form feed, which changed a folded boundary.
  let cur: string[] = [];
  const flush = () => {
    const idx = cur[0]!.indexOf(":");
    if (idx === -1) return;
    const k = trimSpHt(cur[0]!.slice(0, idx)).toLowerCase();
    if (h.has(k)) return;
    const pieces = [cur[0]!.slice(idx + 1), ...cur.slice(1)].map(trimSpHt).filter((p) => p !== "");
    h.set(k, pieces.join(" "));
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur.length > 0) {
      cur.push(line);
    } else {
      if (cur.length > 0) flush();
      cur = [line];
    }
  }
  if (cur.length > 0) flush();
  return h;
}

/** Space and tab trimmed from both ends, and nothing else. */
function trimSpHt(s: string): string {
  let i = 0;
  let n = s.length;
  while (i < n && (s[i] === " " || s[i] === "\t")) i++;
  while (n > i && (s[n - 1] === " " || s[n - 1] === "\t")) n--;
  return s.slice(i, n);
}

/** A header block as core's walker reads it (see readHeaderBlock). */
export interface HeaderBlock {
  /** The fields the reader accepted, without the last one's line break. */
  fields: string;
  /** Where the header's bytes end: before the blank line, or where the reader
   * stopped on a line it refused. */
  head: number;
  /** Where the entity's body starts: after the blank line, where the reader
   * stopped on a line it refused, or the end of the input. */
  end: number;
  /** The reader refused a line. A multipart part whose header it refuses is
   * dropped with every part after it; an embedded message keeps the fields
   * before that line and its body starts after it. */
  err: boolean;
  /** The outcome rests on bytes past the read-window cut: with `err`, only
   * where the reader stopped does (the refusal is decided). */
  open: boolean;
  /** On a refusal, how far the walker's buffered reader had read from its
   * input: `end`, plus whatever it held buffered past it. `restExact`: that
   * is known, because its buffer was empty there or it had read everything;
   * otherwise it hinges on how the input reached it (see splitMultipart). */
  rest: number;
  restExact: boolean;
}

/** go-message's defaultMaxHeaderBytes, under which core's walker reads a
 * part's header block (an embedded message's has no limit). */
export const PART_HEADER_MAX = 1 << 20;

/** The buffer of Go's bufio reader under core's walker: a line is read in
 * pieces of at most this many bytes, and one the walker reads between parts
 * must fit in it. */
const LINE_MAX = 4096;

/**
 * How core's walker meets the end of the input a header block or a multipart
 * is read from:
 * - "whole": a whole body, or an embedded message, read from a copy of its
 *   bytes, whose end comes after its last bytes;
 * - "part": a part that ended at a boundary, read through that part, which
 *   hands over its last bytes with its end or before it, as its own window
 *   into the input falls, which the size of the message's header moves;
 * - "ranOut": a part that ran out with no boundary, whose end Go reads as an
 *   unexpected end of input.
 */
export type InputEnd = "whole" | "part" | "ranOut";

/**
 * The header block at `pos`, read as core's walker reads it (src/lib/mimewalk
 * textproto.ts, a port of go-message's textproto.ReadHeader). It ends at the
 * first blank line, or at the end of the input without an error, unless that
 * input "ranOut". It refuses a block whose first line starts with a space or
 * tab, a field with no colon on its first line (one on a continuation line
 * puts the line break in the name), a field name with a byte outside
 * printable ASCII, a field whose first line ends a "whole" input on a
 * LINE_MAX boundary (see readLine), and a block over `max`, charged as core's
 * port charges it: each line's pieces, 2 more at its end, and each field's
 * buffer slack (see appendSlack). Where a line ends a "part" input on a
 * LINE_MAX boundary, Go's ReadLine may or may not read the empty piece after
 * it: what turns on that is left open.
 *
 * `cut`: `b` is a prefix of the real content. A line the cut splits, and
 * whether a continuation line follows the last one seen, are past it.
 */
export function readHeaderBlock(b: string, pos: number, max: number, cut: boolean, inputEnd: InputEnd = "whole"): HeaderBlock {
  const fields = (end: number) => b.slice(pos, withoutLineBreak(b, pos, end));
  const done = (blank: number, end: number, err: boolean): HeaderBlock => ({
    fields: fields(blank),
    head: blank,
    end,
    err,
    open: false,
    rest: end,
    restExact: end >= b.length,
  });
  /** The reader stopped at `stop` on a refused line; the fields end at `from`. */
  const refused = (from: number, stop: number, rest = stop, restExact = stop >= b.length): HeaderBlock => ({
    fields: fields(from),
    head: stop,
    end: stop,
    err: true,
    open: false,
    rest,
    restExact,
  });
  const open = (err: boolean): HeaderBlock => ({ fields: "", head: b.length, end: b.length, err, open: true, rest: b.length, restExact: false });
  const budget = { n: max };
  if (pos < b.length && isSpHt(b.charCodeAt(pos))) {
    // The reader takes that line and refuses the block.
    const line = readLine(b, pos, budget, cut);
    if (line === null) return open(true);
    return line.over ? refused(pos, line.rest, line.rest, line.exact) : refused(pos, line.next);
  }
  let p = pos;
  for (;;) {
    if (p >= b.length) {
      // The end of the input ends the block, charged as an empty line.
      if (cut) return open(false);
      budget.n -= 2;
      return done(p, p, budget.n < 0 || inputEnd === "ranOut");
    }
    const first = readLine(b, p, budget, cut);
    if (first === null) return open(false);
    if (first.over) return refused(p, first.rest, first.rest, first.exact);
    if (first.empty) return done(p, first.next, false);
    if (first.eof && inputEnd !== "part") return refused(p, b.length);
    // A field: this line, then each line that starts with a space or tab.
    const bad = !fieldNameOk(b, p, first.contentEnd);
    let size = first.contentEnd - p + 2;
    let next = first.next;
    let eof = first.eof;
    // A line that ran to the end of the input has none after it.
    while (first.next > first.contentEnd) {
      if (next >= b.length) {
        if (cut) return open(bad);
        break;
      }
      if (!isSpHt(b.charCodeAt(next))) break;
      const cont = readLine(b, next, budget, cut);
      if (cont === null) return open(bad);
      if (cont.over) return refused(p, cont.rest, cont.rest, cont.exact);
      // A continuation that ends on a LINE_MAX boundary at the end of the
      // input ends the field, without its line break.
      size += cont.contentEnd - next + (cont.eof ? 0 : 2);
      next = cont.next;
      eof ||= cont.eof;
    }
    budget.n -= appendSlack(size);
    if (eof && inputEnd === "part") {
      // The field ends the input on a LINE_MAX boundary, and the reader may
      // have had the end of input with that piece: then the line is whole, a
      // folded one keeps its line break, and the empty piece is not read.
      // Read the field to the end both ways; where they differ, unknown.
      const whole = budget.n + appendSlack(size) - appendSlack(first.eof ? size : size + 2) - 2;
      const plain = first.eof || bad || budget.n - 2 < 0;
      const other = bad || whole < 0;
      if (plain !== other) return open(false);
      return plain ? refused(p, next) : done(next, next, false);
    }
    if (bad || budget.n < 0) return refused(p, next);
    p = next;
  }
}

/** One line as go-message's readLineSlice reads it through Go's ReadLine. */
interface Line {
  /** Where the next line starts. */
  next: number;
  /** Where its content ends: before its line break, or at the end. */
  contentEnd: number;
  /** A blank line. */
  empty: boolean;
  /** It ended at the end of the input on a LINE_MAX boundary: Go's ReadLine
   * then returns its last, empty, piece with the end-of-input error. */
  eof: boolean;
  /** The budget ran out on it: the reader stopped there, having read to
   * `rest`, which is `exact` when its buffer was then empty. */
  over: boolean;
  rest: number;
  exact: boolean;
}

/**
 * The line at `start`, charged to `budget` as the reader charges it: in the
 * pieces Go's ReadLine returns. A line with no line break within LINE_MAX
 * bytes comes in a full buffer's worth (less a CR at its end, which is read
 * again with the next piece), and is charged its length; the last piece is
 * charged its length plus 2. The reader stops at the piece that runs the
 * budget out. After a full piece its buffer is empty, so it has read exactly
 * to that piece's buffer end; after a last piece its buffer may hold more.
 * null: the cut leaves the line open.
 */
function readLine(b: string, start: number, budget: { n: number }, cut: boolean): Line | null {
  const lf = b.indexOf("\n", start);
  const over = (rest: number, exact: boolean): Line => ({ next: rest, contentEnd: rest, empty: false, eof: false, over: true, rest, exact });
  let s = start;
  let full = false;
  for (;;) {
    if (lf !== -1 && lf - s < LINE_MAX) {
      const end = lf > s && b.charCodeAt(lf - 1) === 13 /* \r */ ? lf - 1 : lf;
      budget.n -= end - s + 2;
      if (budget.n < 0) return over(lf + 1, lf + 1 >= b.length);
      return { next: lf + 1, contentEnd: end, empty: !full && end === s, eof: false, over: false, rest: lf + 1, exact: false };
    }
    if (b.length - s >= LINE_MAX) {
      const len = b.charCodeAt(s + LINE_MAX - 1) === 13 /* \r */ ? LINE_MAX - 1 : LINE_MAX;
      budget.n -= len;
      if (budget.n < 0) return over(s + LINE_MAX, true);
      s += len;
      full = true;
      continue;
    }
    if (cut) return null;
    // The end of the input, with no line break.
    budget.n -= b.length - s + 2;
    if (budget.n < 0) return over(b.length, true);
    return { next: b.length, contentEnd: b.length, empty: false, eof: full && s === b.length, over: false, rest: b.length, exact: true };
  }
}

/** `end`, less the line break that ends the text before it. */
function withoutLineBreak(b: string, start: number, end: number): number {
  if (end > start && b.charCodeAt(end - 1) === 10 /* \n */) end--;
  if (end > start && b.charCodeAt(end - 1) === 13 /* \r */) end--;
  return end;
}

/** Whether the line [start, end) has a colon, and the name before it (less
 * outer space and tab) only printable ASCII. */
function fieldNameOk(b: string, start: number, end: number): boolean {
  let colon = start;
  while (colon < end && b.charCodeAt(colon) !== 58 /* : */) colon++;
  if (colon === end) return false;
  let i = start;
  let n = colon;
  while (i < n && isSpHt(b.charCodeAt(i))) i++;
  while (n > i && isSpHt(b.charCodeAt(n - 1))) n--;
  for (; i < n; i++) {
    const c = b.charCodeAt(i);
    if (c < 33 || c > 126) return false;
  }
  return true;
}

/** What the reader charges a field's buffer beyond its length: Go's slack
 * past a 256-byte allocation, exact up to it and an upper bound above (see
 * goAppendSlack in core's textproto.ts). */
function appendSlack(len: number): number {
  return len <= 256 ? 256 - len : (len >> 1) + 256;
}

function isSpHt(c: number): boolean {
  return c === 32 || c === 9;
}

// -------- the body test --------

/**
 * Bounds on the MIME structure the body test walks (RFC 5703 §11: part
 * matching must not deny service). Without them a nesting bomb overflowed the
 * call stack — a throw, which the host's fail-open turns into "skip every
 * rule" — and re-scanned the remaining body once per level. Past them a
 * no-match is "unknown": the rule does not fire, but nothing throws.
 *
 * Depth is Dovecot's message-parser limit (100, added for CVE-2020-12100);
 * nesting is cheap in steps. Parts stay at 1024, not Dovecot's 10000: every
 * body test charges every part, so 10000 tiny parts under a handful of body
 * rules exhaust a host's step budget, and its later tests go unknown.
 */
export const MAX_MIME_DEPTH = 100;

/**
 * Each leaf's text, per Message object: decoded, and reduced from HTML for
 * :text ("t") or not ("c"), keyed by mode and the leaf's place in the MIME
 * tree. Every body test walks the same tree, and decoding and HTML reduction
 * are linear in the part, so a script with many body tests redid them once per
 * test. null: a transfer encoding not decoded, so the part is skipped. The
 * cache lives as long as the Message object, so it also assumes the object's
 * top-level Content-Type and transfer encoding and bodyTruncated() do not
 * change: a host that reuses one object for a changed message gets stale text.
 */
const leafTexts = new WeakMap<Message, Map<string, string | null>>();

function leafCache(msg: Message): Map<string, string | null> {
  let m = leafTexts.get(msg);
  if (m === undefined) leafTexts.set(msg, (m = new Map()));
  return m;
}

/** The raw body as a binary string, per message: converting it costs about as
 * much as the rest of a body test, and every body test started with it. */
const rawBinaries = new WeakMap<Message, string>();

export function rawBinary(msg: Message, raw: Uint8Array): string {
  let s = rawBinaries.get(msg);
  if (s === undefined) rawBinaries.set(msg, (s = bytesToBinary(raw)));
  return s;
}
export const MAX_MIME_PARTS = 1024;

interface SplitCacheEntry {
  body: string;
  boundary: string;
  cut: boolean;
  inputEnd: InputEnd;
  result: Multipart;
}

/** Like rawBinaries and leafTexts, splits belong to the immutable Message.
 * Both walkers use the same part paths: .N for a multipart's Nth child, .m
 * for an embedded message. Keying by path avoids hashing each large nested
 * body on every read. The walkers' part/depth caps bound the paths retained.
 * A path keeps only its latest tuple, checked in full before reusing it. */
const multipartSplits = new WeakMap<Message, Map<string, SplitCacheEntry>>();

export function splitMultipartForMessage(d: RuntimeData, path: string, b: string, boundary: string, cut: boolean, inputEnd: InputEnd): Multipart {
  let cache = multipartSplits.get(d.msg);
  const held = cache?.get(path);
  if (held !== undefined && held.body === b && held.boundary === boundary && held.cut === cut && held.inputEnd === inputEnd) return held.result;
  // Charge before scanning. A missing boundary synthesizes a child without
  // scanning, but each real split can read this entire level's bytes. An
  // exhausted share must not publish a partial result in this cache.
  d.budget.consume(1 + (boundary === "" ? 0 : Math.floor((b.length + boundary.length) / 64)));
  const result = splitMultipart(b, boundary, cut, inputEnd);
  if (cache === undefined) multipartSplits.set(d.msg, (cache = new Map()));
  cache.set(path, { body: b, boundary, cut, inputEnd, result });
  return result;
}

export class TestBody implements Test {
  /** Restores the captures in force, whatever it matched (see check). */
  readonly setsCaptures = false;
  readonly matcher = new MatcherTest();
  raw = false;
  text = false;
  content: string[] = [];

  private matchOpts(d: RuntimeData) {
    return { maxMatchInputLength: d.script.opts.maxMatchInputLength };
  }

  /**
   * Three-valued over a truncated body (Message.bodyTruncated — the host's
   * read window cut the raw bytes). The walk threads a per-part `cut` flag so
   * a part that ENDS at a found boundary keeps exact match semantics — only
   * the tail that ran into the cut is a prefix — and a definite match from any
   * part is sound however much body was cut away. A NO-match over a truncated
   * body is always "unknown": whole parts (even whole part TYPES the :content
   * filter wanted) may sit past the cut, unseen. Comparisons the engine's own
   * match-input cap truncated surface as "unknown" through tryMatch the same
   * way, truncated body or not.
   */
  check(d: RuntimeData): Tri {
    const savedVars = d.matchVariables;
    try {
      const raw = d.msg.bodyRaw();
      if (raw === null) return false;
      const bodyCut = d.msg.bodyTruncated?.() ?? false;

      if (this.raw) {
        // :raw is ONE part by definition, so its count is exact even when cut.
        if (this.matcher.isCount()) return this.matcher.countMatches(d, 1);
        return this.matcher.tryMatch(d, rawBinary(d.msg, raw), this.matchOpts(d), bodyCut);
      }

      const topCt = rootHeaderBytes(d.msg, "content-type", "text/plain; charset=us-ascii");
      const topCte = rootHeaderBytes(d.msg, "content-transfer-encoding");
      const counter = { count: 0, parts: 0 };
      const flags = { unknown: false };
      const matched = this.walk(d, topCt, topCte, rawBinary(d.msg, raw), counter, bodyCut, "whole", flags, 0, "");
      if (matched) return true;
      if (this.matcher.isCount()) {
        const res = this.matcher.countMatches(d, counter.count);
        if (flags.unknown) {
          // Structure ran off the cut, so the visible count is a LOWER BOUND —
          // whole parts may sit past it. `ge`/`gt` already proven stay proven;
          // everything else could flip. (A cut that fell inside a LEAF leaves
          // the count exact: the tail extends a part, it does not add one.)
          return res === true && (this.matcher.relational === "ge" || this.matcher.relational === "gt")
            ? true
            : "unknown";
        }
        return res;
      }
      return flags.unknown ? "unknown" : false;
    } finally {
      d.matchVariables = savedVars; // body restores match vars regardless of outcome
    }
  }

  private wantsPart(mediaType: string): boolean {
    if (this.text) {
      return mediaType.split("/").length === 2 && (mediaType.startsWith("text/") || mediaType === "application/xhtml+xml");
    }
    for (const raw of this.content) {
      const ct = raw.toLowerCase().trim();
      if (ct === "") return true;
      if (ct.startsWith("/") || ct.endsWith("/") || (ct.match(/\//g) ?? []).length > 1) continue;
      if (ct === mediaType || mediaType.startsWith(`${ct}/`)) return true;
    }
    return false;
  }

  /** Match one source, or count it. `cut` marks the source as a prefix of the
   * real content; an unknown from tryMatch lands in `flags`, never in the
   * boolean (which reports DEFINITE matches only). */
  private matchOrCount(
    d: RuntimeData,
    source: string,
    counter: { count: number; parts: number },
    cut: boolean,
    flags: { unknown: boolean },
  ): boolean {
    if (this.matcher.isCount()) {
      counter.count++;
      return false;
    }
    const r = this.matcher.tryMatch(d, source, this.matchOpts(d), cut);
    if (r === "unknown") {
      flags.unknown = true;
      return false;
    }
    return r;
  }

  /** `cut` = this part's content string may be a PREFIX of the real content
   * (the read-window cut fell inside it). Splitting on a FOUND boundary proves
   * everything before that boundary complete, so only the fragment that ran to
   * the end of a cut string inherits the flag. `inputEnd`: see InputEnd.
   * Returns definite matches only; unknowns accumulate in `flags`. */
  private walk(
    d: RuntimeData,
    ctHeader: string,
    cteHeader: string,
    b: string,
    counter: { count: number; parts: number },
    cut: boolean,
    inputEnd: InputEnd,
    flags: { unknown: boolean },
    depth: number,
    path: string,
  ): boolean {
    d.budget.consume(1);
    // Structure past the caps is not examined, so a miss there is not proven:
    // "unknown", exactly as for a part the host's read window cut away.
    if (depth > MAX_MIME_DEPTH) {
      flags.unknown = true;
      return false;
    }
    const { mediaType, primary, params } = parseMediaTypeForMessage(d, ctHeader || "text/plain; charset=us-ascii");
    d.budget.consume(this.content.length); // each :content type, per part
    const process = this.wantsPart(mediaType);

    if (primary === "multipart") {
      // A multipart with no boundary has the one synthesized child, as in core.
      const mp = splitMultipartForMessage(d, path, b, params["boundary"] ?? "", cut, inputEnd);
      // A list that may go on past the cut can hide whole sibling parts —
      // even whole part TYPES a :content filter wanted — so any no-match at
      // this level is unknown. (With the list's end in view the structure is
      // complete and only the epilogue is a prefix; a cut inside a LEAF needs
      // no flag — its comparison runs under prefix semantics, and its tail
      // cannot hide another part.)
      if (mp.open) flags.unknown = true;
      if (process) {
        if (this.matcher.isCount()) {
          counter.count += 2;
        } else {
          if (this.matchOrCount(d, mp.prologue, counter, mp.prologueCut, flags)) return true;
          if (this.matchOrCount(d, mp.epilogue, counter, mp.epilogueCut, flags)) return true;
        }
      }
      for (let i = 0; i < mp.parts.length; i++) {
        if (++counter.parts > MAX_MIME_PARTS) {
          flags.unknown = true;
          return false;
        }
        const part = mp.parts[i]!;
        if (this.walk(d, part.contentType, part.cte, part.body, counter, part.cut, part.ends, flags, depth + 1, `${path}.${i}`)) {
          return true;
        }
      }
      return false;
    }

    if (isMessage(mediaType)) {
      // Its header block as core reads it: a line the reader refuses ends the
      // fields, and the body starts after that line.
      const h = readHeaderBlock(b, 0, Infinity, cut);
      // A header block the cut leaves open may be a prefix of the real one;
      // otherwise the cut can only fall in the body (the tail).
      if (process && this.matchOrCount(d, b.slice(0, h.head), counter, h.open, flags)) return true;
      // A cut inside the nested header hides the entity's real type and
      // structure, so nothing below it is walked, and a miss is not proven.
      if (h.open) {
        flags.unknown = true;
        return false;
      }
      if (++counter.parts > MAX_MIME_PARTS) {
        flags.unknown = true;
        return false;
      }
      const f = parseMimeHeader(h.fields);
      return this.walk(
        d,
        f.get("content-type") ?? "",
        f.get("content-transfer-encoding") ?? "",
        b.slice(h.end),
        counter,
        cut,
        "whole", // core reads an embedded message from a copy of its bytes
        flags,
        depth + 1,
        `${path}.m`,
      );
    }

    // leaf
    if (!process) return false;
    const cache = leafCache(d.msg);
    const key = `${this.text ? "t" : "c"}${path}`;
    let text = cache.get(key);
    if (text === undefined) {
      // Charged by size once; later body tests read the cached text.
      d.budget.consume(b.length >> 10);
      text = this.leafText(b, cteHeader, mediaType, params, cut);
      cache.set(key, text);
    }
    if (text === null) return false; // unknown transfer-encoding → skip
    return this.matchOrCount(d, text, counter, cut, flags);
  }

  /** The text a leaf's body `b` reads as, or null for a transfer encoding not
   * decoded. Decoding never throws (see base64Decode). A cut leaf decodes to a
   * prefix of its content, which matchOrCount then reads under prefix
   * semantics, so every step drops what the cut left open instead of guessing
   * it. */
  private leafText(b: string, cteHeader: string, mediaType: string, params: Record<string, string>, cut: boolean): string | null {
    const decoded = cteDecode(binaryToBytes(b), cteHeader, cut);
    if (decoded === null) return null;
    let text: string;
    if (mediaType.startsWith("text/")) {
      text = charsetDecode(decoded, params["charset"] ?? "us-ascii", cut);
    } else {
      text = bytesToBinary(decoded); // non-text leaf: raw transfer-decoded octets
    }
    if (this.text && (mediaType === "text/html" || mediaType === "application/xhtml+xml")) {
      text = htmlToText(text, cut);
    }
    return text;
  }
}

// -------- the multipart walker --------

/** A part of a multipart, as core's walker lists it. */
export interface SplitPart {
  /** Its header fields (see HeaderBlock.fields); "" for a synthesized child. */
  fields: string;
  /** Its first Content-Type and Content-Transfer-Encoding, as the walker
   * reads a part's header. */
  contentType: string;
  cte: string;
  /** Its body, still transfer-encoded. */
  body: string;
  /** The body is a prefix of the real one: the read-window cut fell in it, or
   * (a synthesized child) what core puts in it is not known here. */
  cut: boolean;
  /** How the body's end reaches the walker: "part", or "ranOut" with no
   * boundary (see InputEnd). */
  ends: InputEnd;
}

export interface Multipart {
  /** The text before the first delimiter line (all of it, without one), less
   * the line break before that line. */
  prologue: string;
  prologueCut: boolean;
  parts: SplitPart[];
  /** The text after the list: after a close delimiter line, or from the line
   * that ended the list. */
  epilogue: string;
  epilogueCut: boolean;
  /** Parts may follow the listed ones past the read-window cut. */
  open: boolean;
}

/** The child core synthesizes for a multipart with no part (RFC 3501's
 * BODYSTRUCTURE needs one). */
const SYNTHESIZED = "text/plain; charset=utf-8";

/**
 * A multipart body's parts as core's walker (src/lib/mimewalk/multipart.ts, a
 * port of go-message's fork of Go's mime/multipart) lists them: the parts the
 * user's mail client is served, so a rule neither acts on a part the client
 * does not show nor misses one it does.
 *
 * Preamble lines are skipped up to the first delimiter line: "--" boundary,
 * transport padding, a line break. Its line break is the multipart's: a bare
 * LF there makes "\n--boundary" the delimiter, otherwise only
 * "\r\n--boundary" is, and the other form is content or ends the list. A
 * part's header block is read as readHeaderBlock reads it; a refused one
 * drops the part and every one after it. Its body ends before the line break
 * of the first line that starts with the boundary and then "-", a space, a
 * tab, CR or LF (or anything, when the line break, "--" and the boundary fill
 * LINE_MAX), or at the end of the input, and the list goes on only if
 * that line is a delimiter line. Anything else ends it: a close delimiter,
 * but also "--b-alt" (a nested boundary that "b" prefixes), "--b junk",
 * "--b--junk", or a delimiter in the other line-break form. So does a line
 * between parts longer than LINE_MAX. That is looser than RFC 2046 §5.1.1
 * about where a part ends and stricter about what follows, and it is what the
 * client shows.
 *
 * A multipart with no part gets one text/plain child holding what core's
 * reader has left: the whole body for an empty boundary (it reads nothing),
 * nothing once the preamble ran to the end, the body past LINE_MAX bytes of
 * an over-long preamble line, the body past the full buffer on which a first
 * part's header ran out its budget. After a close delimiter, or a first part
 * whose header was refused anywhere else, its reader has read ahead by an
 * amount that hinges on the size of the message's own header, so the child
 * is "" read as a prefix: only what any content would match is definite.
 *
 * It stops after MAX_MIME_PARTS + 1 parts, open, as the walkers stop there.
 *
 * `inputEnd`: see InputEnd. `cut`: `b` is a prefix of the real content.
 * A decision that rests on bytes past it stays open: whether a line is a
 * delimiter line, whether a part's header block completes, whether the list
 * goes on.
 */
export function splitMultipart(b: string, boundary: string, cut: boolean, inputEnd: InputEnd = "whole"): Multipart {
  if (boundary === "") {
    return { prologue: b, prologueCut: cut, parts: [synthesized(b, cut)], epilogue: "", epilogueCut: cut, open: false };
  }
  const dash = `--${boundary}`;
  let nl = "\r\n";
  let nlDash = `\r\n${dash}`;
  /** The search for nlDash, built at the first part's body: the first
   * delimiter line has set nl by then, and nothing changes it after. */
  let search: DelimiterSearch | undefined;
  const parts: SplitPart[] = [];
  let first = -1; // where the first delimiter line starts
  let expectNewPart = false;
  let pos = 0;

  /** The list ends. `rest`: how far core's reader has read, `exact` when
   * that is known, for the child of a multipart with no part. */
  const finish = (prologueEnd: number, epilogue: number, rest: number, exact: boolean): Multipart => {
    if (parts.length === 0) {
      const known = exact || (rest >= b.length && !cut);
      parts.push(synthesized(known ? b.slice(rest) : "", cut || !known));
    }
    return {
      prologue: b.slice(0, first !== -1 ? withoutLineBreak(b, 0, first) : prologueEnd),
      prologueCut: false,
      parts,
      epilogue: b.slice(epilogue),
      epilogueCut: cut,
      open: false,
    };
  };
  /** The list runs past the cut, or past MAX_MIME_PARTS: the epilogue is
   * unseen. A preamble line the cut split is not prologue if it could still
   * turn out to be a delimiter line. */
  const open = (): Multipart => {
    let prologueEnd = b.length;
    if (first !== -1) prologueEnd = withoutLineBreak(b, 0, first);
    else if (lineCouldBe(b, pos, dash, true) || lineCouldBe(b, pos, `${dash}--`, true)) prologueEnd = withoutLineBreak(b, 0, pos);
    else if (b.charCodeAt(b.length - 1) === 13 /* \r */) prologueEnd--;
    return { prologue: b.slice(0, prologueEnd), prologueCut: first === -1, parts, epilogue: "", epilogueCut: true, open: true };
  };
  /** After "--" boundary at `k`: 1, the boundary ends a part's body; -1, it
   * does not; 0, the cut leaves it open. */
  const afterBoundary = (k: number): -1 | 0 | 1 => {
    if (k >= b.length) return cut ? 0 : 1;
    const c = b.charCodeAt(k);
    return c === 45 /* - */ || c === 32 || c === 9 || c === 13 || c === 10 ? 1 : -1;
  };
  /** Where the body of a part that starts at `s` ends. `eof`: it ran to the
   * end of a complete input; `cut`: to the cut, or the cut leaves open
   * whether it ends there. */
  const bodyEnd = (s: number): { end: number; cut: boolean; eof: boolean } => {
    let from = s;
    if (b.startsWith(dash, s)) {
      // A boundary right at the start, with no line break before it.
      const m = afterBoundary(s + dash.length);
      if (m !== -1) return { end: s, cut: m === 0, eof: false };
      from = s + dash.length;
    } else if (b.length - s < dash.length && dash.startsWith(b.slice(s))) {
      return { end: s, cut, eof: !cut };
    }
    search ??= delimiterSearch(nl, boundary);
    for (let i = search(b, from); i !== -1; i = search(b, from)) {
      // A delimiter that fills the reader's buffer leaves it no room to look
      // at the byte after it, and it takes the boundary as found. (A longer
      // one has no delimiter line that fits, so no part to end.)
      const m = nlDash.length >= LINE_MAX ? 1 : afterBoundary(i + nlDash.length);
      if (m !== -1) return { end: i, cut: m === 0, eof: false };
      from = i + nlDash.length;
    }
    // No boundary. A tail that could still begin one is held back, at the
    // end of a complete input as at the cut.
    const j = b.lastIndexOf(nlDash[0]!);
    const held = j >= from && b.length - j < nlDash.length && nlDash.startsWith(b.slice(j));
    return { end: held ? j : b.length, cut, eof: !cut };
  };
  /** Whether [start, end) is "--" boundary, padding, then `tail`. */
  const lineIs = (start: number, end: number, prefix: string, tail: string): boolean => {
    if (!b.startsWith(prefix, start)) return false;
    let i = start + prefix.length;
    while (i < end && isSpHt(b.charCodeAt(i))) i++;
    return end - i === tail.length && b.startsWith(tail, i);
  };

  for (;;) {
    const lf = b.indexOf("\n", pos);
    if (lf === -1 || lf - pos >= LINE_MAX) {
      // The reader's buffer fills with no line break: it gives up there. In
      // the preamble the prologue keeps what it read of the line, as it does
      // when the cut falls in the line first.
      if (b.length - pos >= LINE_MAX) {
        const read = pos + LINE_MAX;
        return finish(read, first === -1 ? read : pos, read, true);
      }
      if (cut) {
        // A line the cut split ends the list only if it cannot turn out to
        // be a delimiter line (nor the line break before one). Whether the
        // epilogue follows it (a close delimiter) or starts with it is open.
        const partial = b.slice(pos);
        if (first === -1 || lineCouldBe(b, pos, dash, nl === "\r\n") || (!expectNewPart && nl.startsWith(partial))) return open();
        return finish(0, lineCouldBe(b, pos, `${dash}--`, nl === "\r\n") ? b.length : pos, b.length, true);
      }
      // The last line has no line break: the list ends, cleanly at a close
      // delimiter, and the reader has read everything.
      const close = lineIs(pos, b.length, `${dash}--`, "");
      return finish(close ? withoutLineBreak(b, 0, pos) : b.length, close ? b.length : pos, b.length, true);
    }
    const lineEnd = lf + 1;
    // A delimiter line is "--" boundary, padding and a line break, so a line
    // no longer than "--" boundary is none, and testing that first keeps the
    // comparison in the line. For a boundary with a line break in it, it ran
    // on over the lines after it at every line that starts it (#68).
    if (lineEnd - pos > dash.length && b.startsWith(dash, pos)) {
      // The first delimiter line sets the line break, a bare LF if it ends so.
      if (first === -1 && lineIs(pos, lineEnd, dash, "\n")) {
        nl = "\n";
        nlDash = `\n${dash}`;
      }
      if (lineIs(pos, lineEnd, dash, nl)) {
        if (first === -1) first = pos;
        const h = readHeaderBlock(b, lineEnd, PART_HEADER_MAX, cut, inputEnd);
        if (h.err) return finish(0, pos, h.rest, h.restExact);
        if (h.open) return open();
        const body = bodyEnd(h.end);
        const fields = parseMimeHeader(h.fields);
        parts.push({
          fields: h.fields,
          contentType: fields.get("content-type") ?? "",
          cte: fields.get("content-transfer-encoding") ?? "",
          body: b.slice(h.end, body.end),
          cut: body.cut,
          ends: body.eof ? "ranOut" : "part",
        });
        // Past the walkers' cap the list is not read on (both stop there).
        if (body.cut || parts.length > MAX_MIME_PARTS) return open();
        if (body.eof) return finish(0, body.end, b.length, true);
        pos = body.end;
        expectNewPart = false;
        continue;
      }
      if (lineIs(pos, lineEnd, `${dash}--`, nl)) {
        return finish(withoutLineBreak(b, 0, pos), lineEnd, lineEnd, false);
      }
    }
    if (expectNewPart) return finish(0, pos, lineEnd, false);
    if (first !== -1) {
      // Between parts only the line break before a delimiter line may come.
      if (lineEnd - pos !== nl.length || !b.startsWith(nl, pos)) return finish(0, pos, lineEnd, false);
      expectNewPart = true;
    }
    pos = lineEnd;
  }
}

/** How much of a boundary the delimiter search hands to indexOf: V8 finds a
 * pattern of up to 250 bytes in linear time (its Boyer-Moore tables stop at
 * kBMMaxShift, 250), and CRLF "--" takes 4 of them. */
const DELIMITER_HEAD = 246;

/** Where nl "--" boundary first starts in `b` at or after `from`. */
export type DelimiterSearch = (b: string, from: number) => number;

/**
 * A search for nl "--" boundary that finds where b.indexOf(nl + "--" +
 * boundary, from) finds it, in time linear in the bytes it reads. It is built
 * once per split, as everything it holds depends only on nl and the boundary.
 *
 * V8's indexOf finds a pattern of up to 250 bytes (what its Boyer-Moore
 * tables cover) in linear time, mostly without reading every byte. Past that
 * it compared a long boundary again at each near-match of it: O(n·|boundary|)
 * over a body full of them (#68). So a boundary of up to `head` bytes is
 * searched for whole, as before, and a longer one by its first `head` bytes,
 * comparing the rest after each hit. Without a line break in the boundary a
 * hit holds one LF, its line break's, so two hits overlap at most in a CR
 * that ends one and starts the next (a head that ends in CR, with CRLF), and
 * a comparison stops at the next LF, before the next hit's rest: no byte is
 * compared twice. A boundary can hold one (percent-encoded, through RFC
 * 2231), and then a comparison could run on over the hits after it: that one
 * is found by Knuth-Morris-Pratt.
 *
 * Searching for nl "--" alone would be linear too, but it reads every byte
 * and stops at each line break: up to 250 times what indexOf costs on the
 * whole delimiter, paid again at every level of nesting.
 *
 * `head`: smaller in tests, to take short boundaries down a long one's paths.
 */
export function delimiterSearch(nl: string, boundary: string, head = DELIMITER_HEAD): DelimiterSearch {
  const delimiter = `${nl}--${boundary}`;
  if (boundary.length <= head) return (b, from) => b.indexOf(delimiter, from);
  if (boundary.includes("\n")) {
    const border = kmpBorders(delimiter);
    return (b, from) => kmpIndexOf(b, delimiter, border, from);
  }
  const needle = delimiter.slice(0, delimiter.length - boundary.length + head);
  const rest = boundary.slice(head);
  return (b, from) => {
    for (let i = b.indexOf(needle, from); i !== -1; i = b.indexOf(needle, i + 1)) {
      if (b.startsWith(rest, i + needle.length)) return i;
    }
    return -1;
  };
}

/** For each i, the longest proper prefix of p[0..i] that is a suffix of it:
 * Knuth-Morris-Pratt's table, in time linear in |p|. */
function kmpBorders(p: string): Int32Array {
  const border = new Int32Array(p.length);
  for (let i = 1, k = 0; i < p.length; i++) {
    while (k > 0 && p.charCodeAt(i) !== p.charCodeAt(k)) k = border[k - 1]!;
    if (p.charCodeAt(i) === p.charCodeAt(k)) k++;
    border[i] = k;
  }
  return border;
}

/** The first `p` in `b` at or after `from`, by Knuth-Morris-Pratt over its
 * table: each byte of `b` is read once, and each step back gives up a byte
 * matched before it, so the search is linear. */
function kmpIndexOf(b: string, p: string, border: Int32Array, from: number): number {
  for (let i = from, k = 0; i < b.length; i++) {
    const c = b.charCodeAt(i);
    while (k > 0 && c !== p.charCodeAt(k)) k = border[k - 1]!;
    if (c === p.charCodeAt(k)) k++;
    if (k === p.length) return i - k + 1;
  }
  return -1;
}

/** Whether the line at `start`, which has no line break yet, could still turn
 * out to be `prefix`, transport padding and a line break: LF, or with `crlf`
 * CRLF. */
function lineCouldBe(b: string, start: number, prefix: string, crlf: boolean): boolean {
  if (b.length - start <= prefix.length) return prefix.startsWith(b.slice(start));
  if (!b.startsWith(prefix, start)) return false;
  let i = start + prefix.length;
  while (i < b.length && isSpHt(b.charCodeAt(i))) i++;
  return i === b.length || (crlf && i === b.length - 1 && b.charCodeAt(i) === 13);
}

function synthesized(body: string, cut: boolean): SplitPart {
  return { fields: "", contentType: SYNTHESIZED, cte: "", body, cut, ends: "part" };
}
