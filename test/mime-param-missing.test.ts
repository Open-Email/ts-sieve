// #80 is a Pigeonhole compatibility difference, not a ts-sieve defect:
// RFC 5703 section 4.1 counts parameters with the requested names found.
// An absent parameter is not a present parameter whose value is empty.

import { describe, expect, it } from "vitest";
import { R, run } from "./harness.js";

const REQ = 'require ["mime", "fileinto", "relational", "comparator-i;ascii-numeric"];';
const COUNT = ':count "eq" :comparator "i;ascii-numeric"';

describe("missing MIME parameters stay absent (#80)", () => {
  for (const [field, base] of [["content-type", "application/octet-stream"], ["content-disposition", "attachment"]]) {
    it(`${field}: a missing parameter does not match an empty value or wildcard`, () => {
      const s = `${REQ}
        if header :mime :param "name" :is "${field}" "" { fileinto "Empty"; }
        if header :mime :param "name" :matches "${field}" "*" { fileinto "Any"; }
        if header :mime :param "name" ${COUNT} "${field}" "0" { fileinto "Zero"; }`;
      expect(run(s, `${field}: ${base}\r\n\r\nbody`)).toEqual(R({ fileinto: ["Zero"] }));
    });

    it(`${field}: a present empty parameter contributes one value`, () => {
      const s = `${REQ}
        if header :mime :param "name" :is "${field}" "" { fileinto "Empty"; }
        if header :mime :param "name" :matches "${field}" "*" { fileinto "Any"; }
        if header :mime :param "name" ${COUNT} "${field}" "1" { fileinto "One"; }`;
      expect(run(s, `${field}: ${base}; name=""\r\n\r\nbody`)).toEqual(R({ fileinto: ["Empty", "Any", "One"] }));
    });

    it(`${field}: requesting missing and present names counts only those found`, () => {
      const s = `${REQ} if header :mime :param ["missing", "name"] ${COUNT} "${field}" "1" { fileinto "One"; }`;
      expect(run(s, `${field}: ${base}; name="file.pdf"\r\n\r\nbody`)).toEqual(R({ fileinto: ["One"] }));
    });

    it(`${field}: an absent field contributes no parameter value`, () => {
      const s = `${REQ}
        if header :mime :param "name" :is "${field}" "" { fileinto "Empty"; }
        if header :mime :param "name" ${COUNT} "${field}" "0" { fileinto "Zero"; }`;
      expect(run(s, "Subject: no MIME fields\r\n\r\nbody")).toEqual(R({ fileinto: ["Zero"] }));
    });
  }

  it(":anychild counts only parameters actually found across the part tree", () => {
    const message = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Disposition: attachment\r\n\r\none\r\n--b\r\nContent-Disposition: attachment; filename=""\r\n\r\ntwo\r\n--b--\r\n';
    const s = `${REQ} if header :mime :anychild :param "filename" ${COUNT} "content-disposition" "1" { fileinto "One"; }`;
    expect(run(s, message)).toEqual(R({ fileinto: ["One"] }));
  });
});
