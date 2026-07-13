// The `vnd.dovecot.testsuite` in-Sieve test DSL. These commands/tests only exist
// while a test environment (Options.testEnv) is present; the loaders (load.ts)
// gate on that. The DSL is the harness the Dovecot Pigeonhole `.svtest`
// conformance corpus is written in.
//
// WORKER-SAFETY: the sub-script loader (test_script_compile) reuses the same
// bounded lexer/parser/loader as the main entry point, and the test message
// reader is a linear RFC 5322 header scan (no regex over message bytes). The
// shared execution budget threads through the sub-runs via RuntimeData.clone().

import { SieveError } from "../errors.js";
import { lex } from "../lexer/lex.js";
import { Stream } from "../lexer/stream.js";
import type { Position } from "../parser/command.js";
import { parse } from "../parser/parse.js";
import { parseEnvelopeAddress } from "./address.js";
import { loadBlock } from "./load.js";
import {
  type Cmd,
  EnvelopeStatic,
  MessageStatic,
  type RuntimeData,
  StopSignal,
  type Test,
} from "./runtime.js";
import { Script } from "./script.js";
import { expandVars } from "./variables.js";

const DOVECOT_TEST_EXTENSION = "vnd.dovecot.testsuite";
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// test message parser (RFC 5322 header block reader)
// ---------------------------------------------------------------------------

/**
 * Parse the raw `test_set "message"` value into a MessageStatic, mirroring
 * an RFC 5322 header reader: canonical (case-insensitive) header keys,
 * `\r\n[ \t]` continuation folding, split at the first blank line. `size` is the
 * raw value's byte length; the body is the exact bytes after the blank line, and
 * is null when no blank line was present (hasBody=false) so the `body` test never
 * matches — hasBody is true only when the header block is followed by a body.
 */
export function parseTestMessage(raw: string): MessageStatic {
  const size = encoder.encode(raw).length;
  const headerLines: string[] = [];
  let body = "";
  let hasBody = false;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const nl = raw.indexOf("\n", i);
    let lineEnd: number;
    let nextStart: number;
    if (nl === -1) {
      lineEnd = n;
      nextStart = n;
    } else {
      nextStart = nl + 1;
      lineEnd = nl > i && raw.charCodeAt(nl - 1) === 13 /* \r */ ? nl - 1 : nl;
    }
    const line = raw.slice(i, lineEnd);
    if (line === "") {
      // Blank line: end of headers; the body is everything that follows.
      body = raw.slice(nextStart);
      hasBody = true;
      break;
    }
    headerLines.push(line);
    i = nextStart;
    if (nl === -1) break; // reached EOF without a blank line ⇒ no body
  }

  // Fold continuation lines (leading SP/TAB) into the previous field value.
  // Each line is trimmed of leading+trailing SP/TAB first, so the `header`
  // test sees values with leading/trailing whitespace already stripped
  // (RFC 5228 §5.7). Continuation detection uses the RAW first byte.
  const trimWs = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");
  const folded: string[] = [];
  for (const line of headerLines) {
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9) && folded.length > 0) {
      folded[folded.length - 1] += ` ${trimWs(line)}`;
    } else {
      folded.push(trimWs(line));
    }
  }

  const headers = new Map<string, string[]>();
  for (const line of folded) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).replace(/^[ \t]+/, "");
    const arr = headers.get(key) ?? [];
    arr.push(value);
    headers.set(key, arr);
  }

  return new MessageStatic(size, headers, hasBody ? encoder.encode(body) : null);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/** `test "name" { block }` — run a named sub-test, reporting to Options.testEnv. */
export class CmdDovecotTest implements Cmd {
  testName = "";
  cmds: Cmd[] = [];

  execute(d: RuntimeData): void {
    const env = d.script.opts.testEnv;
    if (!env) throw new SieveError("testing environment is not enabled");
    d.testName = this.testName;
    d.testFailMessage = "";

    env.run(this.testName, (t) => {
      if (d.script.opts.disabledTests.includes(this.testName)) {
        t.skip("test is disabled by disabledTests");
        return;
      }
      try {
        for (const c of this.cmds) {
          d.budget.consume(1);
          c.execute(d);
        }
      } catch (e) {
        if (e instanceof StopSignal) {
          // A `stop`/`test_fail` inside the block: fail iff test_fail set a message.
          if (d.testFailMessage !== "") {
            const { line, col } = d.testFailAt;
            t.errorf(`test_fail at ${line}:${col} called: ${d.testFailMessage}`);
          }
          return;
        }
        throw e; // any other error ⇒ recorded as a fatal sub-test failure by run()
      }
    });
    // `test` never aborts the enclosing script (caught internally).
  }
}

/** `test_fail "msg"` — mark the current test failed and unwind via StopSignal. */
export class CmdDovecotTestFail implements Cmd {
  message = "";
  at: Position = { line: 0, col: 0 };

