// Pigeonhole's compile-error fixtures for mime and foreverypart, one case at a
// time. errors.svtest checks only the total error count of each file (through
// test_error, which this interpreter stubs), so each "# No error" / "# N: …"
// case of a fixture is compiled on its own here: a no-error case must load,
// every numbered case must not.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./harness.js";

const DIR = path.join(import.meta.dirname, "corpus-src/tests/extensions/mime/errors");

interface Case {
  label: string;
  ok: boolean;
  src: string;
}

/** Split a fixture at its case markers. A marker indented inside a block takes
 * the block's opening line (e.g. `foreverypart :name "frop" {`) as its wrapper. */
function cases(file: string): Case[] {
  const text = fs.readFileSync(path.join(DIR, file), "utf8");
  const requires = text.match(/^require [^\n]*;$/gm)?.join("\n") ?? "";
  const lines = text.split("\n");
  const out: Case[] = [];
  let wrapper = "";
  let cur: { label: string; ok: boolean; body: string[]; wrapper: string } | null = null;
  const flush = () => {
    if (!cur) return;
    let body = cur.body.join("\n");
    // The last case inside a block also holds the block's closing brace.
    const opens = (body.match(/{/g) ?? []).length;
    const closes = (body.match(/}/g) ?? []).length;
    if (closes > opens) body = body.slice(0, body.lastIndexOf("}"));
    const src = cur.wrapper ? `${requires}\n${cur.wrapper}\n${body}\n}` : `${requires}\n${body}`;
    out.push({ label: `${file} case ${out.length + 1} (${cur.label})`, ok: cur.ok, src });
    cur = null;
  };
  for (const line of lines) {
    const m = /^(\s*)# (No error\s*|(\d+):.*)$/.exec(line);
    if (m) {
      flush();
      cur = { label: m[2]!.trim(), ok: m[2]!.startsWith("No error"), body: [], wrapper: m[1] ? wrapper : "" };
      continue;
    }
    if (/^\S.*{\s*$/.test(line) && !cur) {
      wrapper = line; // a top-level block opened before any case: its cases nest in it
      continue;
    }
    if (cur) cur.body.push(line);
    else if (/^}/.test(line)) wrapper = "";
  }
  flush();
  return out;
}

describe("Pigeonhole mime/errors fixtures, case by case", () => {
  for (const file of [
    "header-mime-tag.sieve",
    "address-mime-tag.sieve",
    "exists-mime-tag.sieve",
    "foreverypart.sieve",
    "break.sieve",
  ]) {
    const all = cases(file);
    it(`${file}: the fixture splits into cases`, () => {
      expect(all.length).toBeGreaterThan(5);
      expect(all.some((c) => c.ok)).toBe(true);
      expect(all.some((c) => !c.ok)).toBe(true);
    });
    for (const c of all) {
      it(c.label, () => {
        if (c.ok) expect(() => compile(c.src), c.src).not.toThrow();
        else expect(() => compile(c.src), c.src).toThrow();
      });
    }
  }

  it("limits.sieve: foreverypart nests at most four deep", () => {
    const src = fs.readFileSync(path.join(DIR, "limits.sieve"), "utf8");
    expect(() => compile(src)).toThrow(/nest/);
    expect(() =>
      compile('require "foreverypart"; foreverypart { foreverypart { foreverypart { foreverypart { keep; } } } }'),
    ).not.toThrow();
  });
});
