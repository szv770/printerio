import { describe, expect, it } from "vitest";
import { buildAttentionItems, buildRightNow, adminAllClearText, type AttentionInput, type RightNowInput } from "./admin-home";

const NOW = new Date("2026-03-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;

const none: AttentionInput = {
  now: NOW,
  pendingApprovals: { count: 0, oldestCreatedAt: null },
  failed: { count: 0, recent: [] },
  agents: [],
  printers: [],
  heldCount: 0,
  stuckDevices: null,
};

describe("buildAttentionItems", () => {
  it("is empty when everything is fine", () => {
    expect(buildAttentionItems(none)).toEqual([]);
    expect(adminAllClearText()).toBe("All clear. Nothing needs you right now.");
  });

  it("approvals: count, oldest age, link", () => {
    const [item] = buildAttentionItems({ ...none, pendingApprovals: { count: 3, oldestCreatedAt: ago(40 * MIN) } });
    expect(item).toMatchObject({ id: "approvals", severity: "warning", title: "3 jobs waiting for approval", href: "/admin/approvals", action: "Review" });
    expect(item?.note).toBe("The oldest has waited 40 minutes.");
  });

  it("singular approval", () => {
    const [item] = buildAttentionItems({ ...none, pendingApprovals: { count: 1, oldestCreatedAt: ago(MIN) } });
    expect(item?.title).toBe("1 job waiting for approval");
  });

  it("failed: names of the latest failures", () => {
    const [item] = buildAttentionItems({
      ...none,
      failed: {
        count: 2,
        recent: [
          { name: "Quiz.pdf", errorMessage: 'queue "Lib" not found' },
          { name: "Handout.pdf", errorMessage: null },
        ],
      },
    });
    expect(item).toMatchObject({ id: "failed", severity: "danger", title: "2 prints failed this week", href: "/admin/reports", action: "See why" });
    expect(item?.note).toContain("Quiz.pdf");
    expect(item?.note).toContain("Handout.pdf");
  });

  it("single failure uses the friendly reason", () => {
    const [item] = buildAttentionItems({ ...none, failed: { count: 1, recent: [{ name: "A.pdf", errorMessage: 'queue "Lib" not found' }] } });
    expect(item?.title).toBe("1 print failed this week");
    expect(item?.note).toContain("A.pdf");
    expect(item?.note).toContain("printer queue");
  });

  it("print server offline when last seen over two minutes ago", () => {
    const items = buildAttentionItems({ ...none, agents: [{ id: "a1", name: "Front office PC", lastSeenAt: ago(14 * MIN) }] });
    expect(items[0]).toMatchObject({ id: "agents", severity: "danger", title: "Print server is offline", href: "/admin/agents" });
    expect(items[0]?.note).toContain("14 min ago");
  });

  it("an agent seen 90s ago is fine; a never-connected agent is not an alert (setup covers it)", () => {
    expect(
      buildAttentionItems({
        ...none,
        agents: [
          { id: "a1", name: "x", lastSeenAt: ago(90_000) },
          { id: "a2", name: "y", lastSeenAt: null },
        ],
      }),
    ).toEqual([]);
  });

  it("several offline servers are pluralised", () => {
    const [item] = buildAttentionItems({
      ...none,
      agents: [
        { id: "a1", name: "A", lastSeenAt: ago(10 * MIN) },
        { id: "a2", name: "B", lastSeenAt: ago(20 * MIN) },
      ],
    });
    expect(item?.title).toBe("2 print servers are offline");
  });

  it("printers offline or in error", () => {
    const [item] = buildAttentionItems({
      ...none,
      printers: [
        { id: "p1", name: "Library", status: "offline" },
        { id: "p2", name: "Office", status: "online" },
      ],
    });
    expect(item).toMatchObject({ id: "printers", severity: "danger", title: "Library printer is offline", href: "/admin/printers" });
    const [two] = buildAttentionItems({
      ...none,
      printers: [
        { id: "p1", name: "Library", status: "offline" },
        { id: "p2", name: "Office", status: "error" },
      ],
    });
    expect(two?.title).toBe("2 printers need a look");
    expect(two?.note).toBe("Library, Office");
  });

  it("held jobs and stuck devices", () => {
    const items = buildAttentionItems({ ...none, heldCount: 2, stuckDevices: 4 });
    expect(items.map((i) => i.id)).toEqual(["held", "devices"]);
    expect(items[0]).toMatchObject({ severity: "warning", title: "2 jobs need a choice from their owner" });
    expect(items[1]).toMatchObject({ title: "4 devices are connected but stuck", href: "/admin/devices" });
  });

  it("devices zero adds nothing", () => {
    expect(buildAttentionItems({ ...none, stuckDevices: 0 })).toEqual([]);
  });

  it("orders danger before warning, with a fixed order inside each group", () => {
    const items = buildAttentionItems({
      ...none,
      pendingApprovals: { count: 1, oldestCreatedAt: ago(MIN) },
      failed: { count: 1, recent: [{ name: "A", errorMessage: null }] },
      agents: [{ id: "a", name: "A", lastSeenAt: ago(10 * MIN) }],
      printers: [{ id: "p", name: "P", status: "error" }],
      heldCount: 1,
      stuckDevices: 1,
    });
    expect(items.map((i) => i.id)).toEqual(["agents", "printers", "failed", "approvals", "held", "devices"]);
  });
});

describe("buildRightNow", () => {
  const base: RightNowInput = { now: NOW, agents: [], printers: [], activeJobs: [] };

  it("print server OK vs Offline with last seen", () => {
    const rows = buildRightNow({
      ...base,
      agents: [
        { id: "a1", name: "Front office PC", lastSeenAt: ago(30_000) },
        { id: "a2", name: "Back PC", lastSeenAt: ago(9 * MIN) },
        { id: "a3", name: "New PC", lastSeenAt: null },
      ],
    });
    expect(rows[0]).toMatchObject({ name: "Front office PC", tone: "success", word: "OK" });
    expect(rows[1]).toMatchObject({ tone: "danger", word: "Offline" });
    expect(rows[1]?.detail).toBe("Last seen 9 min ago");
    expect(rows[2]?.detail).toBe("Has not connected yet");
  });

  it("a printer with an active job is Busy and shows the job and its size", () => {
    const rows = buildRightNow({
      ...base,
      printers: [{ id: "p1", name: "Main office", status: "online" }],
      activeJobs: [{ id: "j1", jobNumber: "PR-1042", printerId: "p1", status: "printing", pages: 12, copies: 28 }],
    });
    expect(rows[0]).toMatchObject({ name: "Main office", tone: "live", word: "Busy" });
    expect(rows[0]?.detail).toBe("Printing PR-1042 · 12 pages · 28 copies");
  });

  it("idle online printer is Ready, offline/error are Offline/Problem, unknown is neutral", () => {
    const rows = buildRightNow({
      ...base,
      printers: [
        { id: "1", name: "A", status: "online" },
        { id: "2", name: "B", status: "offline" },
        { id: "3", name: "C", status: "error" },
        { id: "4", name: "D", status: "mystery" },
      ],
    });
    expect(rows.map((r) => [r.tone, r.word])).toEqual([
      ["success", "Ready"],
      ["danger", "Offline"],
      ["danger", "Problem"],
      ["neutral", "Unknown"],
    ]);
  });

  it("active jobs without a known printer still show", () => {
    const rows = buildRightNow({
      ...base,
      activeJobs: [{ id: "j1", jobNumber: "PR-7", printerId: null, status: "claimed", pages: 1, copies: 1 }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tone: "live", word: "Busy" });
    expect(rows[0]?.detail).toBe("Sent to printer PR-7 · 1 page");
  });
});
