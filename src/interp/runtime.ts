// The injected runtime surface (envelope/message/policy) interfaces and the
// mutable execution state.
//
// The consumer implements Message/Envelope/PolicyReader; the interpreter never
// does I/O or MIME parsing itself. RuntimeData is the action accumulator the
// executor reads after Script.execute() returns.

import { SieveError } from "../errors.js";
import type { Position } from "../parser/command.js";
import type { HeaderEdit } from "./editheader.js";
import type { MimePart } from "./mime.js";
import type { Script } from "./script.js";
import type { VacationResponse } from "./vacation.js";

/**
 * Captures a match took from an input the engine cut (matcher.ts): they may
 * differ from what the whole input gives. Keyed by the array, so code that
 * saves and restores RuntimeData.matchVariables restores the mark too.
 */
const cutCaptures = new WeakSet<string[]>();

/** Mark captures as taken from a cut input (see matchVariable). */
export function markCutCaptures(caps: string[]): void {
  cutCaptures.add(caps);
}

/**
 * Captures an "unknown" may have changed. Evaluation goes on past an unknown
 * member of anyof/allof, or an unknown key or value: over the whole input it
 * could have set its own captures, or ended the test before a later member set
 * these. Any read of them discloses, an out-of-range one too (the group count
 * may differ).
 */
const staleCaptures = new WeakSet<string[]>();

/** An "unknown" was met in the test being evaluated: doubt the captures in
 * force, and any set before the evaluation ends (see CmdIf). */
export function doubtCaptures(d: RuntimeData): void {
  d.captureDoubt = true;
  if (!staleCaptures.has(d.matchVariables)) {
    d.matchVariables = [...d.matchVariables];
    staleCaptures.add(d.matchVariables);
  }
}

/** Mark captures set while their test evaluation was in doubt. */
export function markStaleCaptures(caps: string[]): void {
  staleCaptures.add(caps);
}

/** Thrown by Budget.consume when a share runs out; withShare catches it. */
const SHARE_EXHAUSTED = Symbol("share exhausted");

/**
 * A cooperative execution budget: script work is bounded by counting steps
 * rather than wall-clock time, so execution stays deterministic and cannot be
 * preempted mid-run. The interpreter ticks this counter in its hot loops
 * (command dispatch, match keys, the regex VM's inner loop) — a deterministic
 * CPU cap for a Worker. Tests spend it under a share (withShare), and a test
 * that runs out of its share is "unknown"; running out outside one throws.
 */
class Budget {
  /** consume() may not take `remaining` below this: 0 for the script, higher
   * inside a test's share. */
  floor = 0;
  /** How many shares are open. */
  shares = 0;
  constructor(public remaining: number) {}
  consume(n = 1): void {
    this.remaining -= n;
    if (this.remaining < this.floor) {
      if (this.shares > 0) {
        // Not below the floor: what is under it belongs to command dispatch
        // and the tests after this one. (A share never opens with its floor
        // above `remaining`, as withShare keeps at most half of what is free,
        // so this only ever lowers the count.)
        this.remaining = this.floor;
        throw SHARE_EXHAUSTED;
      }
      throw new SieveError("sieve: script execution budget exceeded");
    }
  }
}

/** Steps kept back for each test after the running one, as a fraction of
 * maxExecSteps (195 of core's 200k: a header :contains or a short glob, not a
 * body glob). Larger, and a script with many rules after a body glob costs the
 * glob its answer on mail that fits the budget. */
const LATER_TEST_RESERVE = 1 / 1024;

/**
 * Run budgeted work number `index` (a test, or deleteheader's matching, in
 * script order) under a share of the step budget, returning "unknown" when the
 * share runs out. Without this, exhausting the budget threw, and a message can
 * drive that (large parts under a glob, a :regex key built from a header): a
 * thrown execute() skips every rule, which a host's fail-open turns into a
 * filter bypass.
 *
 * The share is everything left, minus the steps command dispatch may still
 * need (one per command in the script, so it never runs out) and a reserve for
 * each budgeted step after this one, capped at half of what is left. One
 * expensive test therefore cannot starve the rest of the script: they keep
 * their reserve, or half of what was left. Many expensive tests in a row can,
 * each taking its share of what the previous ones left; and a run that fits
 * the budget may still lose an answer to the reserves of the tests after it.
 */
