// if / elsif / else. The if/elsif chain is threaded through RuntimeData.ifResult
// (elsif/else run only when the prior test was false).
//
// A branch is where three-valued evaluation must collapse to two. An "unknown"
// condition (see runtime.ts's Tri) is NOT TAKEN — a condition unprovable from
// the bytes read must not fire its actions, which is what used to let a
// `not`-guarded test invert on a truncated input — and the guess is DISCLOSED
// on d.indeterminate. Not-taken rather than abort, deliberately: an abort
// fails the whole script open, so one undecidable body glob would stop every
// unrelated rule from applying. The host reads d.indeterminate to bound what
// an execution that guessed may do (refuse its irreversible outcomes).

import type { Cmd, RuntimeData, Test } from "./runtime.js";

export class CmdIf implements Cmd {
  test!: Test;
  block: Cmd[] = [];

  execute(d: RuntimeData): void {
    const res = this.test.check(d);
    if (res === "unknown") d.indeterminate = true;
    if (res === true) {
      for (const c of this.block) {
        d.budget.consume(1);
        c.execute(d);
      }
    }
    d.ifResult = res === true;
  }
}

export class CmdElsif implements Cmd {
  test!: Test;
  block: Cmd[] = [];

  execute(d: RuntimeData): void {
    if (d.ifResult) return;
    const res = this.test.check(d);
    if (res === "unknown") d.indeterminate = true;
    if (res === true) {
      for (const c of this.block) {
        d.budget.consume(1);
        c.execute(d);
      }
    }
    d.ifResult = res === true;
  }
}

export class CmdElse implements Cmd {
  block: Cmd[] = [];

  execute(d: RuntimeData): void {
    if (d.ifResult) return;
    for (const c of this.block) {
      d.budget.consume(1);
      c.execute(d);
    }
  }
}
