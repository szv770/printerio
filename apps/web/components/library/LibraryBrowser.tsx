"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Plus, Printer, Search } from "lucide-react";
import { Badge, Button, FormError, Input, Segmented, Spinner } from "@/components/ui";
import { libraryEntryAction, libraryLikkutAction, libraryListAction, refreshSieAction } from "@/app/(dashboard)/print/library/actions";
import { importLinkAction } from "@/app/(dashboard)/print/import-link-action";
import { putBuiltBooklet } from "@/lib/booklet/handoff";
import { singleFilePrintUrl } from "@/lib/booklet/builder-params";
import { SIE_CREDIT, SIE_SNAPSHOT_DATE, SIE_WEEKLY } from "@printio/shared/library/sie-weekly";
import { mergeSie } from "@printio/shared/library/sie-store";
import type { SieEntry } from "@printio/shared/library/sie-weekly";
import { groupSie, likkutPageFromLabel, sieContentRange, sieForLikkut } from "@printio/shared/library/sie";
import { addToCart, CART_MAX, clearCart, MAFTEIACH_CREDIT, readCart, removeFromCart, type CartItem } from "@/lib/library/cart";
import { friendlyFileLabel, hasEnglish, matchesQuery } from "@printio/shared/library/labels";
import type { EntrySection, LikkutPage, ListEntry, ListPage } from "@printio/shared/library/mafteiach-parse";
import { isLibraryWaiting } from "@/lib/library/results";
import { createWaitController } from "@/lib/library/wait-controller";
import { SOMETHING_WENT_WRONG, watchLibraryWait, type ShowWait, type WaitView } from "@/lib/library/wait-flow";
import { DailyStudyPanel } from "./DailyStudyPanel";
import { WaitNotice } from "./WaitNotice";

type Tab = "likkutei" | "maamorim" | "all" | "sie" | "daily";

