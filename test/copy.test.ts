// Verifies the :copy extension (RFC 3894) on redirect and fileinto: with :copy
// the implicit keep is preserved, and both actions require `require "copy"`.

import { describe, expect, it } from "vitest";
import { eml, R, run } from "./harness.js";

describe("copy", () => {
  it("redirect with :copy", () => {
    expect(run(`require "copy"; redirect :copy "user@example.com";`, eml)).toEqual(
      R({ redirect: ["user@example.com"], implicitKeep: true }),
    );
  });

  it("fileinto with :copy", () => {
    expect(run(`require ["fileinto", "copy"]; fileinto :copy "Spam";`, eml)).toEqual(
      R({ fileinto: ["Spam"], implicitKeep: true }),
    );
  });

  it("redirect :copy without require", () => {
    expect(() => run(`redirect :copy "user@example.com";`, eml)).toThrow();
  });

  it("fileinto :copy without require", () => {
    expect(() => run(`require "fileinto"; fileinto :copy "Spam";`, eml)).toThrow();
  });
});
