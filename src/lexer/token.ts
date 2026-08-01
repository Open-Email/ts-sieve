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

