// applyHeaderEditsToValues keeps each field's last replay and applies only the
// edits since (#40 review, N4). It must give what replaying the whole ledger
// gives, for any interleaving of edits and reads.

import { expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { applyHeaderEditsToValues, type HeaderEdit } from "../src/interp/editheader.js";

/** The whole-ledger replay this replaced. */
function reference(edits: HeaderEdit[], fieldName: string, values: string[]): string[] {
  let result = [...values];
  const fn = fieldName.toLowerCase();
  for (const edit of edits) {
    if (edit.fieldName.toLowerCase() !== fn) continue;
    if (edit.action === "add") {
      result = edit.last ? [...result, edit.value] : [edit.value, ...result];
    } else if (edit.index > 0) {
      const idx = edit.last ? result.length - edit.index : edit.index - 1;
      if (idx >= 0 && idx < result.length) result = [...result.slice(0, idx), ...result.slice(idx + 1)];
    } else if (edit.value !== "") {
      const idx = result.indexOf(edit.value);
      if (idx !== -1) result = [...result.slice(0, idx), ...result.slice(idx + 1)];
    } else {
      result = [];
    }
  }
  return result;
}

it("matches the whole-ledger replay over random edits and reads", () => {
  let seed = 9;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 16) % n;
  };
  const script = load("keep;", { enabledExtensions: [] });
  for (let t = 0; t < 300; t++) {
    const headers = new Map([
      ["x-a", ["a1", "a2"]],
      ["x-b", []],
    ]);
    const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, headers));
    for (let step = 0; step < 60; step++) {
      const field = ["X-A", "x-a", "X-B"][rnd(3)]!;
      if (rnd(3) === 0) {
        const values = d.msg.headerGet(field);
        expect(applyHeaderEditsToValues(d, field, values)).toEqual(reference(d.headerEdits, field, values));
        continue;
      }
      const v = ["a1", "a2", "v", "w"][rnd(4)]!;
      const kind = rnd(5);
      if (kind < 2) d.headerEdits.push({ action: "add", fieldName: field, value: v, last: kind === 1, index: 0 });
      else if (kind === 2) d.headerEdits.push({ action: "delete", fieldName: field, value: "", index: 1 + rnd(3), last: rnd(2) === 0 });
      else if (kind === 3) d.headerEdits.push({ action: "delete", fieldName: field, value: v, index: 0, last: false });
      else d.headerEdits.push({ action: "delete", fieldName: field, value: "", index: 0, last: false });
    }
  }
});
