/**
 * SAMPLE people for the dev preview only (app/dev/preview). Deterministic, made up, never read from or written to a database:
 * the preview pages use it to look at the People and Groups screens with 5, 60 and 1,500 people.
 */
import type { MemberSource, PersonRow } from "./people-query";

const FIRST = ["Dana", "Moshe", "Rivka", "Avi", "Sarah", "Yosef", "Leah", "Daniel", "Miriam", "Eli", "Chana", "Noah", "Esther", "Aaron", "Tamar", "Ben", "Rachel", "Shmuel", "Naomi", "David", "Hannah", "Isaac", "Talia", "Jacob", "Ruth"];
const LAST = ["Kaplan", "Levi", "Stein", "Goldman", "Cohen", "Katz", "Friedman", "Shapiro", "Klein", "Weiss", "Rosen", "Adler", "Berger", "Gross", "Hirsch", "Lieber", "Mandel", "Newman", "Oster", "Pearl", "Rubin", "Sachs", "Teller", "Unger", "Vogel"];
export const SAMPLE_SECTIONS = ["Math", "Science", "English", "History", "Art", "Office", "Library", "Grade 5", "Grade 6", "Grade 7"];

export const SAMPLE_ADMIN_ID = "p0";

/** `count` made-up people. Person 0 is the admin looking at the screen; a few are approvers, a few are switched off, some have no section. */
export function samplePeople(count: number): PersonRow[] {
  const out: PersonRow[] = [];
  const start = Date.parse("2026-01-12T09:00:00Z");
  for (let i = 0; i < count; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[Math.floor(i / FIRST.length + i * 7) % LAST.length]!;
    const nameless = i > 0 && i % 23 === 0;
    const role = i === 0 || i === 1 ? "org_admin" : i % 29 === 0 ? "approver" : i % 3 === 0 ? "staff" : count > 100 ? "student" : "staff";
    out.push({
      userId: `p${i}`,
      displayName: nameless ? null : `${first} ${last}`,
      email: `${first}.${last}${i >= 100 ? i : ""}@lecfl.com`.toLowerCase(),
      role,
      status: i > 1 && i % 13 === 0 ? "disabled" : "active",
      department: i % 11 === 0 ? null : SAMPLE_SECTIONS[(i * 3 + (i % 7)) % SAMPLE_SECTIONS.length]!,
      userCode: i % 17 === 0 ? null : `${first[0]}${last[0]}${(i % 90) + 10}`,
      joinedAt: new Date(start + i * 3_600_000 * 5).toISOString(),
      source: "manual" satisfies MemberSource,
    });
  }
  return out;
}
