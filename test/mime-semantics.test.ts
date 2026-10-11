// RFC 5703 mime/foreverypart: Pigeonhole's loop tests, and the cases the
// review of #40 found the first cut of this port getting wrong.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDovecotInline } from "./dovecot/harness.js";
import { R, run } from "./harness.js";

describe("Pigeonhole extensions/mime/foreverypart.svtest", () => {
  it("Single loop and Double loop (the include test needs `include`)", () => {
    const file = path.join(import.meta.dirname, "corpus-src/tests/extensions/mime/foreverypart.svtest");
    let src = fs.readFileSync(file, "utf8").replace('require "include";\n', "");
    src = src.slice(0, src.indexOf('test "Double loop - include"'));
    const r = runDovecotInline(src);
    expect(r.report()).toBe("");
    expect(r.passed.length).toBe(2);
  });
});

describe(":param and RFC 2231", () => {
  const param = (name: string, value: string, ct: string) =>
    run(
      `require ["mime","fileinto"]; if header :mime :param "${name}" "content-type" "${value}" { fileinto "P"; }`,
      `From: a@x\r\nTo: b@y\r\nContent-Type: ${ct}\r\n\r\nx\r\n`,
    );

  it("an extended value whose name ends in a digit", () => {
    expect(param("name2", "€.pdf", "application/pdf; name2*=utf-8''%E2%82%AC.pdf")).toEqual(R({ fileinto: ["P"] }));
  });

  it("the charset of section 0 applies to every encoded section", () => {
    // "€" (E2 82 AC) split across two sections.
    expect(param("name", "€x", "application/pdf; name*0*=utf-8''%E2%82; name*1*=%ACx")).toEqual(R({ fileinto: ["P"] }));
  });

  it("plain and quoted sections join", () => {
    expect(param("name", "a long name", 'application/pdf; name*0="a long"; name*1=" name"')).toEqual(R({ fileinto: ["P"] }));
  });
});

