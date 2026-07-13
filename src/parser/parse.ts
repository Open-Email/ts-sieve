// Sieve parser — builds the AST from a token stream.
//
// A low-level recursive-descent parser that builds the AST with very little
// interpretation of values (numeric quantifiers are applied here; everything
// else is resolved by the interpreter's loader). Enforces nesting limits and
// follows a peek/pop discipline over the token stream.

import { multiplier, type Stream } from "../lexer/index.js";
import type { Arg, Cmd, Test } from "./command.js";

export interface Options {
  maxBlockNesting?: number;
  maxTestNesting?: number;
}

export function parse(stream: Stream, opts: Options = {}): Cmd[] {
  return parseBlock(stream, 0, opts);
}

function parseBlock(stream: Stream, nesting: number, opts: Options): Cmd[] {
  if (opts.maxBlockNesting && nesting > opts.maxBlockNesting) {
    throw stream.err("block nesting limit exceeded");
  }
  const res: Cmd[] = [];
  for (;;) {
    const idT = stream.pop();
    if (idT === null) return res;

    let id: string;
    let line: number;
    let col: number;
    if (idT.kind === "identifier") {
      id = idT.text;
      line = idT.line;
      col = idT.col;
    } else if (idT.kind === "blockEnd") {
      return res;
    } else {
      throw stream.err("reading command: expected an identifier or closing brace");
    }

    const { args, tests } = readArguments(stream, false, 0, opts);

    const cmdEnd = stream.pop();
    if (cmdEnd === null) throw stream.err("reading command: expected semicolon or block");

    let block: Cmd[] | null = null;
    if (cmdEnd.kind === "semicolon") {
      // ok
    } else if (cmdEnd.kind === "blockStart") {
      const cmds = parseBlock(stream, nesting + 1, opts);
      // EOF vs } check: after a valid block the closing '}' is the current token.
      if (stream.last() === null) throw stream.err("reading command: expected a closing brace");
      block = cmds;
    } else {
      throw stream.err("reading command: unexpected token");
    }

    res.push({ id, args, tests, block, line, col });
  }
}

function readArguments(
  s: Stream,
  forTest: boolean,
  nesting: number,
  opts: Options,
): { args: Arg[]; tests: Test[] } {
  if (opts.maxTestNesting && nesting > opts.maxTestNesting) {
    throw s.err("reading arguments: nesting limit exceeded");
  }
  const args: Arg[] = [];
  let tests: Test[] = [];

  for (;;) {
    const tok = s.peek();
    if (tok === null) {
      throw s.err("reading arguments: expected semicolon or arguments or block, got EOF");
    }
    switch (tok.kind) {
      case "semicolon":
      case "blockStart":
        return { args, tests };
      case "comma":
      case "testListEnd":
        if (!forTest) throw s.err("reading arguments: expected semicolon or arguments or block");
        return { args, tests };
      case "string":
        s.pop();
        args.push({ kind: "string", value: tok.text, line: tok.line, col: tok.col });
        break;
      case "listStart": {
        s.pop();
        const list = readStringList(s);
        args.push({ kind: "stringList", value: list, line: tok.line, col: tok.col });
        break;
      }
      case "number":
        s.pop();
        args.push({ kind: "number", value: tok.value * multiplier(tok.quantifier), line: tok.line, col: tok.col });
        break;
      case "colon": {
        s.pop(); // colon
        const idT = s.pop();
        if (idT === null) throw s.err("reading arguments: expected identifier, got EOF");
        if (idT.kind !== "identifier") throw s.err("reading arguments: expected identifier");
        args.push({ kind: "tag", value: idT.text, line: tok.line, col: tok.col });
        break;
      }
      case "identifier": {
        // A single test, at the end of arguments.
        s.pop();
        const inner = readArguments(s, true, nesting + 1, opts);
        tests.push({ id: tok.text, args: inner.args, tests: inner.tests, line: tok.line, col: tok.col });
        break;
      }
      case "testListStart":
        s.pop();
        tests = readTestList(s, nesting, opts);
        return { args, tests };
      default:
        throw s.err("reading arguments: expected semicolon or arguments or block");
    }
  }
}

function readTestList(s: Stream, nesting: number, opts: Options): Test[] {
  let needTest = true;
  const res: Test[] = [];
  for (;;) {
    const tok = s.pop();
    if (tok === null) throw s.err("reading test list: expected identifier, got EOF");
    switch (tok.kind) {
      case "identifier": {
        if (!needTest) throw s.err("reading test list: expected comma or closing brace, got identifier");
        const inner = readArguments(s, true, nesting + 1, opts);
        res.push({ id: tok.text, args: inner.args, tests: inner.tests, line: tok.line, col: tok.col });
        needTest = false;
        break;
      }
      case "comma":
        if (needTest) throw s.err("reading test list: expected identifier or list end, got comma");
        needTest = true;
        break;
      case "testListEnd":
        if (needTest) throw s.err("reading test list: expected identifier, got closing brace");
        return res;
      default:
        throw s.err("reading test list: expected identifier or comma or closing brace");
    }
  }
}

function readStringList(s: Stream): string[] {
  const res: string[] = [];
  let needString = true;
  for (;;) {
    const tok = s.pop();
    if (tok === null) throw s.err("reading string list: expected string or closing brace, got EOF");
    switch (tok.kind) {
      case "string":
        if (!needString) throw s.err("reading string list: expected comma or closing brace, got string");
        res.push(tok.text);
        needString = false;
        break;
      case "comma":
        if (needString) throw s.err("reading string list: expected string, got comma");
        needString = true;
        break;
      case "listEnd":
        return res;
      default:
        throw s.err("reading string list: expected string, comma or closing brace");
    }
  }
}
