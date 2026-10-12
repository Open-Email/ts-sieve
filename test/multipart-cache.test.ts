// #86: every body test repeated each multipart's delimiter searches, including
// when a MIME tree had already split it. Count the searches, not elapsed time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../src/index.js";
import { type InputEnd, splitMultipart, splitMultipartForMessage } from "../src/interp/body.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const REQ = 'require ["body", "mime", "foreverypart", "extracttext", "variables", "relational", "fileinto"];';
const MISS = 'if body :content "application/absent" "missing" { discard; }';

function chain(depth = 5, content = "needle"): string {
  let entity = `Content-Type: text/plain\r\nX-Leaf: yes\r\n\r\n${content}`;
  for (let i = depth - 1; i >= 0; i--) {
    entity = `Content-Type: multipart/mixed; boundary=scan${i}\r\n\r\n--scan${i}\r\n${entity}\r\n--scan${i}--\r\n`;
  }
  return entity;
}

function message(raw: string, cut = false) {
  const { size, headers, body } = parseEml(raw);
  return new MessageStatic(size, headers, body, cut);
}

function exec(commands: string, msg = message(chain()), options: Options = {}) {
  const s = load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, ...options });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
  s.execute(d);
  return d;
}

beforeEach(() => { vi.spyOn(String.prototype, "indexOf"); });
afterEach(() => vi.restoreAllMocks());
const searches = () => vi.mocked(String.prototype.indexOf).mock.calls.filter(([needle]) => /^\r\n--scan\d+$/.test(needle)).length;

describe("multipart splits shared by message and part (#86)", () => {
  it("searches each nesting level once across twenty body tests", () => {
    const d = exec(MISS.repeat(20));
    expect([d.implicitKeep, d.indeterminate]).toEqual([true, false]);
    expect(searches()).toBe(5);
  });

  it.each([false, true])("shares body and MIME tree splits, MIME first: %s", (mimeFirst) => {
    const mime = 'if exists :mime :anychild "x-leaf" { set "found" "yes"; }';
    const d = exec(mimeFirst ? mime + MISS : MISS + mime);
    expect(d.variables.get("found")).toBe("yes");
    expect(searches()).toBe(5);
  });

  it("shares the tree with body tests and extraction inside a part loop", () => {
    const d = exec(`foreverypart { ${MISS} extracttext "text"; }`);
    expect(d.variables.get("text")).toBe("needle");
    expect(searches()).toBe(5);
  });

  it("uses the same path through an embedded message in both walkers", () => {
    const msg = message(`Content-Type: message/rfc822\r\n\r\n${chain(3)}`);
    const d = exec(`${MISS} if exists :mime :anychild "x-leaf" { set "found" "yes"; }`, msg);
    expect(d.variables.get("found")).toBe("yes");
    expect(searches()).toBe(3);
  });

  it("retains splits across runtimes and clones sharing one Message", () => {
    const msg = message(chain(2));
    const d = exec(MISS, msg);
    exec(MISS, msg);
    d.script.execute(d.clone());
    expect(searches()).toBe(2);
  });

  it("isolates separate Message objects, even with identical bytes", () => {
    exec(MISS, message(chain(2)));
    exec(MISS, message(chain(2)));
    expect(searches()).toBe(4);
  });

  it("does not confuse siblings that reuse a boundary", () => {
    const child = (value: string) => `Content-Type: multipart/mixed; boundary=scan1\r\n\r\n--scan1\r\nContent-Type: text/plain\r\n\r\n${value}\r\n--scan1--\r\n`;
    const raw = `Content-Type: multipart/mixed; boundary=scan0\r\n\r\n--scan0\r\n${child("first")}\r\n--scan0\r\n${child("second")}\r\n--scan0--\r\n`;
    const d = exec('if body :text :is "second" { set "found" "yes"; }', message(raw));
    expect(d.variables.get("found")).toBe("yes");
  });

  it("preserves uncertainty when the read window cuts the final delimiter", () => {
    const raw = chain(1).slice(0, -5);
    const whole = exec(MISS, message(raw));
    const cut = exec(MISS.repeat(2), message(raw, true));
    expect(whole.indeterminate).toBe(false);
    expect(cut.indeterminate).toBe(true);
  });

  it("checks body, boundary, cut and input ending before reusing a part's result", () => {
    const d = exec("keep;");
    const bodies = ["--scan0\r\nX-Test: yes", "--scan0\r\n\r\ntext\r\n--scan0--\r\n", "--scan0\r\n\r\ndifferent"];
    for (const b of bodies) for (const boundary of ["scan0", "scan1", ""]) for (const cut of [false, true]) {
      for (const end of ["whole", "part", "ranOut"] as InputEnd[]) {
        const expected = splitMultipart(b, boundary, cut, end);
        const found = splitMultipartForMessage(d, "same-path", b, boundary, cut, end);
        expect(found).toEqual(expected);
        expect(splitMultipartForMessage(d, "same-path", b, boundary, cut, end)).toBe(found);
      }
    }
  });
});

describe("uncached multipart scanning uses the execution budget (#86)", () => {
  const LARGE = 128 * 1024;
  const LIMIT = 1_000_000;

  it.each([MISS, 'if exists :mime :anychild "absent" { keep; }'])("charges each level's bytes: %s", (commands) => {
    const d = exec(commands, message(chain(4, "x".repeat(LARGE))), { maxExecSteps: LIMIT });
    expect(LIMIT - d.budget.remaining).toBeGreaterThanOrEqual((4 * LARGE) / 64);
    expect(d.budgetExhausted).toBe(false);
  });

  it("allows a small-budget run to reuse already completed splits", () => {
    const msg = message(chain(4, "x".repeat(LARGE)));
    exec(MISS, msg, { maxExecSteps: LIMIT });
    const d = exec(MISS, msg, { maxExecSteps: 1000 });
    expect([d.indeterminate, d.budgetExhausted]).toEqual([false, false]);
    expect(searches()).toBe(4);
  });

  it.each([MISS, 'if exists :mime :anychild "absent" { keep; }', 'foreverypart { keep; }'])("leaves later commands runnable after exhausting a cold scan: %s", (commands) => {
    const d = exec(`${commands} fileinto "After";`, message(chain(4, "x".repeat(LARGE))), { maxExecSteps: 1000 });
    expect([d.indeterminate, d.budgetExhausted]).toEqual([true, true]);
    expect(d.mailboxes).toEqual(["After"]);
    // Exhausted before the first scan, rather than scanning and then charging.
    expect(searches()).toBe(0);
  });

  it("retains completed splits but never publishes an incomplete MIME tree", () => {
    const msg = message(chain(4, "x".repeat(LARGE)));
    const commands = 'if exists :mime :anychild "x-leaf" { set "found" "yes"; }';
    const limited = exec(commands, msg, { maxExecSteps: 5000 });
    expect(limited.budgetExhausted).toBe(true);
    expect(limited.variables.has("found")).toBe(false);
    const complete = exec(commands + MISS, msg, { maxExecSteps: LIMIT });
    expect(complete.variables.get("found")).toBe("yes");
    expect(complete.indeterminate).toBe(false);
    expect(searches()).toBe(4);
  });
});
