// Media types and their parameters, read as core reads them.
//
// core's MIME walker (src/lib/mimewalk in core, a port of go-message) is what
// the user's mail client sees. A part the engine splits differently from it
// is a part an attachment rule cannot see while the user can (ts-sieve #56):
// the engine split on every ";", took no RFC 2231 continuations, and read a
// quoted-pair or an encoded word literally. This is core's mediatype.ts, a
// port of Go's mime.ParseMediaType, with go-message's fallback (contentType).
// Values are binary strings: a byte per character, as the walker reads them.

const RUNE_ERROR = 0xfffd;

/** Go's utf8.DecodeRuneInString over a binary string. */
function decodeRune(s: string, i: number): { r: number; size: number } {
  const n = s.length - i;
  if (n < 1) return { r: RUNE_ERROR, size: 0 };
  const b0 = s.charCodeAt(i);
  if (b0 < 0x80) return { r: b0, size: 1 };
  let size: number;
  let lo = 0x80;
  let hi = 0xbf;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    size = 2;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    size = 3;
    if (b0 === 0xe0) lo = 0xa0;
    if (b0 === 0xed) hi = 0x9f;
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    size = 4;
    if (b0 === 0xf0) lo = 0x90;
    if (b0 === 0xf4) hi = 0x8f;
  } else {
    return { r: RUNE_ERROR, size: 1 };
  }
  if (n < size) return { r: RUNE_ERROR, size: 1 };
  const b1 = s.charCodeAt(i + 1);
  if (b1 < lo || b1 > hi) return { r: RUNE_ERROR, size: 1 };
  if (size === 2) return { r: ((b0 & 0x1f) << 6) | (b1 & 0x3f), size: 2 };
  const b2 = s.charCodeAt(i + 2);
  if (b2 < 0x80 || b2 > 0xbf) return { r: RUNE_ERROR, size: 1 };
  if (size === 3) return { r: ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), size: 3 };
  const b3 = s.charCodeAt(i + 3);
  if (b3 < 0x80 || b3 > 0xbf) return { r: RUNE_ERROR, size: 1 };
  return { r: ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f), size: 4 };
}

interface MediaTypeResult {
  mediatype: string;
  params: Record<string, string> | null;
  err: boolean;
}

function isTSpecial(r: number): boolean {
  return '()<>@,;:\\"/[]?='.indexOf(String.fromCharCode(r)) >= 0;
}

// isTokenChar: 0x21..0x7E excluding tspecials.
function isTokenChar(r: number): boolean {
  return r > 0x20 && r < 0x7f && !isTSpecial(r);
}

// unicode.IsSpace over a decoded rune (Go TrimLeftFunc(unicode.IsSpace)).
function isUnicodeSpace(r: number): boolean {
  switch (r) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
  }
  return r >= 0x2000 && r <= 0x200a;
}

function trimLeftSpace(v: string): string {
  let i = 0;
  while (i < v.length) {
    const { r, size } = decodeRune(v, i);
    if (size === 0 || !isUnicodeSpace(r)) break;
    i += size;
  }
  return v.slice(i);
}

function trimSpaceFull(v: string): string {
  v = trimLeftSpace(v);
  // Right trim: decode runes from the start (byte strings are cheap to rescan).
  let end = v.length;
  for (;;) {
    let lastNonSpaceEnd = 0;
    let i = 0;
    while (i < end) {
      const { r, size } = decodeRune(v, i);
      if (size === 0) break;
      if (!isUnicodeSpace(r)) lastNonSpaceEnd = i + size;
      i += size;
    }
    end = lastNonSpaceEnd;
    break;
  }
  return v.slice(0, end);
}

function consumeToken(v: string): { token: string; rest: string } {
  for (let i = 0; i < v.length; i++) {
    if (!isTokenChar(v.charCodeAt(i))) {
      return { token: v.slice(0, i), rest: v.slice(i) };
    }
  }
  return { token: v, rest: "" };
}

function consumeValue(v: string): { value: string; rest: string } {
  if (v === "") return { value: "", rest: v };
  if (v[0] !== '"') {
    const t = consumeToken(v);
    return { value: t.token, rest: t.rest };
  }

  // Quoted-string.
  let buffer = "";
  for (let i = 1; i < v.length; i++) {
    const r = v[i];
    if (r === '"') return { value: buffer, rest: v.slice(i + 1) };
    // MSIE unescaped-backslash quirk: a backslash escapes only tspecials;
    // before anything else it is a literal backslash.
    if (r === "\\" && i + 1 < v.length && isTSpecial(v.charCodeAt(i + 1))) {
      buffer += v[i + 1];
      i++;
      continue;
    }
    if (r === "\r" || r === "\n") return { value: "", rest: v };
    buffer += r;
  }
  // No closing quote.
  return { value: "", rest: v };
}

