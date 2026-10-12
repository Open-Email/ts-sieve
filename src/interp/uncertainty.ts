// The state an unobserved arm or loop iteration could have written. Keep the
// uncertainty with that state: an unrelated later rule still has exact input.
import { doubtCaptures, type RuntimeData } from "./runtime.js";

export interface UncertainWrites {
  variables: Set<string>;
  headers: Set<string>;
  allHeaders: boolean;
  flags: boolean;
  captures: boolean;
}

export function emptyWrites(): UncertainWrites {
  return { variables: new Set(), headers: new Set(), allHeaders: false, flags: false, captures: false };
}

export function mergeWrites(into: UncertainWrites, from: UncertainWrites): void {
  for (const name of from.variables) into.variables.add(name);
  for (const name of from.headers) into.headers.add(name);
  into.allHeaders ||= from.allHeaders;
  into.flags ||= from.flags;
  into.captures ||= from.captures;
}

export function markHeaderUncertain(d: RuntimeData, name: string | null): void {
  name = name?.toLowerCase() ?? null;
  // Dropped dynamic edits can name more fields than the retained edit ledger.
  // Widen to all fields instead of retaining an unbounded second ledger.
  if (name === null || (!d.allHeadersUncertain && d.uncertainHeaders.size >= 1024 && !d.uncertainHeaders.has(name))) {
    d.allHeadersUncertain = true;
    d.uncertainHeaders.clear();
    d.certainHeaders.clear();
  } else {
    if (!d.allHeadersUncertain) d.uncertainHeaders.add(name);
    d.certainHeaders.delete(name);
  }
}

export function headerUncertain(d: RuntimeData, name: string): boolean {
  name = name.toLowerCase();
  return d.uncertainHeaders.has(name) || (d.allHeadersUncertain && !d.certainHeaders.has(name));
}

export function markWritesUncertain(d: RuntimeData, writes?: UncertainWrites): void {
  if (writes === undefined) return;
  // A loop can repeat an unknown arm. Charge its effect list before walking
  // it; if that exhausts the enclosing loop, the loop's complete effect list
  // is applied once after its share closes. Outside loops these lists are
  // bounded by the uploaded script, as ordinary command dispatch is.
  if (d.budget.shares > 0) {
    d.budget.consume(Math.ceil((writes.variables.size + writes.headers.size + (writes.allHeaders ? d.certainHeaders.size : 0)) / 64));
  }
  for (const name of writes.variables) d.varMarks.set(name, "doubt");
  for (const name of writes.headers) markHeaderUncertain(d, name);
  if (writes.allHeaders) markHeaderUncertain(d, null);
  if (writes.flags) d.flagsMarked = true;
  if (writes.captures) {
    doubtCaptures(d);
    d.captureDoubt = false;
  }
}