export function withShare(d: RuntimeData, index: number, f: () => Tri): Tri {
  const b = d.budget;
  if (b.remaining === Number.POSITIVE_INFINITY) return f();
  const s = d.script;
  const free = Math.max(0, b.remaining - Math.max(b.floor, s.commandCount));
  const later = Math.max(0, s.budgetedCount - index - 1);
  const keep = Math.min(later * Math.floor(s.opts.maxExecSteps * LATER_TEST_RESERVE), Math.floor(free / 2));
  const outer = b.floor;
  b.floor = b.remaining - (free - keep);
  b.shares++;
  try {
    return f();
  } catch (e) {
    // The innermost share's floor is the one in force, so it is this one.
    if (e !== SHARE_EXHAUSTED) throw e;
    d.budgetExhausted = true;
    return "unknown";
  } finally {
    b.floor = outer;
    b.shares--;
  }
}

/** A test run under its share of the budget (see withShare). */
export class SharedTest implements Test {
  constructor(
    private readonly test: Test,
    private readonly index: number,
  ) {}
  check(d: RuntimeData): Tri {
    return withShare(d, this.index, () => this.test.check(d));
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
  /** Raw body bytes; null when unavailable (the `body` test then never matches).
   * The body test caches what it derives from it per Message object, for as
   * long as the object lives: a host must not change the body, the top-level
   * Content-Type or transfer encoding, or bodyTruncated() behind an object it
   * reuses. */
  bodyRaw(): Uint8Array | null;
  /**
   * True when `bodyRaw()` is a PREFIX of the real body (the host read a bounded
   * window of a larger message). The `body` test then evaluates three-valued:
   * definite answers where the prefix proves them, "unknown" otherwise — which
   * a branch resolves as not-taken while disclosing the guess on
   * RuntimeData.indeterminate. Absent ⇒ the body is complete.
   */
  bodyTruncated?(): boolean;
}

export interface PolicyReader {
  /** Gate (and optionally rate-limit) a redirect target. The default allows all.
   * It may append to `d.redirectAddr` or `d.mailboxes`, but not edit or remove
   * an entry: the commands index those lists, and rebuild the index only when
   * a list's length shows it changed. What it reads of `d` is provisional: a
   * reject cancels the implicit keep only once the script has run, so read
   * `d.rejected` rather than `d.implicitKeep`. */
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

/**
 * Kleene three-valued test result. `"unknown"` means the answer depends on
 * bytes outside the evaluated window (truncated body / capped match input);
 * `not`/`allof`/`anyof` propagate it, and a branch condition that resolves to
 * it is NOT TAKEN, with the guess disclosed on RuntimeData.indeterminate.
 * Tests over complete inputs return plain booleans — `boolean` is assignable,
 * so a definite test needs no ceremony.
 */
export type Tri = boolean | "unknown";

export interface Test {
  check(d: RuntimeData): Tri;
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

  /**
   * True when an "unknown" (see Tri) DECIDED a branch — the condition's value
   * depended on bytes outside the evaluated window and the branch was not
   * taken. The accumulated actions are then a best-effort reading, not a proven
   * one: the host should refuse this execution's IRREVERSIBLE outcomes
   * (discard, redirect-without-keep, reject) and let the recoverable ones
   * stand.
   * Unknowns a definite value absorbed inside allof/anyof never set this.
   * Also set when a variable's value was cut to its size limit, when a
   * fileinto or redirect past its limit was dropped, and when a reject stood
   * beside a delivering action (see rejectConflict).
   */
  indeterminate = false;

  /** RFC 5429 §2.4: the action a reject stood beside ("" for none), the first
   * of keep, fileinto, redirect, vacation when there are several. The run is
   * then indeterminate and everything else stands as if the reject had not
   * run: refuse the reject, deliver the rest. Under strictReject this is an
   * error instead. "As if it had not run" holds within one execute(): a run
   * on a clone (test_script_run) cannot restore an implicit keep that an
   * earlier run's standing reject cancelled. */
  rejectConflict: "" | "keep" | "fileinto" | "redirect" | "vacation" = "";

