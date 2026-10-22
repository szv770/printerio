import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileSnapshotCache, wrapSubmitAction, type SubmitState } from "./print-submit";

/** A File that reads fine the first time and then throws, like a picked file the browser/OneDrive invalidated. */
function staleAfterFirstRead(bytes = [0x25, 0x50, 0x44, 0x46]) {
  const real = new File([new Uint8Array(bytes)], "doc.pdf", { type: "application/pdf" });
  let reads = 0;
  const file = new Proxy(real, {
    get(target, prop) {
      if (prop === "arrayBuffer") {
        return async () => {
          if (reads++ > 0) throw new DOMException("The requested file could not be read", "NotReadableError");
          return target.arrayBuffer();
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as File;
  return file;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("file snapshot (the answer to the blank-pages question)", () => {
  it("still sends the file after the picked file went stale during a long wait", async () => {
    const picked = staleAfterFirstRead();
    const cache = createFileSnapshotCache();

    const first = await cache.get(picked); // first Print press, read while the file was fine
    expect(first.size).toBe(4);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // the member does not answer for ten minutes
    await expect(picked.arrayBuffer()).rejects.toThrow(); // the live handle is now unreadable

    const second = await cache.get(picked); // the answer re-sends the snapshot, not the stale handle
    expect(second).toBe(first);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(second.name).toBe("doc.pdf");
    expect(second.type).toBe("application/pdf");
  });

  it("takes a fresh snapshot when a different file is picked or the cache is cleared", async () => {
    const cache = createFileSnapshotCache();
    const a = new File([new Uint8Array([1])], "a.pdf");
    const b = new File([new Uint8Array([2, 2])], "b.pdf");
    const snapA = await cache.get(a);
    expect((await cache.get(b)).size).toBe(2);
    cache.clear();
    expect(await cache.get(a)).not.toBe(snapA);
  });

  it("explains plainly when the file cannot be read at all", async () => {
    const dead = staleAfterFirstRead();
    await dead.arrayBuffer();
    await expect(createFileSnapshotCache().get(dead)).rejects.toThrow(/choose the file again/i);
  });
});

describe("wrapSubmitAction (never a silent failure)", () => {
  const needs = { sourcePages: 10, paddedPages: 12, blankPagesAdded: 2 };
  const asking: SubmitState = { needsBookletConfirm: needs };
  const confirmData = () => {
    const fd = new FormData();
    fd.set("confirmBookletPadding", "true");
    return fd;
  };

  it("passes a normal result straight through", async () => {
    const wrapped = wrapSubmitAction<SubmitState>(async () => ({ needsBookletConfirm: needs }));
    expect(await wrapped({}, new FormData())).toEqual({ needsBookletConfirm: needs });
  });

  it("turns a thrown/timed-out call into a plain message and keeps the question open", async () => {
    const wrapped = wrapSubmitAction<SubmitState>(async () => {
      throw new Error("Failed to fetch");
    });
    const out = await wrapped(asking, confirmData());
    expect(out.error).toMatch(/press .* again/i);
    expect(out.error).toMatch(/still here|kept/i);
    expect(out.needsBookletConfirm).toEqual(needs);
  });

  it("keeps the question open when the server answers the confirmation with an error", async () => {
    const wrapped = wrapSubmitAction<SubmitState>(async () => ({ error: "You're submitting jobs too quickly." }));
    const out = await wrapped(asking, confirmData());
    expect(out).toEqual({ error: "You're submitting jobs too quickly.", needsBookletConfirm: needs });
  });

  it("does not invent a question for an ordinary failed submit", async () => {
    const wrapped = wrapSubmitAction<SubmitState>(async () => {
      throw new Error("boom");
    });
    const out = await wrapped({}, new FormData());
    expect(out.error).toBeTruthy();
    expect(out.needsBookletConfirm).toBeUndefined();
  });

  it("lets Next's redirect signal through untouched", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/jobs/1;307;" });
    const wrapped = wrapSubmitAction<SubmitState>(async () => {
      throw redirect;
    });
    await expect(wrapped({}, confirmData())).rejects.toBe(redirect);
  });

  it("answers the same no matter how long the member waited (server holds no state)", async () => {
    const action = vi.fn(async (_p: SubmitState, fd: FormData): Promise<SubmitState> => (fd.get("confirmBookletPadding") === "true" ? {} : { needsBookletConfirm: needs }));
    const wrapped = wrapSubmitAction<SubmitState>(action);
    const q = await wrapped({}, new FormData());
    expect(q.needsBookletConfirm).toEqual(needs);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const a = await wrapped(q, confirmData());
    expect(a.error).toBeUndefined();
    expect(action).toHaveBeenCalledTimes(2);
  });
});
