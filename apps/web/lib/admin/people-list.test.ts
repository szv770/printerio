import { describe, expect, it } from "vitest";
import { failure, fakeSupabase, ok, type FakeCall } from "@/test/fake-supabase";
import { distinctSections, fetchPeoplePage, fetchSections } from "./people-list";
import { defaultPeopleQuery, parsePeopleParams } from "./people-query";

const row = (i: number) => ({ user_id: `u${i}`, role: "staff", status: "active", department: "Art", created_at: "2026-01-01T00:00:00Z", user_code: null, profiles: { email: `p${i}@x.org`, display_name: `P ${i}` } });

describe("fetchPeoplePage", () => {
  it("scopes by organization, uses the exact count and the page range, and maps rows", async () => {
    const fake = fakeSupabase(() => ({ data: [row(1), row(2)], error: null, count: 1284 }));
    const res = await fetchPeoplePage(fake.client as never, "org-1", { ...defaultPeopleQuery(), page: 3 });
    expect(res.total).toBe(1284);
    expect(res.rows.map((r) => r.userId)).toEqual(["u1", "u2"]);
    const call = fake.calls[0]!;
    expect(call.table).toBe("organization_members");
    expect(call.filters).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(call.filters).toContainEqual(["range", 100, 149]);
    expect(call.filters.some((f) => f[0] === "limit")).toBe(false);
  });

  it("searches profiles of THIS organization first, then ORs the ids into the members query", async () => {
    const fake = fakeSupabase((c: FakeCall) => (c.table === "profiles" ? ok([{ id: "u9" }]) : { data: [row(9)], error: null, count: 1 }));
    const res = await fetchPeoplePage(fake.client as never, "org-1", parsePeopleParams({ q: "kat" }));
    const profiles = fake.calls[0]!;
    expect(profiles.table).toBe("profiles");
    expect(profiles.filters).toContainEqual(["eq", "organization_members.organization_id", "org-1"]);
    const members = fake.calls[1]!;
    const or = members.filters.find((f) => f[0] === "or")![1] as string;
    expect(or).toContain("user_id.in.(u9)");
    expect(or).toContain("department.ilike");
    expect(res.total).toBe(1);
  });

  it("flags a search that matched more names than it looks at", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => ({ id: `u${i}` }));
    const fake = fakeSupabase((c) => (c.table === "profiles" ? ok(ids) : { data: [], error: null, count: 0 }));
    const res = await fetchPeoplePage(fake.client as never, "org-1", parsePeopleParams({ q: "a" }));
    expect(res.searchTruncated).toBe(true);
  });

  it("falls back to date joined when ordering by name is refused", async () => {
    let n = 0;
    const fake = fakeSupabase(() => (n++ === 0 ? failure("bad order") : { data: [row(1)], error: null, count: 1 }));
    const res = await fetchPeoplePage(fake.client as never, "org-1", parsePeopleParams({ sort: "name" }));
    expect(res.sortFellBack).toBe(true);
    expect(res.rows).toHaveLength(1);
  });

  it("reports a page past the end instead of throwing", async () => {
    let n = 0;
    const fake = fakeSupabase(() => (n++ === 0 ? failure("range") : { data: [row(1)], error: null, count: 60 }));
    const res = await fetchPeoplePage(fake.client as never, "org-1", parsePeopleParams({ page: "9" }));
    expect(res.outOfRange).toBe(true);
    expect(res.total).toBe(60);
  });
});

describe("sections", () => {
  it("distinct, trimmed, sorted ignoring case, exact text kept", () => {
    expect(distinctSections(["b", " Art ", null, "art", "", "B", undefined])).toEqual(["Art", "art", "B", "b"]);
  });
  it("reads in chunks of 1,000 scoped to the organization", async () => {
    const fake = fakeSupabase((c) => (c.columns === "user_id" ? { data: null, error: null, count: 2500 } : ok([{ department: "A" }])));
    const out = await fetchSections(fake.client as never, "org-1");
    expect(out).toEqual(["A"]);
    const reads = fake.calls.filter((c) => c.columns === "department");
    expect(reads).toHaveLength(3);
    expect(reads.every((c) => c.filters.some((f) => f[0] === "eq" && f[2] === "org-1"))).toBe(true);
  });
});
