// Sieve lexer — tokenises a script into a token stream.
//
// Handles position bookkeeping (1-based line/col, byte-counted), CRLF
// normalisation in strings, hash + block comments, the `text:` multi-line
// string form with dot-unstuffing, and the numeric quantifiers K/M/G. Operates
// over UTF-8 bytes so positions and string octets match exactly; token `text`
// is the UTF-8 decoding of the collected bytes.

import { SieveError } from "../errors.js";
import type { Quantifier, Token } from "./token.js";

export interface Options {
  filename?: string;
  noPosition?: boolean;
  maxTokens?: number;
}

interface LexerState {
  file: string;
  line: number;
  col: number;
}

const EOF = -1;
const decoder = new TextDecoder();

function bytesToString(bytes: number[]): string {
  return decoder.decode(Uint8Array.from(bytes));
}

/** Byte cursor over the source — supports readByte/unreadByte/peek/discard. */
class ByteReader {
  private readonly buf: Uint8Array;
  private i = 0;
  constructor(source: string) {
    this.buf = new TextEncoder().encode(source);
  }
  readByte(): number {
    return this.i < this.buf.length ? this.buf[this.i++]! : EOF;
  }
  unreadByte(): void {
    if (this.i > 0) this.i--;
  }
  peek(n: number): Uint8Array {
    return this.buf.subarray(this.i, this.i + n);
  }
  discard(n: number): void {
    this.i = Math.min(this.i + n, this.buf.length);
  }
}

const isAlpha = (b: number) => (b >= 97 && b <= 122) || (b >= 65 && b <= 90);
const isDigit = (b: number) => b >= 48 && b <= 57;

export function lex(source: string, opts: Options = {}): Token[] {
  return tokenStream(new ByteReader(source), opts);
}

function tokenStream(r: ByteReader, opts: Options): Token[] {
  const res: Token[] = [];
  const state: LexerState = { file: opts.filename ?? "", line: 1, col: 0 };

  for (;;) {
    const b = r.readByte();
    if (b === EOF) break;
    if (opts.noPosition) {
      state.line = 0;
      state.col = 0;
    } else {
      state.col++;
    }
    const line = state.line;
    const col = state.col;

    switch (b) {
      case 0:
        throw new SieveError("lexer: NUL is not allowed in input stream", { line, col });
      case 91: // [
        res.push({ kind: "listStart", line, col });
        break;
      case 93: // ]
        res.push({ kind: "listEnd", line, col });
        break;
      case 123: // {
        res.push({ kind: "blockStart", line, col });
        break;
      case 125: // }
        res.push({ kind: "blockEnd", line, col });
        break;
      case 40: // (
        res.push({ kind: "testListStart", line, col });
        break;
      case 41: // )
        res.push({ kind: "testListEnd", line, col });
        break;
      case 44: // ,
        res.push({ kind: "comma", line, col });
        break;
      case 58: // :
        res.push({ kind: "colon", line, col });
        break;
      case 59: // ;
        res.push({ kind: "semicolon", line, col });
        break;
      case 32: // space
      case 9: // tab
        continue;
      case 13: // \r
      case 10: // \n
        r.unreadByte();
        consumeCRLF(r, state);
        break;
      case 34: {
        // "
        const str = quotedString(r, state);
        res.push({ kind: "string", text: str, line, col });
        break;
      }
      case 35: // #
        hashComment(r, state);
        break;
      case 47: {
        // /
        const b2 = r.readByte();
        if (b2 === EOF) throw new SieveError("unexpected EOF", { line, col });
        state.col++;
        if (b2 !== 42 /* * */) throw new SieveError("unexpected forward slash", { line, col });
        multilineComment(r, state);
        break;
      }
      case 116: {
        // 't' — possibly the "text:" multi-line string marker
        const ext = r.peek(4);
        if (ext.length < 4) throw new SieveError("unexpected EOF", { line, col });
        if (ext[0] === 101 && ext[1] === 120 && ext[2] === 116 && ext[3] === 58 /* "ext:" */) {
          r.discard(4);
          state.col += 4;
          // Consume trailing whitespace + optional comment, up to end of line.
          wsLoop: for (;;) {
            const wb = r.readByte();
            if (wb === EOF) throw new SieveError("unexpected EOF", { line: state.line, col: state.col });
            state.col++;
            if (wb === 32 || wb === 9) continue;
            if (wb === 35) {
              hashComment(r, state);
              break wsLoop;
            }
            if (wb === 13 || wb === 10) {
              r.unreadByte();
              consumeCRLF(r, state);
              break wsLoop;
            }
            throw new SieveError(`unexpected character: ${wb}`, { line: state.line, col: state.col });
          }
          const ml = multilineString(r, state);
          res.push({ kind: "string", text: ml, line, col });
          continue;
        }
        // Not "text:" — an ordinary identifier starting with 't'.
        const str = identifier(r, "t", state);
        res.push({ kind: "identifier", text: str, line, col });
        break;
      }
      default: {
        if (isAlpha(b)) {
          const str = identifier(r, String.fromCharCode(b), state);
          res.push({ kind: "identifier", text: str, line, col });
        } else if (isDigit(b)) {
          const num = number(r, b, state);
          res.push({ kind: "number", value: num.value, quantifier: num.quantifier, line, col });
        } else {
          throw new SieveError(`unexpected character: ${b}`, { line, col });
        }
      }
    }

    if (opts.maxTokens && res.length > opts.maxTokens) {
      throw new SieveError("too many tokens", { line, col });
    }
  }

  return res;
}

