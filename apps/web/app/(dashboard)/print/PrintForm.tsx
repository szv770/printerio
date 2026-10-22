"use client";

import { useActionState, useEffect, useRef, useState, startTransition } from "react";
import { AlertTriangle, Minus, Plus, Printer } from "lucide-react";
import { parsePageRange } from "@printio/shared";
import { Button, Input, Select, FieldLabel, FormError, Card, Segmented } from "@/components/ui";
import { formatFileSize, precheckPdfHeader, precheckSelectedFile, shouldPreviewInBrowser } from "@/lib/pdf/client-precheck";
import { renderPdfPageToCanvas } from "@/lib/pdf/render-page";
import {
  MAX_COPIES,
  buildSummary,
  describeAvailability,
  type BookletChoice,
  type SidesChoice,
  type StapleChoice,
} from "@/lib/print-choices";
import { submitPrintJobAction, type SubmitJobState } from "./actions";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialSubmitJobState: SubmitJobState = {};

interface PrinterOption {
  id: string;
  /** What a member sees. For a raw-port printer this is just the printer's name. */
  label: string;
  description: string | null;
  /** True when the printer prints on the raw port: colour and paper size are hidden (unverified) and the server derives them. */
  isRaw: boolean;
  declaredPaperSizes: string[];
  declaredCapabilities: { duplex: boolean; color: boolean; staple: boolean; booklet: boolean; punch: boolean };
  printerOnline: boolean;
}

const THUMBNAIL_MAX_WIDTH_PX = 200;
const STORAGE_KEY = "printio.print-choices.v1";

interface SavedChoices {
  profileId?: string;
  sides?: SidesChoice;
  staple?: StapleChoice;
  booklet?: BookletChoice;
  copies?: number;
  colorMode?: "bw" | "color";
  paperSize?: string;
  punch?: boolean;
}

/** Remembered choices are a convenience only: any failure (private window, blocked storage, junk) means "no memory". */
function readSavedChoices(): SavedChoices {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: SavedChoices = {};
    if (typeof v.profileId === "string") out.profileId = v.profileId;
    if (v.sides === "one" || v.sides === "two") out.sides = v.sides;
    if (v.staple === "none" || v.staple === "top-left" || v.staple === "top-right") out.staple = v.staple;
    if (v.booklet === "none" || v.booklet === "left" || v.booklet === "right") out.booklet = v.booklet;
    if (typeof v.copies === "number" && Number.isInteger(v.copies) && v.copies >= 1 && v.copies <= MAX_COPIES) out.copies = v.copies;
    if (v.colorMode === "bw" || v.colorMode === "color") out.colorMode = v.colorMode;
    if (typeof v.paperSize === "string") out.paperSize = v.paperSize;
    if (typeof v.punch === "boolean") out.punch = v.punch;
    return out;
  } catch {
    return {};
  }
}

function writeSavedChoices(c: SavedChoices) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* storage unavailable - the form just will not remember */
  }
}

function clampCopies(n: number): number {
  return Math.min(MAX_COPIES, Math.max(1, n));
}

/**
 * The upload page. Plain choices (sides, staple, booklet, copies, page range) instead of printer-profile names;
 * what each choice means for the selected printer is decided by lib/print-choices.ts, which the server action
 * runs again as the authority. The summary is an estimate: the server recomputes the page count, print math and
 * the approval decision after submitting and the member lands on the job's status page.
 *
 * Every visible control must do something: colour and paper size are only shown for printers that honour them
 * (Windows-queue printers); a raw-port printer's colour/paper settings are unverified, so they are hidden.
 */
