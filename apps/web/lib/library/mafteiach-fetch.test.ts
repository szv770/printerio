import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { MAX_PAGE_BYTES } from "@printio/shared/library/mafteiach-fetch";
import { loadLikkutVolume, loadList, loadEntry } from "./mafteiach-fetch";

const page = (body: string, status = 200) => async () => new Response(body, { status });

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
