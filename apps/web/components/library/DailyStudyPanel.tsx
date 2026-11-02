"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronLeft, ChevronRight, ExternalLink, Printer, Upload } from "lucide-react";
import { Badge, Button, FormError, Segmented, Spinner } from "@/components/ui";
import { buildDailyBookletAction, dailyDayAction, importDailyAction, type DailyDayItem, type ImportDailyResult } from "@/app/(dashboard)/print/library/daily-actions";
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

/**
 * The library's Daily study tab: the day's Chumash with Rashi, Tanya and Rambam from Chabad.org, in a booklet whose pages are
 * filled edge to edge. The text is saved in Printio once; an admin saves a day's pages here when it is not there yet.
 */
export interface DailyApi {
  day: typeof dailyDayAction;
  build: typeof buildDailyBookletAction;
  importFiles: typeof importDailyAction;
}

export function DailyStudyPanel({ canImport, api }: { canImport: boolean; /** Stand-ins for the server actions, used only by the dev preview page. */ api?: Partial<DailyApi> }) {
  const call: DailyApi = { day: dailyDayAction, build: buildDailyBookletAction, importFiles: importDailyAction, ...api };
  const router = useRouter();
  const [date, setDate] = useState<string | null>(null);
  const [items, setItems] = useState<DailyDayItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [picked, setPicked] = useState<OfferedStudy[]>([]);
  const [language, setLanguage] = useState<Language>("both");
  const [sheet, setSheet] = useState<"letter" | "tabloid">("letter");
  const [error, setError] = useState<string | undefined>();
  const [building, startBuild] = useTransition();
  const [importing, startImport] = useTransition();
  const [imported, setImported] = useState<ImportDailyResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  // "Today" is where the person is, which the server render cannot know: set it after mount.
  useEffect(() => {
    const t = setTimeout(() => setDate(localIsoDate()), 0);
    return () => clearTimeout(t);
  }, []);

  const load = useCallback(async (day: string) => {
    const mine = ++latest.current;
    setItems(null);
    setLoadError(undefined);
    setImported(null);
    const res = await call.day(day).catch(() => null);
    if (mine !== latest.current) return;
    if (!res) return setLoadError("Something went wrong on our side. Try again.");
    if (!res.ok) return setLoadError(res.message);
    setItems(res.items);
    setPicked(res.items.filter((i) => i.saved).map((i) => i.study));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `call` only changes in the dev preview
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
        const res = await call.build({ date, studies: picked, language, sheet });
        if (!res.ok) return setError(res.message);
        putBuiltBooklet(pdfFile(res.pdfBase64, res.fileName));
        router.push(builderPrintUrl(res.direction, sheet));
      } catch {
        setError("Something went wrong on our side. Try again.");
      }
    });
  }

  function runImport() {
    const files = fileInput.current?.files;
    if (!date || !files || files.length === 0) return setImported({ ok: false, message: "Choose the saved page(s) first.", results: [] });
    const data = new FormData();
    data.set("date", date);
    for (const f of Array.from(files)) data.append("files", f);
    startImport(async () => {
      const res = await call.importFiles(data).catch(() => null);
      setImported(res ?? { ok: false, message: "Something went wrong on our side. Try again.", results: [] });
      if (fileInput.current) fileInput.current.value = "";
      if (res?.ok) void load(date);
    });
  }

  const missing = (items ?? []).filter((i) => !i.saved);
  const readyPicked = picked.filter((s) => items?.find((i) => i.study === s)?.saved);

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
          <Spinner /> Loading the day...
        </p>
      )}
      {loadError && <FormError message={loadError} />}

      {items && items.length === 0 && <p className="text-sm text-[var(--color-muted)]">Printio could not get Chabad.org&apos;s list for this day and has nothing saved for it. Try again in a minute.</p>}

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
                  disabled={!i.saved}
                  onClick={() => togglePick(i.study)}
                  className={`flex min-h-14 w-full items-start gap-3 rounded-[var(--radius-card)] border p-3.5 text-start focus-visible:outline-none focus-visible:shadow-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-70 ${on ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
                >
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${on ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "border-[var(--color-border-strong)]"}`} aria-hidden="true">
                    {on && <Check className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{i.label}</span>
                    <span className="block text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">{i.portion}</span>
                    <span className="mt-1.5 block sm:hidden">
                      <Badge tone={i.saved ? "success" : "warning"}>{i.saved ? "Ready" : "Not saved yet"}</Badge>
                    </span>
                  </span>
                  <span className="hidden shrink-0 sm:block">
                    <Badge tone={i.saved ? "success" : "warning"}>{i.saved ? "Ready" : "Not saved yet"}</Badge>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {items && items.some((i) => i.saved) && (
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
          <p className="text-[13px] text-[var(--color-muted)]">The text fills every page edge to edge, using the fewest sheets that stay easy to read. Hebrew-only booklets bind on the right.</p>
          {error && <FormError message={error} />}
          <Button type="button" className="w-full sm:w-auto" onClick={make} pending={building} pendingLabel="Building the booklet..." disabled={readyPicked.length === 0}>
            <Printer className="h-4 w-4" aria-hidden="true" />
            Make a booklet
          </Button>
        </div>
      )}

      {canImport && items && missing.length > 0 && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
          <p className="text-sm font-medium">Add the missing text</p>
          <p className="text-[13px] text-[var(--color-muted)]">
            Chabad.org checks that a real person is visiting, so Printio cannot fetch its pages itself. Open each page below in your own browser, wait until the text shows, press Ctrl+S, choose &quot;Webpage, HTML only&quot;, then pick the saved file(s) here.
          </p>
          <ul className="space-y-1">
            {missing.map((i) =>
              i.url ? (
                <li key={i.study}>
                  <a href={i.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-[var(--color-primary)] underline-offset-2 hover:underline">
                    {i.label} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </li>
              ) : null,
            )}
          </ul>
          <input ref={fileInput} type="file" multiple accept=".htm,.html,text/html" aria-label="Saved pages" className="block w-full text-sm file:mr-3 file:min-h-11 file:rounded-[var(--radius-control)] file:border file:border-[var(--color-border-strong)] file:bg-[var(--color-surface)] file:px-3" />
          <Button type="button" variant="secondary" onClick={runImport} pending={importing} pendingLabel="Saving...">
            <Upload className="h-4 w-4" aria-hidden="true" />
            Save to Printio
          </Button>
          {imported && (
            <div role="status" className="space-y-1 text-sm">
              <p className={imported.ok ? "text-[var(--color-success-ink)]" : "text-[var(--color-danger-ink)]"}>{imported.message}</p>
              {imported.results.map((r, n) => (
                <p key={n} className={`text-[13px] [overflow-wrap:anywhere] ${r.ok ? "text-[var(--color-muted)]" : "text-[var(--color-danger-ink)]"}`}>
                  {r.name}: {r.message}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-[13px] text-[var(--color-muted)]">{DAILY_CREDIT}</p>
    </div>
  );
}
