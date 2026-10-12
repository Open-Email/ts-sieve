// Advisory per-rule reserves. They choose how to share a fixed budget; actual
// work still consumes that same budget and a share can still answer unknown.
import { applyHeaderEditsToValues } from "./editheader.js";
import { MAX_INPUT_LENGTH } from "./regex.js";
import type { RuntimeData } from "./runtime.js";

export interface ValueProfile {
  count: number;
  units: number;
  matchUnits: number;
  foldSteps: number;
}

export interface BudgetShare {
  /** First share after this operation, including any loop body. */
  end: number;
  estimate?: (context: ReserveContext) => number | undefined;
}

/** Only lengths/counts are read here: no decoding, address parsing, variable
 * expansion, MIME walking or matching may run while reserving for a rule. */
export class ReserveContext {
  private profiles = new Map<string, ValueProfile | undefined>();
  private valuesLeft = 4096;
  constructor(private readonly d: RuntimeData) {}

  names(count: number): void {
    this.d.budget.consume(Math.ceil(count / 64));
  }

  header(name: string, index = 0, last = false): ValueProfile | undefined {
    if (name.includes("${")) return undefined;
    name = name.toLowerCase();
    const key = `${name}:${index}:${last}`;
    if (this.profiles.has(key)) return this.profiles.get(key);
    this.d.budget.consume();
    let values: string[];
    try {
      values = this.d.msg.headerGet(name);
    } catch {
      // A host may refuse an unreadable field. Estimation must not make an
      // otherwise skipped future test throw; its actual read owns that error.
      this.profiles.set(key, undefined);
      return undefined;
    }
    const edits = this.d.headerEdits.length;
    if (edits > 0) {
      // Replaying additions can copy and shift the value list. Refuse large
      // lists before replay, and charge its worst-case work before doing it.
      if (values.length + edits > this.valuesLeft) {
        this.profiles.set(key, undefined);
        return undefined;
      }
      this.d.budget.consume(Math.ceil((values.length + edits * (values.length + edits)) / 64));
      values = applyHeaderEditsToValues(this.d, name, values);
    }
    const from = index === 0 ? 0 : last ? Math.max(0, values.length - index) : Math.min(values.length, index - 1);
    const to = index === 0 ? values.length : last && index > values.length ? 0 : Math.min(values.length, from + 1);
    const count = Math.max(0, to - from);
    let result: ValueProfile | undefined;
    if (count <= this.valuesLeft) {
      // Charge before inspecting message data, outside the host-error catch.
      this.d.budget.consume(Math.ceil(count / 64));
      this.valuesLeft -= count;
      result = { count, units: 0, matchUnits: 0, foldSteps: 0 };
      const cap = this.d.script.opts.maxMatchInputLength || MAX_INPUT_LENGTH;
      for (let i = from; i < to; i++) {
        const n = values[i]!.length;
        result.units += n;
        result.matchUnits += Math.min(n, cap) + 1;
        result.foldSteps += Math.floor(n / 1024);
      }
    }
    this.profiles.set(key, result);
    return result;
  }
}

interface Plan {
  msg: RuntimeData["msg"];
  edits: RuntimeData["headerEdits"];
  editCount: number;
  weights: number[];
  after: number[];
}
const plans = new WeakMap<RuntimeData, Plan>();

export function reservePlan(d: RuntimeData): Plan {
  const held = plans.get(d);
  if (held?.msg === d.msg && held.edits === d.headerEdits && held.editCount === d.headerEdits.length) return held;
  const shares = d.script.budgetShares;
  const count = d.script.budgetedCount;
  // An exhausted caller must not repeatedly rebuild an uncharged plan.
  d.budget.consume(Math.ceil(count / 64));
  const limit = d.script.opts.maxExecSteps || d.budget.remaining;
  // Unknown-size operations (body tests, MIME scopes, dynamic names and
  // loops) get a useful allowance. No single requested minimum can reserve
  // more than an eighth of the whole budget from earlier operations.
  const fallback = Math.max(1, Math.floor(limit / 16));
  const cap = Math.max(1, Math.floor(limit / 8));
  const ctx = new ReserveContext(d);
  const weights = new Array<number>(count);
  const after = new Array<number>(count);
  const scope = (start: number, end: number): number => {
    const siblings: number[] = [];
    for (let i = start; i < end;) {
      const share = shares[i];
      const next = share?.end ?? i + 1;
      const children = next > i + 1 ? scope(i + 1, next) : 0;
      weights[i] = Math.max(1, Math.min(cap, Math.max(children, share?.estimate?.(ctx) ?? fallback)));
      siblings.push(i);
      i = next;
    }
    let sum = 0;
    for (let j = siblings.length - 1; j >= 0; j--) {
      const i = siblings[j]!;
      after[i] = sum;
      sum += weights[i]!;
    }
    return sum;
  };
  scope(0, count);
  // Reuse until the message or header-edit ledger changes; clones get a plan
  // for their own script/state. Never retain an interrupted plan.
  const plan = { msg: d.msg, edits: d.headerEdits, editCount: d.headerEdits.length, weights, after };
  plans.set(d, plan);
  return plan;
}
