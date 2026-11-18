import { describe, expect, it, vi } from "vitest";
import { checkTextFidelity } from "@/lib/pdf/text-fidelity";
import { padAndImposeBooklet } from "@/lib/pdf/booklet-build";
import { buildFilledPdf } from "./fill";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("server-only", () => ({}));

const HE = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃ וְהָאָ֗רֶץ הָיְתָ֥ה תֹ֙הוּ֙ וָבֹ֔הוּ וְחֹ֖שֶׁךְ עַל־פְּנֵ֣י תְה֑וֹם";

describe("a daily booklet drawn glyph by glyph still passes Printio's own Hebrew text check", () => {
  it("the folded booklet has the same Hebrew text as the PDF it was made from", async () => {
    const built = await buildFilledPdf({
      title: "Study",
      items: [{ title: "Chumash", sections: [{ heading: "", blocks: Array.from({ length: 12 }, (_, i) => ({ kind: "verse", num: String(i + 1), he: HE, en: "In the beginning." }) as never) }] }],
      language: "he",
      page: { width: 396, height: 612 },
      margin: 28,
    });
    const folded = await padAndImposeBooklet(built.bytes, { paperSize: "letter", bindingSide: "right", fit: "fill" });
    const result = await checkTextFidelity({ original: built.bytes, derived: folded.bytes, sourcePages: null, booklet: true });
    expect(result).toEqual({ status: "ok" });
  });
});
