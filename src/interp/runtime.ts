// The injected runtime surface (envelope/message/policy) interfaces and the
// mutable execution state.
//
// The consumer implements Message/Envelope/PolicyReader; the interpreter never
// does I/O or MIME parsing itself. RuntimeData is the action accumulator the
// executor reads after Script.execute() returns.

import { reservePlan, type ReserveContext } from "./budget-reserve.js";
import { SieveError } from "../errors.js";
import type { Position } from "../parser/command.js";
import type { HeaderEdit } from "./editheader.js";
import type { MimePart } from "./mime.js";
import type { Script } from "./script.js";
import type { VacationResponse } from "./vacation.js";

/** Certainty carried with a value. The string forms retain the original
 * API: whole, all held text is a prefix, or no usable text. A prefix length
 * proves only the leading UTF-16 units (text appended after a cut is not
 * necessarily adjacent to that head). A length bound describes the numeric
 * result of :length; it is not an exact number or a textual prefix. */
export type Mark = "" | "prefix" | "doubt" | Readonly<{ prefix: number }> | Readonly<{ minLength: number }>;

export function provenLength(value: string, mark: Mark): number {
  return mark === "" || mark === "prefix" ? value.length
    : typeof mark === "object" && "prefix" in mark ? Math.min(mark.prefix, value.length) : 0;
}

/** Mark a best-effort value whose first length units are a proven prefix. */
export function prefixMark(value: string, length: number): Mark {
  return length >= value.length ? "prefix" : length > 0 ? { prefix: length } : "doubt";
}

/**
 * Captures a match took from an input the engine cut (matcher.ts), and the
 * match type that took them: a :matches with a sound trailing "*" proves its
 * inner captures, and its last one and ${0} are prefixes of the whole input's;
 * a :regex capture can differ in any group. Keyed by the array, so code that
 * saves and restores RuntimeData.matchVariables restores the mark too.
 */
const cutCaptures = new WeakMap<string[], "matches" | "regex">();

/** Mark captures as taken from a cut input (see captureMark). */
export function markCutCaptures(caps: string[], kind: "matches" | "regex"): void {
  cutCaptures.set(caps, kind);
}

/**
 * Captures an "unknown" may have changed. Evaluation goes on past an unknown
 * member of anyof/allof, or an unknown key or value: over the whole input it
 * could have set its own captures, or ended the test before a later member set
 * these. Each of them is in doubt (see captureMark), an out-of-range one too
 * (the group count may differ): a test over one answers unknown.
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
        // above `remaining`, so this only ever lowers the count.)
        this.remaining = this.floor;
        throw SHARE_EXHAUSTED;
      }
      throw new SieveError("sieve: script execution budget exceeded");
    }
  }
}

/**
 * Run one operation under a share of the remaining budget. Later siblings
 * retain an estimated minimum: cheap literal header reads use their actual
 * counts/lengths, pattern tests include their VM size, and unknown-size work
 * uses a bounded fallback. Surplus is available to the current operation.
 * If all requested minima cannot fit, divide what remains proportionally.
 * This preserves the last rule's allowance across several exhausted earlier
 * tests instead of repeatedly halving it (#66).
 *
 * Loop bodies reserve only for siblings inside that loop: the outer share
 * already protects following rules. Estimates are not completion guarantees;
 * unusually expensive, dynamic or edited values can still exhaust a share.
 * No reserve increases maxExecSteps, and command dispatch keeps its floor.
 */
