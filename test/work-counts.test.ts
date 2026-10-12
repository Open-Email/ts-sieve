import { describe, expect, it } from "vitest";
import { stringWork } from "./work-counts.js";

describe("string work probe", () => {
  it("counts the searched span, including unsuccessful searches and their start offsets", () => {
    const measured = stringWork(() => {
      "abcabc".indexOf("b", 2); // scans c,a,b: 3 units + dispatch
      "abcabc".indexOf("z", 2); // remaining four + dispatch
      "abcabc".lastIndexOf("a", 4); // reads b,a: 2 + dispatch
    }, 12);
    expect(measured.units).toBe(12);
    expect(measured.calls.indexOf).toBe(2);
    expect(measured.calls.lastIndexOf).toBe(1);
  });

  it("refuses repeated suffix scans by work count and restores every primitive", () => {
    const methods = [String.prototype.indexOf, String.prototype.charCodeAt, RegExp.prototype.exec];
    expect(() => stringWork(() => {
      for (let i = 0; i < 1000; i++) "a".repeat(1000).indexOf("z");
    }, 2000)).toThrow(/string work exceeded/);
    expect([String.prototype.indexOf, String.prototype.charCodeAt, RegExp.prototype.exec]).toEqual(methods);
  });
});
