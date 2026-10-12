// #53: count the expensive transforms themselves. Wall-clock limits cannot
// distinguish a fast machine from decoding/parsing the same value repeatedly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../src/index.js";
import * as address from "../src/interp/address.js";
import * as header from "../src/interp/header.js";
import { ALL_EXTENSIONS } from "./harness.js";

const REQ = 'require ["variables", "relational", "editheader", "mime", "comparator-i;octet"];';
const RAW = "=?utf-8?q?hello_world?=".repeat(3000);
const ADDRESS = "Alice (comment) <a@example.net>, Bob <b@example.net>";

function script(commands: string, options: Options = {}) {
  return load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, ...options });
}

function exec(commands: string, fields: [string, string[]][] = [["subject", [RAW]]], options: Options = {}) {
  const s = script(commands, options);
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), new MessageStatic(0, new Map(fields), new Uint8Array()));
  s.execute(d);
  return d;
}

beforeEach(() => {
  vi.spyOn(header, "decodeHeaderValue");
  vi.spyOn(address, "parseAddressList");
  vi.spyOn(address, "stripRFC2822Comments");
});
afterEach(() => vi.restoreAllMocks());

describe("bounded header-value memoization (#53)", () => {
  it("decodes once across fifty independent rules", () => {
    const d = exec('if header :is "subject" "absent" { discard; }'.repeat(50));
    expect(d.implicitKeep).toBe(true);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(1);
  });

  it("decodes once across repeated names, fields, and identical values", () => {
    const names = Array.from({ length: 2400 }, () => '"subject"').join(",");
    exec(`if header :is [${names}] "absent" { discard; }`, [["subject", [RAW, RAW]]]);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(1);
  });

  it("parses and removes comments once while counting every occurrence", () => {
    const names = Array.from({ length: 128 }, () => '"from"').join(",");
    const d = exec(`if address :count "eq" [${names}] "512" { set "counted" "yes"; }
      if address "to" "a@example.net" { set "matched" "yes"; }`, [["from", [ADDRESS, ADDRESS]], ["to", [ADDRESS]]]);
    expect(d.variables.get("counted")).toBe("yes");
    expect(d.variables.get("matched")).toBe("yes");
    expect(address.parseAddressList).toHaveBeenCalledTimes(1);
    expect(address.stripRFC2822Comments).toHaveBeenCalledTimes(1);
  });

  it("remembers failed address parses without changing fallback matching or counts", () => {
    const d = exec(`${'if address "from" "Name <>" { set "fallback" "yes"; }'.repeat(10)}
      if address :count "eq" "from" "0" { set "counted" "yes"; }`, [["from", ["Name <>"]]]);
    expect(d.variables.get("fallback")).toBe("yes");
    expect(d.variables.get("counted")).toBe("yes");
    expect(address.parseAddressList).toHaveBeenCalledTimes(1);
  });

  it("shares decoding between header, MIME header, and deleteheader matching", () => {
    const d = exec(`if header "subject" "hello" { set "plain" "yes"; }
      if header :mime "subject" "hello" { set "mime" "yes"; }
      deleteheader :is "subject" "hello";`, [["subject", ["=?utf-8?q?hello?="]]]);
    expect([d.variables.get("plain"), d.variables.get("mime")]).toEqual(["yes", "yes"]);
    expect(header.getHeader(d, "subject")).toEqual([]);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(1);
  });

  it("keys by raw content so changed headers get their own result", () => {
    const d = exec(`if header "subject" "first" { set "first" "yes"; }
      deleteheader "subject";
      addheader "subject" "=?utf-8?q?second?=";
      if header "subject" "second" { set "second" "yes"; }
      if header "subject" "first" { set "stale" "yes"; }`, [["subject", ["=?utf-8?q?first?="]]]);
    expect([d.variables.get("first"), d.variables.get("second"), d.variables.has("stale")]).toEqual(["yes", "yes", false]);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(2);
  });

  it("caches empty decoded values and empty address lists", () => {
    exec('if header "subject" "missing" { discard; } if address :count "eq" "from" "1" { discard; }'.repeat(4),
      [["subject", [""]], ["from", [""]]]);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(1);
    expect(address.parseAddressList).toHaveBeenCalledTimes(1);
  });

  it("keeps separate caches for runtimes and clones even when they share a message", () => {
    const s = script('if header "subject" "absent" { discard; }'.repeat(2));
    const msg = new MessageStatic(0, new Map([["subject", [RAW]]]));
    const first = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
    s.execute(first);
    const second = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), msg);
    s.execute(second);
    s.execute(first.clone());
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(3);
  });

  it("keeps early entries but stops admitting values once the bounded cache fills", () => {
    const values = Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(1024 * 1024)}`);
    const fields: [string, string[]][] = values.map((v, i) => [`x-${i}`, [v]]);
    const commands = values.map((_, i) => `if header :comparator "i;octet" "x-${i}" "" { discard; }`).join("\n");
    exec(commands.repeat(2), fields);
    const calls = vi.mocked(header.decodeHeaderValue).mock.calls;
    expect(calls.filter(([raw]) => raw === values[0])).toHaveLength(1);
    expect(calls.filter(([raw]) => raw === values[7])).toHaveLength(2);
  });

  it("does not retain a single decoded value larger than the cache allowance", () => {
    exec('if header :comparator "i;octet" "subject" "" { discard; }'.repeat(2), [["subject", ["x".repeat(8 * 1024 * 1024)]]]);
    expect(header.decodeHeaderValue).toHaveBeenCalledTimes(2);
  });

  it("accounts for address objects as well as string length when bounding retained results", () => {
    const value = Array.from({ length: 150_000 }, () => "a@b").join(",");
    exec('if address :count "eq" "from" "150000" { keep; }'.repeat(2), [["from", [value]]]);
    expect(address.parseAddressList).toHaveBeenCalledTimes(2);
  });

  it("does not charge top-level decode size and starve a later definite rule", () => {
    const d = exec('if header :comparator "i;octet" "subject" "absent" { keep; } discard;',
      [["subject", [RAW]]], { maxExecSteps: 50 });
    expect([d.implicitKeep, d.indeterminate, d.budgetExhausted]).toEqual([false, false, false]);
  });
});
