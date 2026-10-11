// Options/Load entry points + Script.Execute.
// The single public entry point: load() lexes → parses → loads (require-gates)
// a script; Script.execute() runs it against a RuntimeData.

import { lex } from "../lexer/lex.js";
import { Stream } from "../lexer/stream.js";
import { parse } from "../parser/parse.js";
import { checkExtensionDependencies, loadBlock } from "./load.js";
import { checkRejectConflicts } from "./reject.js";
import { type Cmd, type RuntimeData, StopSignal, type TestEnv } from "./runtime.js";

export interface Options {
  /** Lexer: hard cap on token count (default 5000). */
  maxTokens?: number;
  /** Parser: max block nesting (default 15). */
  maxBlockNesting?: number;
  /** Parser: max test nesting (default 15). */
  maxTestNesting?: number;
  /** Interp: max distinct redirect addresses per message (default 5). A
   * redirect past it is dropped and sets indeterminate. */
  maxRedirects?: number;
  /** Interp: max distinct fileinto targets per message (default 32, the
   * default of Pigeonhole's sieve_max_actions, which counts every action and
   * fails the script past it; 0 allows none). A fileinto past it is dropped
   * and sets indeterminate: inside a foreverypart loop the message decides how
   * many targets a script files into. */
  maxFileintos?: number;
  maxVariableCount?: number;
  maxVariableNameLen?: number;
  maxVariableLen?: number;
  /** Cut a `:matches`/`:regex` input to this many UTF-8 bytes (0 = the engine's
   * default, 256 KiB). A comparison over a cut input is three-valued. Also the
   * octets extracttext decodes from a part. */
  maxMatchInputLength?: number;
  /**
   * RFC 5429 §2.4 conflicts (a second reject, a reject beside keep, fileinto,
   * redirect or vacation) throw, as in Pigeonhole (default false: a second
   * reject is not executed, and a conflict sets indeterminate). A throw fails
   * the whole script, and the message picks the branches that reach one.
   */
  strictReject?: boolean;
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
    maxFileintos: 32,
    strictReject: false,
    maxVariableCount: 128,
    maxVariableNameLen: 63, // Pigeonhole's limit; RFC 5229 asks for at least 32
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
  /** Commands at every nesting level: what dispatch can cost at most, kept
   * back from tests (see withShare). */
  commandCount = 0;
  /** Tests and deleteheader commands, numbered in script order: each spends a
   * share of the step budget (see withShare). */
  budgetedCount = 0;
  /** Load time: the names of the foreverypart loops being loaded, outermost
   * first ("" for an unnamed one), for break and the nesting cap. */
  loops: string[] = [];

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
      if (!(e instanceof StopSignal)) throw e;
    }
    // A testsuite script checks each `test` block instead, so a conflict is
    // reported against the block it happens in.
    if (!this.requiresExtension("vnd.dovecot.testsuite")) checkRejectConflicts(d);
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
  checkExtensionDependencies(script);
  return script;
}
