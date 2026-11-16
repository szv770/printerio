import { describe, expect, it } from "vitest";
import { mapRawChoices, type PrintChoices } from "./print-choices";
import {
  CARDSTOCK_WARNING,
  CLEAN_CHOICES,
  applyTap,
  findConflict,
  fitToPrinter,
  settleState,
  sizeFromPaperSize,
  type ChoiceState,
  type ChoiceTap,
} from "./print-choice-rules";

const RAW = { raw: true };
const QUEUE = { raw: false };
const st = (over: Partial<ChoiceState> = {}): ChoiceState => ({ ...CLEAN_CHOICES, ...over });

type Row = { name: string; from: Partial<ChoiceState>; tap: ChoiceTap; to: Partial<ChoiceState>; note: string | null };

/** Every tap from the states where it matters. `to` is the full result (merged over the clean state). */
const TABLE: Row[] = [
  // --- sides ---
  { name: "single from clean", from: {}, tap: { kind: "sides", value: "one" }, to: {}, note: null },
  { name: "double from clean", from: {}, tap: { kind: "sides", value: "two" }, to: { sides: "two" }, note: null },
  { name: "single from double short edge resets the edge", from: { sides: "two", edge: "short" }, tap: { kind: "sides", value: "one" }, to: {}, note: null },
  { name: "double keeps long edge", from: { sides: "two", edge: "long" }, tap: { kind: "sides", value: "two" }, to: { sides: "two" }, note: null },
  { name: "double keeps short edge", from: { sides: "two", edge: "short" }, tap: { kind: "sides", value: "two" }, to: { sides: "two", edge: "short" }, note: null },
  { name: "single turns a booklet off", from: { booklet: "left", sides: "two" }, tap: { kind: "sides", value: "one" }, to: {}, note: "Booklet turned off." },
  { name: "double turns a booklet off", from: { booklet: "right", sides: "two" }, tap: { kind: "sides", value: "two" }, to: { sides: "two" }, note: "Booklet turned off." },
  {
    name: "double from two staples: one corner staple instead",
    from: { staple: "dual-left" },
    tap: { kind: "sides", value: "two" },
    to: { sides: "two", staple: "top-left" },
    note: "One staple (top-left) instead of two, because two staples need single-sided.",
  },
  {
    name: "double from punch + corner staple: the staple goes",
    from: { staple: "top-left", punch: true },
    tap: { kind: "sides", value: "two" },
    to: { sides: "two", punch: true },
    note: "Staple turned off because hole punch with a staple needs single-sided.",
  },
  { name: "double with punch alone is fine (proven P1)", from: { punch: true }, tap: { kind: "sides", value: "two" }, to: { sides: "two", punch: true }, note: null },
  { name: "double with a top-right staple is fine", from: { staple: "top-right" }, tap: { kind: "sides", value: "two" }, to: { sides: "two", staple: "top-right" }, note: null },

  // --- flip edge ---
  { name: "long edge from double", from: { sides: "two", edge: "short" }, tap: { kind: "edge", value: "long" }, to: { sides: "two" }, note: null },
  { name: "short edge from double", from: { sides: "two" }, tap: { kind: "edge", value: "short" }, to: { sides: "two", edge: "short" }, note: null },
  { name: "short edge from single also switches to double", from: {}, tap: { kind: "edge", value: "short" }, to: { sides: "two", edge: "short" }, note: null },
  {
    name: "short edge turns a corner staple off, saying why",
    from: { sides: "two", staple: "top-left" },
    tap: { kind: "edge", value: "short" },
    to: { sides: "two", edge: "short" },
    note: "Staple turned off because a corner staple can't be placed with a short-edge flip yet.",
  },
  {
    name: "short edge turns a top-right staple off too",
    from: { sides: "two", staple: "top-right" },
    tap: { kind: "edge", value: "short" },
    to: { sides: "two", edge: "short" },
    note: "Staple turned off because a corner staple can't be placed with a short-edge flip yet.",
  },
  {
    name: "short edge turns hole punch off, saying why",
    from: { sides: "two", punch: true },
    tap: { kind: "edge", value: "short" },
    to: { sides: "two", edge: "short" },
    note: "Hole punch turned off because it can't be combined with a short-edge flip yet.",
  },
  {
    name: "short edge from single + two staples goes double (one corner staple) then short (staple off)",
    from: { staple: "dual-left" },
    tap: { kind: "edge", value: "short" },
    to: { sides: "two", edge: "short" },
    note: "One staple (top-left) instead of two, because two staples need single-sided. Staple turned off because a corner staple can't be placed with a short-edge flip yet.",
  },
  { name: "an edge tap turns a booklet off", from: { booklet: "left", sides: "two" }, tap: { kind: "edge", value: "short" }, to: { sides: "two", edge: "short" }, note: "Booklet turned off." },

  // --- booklet ---
  {
    name: "booklet left from clean",
    from: {},
    tap: { kind: "booklet", value: "left" },
    to: { booklet: "left", sides: "two" },
    note: "Double-sided for the booklet.",
  },
  {
    name: "booklet right overrides everything in one go",
    from: { staple: "top-left", punch: true, paper: "cardstock" },
    tap: { kind: "booklet", value: "right" },
    to: { booklet: "right", sides: "two" },
    note: "Double-sided for the booklet. Staple turned off because a booklet staples itself. Hole punch turned off for the booklet. Plain paper for the booklet.",
  },
  { name: "booklet from double with nothing else: no note", from: { sides: "two" }, tap: { kind: "booklet", value: "left" }, to: { booklet: "left", sides: "two" }, note: null },
  { name: "left to right keeps everything", from: { booklet: "left", sides: "two" }, tap: { kind: "booklet", value: "right" }, to: { booklet: "right", sides: "two" }, note: null },
  { name: "booklet keeps the tabloid size (the sheet follows the size)", from: { size: "tabloid" }, tap: { kind: "booklet", value: "left" }, to: { booklet: "left", sides: "two", size: "tabloid" }, note: "Double-sided for the booklet." },
  { name: "booklet off leaves double-sided", from: { booklet: "left", sides: "two" }, tap: { kind: "booklet", value: "none" }, to: { sides: "two" }, note: null },

  // --- staple ---
  { name: "staple top-left from clean", from: {}, tap: { kind: "staple", value: "top-left" }, to: { staple: "top-left" }, note: null },
  { name: "staple top-right from clean", from: {}, tap: { kind: "staple", value: "top-right" }, to: { staple: "top-right" }, note: null },
  { name: "staple none", from: { staple: "top-left" }, tap: { kind: "staple", value: "none" }, to: {}, note: null },
  { name: "a staple choice turns a booklet off", from: { booklet: "left", sides: "two" }, tap: { kind: "staple", value: "top-left" }, to: { sides: "two", staple: "top-left" }, note: "Booklet turned off." },
  { name: "staple none also turns a booklet off", from: { booklet: "left", sides: "two" }, tap: { kind: "staple", value: "none" }, to: { sides: "two" }, note: "Booklet turned off." },
  {
    name: "two staples from double: single-sided because two staples need it",
    from: { sides: "two" },
    tap: { kind: "staple", value: "dual-left" },
    to: { staple: "dual-left" },
    note: "Single-sided because two staples need it.",
  },
  { name: "two staples from single", from: {}, tap: { kind: "staple", value: "dual-left" }, to: { staple: "dual-left" }, note: null },
  {
    name: "two staples turn hole punch off",
    from: { punch: true },
    tap: { kind: "staple", value: "dual-left" },
    to: { staple: "dual-left" },
    note: "Hole punch turned off because it can't be combined with two staples.",
  },
  {
    name: "corner staple with punch, double-sided: single-sided because a staple together with hole punch needs it",
    from: { sides: "two", punch: true },
    tap: { kind: "staple", value: "top-left" },
    to: { staple: "top-left", punch: true },
    note: "Single-sided because a staple together with hole punch needs it.",
  },
  { name: "corner staple with punch, single-sided is fine (proven P2)", from: { punch: true }, tap: { kind: "staple", value: "top-left" }, to: { staple: "top-left", punch: true }, note: null },
  {
    name: "top-right staple turns hole punch off",
    from: { punch: true },
    tap: { kind: "staple", value: "top-right" },
    to: { staple: "top-right" },
    note: "Hole punch turned off because it can't be combined with a top-right staple.",
  },
  {
    name: "corner staple on a short-edge flip: back to the long edge, said plainly",
    from: { sides: "two", edge: "short" },
    tap: { kind: "staple", value: "top-left" },
    to: { sides: "two", staple: "top-left" },
    note: "Long edge because a corner staple can't be placed with a short-edge flip yet.",
  },
  {
    name: "top-right on a short-edge flip: back to the long edge",
    from: { sides: "two", edge: "short" },
    tap: { kind: "staple", value: "top-right" },
    to: { sides: "two", staple: "top-right" },
    note: "Long edge because a corner staple can't be placed with a short-edge flip yet.",
  },
  {
    name: "two staples on a short-edge flip: single-sided",
    from: { sides: "two", edge: "short" },
    tap: { kind: "staple", value: "dual-left" },
    to: { staple: "dual-left" },
    note: "Single-sided because two staples need it.",
  },

  // --- punch ---
  { name: "punch from clean", from: {}, tap: { kind: "punch", value: true }, to: { punch: true }, note: null },
  { name: "punch from double (proven P1)", from: { sides: "two" }, tap: { kind: "punch", value: true }, to: { sides: "two", punch: true }, note: null },
  { name: "punch off", from: { punch: true }, tap: { kind: "punch", value: false }, to: {}, note: null },
  { name: "punch turns a booklet off", from: { booklet: "left", sides: "two" }, tap: { kind: "punch", value: true }, to: { sides: "two", punch: true }, note: "Booklet turned off." },
  {
    name: "punch with a corner staple, double-sided: single-sided because hole punch with a staple needs it",
    from: { sides: "two", staple: "top-left" },
    tap: { kind: "punch", value: true },
    to: { staple: "top-left", punch: true },
    note: "Single-sided because hole punch with a staple needs it.",
  },
  { name: "punch with a corner staple, single-sided", from: { staple: "top-left" }, tap: { kind: "punch", value: true }, to: { staple: "top-left", punch: true }, note: null },
  {
    name: "punch turns a top-right staple off",
    from: { staple: "top-right" },
    tap: { kind: "punch", value: true },
    to: { punch: true },
    note: "Staple turned off because hole punch can't be combined with a top-right staple.",
  },
  {
    name: "punch turns two staples off",
    from: { staple: "dual-left" },
    tap: { kind: "punch", value: true },
    to: { punch: true },
    note: "Staple turned off because hole punch can't be combined with two staples.",
  },
  {
    name: "punch on a short-edge flip: back to the long edge",
    from: { sides: "two", edge: "short" },
    tap: { kind: "punch", value: true },
    to: { sides: "two", punch: true },
    note: "Long edge because hole punch can't be combined with a short-edge flip yet.",
  },

  // --- size ---
  { name: "tabloid from clean", from: {}, tap: { kind: "size", value: "tabloid" }, to: { size: "tabloid" }, note: null },
  { name: "letter from tabloid", from: { size: "tabloid" }, tap: { kind: "size", value: "letter" }, to: {}, note: null },
  { name: "size keeps a booklet and the booklet sheet follows", from: { booklet: "left", sides: "two" }, tap: { kind: "size", value: "tabloid" }, to: { booklet: "left", sides: "two", size: "tabloid" }, note: null },
  { name: "tabloid keeps the flip edge, staple and punch", from: { sides: "two", staple: "top-right" }, tap: { kind: "size", value: "tabloid" }, to: { sides: "two", staple: "top-right", size: "tabloid" }, note: null },
  {
    name: "tabloid switches cardstock to plain",
    from: { paper: "cardstock" },
    tap: { kind: "size", value: "tabloid" },
    to: { size: "tabloid" },
    note: "Plain paper because cardstock is only loaded in Letter size.",
  },

  // --- paper type ---
  { name: "cardstock from clean", from: {}, tap: { kind: "paper", value: "cardstock" }, to: { paper: "cardstock" }, note: null },
  { name: "plain from cardstock", from: { paper: "cardstock" }, tap: { kind: "paper", value: "plain" }, to: {}, note: null },
  {
    name: "cardstock turns a booklet off",
    from: { booklet: "left", sides: "two" },
    tap: { kind: "paper", value: "cardstock" },
    to: { sides: "two", paper: "cardstock" },
    note: "Booklet turned off because cardstock comes from the bypass tray and can't be folded into a booklet.",
  },
  {
    name: "cardstock switches tabloid to Letter",
    from: { size: "tabloid" },
    tap: { kind: "paper", value: "cardstock" },
    to: { paper: "cardstock" },
    note: "Letter size because cardstock is only loaded in Letter.",
  },
  { name: "cardstock keeps double-sided, staple and punch (not known to conflict)", from: { sides: "two", punch: true }, tap: { kind: "paper", value: "cardstock" }, to: { sides: "two", punch: true, paper: "cardstock" }, note: null },
];

