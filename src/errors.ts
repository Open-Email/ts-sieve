/**
 * All lexer/parser/loader failures surface as a SieveError. When a line/col is
 * known it is carried so callers can report `line:col: message` at
 * script-upload time.
 */
export class SieveError extends Error {
  readonly line: number | undefined;
  readonly col: number | undefined;

  constructor(message: string, pos?: { line: number; col: number }) {
    super(pos && pos.line !== 0 && pos.col !== 0 ? `${pos.line}:${pos.col}: ${message}` : message);
    this.name = "SieveError";
    this.line = pos?.line;
    this.col = pos?.col;
  }
}

