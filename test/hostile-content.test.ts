// Message content must never make execute() throw.
//
// A host treats a thrown execute() as "script failed" and falls back to the
// implicit keep (RFC 5228 §2.10.6) — so EVERY rule of the script is skipped,
// not only the test that tripped. If a sender can trigger that with the message
// they send, they can bypass a recipient's filtering at will. Script errors
// (budget, redirect caps, a malformed regex) may still throw; malformed mail
// may not. Structure this interpreter declines to walk (past the nesting and
// part caps) is "unknown", as a body cut by the host's read window is.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const kept = R({ keep: true, implicitKeep: true });
const b64 = (body: string) =>
  ["From: a@x", "To: b@y", "Subject: hi", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body].join(
    "\r\n",
  );

describe("malformed base64 decodes leniently", () => {
  it("a stray '=' mid-stream: the content before and after it still matches", () => {
    expect(run('require "body"; if body :contains "hello world" { keep; }', b64("aGVsbG8gd29ybGQ=Q"))).toEqual(kept);
  });

  it("a length of 4n+1 drops the dangling character", () => {
    expect(run('require "body"; if body :contains "hello" { keep; }', b64("aGVsbG8gd"))).toEqual(kept);
  });

  it("concatenated padded segments decode as one stream", () => {
    expect(run('require "body"; if body :contains "hello world" { keep; }', b64("aGVsbG8=IHdvcmxk"))).toEqual(kept);
  });

  it("characters outside the alphabet are skipped", () => {
    expect(run('require "body"; if body :contains "hello" { keep; }', b64("aGVs*bG8=\r\n"))).toEqual(kept);
  });

  it("the rest of the script still runs", () => {
    expect(
      run('require ["body","fileinto"]; if body :contains "zzz" { fileinto "X"; } fileinto "Y";', b64("aGVsbG8gd29ybGQ=Q")),
    ).toEqual(R({ fileinto: ["Y"] }));
  });
});

/** `depth` nested multipart/mixed levels with `leaf` as the innermost text,
 * which therefore sits at depth + 1. Boundaries "q<i>q" never prefix each
 * other ("b1" would prefix "b10"), so the nesting is what it claims to be. */
function nested(depth: number, leaf: string): string {
  let body = "";
  for (let i = 0; i < depth; i++) body += `--q${i}q\r\nContent-Type: multipart/mixed; boundary=q${i + 1}q\r\n\r\n`;
  body += `--q${depth}q\r\nContent-Type: text/plain\r\n\r\n${leaf}\r\n--q${depth}q--\r\n`;
  return `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=q0q\r\n\r\n${body}`;
}

/** One multipart/mixed with `n` text/plain parts; part `at` (0-based) holds `leaf`. */
function siblings(n: number, at: number, leaf: string): string {
  let body = "";
  for (let i = 0; i < n; i++) body += `--b\r\nContent-Type: text/plain\r\n\r\n${i === at ? leaf : `part ${i}`}\r\n`;
  return `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
}

// Dovecot's message parser limits (100 nested, 10000 parts in total — added
// for CVE-2020-12100). Legitimate mail stays far inside them; past them the
// structure is unknown, which lets a rule not fire but never throws.
describe("MIME nesting and part count are capped", () => {
  it("ordinary nesting is walked to the leaf", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', nested(10, "needle"))).toEqual(kept);
  });

  it("a leaf at depth 100 is walked; one at depth 101 is unknown", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', nested(99, "needle"))).toEqual(kept);
    expect(run('require "body"; if body :contains "needle" { keep; }', nested(100, "needle"))).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("the 10000th part is walked; the 10001st is unknown", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', siblings(10_001, 9_999, "needle"))).toEqual(
      kept,
    );
    expect(run('require "body"; if body :contains "needle" { keep; }', siblings(10_001, 10_000, "needle"))).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("nesting far past the cap neither throws nor matches: it is unknown", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', nested(20_000, "needle"))).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("an unknown under the cap does not invert a not-guarded discard", () => {
    expect(run('require "body"; if not body :contains "needle" { discard; }', nested(20_000, "needle"))).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });

  it("parts before the part cap match definitely", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', siblings(12_000, 5, "needle"))).toEqual(kept);
  });

  it("a part past the part cap is unknown, not a definite miss", () => {
    expect(run('require "body"; if body :contains "needle" { keep; }', siblings(12_000, 11_999, "needle"))).toEqual(
      R({ implicitKeep: true, indeterminate: true }),
    );
  });
});

describe(":matches captures over a large input", () => {
  it("a capture of half a megabyte does not overflow the call stack", () => {
    const eml = `From: a@x\r\nTo: b@y\r\n\r\n${"a".repeat(500_000)}`;
    expect(run('require "body"; if body :raw :matches "*" { keep; }', eml)).toEqual(kept);
  });
});