describe("the rules table: one tap from a state gives a new state and a plain note", () => {
  it.each(TABLE)("$name", ({ from, tap, to, note }) => {
    const r = applyTap(st(from), tap, RAW);
    expect(r.state).toEqual(st(to));
    expect(r.note).toBe(note);
    expect(findConflict(r.state, RAW)).toBeNull();
  });
});

describe("every tap from every state (raw printer)", () => {
  const sides = ["one", "two"] as const;
  const edges = ["long", "short"] as const;
  const staples = ["none", "top-left", "top-right", "dual-left"] as const;
  const booklets = ["none", "left", "right"] as const;
  const sizes = ["letter", "tabloid"] as const;
  const papers = ["plain", "cardstock"] as const;
  const taps: ChoiceTap[] = [
    { kind: "sides", value: "one" },
    { kind: "sides", value: "two" },
    { kind: "edge", value: "long" },
    { kind: "edge", value: "short" },
    { kind: "booklet", value: "none" },
    { kind: "booklet", value: "left" },
    { kind: "booklet", value: "right" },
    ...staples.map((value) => ({ kind: "staple", value }) as ChoiceTap),
    { kind: "punch", value: true },
    { kind: "punch", value: false },
    ...sizes.map((value) => ({ kind: "size", value }) as ChoiceTap),
    ...papers.map((value) => ({ kind: "paper", value }) as ChoiceTap),
  ];
  // Every SETTLED state (the ones the form can be in): the unsettled mixes are what settleState exists to repair.
  const states: ChoiceState[] = [];
  for (const a of sides) for (const e of edges) for (const s of staples) for (const p of [false, true]) for (const b of booklets) for (const z of sizes) for (const t of papers) {
    const c: ChoiceState = { sides: a, edge: e, staple: s, punch: p, booklet: b, size: z, paper: t };
    if (findConflict(c, RAW) === null) states.push(c);
  }

  it("covers a meaningful number of states and taps", () => {
    expect(states.length).toBeGreaterThan(30);
    expect(taps.length).toBe(17);
  });

  it("the result is always consistent, the tap is honoured, and a note appears exactly when something else changed", () => {
    for (const from of states) {
      for (const tap of taps) {
        const r = applyTap(from, tap, RAW);
        const where = `${JSON.stringify(from)} + ${JSON.stringify(tap)}`;
        expect(findConflict(r.state, RAW), where).toBeNull();
        expect(settleState(r.state, RAW), where).toEqual(r.state);
        // The tapped value wins, except where a tap turns itself into its consequence (an edge tap on single-sided goes double-sided, a booklet-off tap).
        if (tap.kind === "sides") expect(r.state.sides, where).toBe(tap.value);
        if (tap.kind === "edge") expect(r.state.edge, where).toBe(tap.value);
        if (tap.kind === "booklet") expect(r.state.booklet, where).toBe(tap.value);
        if (tap.kind === "staple") expect(r.state.staple, where).toBe(tap.value);
        if (tap.kind === "punch") expect(r.state.punch, where).toBe(tap.value);
        if (tap.kind === "size") expect(r.state.size, where).toBe(tap.value);
        if (tap.kind === "paper") expect(r.state.paper, where).toBe(tap.value);
        // Never silent about a switch: a note appears exactly when a setting other than the tapped one changed.
        // (Implied by the tap itself: an edge tap means double-sided; single-sided resets the flip edge.)
        const implied = new Set<keyof ChoiceState>([tap.kind]);
        if (tap.kind === "edge") implied.add("sides");
        if (tap.kind === "sides" && tap.value === "one") implied.add("edge");
        const others = (Object.keys(from) as (keyof ChoiceState)[]).filter((k) => !implied.has(k) && from[k] !== r.state[k]);
        if (others.length > 0) expect(r.note, where).not.toBeNull();
        else expect(r.note, where).toBeNull();
      }
    }
  });

  it("every settled state is one the SERVER accepts: mapRawChoices holds nothing (so the form never offers a combination the printer would hold)", () => {
    const profile = {
      capabilities: { duplex: true, staple: true, booklet: true, punch: true },
      bookletBindingSide: "left" as const,
      stapleDefault: "top-left" as const,
      declaredPaperSizes: ["letter", "11x17"],
    };
    for (const s of states) {
      const choices: PrintChoices = {
        sides: s.sides,
        staple: s.staple,
        booklet: s.booklet,
        copies: 1,
        pageRange: "",
        ...(s.punch ? { punch: true } : {}),
        ...(s.sides === "two" && s.edge === "short" && s.booklet === "none" ? { flip: "short" as const } : {}),
        ...(s.paper === "cardstock" ? { paper: "cardstock" as const } : {}),
      };
      const mapped = mapRawChoices(choices, profile);
      expect(mapped.heldReason, JSON.stringify(s)).toBeNull();
    }
  });

  it("and the server really does hold the mixes the rules switch away from (the rules mirror it, not invent it)", () => {
    const profile = {
      capabilities: { duplex: true, staple: true, booklet: true, punch: true },
      bookletBindingSide: "left" as const,
      stapleDefault: "top-left" as const,
      declaredPaperSizes: ["letter"],
    };
    const base: PrintChoices = { sides: "one", staple: "none", booklet: "none", copies: 1, pageRange: "" };
    const held = (c: Partial<PrintChoices>) => mapRawChoices({ ...base, ...c }, profile).heldReason;
    expect(held({ sides: "two", staple: "dual-left" })).not.toBeNull();
    expect(held({ punch: true, staple: "dual-left" })).not.toBeNull();
    expect(held({ punch: true, staple: "top-right" })).not.toBeNull();
    expect(held({ sides: "two", punch: true, staple: "top-left" })).not.toBeNull();
    expect(held({ sides: "two", flip: "short", staple: "top-left" })).not.toBeNull();
    expect(held({ sides: "two", flip: "short", punch: true })).not.toBeNull();
    expect(held({ booklet: "left", paper: "cardstock" })).not.toBeNull();
    expect(held({ booklet: "left", punch: true })).not.toBeNull();
    expect(held({ booklet: "left", staple: "top-left" })).not.toBeNull();
  });
});

