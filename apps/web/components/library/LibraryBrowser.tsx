"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { Badge, Button, FormError, Input, Segmented, Spinner } from "@/components/ui";
import { libraryEntryAction, libraryLikkutAction, libraryListAction } from "@/app/(dashboard)/print/library/actions";
import { addToCart, CART_MAX, clearCart, MAFTEIACH_CREDIT, readCart, removeFromCart, type CartItem } from "@/lib/library/cart";
import { friendlyFileLabel, hasEnglish, matchesQuery } from "@/lib/library/labels";
import type { EntrySection, LikkutPage, ListEntry, ListPage } from "@/lib/library/mafteiach-parse";

type Tab = "likkutei" | "maamorim" | "all";

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
export function LibraryBrowser() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("likkutei");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [englishOnly, setEnglishOnly] = useState(false);

  const [likkut, setLikkut] = useState<LikkutPage | null>(null);
  const [lists, setLists] = useState<Partial<Record<"maamorim" | "all", ListPage>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, EntrySection[] | "loading" | string>>({});

  // The cart lives in sessionStorage, which the server render cannot see: read it after mount.
  useEffect(() => {
    const t = setTimeout(() => setCart(readCart()), 0);
    return () => clearTimeout(t);
  }, []);

  const chosen = (url: string) => cart.some((i) => i.url === url);
  function toggle(title: string, url: string) {
    setNotice(undefined);
    if (chosen(url)) return setCart(removeFromCart(url));
    const res = addToCart({ title, url, credit: MAFTEIACH_CREDIT });
    setCart(res.items);
    if (res.full) setNotice(`A booklet holds up to ${CART_MAX} files. Remove one to add another.`);
  }

  function loadVolume(n: number) {
    setError(undefined);
    startTransition(async () => {
      const res = await libraryLikkutAction(n).catch(() => null);
      if (!res) return setError("Something went wrong on our side. Try again.");
      if (!res.ok) return setError(res.message);
      setLikkut(res.page);
    });
  }

  function loadYear(section: "maamorim" | "all", year?: string) {
    setError(undefined);
    startTransition(async () => {
      const res = await libraryListAction(section, year).catch(() => null);
      if (!res) return setError("Something went wrong on our side. Try again.");
      if (!res.ok) return setError(res.message);
      setLists((cur) => ({ ...cur, [section]: res.page }));
      setOpen(null);
    });
  }

  function openEntry(entry: ListEntry) {
    const key = entry.path;
    if (open === key) return setOpen(null);
    setOpen(key);
    if (entries[key] && entries[key] !== "loading" && typeof entries[key] !== "string") return;
    setEntries((cur) => ({ ...cur, [key]: "loading" }));
    void libraryEntryAction(entry.path)
      .then((res) => setEntries((cur) => ({ ...cur, [key]: res.ok ? res.sections : res.message })))
      .catch(() => setEntries((cur) => ({ ...cur, [key]: "Something went wrong on our side. Try again." })));
  }

  function chooseTab(next: Tab) {
    setTab(next);
    setError(undefined);
    setNotice(undefined);
    if (next === "likkutei" && !likkut) loadVolume(1);
    if (next !== "likkutei" && !lists[next]) loadYear(next);
  }

  // Open on Likkutei Sichos: the first load happens once, after mount.
  useEffect(() => {
    const t = setTimeout(() => loadVolume(1), 0);
    return () => clearTimeout(t);
  }, []);

  const list = tab === "likkutei" ? null : lists[tab];

  // What is on screen after the search and the "English only" filter.
  const visibleParshiyos = likkut
    ? likkut.parshiyos
        .map((p) => ({ ...p, entries: p.entries.filter((e) => matchesQuery([e.label, e.summary, p.name], query) && (!englishOnly || hasEnglish(e.links))) }))
        .filter((p) => p.entries.length > 0)
    : [];
  const visibleCount = visibleParshiyos.reduce((n, p) => n + p.entries.length, 0);
  const visibleList = list ? list.entries.filter((e) => matchesQuery([e.heading, e.title, e.series, e.note], query)) : [];

  return (
    <div className="pb-28">
      <Segmented<Tab>
        label="Part of the library"
        value={tab}
        onChange={chooseTab}
        options={[
          { value: "likkutei", label: "Likkutei Sichos" },
          { value: "maamorim", label: "Maamarim" },
          { value: "all", label: "Sichos and farbrengens" },
        ]}
      />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" aria-hidden="true" />
          <Input aria-label="Search this list" type="search" placeholder="Search (a name, a topic, a parsha)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" className="ps-10" dir="auto" />
        </div>
        {tab === "likkutei" && (
          <Chip active={englishOnly} onClick={() => setEnglishOnly((v) => !v)}>
            English available only
          </Chip>
        )}
      </div>
      <FormError message={error} />
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
            {query || englishOnly ? " match" : " in this volume"}
          </p>
          {visibleCount === 0 && <p className="mt-3 text-sm text-[var(--color-muted)]">Nothing matches. Clear the search{englishOnly ? " or the English filter" : ""} to see more.</p>}
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
                        {hasEnglish(e.links) && <Badge tone="accent">English available</Badge>}
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
                        {e.links.length === 0 && <span className="text-[13px] text-[var(--color-muted)]">No file yet.</span>}
                      </div>
                    </li>
                  ))}
                </ul>
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
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-xs)]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <p className="min-w-0 flex-1 text-sm font-medium">
              {cart.length} {cart.length === 1 ? "file" : "files"} chosen
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => (clearCart(), setCart([]))}>
              Clear
            </Button>
            <Button type="button" onClick={() => router.push("/print/booklet")}>
              Make a booklet
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
