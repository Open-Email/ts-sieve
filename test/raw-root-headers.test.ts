import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData } from "../src/index.js";
import { ALL_EXTENSIONS } from "./harness.js";

const bytes = (s: string) => Uint8Array.from(s, c => c.charCodeAt(0));
const scripts = [
  ["mime:anychild", 'require ["fileinto", "mime"]; if header :mime :anychild :contenttype "content-type" "application/x-msdownload" { fileinto "Junk"; }'],
  ["foreverypart", 'require ["fileinto", "mime", "foreverypart"]; foreverypart { if header :mime :param "filename" "content-disposition" "evil.exe" { fileinto "Junk"; } }'],
  ["body:content", 'require ["fileinto", "body"]; if body :content "application/x-msdownload" :contains "MZ" { fileinto "Junk"; }'],
] as const;
const body = (boundary: string) => bytes(`--${boundary}\r\nContent-Type: application/x-msdownload\r\nContent-Disposition: attachment; filename=evil.exe\r\n\r\nMZ\r\n--${boundary}--\r\n`);

function execute(script: string, headers: Map<string, string[]>, raw: Uint8Array, structural?: Map<string, string[]>) {
  const s = load(script, { enabledExtensions: ALL_EXTENSIONS });
  // Reflect.construct keeps this regression executable before the optional
  // fifth constructor argument exists; older versions simply ignore it.
  const message = Reflect.construct(MessageStatic, [raw.length, headers, raw, false, structural]) as MessageStatic;
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic(), message);
  s.execute(d);
  return d.mailboxes;
}

describe.each([["Latin-1", "a\xe9"], ["UTF-8", "a\xc3\xa9"], ["ASCII", "abc"]])("raw %s root headers", (_name, boundary) => {
  it.each(scripts)("%s uses structural bytes instead of lossy display text", (_rule, script) => {
    const headers = new Map([["content-type", ['multipart/mixed; boundary="corrupted"']]]);
    const rawHeaders = new Map([["content-type", [`multipart/mixed; boundary="${boundary}"`]]]);
    expect(execute(script, headers, body(boundary), rawHeaders)).toEqual(["Junk"]);
  });
});

it.each(scripts)("%s treats an explicitly absent structural header as absent", (_rule, script) => {
  const headers = new Map([["content-type", ["multipart/mixed; boundary=b"]]]);
  expect(execute(script, headers, body("b"), new Map())).toEqual([]);
});

it("uses raw transfer encoding for the body test", () => {
  const headers = new Map([["content-type", ["text/plain"]], ["content-transfer-encoding", ["base64"]]]);
  const structural = new Map([["content-type", ["text/plain"]], ["content-transfer-encoding", ["quoted-printable"]]]);
  expect(execute('require ["fileinto", "body"]; if body :contains "flag: yes" { fileinto "Junk"; }',
    headers, bytes("flag=3A yes"), structural)).toEqual(["Junk"]);
});

it("preserves decoded UTF-8 fallback for hosts without raw structural headers", () => {
  const headers = new Map([["content-type", ['multipart/mixed; boundary="aé"']]]);
  expect(execute(scripts[0][1], headers, body("a\xc3\xa9"))).toEqual(["Junk"]);
});

it("ordinary header tests still read decoded text", () => {
  const headers = new Map([["subject", ["café"]]]);
  expect(execute('require "fileinto"; if header :is "subject" "café" { fileinto "Junk"; }',
    headers, bytes("body"), new Map([["subject", ["caf\xc3\xa9"]]]))).toEqual(["Junk"]);
});
