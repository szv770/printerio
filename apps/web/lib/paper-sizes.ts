/**
 * Administrators type the sizes a printer profile offers (printer_profiles.declared_paper_sizes). The print form and the
 * pipeline know 11x17 as "11x17" (a Windows queue may say "tabloid"), but a profile typed as "ledger" (the same sheet,
 * 11x17 in the printer's own words; seen on the live Kyocera profile 2026-11-16) was not recognised, so the form hid the
 * size choice and a booklet could not use 11x17. One place that adds the missing spelling, keeping the original too.
 */
const ELEVEN_BY_SEVENTEEN = new Set(["11x17", "tabloid", "ledger"]);

export function withSizeAliases(declared: readonly string[]): string[] {
  const out = [...declared];
  if (out.some((s) => ELEVEN_BY_SEVENTEEN.has(s.trim().toLowerCase())) && !out.includes("11x17")) out.push("11x17");
  return out;
}