describe("a message whose body the host did not read", () => {
  // A host may pass no body (bodyRaw() null) when the script needs none; core
  // reads it only for some scripts. A multipart root then has parts nobody
  // saw: misses are unknown, not definite.
  const noBody = "From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n";

  it("an :anychild miss under not does not fire", () => {
    const script = 'require ["mime","fileinto"]; if not header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "NoPdf"; }';
    expect(run(script, noBody)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("exists :mime :anychild is unknown", () => {
    const script = 'require ["mime","fileinto"]; if not exists :mime :anychild "content-disposition" { fileinto "NoDisp"; }';
    expect(run(script, noBody)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("a loop over it discloses the parts it never saw", () => {
    const script = 'require ["mime","foreverypart","fileinto"]; foreverypart { fileinto "Part"; }';
    expect(run(script, noBody)).toEqual(R({ fileinto: ["Part"], indeterminate: true }));
  });

  it("a single-part message without its body is complete", () => {
    const script = 'require ["mime","fileinto"]; if not header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "NoPdf"; }';
    expect(run(script, "From: a@x\r\nTo: b@y\r\nContent-Type: text/plain\r\n")).toEqual(R({ fileinto: ["NoPdf"] }));
  });
});

describe("the tree and the body test see the same parts", () => {
  const anyPdf = 'require ["mime","body","fileinto"]; if header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "Mime"; } if body :content "application/pdf" :contains "pdf" { fileinto "Body"; }';
  const pdfPart = "--q\r\nContent-Type: application/pdf\r\n\r\npdf\r\n--q--\r\n";

  it("a duplicated boundary parameter", () => {
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=p; boundary=q\r\n\r\n${pdfPart}`;
    const r = run(anyPdf, eml);
    expect(r.fileinto.includes("Mime")).toBe(r.fileinto.includes("Body"));
  });

  it("a duplicated Content-Type field in a part", () => {
    const eml = [
      "From: a@x",
      "To: b@y",
      "Content-Type: multipart/mixed; boundary=o",
      "",
      "--o",
      "Content-Type: multipart/mixed; boundary=p",
      "Content-Type: multipart/mixed; boundary=q",
      "",
      pdfPart,
      "--o--",
      "",
    ].join("\r\n");
    const r = run(anyPdf, eml);
    expect(r.fileinto.includes("Mime")).toBe(r.fileinto.includes("Body"));
  });
});

describe("structure the caps stop is open", () => {
  const anyPdf = 'require ["mime","fileinto"]; if not header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "NoPdf"; }';

  it("past the nesting cap", () => {
    let body = "";
    for (let i = 0; i < 101; i++) body += `--q${i}q\r\nContent-Type: multipart/mixed; boundary=q${i + 1}q\r\n\r\n`;
    body += "--q101q\r\nContent-Type: text/plain\r\n\r\nx\r\n--q101q--\r\n";
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=q0q\r\n\r\n${body}`;
    expect(run(anyPdf, eml)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("past the part cap", () => {
    let body = "";
    for (let i = 0; i < 1100; i++) body += "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n";
    const eml = `From: a@x\r\nTo: b@y\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n${body}--b--\r\n`;
    expect(run(anyPdf, eml)).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });

  it("a nested message cut inside its header", () => {
    const eml = "From: a@x\r\nTo: b@y\r\nContent-Type: message/rfc822\r\n\r\nFrom: c@d\r\nContent-Ty";
    expect(run(anyPdf, eml, { bodyTruncated: true })).toEqual(R({ implicitKeep: true, indeterminate: true }));
  });
});

describe("cut soundness, over random MIME trees", () => {
  // Every cut of every message: an answer the cut run gives definitely must be
  // the whole message's answer. (A port of the #40 review's fuzzer, smaller.)
  let seed = 11;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return (seed >>> 8) / 0x800000;
  };
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  let bid = 0;
  function gen(depth: number, eol: string): { head: string; body: string } {
    const r = rnd();
    const extra: string[] = [];
    if (rnd() < 0.3) extra.push(`Content-Disposition: ${pick(["attachment", "inline"])}; filename="${pick(["a.pdf", "b.png"])}"`);
    if (rnd() < 0.2) extra.push("X-Addr: a@b.c");
    const head = (lines: string[]) => lines.map((h) => h + eol).join("");
    if (depth < 3 && r < 0.35) {
      const b = `${pick(["b", "bd", "x"])}${bid++}`;
      let body = rnd() < 0.3 ? `preamble${eol}` : "";
      for (let i = 1 + Math.floor(rnd() * 3); i > 0; i--) {
        const c = gen(depth + 1, eol);
        body += `--${b}${eol}${c.head}${eol}${c.body}${eol}`;
      }
      body += `--${b}--${eol}`;
      if (rnd() < 0.3) body += `epilogue${eol}`;
      return { head: head([`Content-Type: multipart/${pick(["mixed", "alternative"])}; boundary="${b}"`, ...extra]), body };
    }
    if (depth < 3 && r < 0.45) {
      const c = gen(depth + 1, eol);
      return { head: head(["Content-Type: message/rfc822", ...extra]), body: `${c.head}${eol}${c.body}` };
    }
    if (r < 0.5) return { head: head(extra), body: `noheader${eol}` };
    return { head: head([`Content-Type: ${pick(["text/plain", "application/pdf", "image/png"])}`, ...extra]), body: `line${eol}--b0x${eol}more` };
  }

  const PRE = 'require ["mime","foreverypart","fileinto","variables","relational","comparator-i;ascii-numeric"];\n';
  const SCRIPTS = [
    'if not header :mime :anychild :contenttype "content-type" "application/pdf" { fileinto "NP"; }',
    'if not exists :mime :anychild "content-disposition" { fileinto "NE"; }',
    'if not header :mime :anychild :count "lt" :comparator "i;ascii-numeric" "content-type" "2" { fileinto "NLT2"; }',
    'if not address :mime :anychild :count "le" :comparator "i;ascii-numeric" "x-addr" "1" { fileinto "NA1"; }',
    'set "s" ""; foreverypart { if header :mime :contenttype :matches "content-type" "*" { set "s" "${s},${1}"; } } fileinto "x${s}";',
    'set "s" ""; foreverypart :name "o" { set "s" "${s}["; foreverypart { if header :mime :type "content-type" "image" { set "s" "${s}I"; break :name "o"; } set "s" "${s}."; } set "s" "${s}]"; } fileinto "x${s}";',
    'if not header :mime :anychild :param "filename" "content-disposition" "a.pdf" { fileinto "NF"; }',
  ];

  it("no definite answer on a cut differs from the whole message's", () => {
    const fails: string[] = [];
    let definite = 0;
    for (let m = 0; m < 40; m++) {
      const eol = rnd() < 0.7 ? "\r\n" : "\n";
      const root = gen(0, eol);
      const head = `From: a@x${eol}To: b@y${eol}Subject: hi${eol}${root.head}`;
      for (const sc of SCRIPTS) {
        const want = JSON.stringify({ ...run(PRE + sc, `${head}${eol}${root.body}`), indeterminate: false });
        for (let k = 0; k <= root.body.length; k++) {
          const got = run(PRE + sc, `${head}${eol}${root.body.slice(0, k)}`, { bodyTruncated: true });
          if (got.indeterminate) continue;
          definite++;
          const g = JSON.stringify({ ...got, indeterminate: false });
          if (g !== want && fails.length < 5) fails.push(`${sc}\ncut at ${k}: ${g}\nwhole: ${want}`);
        }
      }
    }
    expect(fails).toEqual([]);
    expect(definite).toBeGreaterThan(1000);
  });
});