/** One file in the library: tap to put it in (or take it out of) the booklet. */
function FileButton({ label, chosen, onToggle }: { label: string; chosen: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onToggle}
      dir="auto"
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
        chosen ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
      }`}
    >
      {chosen ? <Check className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
      {label}
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      dir="auto"
      className={`min-h-11 min-w-11 shrink-0 rounded-full border px-3 text-sm font-medium focus-visible:outline-none focus-visible:shadow-[var(--ring)] ${
        active ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-fg)]" : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
      }`}
    >
      {children}
    </button>
  );
}

/** Browse the Mafteiach library (Likkutei Sichos, maamarim, sichos and farbrengens) and pick files for a booklet. Admins and early-tools people only. */
export function LibraryBrowser({ extraSie = [], canRefreshSie = false }: { extraSie?: SieEntry[]; canRefreshSie?: boolean }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("likkutei");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  // Only when the website is set to fetch library pages through a print server: the page is not there yet (or the print server is off).
  // While it is not there the screen asks again by itself (lib/library/wait-poller.ts); `waitCtl` holds at most one such wait per item.
  const [waiting, setWaiting] = useState<WaitView | null>(null);
  const [entryWaiting, setEntryWaiting] = useState<Record<string, WaitView | undefined>>({});
  const [waitCtl] = useState(() => createWaitController());
  const retryMain = useRef<() => void>(() => {});
  const mainLoad = useRef(0);
  const openRef = useRef<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [printing, startPrint] = useTransition();
  const [checking, startCheck] = useTransition();
  const [sieMessage, setSieMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const allSie = mergeSie(SIE_WEEKLY, extraSie);
  const [query, setQuery] = useState("");

  const [likkut, setLikkut] = useState<LikkutPage | null>(null);
  const [lists, setLists] = useState<Partial<Record<"maamorim" | "all", ListPage>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, EntrySection[] | "loading" | string>>({});

  // The person left (another page, another tab of this app) or the screen closed: no wait is left running.
  useEffect(() => () => waitCtl.stopAll(), [waitCtl]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // The cart lives in sessionStorage, which the server render cannot see: read it after mount.
  useEffect(() => {
    const t = setTimeout(() => setCart(readCart()), 0);
    return () => clearTimeout(t);
  }, []);

  const chosen = (url: string) => cart.some((i) => i.url === url);
  function toggle(title: string, url: string, credit = MAFTEIACH_CREDIT, pages?: string) {
    setNotice(undefined);
    if (chosen(url)) return setCart(removeFromCart(url));
    const res = addToCart({ title, url, credit, ...(pages ? { pages } : {}) });
    setCart(res.items);
    if (res.full) setNotice(`A booklet holds up to ${CART_MAX} files. Remove one to add another.`);
  }

  /** The simple path: one file, straight to the Print screen. No booklet wizard unless the person asks for it. */
  function printOne() {
    const item = cart[0];
    if (!item) return;
    setError(undefined);
    startPrint(async () => {
      try {
        const data = new FormData();
        data.set("link", item.url);
        const result = await importLinkAction(data);
        if (result.error || !result.imported) return setError(result.error ?? "Something went wrong. Try again.");
        const res = await fetch(result.imported.signedUrl, { cache: "no-store" });
        if (!res.ok) throw new Error("download");
        putBuiltBooklet(new File([await res.blob()], result.imported.fileName, { type: "application/pdf", lastModified: Date.now() }));
        clearCart();
        router.push(singleFilePrintUrl(item.pages));
      } catch {
        setError("Printio could not get that file. Try again.");
      }
    });
  }

  function checkForNewWeeks() {
    setSieMessage(null);
    startCheck(async () => {
      try {
        const res = await refreshSieAction();
        setSieMessage({ ok: res.ok, text: res.message });
        if (res.ok) router.refresh();
      } catch {
        setSieMessage({ ok: false, text: "Something went wrong on our side. Try again." });
      }
    });
  }

  /** Stops every wait and clears what they showed (used when the person switches tab or loads another list). */
  function clearAllWaits() {
    mainLoad.current += 1;
    waitCtl.stopAll();
    setWaiting(null);
    const stuck = Object.keys(entryWaiting);
    if (stuck.length === 0) return;
    setEntryWaiting({});
    setEntries((cur) => {
      const next = { ...cur };
      for (const k of stuck) delete next[k];
      return next;
    });
  }

  /** One opened entry is closed, or another one is opened: its wait (if any) ends and it will be asked afresh when opened again. */
  function forgetEntryWait(path: string) {
    waitCtl.stop(`entry:${path}`);
    if (!entryWaiting[path]) return;
    setEntryWaiting((cur) => ({ ...cur, [path]: undefined }));
    setEntries((cur) => {
      const next = { ...cur };
      delete next[path];
      return next;
    });
  }

  function loadVolume(n: number) {
    setError(undefined);
    waitCtl.stop("main");
    setWaiting(null);
    const mine = ++mainLoad.current;
    startTransition(async () => {
      const res = await libraryLikkutAction(n).catch(() => null);
      if (!res) return setError("Something went wrong on our side. Try again.");
      if (!res.ok) {
        if (!isLibraryWaiting(res)) return setError(res.message);
        retryMain.current = () => loadVolume(n);
        return watchLibraryWait<{ ok: true; page: LikkutPage }>({ controller: waitCtl, key: "main", first: res, isShown: () => mainLoad.current === mine, ask: () => libraryLikkutAction(n), show: setWaiting, onOk: (r) => setLikkut(r.page), onFail: setError });
      }
      setLikkut(res.page);
    });
  }

  function loadYear(section: "maamorim" | "all", year?: string) {
    setError(undefined);
    clearAllWaits();
    const mine = mainLoad.current;
    const apply = (page: ListPage) => {
      setLists((cur) => ({ ...cur, [section]: page }));
      setOpen(null);
    };
    startTransition(async () => {
      const res = await libraryListAction(section, year).catch(() => null);
      if (!res) return setError("Something went wrong on our side. Try again.");
      if (!res.ok) {
        if (!isLibraryWaiting(res)) return setError(res.message);
        retryMain.current = () => loadYear(section, year);
        return watchLibraryWait<{ ok: true; page: ListPage }>({ controller: waitCtl, key: "main", first: res, isShown: () => mainLoad.current === mine, ask: () => libraryListAction(section, year), show: setWaiting, onOk: (r) => apply(r.page), onFail: setError });
      }
      apply(res.page);
    });
  }

  function openEntry(entry: ListEntry) {
    const key = entry.path;
    if (open === key) {
      forgetEntryWait(key);
      return setOpen(null);
    }
    if (open) forgetEntryWait(open);
    setOpen(key);
    if (entries[key] && entries[key] !== "loading" && typeof entries[key] !== "string") return;
    fetchEntry(entry);
  }

  function fetchEntry(entry: ListEntry) {
    const key = entry.path;
    waitCtl.stop(`entry:${key}`);
    setEntryWaiting((cur) => ({ ...cur, [key]: undefined }));
    setEntries((cur) => ({ ...cur, [key]: "loading" }));
    const showEntry: ShowWait = (next) =>
      setEntryWaiting((cur) => {
        const v = typeof next === "function" ? next(cur[key] ?? null) : next;
        return { ...cur, [key]: v ?? undefined };
      });
    const settle = (sections: EntrySection[] | string) => setEntries((cur) => ({ ...cur, [key]: sections }));
    void libraryEntryAction(entry.path)
      .then((res) => {
        if (res.ok) return settle(res.sections);
        if (!isLibraryWaiting(res)) return settle(res.message);
        settle(res.message);
        watchLibraryWait<{ ok: true; sections: EntrySection[] }>({ controller: waitCtl, key: `entry:${key}`, first: res, isShown: () => openRef.current === key, ask: () => libraryEntryAction(entry.path), show: showEntry, onOk: (r) => settle(r.sections), onFail: settle });
      })
      .catch(() => settle(SOMETHING_WENT_WRONG));
  }

  function chooseTab(next: Tab) {
    setTab(next);
    clearAllWaits();
    setError(undefined);
    setNotice(undefined);
    if (next === "likkutei" && !likkut) loadVolume(1);
    if (next === "maamorim" || next === "all") if (!lists[next]) loadYear(next);
  }

  // Open on Likkutei Sichos: the first load happens once, after mount.
  useEffect(() => {
    const t = setTimeout(() => loadVolume(1), 0);
    return () => clearTimeout(t);
    // Deliberately once, after mount (see the comment above); loadVolume is recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list = tab === "maamorim" || tab === "all" ? lists[tab] : null;
  const sieGroups = tab === "sie" ? groupSie(allSie, query) : [];

  // What is on screen after the search and the "English only" filter.
  const visibleParshiyos = likkut
    ? likkut.parshiyos
        .map((p) => ({ ...p, entries: p.entries.filter((e) => matchesQuery([e.label, e.summary, p.name], query)) }))
        .filter((p) => p.entries.length > 0)
    : [];
  const visibleCount = visibleParshiyos.reduce((n, p) => n + p.entries.length, 0);
  // The English (SIE) translation of each sicha: matched by volume and page. A sicha runs until the next one starts.
  const volumePages = likkut ? [...new Set(likkut.parshiyos.flatMap((p) => p.entries.map((e) => likkutPageFromLabel(e.label)).filter((n): n is number => n !== null)))].sort((a, b) => a - b) : [];
  const englishFor = (label: string) => {
    const page = likkutPageFromLabel(label);
    const next = page === null ? null : (volumePages.find((n) => n > page) ?? null);
    return sieForLikkut(likkut?.current ?? null, page, allSie, next);
  };
  const visibleList = list ? list.entries.filter((e) => matchesQuery([e.heading, e.title, e.series, e.note], query)) : [];

  return (
    <div className="pb-[calc(var(--sticky-bottom,0px)+9rem)] sm:pb-28">
      <Segmented<Tab>
        label="Part of the library"
        value={tab}
        onChange={chooseTab}
        options={[
          { value: "likkutei", label: "Likkutei Sichos" },
          { value: "maamorim", label: "Maamarim" },
          { value: "all", label: "Sichos and farbrengens" },
          { value: "sie", label: "Sichos In English" },
          { value: "daily", label: "Daily study" },
        ]}
      />
      {tab !== "daily" && (
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden="true" />
          <Input aria-label="Search this list" type="search" placeholder="Search (a name, a topic, a parsha)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="ps-10" dir="auto" />
        </div>
      </div>
      )}
      <FormError message={error} />
      {waiting && <WaitNotice view={waiting} onTryAgain={() => retryMain.current()} className="mt-2" />}
      {notice && <p role="status" className="mt-2 text-sm text-[var(--color-muted)]">{notice}</p>}
      {pending && (
        <p className="mt-3 flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Spinner /> Loading from the library...
        </p>
      )}

      {tab === "likkutei" && likkut && (
        <section className="mt-4">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2" role="group" aria-label="Volume">
            {likkut.volumes.map((v) => (
              <Chip key={v.n} active={v.n === likkut.current} onClick={() => loadVolume(v.n)}>
                {v.label}
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-[13px] text-[var(--color-muted)]" role="status">
            {visibleCount} {visibleCount === 1 ? "sicha" : "sichos"}
            {query ? " match" : " in this volume"}
          </p>
          {visibleCount === 0 && <p className="mt-3 text-sm text-[var(--color-muted)]">Nothing matches. Clear the search to see more.</p>}
          <div className="mt-3 space-y-5">
            {visibleParshiyos.map((p) => (
              <div key={p.name}>
                <h2 dir="auto" className="text-base font-semibold">
                  {p.name}
                </h2>
                <ul className="mt-2 space-y-3">
                  {p.entries.map((e) => (
                    <li key={e.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
                      <p dir="auto" className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {e.label}
                        {(hasEnglish(e.links) || englishFor(e.label).length > 0) && <Badge tone="accent">English</Badge>}
                      </p>
                      {e.summary && (
                        <p dir="auto" className="mt-1 line-clamp-3 text-[13px] leading-5 text-[var(--color-muted)]">
                          {e.summary}
                        </p>
                      )}
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        {e.links.map((l) => (
                          <FileButton key={l.url} label={friendlyFileLabel(l.label)} chosen={chosen(l.url)} onToggle={() => toggle(l.label === "שיחה" ? e.label : `${e.label} - ${friendlyFileLabel(l.label)}`.slice(0, 120), l.url)} />
                        ))}
                        {englishFor(e.label).map((x, k, all) => (
                          <FileButton key={x.url} label={all.length > 1 ? `English (SIE): ${x.title}` : "English (SIE)"} chosen={chosen(x.url)} onToggle={() => toggle(`${e.label} - English (SIE)`.slice(0, 120), x.url, SIE_CREDIT, sieContentRange(x))} />
                        ))}
                        {e.links.length === 0 && englishFor(e.label).length === 0 && <span className="text-[13px] text-[var(--color-muted)]">No file yet.</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === "daily" && (
        <section className="mt-4">
          <DailyStudyPanel />
        </section>
      )}

      {tab === "sie" && (
        <section className="mt-4">
          <p className="text-[13px] leading-5 text-[var(--color-muted)]">
            SIE Weekly: the weekly English translations of the Rebbe&apos;s Likkutei Sichos, courtesy of Sichos In English (sie.org). {allSie.length} weeks. The list started as a copy from {SIE_SNAPSHOT_DATE}{extraSie.length > 0 ? ` and ${extraSie.length} newer ${extraSie.length === 1 ? "week was" : "weeks were"} added since` : ""}.
          </p>
          {canRefreshSie && (
            <div className="mt-3">
              <Button type="button" variant="secondary" size="sm" onClick={checkForNewWeeks} pending={checking} pendingLabel="Checking Sichos In English...">
                Check for new weeks
              </Button>
              {sieMessage && (sieMessage.ok ? <p role="status" className="mt-2 text-sm">{sieMessage.text}</p> : <FormError message={sieMessage.text} />)}
            </div>
          )}
          {sieGroups.length === 0 && <p className="mt-3 text-sm text-[var(--color-muted)]">Nothing matches. Clear the search to see more.</p>}
          <div className="mt-3 space-y-6">
            {sieGroups.map((g) => (
              <div key={g.chelek}>
                <h2 className="text-base font-semibold">Chelek {g.chelek}</h2>
                {g.sefarim.map((sf) => (
                  <div key={sf.sefer} className="mt-2">
                    <h3 className="text-[13px] font-medium text-[var(--color-muted)]">Sefer {sf.sefer}</h3>
                    <ul className="mt-1.5 space-y-2">
                      {sf.entries.map((e) => (
                        <li key={e.url} className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">{e.title}</span>
                            {sieContentRange(e) && <span className="block text-[12px] text-[var(--color-muted)]">Starts at page {e.from}: the cover and dedication pages are skipped.</span>}
                            {e.volume !== undefined && <span className="block text-[12px] text-[var(--color-muted)]">Likkutei Sichos vol. {e.volume}, p. {e.page}</span>}
                          </span>
                          <FileButton label="English" chosen={chosen(e.url)} onToggle={() => toggle(`${e.title} (SIE, Chelek ${e.chelek})`, e.url, SIE_CREDIT, sieContentRange(e))} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {list && (
        <section className="mt-4">
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2" role="group" aria-label="Year">
            {list.years.map((y) => (
              <Chip key={y.year} active={y.current} onClick={() => loadYear(tab as "maamorim" | "all", y.year)}>
                {y.label}
              </Chip>
            ))}
          </div>
          <ul className="mt-3 space-y-2">
            {visibleList.length === 0 && <li className="text-sm text-[var(--color-muted)]">Nothing matches. Clear the search to see more.</li>}
            {visibleList.map((e) => {
              const state = entries[e.path];
              return (
                <li key={e.path} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                  <button type="button" onClick={() => openEntry(e)} aria-expanded={open === e.path} className="flex min-h-14 w-full items-start gap-3 p-3.5 text-start focus-visible:outline-none focus-visible:shadow-[var(--ring)]">
                    <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-[var(--color-muted)] transition-transform ${open === e.path ? "rotate-180" : ""}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1" dir="auto">
                      {e.heading && <span className="block text-[13px] text-[var(--color-muted)]">{e.heading}</span>}
                      <span className="block text-sm font-medium">
                        {e.title} {e.note && <span className="font-normal text-[var(--color-muted)]">{e.note}</span>}
                      </span>
                      {e.series && <span className="block text-[13px] text-[var(--color-muted)]">{e.series}</span>}
                    </span>
                  </button>
                  {open === e.path && (
                    <div className="border-t border-[var(--color-border)] p-3.5">
                      {state === "loading" || state === undefined ? (
                        <p className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
                          <Spinner /> Loading...
                        </p>
                      ) : entryWaiting[e.path] ? (
                        <WaitNotice view={entryWaiting[e.path]!} onTryAgain={() => fetchEntry(e)} />
                      ) : typeof state === "string" ? (
                        <FormError message={state} />
                      ) : state.length === 0 ? (
                        <p className="text-sm text-[var(--color-muted)]">No files for this one yet.</p>
                      ) : (
                        <div className="space-y-4">
                          {state.map((s, i) => (
                            <div key={`${s.title}-${i}`}>
                              <p dir="auto" className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                                {s.title}
                                {hasEnglish(s.groups.flatMap((g) => g.links), s.title) && <Badge tone="accent">English</Badge>}
                              </p>
                              {s.groups.map((g, j) => (
                                <div key={`${g.label}-${j}`} className="mt-1.5">
                                  {g.label && (
                                    <p dir="auto" className="text-[13px] text-[var(--color-muted)]">
                                      {g.label}
                                    </p>
                                  )}
                                  <div className="mt-1 flex flex-wrap gap-2">
                                    {g.links.map((l) => (
                                      <FileButton key={l.url} label={friendlyFileLabel(l.label).length > 48 ? `${friendlyFileLabel(l.label).slice(0, 46)}...` : friendlyFileLabel(l.label)} chosen={chosen(l.url)} onToggle={() => toggle(`${e.title} - ${friendlyFileLabel(l.label)}`.slice(0, 120), l.url)} />
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {cart.length > 0 && (
        <div role="region" aria-label="Chosen files" className="fixed inset-x-0 bottom-[var(--sticky-bottom,0px)] z-40 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] shadow-[var(--shadow-pop)]">
          <div className="mx-auto flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 basis-32 text-sm font-medium">
              {cart.length} {cart.length === 1 ? "file" : "files"} chosen
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => (clearCart(), setCart([]))}>
              Clear
            </Button>
            <div className="flex w-full gap-2 sm:w-auto">
            {cart.length === 1 && (
              <Button type="button" className="flex-1 sm:flex-none" onClick={printOne} pending={printing} pendingLabel="Getting the file...">
                <Printer className="h-4 w-4" aria-hidden="true" />
                Print this file
              </Button>
            )}
            <Button type="button" className="flex-1 sm:flex-none" variant={cart.length === 1 ? "secondary" : "primary"} onClick={() => router.push("/print/booklet")} disabled={printing}>
              Make a booklet
            </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
