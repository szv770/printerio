/**
 * The print page's quick controls as PURE rules: (current choices + one tap) -> (new choices + a plain note).
 * No React, no server imports, so the whole table is testable (print-choice-rules.test.ts) and the form only wires taps to it.
 *
 * Principle: NOTHING is greyed out and no control is locked "because of" another. A tap always does what the person asked
 * for, and whatever it cannot live with is SWITCHED, with one plain sentence saying so (the form shows it in the live
 * summary), for example "Single-sided because hole punch with a staple needs it."
 *
 * The rules mirror what the PRINTER genuinely cannot do, as the server already decides it (print-choices.ts mapRawChoices
 * and packages/shared/src/pjl.ts PROVEN_FINISHING_COMBOS). A test runs every settled state through mapRawChoices and
 * expects no held reason, so the two can not drift apart. The conflicts, for a raw-port (Kyocera) printer:
 *   - A booklet is double-sided, staples itself, and cannot be punched or printed on cardstock. Choosing the booklet
 *     overrides all of that in one go; choosing sides / a staple / punch / cardstock turns the booklet off.
 *   - Two staples (left) need single-sided (double-sided gave one staple, labelled print P3) and cannot be punched.
 *   - Hole punch + a corner staple is proven single-sided only (P2). Hole punch + a top-right staple is not offered.
 *     Hole punch alone is proven double-sided too (P1).
 *   - A short-edge flip cannot be combined with a corner staple (the corner is unknown) or with hole punch: the server
 *     would hold the job, so the form switches instead.
 *   - Cardstock is loaded only in the bypass tray, in Letter: not with Tabloid, not with a booklet.
 * A Windows-queue printer (ctx.raw false) has none of the staple / punch / edge combinations (it never offers them);
 * only the booklet override applies there.
 *
 * Booklet sheet size: a booklet's sheet is the main Size choice (Letter = regular statement-size pages, Tabloid = full
 * size pages on an 11x17 sheet). They are ONE value here, so the "Booklet size" control under Booklet and the main row can
 * never disagree: changing either changes both.
 */
import type { StapleChoice } from "./print-choices";

export type SidesValue = "one" | "two";
export type EdgeValue = "long" | "short";
export type StapleValue = Exclude<StapleChoice, "profile">;
export type BookletValue = "none" | "left" | "right";
export type SizeValue = "letter" | "tabloid";
export type PaperValue = "plain" | "cardstock";

export interface ChoiceState {
  sides: SidesValue;
  /** Only meaningful when double-sided (and not a booklet); always "long" when single-sided. */
  edge: EdgeValue;
  staple: StapleValue;
  punch: boolean;
  booklet: BookletValue;
  /** The main page size; for a booklet it is also the booklet's sheet. */
  size: SizeValue;
  paper: PaperValue;
}

export const CLEAN_CHOICES: ChoiceState = { sides: "one", edge: "long", staple: "none", punch: false, booklet: "none", size: "letter", paper: "plain" };

export type ChoiceTap =
  | { kind: "sides"; value: SidesValue }
  | { kind: "edge"; value: EdgeValue }
  | { kind: "booklet"; value: BookletValue }
  | { kind: "staple"; value: StapleValue }
  | { kind: "punch"; value: boolean }
  | { kind: "size"; value: SizeValue }
  | { kind: "paper"; value: PaperValue };

export interface RuleContext {
  /** A raw-port printer (the Kyocera): the staple / punch / flip-edge combinations apply. A Windows queue has none of them. */
  raw: boolean;
}

export interface TapResult {
  state: ChoiceState;
  /** One or two plain sentences saying what was switched besides the tap itself; null when nothing else changed. */
  note: string | null;
}

/** Shown on the form whenever Cardstock is chosen (it comes from the bypass tray, which must be loaded first). */
export const CARDSTOCK_WARNING = "Uses the bypass tray: load cardstock there first, or the printer will wait and hold up other jobs.";

export function sizeFromPaperSize(paperSize: string): SizeValue {
  return paperSize === "tabloid" || paperSize === "11x17" ? "tabloid" : "letter";
}

const isCorner = (s: StapleValue) => s === "top-left" || s === "top-right";

