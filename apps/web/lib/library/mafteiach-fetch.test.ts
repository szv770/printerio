import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { decodeEmbeddedHtml, libraryPageUrl, loadLikkutVolume, loadList, loadEntry, MAX_PAGE_BYTES } from "./mafteiach-fetch";

const page = (body: string, status = 200) => async () => new Response(body, { status });

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

describe("loading and reading pages", () => {
  it("loads a Likkutei Sichos volume and a year list and an entry", async () => {
    const volume = '<button class="f4 volume active" id="volume_2">ב</button><div class="parsha"><button class="parsha-button">שמות <span class="thin-font">(1 שיחה)</span></button></div>';
    const res = await loadLikkutVolume(2, { fetchPage: page(volume) });
    expect(res.ok && res.page.volumes).toEqual([{ n: 2, label: "ב" }]);
    expect(res.ok && res.page.parshiyos[0]?.name).toBe("שמות");

    const list = await loadList({ section: "maamorim", year: "5711" }, { fetchPage: page('<a class="year active" href="/maamorim?order=by_year&amp;year=5711">תשי"א</a>') });
    expect(list.ok && list.page.years).toEqual([{ year: "5711", label: 'תשי"א', current: true }]);

    const entry = await loadEntry("/maamorim/1", { fetchPage: page('<div class="farbrengen-detail-content"><h4>הנחות</h4><a href="https://drive.google.com/file/d/abc/view">x</a></div>') });
    expect(entry.ok && entry.sections).toHaveLength(1);
  });

  it("explains a bad page address, an unreachable site, a missing page and a page that looks different", async () => {
    expect((await loadEntry("//evil.example/x", { fetchPage: page("") })).ok).toBe(false);
    const down = await loadLikkutVolume(1, {
      fetchPage: async () => {
        throw new Error("offline");
      },
    });
    expect(!down.ok && down.message).toMatch(/could not reach/i);
    const gone = await loadLikkutVolume(1, { fetchPage: page("nope", 404) });
    expect(!gone.ok && gone.message).toMatch(/not find/i);
    const odd = await loadLikkutVolume(1, { fetchPage: page("<html>nothing</html>") });
    expect(!odd.ok && odd.message).toMatch(/looks different/i);
  });

  it("refuses a page that is far too big", async () => {
    const huge = await loadLikkutVolume(1, { fetchPage: page("x".repeat(MAX_PAGE_BYTES + 1)) });
    expect(!huge.ok && huge.message).toMatch(/too large/i);
  });
});
