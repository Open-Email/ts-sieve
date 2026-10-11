// Header access + RFC 2047 decoding. With the `editheader` extension disabled in
// v1, header lookup is just Message.headerGet; decodeHeaderValue unfolds and
// decodes encoded-words so comparisons run on decoded text (RFC 5228 §2.7.2).

import { applyHeaderEditsToValues } from "./editheader.js";
import type { RuntimeData } from "./runtime.js";

export function getHeader(d: RuntimeData, field: string): string[] {
  return applyHeaderEditsToValues(d, field, d.msg.headerGet(field));
}

function qpToBytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") {
      bytes.push(0x20);
    } else if (c === "=" && i + 2 < text.length) {
      const hex = text.slice(i + 1, i + 3);
      // Both chars must be hex digits (parseInt would accept "4x" as 4).
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(c.charCodeAt(0));
      }
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return bytes;
}

function base64ToBytes(text: string): number[] {
  const bin = atob(text.replace(/\s+/g, ""));
  const out: number[] = [];
  for (let i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
  return out;
}

function decodeBytes(bytes: number[], charset: string): string {
  const arr = Uint8Array.from(bytes);
  // RFC 2231 allows a language suffix on the charset ("utf-8*en").
  const cs = charset.split("*")[0]!.toLowerCase();
  if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return new TextDecoder("utf-8").decode(arr);
  }
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252") {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
  // Unknown charset: best-effort UTF-8.
  return new TextDecoder("utf-8").decode(arr);
}

/**
 * Unfold a header value and decode RFC 2047 encoded-words to UTF-8. Each word
 * decodes on its own, as core's walker decodes them (Go's
 * WordDecoder.DecodeHeader, which is what the user's client shows): a word
 * that does not decode stays as its raw text, and the search for the next
 * word resumes inside it, two characters on, so its closing "=" may open the
 * next one. Decoding the value whole made one malformed word hide every other
 * word's text from a rule (#67).
 */
export function decodeHeaderValue(raw: string): string {
  if (/[\r\n]/.test(raw)) raw = raw.replace(/[\r\n]/g, "");
  if (!raw.includes("=?")) return raw;
  const word = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  let out = "";
  let pos = 0; // raw before pos is in out
  let afterWord = false; // out ends with a decoded word
  for (let m = word.exec(raw); m !== null; m = word.exec(raw)) {
    let decoded: string;
    try {
      decoded = decodeBytes(m[2]!.toUpperCase() === "B" ? base64ToBytes(m[3]!) : qpToBytes(m[3]!), m[1]!);
    } catch {
      word.lastIndex = m.index + 2;
      continue;
    }
    // Spaces and tabs separating two decoded words are dropped (RFC 2047
    // §6.2); any other text between them, a word that did not decode
    // included, is kept.
    const between = raw.slice(pos, m.index);
    if (!afterWord || /[^ \t]/.test(between)) out += between;
    out += decoded;
    pos = word.lastIndex;
    afterWord = true;
  }
  return out + raw.slice(pos);
}
