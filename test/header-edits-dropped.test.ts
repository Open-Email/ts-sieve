// Hosts need to distinguish editheader's dropped commands from other guesses
// (#76). Count commands run, including a partially recorded deleteheader, not
// the individual ledger entries one command can produce.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options, type RuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml, parts } from "./harness.js";

const REQ = 'require ["editheader","variables","foreverypart","index"];';
const FILL = 'addheader "X-Fill" "x";';
const MARK = 'if header :matches "subject" "*" { set "name" "${1}"; }';
const LONG = `Subject: ${"x".repeat(4500)}\r\n\r\nbody`;
const REPEATED = "X-Tag: same\r\nX-Tag: same\r\nX-Tag: same\r\n\r\nbody";

function exec(commands: string, message = "", options: Options = {}): RuntimeData {
  const { headers, size, body } = parseEml(message);
  const s = load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, ...options });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(size, headers, body));
  s.execute(d);
  return d;
}

describe("headerEditsDropped (#76)", () => {
  it("starts at zero and leaves successful edits uncounted", () => {
    expect(exec("keep;").headerEditsDropped).toBe(0);
    const d = exec('addheader "X-Tag" "value"; deleteheader "X-Tag";');
    expect(d.headerEdits).toHaveLength(2);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([0, false]);
  });

  it("accepts exactly 1024 edits, then counts each add or delete command dropped", () => {
    const full = exec(FILL.repeat(1024));
    expect(full.headerEdits).toHaveLength(1024);
    expect([full.headerEditsDropped, full.indeterminate]).toEqual([0, false]);
    const over = exec(`${FILL.repeat(1024)} ${FILL} deleteheader "X-Fill"; deleteheader :index 1 "X-Fill";`);
    expect(over.headerEdits).toHaveLength(1024);
    expect([over.headerEditsDropped, over.indeterminate, over.guessAfter]).toEqual([3, true, false]);
    expect([...over.uncertainHeaders]).toEqual(["x-fill"]);
  });

  it("counts a partly or wholly dropped delete-by-value once, even with repeated matching values", () => {
    for (const held of [1023, 1024]) {
      const d = exec(`${FILL.repeat(held)} deleteheader :is "X-Tag" "same";`, REPEATED);
      expect(d.headerEdits).toHaveLength(1024);
      expect(d.headerEdits.filter((e) => e.action === "delete")).toHaveLength(1024 - held);
      expect([d.headerEditsDropped, d.indeterminate]).toEqual([1, true]);
    }
  });

  it("does not count a delete-by-value that exactly fills the ledger", () => {
    const d = exec(`${FILL.repeat(1021)} deleteheader :is "X-Tag" "same";`, REPEATED);
    expect(d.headerEdits).toHaveLength(1024);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([0, false]);
  });

  it("accepts exactly 1 MiB of added values, then counts each oversized add", () => {
    // The loop visits the multipart root and 255 children: 256 * 4096.
    const fill = `foreverypart { addheader "X-Large" "${"x".repeat(4096)}"; }`;
    const exact = exec(fill, parts(255));
    expect([exact.headerEdits.length, exact.headerEditBytes]).toEqual([256, 1024 * 1024]);
    expect([exact.headerEditsDropped, exact.indeterminate]).toEqual([0, false]);
    const over = exec(`${fill} ${FILL.repeat(2)} deleteheader "X-Large"; addheader "X-Empty" "";`, parts(255));
    // Deletes and empty adds still fit; the value cap does not fill the ledger.
    expect([over.headerEdits.length, over.headerEditBytes]).toEqual([258, 1024 * 1024]);
    expect([over.headerEditsDropped, over.indeterminate]).toEqual([2, true]);
  });

  it("counts one dropped command per loop iteration", () => {
    const d = exec(`${FILL.repeat(1024)} foreverypart { ${FILL} }`, parts(3));
    expect(d.headerEdits).toHaveLength(1024);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([4, true]);
  });

  it("counts add and delete commands whose field name is marked", () => {
    const d = exec(`${MARK} addheader "\${name}" "value"; deleteheader "\${name}";`, LONG);
    expect(d.headerEdits).toEqual([]);
    expect([d.headerEditsDropped, d.indeterminate, d.guessAfter]).toEqual([2, true, false]);
    expect(d.allHeadersUncertain).toBe(true);
  });

  it("counts a command with both a marked name and a full ledger only once", () => {
    const d = exec(`${FILL.repeat(1024)} ${MARK} addheader "\${name}" "value"; deleteheader "\${name}";`, LONG);
    expect(d.headerEdits).toHaveLength(1024);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([2, true]);
  });

  it("does not count an added value that is marked: the edit is recorded", () => {
    const d = exec(`${MARK} addheader "X-Tag" "\${name}";`, LONG);
    expect(d.headerEdits).toMatchObject([{ action: "add", mark: "prefix" }]);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([0, false]);
  });

  it("does not count skipped commands, invalid names, protected deletes or nonmatches, even at the limit", () => {
    const d = exec(`${FILL.repeat(1024)}
      if false { ${FILL} }
      set "bad" "bad name";
      addheader "\${bad}" "value"; deleteheader "\${bad}";
      deleteheader "Received"; deleteheader "Auto-Submitted";
      deleteheader :is "X-Tag" "missing";
      deleteheader :is "X-Absent" "same";`, REPEATED);
    expect(d.headerEdits).toHaveLength(1024);
    expect([d.headerEditsDropped, d.indeterminate]).toEqual([0, false]);
  });

  it("leaves an unknown delete match disclosed without claiming a definite edit was dropped", () => {
    const d = exec('deleteheader :matches "subject" "*zzz";', LONG, { maxMatchInputLength: 16 });
    expect(d.headerEdits).toEqual([]);
    expect([d.headerEditsDropped, d.indeterminate, d.guessAfter]).toEqual([0, true, false]);
    expect([...d.uncertainHeaders]).toEqual(["subject"]);
  });

  it("copies the count into a clone without sharing subsequent increments", () => {
    const d = exec(`${MARK} addheader "\${name}" "value";`, LONG);
    const clone = d.clone(load(`${REQ} deleteheader "\${name}";`, { enabledExtensions: ALL_EXTENSIONS }));
    expect(clone.headerEditsDropped).toBe(1);
    clone.script.execute(clone);
    expect([d.headerEditsDropped, clone.headerEditsDropped]).toEqual([1, 2]);
  });
});
