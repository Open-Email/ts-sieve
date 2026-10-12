// #91: replacing a fixture must read the expanded message and rebuild its
// envelope, as Pigeonhole's testsuite_message_set_data does.

import { describe, expect, it } from "vitest";
import { DummyPolicy, EnvelopeStatic, load, MessageStatic, newRuntimeData, type Options } from "../../src/index.js";
import { ALL_EXTENSIONS } from "../harness.js";
import { Reporter } from "./harness.js";

const REQ = 'require ["vnd.dovecot.testsuite", "variables", "envelope"];';
const message = 'From: Sender <new-sender@example.net>\r\nTo: Recipient <new-recipient@example.net>\r\nSubject: replacement\r\n\r\nnew body';
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function exec(commands: string, options: Options = {}) {
  const s = load(`${REQ} ${commands}`, { enabledExtensions: ALL_EXTENSIONS, testEnv: new Reporter(), ...options });
  const d = newRuntimeData(s, new DummyPolicy(), new EnvelopeStatic("old-sender@example.net", "old-recipient@example.net", "old-auth"), new MessageStatic(0, new Map()));
  s.execute(d);
  return d;
}

const envelope = (d: ReturnType<typeof exec>) => [d.envelope.envelopeFrom(), d.envelope.envelopeTo(), d.envelope.authUsername()];

describe("test_set message replacement (#91)", () => {
  it("reads headers, body and byte size from the expanded message", () => {
    const d = exec(`set "fixture" ${quoted(message)}; test_set "message" "\${fixture}";`);
    expect(d.msg.headerGet("subject")).toEqual(["replacement"]);
    expect(new TextDecoder().decode(d.msg.bodyRaw()!)).toBe("new body");
    expect(d.msg.messageSize()).toBe(new TextEncoder().encode(message).length);
  });

  it.each(["message", "Message"])("rebuilds the envelope and resets authentication for %s", (name) => {
    const d = exec(`test_set "${name}" ${quoted(message)};`);
    expect(envelope(d)).toEqual(["new-sender@example.net", "new-recipient@example.net", ""]);
  });

  it.each([
    ["Return-path: <return@example.net>\r\nSender: sender@example.net\r\nFrom: from@example.net", "return@example.net"],
    ["Sender: sender@example.net\r\nFrom: from@example.net", "sender@example.net"],
    ["Return-path: <>\r\nSender: sender@example.net\r\nFrom: from@example.net", "sender@example.net"],
    ["Return-path: <>\r\nSender: <>\r\nFrom: From <from@example.net>", "from@example.net"],
    ["From: First <first@example.net>, Second <second@example.net>", "first@example.net"],
    ["From: First <first@example.net>, <>", "first@example.net"],
    ["From: localmailbox", "localmailbox"],
    ["Subject: no sender", "sender@example.com"],
  ])("derives sender from %s", (headers, expected) => {
    const d = exec(`test_set "message" ${quoted(`${headers}\r\n\r\nbody`)};`);
    expect(d.envelope.envelopeFrom()).toBe(expected);
  });

  it.each([
    ["Envelope-To: envelope@example.net\r\nTo: to@example.net", "envelope@example.net"],
    ["Envelope-To: <>\r\nTo: To <to@example.net>", "to@example.net"],
    ["To: First <first@example.net>, Second <second@example.net>", "first@example.net"],
    ["Envelope-To: <>\r\nEnvelope-To: ignored@example.net\r\nTo: to@example.net", "to@example.net"],
    ["Subject: no recipient", "recipient@example.com"],
  ])("derives recipient from %s", (headers, expected) => {
    const d = exec(`test_set "message" ${quoted(`${headers}\r\n\r\nbody`)};`);
    expect(d.envelope.envelopeTo()).toBe(expected);
  });

  it("replaces the previous message and envelope again, including explicit overrides", () => {
    const d = exec(`test_set "message" ${quoted(message)};
      test_set "envelope.from" "override@example.net";
      test_set "envelope.orig_to" "override-to@example.net";
      test_set "envelope.auth" "override-auth";
      set "next" "Subject: second\r\n\r\nsecond body";
      test_set "message" "\${next}";`);
    expect(d.msg.headerGet("subject")).toEqual(["second"]);
    expect(envelope(d)).toEqual(["sender@example.com", "recipient@example.com", ""]);
  });

  it("still permits explicit envelope overrides after replacing the message", () => {
    const d = exec(`test_set "message" ${quoted(message)};
      test_set "envelope.from" "override@example.net";
      test_set "envelope.to" "override-to@example.net";
      test_set "envelope.auth" "override-auth";`);
    expect(envelope(d)).toEqual(["override@example.net", "override-to@example.net", "override-auth"]);
  });

  it("charges for the expanded fixture size rather than the short variable reference", () => {
    const fixture = `Subject: large\r\n\r\n${"x".repeat(8192)}`;
    // test_set's raw variable is intentionally unbounded; the later parse
    // still has to pay for all of it.
    const commands = `test_set "fixture" ${quoted(fixture)}; test_set "message" "\${fixture}";`;
    const d = exec(commands, { maxExecSteps: 1000 });
    expect(1000 - d.budget.remaining).toBeGreaterThanOrEqual(fixture.length >> 6);
    expect(() => exec(commands, { maxExecSteps: 50 })).toThrow(/budget exceeded/);
  });
});
