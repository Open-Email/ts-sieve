// Header access with virtual edits, plus RFC 2047 decoding so comparisons
// run on the text Core exposes (RFC 5228 §2.7.2).

import { headerUncertain } from "./uncertainty.js";
import { applyHeaderEditsToValues } from "./editheader.js";
import { decodeHeaderText } from "./mediatype.js";
import type { RuntimeData } from "./runtime.js";

export function getHeader(d: RuntimeData, field: string): string[] {
  if (headerUncertain(d, field)) d.testDoubt = true;
  return applyHeaderEditsToValues(d, field, d.msg.headerGet(field));
}

/**
 * Unfold, then decode as Core's MIME walker does: malformed words stay raw
 * and decoding resumes inside them; an unframable marker stops the search;
 * an unsupported charset keeps the whole unfolded value raw. Byte fragments
 * from adjacent words are joined before conversion to Unicode (#75).
 */
export function decodeHeaderValue(raw: string): string {
  if (/[\r\n]/.test(raw)) raw = raw.replace(/[\r\n]/g, "");
  if (!raw.includes("=?")) return raw;
  return decodeHeaderText(raw);
}
