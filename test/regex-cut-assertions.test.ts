// :regex over a cut input: an assertion at the cut.
//
// The engine cuts every :regex input, and a match over the cut input stands
// for the whole only when nothing past the cut could undo it. `$`, `\z`, `\b`
// and `\B` are decided by what follows the matched text: at the end of a cut
// input nothing follows, though the whole input goes on. Only `$` gave the
// answer up, and for any match. Now a match gives it up when it ends at the
// cut and the pattern has one of those assertions: anywhere else, they see
// the same characters in both inputs.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const CORE = { options: { maxMatchInputLength: 16 * 1024 } };
const B = String.fromCharCode(92);
/** A Sieve string literal holding regex source with `\x` escapes. */
const lit = (re: string) => re.replaceAll(B, B + B);
const subject = (s: string) => `From: a@x\r\nSubject: ${s}\r\n\r\nbody\r\n`;
/** A subject whose first 16 KiB end exactly after `head`, `tail` following. */
const atCut = (head: string, tail: string) => `${"x".repeat(16 * 1024 - head.length)}${head}${tail}`;
const rule = (test: string) => `require ["regex","body"]; if ${test} { discard; }`;

describe("a match that ends at the cut, with an assertion there, is unknown", () => {
  it("\\b", () => {
    const r = run(rule(`header :regex "subject" "${lit(`${B}bfree${B}b`)}"`), subject(atCut(" free", "dom")), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("\\z", () => {
    const r = run(rule(`header :regex "subject" "${lit(`free${B}z`)}"`), subject(atCut(" free", "dom")), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("\\B", () => {
    const r = run(rule(`header :regex "subject" "${lit(`-${B}B`)}"`), subject(atCut("-", "abc")), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("a multiline $", () => {
    const r = run(rule('header :regex "subject" "(?m)free$"'), subject(atCut(" free", "dom")), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });

  it("in the body", () => {
    const body = `${"y".repeat(16 * 1024 - 7)} casinos and more\r\n`;
    const r = run(rule(`body :text :regex "${lit(`${B}bcasino${B}b`)}"`), `From: a@x\r\nSubject: s\r\n\r\n${body}`, CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([true, true]);
  });
});

describe("a match that ends before the cut is definite, its assertions seeing what the whole input has", () => {
  it("\\b", () => {
    const r = run(rule(`header :regex "subject" "${lit(`${B}bfree${B}b`)}"`), subject(`a free gift ${"x".repeat(20_000)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("a match running into the cut with only a start anchor: ^ looks back", () => {
    const r = run(rule('header :regex "subject" "^x+"'), subject("x".repeat(20_000)), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("a \\b one character before the cut", () => {
    const r = run(rule(`header :regex "subject" "${lit(`${B}bfree${B}b`)}"`), subject(atCut(" free ", "dom")), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("a match that ran into the cut after its \\b was decided at the start", () => {
    // What decides is whether the match relied on such an assertion AT the
    // cut, not whether the pattern has one somewhere.
    const r = run(rule(`header :regex "subject" "${lit(`${B}bfree.*`)}"`), subject(`free ${"x".repeat(20_000)}`), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("a multiline ^ at the cut, right after a line's end: ^ looks back", () => {
    const body = `${"y".repeat(16 * 1024 - 4)}abc\nmore\n`;
    const r = run(rule(`body :raw :regex "${lit(`(?m)abc${B}n^`)}"`), `From: a@x\r\nSubject: s\r\n\r\n${body}`, CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("an assertion at the cut in a branch that did not win", () => {
    // "$" passes at the cut in the first alternative, which then needs a "z";
    // the empty one wins, having asserted nothing.
    const r = run(rule('header :regex "subject" "x+(?:$z|)"'), subject("x".repeat(20_000)), CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });

  it("a multiline $ at a line's end", () => {
    // LF: a multiline $ asserts before "\n", not "\r".
    const body = `abc\n${"y".repeat(20_000)}\n`;
    const r = run(rule('body :raw :regex "(?m)^abc$"'), `From: a@x\r\nSubject: s\r\n\r\n${body}`, CORE);
    expect([r.implicitKeep, r.indeterminate]).toEqual([false, false]);
  });
});
