"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { Button, Checkbox, Collapsible, FormError, Segmented, Spinner } from "@/components/ui";
import { buildDailyBookletAction, dailyDayAction, dailyFontsAction, type DailyDayItem } from "@/app/(dashboard)/print/library/daily-actions";
import { putBuiltBooklet } from "@/lib/booklet/handoff";
import { builderPrintUrl } from "@/lib/booklet/builder-params";
import { localIsoDate, shiftIso } from "@printio/shared/library/daily/dates";
import { DAILY_CREDIT, datesBetween, MAX_BOOKLET_DAYS, type OfferedStudy } from "@/lib/library/daily/studies";
import type { ColumnSplit, Language } from "@/lib/library/daily/fill";
import type { Arrange } from "@/lib/library/daily/merge";
import { FONT_ROLES, type FontFacts, type FontRole } from "@/lib/booklet/font-families";
import {
  effective,
  englishFamilyChoices,
  englishRolePlan,
  familyOfFont,
  hebrewFamilyChoices,
  hebrewRolePlan,
  resolveFontIds,
  ROLE_NAMES,
  validOverrides,
  withFacts,
  type RoleOverrides,
  type RolePlan,
} from "@/lib/booklet/font-roles";

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

// Remembered on this device. The first three keys are older than font families and held one font's id each; they are still read.
const FONT_KEY = "printio.daily.hebrewFont";
const TITLE_FONT_KEY = "printio.daily.titleFont";
const LATIN_FONT_KEY = "printio.daily.latinFont";
const HEBREW_FAMILY_KEY = "printio.daily.hebrewFamily";
const LATIN_FAMILY_KEY = "printio.daily.latinFamily";
const ROLES_KEY = "printio.daily.fontRoles";
const COLUMNS_KEY = "printio.daily.columns";
const readSaved = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const saveChoice = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a remembered choice is only a convenience */
  }
};

type FontOption = { id: string; name: string; hasVowels: boolean; hasCantillation: boolean; hasHebrew: boolean; hasLatin: boolean };
type Overrides = { he: RoleOverrides; en: RoleOverrides };

const SELECT_CLASS = "min-h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base";

function FontSelect({
  label,
  value,
  onChange,
  hint,
  children,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-medium">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT_CLASS}>
        {children}
      </select>
      {hint && <span className="block text-[13px] text-[var(--color-muted)]">{hint}</span>}
    </label>
  );
}

