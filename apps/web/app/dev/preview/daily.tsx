"use client";

import { DailyStudyPanel } from "@/components/library/DailyStudyPanel";

const items = [
  { study: "chumash" as const, label: "Chumash with Rashi", portion: "Parshat Chayei Sarah, 1st Portion (Bereshit (Genesis) 23:1-23:16) with Rashi", saved: false, url: "https://www.chabad.org/dailystudy/torahreading.asp?tdate=11/1/2026" },
  { study: "tanya" as const, label: "Tanya", portion: "Iggeret HaKodesh, middle of Epistle 29", saved: true },
  { study: "rambam1" as const, label: "Rambam (1 chapter)", portion: "Issurei Biah - Chapter 13", saved: true },
  { study: "rambam3" as const, label: "Rambam (3 chapters)", portion: "Mechirah - Chapter 28, Mechirah - Chapter 29, Mechirah - Chapter 30", saved: false, url: "https://www.chabad.org/dailystudy/rambam.asp?tdate=11/1/2026&rambamChapters=3" },
];

/** The library's Daily study tab with made-up data (no login, no database). */
export function DailyStudyPreview() {
  return (
    <div className="mx-auto max-w-2xl p-4">
      <DailyStudyPanel
        canImport
        api={{
          day: async () => ({ ok: true, items }),
          build: async () => ({ ok: false, message: "Preview only." }),
          importFiles: async () => ({ ok: true, message: "Saved 1 page.", results: [{ name: "Rambam.htm", ok: true, message: "Saved: Issurei Biah - Chapter 13" }] }),
        }}
      />
    </div>
  );
}