function consumeMediaParam(v: string): { param: string; value: string; rest: string } {
  let rest = trimLeftSpace(v);
  if (!rest.startsWith(";")) return { param: "", value: "", rest: v };
  rest = rest.slice(1);
  rest = trimLeftSpace(rest);
  const tok = consumeToken(rest);
  const param = tok.token.toLowerCase();
  rest = tok.rest;
  if (param === "") return { param: "", value: "", rest: v };
  rest = trimLeftSpace(rest);
  if (!rest.startsWith("=")) return { param: "", value: "", rest: v };
  rest = rest.slice(1);
  rest = trimLeftSpace(rest);
  const val = consumeValue(rest);
  if (val.value === "" && val.rest === rest) return { param: "", value: "", rest: v };
  return { param, value: val.value, rest: val.rest };
}

function ishex(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
  );
}

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return 0;
}

function percentHexUnescape(s: string): { out: string; ok: boolean } {
  let percents = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "%") {
      i++;
      continue;
    }
    percents++;
    if (i + 2 >= s.length || !ishex(s.charCodeAt(i + 1)) || !ishex(s.charCodeAt(i + 2))) {
      return { out: "", ok: false };
    }
    i += 3;
  }
  if (percents === 0) return { out: s, ok: true };
  let t = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] === "%") {
      t += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 3;
    } else {
      t += s[i];
      i++;
    }
  }
  return { out: t, ok: true };
}

function decode2231Enc(v: string): { out: string; ok: boolean } {
  const q1 = v.indexOf("'");
  if (q1 < 0) return { out: "", ok: false };
  let charset = v.slice(0, q1);
  const rest1 = v.slice(q1 + 1);
  const q2 = rest1.indexOf("'");
  if (q2 < 0) return { out: "", ok: false };
  const extOtherVals = rest1.slice(q2 + 1);
  charset = charset.toLowerCase();
  if (charset !== "us-ascii" && charset !== "utf-8") return { out: "", ok: false };
  return percentHexUnescape(extOtherVals);
}

function checkMediaTypeDisposition(s: string): boolean {
  const t = consumeToken(s);
  if (t.token === "") return false; // errNoMediaType
  if (t.rest === "") return true;
  if (!t.rest.startsWith("/")) return false; // errNoSlashAfterFirstToken
  const sub = consumeToken(t.rest.slice(1));
  if (sub.token === "") return false; // errNoTokenAfterSlash
  if (sub.rest !== "") return false; // errUnexpectedContentAfterMediaSubtype
  return true;
}

/**
 * mime.ParseMediaType. Returns:
 * - success: {mediatype, params (non-null), err:false}
 * - bad type (checkMediaTypeDisposition failed): {mediatype:"", params:null, err:true}
 * - bad params only: {mediatype, params:null, err:true} (ErrInvalidMediaParameter)
 * - duplicate params: {mediatype:"", params:null, err:true}
 */
