import { describe, it, expect } from "vitest";
import { isValidSlug, slugify, parseOrganizationInput } from "./organizations";

describe("isValidSlug", () => {
  it("accepts lowercase letters, numbers, and hyphens", () => {
    expect(isValidSlug("lincoln-elementary-1")).toBe(true);
  });

  it("rejects a leading or trailing hyphen", () => {
    expect(isValidSlug("-lincoln")).toBe(false);
    expect(isValidSlug("lincoln-")).toBe(false);
  });

  it("rejects uppercase and spaces", () => {
    expect(isValidSlug("Lincoln Elementary")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidSlug("")).toBe(false);
  });

  it("rejects over 100 characters", () => {
    expect(isValidSlug("a".repeat(101))).toBe(false);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Lincoln Elementary School")).toBe("lincoln-elementary-school");
  });

  it("strips non-alphanumeric characters", () => {
    expect(slugify("Lincoln & Washington (K-8)!")).toBe("lincoln-washington-k-8");
  });

  it("trims leading/trailing hyphens produced by punctuation", () => {
    expect(slugify("--Lincoln--")).toBe("lincoln");
  });

  it("truncates to 100 characters", () => {
    expect(slugify("a".repeat(150)).length).toBe(100);
  });
});

describe("parseOrganizationInput", () => {
  it("derives a slug from the name when slug is blank", () => {
    const result = parseOrganizationInput("Lincoln Elementary", "");
    expect(result).toEqual({ name: "Lincoln Elementary", slug: "lincoln-elementary" });
  });

  it("uses an explicit slug when provided", () => {
    const result = parseOrganizationInput("Lincoln Elementary", "lincoln-e");
    expect(result).toEqual({ name: "Lincoln Elementary", slug: "lincoln-e" });
  });

  it("rejects a blank name", () => {
    const result = parseOrganizationInput("   ", "");
    expect(result).toEqual({ field: "name", message: expect.any(String) });
  });

  it("rejects an invalid explicit slug", () => {
    const result = parseOrganizationInput("Lincoln Elementary", "Not A Slug!");
    expect(result).toEqual({ field: "slug", message: expect.any(String) });
  });

  it("rejects a name over 200 characters", () => {
    const result = parseOrganizationInput("a".repeat(201), "");
    expect(result).toEqual({ field: "name", message: expect.any(String) });
  });
});
