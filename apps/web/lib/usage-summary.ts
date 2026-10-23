export interface UsageSummary {
  headline: string;
  detail: string;
  /** 0-100, or null when there is no limit. */
  pct: number | null;
  tone: "success" | "warning" | "danger";
}

const count = (n: number, unitPlural: string) => `${n} ${n === 1 ? unitPlural.replace(/s$/, "") : unitPlural}`;

/** Friendly wording for the "My usage" page. `unit` is the plural name, e.g. "sheets". */
export function usageSummary(input: { used: number; limit: number | null; unit: string }): UsageSummary {
  const { used, limit, unit } = input;
  if (limit === null) {
    return { headline: `${count(used, unit)} used this month`, detail: "No limit is set for you.", pct: null, tone: "success" };
  }
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "success";
  if (used >= limit) {
    return { headline: `You have used all ${count(limit, unit)}`, detail: `You have used ${used} of ${limit}.`, pct: 100, tone: "danger" };
  }
  return { headline: `${count(limit - used, unit)} left this month`, detail: `You have used ${used} of ${limit}.`, pct, tone };
}
