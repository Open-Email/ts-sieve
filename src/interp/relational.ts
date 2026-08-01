// RFC 5231 relational (:value / :count)
// comparison kernel. CompareString is byte-wise (UTF-8 lexicographic);
// CompareNumericValue backs both :value and :count and implements RFC 4790
// §9.1 infinity semantics (null = +infinity).

export const RELATIONAL_OPS = new Set<string>(["gt", "ge", "lt", "le", "eq", "ne"]);

const encoder = new TextEncoder();

function applyRel(rel: string, cmp: number): boolean {
  switch (rel) {
    case "gt":
      return cmp > 0;
    case "ge":
      return cmp >= 0;
    case "lt":
      return cmp < 0;
    case "le":
      return cmp <= 0;
    case "eq":
      return cmp === 0;
    case "ne":
      return cmp !== 0;
    default:
      return false;
  }
}

/** Byte-wise (UTF-8) lexicographic string comparison. */
function byteCompare(a: string, b: string): number {
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i++) {
    if (ea[i] !== eb[i]) return ea[i]! < eb[i]! ? -1 : 1;
  }
  return ea.length === eb.length ? 0 : ea.length < eb.length ? -1 : 1;
}

export function compareString(rel: string, a: string, b: string): boolean {
  return applyRel(rel, byteCompare(a, b));
}

/** RFC 4790 §9.1: null operand = +infinity (a non-numeric string). */
export function compareNumericValue(rel: string, a: bigint | null, b: bigint | null): boolean {
  let cmp: number;
  if (a === null && b === null) cmp = 0;
  else if (a === null) cmp = 1; // +inf > finite
  else if (b === null) cmp = -1; // finite < +inf
  else cmp = a < b ? -1 : a > b ? 1 : 0;
  return applyRel(rel, cmp);
}

/**
 * RFC 4790 §9.1.1 i;ascii-numeric preparation: the value is the longest prefix
 * of ASCII digits; a string that does not start with a digit is positive
 * infinity (null). So "5 apples" prepares to the numeric value 5.
 */
export function parseNumericPrefix(s: string): bigint | null {
  let end = 0;
  while (end < s.length) {
    const c = s.charCodeAt(end);
    if (c < 48 || c > 57) break;
    end++;
  }
  if (end === 0) return null;
  return BigInt(s.slice(0, end));
}
