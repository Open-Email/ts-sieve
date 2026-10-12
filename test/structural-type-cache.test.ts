// #101: body/leaf caches do not prevent reparsing structural Content-Type.
// Count the parser and host reads, including tree construction and extraction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../src/index.js";
import * as media from "../src/interp/mediatype.js";
import { ALL_EXTENSIONS, parseEml } from "./harness.js";

const REQ = 'require ["body", "mime", "foreverypart", "extracttext", "variables", "fileinto"];';
const MISS = 'if body :text :is "absent" { discard; }';
const LARGE = `text/plain; x="${"a;".repeat(300_000)}"`;

function simple(type = LARGE) {
  return new MessageStatic(1, new Map([["content-type", [type]]]), new Uint8Array([120]));
}

function exec(commands: string, msg = simple(), options: Options = {}) {
  const s = load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, ...options });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
  s.execute(d);
  return d;
}

beforeEach(() => { vi.spyOn(media, "contentType"); });
afterEach(() => vi.restoreAllMocks());
const parses = (value: string) => vi.mocked(media.contentType).mock.calls.filter(([raw]) => raw === value).length;

describe("structural Content-Type reuse (#101)", () => {
  it("parses the same large root value once across twenty body rules", () => {
    const d = exec(MISS.repeat(20));
    expect(d.indeterminate).toBe(false);
    expect(parses(LARGE)).toBe(1);
  });

  it("reads immutable root fields once rather than rebuilding their byte view", () => {
    const msg = simple("text/plain; x=é");
    const read = vi.spyOn(msg, "headerGet");
    exec(MISS.repeat(20), msg);
    expect(read.mock.calls.filter(([key]) => key === "content-type")).toHaveLength(1);
    expect(read.mock.calls.filter(([key]) => key === "content-transfer-encoding")).toHaveLength(1);
    expect(parses("text/plain; x=\xc3\xa9")).toBe(1);
  });

  it.each([false, true])("shares parsing across body, tree and extraction, MIME first: %s", (mimeFirst) => {
    const ct = "text/plain; x=leaf";
    const raw = `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: ${ct}\r\nX-Leaf: yes\r\n\r\nneedle\r\n--b--\r\n`;
    const { size, headers, body } = parseEml(raw);
    const msg = new MessageStatic(size, headers, body);
    const mime = 'if exists :mime :anychild "x-leaf" { set "found" "yes"; }';
    const d = exec((mimeFirst ? mime + MISS : MISS + mime) + 'foreverypart { extracttext "text"; }', msg);
    expect([d.variables.get("found"), d.variables.get("text")]).toEqual(["yes", "needle"]);
    expect(parses("multipart/mixed; boundary=b")).toBe(1);
    expect(parses(ct)).toBe(1);
  });

  it("shares identical values across different parts but distinguishes different types", () => {
    const part = (ct: string, text: string) => `--b\r\nContent-Type: ${ct}\r\n\r\n${text}\r\n`;
    const raw = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${part("text/plain", "one")}${part("text/plain", "two")}${part("text/html", "<b>three</b>")}--b--\r\n`;
    const { size, headers, body } = parseEml(raw);
    const d = exec(`${MISS} if body :text :is "three" { set "found" "yes"; }`, new MessageStatic(size, headers, body));
    expect(d.variables.get("found")).toBe("yes");
    expect(parses("text/plain")).toBe(1);
    expect(parses("text/html")).toBe(1);
  });

  it("reuses a Message's results in clones and separate runtimes, without sharing between Messages", () => {
    const msg = simple();
    const first = exec(MISS, msg);
    exec(MISS, msg);
    first.script.execute(first.clone());
    exec(MISS, simple());
    expect(parses(LARGE)).toBe(2);
  });

  it("preserves raw non-UTF-8 boundary bytes when caching the root header view", () => {
    const ct = 'multipart/mixed; boundary="a\xe9"';
    const raw = '--a\xe9\r\nContent-Type: text/plain\r\nX-Leaf: yes\r\n\r\nneedle\r\n--a\xe9--\r\n';
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const msg = new MessageStatic(bytes.length, new Map([["content-type", ['multipart/mixed; boundary="wrong"']]]), bytes, false, new Map([["content-type", [ct]]]));
    const read = vi.spyOn(msg, "mimeHeaderGet");
    const d = exec('if body :text "needle" { set "body" "yes"; } if exists :mime :anychild "x-leaf" { set "mime" "yes"; }', msg);
    expect([d.variables.get("body"), d.variables.get("mime")]).toEqual(["yes", "yes"]);
    expect(read.mock.calls.filter(([key]) => key === "content-type")).toHaveLength(1);
    expect(parses(ct)).toBe(1);
  });

  it.each(["text/plain; charset=utf-8; charset=iso-8859-1", "not a valid media type", "__proto__"])("keeps fallback parsing unchanged for %s", (ct) => {
    const d = exec('if body :content "" :is "x" { set "found" "yes"; }'.repeat(2), simple(ct));
    expect(d.variables.get("found")).toBe("yes");
    expect(parses(ct)).toBe(1);
  });

  it("caches field absence, not whichever default the first reader supplied", () => {
    const msg = new MessageStatic(0, new Map([["content-type", ["misleading"]]]), null, false, new Map());
    const read = vi.spyOn(msg, "mimeHeaderGet");
    const host = vi.spyOn(msg, "headerGet");
    expect(media.rootHeaderBytes(msg, "content-type", "text/plain; charset=us-ascii")).toBe("text/plain; charset=us-ascii");
    expect(media.rootHeaderBytes(msg, "content-type")).toBe("");
    expect(read).toHaveBeenCalledTimes(1);
    expect(host).not.toHaveBeenCalled();
  });
});

describe("cold structural parsing budget (#101)", () => {
  it("charges the parsed header size once, while warm reads fit a small budget", () => {
    const msg = simple();
    const first = exec(MISS, msg, { maxExecSteps: 200_000 });
    expect(200_000 - first.budget.remaining).toBeGreaterThanOrEqual(LARGE.length / 64);
    const warm = exec(MISS, msg, { maxExecSteps: 50 });
    expect([warm.budgetExhausted, warm.indeterminate]).toEqual([false, false]);
    expect(parses(LARGE)).toBe(1);
  });

  it.each([MISS, 'if exists :mime "absent" { keep; }', 'foreverypart { keep; }'])("stops before parsing but leaves later commands runnable: %s", (commands) => {
    const d = exec(`${commands} fileinto "After";`, simple(), { maxExecSteps: 50 });
    expect([d.budgetExhausted, d.indeterminate]).toEqual([true, true]);
    expect(d.mailboxes).toEqual(["After"]);
    expect(parses(LARGE)).toBe(0);
  });

  it("retries an interrupted parse rather than caching a made-up type", () => {
    const msg = simple();
    expect(exec(MISS, msg, { maxExecSteps: 50 }).budgetExhausted).toBe(true);
    const d = exec('if body :text :is "x" { set "found" "yes"; }', msg, { maxExecSteps: 200_000 });
    expect(d.variables.get("found")).toBe("yes");
    expect(parses(LARGE)).toBe(1);
  });
});