function parseMediaType(v: string): MediaTypeResult {
  const semi = v.indexOf(";");
  const base = semi < 0 ? v : v.slice(0, semi);
  const mediatype = trimSpaceFull(base.toLowerCase());

  if (!checkMediaTypeDisposition(mediatype)) {
    return { mediatype: "", params: null, err: true };
  }

  const params: Record<string, string> = Object.create(null);
  // base param name → param name → value, for names containing '*'.
  let continuation: Map<string, Map<string, string>> | null = null;

  let rest = v.slice(base.length);
  while (rest.length > 0) {
    rest = trimLeftSpace(rest);
    if (rest.length === 0) break;
    const { param, value, rest: after } = consumeMediaParam(rest);
    if (param === "") {
      if (trimSpaceFull(after) === ";") break; // trailing semicolon — not an error
      return { mediatype, params: null, err: true }; // ErrInvalidMediaParameter
    }

    let pmap: Map<string, string> | Record<string, string> = params;
    const star = param.indexOf("*");
    if (star >= 0) {
      const baseName = param.slice(0, star);
      if (continuation === null) continuation = new Map();
      let m = continuation.get(baseName);
      if (!m) {
        m = new Map();
        continuation.set(baseName, m);
      }
      pmap = m;
    }
    const existing = pmap instanceof Map ? pmap.get(param) : pmap[param];
    if (existing !== undefined && existing !== value) {
      return { mediatype: "", params: null, err: true }; // errDuplicateParamName
    }
    if (pmap instanceof Map) pmap.set(param, value);
    else pmap[param] = value;
    rest = after;
  }

  // Stitch RFC 2231 continuations.
  if (continuation !== null) {
    for (const [key, pieceMap] of continuation) {
      const singlePartKey = key + "*";
      const single = pieceMap.get(singlePartKey);
      if (single !== undefined) {
        const dec = decode2231Enc(single);
        if (dec.ok) params[key] = dec.out;
        continue;
      }
      let buf = "";
      let valid = false;
      for (let n = 0; ; n++) {
        const simplePart = `${key}*${n}`;
        const simple = pieceMap.get(simplePart);
        if (simple !== undefined) {
          valid = true;
          buf += simple;
          continue;
        }
        const encoded = pieceMap.get(simplePart + "*");
        if (encoded === undefined) break;
        valid = true;
        if (n === 0) {
          const dec = decode2231Enc(encoded);
          if (dec.ok) buf += dec.out;
        } else {
          const dec = percentHexUnescape(encoded);
          buf += dec.out; // Go ignores the ok flag here
        }
      }
      if (valid) params[key] = buf;
    }
  }

  return { mediatype, params, err: false };
}


// -------- RFC 2047 in parameter values: core's encodedword.ts --------
//
// go-message decodes a parameter's encoded words with Go's WordDecoder over
// bytes, knowing only utf-8, iso-8859-1 and us-ascii: any other charset keeps
// the whole RAW value, a malformed word passes through as written, and
// adjacent words join their bytes. The header test's decoder (TextDecoder,
// word by word) gives other bytes for most such values, and a boundary that
// decodes differently is a part one of them does not see.

type ErrKind = null | "invalid" | "charset";

/** Go utf8.EncodeRune → byte string (used where Go WriteRune()s into a builder). */
function encodeRune(r: number): string {
  if (r < 0 || (r >= 0xd800 && r <= 0xdfff) || r > 0x10ffff) r = RUNE_ERROR;
  if (r < 0x80) return String.fromCharCode(r);
  if (r < 0x800) return String.fromCharCode(0xc0 | (r >> 6), 0x80 | (r & 0x3f));
  if (r < 0x10000) {
    return String.fromCharCode(0xe0 | (r >> 12), 0x80 | ((r >> 6) & 0x3f), 0x80 | (r & 0x3f));
  }
  return String.fromCharCode(
    0xf0 | (r >> 18),
    0x80 | ((r >> 12) & 0x3f),
    0x80 | ((r >> 6) & 0x3f),
    0x80 | (r & 0x3f),
  );
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64Index = new Map<number, number>();
for (let i = 0; i < B64_ALPHABET.length; i++) b64Index.set(B64_ALPHABET.charCodeAt(i), i);

/** Go base64.StdEncoding.DecodeString: strict, but \r and \n are skipped. */
function base64Decode(s: string): string | null {
  let cleaned = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\r" || c === "\n") continue;
    // Fail FAST on a character no quantum can hold. Every such input is
    // refused by the quantum loop below anyway (the result is identical), but
    // only after this loop has copied the whole text — and the header decoder
    // hands this function a text that runs to the NEXT `?=`, however far away,
    // once per candidate word, which made a run of `=?x?B?` candidates O(n²).
    if (c !== "=" && !b64Index.has(c.charCodeAt(0))) return null;
    cleaned += c;
  }
  if (cleaned.length % 4 !== 0) return null;
  let out = "";
  for (let i = 0; i < cleaned.length; i += 4) {
    const quad = cleaned.slice(i, i + 4);
    const last = i + 4 >= cleaned.length;
    let pads = 0;
    if (quad[3] === "=") {
      pads = quad[2] === "=" ? 2 : 1;
      if (!last) return null; // padding only in the final quantum
    }
    const vals: number[] = [];
    for (let j = 0; j < 4 - pads; j++) {
      const v = b64Index.get(quad.charCodeAt(j));
      if (v === undefined) return null;
      vals.push(v);
    }
    if (pads === 2) {
      out += String.fromCharCode((vals[0]! << 2) | (vals[1]! >> 4));
    } else if (pads === 1) {
      out += String.fromCharCode((vals[0]! << 2) | (vals[1]! >> 4), ((vals[1]! & 0xf) << 4) | (vals[2]! >> 2));
    } else {
      out += String.fromCharCode(
        (vals[0]! << 2) | (vals[1]! >> 4),
        ((vals[1]! & 0xf) << 4) | (vals[2]! >> 2),
        ((vals[2]! & 0x3) << 6) | vals[3]!,
      );
    }
  }
  return out;
}

