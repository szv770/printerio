import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitNotice } from "./WaitNotice";
import { OFFLINE_MESSAGE } from "@/lib/library/results";

const html = (view: Parameters<typeof WaitNotice>[0]["view"]) => renderToStaticMarkup(<WaitNotice view={view} onTryAgain={() => {}} />);

describe("WaitNotice", () => {
  it("while waiting: the waiting sentence with the seconds, and no button (the screen asks again by itself)", () => {
    const out = html({ kind: "pending", message: "ignored", gaveUp: false, elapsedMs: 17_000 });
    expect(out).toContain("Waiting for your print server to fetch this page (about 15 seconds)");
    expect(out).not.toContain("<button");
    expect(out).not.toContain("ignored");
  });

  it("at the start there are no seconds yet", () => {
    expect(html({ kind: "pending", message: "", gaveUp: false, elapsedMs: 0 })).toContain("Waiting for your print server to fetch this page...");
  });

  it("after the cap: the longer-than-usual sentence and the Try again button", () => {
    const out = html({ kind: "pending", message: "", gaveUp: true, elapsedMs: 91_000 });
    expect(out).toContain("This is taking longer than usual. Try again in a minute.");
    expect(out).toContain("Try again</button>");
    expect(out).not.toContain("Waiting for your print server");
  });

  it("print server offline: the message and the Try again button only", () => {
    const out = html({ kind: "offline", message: OFFLINE_MESSAGE, gaveUp: false, elapsedMs: 0 });
    expect(out).toContain(OFFLINE_MESSAGE);
    expect(out).toContain("Try again</button>");
    expect(out).not.toContain("Waiting for your print server");
  });
});
