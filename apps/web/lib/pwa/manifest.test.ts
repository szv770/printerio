import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";

const m = buildManifest();

describe("web app manifest", () => {
  it("names the app and starts on the home screen inside the whole site", () => {
    expect(m.name).toBe("Printio");
    expect(m.short_name).toBe("Printio");
    expect(m.start_url).toBe("/home");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.id).toBe("/");
  });
  it("uses the design-token colours", () => {
    expect(m.background_color).toBe("#f5f3ef");
    expect(m.theme_color).toBe("#0a64d8");
  });
  it("has 192 and 512 icons, each as plain and maskable", () => {
    const find = (sizes: string, purpose: string) => m.icons?.find((i) => i.sizes === sizes && i.purpose === purpose);
    for (const size of ["192x192", "512x512"]) {
      for (const purpose of ["any", "maskable"]) {
        const icon = find(size, purpose);
        expect(icon, `${size} ${purpose}`).toBeDefined();
        expect(icon?.type).toBe("image/png");
        expect(icon?.src.startsWith("/")).toBe(true);
      }
    }
    expect(m.icons?.every((i) => i.purpose !== ("any maskable" as string))).toBe(true);
  });
  it("accepts a shared PDF with a multipart POST to /share-target", () => {
    expect(m.share_target).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "file", accept: ["application/pdf", ".pdf"] }] },
    });
  });
  it("offers print and my jobs as shortcuts", () => {
    expect(m.shortcuts?.map((s) => [s.name, s.url])).toEqual([
      ["Print a document", "/print"],
      ["My jobs", "/jobs"],
    ]);
  });
});
