// if / elsif / else. The if/elsif chain is threaded through RuntimeData.ifResult
// (elsif/else run only when the prior test was not true: false, or unknown).
//
// A branch is where three-valued evaluation must collapse to two. An "unknown"
// condition (see runtime.ts's Tri) is NOT TAKEN — a condition unprovable from
// the bytes read must not fire its actions, which is what used to let a
// `not`-guarded test invert on a truncated input — and the guess is DISCLOSED
// on d.indeterminate. Not-taken rather than abort, deliberately: an abort
// fails the whole script open, so one undecidable body glob would stop every
// unrelated rule from applying. The host reads per-outcome disclosures to
// refuse uncertain irreversible outcomes; indeterminate remains diagnostic.
//
// It also reads which actions the guess decided (see runtime.ts's onGuess):
// the arm that runs after an unknown condition in its chain may not be the
// one the whole input would choose, and an unknown-decided arm that could
// change what runs after it (mayAffectLater, see guess.ts) puts the rest of
// the run on a guess. Ordinary writes instead mark their specific state;
// possible local stores and reject conflicts are disclosed separately.

import { type Cmd, doubtCaptures, onGuess, type RuntimeData, type Test } from "./runtime.js";
import { markWritesUncertain, type UncertainWrites } from "./uncertainty.js";
import { setsCaptures } from "./test.js";

/** The arm an unknown kept from running may be the whole input's, and so may
 * one skipped while a guess is in force (a definite test over state a guess
 * wrote, or a chain an earlier arm of which ran on a guess): a vacation in it
 * could replace the one recorded, and a reject in it could have refused the
 * message. */
export function armSkipped(d: RuntimeData, arm: { mayVacation: boolean; mayReject: boolean; mayKeepLocal: boolean; mayConflictReject: boolean; uncertainWrites?: UncertainWrites }): void {
  markWritesUncertain(d, arm.uncertainWrites);
  if (arm.mayKeepLocal) d.localStoreUncertain = true;
  if (arm.mayConflictReject) d.rejectConflictUncertain = true;
  if (arm.mayVacation && d.vacationResponses.size > 0) d.vacationOnGuess = true;
  if (arm.mayReject) d.rejectOnGuess = true;
}

/** Run an arm, on a guess when an unknown decided the chain before it. One
 * that could change what runs after it puts the rest of the run on a guess. */
function runArm(d: RuntimeData, block: Cmd[], guessed: boolean, mayAffectLater: boolean, writes?: UncertainWrites): void {
  if (guessed) {
    if (mayAffectLater) d.guessAfter = true;
    d.guessDepth++;
  }
  try {
    for (const c of block) {
      d.budget.consume(1);
      c.execute(d);
    }
  } finally {
    if (guessed) {
      d.guessDepth--;
      markWritesUncertain(d, writes);
    }
  }
}

export class CmdIf implements Cmd {
  test!: Test;
  block: Cmd[] = [];
  /** The block could change what runs after it (see guess.ts). */
  mayAffectLater = true;
  /** The block holds a vacation, or a reject (see guess.ts). */
  mayVacation = true;
  mayReject = true;
  mayKeepLocal = true;
  mayConflictReject = true;
  uncertainWrites?: UncertainWrites;

  execute(d: RuntimeData): void {
    const res = this.test.check(d);
    // Doubt about captures lasts one test's evaluation (see doubtCaptures).
    d.captureDoubt = false;
    if (res === "unknown") {
      d.indeterminate = true;
      // Over the whole input the test may have set its own captures: an
      // unknown that ran out of its budget, read a value in doubt or an open
      // part tree left the ones in force unmarked (as member() does in
      // anyof/allof).
      if (setsCaptures(this.test)) doubtCaptures(d);
      // The block not run may be the one the whole input runs.
      if (this.mayAffectLater) d.guessAfter = true;
      armSkipped(d, this);
    } else if (res === false && onGuess(d)) {
      armSkipped(d, this);
    }
    if (res === true) runArm(d, this.block, false, this.mayAffectLater, this.uncertainWrites);
    d.ifResult = res === true;
    d.chainGuessed = res === "unknown";
  }
}

export class CmdElsif implements Cmd {
  test!: Test;
  block: Cmd[] = [];
  /** The block could change what runs after it (see guess.ts). */
  mayAffectLater = true;
  /** The block holds a vacation, or a reject (see guess.ts). */
  mayVacation = true;
  mayReject = true;
  mayKeepLocal = true;
  mayConflictReject = true;
  uncertainWrites?: UncertainWrites;

  execute(d: RuntimeData): void {
    if (d.ifResult) {
      // The arm that ran instead may not be the whole input's.
      if (d.chainGuessed || onGuess(d)) armSkipped(d, this);
      return;
    }
    const prior = d.chainGuessed;
    // Whole, the chain may have ended before this test: the captures it sets
    // are then a guess too.
    if (prior && setsCaptures(this.test)) doubtCaptures(d);
    const res = this.test.check(d);
    // Doubt about captures lasts one test's evaluation (see doubtCaptures).
    d.captureDoubt = false;
    if (res === "unknown") {
      d.indeterminate = true;
      if (setsCaptures(this.test)) doubtCaptures(d);
      if (this.mayAffectLater) d.guessAfter = true;
      armSkipped(d, this);
    } else if (res === false && onGuess(d)) {
      armSkipped(d, this);
    }
    if (res === true) runArm(d, this.block, prior, this.mayAffectLater, this.uncertainWrites);
    d.ifResult = res === true;
    d.chainGuessed = prior || res === "unknown";
  }
}

export class CmdElse implements Cmd {
  block: Cmd[] = [];
  /** The block could change what runs after it (see guess.ts). */
  mayAffectLater = true;
  /** The block holds a vacation, or a reject (see guess.ts). */
  mayVacation = true;
  mayReject = true;
  mayKeepLocal = true;
  mayConflictReject = true;
  uncertainWrites?: UncertainWrites;

  execute(d: RuntimeData): void {
    if (d.ifResult) {
      if (d.chainGuessed || onGuess(d)) armSkipped(d, this);
      return;
    }
    runArm(d, this.block, d.chainGuessed, this.mayAffectLater, this.uncertainWrites);
  }
}