function consumeCRLF(r: ByteReader, state: LexerState): void {
  const b = r.readByte();
  if (b === EOF) throw new SieveError("unexpected EOF");
  if (b === 13 /* \r */) {
    const b2 = r.readByte();
    if (b2 === EOF) throw new SieveError("unexpected EOF");
    if (b2 !== 10 /* \n */) throw new SieveError("CR is not followed by LF");
    state.line++;
    state.col = 0;
    return;
  }
  if (b === 10 /* \n */) {
    state.line++;
    state.col = 0;
    return;
  }
  throw new Error("consumeCRLF should not be called not on CR/LF");
}

function hashComment(r: ByteReader, state: LexerState): void {
  for (;;) {
    const b = r.readByte();
    if (b === EOF) break;
    state.col++;
    if (b === 13 || b === 10) {
      r.unreadByte();
      consumeCRLF(r, state);
      break;
    }
  }
}

function multilineComment(r: ByteReader, state: LexerState): void {
  let wasStar = false;
  for (;;) {
    const b = r.readByte();
    if (b === EOF) throw new SieveError("unexpected EOF");
    state.col++;
    if (b === 10) {
      state.line++;
      state.col = 0;
    }
    if (wasStar && b === 47 /* / */) return;
    wasStar = b === 42 /* * */;
  }
}

function quotedString(r: ByteReader, state: LexerState): string {
  const buf: number[] = [];
  let atBackslash = false;
  for (;;) {
    const b = r.readByte();
    if (b === EOF) throw new SieveError("unexpected EOF");
    state.col++;
    switch (b) {
      case 13:
      case 10:
        r.unreadByte();
        consumeCRLF(r, state);
        buf.push(13, 10);
        break;
      case 92: // backslash
        if (!atBackslash) {
          atBackslash = true;
          continue;
        }
        buf.push(92);
        break;
      case 34: // "
        if (!atBackslash) return bytesToString(buf);
        buf.push(34);
        break;
      default:
        buf.push(b);
        break;
    }
    atBackslash = false;
  }
}

/**
 * Multi-line string (`text:` form). Normalises LF→CRLF and applies dot-unstuffing:
 * a line consisting of a single "." terminates; a leading "." on a content line is
 * removed. Note: the first content line's leading dot is NOT unstuffed, because
 * atLF starts false.
 */
function multilineString(r: ByteReader, state: LexerState): string {
  let atLF = false;
  let atLFHadDot = false;
  const data: number[] = [];
  for (;;) {
    const b = r.readByte();
    if (b === EOF) throw new SieveError("unexpected EOF");
    state.col++;
    switch (b) {
      case 46: // .
        if (atLF) {
          atLFHadDot = true;
        } else {
          data.push(46);
          atLFHadDot = false;
        }
        atLF = false;
        break;
      case 13:
      case 10:
        r.unreadByte();
        consumeCRLF(r, state);
        if (atLFHadDot) return bytesToString(data);
        data.push(13, 10);
        atLF = true;
        break;
      default:
        if (atLFHadDot) data.push(46);
        atLF = false;
        atLFHadDot = false;
        data.push(b);
        break;
    }
  }
}

function identifier(r: ByteReader, startWith: string, state: LexerState): string {
  const chars: number[] = [];
  for (let i = 0; i < startWith.length; i++) chars.push(startWith.charCodeAt(i));
  for (;;) {
    const b = r.readByte();
    if (b === EOF) break;
    state.col++;
    if (isAlpha(b) || isDigit(b) || b === 95 /* _ */) {
      chars.push(b);
    } else {
      r.unreadByte();
      state.col--;
      break;
    }
  }
  return bytesToString(chars);
}

function number(
  r: ByteReader,
  startByte: number,
  state: LexerState,
): { value: number; quantifier: Quantifier } {
  const digits: number[] = [startByte];
  let q: Quantifier = "none";
  readLoop: for (;;) {
    const b = r.readByte();
    if (b === EOF) break;
    state.col++;
    switch (b) {
      case 75: // K
      case 71: // G
      case 77: // M
        q = String.fromCharCode(b) as Quantifier;
        break readLoop;
      case 107: // k
      case 103: // g
      case 109: // m
        q = String.fromCharCode(b - 32) as Quantifier;
        break readLoop;
    }
    if (isDigit(b)) {
      digits.push(b);
    } else {
      r.unreadByte();
      state.col--;
      break;
    }
  }
  const value = Number.parseInt(bytesToString(digits), 10);
  if (Number.isNaN(value)) throw new SieveError("invalid number");
  // Reject values that lose integer precision (overflow).
  if (!Number.isSafeInteger(value * multiplierFor(q))) throw new SieveError("number too large");
  return { value, quantifier: q };
}

function multiplierFor(q: Quantifier): number {
  return q === "K" ? 1024 : q === "M" ? 1024 * 1024 : q === "G" ? 1024 * 1024 * 1024 : 1;
}
