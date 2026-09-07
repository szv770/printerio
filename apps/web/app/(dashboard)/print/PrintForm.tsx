"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { computePrintMath } from "@printio/shared";
import { Button, Input, Select, FieldLabel, FormError, Card } from "@/components/ui";
import { PRINTER_PROFILE_ICON_COMPONENTS, type PrinterProfileIconKey } from "@/lib/printer-profile-icons";
import { submitPrintJobAction, initialSubmitJobState } from "./actions";

interface PrinterProfileOption {
  id: string;
  label: string;
  /** Admin-written blurb (printer_profiles.description) - shown under the
   *  label so a user picks a profile by what it does, not a cryptic internal
   *  label. Null if the admin never set one. */
  description: string | null;
  /** printer_profiles.icon_key - one of PRINTER_PROFILE_ICON_KEYS, or null. */
  iconKey: string | null;
  declaredPaperSizes: string[];
  declaredCapabilities: { duplex: boolean; color: boolean; staple: boolean; booklet: boolean; punch: boolean };
  /** This profile's own stored booklet_binding_side default (only meaningful
   *  when declaredCapabilities.booklet is true) - prefills the per-job
   *  override below rather than always showing "left". */
  bookletBindingSide: "left" | "right";
  printerOnline: boolean;
}

const THUMBNAIL_MAX_WIDTH_PX = 200;

/**
 * Renders page 1 of a locally-selected PDF onto a canvas, entirely
 * client-side (pdfjs-dist) - no upload/server round trip needed just to show
 * the user what they're about to print. Dynamically imported so pdfjs-dist's
 * ~1MB never ends up in the initial page bundle for users who haven't picked
 * a file yet. Swallows its own errors (malformed/encrypted PDF, worker load
 * failure) - the thumbnail is a nicety, never a blocker; the server's own
 * preflight (lib/pdf/preflight.ts) is the authoritative validation either way.
 */
async function renderFirstPageThumbnail(file: File, canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

    const bytes = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const scale = THUMBNAIL_MAX_WIDTH_PX / unscaledViewport.width;
    const viewport = page.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) return false;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return true;
  } catch {
    return false;
  }
}

/**
 * V1 scope note: this form shows a LIVE, CLIENT-COMPUTED estimate (page count
 * via a best-effort in-browser PDF parse, sides/sheets via the same pure
 * @printio/shared math used server-side) so the user sees an immediate
 * summary while choosing options - matching the spec's print-submission
 * wireframe. It is explicitly NOT the authoritative policy decision: the
 * frontend never claims "approved"/"requires approval" itself. The real,
 * server-computed page count, print math, and policy decision are only ever
 * produced by submitPrintJobAction, and the user is taken straight to the job
 * status page to see that authoritative result immediately after submitting.
 *
 * Layout groups every "how this prints" decision (printer, color, duplex,
 * finishing) into one section, since they're really one decision the user is
 * making, not four unrelated ones - copies/paper size are a separate, lower-
 * priority section below.
 */
