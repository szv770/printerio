import { describe, expect, it } from "vitest";
import { SIE_WEEKLY } from "@printio/shared/library/sie-weekly";
import { normalizeSourceLink } from "@/lib/sources/link";

describe("SIE Weekly data against the website's link import", () => {
  it("has a Drive file for every week that the safe link import accepts", () => {
    for (const e of SIE_WEEKLY) expect(normalizeSourceLink(e.url).ok, e.url).toBe(true);
  });
});
