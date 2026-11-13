"use client";

import { useState } from "react";
import { DailyStudyPanel } from "@/components/library/DailyStudyPanel";
import { Segmented } from "@/components/ui";

const items = [
  { study: "chumash" as const, label: "Chumash with Rashi", portion: "Parshat Chayei Sarah, 2nd Portion (Bereshit (Genesis) 23:17-24:9)" },
  { study: "tanya" as const, label: "Tanya", portion: "Iggeret HaKodesh, middle of Epistle 29" },
  { study: "hayomyom" as const, label: "Hayom Yom", portion: "Daily Study: Hayom Yom" },
  { study: "rambam3" as const, label: "Rambam (3 chapters)", portion: "Zechiyah uMattanah - Chapter 1, Zechiyah uMattanah - Chapter 2, Zechiyah uMattanah - Chapter 3" },
  { study: "rambam1" as const, label: "Rambam (1 chapter)", portion: "Issurei Biah - Chapter 14 | Shiur 273" },
];

/** The library's Daily study tab with made-up data (no login, no database). */
export function DailyStudyPreview() {
  const [tab, setTab] = useState("daily");
  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="mb-4">
        <Segmented
          label="Part of the library"
          value={tab}
          onChange={setTab}
          options={[
            { value: "likkutei", label: "Likkutei Sichos" },
            { value: "maamorim", label: "Maamarim" },
            { value: "all", label: "Sichos and farbrengens" },
            { value: "sie", label: "Sichos In English" },
            { value: "daily", label: "Daily study" },
          ]}
        />
      </div>
      <DailyStudyPanel api={{ day: async () => ({ ok: true, items }), build: async () => ({ ok: false, message: "Preview only." }), fonts: async () => ({ ok: true, fonts: [{ id: "f1", name: "OT Siddur Classic", hasVowels: true, hasCantillation: true }, { id: "f2", name: "Sample no trop", hasVowels: true, hasCantillation: false }] }) }} />
    </div>
  );
}