/** What a tap on a quick control does, switching whatever it cannot live with. Never throws, never disables anything. */
export function applyTap(prev: ChoiceState, tap: ChoiceTap, ctx: RuleContext): TapResult {
  const s: ChoiceState = { ...prev };
  const notes: string[] = [];
  const raw = ctx.raw;

  const bookletOff = () => {
    if (s.booklet !== "none") {
      s.booklet = "none";
      notes.push("Booklet turned off.");
    }
  };
  const goSingle = (why: string) => {
    if (s.sides === "two") {
      s.sides = "one";
      s.edge = "long";
      notes.push(`Single-sided because ${why}.`);
    }
  };
  const goLongEdge = (why: string) => {
    if (s.sides === "two" && s.edge === "short") {
      s.edge = "long";
      notes.push(`Long edge because ${why}.`);
    }
  };

  switch (tap.kind) {
    case "sides": {
      bookletOff();
      if (tap.value === "one") {
        s.sides = "one";
        s.edge = "long";
      } else {
        s.sides = "two";
        if (raw) {
          if (s.staple === "dual-left") {
            s.staple = "top-left";
            notes.push("One staple (top-left) instead of two, because two staples need single-sided.");
          }
          if (s.punch && s.staple === "top-left") {
            s.staple = "none";
            notes.push("Staple turned off because hole punch with a staple needs single-sided.");
          }
        }
      }
      break;
    }
    case "edge": {
      if (prev.sides === "one") {
        // Choosing a flip edge means double-sided: do exactly what tapping Double-sided would.
        const r = applyTap(prev, { kind: "sides", value: "two" }, ctx);
        Object.assign(s, r.state);
        if (r.note) notes.push(r.note);
      } else {
        bookletOff();
      }
      s.edge = tap.value;
      if (tap.value === "short" && raw) {
        if (isCorner(s.staple)) {
          s.staple = "none";
          notes.push("Staple turned off because a corner staple can't be placed with a short-edge flip yet.");
        }
        if (s.punch) {
          s.punch = false;
          notes.push("Hole punch turned off because it can't be combined with a short-edge flip yet.");
        }
      }
      break;
    }
    case "booklet": {
      if (tap.value === "none") {
        s.booklet = "none";
        break;
      }
      s.booklet = tap.value;
      if (s.sides !== "two") {
        s.sides = "two";
        notes.push("Double-sided for the booklet.");
      }
      if (s.staple !== "none") {
        s.staple = "none";
        notes.push("Staple turned off because a booklet staples itself.");
      }
      if (s.punch) {
        s.punch = false;
        notes.push("Hole punch turned off for the booklet.");
      }
      if (s.paper === "cardstock") {
        s.paper = "plain";
        notes.push("Plain paper for the booklet.");
      }
      break;
    }
    case "staple": {
      bookletOff();
      s.staple = tap.value;
      if (!raw || tap.value === "none") break;
      if (tap.value === "dual-left") {
        if (s.punch) {
          s.punch = false;
          notes.push("Hole punch turned off because it can't be combined with two staples.");
        }
        goSingle("two staples need it");
      } else {
        if (tap.value === "top-right" && s.punch) {
          s.punch = false;
          notes.push("Hole punch turned off because it can't be combined with a top-right staple.");
        }
        if (tap.value === "top-left" && s.punch) goSingle("a staple together with hole punch needs it");
        goLongEdge("a corner staple can't be placed with a short-edge flip yet");
      }
      break;
    }
    case "punch": {
      if (!tap.value) {
        s.punch = false;
        break;
      }
      bookletOff();
      s.punch = true;
      if (!raw) break;
      if (s.staple === "dual-left") {
        s.staple = "none";
        notes.push("Staple turned off because hole punch can't be combined with two staples.");
      } else if (s.staple === "top-right") {
        s.staple = "none";
        notes.push("Staple turned off because hole punch can't be combined with a top-right staple.");
      } else if (s.staple === "top-left") {
        goSingle("hole punch with a staple needs it");
      }
      goLongEdge("hole punch can't be combined with a short-edge flip yet");
      break;
    }
    case "size": {
      s.size = tap.value;
      if (tap.value === "tabloid" && s.paper === "cardstock") {
        s.paper = "plain";
        notes.push("Plain paper because cardstock is only loaded in Letter size.");
      }
      break;
    }
    case "paper": {
      s.paper = tap.value;
      if (tap.value === "cardstock") {
        if (s.booklet !== "none") {
          s.booklet = "none";
          notes.push("Booklet turned off because cardstock comes from the bypass tray and can't be folded into a booklet.");
        }
        if (s.size === "tabloid") {
          s.size = "letter";
          notes.push("Letter size because cardstock is only loaded in Letter.");
        }
      }
      break;
    }
  }
  return { state: s, note: notes.length ? notes.join(" ") : null };
}