function fromHex(b: number): number | null {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10; // accept badly encoded bytes
  return null;
}

/** Go qDecode. */
function qDecode(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5f /* _ */) {
      out += " ";
    } else if (c === 0x3d /* = */) {
      if (i + 2 >= s.length) return null;
      const hb = fromHex(s.charCodeAt(i + 1));
      const lb = fromHex(s.charCodeAt(i + 2));
      if (hb === null || lb === null) return null;
      out += String.fromCharCode((hb << 4) | lb);
      i += 2;
    } else if ((c <= 0x7e && c >= 0x20) || c === 0x0a || c === 0x0d || c === 0x09) {
      out += s[i];
    } else {
      return null;
    }
  }
  return out;
}

function decodeContent(encoding: string, text: string): string | null {
  switch (encoding) {
    case "B":
    case "b":
      return base64Decode(text);
    case "Q":
    case "q":
      return qDecode(text);
    default:
      return null;
  }
}

/**
 * WordDecoder.convert with a nil user CharsetReader: the native trio decodes,
 * everything else is a charset error.
 */
function convert(charset: string, content: string): { out: string; charsetErr: boolean } {
  const cs = charset.toLowerCase();
  if (cs === "utf-8") return { out: content, charsetErr: false };
  if (cs === "iso-8859-1") {
    let out = "";
    for (let i = 0; i < content.length; i++) out += encodeRune(content.charCodeAt(i));
    return { out, charsetErr: false };
  }
  if (cs === "us-ascii") {
    let out = "";
    for (let i = 0; i < content.length; i++) {
      const c = content.charCodeAt(i);
      out += c >= 0x80 ? encodeRune(RUNE_ERROR) : content[i];
    }
    return { out, charsetErr: false };
  }
  return { out: "", charsetErr: true };
}

function hasNonWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    switch (s[i]) {
      case " ":
      case "\t":
      case "\n":
      case "\r":
        break;
      default:
        return true;
    }
  }
  return false;
}

/**
 * Go WordDecoder.DecodeHeader: decodes every encoded-word in the value.
 * Returns err=true if and only if a charset conversion failed (the only
 * DecodeHeader error path) — at which point the caller keeps the raw value.
 */
function decodeHeaderRFC2047(input: string): { value: string; err: boolean } {
  const first = input.indexOf("=?");
  if (first === -1) return { value: input, err: false };

  // Go walks a shrinking `header` slice; this walks ABSOLUTE offsets into the
  // one input (`pos` is where Go's `header` begins), which is the same
  // algorithm with one difference that matters: the position of the closing
  // `?=` is CACHED. A candidate that fails to decode advances only two
  // characters, and without the cache every such candidate re-scanned to the
  // same far-away `?=` — a header of n bytes made O(n²) work, on the
  // synchronous delivery path (Subject, every part's parameters, every
  // embedded message's headers), from bytes any sender chooses. The cache is
  // exact: `closeAt` is the first `?=` at or after some earlier `cur`, so while
  // it is still ≥ the current `cur` no earlier `?=` can exist in between.
  let buf = input.slice(0, first);
  let pos = first;
  let closeAt = -1;

  let betweenWords = false;
  for (;;) {
    const start = input.indexOf("=?", pos);
    if (start === -1) break;
    let cur = start + 2;

    const i = input.indexOf("?", cur);
    if (i === -1) break;
    const charset = input.slice(cur, i);
    cur = i + 1;

    if (input.length < cur + 4 /* "Q??=" */) break;
    const encoding = input[cur]!;
    cur++;

    if (input[cur] !== "?") break;
    cur++;

    if (closeAt < cur) closeAt = input.indexOf("?=", cur);
    const j = closeAt;
    if (j === -1) break;
    const text = input.slice(cur, j);
    const end = j + 2;

    const content = decodeContent(encoding, text);
    if (content === null) {
      betweenWords = false;
      buf += input.slice(pos, start + 2);
      pos = start + 2;
      continue;
    }

    // Whitespace separating two encoded-words is deleted.
    if (start > pos && (!betweenWords || hasNonWhitespace(input.slice(pos, start)))) {
      buf += input.slice(pos, start);
    }

    const conv = convert(charset, content);
    if (conv.charsetErr) return { value: "", err: true };
    buf += conv.out;

    pos = end;
    betweenWords = true;
  }

  if (pos < input.length) buf += input.slice(pos);
  return { value: buf, err: false };
}

