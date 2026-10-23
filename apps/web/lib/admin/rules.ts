/**
 * Plain-language wording for print rules and monthly limits, and the tiny
 * "rule builder" that turns a few simple choices into the condition list the
 * policy engine reads. Pure; unit tested in rules.test.ts. The policy engine
 * itself (packages/shared) is unchanged.
 */
import { roleLabel } from "@/lib/role-label";

export type RuleAction = "allow" | "require_approval" | "deny";

export interface RuleLike {
  action: string;
  conditions: Array<{ field: string; operator: string; value: unknown }>;
}

export interface NameLookups {
  groupName?: (id: string) => string | null | undefined;
  printerName?: (id: string) => string | null | undefined;
  userName?: (id: string) => string | null | undefined;
}

export function actionVerb(action: string): string {
  switch (action) {
    case "allow":
      return "are allowed";
    case "require_approval":
      return "need approval";
    default:
      return "are not allowed";
  }
}

function singularVerb(action: string): string {
  switch (action) {
    case "allow":
      return "is allowed";
    case "require_approval":
      return "needs approval";
    default:
      return "is not allowed";
  }
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

function compare(op: string, v: unknown, words: { gt: string; gte: string; lt: string; lte: string; eq: string }, unit: (c: number) => string): string | null {
  const num = n(v);
  if (num === null) return null;
  const pick = op === "gt" ? words.gt : op === "gte" ? words.gte : op === "lt" ? words.lt : op === "lte" ? words.lte : op === "eq" ? words.eq : null;
  if (!pick) return null;
  return pick.replace("{n}", String(num)).replace("{unit}", unit(num));
}

function clock(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")} ${suffix}`;
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function dayPhrase(op: string, v: unknown): string | null {
  const list = Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : n(v) !== null ? [v as number] : [];
  if (list.length === 0) return null;
  const set = new Set(list);
  if (op === "neq" || op === "not_in") return `not on ${list.map((d) => DAYS[d] ?? "").filter(Boolean).join(" or ")}`;
  if (set.size === 2 && set.has(0) && set.has(6)) return "on weekends";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "on weekdays";
  return `on ${list.map((d) => DAYS[d] ?? "").filter(Boolean).join(" and ")}`;
}

function pluralRole(role: string): string {
  const label = roleLabel(role).toLowerCase();
  return label === "staff" ? "staff" : `${label}s`;
}

/** One sentence for a rule, e.g. "Color jobs over 20 pages need approval". */
export function ruleSentence(rule: RuleLike, names: NameLookups = {}): string {
  const adjectives: string[] = [];
  const quantity: string[] = [];
  const where: string[] = [];
  const who: string[] = [];
  const when: string[] = [];
  let custom = false;

  for (const c of rule.conditions) {
    const { field, operator: op, value: v } = c;
    let handled = true;
    switch (field) {
      case "colorMode":
        if (op === "eq" && v === "color") adjectives.push("Color");
        else if (op === "eq" && v === "bw") adjectives.push("Black and white");
        else if (op === "neq" && v === "color") adjectives.push("Black and white");
        else if (op === "neq" && v === "bw") adjectives.push("Color");
        else handled = false;
        break;
      case "duplex":
        if (typeof v === "boolean") adjectives.push(v === (op !== "neq") ? "Double-sided" : "Single-sided");
        else handled = false;
        break;
      case "finishingStaple":
      case "finishingBooklet":
      case "finishingPunch": {
        const word = field === "finishingStaple" ? "Stapled" : field === "finishingBooklet" ? "Booklet" : "Hole-punched";
        if (typeof v === "boolean" && v === (op !== "neq")) adjectives.push(word);
        else handled = false;
        break;
      }
      case "pageCount": {
        const t = compare(op, v, { gt: "over {n} {unit}", gte: "of {n} or more {unit}", lt: "under {n} {unit}", lte: "of {n} or fewer {unit}", eq: "of exactly {n} {unit}" }, (c2) => plural(c2, "page", "pages"));
        if (t) quantity.push(t);
        else handled = false;
        break;
      }
      case "copies": {
        const t = compare(op, v, { gt: "with more than {n} {unit}", gte: "with {n} or more {unit}", lt: "with fewer than {n} {unit}", lte: "with {n} or fewer {unit}", eq: "with {n} {unit}" }, (c2) => plural(c2, "copy", "copies"));
        if (t) quantity.push(t);
        else handled = false;
        break;
      }
      case "estimatedPhysicalSheets": {
        const t = compare(op, v, { gt: "using more than {n} {unit}", gte: "using {n} or more {unit}", lt: "using fewer than {n} {unit}", lte: "using {n} or fewer {unit}", eq: "using {n} {unit}" }, (c2) => plural(c2, "sheet", "sheets"));
        if (t) quantity.push(t);
        else handled = false;
        break;
      }
      case "estimatedCostCents": {
        const cents = n(v);
        if (cents === null || !["gt", "gte", "lt", "lte"].includes(op)) {
          handled = false;
          break;
        }
        const money = `$${(cents / 100).toFixed(2)}`;
        quantity.push(`costing ${op === "gt" ? "more than" : op === "gte" ? "at least" : op === "lt" ? "less than" : "at most"} ${money}`);
        break;
      }
      case "paperSize": {
        const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
        if (list.length === 0) handled = false;
        else where.push(`${op === "neq" || op === "not_in" ? "not " : ""}on ${list.join(" or ")} paper`);
        break;
      }
      case "role": {
        const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [];
        if (list.length === 0) handled = false;
        else who.push(`${op === "neq" || op === "not_in" ? "not from" : "from"} ${list.map(pluralRole).join(" or ")}`);
        break;
      }
      case "department":
        if (typeof v === "string" && v) who.push(`${op === "neq" ? "not from" : "from"} the ${v} department`);
        else handled = false;
        break;
      case "groupIds": {
        const id = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
        const name = id ? names.groupName?.(id) : null;
        who.push(name ? `from the ${name} group` : "from a certain group");
        break;
      }
      case "userId": {
        const id = String(v ?? "");
        const name = id ? names.userName?.(id) : null;
        who.push(name ? `from ${name}` : "from one person");
        break;
      }
      case "printerId": {
        const id = String(v ?? "");
        const name = id ? names.printerName?.(id) : null;
        where.push(name ? `sent to ${name}` : "sent to a certain printer");
        break;
      }
      case "dayOfWeek": {
        const t = dayPhrase(op, v);
        if (t) when.push(t);
        else handled = false;
        break;
      }
      case "timeOfDayMinutes": {
        if (op === "between" && Array.isArray(v) && n(v[0]) !== null && n(v[1]) !== null) {
          when.push(`between ${clock(v[0] as number)} and ${clock(v[1] as number)}`);
        } else if ((op === "gte" || op === "gt") && n(v) !== null) when.push(`from ${clock(v as number)} on`);
        else if ((op === "lt" || op === "lte") && n(v) !== null) when.push(`before ${clock(v as number)}`);
        else handled = false;
        break;
      }
      case "monthlyQuotaUsagePct":
        if ((op === "gt" || op === "gte") && n(v) !== null) when.push(`when ${op === "gt" ? "over" : "at least"} ${v}% of the monthly limit is used`);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled) custom = true;
  }

  const verbFor = (singular: boolean) => (singular ? singularVerb(rule.action) : actionVerb(rule.action));
  const parts = [...quantity, ...where, ...who, ...when];
  if (custom) parts.push("that match a custom condition");

  if (rule.conditions.length === 0) return `Every job ${verbFor(true)}`;

  const subject =
    adjectives.length > 0
      ? `${adjectives.map((w, i) => (i === 0 ? w : w.charAt(0).toLowerCase() + w.slice(1))).join(" ")} jobs`
      : "Jobs";
  return [subject, ...parts, verbFor(false)].join(" ");
}

export type ColorChoice = "any" | "color" | "bw";

export interface RuleFormValues {
  color: ColorChoice;
  pagesOver: string;
  copiesOver: string;
  role: string;
  stapled: boolean;
}

function positiveInt(s: string): number | null {
  const v = Number.parseInt(s, 10);
  return Number.isFinite(v) && v > 0 && /^\d+$/.test(s.trim()) ? v : null;
}

/** The conditions the policy engine reads, from the simple "add a rule" form. */
export function buildConditions(f: RuleFormValues): Array<{ field: string; operator: string; value: unknown }> {
  const out: Array<{ field: string; operator: string; value: unknown }> = [];
  if (f.color !== "any") out.push({ field: "colorMode", operator: "eq", value: f.color });
  const pages = positiveInt(f.pagesOver);
  if (pages !== null) out.push({ field: "pageCount", operator: "gt", value: pages });
  const copies = positiveInt(f.copiesOver);
  if (copies !== null) out.push({ field: "copies", operator: "gt", value: copies });
  if (f.role !== "any" && f.role) out.push({ field: "role", operator: "eq", value: f.role });
  if (f.stapled) out.push({ field: "finishingStaple", operator: "eq", value: true });
  return out;
}

/** The unit a monthly limit counts, in everyday words. */
export function unitWord(basis: string | null | undefined): string {
  switch (basis) {
    case "pdf_pages":
      return "pages";
    case "printed_sides":
      return "sides";
    case "color_weighted":
      return "color-weighted pages";
    default:
      return "sheets";
  }
}

/** Who a monthly limit is for: "Everyone", "Users", "The Science department", ... */
export function quotaSentence(q: { scope_type: string; scope_value: string | null }, names: NameLookups): string {
  const value = q.scope_value ?? "";
  switch (q.scope_type) {
    case "organization":
      return "Everyone";
    case "role": {
      const label = roleLabel(value);
      return label === "User" ? "Users" : label;
    }
    case "department":
      return `The ${value} department`;
    case "group":
      return `The ${names.groupName?.(value) ?? "chosen"} group`;
    case "user":
      return names.userName?.(value) ?? "One person";
    default:
      return "Some people";
  }
}
