// Token types + positions.
//
// Tokens are modelled as a discriminated union on `kind`. Every token carries
// its 1-based source position (line, col); `line === 0 && col === 0` means
// "position suppressed" (the NoPosition option).

export type Quantifier = "none" | "K" | "M" | "G";

export function multiplier(q: Quantifier): number {
  switch (q) {
    case "none":
      return 1;
    case "K":
      return 1024;
    case "M":
      return 1024 * 1024;
    case "G":
      return 1024 * 1024 * 1024;
  }
}

export interface Position {
  line: number;
  col: number;
}

export interface IdentifierToken extends Position {
  kind: "identifier";
  text: string;
}
export interface NumberToken extends Position {
  kind: "number";
  value: number;
  quantifier: Quantifier;
}
export interface StringToken extends Position {
  kind: "string";
  text: string;
}
export interface SimpleToken extends Position {
  kind:
    | "listStart"
    | "listEnd"
    | "blockStart"
    | "blockEnd"
    | "testListStart"
    | "testListEnd"
    | "comma"
    | "semicolon"
    | "colon";
}

export type Token = IdentifierToken | NumberToken | StringToken | SimpleToken;

/**
 * RFC 5228 identifier grammar: `(ALPHA / "_") *(ALPHA / DIGIT / "_")`.
 * Used by the interpreter for variable names.
 */
export function isValidIdentifier(s: string): boolean {
  if (s.length === 0) return false;
  const first = s.charCodeAt(0);
  const isAlpha = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  const isDigit = (c: number) => c >= 48 && c <= 57;
  if (!isAlpha(first) && first !== 95 /* _ */) return false;
  for (let i = 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!isAlpha(c) && !isDigit(c) && c !== 95 /* _ */) return false;
  }
  return true;
}