/** The three jobs of one language (titles, body text, Rashi): what Printio picked, and a list to change each. */
function RoleSelects({ heading, plan, overrides, onChange }: { heading: string; plan: RolePlan; overrides: RoleOverrides; onChange: (role: FontRole, value: string) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{heading}</legend>
      {FONT_ROLES.map((role) => (
        <label key={role} className="block space-y-1">
          <span className="block text-[13px] text-[var(--color-muted)]">{ROLE_NAMES[role]}</span>
          <select value={overrides[role] ?? ""} onChange={(e) => onChange(role, e.target.value)} className={SELECT_CLASS}>
            <option value="">Automatic: {plan.auto[role].label}</option>
            {plan.options[role].map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The library's Daily study tab: the day's Chumash with Rashi, Tanya, Hayom Yom and Rambam, in a booklet whose pages are filled
 * edge to edge (Hebrew on the left, English on the right, or either alone), with a front page that lists what is inside. One
 * booklet can hold up to a week, arranged by day or by study. Printio fetches a day from its source the first time anyone opens
 * it and keeps it, so nobody has to find or upload anything.
 */
export function DailyStudyPanel({ api }: { /** Stand-ins for the server actions, used only by the dev preview page. */ api?: Partial<DailyApi> }) {
  const router = useRouter();
  const call: DailyApi = { day: dailyDayAction, build: buildDailyBookletAction, fonts: dailyFontsAction, ...api };
  const [date, setDate] = useState<string | null>(null);
  /** How many days after the first day the booklet goes on (0: one day). */
  const [extraDays, setExtraDays] = useState(0);
  const [arrange, setArrange] = useState<Arrange>("day");
  const [skipMissing, setSkipMissing] = useState(false);
  const [items, setItems] = useState<DailyDayItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [picked, setPicked] = useState<OfferedStudy[]>([]);
  const [language, setLanguage] = useState<Language>("both");
  const [sheet, setSheet] = useState<"letter" | "tabloid">("letter");
  const [columns, setColumns] = useState<ColumnSplit>("auto");
  const [error, setError] = useState<string | undefined>();
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [facts, setFacts] = useState<Record<string, FontFacts>>({});
  const [englishFonts, setEnglishFonts] = useState<{ id: string; name: string }[]>([]);
  const [hebrewFamily, setHebrewFamily] = useState("");
  const [latinFamily, setLatinFamily] = useState("");
  const [overrides, setOverrides] = useState<Overrides>({ he: {}, en: {} });
  /** A built booklet held back (the chosen font lacks marks, or days were left out): the person decides whether to go on. */
  const [held, setHeld] = useState<{ file: File; direction: "ltr" | "rtl"; notes: string[]; font: boolean } | null>(null);
  const [building, startBuild] = useTransition();
  const latest = useRef(0);
  const dayCall = useRef(call.day);

  // "Today" is where the person is, which the server render cannot know: set it after mount.
  useEffect(() => {
    const t = setTimeout(() => {
      setDate(localIsoDate());
      const saved = readSaved(COLUMNS_KEY);
      if (saved === "auto" || saved === "even" || saved === "wider" || saved === "much") setColumns(saved);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const faces = useMemo(() => withFacts(fonts, facts), [fonts, facts]);
  const bundled = useMemo(() => englishFonts.map((f) => ({ value: f.id, label: f.name })), [englishFonts]);
  const hebrewChoices = useMemo(() => hebrewFamilyChoices(faces), [faces]);
  const englishChoices = useMemo(() => englishFamilyChoices(bundled, faces), [bundled, faces]);
  const hebrewPlan = useMemo(() => hebrewRolePlan(faces, hebrewFamily), [faces, hebrewFamily]);
  const englishPlan = useMemo(() => englishRolePlan(bundled, faces, latinFamily), [bundled, faces, latinFamily]);

  // The uploaded fonts (Admin -> Fonts), grouped into families, and the bundled English fonts. The last choices are remembered on
  // this device, and dropped if a font is gone (or can no longer be used for that job).
  const fontsCall = useRef(call.fonts);
  useEffect(() => {
    let live = true;
    void fontsCall.current().then(
      (res) => {
        if (!live || !res.ok) return;
        const all = withFacts(res.fonts, res.faces);
        const english = res.englishFonts.map((f) => ({ value: f.id, label: f.name }));
        const he = hebrewFamilyChoices(all).map((c) => c.value);
        const en = englishFamilyChoices(english, all).map((c) => c.value);
        const oldHebrew = readSaved(FONT_KEY);
        const oldLatin = readSaved(LATIN_FONT_KEY);
        const heFamily = [readSaved(HEBREW_FAMILY_KEY), oldHebrew ? familyOfFont(all, oldHebrew) : null].find((v): v is string => v != null && he.includes(v)) ?? "";
        const enFamily = [readSaved(LATIN_FAMILY_KEY), oldLatin, oldLatin ? familyOfFont(all, oldLatin) : null].find((v): v is string => v != null && en.includes(v)) ?? en[0] ?? "";
        let saved: Partial<Overrides> = {};
        try {
          saved = JSON.parse(readSaved(ROLES_KEY) ?? "{}") as Partial<Overrides>;
        } catch {
          /* start from automatic */
        }
        const oldTitle = readSaved(TITLE_FONT_KEY);
        const heSaved = saved.he ?? (oldTitle ? { title: oldTitle } : {});
        setFonts(res.fonts);
        setFacts(res.faces ?? {});
        setEnglishFonts(res.englishFonts);
        setHebrewFamily(heFamily);
        setLatinFamily(enFamily);
        setOverrides({ he: validOverrides(hebrewRolePlan(all, heFamily), heSaved), en: validOverrides(englishRolePlan(english, all, enFamily), saved.en) });
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

  const toDate = date ? shiftIso(date, extraDays) : null;
  const several = extraDays > 0;
  const togglePick = (s: OfferedStudy) => setPicked((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const setOverride = (lang: "he" | "en", role: FontRole, value: string) => {
    setHeld(null);
    setOverrides((cur) => {
      const next = { ...cur, [lang]: { ...cur[lang], [role]: value || undefined } };
      saveChoice(ROLES_KEY, JSON.stringify(next));
      return next;
    });
  };
  const chooseFamily = (lang: "he" | "en", value: string) => {
    setHeld(null);
    if (lang === "he") setHebrewFamily(value);
    else setLatinFamily(value);
    saveChoice(lang === "he" ? HEBREW_FAMILY_KEY : LATIN_FAMILY_KEY, value);
    // A new family starts from Printio's own picks.
    setOverrides((cur) => {
      const next = { ...cur, [lang]: {} };
      saveChoice(ROLES_KEY, JSON.stringify(next));
      return next;
    });
  };

  function make() {
    if (!date || !toDate) return;
    setError(undefined);
    setHeld(null);
    startBuild(async () => {
      try {
        const res = await call.build({
          date,
          toDate,
          arrange,
          skipMissing: several && skipMissing,
          studies: picked,
          language,
          sheet,
          columns,
          ...resolveFontIds({ language, hebrew: hebrewPlan, hebrewOverrides: overrides.he, english: englishPlan, englishOverrides: overrides.en }),
        });
        if (!res.ok) return setError(res.message);
        const file = pdfFile(res.pdfBase64, res.fileName);
        const notes = [...(res.skipped?.length ? [`Left out because it is not available: ${res.skipped.join("; ")}.`] : []), ...(res.fontWarning ? [res.fontWarning] : [])];
        if (notes.length > 0) return setHeld({ file, direction: res.direction, notes, font: !!res.fontWarning });
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

  const picks = (plan: RolePlan, over: RoleOverrides) => {
    const [title, body, rashi] = FONT_ROLES.map((role) => effective(plan, over, role).label.replace(/ \(.*\)$/, ""));
    return title === body && body === rashi ? `${body} for everything` : `${title} titles, ${body} text, ${rashi} Rashi`;
  };
  const fontSummary = [language !== "en" ? `Hebrew: ${picks(hebrewPlan, overrides.he)}` : "", language !== "he" ? `English: ${picks(englishPlan, overrides.en)}` : ""].filter(Boolean).join(". ");

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" aria-label="Previous day" disabled={!date} onClick={() => date && setDate(shiftIso(date, -1))}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <input
            type="date"
            aria-label={several ? "First day" : "Day"}
            value={date ?? ""}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base"
          />
          <Button type="button" variant="secondary" size="sm" aria-label="Next day" disabled={!date} onClick={() => date && setDate(shiftIso(date, 1))}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        <label className="flex items-center gap-2">
          <span className="shrink-0 text-sm font-medium">Until</span>
          <input
            type="date"
            aria-label="Last day"
            value={toDate ?? ""}
            min={date ?? undefined}
            max={date ? shiftIso(date, MAX_BOOKLET_DAYS - 1) : undefined}
            disabled={!date}
            onChange={(e) => {
              const days = date && e.target.value ? datesBetween(date, e.target.value) : null;
              // A day before the first day, or more than a week on, is not a booklet: keep to what fits.
              setExtraDays(days ? days.length - 1 : date && e.target.value > date ? MAX_BOOKLET_DAYS - 1 : 0);
              setHeld(null);
            }}
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-base"
          />
          <span className="shrink-0 text-[13px] text-[var(--color-muted)]">{several ? `${extraDays + 1} days` : "1 day"}</span>
        </label>
        <p className="text-[13px] text-[var(--color-muted)]">One booklet can hold up to {MAX_BOOKLET_DAYS} days in a row.</p>
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
                    <span className="block text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{several ? `First day: ${i.portion}` : i.portion}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {items && items.length > 0 && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
          {several && (
            <>
              <Segmented<Arrange>
                label="Arrange"
                value={arrange}
                onChange={setArrange}
                options={[
                  { value: "day", label: "By day" },
                  { value: "study", label: "By study" },
                ]}
                hint={arrange === "day" ? "Each day's studies together, one day after another." : "Every day's Chumash together, then every day's Tanya, and so on."}
              />
              <Checkbox
                label="Skip days that are not available"
                description="Off: if a day cannot be had, Printio stops and says which. On: the booklet is made without it."
                checked={skipMissing}
                onChange={(e) => setSkipMissing(e.target.checked)}
              />
            </>
          )}
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
          {language === "both" && (
            <FontSelect
              label="Column widths"
              value={columns}
              onChange={(v) => {
                setColumns(v as ColumnSplit);
                saveChoice(COLUMNS_KEY, v);
              }}
              hint="Automatic measures the text: English is usually longer, so it gets more room and the booklet needs fewer pages."
            >
              <option value="auto">Automatic</option>
              <option value="even">Even (50 / 50)</option>
              <option value="wider">Wider English (40 / 60)</option>
              <option value="much">Much wider English (33 / 67)</option>
            </FontSelect>
          )}
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
            <FontSelect
              label="Hebrew font"
              value={hebrewFamily}
              onChange={(v) => chooseFamily("he", v)}
              hint={hebrewChoices.length <= 1 ? "An admin can add more Hebrew fonts under Admin, Fonts." : "Fonts marked \"no trop\" leave out the cantillation marks (the Chumash needs them)."}
            >
              {hebrewChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </FontSelect>
          )}
          {language !== "he" && (
            <FontSelect
              label="English font"
              value={latinFamily}
              onChange={(v) => chooseFamily("en", v)}
              hint={faces.some((f) => f.hasLatin) ? "Includes the English fonts your admins uploaded." : "An admin can upload your own English fonts under Admin, Fonts."}
            >
              {englishChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </FontSelect>
          )}
          <Collapsible id="daily-fonts" title="Fonts" summary={fontSummary} headingLevel={3} independent>
            <div className="space-y-4">
              <p className="text-[13px] text-[var(--color-muted)]">
                Printio uses a family&apos;s Bold for titles and headings and its Regular for the text and for Rashi. A family with one weight uses it for everything. Change any of them here.
              </p>
              {language !== "en" && <RoleSelects heading="Hebrew" plan={hebrewPlan} overrides={overrides.he} onChange={(role, v) => setOverride("he", role, v)} />}
              {language !== "he" && <RoleSelects heading="English" plan={englishPlan} overrides={overrides.en} onChange={(role, v) => setOverride("en", role, v)} />}
            </div>
          </Collapsible>
          <p className="text-[13px] text-[var(--color-muted)]">The text fills every page edge to edge, using the fewest sheets that stay easy to read. The front page lists what is inside. Hebrew-only booklets bind on the right.</p>
          {error && <FormError message={error} />}
          {held && (
            <div role="alert" className="space-y-2 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] p-3 text-sm">
              {held.notes.map((n) => (
                <p key={n} className="[overflow-wrap:anywhere]">
                  {n}
                </p>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={goOn}>
                  {held.font ? "Use it anyway" : "Continue"}
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setHeld(null)}>
                  {held.font ? "Choose another font" : "Go back"}
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
