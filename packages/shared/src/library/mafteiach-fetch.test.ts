import { describe, expect, it } from "vitest";
import { decodeEmbeddedHtml, libraryPageUrl } from "./mafteiach-fetch";

describe("libraryPageUrl: only a few page shapes on the one library site", () => {
  it("builds the address for each kind of page", () => {
    expect(libraryPageUrl({ kind: "likkutei", volume: 3 })).toBe("https://www.mafteiach.app/likkutei_sichos/by_volume/3");
    expect(libraryPageUrl({ kind: "list", section: "maamorim", year: "5711" })).toBe("https://www.mafteiach.app/maamorim?order=by_year&year=5711");
    expect(libraryPageUrl({ kind: "list", section: "all", year: "5711" })).toBe("https://www.mafteiach.app/all/by_year/5711");
    expect(libraryPageUrl({ kind: "list", section: "maamorim" })).toBe("https://www.mafteiach.app/maamorim");
    expect(libraryPageUrl({ kind: "entry", path: "/maamorim/12" })).toBe("https://www.mafteiach.app/maamorim/12");
    expect(libraryPageUrl({ kind: "entry", path: "/all/5711-01-01" })).toBe("https://www.mafteiach.app/all/5711-01-01");
  });

  it("refuses anything else, so a crafted value can never point the server at another address", () => {
    expect(libraryPageUrl({ kind: "likkutei", volume: 0 })).toBeNull();
    expect(libraryPageUrl({ kind: "likkutei", volume: 400 })).toBeNull();
    expect(libraryPageUrl({ kind: "likkutei", volume: 1.5 })).toBeNull();
    expect(libraryPageUrl({ kind: "list", section: "all", year: "5711/../x" })).toBeNull();
    expect(libraryPageUrl({ kind: "list", section: "all", year: "5711&x=1" })).toBeNull();
    // years outside any real range, and absurd ids, are refused (they would only churn the cache and hammer the library's site)
    expect(libraryPageUrl({ kind: "list", section: "maamorim", year: "1234" })).toBeNull();
    expect(libraryPageUrl({ kind: "list", section: "maamorim", year: "9999" })).toBeNull();
    expect(libraryPageUrl({ kind: "entry", path: "/maamorim/9999999" })).toBeNull();
    for (const path of ["//evil.example/x", "/maamorim/../admin", "/maamorim/12?x=1", "http://evil.example/maamorim/1", "/maamorim/abc", "/all/5711-01-01/extra", "/likkutei_sichos/by_volume/1"]) {
      expect(libraryPageUrl({ kind: "entry", path }), path).toBeNull();
    }
  });
});

describe("decodeEmbeddedHtml", () => {
  it("reads the HTML some pages carry inside a script, as text and without running anything", () => {
    const js = 'x();\n  let html = "<main class=\\"a\\">\\n  <script>go(\\\'x\\\')<\\/script><p>\\u05d0&quot;<\\/p><\\/main>";\n  more();';
    expect(decodeEmbeddedHtml(js)).toBe('<main class="a">\n  <script>go(\'x\')</script><p>א&quot;</p></main>');
  });
  it("returns an ordinary page as it is", () => {
    expect(decodeEmbeddedHtml("<html><body>hi</body></html>")).toBe("<html><body>hi</body></html>");
  });
});
