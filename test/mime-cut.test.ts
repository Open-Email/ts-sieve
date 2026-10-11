// RFC 5703 mime and foreverypart over a body the host's read window cut, and
// under the step budget.
//
// Pigeonhole and go-sieve read whole messages; a host here may read a prefix
// (Message.bodyTruncated). Every part the prefix does not show comes after
// every part it does, in document order, so:
// - a :mime test of the current part reads its header, which a part only gets
//   once its header block is complete: definite;
// - an :anychild miss is "unknown" when the subtree may go on past the cut, a
//   hit is definite;
// - a foreverypart loop that runs to the end of an open part list may have
//   missed iterations: `indeterminate`. One that breaks before the end did not.
// foreverypart is also the first loop, so its iterations are budgeted: one
// that runs out stops, discloses it, and the script goes on.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const CUT = { bodyTruncated: true };

/** multipart/mixed: a text/plain part, then a part of type `second`; `close`
 * ends the multipart, otherwise the cut falls inside the second part. */
function mixed(second: string, close: boolean): string {
  const tail = close ? "--b--\r\n" : "";
  return [
    "From: a@x",
    "To: b@y",
    "Subject: hi",
    "Content-Type: multipart/mixed; boundary=b",
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "hello",
    "--b",
    `Content-Type: ${second}`,
    "",
    `content${tail ? "\r\n" : ""}${tail}`,
  ].join("\r\n");
}

describe(":mime over a cut body", () => {
  const anyPdf = 'require ["mime","fileinto"]; if header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "Pdf"; }';

  it("an :anychild hit is definite", () => {
    expect(run(anyPdf, mixed("application/pdf", false), CUT)).toEqual(R({ fileinto: ["Pdf"] }));
  });

  it("an :anychild miss is unknown while the multipart may go on", () => {
    expect(run(anyPdf, mixed("image/png", false), CUT)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("not-guarded, the miss does not fire", () => {
    const script = 'require ["mime","fileinto"]; if not header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "NoPdf"; }';
    expect(run(script, mixed("image/png", false), CUT)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("a part cut inside its header is not yet a part", () => {
    // "Content-Type: application/pdf" may go on as "application/pdfx".
    const eml = "From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/pdf";
    expect(run(anyPdf, eml, CUT)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("with the close delimiter in view, the miss is definite", () => {
    expect(run(anyPdf, mixed("image/png", true), CUT)).toEqual(R({ implicitKeep: true }));
  });

  it("the current part alone (no :anychild) reads complete headers: definite", () => {
    const script = 'require ["mime","fileinto"]; if not header :mime :subtype "content-type" "mixed" { fileinto "NotMixed"; }';
    expect(run(script, mixed("image/png", false), CUT)).toEqual(R({ implicitKeep: true }));
  });

  it("exists :mime :anychild: found is definite, not found is unknown", () => {
    const found = 'require ["mime","fileinto"]; if exists :mime :anychild "content-type" { fileinto "F"; }';
    expect(run(found, mixed("image/png", false), CUT)).toEqual(R({ fileinto: ["F"] }));
    const missing = 'require ["mime","fileinto"]; if exists :mime :anychild "content-disposition" { fileinto "F"; }';
    expect(run(missing, mixed("image/png", false), CUT)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });
});

describe("foreverypart over a cut body", () => {
  const count = `require ["foreverypart","mime","variables","fileinto"];
    foreverypart { if header :mime :subtype "content-type" "plain" { fileinto "Plain"; } }`;

  it("a loop over an open part list discloses the iterations it may have missed", () => {
    expect(run(count, mixed("image/png", false), CUT)).toEqual(R({ fileinto: ["Plain"], indeterminate: true }));
  });

  it("over a complete list it is definite", () => {
    expect(run(count, mixed("image/png", true), CUT)).toEqual(R({ fileinto: ["Plain"] }));
  });

  it("a break before the end is definite", () => {
    const script = `require ["foreverypart","mime","fileinto"];
      foreverypart { if header :mime :subtype "content-type" "plain" { fileinto "Plain"; break; } }`;
    expect(run(script, mixed("image/png", false), CUT)).toEqual(R({ fileinto: ["Plain"] }));
  });
});

describe("foreverypart under the step budget", () => {
  /** multipart/mixed with `n` empty text/plain parts. */
  function many(n: number): string {
    let body = "";
    for (let i = 0; i < n; i++) body += "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    return `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
  }

  it("iterations that run out of budget stop the loop, not the script", () => {
    const inner = Array.from({ length: 40 }, (_, i) => `if header :mime :contains "content-type" "z${i}" { fileinto "Z${i}"; }`).join(" ");
    const script = `require ["foreverypart","mime","fileinto"];
      foreverypart { ${inner} }
      if header :contains "subject" "hi" { fileinto "Hi"; }`;
    const r = run(script, many(1000), { options: { maxExecSteps: 20_000 } });
    expect(r).toEqual(R({ fileinto: ["Hi"], indeterminate: true }));
  });

  it("nested loops over many parts are bounded too", () => {
    const script = `require ["foreverypart","mime","fileinto"];
      foreverypart { foreverypart { foreverypart { if exists :mime "content-type" { keep; } } } }
      fileinto "After";`;
    const r = run(script, many(1000), { options: { maxExecSteps: 200_000 } });
    expect(r.fileinto).toEqual(["After"]);
  });
});
