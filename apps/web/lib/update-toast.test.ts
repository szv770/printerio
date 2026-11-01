import { describe, expect, it } from "vitest";
import { toastSummary } from "./update-toast";
import type { StepView, UpdateView } from "./update-progress";

const steps = (states: StepView["state"][]): StepView[] =>
  states.map((state, i) => ({ id: `s${i}` as StepView["id"], label: `Step ${i + 1}`, state }));

describe("toastSummary", () => {
  it("is quiet when nothing is happening", () => {
    const quiet: UpdateView[] = [{ kind: "idle" }, { kind: "checking" }, { kind: "up_to_date", checkedAt: null }];
    for (const v of quiet) expect(toastSummary(v)).toBeNull();
  });

  it("says which step an update is holding at", () => {
    const t = toastSummary({ kind: "updating", steps: steps(["done", "active", "pending"]), message: null, startedAt: "2026-11-01T10:00:00Z" });
    expect(t).toMatchObject({ tone: "primary", title: "Updating the print server", live: true });
    expect(t?.detail).toBe("Step 2 of 3: Step 2");
    expect(t?.since).toBe("2026-11-01T10:00:00Z");
  });

  it("shows restarting, done and failed", () => {
    expect(toastSummary({ kind: "restarting", steps: steps(["done", "active"]), to: "1.2.3" })).toMatchObject({ title: "Restarting the print server", live: true });
    expect(toastSummary({ kind: "done", steps: steps(["done"]), from: "1.0", to: "1.2.3" })).toMatchObject({ tone: "success", title: "Print server updated", detail: "Now running 1.2.3", live: false });
    expect(toastSummary({ kind: "failed", steps: steps(["failed"]), message: "git pull failed" })).toMatchObject({ tone: "danger", title: "Update did not finish", detail: "git pull failed", live: false });
  });
});