describe("a Windows-queue printer: only the booklet override applies", () => {
  it("a booklet still overrides staple and punch in one go", () => {
    const r = applyTap(st({ staple: "top-left", punch: true }), { kind: "booklet", value: "left" }, QUEUE);
    expect(r.state).toEqual(st({ booklet: "left", sides: "two" }));
  });
  it("staple, punch and sides combine freely (the queue's own driver decides)", () => {
    expect(applyTap(st({ sides: "two", punch: true }), { kind: "staple", value: "top-left" }, QUEUE)).toEqual({ state: st({ sides: "two", punch: true, staple: "top-left" }), note: null });
    expect(applyTap(st({ sides: "two", staple: "top-left" }), { kind: "punch", value: true }, QUEUE)).toEqual({ state: st({ sides: "two", punch: true, staple: "top-left" }), note: null });
  });
});

describe("settleState: a starting mix (Print again, builder handoff, remembered) becomes consistent, silently", () => {
  it("the booklet wins over staple, punch, cardstock and single-sided", () => {
    expect(settleState(st({ booklet: "right", staple: "top-left", punch: true, paper: "cardstock", sides: "one" }), RAW)).toEqual(st({ booklet: "right", sides: "two" }));
  });
  it("a clean state is untouched", () => {
    expect(settleState(CLEAN_CHOICES, RAW)).toEqual(CLEAN_CHOICES);
  });
  it("cardstock on Tabloid becomes plain; two staples on double-sided become single-sided", () => {
    expect(settleState(st({ paper: "cardstock", size: "tabloid" }), RAW)).toEqual(st({ size: "tabloid" }));
    expect(settleState(st({ staple: "dual-left", sides: "two" }), RAW)).toEqual(st({ staple: "dual-left" }));
  });
});

