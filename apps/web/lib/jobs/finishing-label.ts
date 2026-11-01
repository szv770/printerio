/** Plain words for what was asked for, from the per-job fields (older jobs have no corner / side stored). */
export function finishingLabel(job: { finishing: unknown; staple_position: string | null; booklet_binding_side: string | null }): string {
  const f = job.finishing as { staple?: boolean; booklet?: boolean; punch?: boolean; stapleStyle?: string } | null;
  const parts: string[] = [];
  if (f?.booklet) parts.push(job.booklet_binding_side ? `Booklet, bound on the ${job.booklet_binding_side}` : "Booklet");
  if (f?.staple) parts.push(f.stapleStyle === "dual-left" ? "Two staples, left" : job.staple_position ? `Stapled ${job.staple_position}` : "Stapled");
  if (f?.punch) parts.push("Hole punch");
  return parts.length > 0 ? parts.join(", ") : "None";
}
