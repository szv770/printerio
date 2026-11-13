"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { Button, FormError, Segmented, Spinner } from "@/components/ui";
import { buildDailyBookletAction, dailyDayAction, dailyFontsAction, type DailyDayItem } from "@/app/(dashboard)/print/library/daily-actions";
import { putBuiltBooklet } from "@/lib/booklet/handoff";
import { builderPrintUrl } from "@/lib/booklet/builder-params";
import { localIsoDate, shiftIso } from "@/lib/library/daily/dates";
import { DAILY_CREDIT, type OfferedStudy } from "@/lib/library/daily/studies";
import type { Language } from "@/lib/library/daily/fill";

function pdfFile(base64: string, name: string): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "application/pdf", lastModified: Date.now() });
}

export interface DailyApi {
  day: typeof dailyDayAction;
  build: typeof buildDailyBookletAction;
  fonts: typeof dailyFontsAction;
}

const FONT_KEY = "printio.daily.hebrewFont";
const readSavedFont = (): string => {
  try {
    return localStorage.getItem(FONT_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveFont = (id: string) => {
  try {
    localStorage.setItem(FONT_KEY, id);
  } catch {
    /* a remembered choice is only a convenience */
  }
};

/**
 * The library's Daily study tab: the day's Chumash with Rashi, Tanya, Hayom Yom and Rambam, in a booklet whose pages are filled
 * edge to edge (Hebrew on the left, English on the right, or either alone). Printio fetches a day from its source the first time
 * anyone opens it and keeps it, so nobody has to find or upload anything.
 */
export function DailyStudyPanel({ api }: { /** Stand-ins for the server actions, used only by the dev preview page. */ api?: Partial<DailyApi> }) {
  const router = useRouter();
  const call: DailyApi = { day: dailyDayAction, build: buildDailyBookletAction, fonts: dailyFontsAction, ...api };
  const [date, setDate] = useState<string | null>(null);
  const [items, setItems] = useState<DailyDayItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [picked, setPicked] = useState<OfferedStudy[]>([]);
  const [language, setLanguage] = useState<Language>("both");
  const [sheet, setSheet] = useState<"letter" | "tabloid">("letter");
  const [error, setError] = useState<string | undefined>();
  const [fonts, setFonts] = useState<{ id: string; name: string; hasVowels: boolean; hasCantillation: boolean }[]>([]);
  const [fontId, setFontId] = useState("");
  /** A built booklet held back because the chosen font lacks marks: the person decides whether to go on. */
  const [held, setHeld] = useState<{ file: File; direction: "ltr" | "rtl"; warning: string } | null>(null);
  const [building, startBuild] = useTransition();
  const latest = useRef(0);
  const dayCall = useRef(call.day);

  // "Today" is where the person is, which the server render cannot know: set it after mount.
  useEffect(() => {
    const t = setTimeout(() => setDate(localIsoDate()), 0);
    return () => clearTimeout(t);
  }, []);

  // The uploaded Hebrew fonts (Admin -> Fonts). The last choice is remembered on this device, and dropped if that font is gone.
  const fontsCall = useRef(call.fonts);
  useEffect(() => {
    let live = true;
    void fontsCall.current().then(
      (res) => {
        if (!live || !res.ok) return;
        setFonts(res.fonts);
        const saved = readSavedFont();
        setFontId(res.fonts.some((f) => f.id === saved) ? saved : "");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async (day: string) => {
    const mine = ++latest.current;
    setItems(null);
    setLoadError(undefined);
    const res = await dayCall.current(day).catch(() => null);
    if (mine !== latest.current) return;
    if (!res) return setLoadError("Something went wrong on our side. Try again.");
    if (!res.ok) return setLoadError(res.message);
    setItems(res.items);
    setPicked(res.items.map((i) => i.study));
  }, []);

  useEffect(() => {
    if (!date) return;
    const t = setTimeout(() => void load(date), 0);
    return () => clearTimeout(t);
  }, [date, load]);

  const togglePick = (s: OfferedStudy) => setPicked((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  function make() {
    if (!date) return;
    setError(undefined);
    startBuild(async () => {
      try {
        const res = await call.build({ date, studies: picked, language, sheet, fontId: fontId || null });
        if (!res.ok) return setError(res.message);
        const file = pdfFile(res.pdfBase64, res.fileName);
        if (res.fontWarning) return setHeld({ file, direction: res.direction, warning: res.fontWarning });
        putBuiltBooklet(file);
        router.push(builderPrintUrl(res.direction, sheet));
      } catch {
        setError("Something went wrong on our side. Try again.");
      }
    });
  }

  function goOn() {
    if (!held) return;
    putBuiltBooklet(held.file);
    router.push(builderPrintUrl(held.direction, sheet));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" aria-label="Previous day" disabled={!date} onClick={() => date && setDate(shiftIso(date, -1))}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <input
          type="date"
          aria-label="Day"
          value={date ?? ""}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base"
        />
        <Button type="button" variant="secondary" size="sm" aria-label="Next day" disabled={!date} onClick={() => date && setDate(shiftIso(date, 1))}>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {items === null && !loadError && (
        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Spinner /> Getting the day&apos;s study...
        </p>
      )}
      {loadError && (
        <div className="space-y-2">
          <FormError message={loadError} />
          <Button type="button" variant="secondary" size="sm" onClick={() => date && void load(date)}>
            Try again
          </Button>
        </div>
      )}

      {items && items.length === 0 && <p className="text-sm text-[var(--color-muted)]">Nothing is listed for this day.</p>}

      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((i) => {
            const on = picked.includes(i.study);
            return (
              <li key={i.study}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => togglePick(i.study)}
                  className={`flex min-h-14 w-full items-start gap-3 rounded-[var(--radius-card)] border p-3.5 text-start focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${on ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
                >
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "border-[var(--color-border-strong)]"}`} aria-hidden="true">
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{i.label}</span>
                    <span className="block text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{i.portion}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {items && items.length > 0 && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
          <Segmented<Language>
            label="Language"
            value={language}
            onChange={setLanguage}
            options={[
              { value: "both", label: "Hebrew + English" },
              { value: "he", label: "Hebrew" },
              { value: "en", label: "English" },
            ]}
          />
          <Segmented<"letter" | "tabloid">
            label="Sheet"
            value={sheet}
            onChange={setSheet}
            options={[
              { value: "letter", label: "Regular Letter" },
              { value: "tabloid", label: "11x17" },
            ]}
          />
          {language !== "en" && (
            <label className="block space-y-1">
              <span className="block text-sm font-medium">Hebrew font</span>
              <select
                value={fontId}
                onChange={(e) => {
                  setFontId(e.target.value);
                  saveFont(e.target.value);
                  setHeld(null);
                }}
                className="min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base"
              >
                <option value="">Printio&apos;s default (Ezra SIL)</option>
                {fonts.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.hasCantillation ? "" : " (no trop)"}
                  </option>
                ))}
              </select>
              <span className="block text-[13px] text-[var(--color-muted)]">{fonts.length === 0 ? "An admin can add more Hebrew fonts under Admin, Fonts." : "Fonts marked \"no trop\" leave out the cantillation marks (the Chumash needs them)."}</span>
            </label>
          )}
          <p className="text-[13px] text-[var(--color-muted)]">The text fills every page edge to edge, using the fewest sheets that stay easy to read. Hebrew-only booklets bind on the right.</p>
          {error && <FormError message={error} />}
          {held && (
            <div role="alert" className="space-y-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] p-3 text-sm">
              <p>{held.warning}</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={goOn}>
                  Use it anyway
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setHeld(null)}>
                  Choose another font
                </Button>
              </div>
            </div>
          )}
          <Button type="button" className="w-full sm:w-auto" onClick={make} pending={building} pendingLabel="Building the booklet..." disabled={picked.length === 0}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Make a booklet
          </Button>
        </div>
      )}

      <p className="text-[13px] text-[var(--color-muted)]">{DAILY_CREDIT}</p>
    </div>
  );
}
