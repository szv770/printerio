import { describe, expect, it } from "vitest";
import {
  NO_SECTION,
  applyPeopleQuery,
  buildProfileSearchOr,
  buildSearchOr,
  cleanSearchText,
  defaultPeopleQuery,
  escapeLike,
  pageCount,
  pageRange,
  parsePeopleParams,
  peopleQueryToSearch,
  quoteForOr,
  runPeopleQuery,
  type FilterChain,
} from "./people-query";
import { samplePeople } from "./people-sample";

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const chain: FilterChain = new Proxy({} as FilterChain, {
    get: (_t, name: string) => (...args: unknown[]) => {
      calls.push([name, ...args]);
      return chain;
    },
  });
  return { chain, calls };
}

describe("parsePeopleParams", () => {
  it("falls back to safe defaults for junk", () => {
    const q = parsePeopleParams({ role: "root", status: "x", sort: "password", dir: "up", page: "-4", size: "100000" });
    expect(q).toEqual(defaultPeopleQuery());
  });
  it("reads valid values and the first of repeated params", () => {
    const q = parsePeopleParams({ q: "  ann  ", role: ["staff", "student"], status: "disabled", section: "Science", sort: "name", dir: "desc", page: "3", size: "25" });
    expect(q.filter).toEqual({ q: "ann", role: "staff", status: "disabled", section: "Science" });
    expect([q.sort, q.dir, q.page, q.pageSize]).toEqual(["name", "desc", 3, 25]);
  });
  it("round trips through the URL and leaves defaults out", () => {
    expect(peopleQueryToSearch(defaultPeopleQuery())).toBe("");
    const q = parsePeopleParams({ q: "a b", role: "approver", section: NO_SECTION, page: "2", sort: "section" });
    expect(parsePeopleParams(new URLSearchParams(peopleQueryToSearch(q)))).toEqual(q);
  });
  it("cleans control characters and caps the search length", () => {
    expect(cleanSearchText("a\u0000b\n c")).toBe("a b c");
    expect(cleanSearchText("x".repeat(500))).toHaveLength(100);
  });
});

describe("search strings", () => {
  it("escapes LIKE wildcards and quotes commas safely", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    const or = buildSearchOr("a,b)", [])!;
    expect(or).toContain('department.ilike."%a,b)%"');
    expect(or).toContain('user_code.ilike."a,b)%"');
    expect(quoteForOr('x"y')).toBe('"x\\"y"');
  });
  it("adds only plain profile ids and returns null for empty text", () => {
    expect(buildSearchOr("  ", ["a"])).toBeNull();
    expect(buildSearchOr("kat", ["abc-1", "bad,id", "x)"])).toContain("user_id.in.(abc-1)");
    expect(buildSearchOr("kat", ["bad,id"])).not.toContain("user_id.in");
    expect(buildProfileSearchOr("kat")).toBe('email.ilike."%kat%",display_name.ilike."%kat%"');
  });
});

describe("applyPeopleQuery", () => {
  it("applies filters, a stable sort and the page range", () => {
    const { chain, calls } = recorder();
    const q = parsePeopleParams({ role: "staff", status: "active", section: "Art", page: "3", size: "25", sort: "section", dir: "desc" });
    applyPeopleQuery(chain, q, "x.ilike.y");
    expect(calls).toEqual([
      ["eq", "role", "staff"],
      ["eq", "status", "active"],
      ["eq", "department", "Art"],
      ["or", "x.ilike.y"],
      ["order", "department", { ascending: false, nullsFirst: false }],
      ["order", "user_id"],
      ["range", 50, 74],
    ]);
  });
  it("uses is-null for no section and does not filter by default", () => {
    const { chain, calls } = recorder();
    applyPeopleQuery(chain, parsePeopleParams({ section: NO_SECTION }), null);
    expect(calls[0]).toEqual(["is", "department", null]);
    const r = recorder();
    applyPeopleQuery(r.chain, defaultPeopleQuery(), null);
    expect(r.calls.map((c) => c[0])).toEqual(["order", "order", "range"]);
  });
  it("page maths", () => {
    expect(pageRange(1, 50)).toEqual({ from: 0, to: 49 });
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
  });
});

describe("runPeopleQuery (preview rules)", () => {
  const all = samplePeople(1500);
  it("pages 1,500 people with an exact total and no overlap", () => {
    const a = runPeopleQuery(all, { ...defaultPeopleQuery(), page: 1 });
    const b = runPeopleQuery(all, { ...defaultPeopleQuery(), page: 2 });
    expect(a.total).toBe(1500);
    expect(a.rows).toHaveLength(50);
    expect(new Set([...a.rows, ...b.rows].map((r) => r.userId)).size).toBe(100);
  });
  it("filters by role, status and section together and counts them", () => {
    const q = parsePeopleParams({ role: "staff", status: "active", section: "Science" });
    const r = runPeopleQuery(all, q);
    expect(r.total).toBe(all.filter((p) => p.role === "staff" && p.status === "active" && p.department === "Science").length);
    expect(r.rows.every((p) => p.department === "Science")).toBe(true);
  });
  it("searches name, email, section and code prefix", () => {
    expect(runPeopleQuery(all, parsePeopleParams({ q: "dana.kaplan@" })).rows[0]!.userId).toBe("p0");
    expect(runPeopleQuery(all, parsePeopleParams({ q: "science" })).total).toBeGreaterThan(0);
    const coded = all.find((p) => p.userCode)!;
    expect(runPeopleQuery(all, parsePeopleParams({ q: coded.userCode! })).rows.some((p) => p.userId === coded.userId)).toBe(true);
  });
  it("no-section filter", () => {
    const r = runPeopleQuery(all, parsePeopleParams({ section: NO_SECTION }));
    expect(r.rows.every((p) => !p.department)).toBe(true);
  });
});
