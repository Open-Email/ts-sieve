// How many redirects the engine dropped (ts-sieve #70).
//
// The engine drops a redirect itself in two places: one to an address built
// from a value it could not hold whole (a cut prefix, a capture an unknown
// doubted; see disclose-per-value.test.ts), and one past maxRedirects. Both
// set indeterminate, which says the run guessed, not that a forward did not
// go, or how many. The host never sees these addresses, so it could not count
// them with the forwards it withholds itself (core's meta.sieve.withheld):
// redirectsDropped does. A redirect the host's own policy refused is its own
// decision, and a repeat of a target held is no new target: neither is a
// drop. fileintosDropped counts the fileintos dropped past maxFileintos.
//
// Both count commands run, not addresses or names: in a loop one command is
// dropped once per iteration.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type PolicyReader, type RuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const CORE = { maxMatchInputLength: 16 * 1024 };

function exec(script: string, message: string, options: Record<string, number> = {}, policy: PolicyReader = new DummyPolicy()): RuntimeData {
  const { headers, size, body } = parseEml(message);
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS, ...CORE, ...options });
  const d = newRuntimeData(s, policy, new EnvelopeStatic("from@test.com", "to@test.com"), new MessageStatic(size, headers, body));
  s.execute(d);
  return d;
}

/** A multipart of `n` text parts under `headers`: a loop runs n + 1 times. */
function parts(n: number, headers = ""): string {
  let body = "";
  for (let j = 0; j < n; j++) body += `--b\r\nX-N: p${j}\r\nContent-Type: text/plain\r\n\r\nx\r\n`;
  return `From: a@x\r\nTo: b@y\r\n${headers}Subject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
}

const plain = "From: a@x\r\nTo: b@y\r\nSubject: s\r\n\r\nbody\r\n";
/** An X-To past maxVariableLen (4000): stored, it is a prefix of the real one. */
const LONG_TO = `X-To: ${"u".repeat(4500)}@example.com\r\n`;
const longTo = `From: a@x\r\nTo: b@y\r\n${LONG_TO}Subject: s\r\n\r\nbody\r\n`;
const STORE = 'if header :matches "x-to" "*" { set "a" "${1}"; }';
const result = (d: RuntimeData) => [d.redirectAddr, d.redirectsDropped, d.indeterminate];

describe("redirectsDropped", () => {
  it("is 0 when every redirect goes, or none runs", () => {
    expect(result(exec('redirect "a@x.test";', plain))).toEqual([["a@x.test"], 0, false]);
    expect(result(exec("keep;", plain))).toEqual([[], 0, false]);
  });

  it("counts a redirect to a value cut to its size limit", () => {
    const d = exec(`require ["variables"]; ${STORE} redirect "\${a}";`, longTo);
    expect(result(d)).toEqual([[], 1, true]);
  });

  it("counts a redirect to a capture an unknown doubted (#69)", () => {
    const m = `From: a@x\r\nTo: b@y\r\nX-A: alice\r\nSubject: ${"x".repeat(20_000)}\r\n\r\nbody\r\n`;
    const d = exec('require ["variables"]; if header :matches "x-a" "*" {} if header :matches "subject" "*zzz" {} redirect "${1}@x.test";', m);
    expect(result(d)).toEqual([[], 1, true]);
  });

  it("counts each redirect past maxRedirects", () => {
    const seven = Array.from({ length: 7 }, (_, i) => `redirect "u${i}@x.test";`).join(" ");
    const d = exec(seven, plain);
    expect([d.redirectAddr.length, d.redirectsDropped, d.indeterminate]).toEqual([5, 2, true]);
  });

  it("adds both kinds up in one run, and counts a redirect that is both once", () => {
    const d = exec(`require ["variables"]; ${STORE} redirect "\${a}"; redirect "a@x.test"; redirect "b@x.test"; redirect "c@x.test";`, longTo, { maxRedirects: 1 });
    expect(result(d)).toEqual([["a@x.test"], 3, true]);
    // Marked and past the limit: one redirect dropped.
    expect(result(exec(`require ["variables"]; ${STORE} redirect "\${a}";`, longTo, { maxRedirects: 0 }))).toEqual([[], 1, true]);
  });

  it("counts redirects run, not addresses: a loop drops one redirect once per iteration", () => {
    const REQ = 'require ["mime","foreverypart","variables"];';
    // The same marked address on each of the 4 iterations.
    const marked = exec(`${REQ} ${STORE} foreverypart { redirect "\${a}"; }`, parts(3, LONG_TO));
    expect(result(marked)).toEqual([[], 4, true]);
    // One literal address, never held, past a limit of none.
    const capped = exec(`${REQ} foreverypart { redirect "same@x.test"; }`, parts(3), { maxRedirects: 0 });
    expect(result(capped)).toEqual([[], 4, true]);
  });

  it("does not count a redirect the host's policy refused: that is the host's own decision", () => {
    const deny: PolicyReader = { redirectAllowed: () => false };
    expect(result(exec('redirect "a@x.test"; redirect "b@x.test";', plain, {}, deny))).toEqual([[], 0, false]);
  });

  it("does not count a repeat of a target held, at the limit or in a loop", () => {
    expect(result(exec('redirect "a@x.test"; redirect "a@X.TEST";', plain, { maxRedirects: 1 }))).toEqual([["a@x.test"], 0, false]);
    const loop = exec('require ["mime","foreverypart"]; foreverypart { redirect "same@x.test"; }', parts(3), { maxRedirects: 1 });
    expect(result(loop)).toEqual([["same@x.test"], 0, false]);
  });
});

describe("fileintosDropped", () => {
  const filed = (d: RuntimeData) => [d.mailboxes, d.fileintosDropped, d.indeterminate];

  it("counts each fileinto past maxFileintos, per fileinto run", () => {
    expect(filed(exec('require "fileinto"; fileinto "A"; fileinto "B"; fileinto "C";', plain, { maxFileintos: 1 }))).toEqual([["A"], 2, true]);
    const loop = exec('require ["mime","foreverypart","fileinto"]; foreverypart { fileinto "Same"; }', parts(3), { maxFileintos: 0 });
    expect(filed(loop)).toEqual([[], 4, true]);
  });

  it("does not count a repeat, a name built from a marked value (it is filed), or a redirect drop", () => {
    expect(filed(exec('require "fileinto"; fileinto "A"; fileinto "A";', plain, { maxFileintos: 1 }))).toEqual([["A"], 0, false]);
    const marked = exec(`require ["variables","fileinto"]; ${STORE} fileinto "\${a}";`, longTo);
    expect([marked.mailboxes.length, marked.fileintosDropped]).toEqual([1, 0]);
    const redirect = exec('require "fileinto"; redirect "a@x.test"; redirect "b@x.test"; fileinto "A";', plain, { maxRedirects: 1 });
    expect([redirect.redirectsDropped, redirect.fileintosDropped]).toEqual([1, 0]);
  });
});
