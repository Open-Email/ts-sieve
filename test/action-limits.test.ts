// How many fileinto and redirect targets one execution may hold, and what
// happens past the limit.
//
// At top level the script bounds both: each command runs once. Inside a
// foreverypart loop the message does, one target per part (or per combination
// of parts in nested loops): a script filing attachments by filename filed one
// hostile message into 117,797 folders, and a host that creates what a script
// files into (core does, up to its label cap) creates them. A redirect past
// maxRedirects threw, which fails the whole script, and a host's fail-open
// turns that into every rule skipped: a loop redirecting once per matching part
// threw on the sixth.
//
// A target past the limit is dropped and disclosed as indeterminate, so the
// host refuses the irreversible outcomes and the rest of the script stands. A
// target the execution already holds is no new target, so a loop filing or
// redirecting to one name is never limited.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type RuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS, R, run } from "./harness.js";

/** A multipart of `parts` text parts, each with its own X-N. */
function parts(n: number): string {
  let body = "";
  for (let j = 0; j < n; j++) body += `--b\r\nX-N: p${j}\r\nContent-Type: text/plain\r\n\r\nx\r\n`;
  return `From: a@x\r\nTo: b@y\r\nSubject: s\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
}

const REQ = 'require ["mime","foreverypart","fileinto","variables","copy"];';

describe("fileinto", () => {
  it("holds at most maxFileintos distinct targets; the rest are dropped and disclosed", () => {
    const script = `${REQ} foreverypart { if header :mime :matches "x-n" "*" { fileinto "F/\${1}"; } }`;
    const r = run(script, parts(40));
    expect(r.fileinto).toEqual(Array.from({ length: 32 }, (_, j) => `F/p${j}`));
    expect(r.indeterminate).toBe(true);
  });

  it("a target already held is not a new one", () => {
    const script = `${REQ} foreverypart { fileinto "Same"; }`;
    expect(run(script, parts(100))).toEqual(R({ fileinto: ["Same"] }));
  });

  it("is an option", () => {
    const script = `${REQ} foreverypart { if header :mime :matches "x-n" "*" { fileinto "F/\${1}"; } }`;
    expect(run(script, parts(40), { options: { maxFileintos: 40 } })).toMatchObject({ indeterminate: false });
    const three = run(script, parts(40), { options: { maxFileintos: 3 } });
    expect(three.fileinto).toEqual(["F/p0", "F/p1", "F/p2"]);
    expect(three.indeterminate).toBe(true);
  });

  it("a dropped target has no other effect", () => {
    // :create, :flags and the implicit keep belong to a target that was filed.
    const script = `require ["fileinto","copy","mailbox","imap4flags"];
      fileinto :copy "A"; fileinto :create :flags "\\\\Seen" "B";`;
    const s = load(script, { enabledExtensions: ALL_EXTENSIONS, maxFileintos: 1 });
    const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("a@x", "b@y"), new MessageStatic(0, new Map(), null));
    s.execute(d);
    expect([d.mailboxes, d.mailboxesCreate, d.flags, d.implicitKeep, d.indeterminate]).toEqual([["A"], [], [], true, true]);
  });
});

describe("redirect", () => {
  it("past maxRedirects, a redirect is dropped and disclosed, not thrown", () => {
    const six = Array.from({ length: 6 }, (_, i) => `redirect "u${i}@x.com";`).join(" ");
    const r = run(`require ["fileinto"]; ${six} fileinto "After";`);
    expect(r.redirect).toEqual(["u0@x.com", "u1@x.com", "u2@x.com", "u3@x.com", "u4@x.com"]);
    expect(r.fileinto).toEqual(["After"]);
    expect(r.indeterminate).toBe(true);
  });

  it("in a loop, one address is redirected to once, however many parts match", () => {
    const script = `${REQ} foreverypart { if header :mime :contains "x-n" "p" { redirect "sec@x.com"; } } fileinto "After";`;
    expect(run(script, parts(20))).toEqual(R({ redirect: ["sec@x.com"], fileinto: ["After"] }));
  });

  it("an address is the same whatever its display name, brackets or domain case", () => {
    const script = 'redirect "stephan@example.com"; redirect "Stephan Bosch <stephan@EXAMPLE.com>"; redirect " <stephan@example.com> ";';
    expect(run(script).redirect).toEqual(["stephan@example.com"]);
    // The local part is the receiving domain's to interpret: not folded.
    expect(run('redirect "a@x.com"; redirect "A@x.com";').redirect).toEqual(["a@x.com", "A@x.com"]);
  });

  it("a repeat asks the host's policy nothing: it may count what it allows", () => {
    let asked = 0;
    const policy = new (class extends DummyPolicy {
      override redirectAllowed(): boolean {
        asked++;
        return true;
      }
    })();
    const s = load('redirect "a@x.com"; redirect "a@x.com"; redirect "b@x.com";', { enabledExtensions: [], maxRedirects: 1 });
    const d: RuntimeData = newRuntimeData(s, policy, new EnvelopeStatic(), new MessageStatic(0, new Map(), null));
    s.execute(d);
    // The repeat is no new target; b@x.com is past the limit, dropped before the policy.
    expect([asked, d.redirectAddr, d.indeterminate]).toEqual([1, ["a@x.com"], true]);
  });

  it("a repeat without :copy still cancels the implicit keep", () => {
    const r = run('require ["copy"]; redirect :copy "a@x.com"; redirect "a@x.com";');
    expect([r.redirect, r.implicitKeep]).toEqual([["a@x.com"], false]);
  });
});

describe("the loop that threw", () => {
  it("redirecting once per matching part, to the part's own address, keeps the rest of the script", () => {
    const script = `${REQ} foreverypart { if header :mime :matches "x-n" "*" { redirect "\${1}@x.com"; } } fileinto "After";`;
    const r = run(script, parts(10));
    expect(r.redirect).toHaveLength(5);
    expect(r.fileinto).toEqual(["After"]);
    expect(r.indeterminate).toBe(true);
  });
});

describe("a repeated fileinto", () => {
  it("without :copy still cancels the implicit keep", () => {
    const r = run('require ["fileinto","copy"]; fileinto :copy "A"; fileinto "A";');
    expect([r.fileinto, r.implicitKeep]).toEqual([["A"], false]);
  });
});
