// Media types and their parameters, read as core reads them.
//
// core's MIME walker (src/lib/mimewalk in core, a port of go-message) is what
// the user's mail client sees. A part the engine splits differently from it
// is a part an attachment rule cannot see while the user can (ts-sieve #56):
// the engine split on every ";", took no RFC 2231 continuations, and read a
// quoted-pair or an encoded word literally. This is core's mediatype.ts, a
// port of Go's mime.ParseMediaType, with go-message's fallback (contentType).
// Values are binary strings: a byte per character, as the walker reads them.

import { decodeHeaderValue } from "./header.js";

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


/** A param value's RFC 2047 encoded words decoded (go-message's
 * decodeHeader), as a binary string; the raw value when nothing decodes. */
function decodeParam(v: string): string {
  if (!v.includes("=?")) return v;
  const decoded = decodeHeaderValue(v);
  if (decoded === v) return v;
  let out = "";
  for (const b of new TextEncoder().encode(decoded)) out += String.fromCharCode(b);
  return out;
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
  if (params) for (const k of Object.keys(params)) decoded[k] = decodeParam(params[k]!);
  const slash = mediaType.indexOf("/");
  return { mediaType, primary: slash < 0 ? mediaType : mediaType.slice(0, slash), params: decoded };
}
