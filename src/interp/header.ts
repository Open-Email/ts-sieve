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
 * Unfold a header value and decode RFC 2047 encoded-words to UTF-8. Values that
 * fail to decode are returned unfolded but otherwise unchanged.
 */
export function decodeHeaderValue(raw: string): string {
  if (/[\r\n]/.test(raw)) raw = raw.replace(/[\r\n]/g, "");
  if (!raw.includes("=?")) return raw;
  try {
    // Whitespace separating two adjacent encoded-words is removed (RFC 2047).
    const collapsed = raw.replace(/\?=\s+=\?/g, "?==?");
    return collapsed.replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_m, charset: string, enc: string, text: string) => {
        const bytes = enc.toUpperCase() === "B" ? base64ToBytes(text) : qpToBytes(text);
        return decodeBytes(bytes, charset);
      },
    );
  } catch {
    return raw;
  }
}
