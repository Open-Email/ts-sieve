// Harness for the vnd.dovecot.testsuite DSL — the reporter shim, a filesystem
// Namespace, and the two runners for the Dovecot `.svtest` DSL
// (runDovecotInline for inline scripts, runDovecotFile for on-disk files).
//
// vitest can't spawn subtests dynamically mid-run, so each `.svtest` file (or
// inline script) is one vitest `it`: the Reporter collects every `test "name"`
// sub-result, and the caller asserts `reporter.failures` is empty.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DummyPolicy,
  EnvelopeStatic,
  load,
  MessageStatic,
  type Namespace,
  newRuntimeData,
  type SubTest,
  type TestEnv,
} from "../../src/index.js";
import { ALL_EXTENSIONS } from "../harness.js";

export type SubStatus = "pass" | "fail" | "skip";
export interface SubResult {
  name: string;
  status: SubStatus;
  message?: string;
}

/** Collecting reporter: one entry per `test` block. */
export class Reporter implements TestEnv {
  readonly results: SubResult[] = [];

  run(name: string, body: (t: SubTest) => void): void {
    let status: SubStatus = "pass";
    let message: string | undefined;
    const t: SubTest = {
      errorf(m: string): void {
        status = "fail";
        message = m;
      },
      skip(reason: string): void {
        if (status !== "fail") {
          status = "skip";
          message = reason;
        }
      },
    };
    try {
      body(t);
    } catch (e) {
      // A non-StopSignal error escaped the test block (fatal).
      status = "fail";
      message = `fatal: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.results.push({ name, status, message });
  }

  get failures(): SubResult[] {
    return this.results.filter((r) => r.status === "fail");
  }
  get passed(): SubResult[] {
    return this.results.filter((r) => r.status === "pass");
  }
  get skipped(): SubResult[] {
    return this.results.filter((r) => r.status === "skip");
  }

  /** A human-readable failure list for a vitest assertion message. */
  report(): string {
    return this.failures.map((f) => `  ✗ ${f.name}: ${f.message ?? ""}`).join("\n");
  }
}

/** A read-only Namespace (filesystem view) over a base directory. */
export function dirNamespace(baseDir: string): Namespace {
  return {
    readFile(p: string): Uint8Array | null {
      try {
        return new Uint8Array(fs.readFileSync(path.resolve(baseDir, p)));
      } catch {
        return null;
      }
    },
  };
}

/** An in-memory Namespace (path → text), for self-contained tests. */
export function mapNamespace(files: Record<string, string>): Namespace {
  const enc = new TextEncoder();
  return {
    readFile(p: string): Uint8Array | null {
      const v = files[p] ?? files[p.replace(/^\.\//, "")];
      return v === undefined ? null : enc.encode(v);
    },
  };
}

/**
 * Run a `.svtest` file through the DSL: full extension set, test env, empty
 * envelope + empty message, namespace rooted at the file's directory. Throws on
 * a top-level load/execute error (fatal).
 */
export function runDovecotFile(filePath: string, disabledTests: string[] = []): Reporter {
  const source = fs.readFileSync(filePath, "utf8");
  const reporter = new Reporter();
  const script = load(source, {
    enabledExtensions: ALL_EXTENSIONS,
    testEnv: reporter,
    disabledTests,
  });
  const d = newRuntimeData(script, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map(), null));
  d.namespace = dirNamespace(path.dirname(filePath));
  script.execute(d);
  return reporter;
}

/**
 * Run an inline DSL script: full extension set, test env, default envelope
 * sender@example.com/recipient@example.com, empty message of size 100, namespace
 * at `baseDir` (or cwd). Throws on a top-level load/execute error.
 */
export function runDovecotInline(scriptText: string, namespace?: Namespace): Reporter {
  const reporter = new Reporter();
  const script = load(scriptText, {
    enabledExtensions: ALL_EXTENSIONS,
    testEnv: reporter,
  });
  const env = new EnvelopeStatic("sender@example.com", "recipient@example.com");
  const d = newRuntimeData(script, new DummyPolicy(), env, new MessageStatic(100, new Map(), null));
  d.namespace = namespace ?? dirNamespace(process.cwd());
  script.execute(d);
  return reporter;
}
