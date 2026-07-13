// A cursor over a token slice used by the parser.
//
// The cursor starts at -1 and pop() pre-increments, so the first pop() yields
// token[0]; last() returns the token at the current cursor.

import { SieveError } from "../errors.js";
import type { Token } from "./token.js";

export class Stream {
  private cursor = -1;
  private readonly toks: Token[];

  constructor(toks: Token[]) {
    this.toks = toks;
  }

  last(): Token | null {
    if (this.cursor >= this.toks.length) return null;
    return this.cursor < 0 ? null : this.toks[this.cursor]!;
  }

  pop(): Token | null {
    this.cursor++;
    if (this.cursor >= this.toks.length) return null;
    return this.toks[this.cursor]!;
  }

  peek(): Token | null {
    const cur = this.cursor + 1;
    if (cur >= this.toks.length) return null;
    return this.toks[cur]!;
  }

  /** Build a positioned error anchored at the current token. */
  err(message: string): SieveError {
    const last = this.last();
    if (last === null) return new SieveError(message);
    return new SieveError(message, { line: last.line, col: last.col });
  }
}
