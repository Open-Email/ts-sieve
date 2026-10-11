// RFC 2047 encoded words in header values (ts-sieve #67): each word decodes on
// its own, as core's walker decodes them (Go's WordDecoder.DecodeHeader, which
// is what the user's client shows), so one malformed word cannot hide the
// text of the others from a rule.

import { describe, expect, it } from "vitest";
import { decodeHeaderValue } from "../src/interp/header.js";
import { R, run } from "./harness.js";

const NBSP = String.fromCharCode(0xa0);

describe("decodeHeaderValue", () => {
  it("decodes the words around one that does not decode", () => {
    expect(decodeHeaderValue("=?utf-8?b?dmlhZ3Jh?= =?utf-8?b?!!!?=")).toBe("viagra =?utf-8?b?!!!?=");
    expect(decodeHeaderValue("=?utf-8?b?!!!?= =?utf-8?b?dmlhZ3Jh?=")).toBe("=?utf-8?b?!!!?= viagra");
    expect(decodeHeaderValue("a =?utf-8?q?vi?= =?utf-8?b?!!!?= =?utf-8?q?agra?= b")).toBe("a vi =?utf-8?b?!!!?= agra b");
  });

  it("looks for a word inside one that does not decode, as Go does", () => {
    // The failed word's closing "=" opens the next one.
    expect(decodeHeaderValue("=?x?b?!!!?=?utf-8?q?viagra?=")).toBe("=?x?b?!!!?viagra");
  });

  it("drops only spaces and tabs between two decoded words", () => {
    expect(decodeHeaderValue("=?utf-8?q?via?= \t =?utf-8?q?gra?=")).toBe("viagra");
    expect(decodeHeaderValue("=?utf-8?q?via?=\r\n =?utf-8?q?gra?=")).toBe("viagra");
    expect(decodeHeaderValue(`=?utf-8?q?via?=${NBSP}=?utf-8?q?gra?=`)).toBe(`via${NBSP}gra`);
    expect(decodeHeaderValue("=?utf-8?q?via?= x =?utf-8?q?gra?=")).toBe("via x gra");
    expect(decodeHeaderValue(" =?utf-8?q?via?= ")).toBe(" via ");
  });

  it("leaves a value with no word that decodes as it was, unfolded", () => {
    expect(decodeHeaderValue("=?utf-8?b?!!!?=\r\n =?utf-8?b?***?=")).toBe("=?utf-8?b?!!!?= =?utf-8?b?***?=");
    expect(decodeHeaderValue("plain =? text ?=")).toBe("plain =? text ?=");
  });
});

describe("a header rule sees every word that decodes", () => {
  const eml = (subject: string) => `From: a@x\r\nTo: b@y\r\nSubject: ${subject}\r\n\r\nbody\r\n`;
  const script = 'require "fileinto"; if header :contains "subject" "viagra" { fileinto "Junk"; }';

  it("past a malformed word after it", () => {
    expect(run(script, eml("=?utf-8?b?dmlhZ3Jh?= =?utf-8?b?!!!?="))).toEqual(R({ fileinto: ["Junk"] }));
  });

  it("past a malformed word whose end opens it", () => {
    expect(run(script, eml("=?x?b?!!!?=?utf-8?q?vi=61gra?="))).toEqual(R({ fileinto: ["Junk"] }));
  });

  it("and the control, with no malformed word", () => {
    expect(run(script, eml("=?utf-8?b?dmlhZ3Jh?="))).toEqual(R({ fileinto: ["Junk"] }));
  });
});
