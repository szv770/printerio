import { describe, expect, it } from "vitest";
import { GENERIC_HELP, HELP_PAGES, helpForPath, helpPageId, type HelpPage } from "./help-content";

const all: Array<[string, HelpPage]> = [...Object.entries(HELP_PAGES), ["generic", GENERIC_HELP]];

function texts(p: HelpPage): string[] {
  return [p.title, p.what, p.done, ...p.first, ...p.problems.flatMap((q) => [q.question, q.answer])];
}

describe("help content", () => {
  it.each(all)("%s has every field filled in", (_id, p) => {
    expect(p.title.trim()).not.toBe("");
    expect(p.what.trim()).not.toBe("");
    expect(p.done.trim()).not.toBe("");
    expect(p.first.length).toBeGreaterThanOrEqual(1);
    expect(p.first.length).toBeLessThanOrEqual(3);
    expect(p.problems.length).toBeLessThanOrEqual(3);
    for (const t of texts(p)) expect(t.trim()).not.toBe("");
  });

  it.each(all)("%s has no developer words", (_id, p) => {
    const joined = texts(p).join("\n");
    expect(joined).not.toMatch(/\bAgents?\b/);
    expect(joined).not.toMatch(/\bRLS\b/);
    expect(joined).not.toMatch(/endpoint/i);
    expect(joined).not.toMatch(/enrollment code/i);
    expect(joined).not.toMatch(/\b(docs|apps|lib)\/|\.(md|tsx?|sql)\b/);
  });

  it("covers the member and admin pages that exist", () => {
    for (const path of ["/home", "/print", "/jobs", "/jobs/abc", "/devices", "/profile", "/usage", "/admin", "/admin/devices", "/admin/printers", "/admin/agents", "/admin/users", "/admin/invites", "/admin/groups", "/admin/policies", "/admin/quotas", "/admin/approvals", "/admin/reports", "/admin/audit", "/admin/storage", "/admin/settings"]) {
      expect(helpForPath(path), path).not.toBeNull();
    }
  });

  it("handles ids, trailing slashes and unknown pages", () => {
    expect(helpPageId("/admin/agents/123")).toBe("adminAgent");
    expect(helpPageId("/print/preparing/9")).toBe("print");
    expect(helpPageId("/admin/printers/")).toBe("adminPrinters");
    expect(helpForPath("/platform")).toBeNull();
    expect(helpForPath(null)).toBeNull();
  });

  it("resolves the developer preview by its section", () => {
    expect(helpPageId("/dev/preview", "?section=teacher")).toBe("home");
    expect(helpPageId("/dev/preview", "?section=adminhome&shell=admin")).toBe("adminHome");
  });
});
