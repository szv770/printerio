import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_EVENT_DISPLAY, JOB_EVENT_TYPES, jobEventDisplay, type JobEventType } from "./job-event-labels";

/** Pulls the event_type CHECK list straight out of the migration that defines
 *  it, so this file is grounded in the real constraint rather than a
 *  hand-copied duplicate of it. */
function eventTypesFromMigration(): string[] {
  const sql = readFileSync(
    path.resolve(__dirname, "../../../supabase/migrations/0003_jobs_tables.sql"),
    "utf8",
  );
  const match = sql.match(/event_type text not null check \(event_type in \(([\s\S]*?)\)\)/);
  const constraintList = match?.[1];
  if (!constraintList) {
    throw new Error("could not find the print_job_events event_type CHECK constraint in 0003_jobs_tables.sql");
  }
  return [...constraintList.matchAll(/'([A-Z_]+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

describe("JOB_EVENT_TYPES", () => {
  it("covers exactly the event types the database actually allows", () => {
    expect([...JOB_EVENT_TYPES].sort()).toEqual(eventTypesFromMigration().sort());
  });

  it("has a display entry for every declared event type", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(JOB_EVENT_DISPLAY[type]).toBeDefined();
    }
  });
});

describe("JOB_EVENT_DISPLAY", () => {
  it("never leaks an internal pipeline constant into a user-visible label", () => {
    for (const type of JOB_EVENT_TYPES) {
      const { label } = JOB_EVENT_DISPLAY[type];
      expect(label).not.toMatch(/[A-Z]{2,}_/); // no SCREAMING_SNAKE_CASE
      expect(label).not.toBe(type);
    }
  });

  it("gives every event type a real icon (this app uses lucide icons, never emoji)", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(typeof JOB_EVENT_DISPLAY[type].Icon).not.toBe("undefined");
      expect(JOB_EVENT_DISPLAY[type].label).toMatch(/^[ -~]*$/); // printable ASCII only - no emoji
    }
  });

  it("starts every label with a capital, so a history list reads consistently", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(JOB_EVENT_DISPLAY[type].label[0]).toMatch(/[A-Z]/);
    }
  });
});

describe("jobEventDisplay", () => {
  it("returns the mapped display for a known event type", () => {
    expect(jobEventDisplay("PREFLIGHT_COMPLETED").label).toBe("Document checked");
  });

  it("falls back to the raw value for an unknown event type rather than throwing", () => {
    expect(jobEventDisplay("SOME_FUTURE_EVENT").label).toBe("SOME_FUTURE_EVENT");
  });

  it("resolves every declared type to that type's own entry", () => {
    for (const type of JOB_EVENT_TYPES) {
      expect(jobEventDisplay(type)).toBe(JOB_EVENT_DISPLAY[type as JobEventType]);
    }
  });
});