/**
 * go-message decodeHeader: DecodeHeader, but on (charset) error the RAW input
 * is returned. Used for Subject, Content-Type/Disposition param values, etc.
 */
function decodeHeaderShim(s: string): { value: string } {
  const res = decodeHeaderRFC2047(s);
  if (res.err) return { value: s };
  return { value: res.value };
}

/**
 * A header value a host gave as text (Message.headerGet), as the bytes the
 * walker reads: its UTF-8. A part's header is read from the raw body and is
 * already bytes; the root's comes from the host, decoded, and a boundary
 * matched against the raw body has to be its bytes again.
 */
export function hostValueBytes(v: string): string {
  if (!/[^\x00-\x7f]/.test(v)) return v;
  let out = "";
  for (const b of new TextEncoder().encode(v)) out += String.fromCharCode(b);
  return out;
}

type RootField = "content-type" | "content-transfer-encoding";
interface RootFieldBytes {
  bytes: string | undefined;
  raw: boolean;
}
const rootFields = new WeakMap<import("./runtime.js").Message, Map<RootField, RootFieldBytes>>();

/** A raw root field, when supplied, owns both its bytes and its absence.
 * Cache the immutable field, including authoritative absence, rather than a
 * caller's fallback: body and MIME readers use different defaults. Keeping
 * its byte view also avoids rebuilding and hashing a large UTF-8 string on
 * every lookup of an already-parsed type.
 * Re-encoding a binary string would corrupt Latin-1 and UTF-8 boundaries. */
export function rootHeaderBytes(
  msg: import("./runtime.js").Message,
  key: RootField,
  fallback = "",
): string {
  let fields = rootFields.get(msg);
  let field = fields?.get(key);
  if (field === undefined) {
    const raw = msg.mimeHeaderGet?.(key);
    let bytes: string | undefined;
    if (raw === undefined) {
      const text = msg.headerGet(key)[0];
      bytes = text === undefined ? undefined : hostValueBytes(text);
    } else {
      bytes = raw[0];
    }
    field = { bytes, raw: raw !== undefined };
    if (fields === undefined) rootFields.set(msg, (fields = new Map()));
    fields.set(key, field);
  }
  return field.bytes ?? (field.raw ? fallback : hostValueBytes(fallback));
}

/**
 * A part's Content-Type as core's walker reads it (go-message's
 * parseHeaderWithParams, then the walker's contentType): "" is text/plain; a
 * type that does not parse falls back to the RAW value with no parameters, and
 * one whose parameters do not parse keeps its type without them. `primary` is
 * the media type up to its "/", the whole of it without one: "multipart"
 * there is a multipart, a bare "multipart" included.
 */
export function contentType(value: string): { mediaType: string; primary: string; params: Record<string, string> } {
  if (value === "") return { mediaType: "text/plain", primary: "text", params: {} };
  const res = parseMediaType(value);
  let mediaType = res.mediatype;
  let params = res.params;
  if (res.err && mediaType === "") {
    mediaType = value;
    params = null;
  }
  const decoded: Record<string, string> = {};
  if (params) for (const k of Object.keys(params)) decoded[k] = decodeHeaderShim(params[k]!).value;
  const slash = mediaType.indexOf("/");
  return { mediaType, primary: slash < 0 ? mediaType : mediaType.slice(0, slash), params: decoded };
}

/** A text header's parameters as Core exposes them to clients: parse and
 * decode over bytes, then convert to Unicode using Go's per-invalid-byte
 * replacement. A malformed parameter list contributes no parameters (#82).
 * The type/disposition fallback itself is immaterial to a :param test. */
export function contentParams(value: string): Map<string, string> {
  const { params } = parseMediaType(hostValueBytes(value));
  const out = new Map<string, string>();
  if (params === null) return out;
  for (const [name, raw] of Object.entries(params)) {
    const bytes = decodeHeaderShim(raw).value;
    let text = "";
    for (let i = 0; i < bytes.length; ) {
      const { r, size } = decodeRune(bytes, i);
      text += String.fromCodePoint(r);
      i += size;
    }
    out.set(name, text);
  }
  return out;
}