export function PrintForm({ printerProfiles }: { printerProfiles: PrinterProfileOption[] }) {
  const [state, formAction, pending] = useActionState(submitPrintJobAction, initialSubmitJobState);

  const [profileId, setProfileId] = useState(printerProfiles[0]?.id ?? "");
  const [estimatedPages, setEstimatedPages] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [thumbnailReady, setThumbnailReady] = useState(false);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copies, setCopies] = useState(1);
  const [colorMode, setColorMode] = useState<"bw" | "color">("bw");
  const [duplex, setDuplex] = useState(true);
  const [paperSize, setPaperSize] = useState("letter");
  const [staple, setStaple] = useState(false);
  const [booklet, setBooklet] = useState(false);
  const [punch, setPunch] = useState(false);
  // null = "use the selected profile's own default" (bookletBindingSide
  // below resolves it); set explicitly once the user touches the override
  // control. Reset to null whenever the profile changes so switching
  // printers re-derives from the newly-selected profile's own default
  // rather than carrying over a stale explicit choice.
  const [bindingSideOverride, setBindingSideOverride] = useState<"left" | "right" | null>(null);

  const profile = printerProfiles.find((p) => p.id === profileId);
  const bookletBindingSide = bindingSideOverride ?? profile?.bookletBindingSide ?? "left";

  function onProfileChange(id: string) {
    setProfileId(id);
    setBindingSideOverride(null);
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setEstimatedPages(null);
    setFileName(file?.name ?? null);
    setThumbnailReady(false);
    if (!file) return;

    try {
      const { PDFDocument } = await import("pdf-lib");
      const bytes = await file.arrayBuffer();
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      setEstimatedPages(doc.getPageCount());
    } catch {
      setEstimatedPages(null); // not a fatal UI error - server preflight is authoritative anyway
    }

    if (canvasRef.current) {
      setThumbnailLoading(true);
      const ok = await renderFirstPageThumbnail(file, canvasRef.current);
      setThumbnailLoading(false);
      setThumbnailReady(ok);
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
  const anyFinishingDisabled =
    !profile?.declaredCapabilities.duplex ||
    !profile?.declaredCapabilities.color ||
    !profile?.declaredCapabilities.staple ||
    !profile?.declaredCapabilities.booklet ||
    !profile?.declaredCapabilities.punch;

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div>
        <FieldLabel htmlFor="file">Document</FieldLabel>
        <div className="flex items-start gap-4" data-tour="print-file-picker">
          <input
            id="file"
            type="file"
            name="file"
            accept="application/pdf"
            required
            onChange={onFileChange}
            className="block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
          />
          {/* Canvas always mounted (just hidden when empty) so its ref is
           *  available the moment a file is chosen - no render-order race
           *  with the async thumbnail draw. */}
          <div
            className="flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-gray-50"
            data-tour="print-preview"
            hidden={!fileName}
          >
            {thumbnailLoading && <span className="text-xs text-[var(--color-muted)]">…</span>}
            <canvas ref={canvasRef} className="max-h-full max-w-full" hidden={!thumbnailReady} />
            {!thumbnailLoading && !thumbnailReady && fileName && (
              <span className="px-1 text-center text-[10px] text-[var(--color-muted)]">No preview</span>
            )}
          </div>
        </div>
        {estimatedPages !== null && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">Estimated {estimatedPages} page(s).</p>
        )}
      </div>

      <Card>
        <p className="mb-3 text-sm font-medium">How it prints</p>
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2" data-tour="print-printer-fieldset">
            <legend className="mb-1 text-sm font-medium">Printer</legend>
            {/* Icon + description shown per option (not a plain <select>) so a
             *  user picks a profile by what it actually does - duplex,
             *  color, booklet, etc. - rather than a cryptic internal label. */}
            {printerProfiles.map((p) => {
              const Icon = p.iconKey ? PRINTER_PROFILE_ICON_COMPONENTS[p.iconKey as PrinterProfileIconKey] : null;
              return (
                <label
                  key={p.id}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${
                    profileId === p.id ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-[var(--color-border)]"
                  }`}
                >
                  <input
                    type="radio"
                    name="printerProfileId"
                    value={p.id}
                    checked={profileId === p.id}
                    onChange={() => onProfileChange(p.id)}
                    className="mt-0.5"
                  />
                  {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {p.label}
                      {!p.printerOnline ? " (offline)" : ""}
                    </span>
                    {p.description && <span className="text-xs text-[var(--color-muted)]">{p.description}</span>}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Color</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="colorMode" value="bw" checked={colorMode === "bw"} onChange={() => setColorMode("bw")} />
              Black &amp; white
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="colorMode"
                value="color"
                checked={colorMode === "color"}
                onChange={() => setColorMode("color")}
                disabled={!profile?.declaredCapabilities.color}
              />
              Color
            </label>
          </fieldset>

          <div className="flex flex-col gap-2 text-sm">
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

          {profile?.declaredCapabilities.booklet && (
            <div>
              <FieldLabel
                htmlFor="bookletBindingSide"
                hint="most jobs should use the profile's own default - only change this for a one-off LTR/RTL exception"
              >
                Booklet binding side
              </FieldLabel>
              <Select
                id="bookletBindingSide"
                name="bookletBindingSide"
                value={bookletBindingSide}
                onChange={(e) => setBindingSideOverride(e.target.value === "right" ? "right" : "left")}
              >
                <option value="left">Left edge binding (LTR reading)</option>
                <option value="right">Right edge binding (RTL reading, e.g. Hebrew)</option>
              </Select>
            </div>
          )}

          {anyFinishingDisabled && (
            <p className="text-xs text-[var(--color-muted)]">
              Options shown greyed out aren&apos;t supported by the selected printer - choose a different printer above if you need them.
            </p>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <FieldLabel htmlFor="copies">Copies</FieldLabel>
          <Input
            id="copies"
            type="number"
            name="copies"
            min={1}
            max={99}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
        </div>
        <div>
          <FieldLabel htmlFor="paperSize">Paper size</FieldLabel>
          <Select id="paperSize" name="paperSize" value={paperSize} onChange={(e) => setPaperSize(e.target.value)}>
            {(profile?.declaredPaperSizes ?? ["letter"]).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {preview && (
        <Card className="text-sm">
          <p className="font-medium">Estimated usage</p>
          <p>{preview.printedSides} printed sides</p>
          <p>{preview.physicalSheets} physical sheets</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Final page count, print math, and approval decision are confirmed by the server after you submit.
          </p>
        </Card>
      )}

      {needsBookletConfirm && (
        <div className="rounded-lg border border-[var(--color-warning)] bg-yellow-50 p-4 text-sm">
          <p className="font-medium">
            This document has {needsBookletConfirm.sourcePages} pages. Booklet printing needs a multiple of 4.
          </p>
          <p className="mt-1">Add {needsBookletConfirm.blankPagesAdded} blank page(s) to make {needsBookletConfirm.paddedPages}?</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setBooklet(false)}>
              Cancel booklet
            </Button>
            {/* A submit button's own name/value is included in the FormData
                by native browser form semantics when it's the element that
                triggered submission - this is deliberately NOT done via React
                state, since a state update from onClick is not guaranteed to
                flush into the DOM before the browser reads form fields for
                the same-tick native submission. */}
            <Button type="submit" name="confirmBookletPadding" value="true" size="sm">
              Add blank pages &amp; submit
            </Button>
          </div>
        </div>
      )}

      <FormError message={state.error} />

      {!needsBookletConfirm && (
        <Button type="submit" data-tour="print-submit-button" pending={pending} pendingLabel="Submitting...">
          Submit Job
        </Button>
      )}
    </form>
  );
}
