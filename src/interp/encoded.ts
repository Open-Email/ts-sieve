// decodeEncodedChars — RFC 5228 §2.4.2.4 encoded-character extension. Decodes
// ${hex:..} / ${unicode:..} in string arguments at LOAD time (before ${var}
// runtime expansion). Load-time only and bounded by script size, so a small
// scanner is fine (no per-message ReDoS path).

import { SieveError } from "../errors.js";

const WS = /[ \t\r\n]+/;

/** Decode ${hex:..} and ${unicode:..} sequences; leave everything else literal. */
export function decodeEncodedChars(s: string): string {
  if (!s.includes("${")) return s;
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.startsWith("${", i)) {
      const close = s.indexOf("}", i + 2);
      if (close !== -1) {
        const inner = s.slice(i + 2, close);
        const lower = inner.toLowerCase();
        if (lower.startsWith("hex:")) {
          const parts = inner.slice(4).trim().split(WS).filter(Boolean);
          if (parts.length > 0 && parts.every((h) => /^[0-9a-fA-F]{1,2}$/.test(h))) {
            const bytes = parts.map((h) => Number.parseInt(h, 16));
            out += new TextDecoder().decode(Uint8Array.from(bytes));
            i = close + 1;
            continue;
          }
        } else if (lower.startsWith("unicode:")) {
          const parts = inner.slice(8).trim().split(WS).filter(Boolean);
          if (parts.length > 0 && parts.every((c) => /^[0-9a-fA-F]+$/.test(c))) {
            let str = "";
            for (const c of parts) {
              const v = Number.parseInt(c, 16);
              // RFC 5228 §2.4.2.4: 0–D7FF or E000–10FFFF (surrogates excluded).
              if (!((v >= 0 && v <= 0xd7ff) || (v >= 0xe000 && v <= 0x10ffff))) {
                throw new SieveError("encoded unicode keypoint is out of range");
              }
              str += String.fromCodePoint(v);
            }
            out += str;
            i = close + 1;
            continue;
          }
        }
      }
    }
    out += s[i];
    i++;
  }
  return out;
}
