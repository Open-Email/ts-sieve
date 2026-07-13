// Stripped-inline compile-error tests: inline variants of the corpus compile-
// error, recovery, and relational-error cases — with the Pigeonhole-specific
// test_error assertions removed — run instead of the full errors.svtest, because
// test_script_compile isolates the sub-script (enabledExtensions = []) so EVERY
// invalid script must fail to compile. This is the load-time half of the corpus
// (the .svtest error files are skipped in corpus.test.ts as test_error-driven).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "vitest";
import { dirNamespace, runDovecotInline } from "./harness.js";

const CORPUS_ROOT = path.resolve(__dirname, "../corpus-src/tests");
const hasCorpus = fs.existsSync(CORPUS_ROOT);

function runInDir(subdir: string, script: string): void {
  const r = runDovecotInline(script, dirNamespace(path.join(CORPUS_ROOT, subdir)));
  if (r.failures.length > 0) throw new Error(`sub-test failures:\n${r.report()}`);
}

describe.skipIf(!hasCorpus)("vnd.dovecot.testsuite inline — compile errors", () => {
  it("compile errors (stripped test_error)", () => {
    runInDir(
      "compile",
      `
require "vnd.dovecot.testsuite";
test "Lexer errors" {
	if test_script_compile "errors/lexer.sieve" { test_fail "compile should have failed."; }
}
test "Parser errors" {
	if test_script_compile "errors/parser.sieve" { test_fail "compile should have failed."; }
}
test "Header errors" {
	if test_script_compile "errors/header.sieve" { test_fail "compile should have failed."; }
}
test "Address errors" {
	if test_script_compile "errors/address.sieve" { test_fail "compile should have failed."; }
}
test "If errors" {
	if test_script_compile "errors/if.sieve" { test_fail "compile should have failed."; }
}
test "Require errors" {
	if test_script_compile "errors/require.sieve" { test_fail "compile should have failed."; }
}
test "Size errors" {
	if test_script_compile "errors/size.sieve" { test_fail "compile should have failed."; }
}
test "Envelope errors" {
	if test_script_compile "errors/envelope.sieve" { test_fail "compile should have failed."; }
}
test "Stop errors" {
	if test_script_compile "errors/stop.sieve" { test_fail "compile should have failed."; }
}
test "Keep errors" {
	if test_script_compile "errors/keep.sieve" { test_fail "compile should have failed."; }
}
test "Fileinto errors" {
	if test_script_compile "errors/fileinto.sieve" { test_fail "compile should have failed."; }
}
test "COMPARATOR errors" {
	if test_script_compile "errors/comparator.sieve" { test_fail "compile should have failed."; }
}
test "ADDRESS-PART errors" {
	if test_script_compile "errors/address-part.sieve" { test_fail "compile should have failed."; }
}
test "MATCH-TYPE errors" {
	if test_script_compile "errors/match-type.sieve" { test_fail "compile should have failed."; }
}
test "Encoded-character errors" {
	if test_script_compile "errors/encoded-character.sieve" { test_fail "compile should have failed."; }
}
test "Outgoing address errors" {
	if test_script_compile "errors/out-address.sieve" { test_fail "compile should have failed."; }
}
test "Tagged argument errors" {
	if test_script_compile "errors/tag.sieve" { test_fail "compile should have failed."; }
}
test "Typos" {
	if test_script_compile "errors/typos.sieve" { test_fail "compile should have failed."; }
}
test "Unsupported language features" {
	if test_script_compile "errors/unsupported.sieve" { test_fail "compile should have failed."; }
}
`,
    );
  });

  it("compile recover (missing semicolons)", () => {
    runInDir(
      "compile",
      `
require "vnd.dovecot.testsuite";
test "Missing semicolons" {
	if test_script_compile "recover/commands-semicolon.sieve" { test_fail "compile should have failed."; }
}
test "Missing semicolon at end of block" {
	if test_script_compile "recover/commands-endblock.sieve" { test_fail "compile should have failed."; }
}
test "Spurious comma at end of test list" {
	if test_script_compile "recover/tests-endcomma.sieve" { test_fail "compile should have failed."; }
}
`,
    );
  });

  it("relational errors (stripped test_error)", () => {
    runInDir(
      "extensions/relational",
      `
require "vnd.dovecot.testsuite";
test "Syntax errors" {
	if test_script_compile "errors/syntax.sieve" { test_fail "compile should have failed"; }
}
test "Validation errors" {
	if test_script_compile "errors/validation.sieve" { test_fail "compile should have failed"; }
}
`,
    );
  });
});
