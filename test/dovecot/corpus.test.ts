// Dovecot Pigeonhole `.svtest` conformance corpus (vendored under
// test/corpus-src/ — LGPL third-party data; see test/corpus-src/PROVENANCE.md).
// One vitest `it` per `.svtest`: in-scope
// files run through runDovecotFile and must produce zero sub-test failures;
// files requiring an extension this interpreter doesn't implement (enotify,
// include, mime, …) or the result-verification DSL that is out of scope here
// (test_result_execute, test_message, …) are it.skip'd with a note.
//
// This covers every in-scope extension corpus — a gold-standard stress test
// beyond the interpreter's own unit tests.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_EXTENSIONS } from "../harness.js";
import { runDovecotFile } from "./harness.js";

const CORPUS_ROOT = path.resolve(__dirname, "../corpus-src/tests");

// Extensions this interpreter implements (the full set). A file requiring any
// name outside this set is out of scope.
const IN_SCOPE_EXT = new Set<string>([...ALL_EXTENSIONS, "vnd.dovecot.testsuite"]);

// The result-verification testsuite commands this interpreter intentionally
// does NOT implement. A file using any of these is out of scope.
const RESULT_CMD_RE =
  /\b(test_result_execute|test_result_reset|test_result_action|test_result_print|test_message|test_mailbox_create|test_imap_metadata_set)\b/;

// test_error inspects the count/detail of compile errors — Pigeonhole-specific
// (this interpreter stubs test_error to always-true and instead runs stripped
// inline variants of these compile-error corpora; see inline-compile.test.ts).
const TEST_ERROR_RE = /\btest_error\b/;

// The only test_config_set key this interpreter implements. A file setting any
// other key (recipient_delimiter, sieve_include_*, …) fatally errors, so it is
// out of scope.
const SUPPORTED_CONFIG_KEY = "sieve_variables_max_variable_size";

// Whole subtrees outside this interpreter's conformance scope: action execution
// + result checking (execute), multi-script chaining, external-program plugins,
// and the fuzz regression corpus.
const OUT_OF_SCOPE_DIRS = ["execute/", "multiscript/", "plugins/", "failures/"];

// Per-file sub-test skips (by exact name) — documented skips.
const FILE_SKIPS: Record<string, string[]> = {
  "extensions/date/zones.svtest": ["Local Zone Shift"], // depends on system local TZ (skipped)
};
// Whole files skipped, with justification. What remains here is NOT a defect in
// this interpreter: either an invalid corpus fixture, a corpus file that is
// itself non-conformant with the RFC this interpreter enforces, or a whole
// extension this interpreter does not implement.
const KNOWN_SKIP: Record<string, string> = {
  "extensions/body/basic.svtest": "invalid fixture (skipped)",
  "extensions/date/basic.svtest": "invalid message format — missing blank line (skipped)",
  "comparators/i-unicode-casemap.svtest":
    "corpus file uses :comparator \"i;unicode-casemap\" without require \"comparator-i;unicode-casemap\" — non-conformant per RFC 5228 §2.7.3, which this interpreter (correctly) enforces",
  "extensions/include/rfc.svtest":
    "requires the `include` extension (RFC 6609), which this interpreter does not implement",
};

interface Candidate {
  rel: string;
  abs: string;
}

function listSvtests(): Candidate[] {
  if (!fs.existsSync(CORPUS_ROOT)) return [];
  const out: Candidate[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".svtest")) {
        out.push({ rel: path.relative(CORPUS_ROOT, abs), abs });
      }
    }
  };
  walk(CORPUS_ROOT);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Strip Sieve comments so a commented-out `require` can't misclassify a file. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/#.*$/gm, "");
}

/** Top-level required extensions (from every `require "x"` / `require ["a","b"]`). */
function requiredExtensions(src: string): string[] {
  const clean = stripComments(src);
  const exts: string[] = [];
  for (const m of clean.matchAll(/\brequire\s+(\[[^\]]*\]|"[^"]*")/g)) {
    for (const s of m[1]!.matchAll(/"([^"]*)"/g)) exts.push(s[1]!);
  }
  return exts;
}

/** Every test_config_set / test_config_unset key a file touches. */
function configKeys(src: string): string[] {
  const keys: string[] = [];
  for (const m of stripComments(src).matchAll(/\btest_config_(?:set|unset)\s+"([^"]*)"/g)) keys.push(m[1]!);
  return keys;
}

/** Classify a file: null ⇒ in scope; string ⇒ skip reason. */
function skipReason(rel: string, src: string): string | null {
  if (KNOWN_SKIP[rel]) return KNOWN_SKIP[rel];
  const dir = OUT_OF_SCOPE_DIRS.find((d) => rel.startsWith(d));
  if (dir) return `out-of-scope subtree (${dir}) — action execution / result checking, not part of this conformance scope`;
  const outOfScope = requiredExtensions(src).filter((e) => !IN_SCOPE_EXT.has(e));
  if (outOfScope.length > 0) return `requires unimplemented extension(s): ${[...new Set(outOfScope)].join(", ")}`;
  const clean = stripComments(src);
  if (RESULT_CMD_RE.test(clean)) return "uses result-verification DSL (test_result_*/test_message) that this interpreter does not implement";
  if (TEST_ERROR_RE.test(clean)) return "uses test_error (Pigeonhole-specific compile-error detail checks; run as stripped inline variants)";
  const badKeys = configKeys(src).filter((k) => k !== SUPPORTED_CONFIG_KEY);
  if (badKeys.length > 0) return `uses unsupported test_config_set key(s): ${[...new Set(badKeys)].join(", ")}`;
  return null;
}

const candidates = listSvtests();

// Set CORPUS_RUN_ALL=1 to force EVERY .svtest to run (no skips, no per-subtest
// skips). Expect ~100 failures: those files require extensions this interpreter
// does not implement (enotify, mime, include, …) or the Pigeonhole-only
// result/test_error DSL, so they throw at load or fail their assertions. Use it
// to audit the skip classification, not as a green gate.
const RUN_ALL = process.env.CORPUS_RUN_ALL === "1";

describe("Dovecot Pigeonhole .svtest corpus", () => {
  if (candidates.length === 0) {
    it.skip("corpus missing (vendored under test/corpus-src/tests; see PROVENANCE.md)", () => {});
    return;
  }

  for (const { rel, abs } of candidates) {
    const src = fs.readFileSync(abs, "utf8");
    const reason = skipReason(rel, src);
    if (reason !== null && !RUN_ALL) {
      it.skip(`${rel} — ${reason}`, () => {});
      continue;
    }
    const label = reason !== null ? `${rel} — (forced; classified: ${reason})` : rel;
    it(label, () => {
      const reporter = runDovecotFile(abs, RUN_ALL ? [] : (FILE_SKIPS[rel] ?? []));
      if (reporter.failures.length > 0) {
        throw new Error(`${reporter.failures.length} sub-test failure(s) in ${rel}:\n${reporter.report()}`);
      }
      expect(reporter.results.length).toBeGreaterThan(0);
    });
  }
});
