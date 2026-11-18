import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { buildManifest, PWA_ICON_PATHS } from "./manifest";

// The home-screen icons are static PNGs under public/ (rendered once from the Printio mark), so a wrong path or a
// replaced file with the wrong size would silently break installed apps. These tests read the real files.
const publicDir = path.join(__dirname, "../../public");

/** Width/height from the PNG header (8-byte signature, then the IHDR chunk). */
function pngSize(urlPath: string): { width: number; height: number } {
  const bytes = readFileSync(path.join(publicDir, urlPath));
  expect(bytes.subarray(0, 8).toString("hex"), `${urlPath} is a PNG`).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("ascii"), `${urlPath} starts with IHDR`).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("static icon files", () => {
  it("every icon in the manifest exists and has the size the manifest declares", () => {
    const m = buildManifest();
    const all = [...(m.icons ?? []), ...(m.shortcuts ?? []).flatMap((s) => s.icons ?? [])];
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const icon of all) {
      expect(icon.type).toBe("image/png");
      const { width, height } = pngSize(icon.src);
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
    }
  });

  it("the Apple touch icon (linked from app/layout.tsx) is 180x180", () => {
    expect(pngSize(PWA_ICON_PATHS.apple)).toEqual({ width: 180, height: 180 });
    expect(readFileSync(path.join(__dirname, "../../app/layout.tsx"), "utf8")).toContain("PWA_ICON_PATHS.apple");
  });

  it("every path in PWA_ICON_PATHS is a file under public/", () => {
    for (const p of Object.values(PWA_ICON_PATHS)) expect(() => pngSize(p), p).not.toThrow();
  });

  it("/icon (the favicon URL) is rewritten to a 32x32 PNG", async () => {
    const rules = await nextConfig.rewrites!();
    const list = Array.isArray(rules) ? rules : (rules.afterFiles ?? []);
    const rule = list.find((r) => r.source === "/icon");
    expect(rule).toBeDefined();
    expect(pngSize(rule!.destination)).toEqual({ width: 32, height: 32 });
  });
});
