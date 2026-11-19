import { describe, expect, it } from "vitest";
import { GET, llmsText } from "./route";
import { FEATURE_ROWS } from "@/lib/landing-content";

describe("llms.txt", () => {
  it("is plain text", async () => {
    const res = GET();
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe(llmsText());
  });

  it("says Mac and Chromebook are still being tested and lists proven devices", () => {
    const t = llmsText();
    expect(t).toContain("confirmed working on Windows, iPhone and Android");
    expect(t).toMatch(/Mac and Chromebook are still being tested/);
  });

  it("puts features that are still being tested in their own section", () => {
    const t = llmsText();
    const testing = FEATURE_ROWS.filter((f) => f.testing);
    const [before, after = ""] = t.split("## Built, still being tested");
    for (const f of testing) {
      expect(before).not.toContain(f.title);
      expect(after).toContain(f.title);
    }
  });
});