/**
 * Makes any starting state consistent without a tap (a "Print again" job, a booklet-builder handoff, a remembered choice
 * that does not fit): the booklet wins, then the printer's own combinations. Silent: it only runs before the person has
 * touched anything.
 */
export function settleState(state: ChoiceState, ctx: RuleContext): ChoiceState {
  const s: ChoiceState = { ...state };
  if (s.booklet !== "none") {
    s.sides = "two";
    s.staple = "none";
    s.punch = false;
    s.paper = "plain";
  }
  if (s.paper === "cardstock" && s.size === "tabloid") s.paper = "plain";
  if (s.sides === "one") s.edge = "long";
  if (ctx.raw && s.booklet === "none") {
    if (s.staple === "dual-left") {
      s.punch = false;
      s.sides = "one";
      s.edge = "long";
    }
    if (s.punch && (s.staple === "top-right" || (s.staple === "top-left" && s.sides === "two"))) s.staple = "none";
    if (s.sides === "two" && s.edge === "short" && (isCorner(s.staple) || s.punch)) s.edge = "long";
  }
  return s;
}

export interface PrinterFit {
  raw: boolean;
  duplex: boolean;
  staple: boolean;
  booklet: boolean;
  punch: boolean;
  /** The printer declares 11x17 (or tabloid). */
  tabloid: boolean;
}

/**
 * What the form will really submit for the selected printer: whatever the printer does not offer drops out (the raw picks
 * stay in the form's state, so switching back to a printer that does restores them). A Windows queue only ever has a
 * plain corner staple, no flip edge, no cardstock.
 */
export function fitToPrinter(state: ChoiceState, p: PrinterFit): ChoiceState {
  const s: ChoiceState = { ...state };
  if (!p.duplex) {
    s.sides = "one";
    s.booklet = "none";
  }
  if (!p.booklet) s.booklet = "none";
  if (!p.staple) s.staple = "none";
  else if (!p.raw && s.staple !== "none") s.staple = "top-left";
  if (!p.punch) s.punch = false;
  if (!p.raw) {
    s.edge = "long";
    s.paper = "plain";
  }
  if (!p.tabloid) s.size = "letter";
  return settleState(s, { raw: p.raw });
}

/** The conflict a state still has (null = consistent). Used by the tests as an independent check of applyTap / settleState. */
export function findConflict(s: ChoiceState, ctx: RuleContext): string | null {
  if (s.booklet !== "none") {
    if (s.sides !== "two") return "booklet must be double-sided";
    if (s.staple !== "none") return "booklet cannot be stapled";
    if (s.punch) return "booklet cannot be punched";
    if (s.paper === "cardstock") return "booklet cannot be cardstock";
  }
  if (s.sides === "one" && s.edge !== "long") return "single-sided has no flip edge";
  if (s.paper === "cardstock" && s.size === "tabloid") return "cardstock is Letter only";
  if (ctx.raw && s.booklet === "none") {
    if (s.staple === "dual-left" && s.sides === "two") return "two staples need single-sided";
    if (s.staple === "dual-left" && s.punch) return "two staples cannot be punched";
    if (s.punch && s.staple === "top-right") return "punch with a top-right staple";
    if (s.punch && s.staple === "top-left" && s.sides === "two") return "punch with a staple needs single-sided";
    if (s.sides === "two" && s.edge === "short" && isCorner(s.staple)) return "short edge with a corner staple";
    if (s.sides === "two" && s.edge === "short" && s.punch) return "short edge with punch";
  }
  return null;
}
