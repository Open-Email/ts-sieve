// The injected runtime surface (envelope/message/policy) interfaces and the
// mutable execution state.
//
// The consumer implements Message/Envelope/PolicyReader; the interpreter never
// does I/O or MIME parsing itself. RuntimeData is the action accumulator the
// executor reads after Script.execute() returns.

import { SieveError } from "../errors.js";
import type { Position } from "../parser/command.js";
import type { HeaderEdit } from "./editheader.js";
import type { Script } from "./script.js";
import type { VacationResponse } from "./vacation.js";

/**
 * A cooperative execution budget: script work is bounded by counting steps
 * rather than wall-clock time, so execution stays deterministic and cannot be
 * preempted mid-run. The interpreter ticks this counter in its hot loops
 * (command dispatch, match keys, the regex VM's inner loop) and throws when it
 * is exhausted — a deterministic CPU cap for a Worker.
 */
class Budget {
  constructor(public remaining: number) {}
  consume(n = 1): void {
    this.remaining -= n;
    if (this.remaining < 0) throw new SieveError("sieve: script execution budget exceeded");
  }
}

export interface Envelope {
  envelopeFrom(): string;
  envelopeTo(): string;
  authUsername(): string;
}

export interface Message {
  /**
   * Header field values, in order. Per RFC 5228 §2.7.2 the interpreter compares
   * the DECODED (RFC 2047) header text; the consumer may return raw values and
   * the interpreter decodes, or return already-decoded values.
   */
  headerGet(key: string): string[];
  messageSize(): number;
  /** Raw body bytes; null when unavailable (the `body` test then never matches). */
  bodyRaw(): Uint8Array | null;
}

export interface PolicyReader {
  /** Gate (and optionally rate-limit) a redirect target. The default allows all. */
  redirectAllowed(d: RuntimeData, addr: string): boolean;
}

/** Optional host hook for the `mailbox` extension's `mailboxexists` test. */
export interface MailboxChecker {
  exists(mailbox: string): boolean;
}

/** Thrown by `stop`; caught by Script.execute to end evaluation normally. */
export class StopSignal {}

export interface Cmd {
  execute(d: RuntimeData): void;
}

export interface Test {
  check(d: RuntimeData): boolean;
}

/**
 * A read-only file namespace for the `vnd.dovecot.testsuite` DSL — the FS that
 * `test_script_compile "path"` resolves sub-scripts against. `readFile` returns
 * null when the path is absent (a missing sub-script ⇒ compile fails, not an
 * error).
 */
export interface Namespace {
  readFile(path: string): Uint8Array | null;
}

/**
 * A single `test "name" { … }` sub-result sink, handed to the body by
 * `TestEnv.run`. `errorf` records a non-fatal failure and lets the body
 * continue; `skip` marks the sub-test skipped.
 */
export interface SubTest {
  errorf(message: string): void;
  skip(reason: string): void;
}

/**
 * The `vnd.dovecot.testsuite` reporter. Its presence in `Options` is the gate
 * that enables `require "vnd.dovecot.testsuite"`. `run` invokes one `test`
 * block's body, catching a thrown non-StopSignal error and recording it as a
 * fatal sub-test failure.
 */
export interface TestEnv {
  run(name: string, body: (t: SubTest) => void): void;
}

export class RuntimeData {
  readonly script: Script;
  readonly policy: PolicyReader;
  /** Mutable: `test_set "envelope.*"` replaces the whole envelope. */
  envelope: Envelope;
  /** Mutable: `test_set "message"` replaces the whole message. */
  msg: Message;

  ifResult = false;

  redirectAddr: string[] = [];
  mailboxes: string[] = [];
  mailboxesCreate: string[] = []; // RFC 5490 :create
  flags: string[] = [];
  keep = false;
  implicitKeep = true;

  flagAliases: Map<string, string> = new Map();

  /** Optional host hook for `mailboxexists` (undefined ⇒ optimistic "exists"). */
  mailboxChecker?: MailboxChecker;

  /** RFC 5293 editheader ledger, replayed over raw header values on every read. */
  headerEdits: HeaderEdit[] = [];

  /** RFC 5229 user variables (keyed by lowercased name). */
  variables: Map<string, string> = new Map();

  /** Match variables ${0..N}: [0] = whole match, [1..] = capture groups. */
  matchVariables: string[] = [];

