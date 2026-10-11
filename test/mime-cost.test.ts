// The work a :mime test or a foreverypart loop does per part is charged to the
// step budget, so a message cannot make it burn CPU the budget does not see.
//
// The first cut of this port parsed every value of every part in scope on
// every evaluation, uncharged: inside nested loops, a 1 MB message of nested
// multiparts with one huge Content-Type parameter took 26 s at core's options.
// Values are parsed once per message now, a MIMEOPT that needs no parameter
// reads only the text before the first ";", and each part examined and each
// value read costs steps.

import { describe, expect, it } from "vitest";
import { run } from "./harness.js";

const CORE = { options: { maxExecSteps: 200_000, maxMatchInputLength: 16 * 1024 } };

/** `depth` nested multiparts, the innermost holding `leaves` text parts, the
 * last with a `bigLen`-character Content-Type parameter. */
function chain(depth: number, leaves: number, bigLen: number): string {
  let body = "";
  for (let i = 1; i <= depth; i++) body += `--b${i - 1}\r\nContent-Type: multipart/mixed; boundary=b${i}\r\n\r\n`;
  for (let j = 0; j < leaves; j++) {
    const big = j === leaves - 1 && bigLen > 0 ? `; x="${"a;".repeat(bigLen / 2)}"` : "";
    body += `--b${depth}\r\nContent-Type: text/plain${big}\r\n\r\nx\r\n`;
  }
  for (let i = depth; i >= 0; i--) body += `--b${i}--\r\n`;
  return `From: a@x\r\nTo: b@y\r\nSubject: hi\r\nContent-Type: multipart/mixed; boundary=b0\r\n\r\n${body}`;
}

function within(ms: number, f: () => unknown): void {
  const t0 = performance.now();
  f();
  expect(performance.now() - t0).toBeLessThan(ms);
}

describe("loops over a deep tree with a huge header value", () => {
  const big = chain(98, 1, 1_000_000);
  const req = 'require ["mime","foreverypart","fileinto"];';

  it("two nested loops, :anychild :contenttype", () => {
    within(2000, () =>
      run(`${req} foreverypart { foreverypart { if header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "A"; } } } fileinto "After";`, big, CORE),
    );
  });

  it("three nested loops, :type", () => {
    within(2000, () =>
      run(`${req} foreverypart { foreverypart { foreverypart { if header :mime :type "content-type" "application" { fileinto "A"; } } } } fileinto "After";`, big, CORE),
    );
  });

  it("the default MIMEOPT decodes each value once, however many loops read it", () => {
    within(2000, () =>
      run(`${req} foreverypart { foreverypart { if header :mime :anychild :contains "content-type" "pdf" { fileinto "A"; } } } fileinto "After";`, big, CORE),
    );
  });
});

describe("many parts, four nested loops", () => {
  it("absent headers are still charged per part", () => {
    const small = chain(98, 60, 0);
    const names = Array.from({ length: 8 }, (_, i) => `"x-none-${i}"`).join(",");
    const script = `require ["mime","foreverypart","fileinto"];
      foreverypart { foreverypart { foreverypart { foreverypart { if header :mime :anychild :contains [${names}] "z" { fileinto "A"; } } } } }
      fileinto "After";`;
    within(1000, () => expect(run(script, small, CORE).fileinto).toEqual(["After"]));
  });
});
