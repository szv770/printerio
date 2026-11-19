import { describe, expect, it } from "vitest";
import { addRecent, linkToRemember, MAX_RECENT_LINKS, parseRecent, recentEntry, type RecentLink } from "./recent-links";

const u = (s: string) => new URL(s);

describe("linkToRemember: only links with nothing secret in them", () => {
  it.each([
    "https://drive.google.com/file/d/1Q6o-wEkpAsvRQIaJqSqcCOkBZhQAAdYI/view?usp=sharing",
    "https://www.dropbox.com/s/abc123xyz/a.pdf?dl=0",
    "https://example.org/files/a.pdf",
    "https://www.hebrewbooks.org/pdfpager.aspx",
  ])("keeps %s", (link) => {
    expect(linkToRemember(u(link))).toBe(u(link).toString());
  });

  it.each([
    "https://www.dropbox.com/scl/fi/h2k3j4/a.pdf?rlkey=Qw3rTy&dl=0",
    "https://drive.google.com/file/d/1Q6o-wEkpAsvRQIaJqSqcCOkBZhQAAdYI/view?resourcekey=0-abc",
    "https://onedrive.live.com/redir?resid=A%21B&authkey=%21k",
    "https://example.org/a.pdf?token=abc",
    "https://example.org/a.pdf?X-Amz-Signature=abc&X-Amz-Expires=300",
    "https://example.org/a.pdf?sig=abc",
    "https://example.org/a.pdf?e=1&st=2",
    "https://example.org/a.pdf?something=else",
    "https://example.org/a.pdf?usp=sharing&key=1",
    "https://example.org/a.pdf?USP=sharing&Token=1",
    "https://example.org/a.pdf#access_token=abc",
    "https://user:pw@example.org/a.pdf",
    "http://example.org/a.pdf",
  ])("does not keep %s", (link) => {
    expect(linkToRemember(u(link))).toBeNull();
  });
});

describe("recentEntry", () => {
  it("stores the host and name, and never the query when the link has a secret", () => {
    const e = recentEntry(u("https://www.dropbox.com/scl/fi/h2k3j4/a.pdf?rlkey=Qw3rTy&dl=0"), "Sicha.pdf", 5);
    expect(e).toEqual({ host: "www.dropbox.com", name: "Sicha.pdf", link: null, at: 5 });
    expect(JSON.stringify(e)).not.toContain("Qw3rTy");
  });
  it("trims a very long name", () => {
    expect(recentEntry(u("https://example.org/a.pdf"), "x".repeat(500), 1).name).toHaveLength(120);
  });
});

describe("addRecent", () => {
  const e = (n: number, link: string | null = `https://example.org/${n}.pdf`): RecentLink => ({ host: "example.org", name: `f${n}.pdf`, link, at: n });
  it("puts the newest first and keeps five", () => {
    let list: RecentLink[] = [];
    for (let i = 1; i <= 7; i++) list = addRecent(list, e(i));
    expect(list.map((x) => x.at)).toEqual([7, 6, 5, 4, 3]);
    expect(list).toHaveLength(MAX_RECENT_LINKS);
  });
  it("moves a link fetched again to the top instead of listing it twice", () => {
    const list = addRecent(addRecent(addRecent([], e(1)), e(2)), { ...e(1), at: 9 });
    expect(list.map((x) => x.at)).toEqual([9, 2]);
  });
  it("entries without a stored link are the same when host and name match", () => {
    const list = addRecent(addRecent([], e(1, null)), { ...e(1, null), at: 4 });
    expect(list).toHaveLength(1);
    expect(list[0]!.at).toBe(4);
  });
  it("does not change the list it was given", () => {
    const before = [e(1)];
    addRecent(before, e(2));
    expect(before).toHaveLength(1);
  });
});

describe("parseRecent: whatever is in storage is not trusted", () => {
  it("reads what was written", () => {
    const list = [recentEntry(u("https://example.org/a.pdf"), "A.pdf", 1)];
    expect(parseRecent(JSON.stringify(list))).toEqual(list);
  });
  it.each([null, "", "not json", "{}", "42", '"x"', "[null, 3, {}]"])("%s gives an empty list", (raw) => {
    expect(parseRecent(raw)).toEqual([]);
  });
  it("drops a secret link someone put in storage by hand, but keeps the entry", () => {
    const raw = JSON.stringify([{ host: "x.org", name: "A.pdf", link: "https://x.org/a.pdf?token=abc", at: 1 }]);
    expect(parseRecent(raw)).toEqual([{ host: "x.org", name: "A.pdf", link: null, at: 1 }]);
  });
  it("drops a link that is not an address, and caps the length of the list", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ host: "x.org", name: `n${i}`, link: "not a link", at: i }));
    const out = parseRecent(JSON.stringify(items));
    expect(out).toHaveLength(MAX_RECENT_LINKS);
    expect(out.every((x) => x.link === null)).toBe(true);
  });
});
