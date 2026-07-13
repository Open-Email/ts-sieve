// if / elsif / else. The if/elsif chain is threaded through RuntimeData.ifResult
// (elsif/else run only when the prior test was false).

import type { Cmd, RuntimeData, Test } from "./runtime.js";

export class CmdIf implements Cmd {
  test!: Test;
  block: Cmd[] = [];

  execute(d: RuntimeData): void {
    const res = this.test.check(d);
    if (res) {
      for (const c of this.block) {
        d.budget.consume(1);
        c.execute(d);
      }
    }
    d.ifResult = res;
  }
}

export class CmdElsif implements Cmd {
  test!: Test;
  block: Cmd[] = [];

  execute(d: RuntimeData): void {
    if (d.ifResult) return;
    const res = this.test.check(d);
    if (res) {
      for (const c of this.block) {
        d.budget.consume(1);
        c.execute(d);
      }
    }
    d.ifResult = res;
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