describe("fitToPrinter: what the selected printer does not offer drops out", () => {
  const all = { raw: true, duplex: true, staple: true, booklet: true, punch: true, tabloid: true };
  it("keeps everything on a printer that offers it all", () => {
    const s = st({ sides: "two", edge: "short", paper: "cardstock", size: "letter" });
    expect(fitToPrinter(s, all)).toEqual(s);
  });
  it("a single-sided-only printer: no double-sided, no booklet", () => {
    expect(fitToPrinter(st({ booklet: "left", sides: "two" }), { ...all, duplex: false })).toEqual(st());
  });
  it("a Windows queue: a plain staple, no flip edge, no cardstock, no two staples", () => {
    expect(fitToPrinter(st({ sides: "two", edge: "short", paper: "cardstock", staple: "top-right" }), { ...all, raw: false })).toEqual(st({ sides: "two", staple: "top-left" }));
  });
  it("no tabloid declared: Letter", () => {
    expect(fitToPrinter(st({ size: "tabloid" }), { ...all, tabloid: false })).toEqual(st());
  });
});

describe("small helpers", () => {
  it("both spellings of 11x17 are Tabloid; everything else is Letter", () => {
    expect(sizeFromPaperSize("tabloid")).toBe("tabloid");
    expect(sizeFromPaperSize("11x17")).toBe("tabloid");
    expect(sizeFromPaperSize("letter")).toBe("letter");
    expect(sizeFromPaperSize("a4")).toBe("letter");
  });
  it("the cardstock warning says what to do and what happens otherwise", () => {
    expect(CARDSTOCK_WARNING).toBe("Uses the bypass tray: load cardstock there first, or the printer will wait and hold up other jobs.");
  });
});
