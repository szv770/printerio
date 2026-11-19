"use client";

import { useState } from "react";
import { Button, Checkbox, FieldLabel, FormError, Input, Modal, Select } from "@/components/ui";
import { roleLabel } from "@/lib/role-label";
import { roleChoices } from "@/lib/admin/members";
import { MAX_SECTION_LENGTH, type BulkOp, type BulkResult } from "@/lib/admin/bulk-members";
import type { OrgRole } from "@printio/shared";

export type BulkMode = "role" | "section" | "on" | "off" | "remove";

const NEW_SECTION = "__new";
const NO_SECTION = "__none";

const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;

/** One dialog for every bulk action. It always says how many people it covers, and the button repeats the number. */
export function BulkDialog({
  mode,
  count,
  sections,
  onClose,
  onRun,
}: {
  mode: BulkMode | null;
  count: number;
  sections: string[] | null;
  onClose: () => void;
  onRun: (op: BulkOp) => Promise<BulkResult>;
}) {
  const [role, setRole] = useState<OrgRole>("staff");
  const [section, setSection] = useState<string>("");
  const [newSection, setNewSection] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!mode) return null;
  const privileged = mode === "role" && (role === "org_admin" || role === "approver");
  const sectionValue = section === NEW_SECTION ? newSection.trim() : section === NO_SECTION ? null : section;
  const canRun = !busy && count > 0 && (!privileged || confirmed) && (mode !== "section" || section === NO_SECTION || !!sectionValue);

  const title =
    mode === "role" ? "Change role" : mode === "section" ? "Set section" : mode === "on" ? "Switch on" : mode === "off" ? "Switch off" : "Remove from this organization";
  const verb =
    mode === "role" ? "Change role for" : mode === "section" ? "Set section for" : mode === "on" ? "Switch on" : mode === "off" ? "Switch off" : "Remove";

  async function run() {
    setBusy(true);
    setError(null);
    const op: BulkOp =
      mode === "role"
        ? { type: "role", role, confirmPrivileged: privileged && confirmed }
        : mode === "section"
          ? { type: "section", section: sectionValue }
          : mode === "remove"
            ? { type: "remove" }
            : { type: "status", status: mode === "on" ? "active" : "disabled" };
    try {
      const res = await onRun(op);
      if (!res.ok) setError(res.message);
    } catch {
      setError("Couldn't save. Check your connection and try again.");
    }
    setBusy(false);
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={title}
      description={`${people(count)} selected`}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={mode === "remove" ? "danger" : "primary"} onClick={() => void run()} disabled={!canRun} pending={busy} pendingLabel="Saving...">
            {verb} {people(count)}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        {mode === "role" && (
          <>
            <div>
              <FieldLabel htmlFor="bulk-role">New role</FieldLabel>
              <Select id="bulk-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
                {roleChoices().map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            {privileged && (
              <Checkbox
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                label={`I want to give the ${roleLabel(role)} role to ${people(count)}`}
                description={role === "org_admin" ? "Admins can change every setting and every person." : "Approvers can see everyone and approve print jobs."}
              />
            )}
          </>
        )}

        {mode === "section" && (
          <>
            <div>
              <FieldLabel htmlFor="bulk-section">Section</FieldLabel>
              <Select id="bulk-section" value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">Choose a section...</option>
                {(sections ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value={NEW_SECTION}>New section...</option>
                <option value={NO_SECTION}>No section</option>
              </Select>
              {sections === null && <p className="mt-1 text-[13px] text-[var(--color-muted)]">Loading your sections...</p>}
            </div>
            {section === NEW_SECTION && (
              <div>
                <FieldLabel htmlFor="bulk-new-section">New section name</FieldLabel>
                <Input id="bulk-new-section" value={newSection} maxLength={MAX_SECTION_LENGTH} onChange={(e) => setNewSection(e.target.value)} placeholder="Science" />
              </div>
            )}
            <p className="rounded-[var(--radius-control)] bg-[var(--color-surface-2)] p-3 text-[13px] text-[var(--color-text-2)]">
              Print rules and monthly limits match a section by its exact name. Moving people to a different section can change which rules and limits apply to them.
            </p>
          </>
        )}

        {mode === "off" && (
          <p className="text-[var(--color-text-2)]">
            They will not be able to sign in or print, and their waiting print jobs are cancelled. Their accounts and history stay, and you can switch them back on.
          </p>
        )}
        {mode === "on" && <p className="text-[var(--color-text-2)]">They will be able to sign in and print again.</p>}
        {mode === "remove" && (
          <p className="text-[var(--color-text-2)]">
            They lose access to this organization and their waiting print jobs are cancelled. Their accounts are not deleted, and they can be invited again later.
          </p>
        )}
        <FormError message={error} />
      </div>
    </Modal>
  );
}
