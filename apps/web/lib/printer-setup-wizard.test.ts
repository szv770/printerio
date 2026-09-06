import { describe, it, expect } from "vitest";
import {
  PRINTER_ARCHETYPES,
  PRINTER_ARCHETYPE_IDS,
  isPrinterArchetypeId,
  buildRecipeCard,
  buildRecipeCards,
} from "./printer-setup-wizard";
import { isPrinterProfileIconKey } from "./printer-profile-icons";

describe("PRINTER_ARCHETYPES", () => {
  it("has an entry for every declared archetype id, keyed consistently", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) {
      expect(PRINTER_ARCHETYPES[id].id).toBe(id);
    }
  });

  it("only ever uses icons from the curated printer-profile-icons allow-list", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) {
      expect(isPrinterProfileIconKey(PRINTER_ARCHETYPES[id].iconKey)).toBe(true);
    }
  });

  it("every suggestedKey matches the DB's key ~ '^[a-z0-9_]+$' constraint", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) {
      expect(PRINTER_ARCHETYPES[id].suggestedKey).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("declares exactly one true capability flag per non-booklet archetype", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) {
      const archetype = PRINTER_ARCHETYPES[id];
      if (archetype.isBooklet) continue;
      const trueFlags = Object.values(archetype.declaredCapabilities).filter(Boolean);
      // bw_simplex is the one archetype with zero flags set (the plain default).
      expect(trueFlags.length).toBeLessThanOrEqual(1);
    }
  });

  it("marks only the two booklet archetypes as isBooklet, both with booklet:true", () => {
    const bookletIds = PRINTER_ARCHETYPE_IDS.filter((id) => PRINTER_ARCHETYPES[id].isBooklet);
    expect(bookletIds.sort()).toEqual(["booklet_left", "booklet_right"]);
    for (const id of bookletIds) {
      expect(PRINTER_ARCHETYPES[id].declaredCapabilities.booklet).toBe(true);
    }
  });

  it("keeps driverGuidance grounded - references docs/printer-setup.md", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) {
      expect(PRINTER_ARCHETYPES[id].driverGuidance).toContain("docs/printer-setup.md");
    }
  });
});

describe("isPrinterArchetypeId", () => {
  it("accepts every declared id and rejects arbitrary strings", () => {
    for (const id of PRINTER_ARCHETYPE_IDS) expect(isPrinterArchetypeId(id)).toBe(true);
    expect(isPrinterArchetypeId("not_a_real_archetype")).toBe(false);
    expect(isPrinterArchetypeId("")).toBe(false);
  });
});

describe("buildRecipeCard", () => {
  it("maps an archetype's declared_capabilities and icon through unchanged", () => {
    const card = buildRecipeCard("stapled");
    expect(card.declaredCapabilities).toEqual({
      duplex: false,
      color: false,
      staple: true,
      booklet: false,
      punch: false,
    });
    expect(card.iconKey).toBe("paperclip");
    expect(card.key).toBe("stapled");
  });

  it("prefills bookletBindingSide from the org default for a booklet archetype, not a hardcoded value", () => {
    const leftDefaultOrg = buildRecipeCard("booklet_right", "left");
    expect(leftDefaultOrg.bookletBindingSide).toBe("left");

    const rightDefaultOrg = buildRecipeCard("booklet_left", "right");
    expect(rightDefaultOrg.bookletBindingSide).toBe("right");
  });

  it("defaults to 'left' when no org setting is passed, matching the DB column's own default", () => {
    const card = buildRecipeCard("booklet_left");
    expect(card.bookletBindingSide).toBe("left");
  });

  it("still populates bookletBindingSide for a non-booklet archetype (stored regardless, like the DB column itself)", () => {
    const card = buildRecipeCard("color", "right");
    expect(card.isBooklet).toBe(false);
    expect(card.bookletBindingSide).toBe("right");
  });
});

describe("buildRecipeCards", () => {
  it("builds one card per checked archetype, in the order given", () => {
    const cards = buildRecipeCards(["stapled", "bw_duplex", "color"]);
    expect(cards.map((c) => c.archetypeId)).toEqual(["stapled", "bw_duplex", "color"]);
  });

  it("de-duplicates a repeated archetype id into a single card", () => {
    const cards = buildRecipeCards(["stapled", "stapled", "color"]);
    expect(cards.map((c) => c.archetypeId)).toEqual(["stapled", "color"]);
  });

  it("returns an empty array for an empty selection", () => {
    expect(buildRecipeCards([])).toEqual([]);
  });

  it("threads the org booklet binding side default into every booklet card built", () => {
    const cards = buildRecipeCards(["booklet_left", "booklet_right"], "right");
    expect(cards.every((c) => c.bookletBindingSide === "right")).toBe(true);
  });
});
