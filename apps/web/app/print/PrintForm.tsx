"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { computePrintMath } from "@printos/shared";
import { submitPrintJobAction, initialSubmitJobState } from "./actions";

interface PrinterProfileOption {
  id: string;
  label: string;
  declaredPaperSizes: string[];
  declaredCapabilities: { duplex: boolean; color: boolean; staple: boolean; booklet: boolean; punch: boolean };
  printerOnline: boolean;
}

/**
 * V1 scope note: this form shows a LIVE, CLIENT-COMPUTED estimate (page count
 * via a best-effort in-browser PDF parse, sides/sheets via the same pure
 * @printos/shared math used server-side) so the user sees an immediate
 * summary while choosing options - matching the spec's print-submission
 * wireframe. It is explicitly NOT the authoritative policy decision: the
 * frontend never claims "approved"/"requires approval" itself. The real,
 * server-computed page count, print math, and policy decision are only ever
 * produced by submitPrintJobAction, and the user is taken straight to the job
 * status page to see that authoritative result immediately after submitting.
 */
export function PrintForm({ printerProfiles }: { printerProfiles: PrinterProfileOption[] }) {
  const [state, formAction, pending] = useActionState(submitPrintJobAction, initialSubmitJobState);
  const formRef = useRef<HTMLFormElement>(null);

  const [profileId, setProfileId] = useState(printerProfiles[0]?.id ?? "");
  const [estimatedPages, setEstimatedPages] = useState<number | null>(null);
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<"bw" | "color">("bw");
  const [duplex, setDuplex] = useState(true);
  const [paperSize, setPaperSize] = useState("letter");
  const [staple, setStaple] = useState(false);
  const [booklet, setBooklet] = useState(false);
  const [punch, setPunch] = useState(false);

  const profile = printerProfiles.find((p) => p.id === profileId);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setEstimatedPages(null);
    if (!file) return;
    try {
      const { PDFDocument } = await import("pdf-lib");
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      setEstimatedPages(doc.getPageCount());
    } catch {
      setEstimatedPages(null); // not a fatal UI error - server preflight is authoritative anyway
    }
  }

  const preview = useMemo(() => {
    if (!estimatedPages || estimatedPages <= 0) return null;
    try {
      return computePrintMath({ pageCount: estimatedPages, copies, duplex, booklet });
    } catch {
      return null;
    }
  }, [estimatedPages, copies, duplex, booklet]);

  const needsBookletConfirm = state.needsBookletConfirm;

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-6">
      <div>
        <label className="mb-1 block text-sm font-medium">Document</label>
        <input
          type="file"
          name="file"
          accept="application/pdf"
          required
          onChange={onFileChange}
          className="block w-full rounded-lg border border-[var(--color-border)] p-3"
        />
        {estimatedPages !== null && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">Estimated {estimatedPages} page(s).</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Printer</label>
        <select
          name="printerProfileId"
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className="block w-full rounded-lg border border-[var(--color-border)] p-3"
        >
          {printerProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {!p.printerOnline ? " (offline)" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Copies</label>
          <input
            type="number"
            name="copies"
            min={1}
            max={99}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="block w-full rounded-lg border border-[var(--color-border)] p-3"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Paper size</label>
          <select
            name="paperSize"
            value={paperSize}
            onChange={(e) => setPaperSize(e.target.value)}
            className="block w-full rounded-lg border border-[var(--color-border)] p-3"
          >
            {(profile?.declaredPaperSizes ?? ["letter"]).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Color</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="colorMode" value="bw" checked={colorMode === "bw"} onChange={() => setColorMode("bw")} />
          Black &amp; white
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="colorMode"
            value="color"
            checked={colorMode === "color"}
            onChange={() => setColorMode("color")}
            disabled={!profile?.declaredCapabilities.color}
          />
          Color {!profile?.declaredCapabilities.color && <span className="text-xs text-[var(--color-muted)]">(not available)</span>}
        </label>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="duplex" checked={duplex} onChange={(e) => setDuplex(e.target.checked)} disabled={!profile?.declaredCapabilities.duplex} />
          Double-sided (duplex)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="staple" checked={staple} onChange={(e) => setStaple(e.target.checked)} disabled={!profile?.declaredCapabilities.staple} />
          Staple
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="booklet" checked={booklet} onChange={(e) => setBooklet(e.target.checked)} disabled={!profile?.declaredCapabilities.booklet} />
          Booklet
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="punch" checked={punch} onChange={(e) => setPunch(e.target.checked)} disabled={!profile?.declaredCapabilities.punch} />
          Hole punch
        </label>
      </div>

      {preview && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
          <p className="font-medium">Estimated usage</p>
          <p>{preview.printedSides} printed sides</p>
          <p>{preview.physicalSheets} physical sheets</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Final page count, print math, and approval decision are confirmed by the server after you submit.
          </p>
        </div>
      )}

      {needsBookletConfirm && (
        <div className="rounded-lg border border-[var(--color-warning)] bg-yellow-50 p-4 text-sm">
          <p className="font-medium">
            This document has {needsBookletConfirm.sourcePages} pages. Booklet printing needs a multiple of 4.
          </p>
          <p className="mt-1">Add {needsBookletConfirm.blankPagesAdded} blank page(s) to make {needsBookletConfirm.paddedPages}?</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setBooklet(false)}
              className="rounded-lg border border-[var(--color-border)] px-4 py-2"
            >
              Cancel booklet
            </button>
            {/* A submit button's own name/value is included in the FormData
                by native browser form semantics when it's the element that
                triggered submission - this is deliberately NOT done via React
                state, since a state update from onClick is not guaranteed to
                flush into the DOM before the browser reads form fields for
                the same-tick native submission. */}
            <button
              type="submit"
              name="confirmBookletPadding"
              value="true"
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-[var(--color-primary-fg)]"
            >
              Add blank pages &amp; submit
            </button>
          </div>
        </div>
      )}

      {state.error && <p className="text-sm text-[var(--color-danger)]">{state.error}</p>}

      {!needsBookletConfirm && (
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--color-primary)] px-4 py-3 text-base font-medium text-[var(--color-primary-fg)] disabled:opacity-60"
        >
          {pending ? "Submitting..." : "Submit Job"}
        </button>
      )}
    </form>
  );
}
