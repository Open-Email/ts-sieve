// #81: refusing an incomplete redirect address must not make a reject look
// conflict-free when the whole address could have delivered the message.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options, type PolicyReader } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const REQ = 'require ["variables", "reject", "ereject", "copy", "fileinto"];';
const STORE = 'if header :matches "x-address" "*" { set "addr" "${1}"; }';
const FORWARD = 'redirect "${addr}";';
const MSG = 'X-Address: alice@example.net\r\n\r\nbody';

function exec(commands: string, opts: Options = {}, policy: PolicyReader = new DummyPolicy()) {
  const s = load(`${REQ} ${STORE} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, maxVariableLen: 8, ...opts });
  const { headers, size, body } = parseEml(MSG);
  const d = newRuntimeData(s, policy, new EnvelopeStatic("sender@x", "recipient@y"), new MessageStatic(size, headers, body));
  s.execute(d);
  return d;
}

describe("reject beside a redirect to a marked address (#81)", () => {
  for (const kind of ["reject", "ereject"]) {
    for (const copy of ["", ":copy "]) {
      for (const first of [true, false]) {
        const redirect = `redirect ${copy}"\${addr}";`;
        const reject = `${kind} "no";`;
        const commands = first ? `${redirect} ${reject}` : `${reject} ${redirect}`;

        it(`${kind}, ${copy || "no copy"}, redirect ${first ? "before" : "after"}`, () => {
          const d = exec(commands);
          expect(d.redirectAddr).toEqual([]);
          expect([d.redirectsDropped, d.rejected, d.rejectConflict, d.indeterminate, d.implicitKeep]).toEqual([1, true, "redirect", true, true]);
          // The same script with enough variable space actually holds the
          // target and reports the same conflict.
          const whole = exec(commands, { maxVariableLen: 128 });
          expect([whole.redirectAddr, whole.rejectConflict]).toEqual([["alice@example.net"], "redirect"]);
        });

        it(`strict: ${kind}, ${copy || "no copy"}, redirect ${first ? "before" : "after"}`, () => {
          expect(() => exec(commands, { strictReject: true })).toThrow(/conflicts with the redirect action/);
        });
      }
    }
  }

  it("keeps a later definite delivery and conflict precedence", () => {
    const d = exec(`${FORWARD} reject "no"; fileinto "Archive";`);
    expect([d.mailboxes, d.rejectConflict, d.indeterminate]).toEqual([["Archive"], "fileinto", true]);
  });

  it("does not invent a conflict when redirects are disabled, even for a marked address", () => {
    for (const redirect of [FORWARD, 'redirect "alice@example.net";']) {
      const d = exec(`${redirect} reject "no";`, { maxRedirects: 0 });
      expect([d.redirectsDropped, d.rejectConflict, d.implicitKeep]).toEqual([1, "", false]);
    }
  });

  it("does not invent a conflict for a whole address the policy refused", () => {
    const d = exec(`${FORWARD} reject "no";`, { maxVariableLen: 128 }, { redirectAllowed: () => false });
    expect([d.redirectsDropped, d.rejectConflict, d.implicitKeep, d.indeterminate]).toEqual([0, "", false, false]);
  });

  it("does not send a marked address to policy or invent a reject when none ran", () => {
    let asked = 0;
    const d = exec(FORWARD, {}, { redirectAllowed: () => (++asked, true) });
    expect([asked, d.rejected, d.rejectConflict, d.redirectsDropped]).toEqual([0, false, "", 1]);
  });

  it("ignores a redirect in an unexecuted arm", () => {
    const d = exec(`if false { ${FORWARD} } reject "no";`);
    expect([d.rejectConflict, d.redirectsDropped, d.implicitKeep, d.indeterminate]).toEqual(["", 0, false, false]);
  });

  it("preserves the possible redirect in a clone, without leaking child state to the parent", () => {
    const d = exec(FORWARD);
    const reject = load('require "reject"; reject "no";', { enabledExtensions: ALL_EXTENSIONS });
    const clone = d.clone(reject);
    reject.execute(clone);
    expect([clone.rejectConflict, clone.implicitKeep, d.rejected, d.rejectConflict]).toEqual(["redirect", true, false, ""]);

    const parent = exec("");
    const childScript = load(`${REQ} ${FORWARD} reject "no";`, { enabledExtensions: ALL_EXTENSIONS });
    const child = parent.clone(childScript);
    childScript.execute(child);
    const untouched = parent.clone(reject);
    reject.execute(untouched);
    expect([child.rejectConflict, untouched.rejectConflict, untouched.implicitKeep]).toEqual(["redirect", "", false]);
  });
});