  /** A test ran out of its share of the step budget and answered "unknown"
   * (see withShare). The script completed; this says why it guessed. */
  budgetExhausted = false;

  redirectAddr: string[] = [];
  mailboxes: string[] = [];
  mailboxesCreate: string[] = []; // RFC 5490 :create
  flags: string[] = [];
  keep = false;
  implicitKeep = true;

  /** RFC 5429: a reject (or, with rejectExtended, an ereject) ran, with this
   * reason after variable expansion. Refusing the message is the host's call. */
  rejected = false;
  rejectReason = "";
  rejectExtended = false;
  /** A vacation action ran, whether or not it recorded a response. */
  vacationRan = false;

  flagAliases: Map<string, string> = new Map();

  /** Optional host hook for `mailboxexists` (undefined ⇒ optimistic "exists"). */
  mailboxChecker?: MailboxChecker;

  /** RFC 5293 editheader ledger, replayed over raw header values on every read. */
  headerEdits: HeaderEdit[] = [];
  /** Characters of the values headerEdits adds (editheader.ts caps it). */
  headerEditBytes = 0;

  /** RFC 5229 user variables (keyed by lowercased name). */
  variables: Map<string, string> = new Map();

  /** Match variables ${0..N}: [0] = whole match, [1..] = capture groups. */
  matchVariables: string[] = [];

  /** Folds of large values, per fold kind, for this execution (matcher.ts
   * foldOnce). */
  foldCache: Map<string, Map<string, string>> = new Map();
  /** UTF-16 units foldCache holds, values and folds together. */
  foldCacheUnits = 0;

  /** RFC 5703: the part each running foreverypart has reached, innermost last. */
  partStack: MimePart[] = [];

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

  /** Read ${i}; out-of-range ⇒ "" (RFC 5229). A capture from a cut input
   * may differ from what the whole input gives (for :matches, ${0} and the
   * last "*"; for :regex, any group), with nothing to say so: reading it sets
   * indeterminate, as extracttext's cut does. So does reading a capture an
   * "unknown" may have changed (see doubtCaptures), in range or not. */
  matchVariable(i: number): string {
    if (staleCaptures.has(this.matchVariables)) this.indeterminate = true;
    if (i < 0 || i >= this.matchVariables.length) return "";
    if (cutCaptures.has(this.matchVariables)) this.indeterminate = true;
    return this.matchVariables[i]!;
  }

  /** An "unknown" was met in the test being evaluated (see doubtCaptures);
   * cleared after each if/elsif test. (deleteheader, the one other matcher,
   * discloses its own unknowns.) */
  captureDoubt = false;

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
    c.indeterminate = this.indeterminate;
    c.budgetExhausted = this.budgetExhausted;
    c.redirectAddr = [...this.redirectAddr];
    c.mailboxes = [...this.mailboxes];
    c.mailboxesCreate = [...this.mailboxesCreate];
    c.flags = [...this.flags];
    c.keep = this.keep;
    c.implicitKeep = this.implicitKeep;
    c.rejected = this.rejected;
    c.rejectReason = this.rejectReason;
    c.rejectExtended = this.rejectExtended;
    c.rejectConflict = this.rejectConflict;
    c.vacationRan = this.vacationRan;
    c.flagAliases = new Map(this.flagAliases);
    c.mailboxChecker = this.mailboxChecker;
    c.headerEdits = [...this.headerEdits];
    c.headerEditBytes = this.headerEditBytes;
    c.variables = new Map(this.variables);
    c.matchVariables = [...this.matchVariables];
    if (cutCaptures.has(this.matchVariables)) cutCaptures.add(c.matchVariables);
    if (staleCaptures.has(this.matchVariables)) staleCaptures.add(c.matchVariables);
    c.partStack = [...this.partStack];
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
    private readonly truncated: boolean = false,
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
  bodyTruncated(): boolean {
    return this.truncated;
  }
}