export function withShare(d: RuntimeData, index: number, f: () => Tri): Tri {
  const b = d.budget;
  if (b.remaining === Number.POSITIVE_INFINITY) return f();
  const outer = b.floor;
  b.floor = Math.max(outer, Math.min(b.remaining, d.script.commandCount));
  b.shares++;
  try {
    const plan = reservePlan(d);
    const free = Math.max(0, b.remaining - b.floor);
    const wanted = plan.after[index] ?? 0;
    const own = plan.weights[index] ?? 1;
    const keep = wanted + own <= free ? wanted : Math.floor(free * wanted / (wanted + own));
    b.floor += keep;
    return f();
  } catch (e) {
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
  /** The wrapped test's (see test.ts setsCaptures). */
  get setsCaptures(): boolean | undefined {
    return (this.test as { setsCaptures?: boolean }).setsCaptures;
  }
  check(d: RuntimeData): Tri {
    const outer = d.testDoubt;
    d.testDoubt = false;
    try {
      const r = withShare(d, this.index, () => this.test.check(d));
      // A marked value read where the test could not weigh it: its definite
      // answer may not be the whole input's.
      return d.testDoubt ? "unknown" : r;
    } finally {
      d.testDoubt = outer;
    }
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
  /** Optional root MIME structure values as binary strings (one code unit
   * per original byte), in field order. Used only for Content-Type and
   * Content-Transfer-Encoding; ordinary header tests still use headerGet.
   * Undefined means the host has no raw view, so decoded-text fallback is
   * used. An empty array means the field is authoritatively absent. */
  mimeHeaderGet?(key: string): string[] | undefined;
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
  /** Advisory minimum for a future rule; omitted for unknown-size work. */
  budgetReserve?(context: ReserveContext): number | undefined;
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
   * taken. This is a diagnostic for any uncertain effect. Hosts use
   * localDeliveryOnGuess for a no-local-store outcome, redirectsOnGuess and
   * vacationOnGuess for sends, and rejectConflict for conflicting rejects.
   * Unknowns a definite value absorbed inside allof/anyof never set this.
   * A value the engine could not hold whole is marked, not the run (see
   * Mark): this is set only where a command cannot weigh the mark and drops
   * what it would have done (a redirect to one, or a header name built from
   * one). Also set when a fileinto or redirect past its limit was dropped, and
   * when a reject stood beside a delivering action (see rejectConflict). The
   * redirects and fileintos dropped are counted (see redirectsDropped).
   */
  indeterminate = false;

  /** A no-local-store outcome may differ over the whole input. Hosts consult
   * this when keep/implicitKeep/mailboxes say to store nothing; indeterminate
   * remains the wider diagnostic for any uncertain effect. */
  get localDeliveryOnGuess(): boolean {
    const rejectedOnProof = this.rejected && this.rejectConflict === "" && this.rejectExecutionProven && !this.rejectConflictUncertain;
    return !this.implicitKeep && (this.localStoreUncertain || !(this.keepCancellationProven || rejectedOnProof));
  }
  /** An unobserved arm/iteration could have kept or filed the message. */
  localStoreUncertain = false;
  /** A non-reject action definitely cancelled implicit keep. */
  keepCancellationProven = false;
  /** The executed reject was reached on exact control flow. */
  rejectExecutionProven = false;
  /** An unobserved delivery/vacation could conflict with an executed reject. */
  rejectConflictUncertain = false;

  /** Root fields that an unobserved command may have added or removed. A
   * definite delete-all restores a field, even after an unknown field name. */
  uncertainHeaders = new Set<string>();
  allHeadersUncertain = false;
  certainHeaders = new Set<string>();

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

  /** Redirects that ran and the engine dropped, each disclosed on
   * indeterminate: one to an address built from a value it could not hold
   * whole (see Mark), or one past maxRedirects, which never reached the
   * host's policy and so may be one it would have refused. Their addresses
   * are in no list. It counts redirects run, not addresses: a loop drops one
   * redirect once per iteration, to the same address or not. A host reports
   * it beside the forwards it withholds, as its own number: those are
   * addresses. A redirect in an arm an unknown kept from running, or in a
   * loop iteration missed, did not run: it is neither here nor in
   * redirectsOnGuess, and only indeterminate discloses it. A redirect the
   * host's policy refused, or a repeat of a target held, is no drop. */
  redirectsDropped = 0;
  /** Fileintos that ran and were dropped past maxFileintos, counted as
   * redirectsDropped is: per fileinto run, not per name. */
  fileintosDropped = 0;
  /** Addheader/deleteheader commands whose edits were dropped for a marked
   * field name or the ledger's edit/value limits, each setting indeterminate.
   * Counts commands run, once per loop iteration, including a deleteheader
   * only partly recorded. Unknown delete matches disclose a guess but prove
   * no edit to drop; ignored invalid names and protected deletes do not count. */
  headerEditsDropped = 0;

  redirectAddr: string[] = [];
  mailboxes: string[] = [];
  mailboxesCreate: string[] = []; // RFC 5490 :create
  flags: string[] = [];
  /** The internal flag set was built from a value the engine could not hold
   * whole (see Mark): hasflag over it cannot answer for the whole input. A
   * setflag, or the :flags of keep or fileinto, of values held whole replaces
   * it, and a discard clears it. */
  flagsMarked = false;
  keep = false;
  implicitKeep = true;

  /** RFC 5429: a reject (or, with rejectExtended, an ereject) ran, with this
   * reason after variable expansion. Refusing the message is the host's call. */
  rejected = false;
  rejectReason = "";
  rejectExtended = false;
  /** A vacation action ran, whether or not it recorded a response. */
  vacationRan = false;
  /** The vacation response recorded may not be the whole input's: the last
   * one recorded ran on a guess (see onGuess), or an arm an unknown decided
   * after it holds a vacation that could have replaced it. */
  vacationOnGuess = false;
  /** A reject ran on uncertain control flow, or may have run in a skipped
   * arm/iteration. A host keeps from answering a sender the script may have
   * meant to refuse. */
  rejectOnGuess = false;
  /** The redirect targets (by redirectKey) every redirect to which so far
   * ran on a guess (see onGuess, redirectsOnGuess). Empty in a run that
   * never guessed, so a redirect then costs no lookup in it. */
  redirectGuessed: Set<string> = new Set();
  /** A redirect to a marked address was dropped while redirects were enabled.
   * Its whole address may have delivered, so a reject cannot stand beside it
   * as conflict-free. Separate from redirectsDropped, which also counts known
   * targets dropped at the limit (including maxRedirects = 0). */
  redirectUnresolved = false;
  /** Arms being run that an unknown chose (see control.ts). */
  guessDepth = 0;
  /** Uncertain control flow or action-limit interactions could change which
   * later commands run. Ordinary writes instead mark their specific state. */
  guessAfter = false;
  /** An unknown decided a condition earlier in this if/elsif chain, so the
   * arm that runs may not be the one the whole input would choose. Threaded
   * like ifResult. */
  chainGuessed = false;

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

  /** Read ${i}; out-of-range ⇒ "" (RFC 5229). */
  matchVariable(i: number): string {
    return i >= 0 && i < this.matchVariables.length ? this.matchVariables[i]! : "";
  }

  /** The mark on ${i} (see Mark): a capture an unknown may have changed is in
   * doubt, out of range too (the group count may differ); one from a cut
   * input is a prefix (a :matches' ${0} and last capture), exact (its inner
   * ones), or in doubt (any :regex group). */
  captureMark(i: number): Mark {
    if (staleCaptures.has(this.matchVariables)) return "doubt";
    if (i < 0 || i >= this.matchVariables.length) return "";
    const cut = cutCaptures.get(this.matchVariables);
    if (cut === undefined) return "";
    if (cut === "regex") return "doubt";
    return i === 0 || i === this.matchVariables.length - 1 ? "prefix" : "";
  }

  /** User variables whose value is marked (see Mark), by lowercased name. */
  varMarks: Map<string, Exclude<Mark, "">> = new Map();

  /** A test read a marked value where it cannot weigh the mark itself (a
   * an exists field or a :count key): SharedTest then answers "unknown". */
  testDoubt = false;

  /** An "unknown" was met in the test being evaluated (see doubtCaptures);
   * reset for each if/elsif test. (deleteheader, the one other matcher,
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
    c.localStoreUncertain = this.localStoreUncertain;
    c.keepCancellationProven = this.keepCancellationProven;
    c.rejectExecutionProven = this.rejectExecutionProven;
    c.rejectConflictUncertain = this.rejectConflictUncertain;
    c.uncertainHeaders = new Set(this.uncertainHeaders);
    c.allHeadersUncertain = this.allHeadersUncertain;
    c.certainHeaders = new Set(this.certainHeaders);
    c.budgetExhausted = this.budgetExhausted;
    c.redirectsDropped = this.redirectsDropped;
    c.fileintosDropped = this.fileintosDropped;
    c.headerEditsDropped = this.headerEditsDropped;
    c.redirectAddr = [...this.redirectAddr];
    c.mailboxes = [...this.mailboxes];
    c.mailboxesCreate = [...this.mailboxesCreate];
    c.flags = [...this.flags];
    c.flagsMarked = this.flagsMarked;
    c.keep = this.keep;
    c.implicitKeep = this.implicitKeep;
    c.rejected = this.rejected;
    c.rejectReason = this.rejectReason;
    c.rejectExtended = this.rejectExtended;
    c.rejectConflict = this.rejectConflict;
    c.vacationRan = this.vacationRan;
    c.vacationOnGuess = this.vacationOnGuess;
    c.rejectOnGuess = this.rejectOnGuess;
    c.redirectGuessed = new Set(this.redirectGuessed);
    c.redirectUnresolved = this.redirectUnresolved;
    c.guessDepth = this.guessDepth;
    c.guessAfter = this.guessAfter;
    c.chainGuessed = this.chainGuessed;
    c.flagAliases = new Map(this.flagAliases);
    c.mailboxChecker = this.mailboxChecker;
    c.headerEdits = [...this.headerEdits];
    c.headerEditBytes = this.headerEditBytes;
    c.variables = new Map(this.variables);
    c.matchVariables = [...this.matchVariables];
    const cut = cutCaptures.get(this.matchVariables);
    if (cut !== undefined) cutCaptures.set(c.matchVariables, cut);
    c.varMarks = new Map(this.varMarks);
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

/**
 * Whether an action running now is on a guess: an "unknown" chose the arm it
 * runs in, or decided earlier an arm, a loop or a header edit that could
 * change what runs after it. A forward or an auto-reply cannot be recalled,
 * so a host withholds the ones a guess decided; the rest of the run is as the
 * whole input would have it.
 */
export function onGuess(d: RuntimeData): boolean {
  return d.guessDepth > 0 || d.guessAfter;
}

/**
 * A stop or break ran on a guess: read whole, the run may have gone on past
 * it, to a reject or a vacation the script holds. Conservative, by the
 * script: it only keeps a host from answering.
 */
export function cutOffOnGuess(d: RuntimeData): void {
  if (!onGuess(d)) return;
  if (d.script.hasLocalDelivery) d.localStoreUncertain = true;
  if (d.script.hasRejectConflictAction) d.rejectConflictUncertain = true;
  if (d.script.hasReject) d.rejectOnGuess = true;
  if (d.script.hasVacation && d.vacationResponses.size > 0) d.vacationOnGuess = true;
}

/** Record cancellation separately from whether an uncertain arm could add a
 * local destination. A later definite cancellation supersedes a guessed one. */
export function cancelImplicitKeep(d: RuntimeData, proven = !onGuess(d)): void {
  d.implicitKeep = false;
  d.keepCancellationProven ||= proven;
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
    private readonly mimeHeaders?: Map<string, string[]>,
  ) {}
  headerGet(key: string): string[] {
    return this.headers.get(key.toLowerCase()) ?? [];
  }
  mimeHeaderGet(key: string): string[] | undefined {
    return this.mimeHeaders === undefined ? undefined : this.mimeHeaders.get(key.toLowerCase()) ?? [];
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