export function PrintForm({
  printerProfiles,
  maxUploadBytes,
}: {
  printerProfiles: PrinterOption[];
  /** organization_settings.max_upload_size_bytes, forwarded only so the file picker can reject an oversized file
   *  instantly. Advisory: print/actions.ts re-reads the same setting server-side and is the real gate. */
  maxUploadBytes: number;
}) {
  const [state, formAction, pending] = useActionState(submitPrintJobAction, initialSubmitJobState);

  const [profileId, setProfileId] = useState(printerProfiles[0]?.id ?? "");
  const [estimatedPages, setEstimatedPages] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSizeLabel, setFileSizeLabel] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [thumbnailReady, setThumbnailReady] = useState(false);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  /** Set when a file is too large to parse/render safely in the browser (see shouldPreviewInBrowser) - the upload itself is unaffected. */
  const [previewSkipped, setPreviewSkipped] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bookletConfirmRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  /** True only while the member's explicit click on "Add blank pages & print" is submitting the form. */
  const confirmingRef = useRef(false);
  /** Bumped whenever a different file is picked, so the booklet prompt below cannot outlive the file it asked about. */
  const [fileVersion, setFileVersion] = useState(0);
  /** What the form looked like when the server last asked the padding question (null = not asked / cleared). */
  const [askedSignature, setAskedSignature] = useState<string | null>(null);
  /** The server response whose booklet prompt the member cancelled - that response's prompt stays hidden. */
  const [dismissedState, setDismissedState] = useState<SubmitJobState | null>(null);
  /** Set by a refused submit (Enter pressed while the form is invalid); cleared by the next valid submit. */
  const [clientError, setClientError] = useState<string | null>(null);

  const [sides, setSides] = useState<SidesChoice>("two");
  const [staple, setStaple] = useState<StapleChoice>("none");
  const [booklet, setBooklet] = useState<BookletChoice>("none");
  const [copiesText, setCopiesText] = useState("1");
  const [pageRange, setPageRange] = useState("");
  const [colorMode, setColorMode] = useState<"bw" | "color">("bw");
  const [paperSize, setPaperSize] = useState("letter");
  const [punch, setPunch] = useState(false);
  /** False until the remembered choices have been read, so the first render never overwrites them. */
  const [restored, setRestored] = useState(false);

  const profile = printerProfiles.find((p) => p.id === profileId) ?? printerProfiles[0];
  const hasPrinters = printerProfiles.length > 0;
  const isRaw = profile?.isRaw ?? false;
  // With no printer at all the form is a preview only (Submit is disabled), so nothing is greyed out.
  const caps = profile?.declaredCapabilities ?? { duplex: true, color: true, staple: true, booklet: true, punch: true };

  // Restore the member's last choices after mount (never during the first render: it would not match the
  // server-rendered HTML). A timer rather than a direct setState keeps this out of the render/commit cascade.
  useEffect(() => {
    const t = setTimeout(() => {
      const saved = readSavedChoices();
      if (saved.profileId && printerProfiles.some((p) => p.id === saved.profileId)) setProfileId(saved.profileId);
      if (saved.sides) setSides(saved.sides);
      if (saved.staple) setStaple(saved.staple);
      if (saved.booklet) setBooklet(saved.booklet);
      if (saved.copies) setCopiesText(String(saved.copies));
      if (saved.colorMode) setColorMode(saved.colorMode);
      if (saved.paperSize) setPaperSize(saved.paperSize);
      if (typeof saved.punch === "boolean") setPunch(saved.punch);
      setRestored(true);
    }, 0);
    return () => clearTimeout(t);
    // Runs once; the printer list does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copiesNumber = /^\d+$/.test(copiesText.trim()) ? parseInt(copiesText, 10) : NaN;
  const copiesValid = Number.isInteger(copiesNumber) && copiesNumber >= 1 && copiesNumber <= MAX_COPIES;
  const copies = copiesValid ? copiesNumber : 1;

  useEffect(() => {
    if (!restored) return;
    writeSavedChoices({ profileId, sides, staple, booklet, copies, colorMode, paperSize, punch });
  }, [restored, profileId, sides, staple, booklet, copies, colorMode, paperSize, punch]);

  /**
   * What the form will actually submit, given what the selected printer can do. The raw picks stay in state, so
   * switching back to a printer that supports an option restores it; but what is shown and sent is always the
   * effective value, so the page never shows something it will not do.
   */
  const exclusive = isRaw; // only a raw-port printer cannot combine a booklet with a corner staple
  const effBooklet: BookletChoice = describeAvailability({ staple, booklet }, caps, { exclusive }).bookletDisabledReason ? "none" : booklet;
  const effStaple: StapleChoice = describeAvailability({ staple, booklet: effBooklet }, caps, { exclusive }).stapleDisabledReason
    ? "none"
    : isRaw
      ? staple
      : staple === "none"
        ? "none"
        : "top-left";
  const avail = describeAvailability({ staple: effStaple, booklet: effBooklet }, caps, { exclusive });
  const effSides: SidesChoice = avail.sidesLocked ? "two" : caps.duplex ? sides : "one";

  // The page range, checked as far as the browser can (the server checks it again against the real document).
  const rangeText = pageRange.trim();
  const rangeCheck = rangeText && estimatedPages ? parsePageRange(rangeText, estimatedPages) : null;
  const rangeError = (rangeCheck && !rangeCheck.ok ? rangeCheck.reason : null) ?? state.fieldErrors?.pageRange ?? null;
  const selectedPages = rangeCheck?.ok ? rangeCheck.pages.length : rangeText && !estimatedPages ? null : estimatedPages;
  const summary = buildSummary({ pages: selectedPages, copies, sides: effSides, staple: effStaple, booklet: effBooklet });

  // The padding question belongs to one exact set of choices. Server action state is never cleared, so the prompt
  // only shows while the form still matches what was submitted and the member has not cancelled that answer.
  const formSignature = JSON.stringify([fileVersion, profileId, effBooklet, effSides, effStaple, copiesText.trim(), rangeText]);
  const needsBookletConfirm =
    state.needsBookletConfirm && askedSignature === formSignature && dismissedState !== state ? state.needsBookletConfirm : undefined;
  const serverError = state.error && state.error !== state.fieldErrors?.pageRange ? state.error : null;

  // The booklet padding question replaces the Submit button. On a phone the button the user just tapped is at
  // the bottom of the viewport and the question appears above it, so without this it reads as "nothing happened".
  useEffect(() => {
    if (needsBookletConfirm) bookletConfirmRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [needsBookletConfirm]);

  /** Clears the picked file and explains why, so the user can't sit through a slow upload of something the server was always going to reject. */
  function rejectSelectedFile(input: HTMLInputElement, reason: string) {
    input.value = "";
    setFileName(null);
    setFileSizeLabel(null);
    setEstimatedPages(null);
    setThumbnailReady(false);
    setPreviewSkipped(false);
    setFileError(reason);
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    setFileVersion((v) => v + 1);
    setEstimatedPages(null);
    setFileError(null);
    setFileName(file?.name ?? null);
    setFileSizeLabel(file ? formatFileSize(file.size) : null);
    setThumbnailReady(false);
    setPreviewSkipped(false);
    if (!file) return;

    // Advisory only - lib/pdf/preflight.ts re-runs all of this server-side on the real bytes and stays the only
    // source of truth. The point is that an empty/oversized/non-PDF file is knowable the instant it's picked.
    const metaCheck = precheckSelectedFile(file, maxUploadBytes);
    if (!metaCheck.ok) {
      rejectSelectedFile(input, metaCheck.reason);
      return;
    }

    // Everything below reads the whole file into the tab and parses it twice (pdf-lib for the page count,
    // pdfjs-dist for the thumbnail). Over the threshold, skip all of it - the upload and the server's own
    // preflight are unaffected.
    if (!shouldPreviewInBrowser(file.size)) {
      setPreviewSkipped(true);
      return;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      return; // can't read it here - let the server have the final say
    }

    const headerCheck = precheckPdfHeader(new Uint8Array(bytes.slice(0, 5)));
    if (!headerCheck.ok) {
      rejectSelectedFile(input, headerCheck.reason);
      return;
    }

    try {
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      setEstimatedPages(doc.getPageCount());
      // Attachments/JavaScript are not rejected: the server strips them (lib/pdf/sanitize.ts) before printing.
    } catch {
      setEstimatedPages(null); // not a fatal UI error - server preflight is authoritative anyway
    }

    if (canvasRef.current) {
      setThumbnailLoading(true);
      const ok = await renderPdfPageToCanvas(bytes, canvasRef.current, { maxWidthPx: THUMBNAIL_MAX_WIDTH_PX });
      setThumbnailLoading(false);
      setThumbnailReady(ok);
    }
  }

  const canSubmit = hasPrinters && !rangeError && copiesValid && !fileError;

  /**
   * Submitted by hand (not `<form action>`): React 19 resets an uncontrolled form after an action finishes,
   * which would empty the file picker whenever the server answers with an error or the booklet-padding question,
   * and "your file is still selected" would not be true. No submitter is read: confirmBookletPadding is added
   * only when the member explicitly clicked the confirm button (confirmingRef), never because Enter in a text
   * field happened to activate some submit button.
   */
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (!canSubmit) {
      // The inline messages (copies, pages, file) are already on screen; this covers what has no field of its own.
      setClientError(
        !hasPrinters
          ? "No printer is connected yet."
          : fileError
            ? fileError
            : !copiesValid
              ? `Enter a number of copies from 1 to ${MAX_COPIES}.`
              : (rangeError ?? "Check the highlighted fields and try again."),
      );
      return;
    }
    setClientError(null);
    const data = new FormData(e.currentTarget);
    if (confirmingRef.current && needsBookletConfirm) data.set("confirmBookletPadding", "true");
    setAskedSignature(formSignature);
    startTransition(() => formAction(data));
  }

  function confirmBookletPadding() {
    confirmingRef.current = true;
    try {
      formRef.current?.requestSubmit();
    } finally {
      confirmingRef.current = false;
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5">
      <Card className="flex flex-col gap-3">
        <FieldLabel htmlFor="file">Document</FieldLabel>
        <div className="flex items-start gap-4" data-tour="print-file-picker">
          <input
            id="file"
            type="file"
            name="file"
            accept="application/pdf"
            required
            onChange={onFileChange}
            className="block w-full min-w-0 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-lg file:border-0 file:bg-[var(--color-primary)] file:px-4 file:py-2 file:text-sm file:font-medium file:text-[var(--color-primary-fg)]"
          />
          {/* Canvas always mounted (just hidden when empty) so its ref is available the moment a file is chosen - no
           *  render-order race with the async thumbnail draw. */}
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
        {fileError && <p className="text-sm text-[var(--color-danger)]">{fileError}</p>}
        {!fileError && estimatedPages !== null && (
          <p className="text-xs text-[var(--color-muted)]">
            {estimatedPages} {estimatedPages === 1 ? "page" : "pages"}
            {fileSizeLabel ? ` · ${fileSizeLabel}` : ""}
          </p>
        )}
        {!fileError && previewSkipped && (
          <p className="text-xs text-[var(--color-muted)]">
            {fileSizeLabel ? `${fileSizeLabel} · ` : ""}too large to preview here - it will still upload and print
            normally, and the page count is confirmed after you submit.
          </p>
        )}
      </Card>

      {/* Always rendered (the tour points at it), but it only asks for a choice when there is one to make. */}
      <fieldset className="flex flex-col gap-2" data-tour="print-printer-fieldset">
        <legend className="mb-1 text-sm font-medium">Printer</legend>
        {!hasPrinters && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
            <span>
              No printer is connected yet. You can still pick a file and set everything up below - printing isn&apos;t
              possible until an administrator adds one under Admin &rarr; Printers.
            </span>
          </div>
        )}
        {printerProfiles.length === 1 && profile && (
          <>
            <input type="hidden" name="printerProfileId" value={profile.id} />
            <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
              <Printer className="h-5 w-5 shrink-0 text-[var(--color-muted)]" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{profile.label}</span>
                {profile.description && <span className="text-xs text-[var(--color-muted)]">{profile.description}</span>}
              </span>
              <span className={`ml-auto shrink-0 text-xs ${profile.printerOnline ? "text-[var(--color-success)]" : "text-[var(--color-muted)]"}`}>
                {profile.printerOnline ? "Ready" : "Offline"}
              </span>
            </div>
          </>
        )}
        {printerProfiles.length > 1 &&
          printerProfiles.map((p) => (
            <label
              key={p.id}
              className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${
                profile?.id === p.id ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-[var(--color-border)]"
              }`}
            >
              <input
                type="radio"
                name="printerProfileId"
                value={p.id}
                checked={profile?.id === p.id}
                onChange={() => setProfileId(p.id)}
                className="mt-0.5"
              />
              <span className="flex flex-col">
                <span className="font-medium">
                  {p.label}
                  {!p.printerOnline ? " (offline)" : ""}
                </span>
                {p.description && <span className="text-xs text-[var(--color-muted)]">{p.description}</span>}
              </span>
            </label>
          ))}
      </fieldset>

      <Card className="flex flex-col gap-5" data-tour="print-options">
        <Segmented<SidesChoice>
          name="sides"
          label="Sides"
          value={effSides}
          onChange={setSides}
          options={[
            { value: "one", label: "Single-sided", disabledReason: avail.sidesLocked ? "A booklet is always double-sided." : null },
            { value: "two", label: "Double-sided", disabledReason: caps.duplex ? null : "This printer can't print double-sided." },
          ]}
          hint={avail.sidesLocked ? "A booklet is always double-sided." : !caps.duplex ? "This printer prints single-sided only." : undefined}
        />

        <Segmented<StapleChoice>
          name="staple"
          label="Staple"
          value={effStaple}
          onChange={setStaple}
          disabled={!!avail.stapleDisabledReason}
          options={
            isRaw
              ? [
                  { value: "none", label: "None" },
                  { value: "top-left", label: "Top-left" },
                  { value: "top-right", label: "Top-right" },
                ]
              : [
                  { value: "none", label: "None" },
                  { value: "top-left", label: "Staple" },
                ]
          }
          hint={avail.stapleDisabledReason ?? undefined}
        />

        <Segmented<BookletChoice>
          name="booklet"
          label="Booklet"
          value={effBooklet}
          onChange={setBooklet}
          disabled={!!avail.bookletDisabledReason}
          options={[
            { value: "none", label: "None" },
            { value: "left", label: "Left edge" },
            { value: "right", label: "Right edge" },
          ]}
          hint={
            avail.bookletDisabledReason ??
            (effBooklet === "none"
              ? "Folds and staples the pages into a booklet. Left edge reads left-to-right; right edge is for right-to-left languages such as Hebrew."
              : effBooklet === "left"
                ? "Bound on the left edge, like an English book."
                : "Bound on the right edge, like a Hebrew book.")
          }
        />

        {!isRaw && (
          <>
            <Segmented<"bw" | "color">
              name="colorMode"
              label="Colour"
              value={caps.color ? colorMode : "bw"}
              onChange={setColorMode}
              options={[
                { value: "bw", label: "Black & white" },
                { value: "color", label: "Colour", disabledReason: caps.color ? null : "This printer can't print in colour." },
              ]}
            />
            <div>
              <FieldLabel htmlFor="paperSize">Paper size</FieldLabel>
              <Select
                id="paperSize"
                name="paperSize"
                value={profile?.declaredPaperSizes.includes(paperSize) ? paperSize : (profile?.declaredPaperSizes[0] ?? "letter")}
                onChange={(e) => setPaperSize(e.target.value)}
                className="min-h-11"
              >
                {(profile?.declaredPaperSizes.length ? profile.declaredPaperSizes : ["letter"]).map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </div>
            {caps.punch && (
              <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
                <input type="checkbox" name="punch" checked={punch} onChange={(e) => setPunch(e.target.checked)} className="h-5 w-5" />
                Hole punch
              </label>
            )}
          </>
        )}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="copies">Copies</FieldLabel>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                aria-label="Fewer copies"
                disabled={!copiesValid || copies <= 1}
                onClick={() => setCopiesText(String(clampCopies(copies - 1)))}
                className="flex min-h-11 w-11 items-center justify-center rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Minus className="h-4 w-4" />
              </button>
              <Input
                id="copies"
                name="copies"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={copiesText}
                aria-invalid={!copiesValid}
                aria-describedby={copiesValid ? undefined : "copies-error"}
                onChange={(e) => setCopiesText(e.target.value)}
                onBlur={() => copiesValid && setCopiesText(String(copies))}
                className="min-h-11 text-center"
              />
              <button
                type="button"
                aria-label="More copies"
                disabled={copiesValid && copies >= MAX_COPIES}
                onClick={() => setCopiesText(String(clampCopies(copies + 1)))}
                className="flex min-h-11 w-11 items-center justify-center rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            {!copiesValid && (
              <p id="copies-error" className="mt-1.5 text-xs text-[var(--color-danger)]">
                Enter a number from 1 to {MAX_COPIES}.
              </p>
            )}
          </div>

          <div>
            <FieldLabel htmlFor="pageRange" hint="(optional)">
              Pages
            </FieldLabel>
            <Input
              id="pageRange"
              name="pageRange"
              type="text"
              autoComplete="off"
              placeholder="All pages, or e.g. 1-5, 8"
              value={pageRange}
              aria-invalid={!!rangeError}
              aria-describedby={rangeError ? "pageRange-error" : undefined}
              onChange={(e) => setPageRange(e.target.value)}
              className="min-h-11"
            />
            {rangeError ? (
              <p id="pageRange-error" className="mt-1.5 text-xs text-[var(--color-danger)]">
                {rangeError}
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-[var(--color-muted)]">Leave empty to print the whole document.</p>
            )}
          </div>
        </div>
      </Card>

      {/* Summary + submit stay in view at the bottom of a phone screen while the options above are changed. */}
      <div className="sticky bottom-3 z-10 flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-4 shadow-lg backdrop-blur">
        <div aria-live="polite">
          {summary ? (
            <>
              <p className="text-2xl font-semibold leading-tight">
                {summary.sheets} {summary.sheets === 1 ? "sheet" : "sheets"}
              </p>
              <p className="mt-0.5 text-sm text-[var(--color-muted)]">{summary.text}</p>
              {summary.blankPagesAdded > 0 && (
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  Includes {summary.blankPagesAdded} blank {summary.blankPagesAdded === 1 ? "page" : "pages"} to fill the booklet.
                </p>
              )}
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Final page count and any approval needed are confirmed after you submit.
              </p>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">
              {rangeText && !estimatedPages
                ? "The page count is confirmed after you submit."
                : "Choose a document to see how many sheets this will use."}
            </p>
          )}
        </div>

        {needsBookletConfirm && (
          <div ref={bookletConfirmRef} className="rounded-lg border border-[var(--color-warning)] bg-yellow-50 p-3 text-sm">
            <p className="font-medium">
              {needsBookletConfirm.sourcePages} {needsBookletConfirm.sourcePages === 1 ? "page" : "pages"} to print. A booklet needs a multiple of 4.
            </p>
            <p className="mt-1">
              Add {needsBookletConfirm.blankPagesAdded} blank {needsBookletConfirm.blankPagesAdded === 1 ? "page" : "pages"} to make {needsBookletConfirm.paddedPages}?
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => {
                  setBooklet("none");
                  setDismissedState(state);
                }}>
                Cancel booklet
              </Button>
              {/* type="button": only this click (via confirmBookletPadding) ever sends confirmBookletPadding=true.
                  Enter in Copies/Pages submits nothing while this question is open (no submit button exists).
                  `pending` matters because this re-uploads the whole file: a double-tap would otherwise print the
                  booklet twice. */}
              <Button type="button" size="sm" pending={pending} pendingLabel="Submitting..." onClick={confirmBookletPadding}>
                Add blank pages &amp; print
              </Button>
            </div>
            <p className="mt-2 text-xs text-[var(--color-muted)]">Your file is still selected - confirming re-sends it with the blank pages added.</p>
          </div>
        )}

        <FormError message={clientError ?? serverError} />

        {!needsBookletConfirm && (
          <Button
            type="submit"
            data-tour="print-submit-button"
            pending={pending}
            pendingLabel="Sending..."
            disabled={!canSubmit}
            className="w-full min-h-12"
            title={hasPrinters ? undefined : "No printer is connected yet - see the notice above."}
          >
            Print
          </Button>
        )}
      </div>
    </form>
  );
}
