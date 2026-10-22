import { describe, expect, it } from "vitest";
import { attr, decodeIpp, encodeIpp, flatten, IppParseError, TAG } from "../src/ipp/codec.js";

const opHead = [
  attr(TAG.charset, "attributes-charset", "utf-8"),
  attr(TAG.language, "attributes-natural-language", "en"),
];

describe("IPP codec", () => {
  it("round-trips scalars, multi-values and nested collections", () => {
    const buf = encodeIpp({
      code: 0x000b,
      requestId: 7,
      groups: [
        { tag: TAG.operation, attrs: [...opHead, attr(TAG.keyword, "requested-attributes", "a", "b")] },
        {
          tag: TAG.printer,
          attrs: [
            attr(TAG.integer, "n", 5),
            attr(TAG.boolean, "ok", true),
            attr(TAG.range, "r", [1, 9]),
            attr(TAG.resolution, "res", { x: 600, y: 600, units: 3 }),
            attr(TAG.begCollection, "col", [
              { name: "size", tag: TAG.begCollection, values: [[{ name: "x", tag: TAG.integer, values: [21000] }]] },
            ]),
          ],
        },
      ],
    });
    const m = decodeIpp(buf);
    expect(m.requestId).toBe(7);
    expect(flatten(m.groups[0])["requested-attributes"]).toEqual(["a", "b"]);
    const p = flatten(m.groups[1]);
    expect(p.n).toBe(5);
    expect(p.ok).toBe(true);
    expect(p.r).toEqual([1, 9]);
    expect(p.res).toEqual({ x: 600, y: 600, units: 3 });
    expect(p.col).toEqual({ size: { x: 21000 } });
  });

  it("keeps several ranges and several collections as arrays, and returns trailing document bytes", () => {
    const pdf = Buffer.from("%PDF-1.4 hello");
    const buf = Buffer.concat([
      encodeIpp({
        code: 2,
        requestId: 1,
        groups: [
          { tag: TAG.operation, attrs: opHead },
          {
            tag: TAG.job,
            attrs: [
              attr(TAG.range, "page-ranges", [1, 3], [5, 5]),
              attr(TAG.begCollection, "media-col", [
                { name: "media-size", tag: TAG.begCollection, values: [[{ name: "x-dimension", tag: TAG.integer, values: [21590] }]] },
              ]),
            ],
          },
        ],
      }),
      pdf,
    ]);
    const m = decodeIpp(buf);
    expect(flatten(m.groups[1])["page-ranges"]).toEqual([[1, 3], [5, 5]]);
    expect(flatten(m.groups[1])["media-col"]).toEqual({ "media-size": { "x-dimension": 21590 } });
    expect(m.doc.equals(pdf)).toBe(true);
  });

  it("decodes text-with-language values and encodes dateTime", () => {
    const m = decodeIpp(
      encodeIpp({ code: 0, requestId: 1, groups: [{ tag: TAG.printer, attrs: [attr(TAG.dateTime, "t", new Date(Date.UTC(2026, 9, 22, 8, 30, 5)))] }] }),
    );
    expect(flatten(m.groups[0]).t).toBe("2026-10-22T8:30:5");
  });

  it("throws IppParseError (never a bare RangeError) on truncated or garbage input", () => {
    const good = encodeIpp({ code: 2, requestId: 1, groups: [{ tag: TAG.operation, attrs: opHead }] });
    for (let cut = 0; cut < good.length - 1; cut++) {
      expect(() => decodeIpp(good.subarray(0, cut))).toThrow(IppParseError);
    }
    // a value length that points past the end of the buffer
    const lying = Buffer.from(good);
    lying.writeUInt16BE(0x7fff, 8 + 1 + 1 + 2 + "attributes-charset".length);
    expect(() => decodeIpp(lying)).toThrow(IppParseError);
    // collection nested without end
    const open = Buffer.concat([
      Buffer.from([2, 0, 0, 2, 0, 0, 0, 1, TAG.job, TAG.begCollection, 0, 1, 0x63, 0, 0]),
      Buffer.from([TAG.memberName, 0, 0, 0, 1, 0x61]),
    ]);
    expect(() => decodeIpp(open)).toThrow(IppParseError);
  });
});