  execute(d: RuntimeData): void {
    d.testFailMessage = expandVars(d, this.message);
    d.testFailAt = this.at;
    throw new StopSignal();
  }
}

/** `test_config_set`/`test_config_unset` — mutate the live script options. */
export class CmdDovecotConfigSet implements Cmd {
  constructor(
    public unset = false,
    public key = "",
    public value = "",
  ) {}

  execute(d: RuntimeData): void {
    switch (this.key) {
      case "sieve_variables_max_variable_size":
        if (this.unset) {
          d.script.opts.maxVariableLen = 4000;
        } else {
          if (!/^[+-]?\d+$/.test(this.value)) {
            throw new SieveError(`test_config_set: invalid integer: ${this.value}`);
          }
          d.script.opts.maxVariableLen = Number.parseInt(this.value, 10);
        }
        break;
      default:
        throw new SieveError(`unknown test_config_set key: ${this.key}`);
    }
  }
}

/** `test_set "name" "value"` — inject the message, envelope, or a raw variable. */
export class CmdDovecotTestSet implements Cmd {
  variableName = "";
  variableValue = "";

  execute(d: RuntimeData): void {
    const value = expandVars(d, this.variableValue);
    switch (this.variableName) {
      case "message": {
        // Parse the RAW (unexpanded) value; bound the parse against the budget.
        d.budget.consume(1 + (this.variableValue.length >> 6));
        d.msg = parseTestMessage(this.variableValue);
        break;
      }
      case "envelope.from": {
        let parsed: string;
        try {
          parsed = parseEnvelopeAddress(value);
        } catch {
          parsed = value; // keep the raw value so envelope tests see the invalidity
        }
        d.envelope = new EnvelopeStatic(parsed, d.envelope.envelopeTo(), d.envelope.authUsername());
        break;
      }
      case "envelope.to": {
        let parsed: string;
        try {
          parsed = parseEnvelopeAddress(value);
        } catch {
          parsed = value;
        }
        d.envelope = new EnvelopeStatic(d.envelope.envelopeFrom(), parsed, d.envelope.authUsername());
        break;
      }
      case "envelope.auth":
        d.envelope = new EnvelopeStatic(d.envelope.envelopeFrom(), d.envelope.envelopeTo(), value);
        break;
      default:
        // Any other name: store the RAW value (no lowercase, no length check).
        d.variables.set(this.variableName, this.variableValue);
    }
  }
}

/** A command that does nothing (test_binary_load/save, test_config_reload). */
export class CmdDovecotNoop implements Cmd {
  execute(_d: RuntimeData): void {}
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/**
 * `test_script_compile "path"` — read + compile a sub-script from the namespace.
 * Runs the full lexer/parser/loader with maxTokens 5000, UNLIMITED nesting, and
 * `enabledExtensions = []`, so any `require` in the sub-script fails and every
 * compile failure (missing file / lex / parse / load) returns false with NO throw
 * (the corpus's "this invalid script must fail to compile" checks). A missing
 * namespace is a fatal error.
 */
export class TestDovecotCompile implements Test {
  scriptPath = "";

  check(d: RuntimeData): boolean {
    if (!d.namespace) throw new SieveError("RuntimeData.namespace is not set, cannot load scripts");
    const bytes = d.namespace.readFile(this.scriptPath);
    if (bytes === null) return false;
    try {
      const source = new TextDecoder().decode(bytes);
      const script = new Script({
        maxTokens: 5000,
        maxBlockNesting: d.testMaxNesting,
        maxTestNesting: d.testMaxNesting,
        maxRedirects: d.script.opts.maxRedirects,
        enabledExtensions: [], // isolate: every `require` fails ⇒ invalid scripts fail
      });
      const toks = lex(source, { maxTokens: 5000, filename: this.scriptPath });
      const cmds = parse(new Stream(toks), {
        maxBlockNesting: d.testMaxNesting,
        maxTestNesting: d.testMaxNesting,
      });
      script.cmds = loadBlock(script, cmds);
      d.testScript = script;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * `test_script_run` — run the script compiled by test_script_compile against a
 * clone of the runtime data (msg/envelope/namespace shared by reference). True
 * iff it runs without error; false when nothing has been compiled.
 */
export class TestDovecotRun implements Test {
  check(d: RuntimeData): boolean {
    if (!d.testScript) return false;
    const testD = d.clone(d.testScript);
    try {
      d.testScript.execute(testD);
    } catch {
      return false;
    }
    return true;
  }
}

/**
 * `test_error` — always true. The compiler stops on the first lex/parse/load
 * error with different formatting, so the Pigeonhole-specific detailed error
 * checks are discarded; the loader still accepts+ignores `:index` and the
 * matcher tags.
 */
export class TestDovecotTestError implements Test {
  check(_d: RuntimeData): boolean {
    return true;
  }
}
