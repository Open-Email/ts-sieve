// Options/Load entry points + Script.Execute.
// The single public entry point: load() lexes → parses → loads (require-gates)
// a script; Script.execute() runs it against a RuntimeData.

import { lex } from "../lexer/lex.js";
import { Stream } from "../lexer/stream.js";
import { parse } from "../parser/parse.js";
import { loadBlock } from "./load.js";
import { type Cmd, type RuntimeData, StopSignal, type TestEnv } from "./runtime.js";

export interface Options {
  /** Lexer: hard cap on token count (default 5000). */
  maxTokens?: number;
  /** Parser: max block nesting (default 15). */
  maxBlockNesting?: number;
  /** Parser: max test nesting (default 15). */
  maxTestNesting?: number;
  /** Interp: max redirect actions per message (default 5). */
  maxRedirects?: number;
  maxVariableCount?: number;
  maxVariableNameLen?: number;
  maxVariableLen?: number;
  /** Truncate a matched value to this many chars before `:matches` (0 = no cap). */
  maxMatchInputLength?: number;
  /**
   * Cooperative CPU budget: total interpreter "steps" (command dispatch, match
   * keys, regex-VM inner-loop units) before execution aborts with an error.
   * 0 = unlimited. Set a finite value in constrained runtimes (Cloudflare
   * Workers) to guarantee bounded per-message CPU.
   */
  maxExecSteps?: number;
  /**
   * Extensions this script may `require`. `null` means none are allowed (every
   * `require` fails). Names outside this list are rejected at load time.
   */
  enabledExtensions?: string[] | null;
  /**
   * The `vnd.dovecot.testsuite` reporter. When set, `require
   * "vnd.dovecot.testsuite"` is permitted (bypassing enabledExtensions) and the
   * in-Sieve test DSL is enabled; when null, the DSL commands/tests are absent.
   */
  testEnv?: TestEnv | null;
  /** `vnd.dovecot.testsuite`: `test "name"` blocks to skip by exact name. */
  disabledTests?: string[];
}

export function defaultOptions(): Required<Options> {
  return {
    maxTokens: 5000,
    maxBlockNesting: 15,
    maxTestNesting: 15,
    maxRedirects: 5,
    maxVariableCount: 128,
    maxVariableNameLen: 32,
    maxVariableLen: 4000,
    maxMatchInputLength: 0,
    maxExecSteps: 0,
    enabledExtensions: null,
    testEnv: null,
    disabledTests: [],
  };
}

export class Script {
  readonly extensions = new Set<string>();
  readonly enabledExtensions: string[] | null;
  readonly opts: Required<Options>;
  cmds: Cmd[] = [];

  constructor(opts: Options = {}) {
    this.opts = { ...defaultOptions(), ...opts };
    this.enabledExtensions = this.opts.enabledExtensions;
  }

  requiresExtension(name: string): boolean {
    return this.extensions.has(name);
  }

  /** Extensions the script actually `require`d (and were enabled). */
  usedExtensions(): string[] {
    return [...this.extensions];
  }

  execute(d: RuntimeData): void {
    try {
      for (const c of this.cmds) {
        d.budget.consume(1);
        c.execute(d);
      }
    } catch (e) {
      if (e instanceof StopSignal) return;
      throw e;
    }
  }
}

/**
 * Lex, parse, and load a Sieve script. Throws SieveError on any lex/parse error,
 * on an unsupported or non-enabled `require`, or on a malformed command/test.
 */
export function load(source: string, opts: Options = {}): Script {
  const script = new Script(opts);
  const toks = lex(source, { maxTokens: script.opts.maxTokens });
  const cmds = parse(new Stream(toks), {
    maxBlockNesting: script.opts.maxBlockNesting,
    maxTestNesting: script.opts.maxTestNesting,
  });
  script.cmds = loadBlock(script, cmds);
  return script;
}
