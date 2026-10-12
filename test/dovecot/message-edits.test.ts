// #95: virtual edits belong to the fixture they changed. Replacing that
// fixture must also invalidate reads cached from its edit ledger.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../../src/index.js";
import { getHeader } from "../../src/interp/header.js";
import { ALL_EXTENSIONS, parseEml, parts } from "../harness.js";
import { Reporter } from "./harness.js";

const REQ = 'require ["vnd.dovecot.testsuite", "editheader", "variables", "foreverypart", "body"];';
const NEXT = 'test_set "message" "Subject: second\r\n\r\nnewbody";';

function script(commands: string) {
  return load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, testEnv: new Reporter() });
}

function exec(commands: string, message = "Subject: first\r\n\r\noldbody") {
  const s = script(commands);
  const { size, headers, body } = parseEml(message);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(size, headers, body));
  s.execute(d);
  return d;
}

describe("test_set message edit isolation (#95)", () => {
  it("removes earlier adds without erasing script variables", () => {
    const d = exec(`set "saved" "keep me"; addheader "X-Old" "leaked"; ${NEXT}`);
    expect(getHeader(d, "x-old")).toEqual([]);
    expect(d.variables.get("saved")).toBe("keep me");
    expect([d.headerEdits.length, d.headerEditBytes]).toEqual([0, 0]);
  });

  it("does not apply an earlier delete to the replacement's header", () => {
    const d = exec(`deleteheader "Subject"; ${NEXT}`);
    expect(getHeader(d, "subject")).toEqual(["second"]);
  });

  it("invalidates a cached read even when the new ledger has the same length", () => {
    const d = exec(`addheader "X-Tag" "old";
      if header :is "X-Tag" "old" { set "primed" "yes"; }
      ${NEXT} addheader "X-Tag" "new";
      if header :is "X-Tag" "new" { set "fresh" "yes"; }`);
    expect(d.variables.get("primed")).toBe("yes");
    expect(d.variables.get("fresh")).toBe("yes");
    expect(getHeader(d, "x-tag")).toEqual(["new"]);
  });

  it("keeps only the latest fixture's edits after repeated replacements", () => {
    const d = exec(["one", "two", "three"].map((value) => `${NEXT}
      addheader "X-Tag" "${value}";
      if header :is "X-Tag" "${value}" { set "seen" "${value}"; }`).join("\n"));
    expect(d.variables.get("seen")).toBe("three");
    expect(getHeader(d, "x-tag")).toEqual(["three"]);
    expect([d.headerEdits.length, d.headerEditBytes]).toEqual([1, 5]);
  });

  it("restores edit capacity while retaining earlier drop diagnostics and spent budget", () => {
    const d = exec(`${'addheader "X-Fill" "x";'.repeat(1025)} ${NEXT} addheader "X-New" "accepted";`);
    expect(getHeader(d, "x-new")).toEqual(["accepted"]);
    expect(getHeader(d, "x-fill")).toEqual([]);
    expect([d.headerEdits.length, d.headerEditsDropped, d.indeterminate, d.guessAfter]).toEqual([1, 1, true, true]);
    expect(d.script.opts.maxExecSteps - d.budget.remaining).toBeGreaterThan(1025);
  });

  it("restores the retained-value allowance for the replacement", () => {
    // Root + 255 parts fill the old fixture's 1 MiB allowance exactly.
    const d = exec(`foreverypart { addheader "X-Large" "${"x".repeat(4096)}"; }
      addheader "X-Overflow" "dropped"; ${NEXT} addheader "X-New" "accepted";`, parts(255));
    expect(getHeader(d, "x-new")).toEqual(["accepted"]);
    expect([d.headerEdits.length, d.headerEditBytes, d.headerEditsDropped]).toEqual([1, 8, 1]);
  });

  it("replaces a cloned fixture without altering its parent's edits or cached reads", () => {
    const parent = exec('addheader "X-Tag" "parent";');
    expect(getHeader(parent, "x-tag")).toEqual(["parent"]);
    const child = parent.clone(script(`${NEXT} addheader "X-Tag" "child";`));
    child.script.execute(child);
    expect(getHeader(child, "x-tag")).toEqual(["child"]);
    expect(getHeader(parent, "x-tag")).toEqual(["parent"]);
  });

  it("uses the replacement's body after an earlier cached body read", () => {
    const d = exec(`if body :contains "oldbody" { set "primed" "yes"; }
      ${NEXT}
      if body :contains "newbody" { set "fresh" "yes"; }
      if body :contains "oldbody" { set "stale" "yes"; }`);
    expect(d.variables.get("primed")).toBe("yes");
    expect(d.variables.get("fresh")).toBe("yes");
    expect(d.variables.has("stale")).toBe(false);
  });
});