  /**
   * RFC 5230 vacation intents, keyed by envelope-from sender. The library only
   * records intent; the host reads this after execute() and applies the send +
   * dedup/rate-limit policy. A Map (not object) avoids prototype-key hazards from
   * attacker-controlled sender strings.
   */
  vacationResponses: Map<string, VacationResponse> = new Map();

  // --- vnd.dovecot.testsuite state (test* fields) ---------
  /** Name of the currently-executing `test` block. */
  testName = "";
  /** Non-empty ⇒ the current test failed with this (variable-expanded) message. */
  testFailMessage = "";
  /** Source position of the `test_fail` that set testFailMessage. */
  testFailAt: Position = { line: 0, col: 0 };
  /** Script compiled by the last `test_script_compile` (run by `test_script_run`). */
  testScript: Script | null = null;
  /** Nesting limit for sub-scripts (0 ⇒ unlimited). */
  testMaxNesting = 0;
  /** FS that `test_script_compile` reads sub-scripts from. */
  namespace: Namespace | null = null;

  /** Read ${i}; out-of-range ⇒ "" (RFC 5229). */
  matchVariable(i: number): string {
    return i >= 0 && i < this.matchVariables.length ? this.matchVariables[i]! : "";
  }

  /** Cooperative CPU budget; `maxExecSteps <= 0` ⇒ unlimited. */
  readonly budget: Budget;

  constructor(script: Script, policy: PolicyReader, envelope: Envelope, msg: Message, budget?: Budget) {
    this.script = script;
    this.policy = policy;
    this.envelope = envelope;
    this.msg = msg;
    // A shared budget (passed by clone()) bounds total CPU across a test and the
    // sub-scripts it runs; otherwise derive one from the script's step limit.
    this.budget =
      budget ?? new Budget(script.opts.maxExecSteps > 0 ? script.opts.maxExecSteps : Number.POSITIVE_INFINITY);
  }

  /**
   * Deep-copy the mutable execution state for `test_script_run`. Shares
   * script/policy/envelope/msg/namespace and the CPU budget by reference; clones
   * the action accumulators, variables, and match variables so the sub-run cannot
   * corrupt the parent. `scriptOverride` runs the clone against a different
   * (compiled) script.
   */
  clone(scriptOverride?: Script): RuntimeData {
    const c = new RuntimeData(scriptOverride ?? this.script, this.policy, this.envelope, this.msg, this.budget);
    c.ifResult = this.ifResult;
    c.redirectAddr = [...this.redirectAddr];
    c.mailboxes = [...this.mailboxes];
    c.mailboxesCreate = [...this.mailboxesCreate];
    c.flags = [...this.flags];
    c.keep = this.keep;
    c.implicitKeep = this.implicitKeep;
    c.flagAliases = new Map(this.flagAliases);
    c.mailboxChecker = this.mailboxChecker;
    c.headerEdits = [...this.headerEdits];
    c.variables = new Map(this.variables);
    c.matchVariables = [...this.matchVariables];
    c.vacationResponses = new Map(this.vacationResponses);
    c.testName = this.testName;
    c.testFailMessage = this.testFailMessage;
    c.testFailAt = this.testFailAt;
    c.testScript = this.testScript;
    c.testMaxNesting = this.testMaxNesting;
    c.namespace = this.namespace;
    return c;
  }
}

export function newRuntimeData(
  script: Script,
  policy: PolicyReader,
  envelope: Envelope,
  msg: Message,
): RuntimeData {
  return new RuntimeData(script, policy, envelope, msg);
}

/** Permissive default policy — every redirect allowed. */
export class DummyPolicy implements PolicyReader {
  redirectAllowed(_d: RuntimeData, _addr: string): boolean {
    return true;
  }
}

/** In-memory Envelope. */
export class EnvelopeStatic implements Envelope {
  constructor(
    public from = "",
    public to = "",
    public auth = "",
  ) {}
  envelopeFrom(): string {
    return this.from;
  }
  envelopeTo(): string {
    return this.to;
  }
  authUsername(): string {
    return this.auth;
  }
}

/**
 * In-memory Message. Header lookup is case-insensitive: construct from a map
 * keyed by lowercased field name to a list of values.
 */
export class MessageStatic implements Message {
  constructor(
    private readonly size: number,
    private readonly headers: Map<string, string[]>,
    private readonly body: Uint8Array | null = null,
  ) {}
  headerGet(key: string): string[] {
    return this.headers.get(key.toLowerCase()) ?? [];
  }
  messageSize(): number {
    return this.size;
  }
  bodyRaw(): Uint8Array | null {
    return this.body;
  }
}
