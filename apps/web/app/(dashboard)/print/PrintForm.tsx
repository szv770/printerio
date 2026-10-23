"use client";

import { useActionState, useEffect, useRef, useState, startTransition } from "react";
import { AlertTriangle, FileText, FileUp, ListOrdered, Minus, Palette, Paperclip, Plus, Printer, SlidersHorizontal } from "lucide-react";
import { parsePageRange } from "@printio/shared";
import { Button, Card, Collapsible, FieldError, FieldLabel, FormError, Input, Segmented, Select, Spinner, StatusDot, Switch } from "@/components/ui";
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
import { liveSummaryLine, summarizeAdvanced, summarizeFinishing, summarizePages, summarizePaperColor } from "@/lib/print-form-summary";
import { submitPrintJobAction, type SubmitJobState } from "./actions";
import { createFileSnapshotCache, wrapSubmitAction } from "@/lib/print-submit";

// A "use server" file may only export async functions, so this trivial seed
// value for useActionState lives here instead of alongside the action.
const initialSubmitJobState: SubmitJobState = {};
// A failed call becomes a plain message (and keeps the blank-pages question open) instead of a silent failure.
const safeSubmitPrintJobAction = wrapSubmitAction(submitPrintJobAction);

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
  const [state, formAction, pending] = useActionState(safeSubmitPrintJobAction, initialSubmitJobState);

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
  /** In-memory copy of the picked file, taken on the first Print press so the answer to the blank-pages question
   *  re-sends it however long the member waits (the browser's handle on the disk file can go stale; lib/print-submit.ts). */
  const fileSnapshots = useRef(createFileSnapshotCache());
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
  /** Presentation only: whether the "Some pages" box is showing. The text in pageRange is still what is submitted. */
  const [pagesMode, setPagesMode] = useState<"all" | "range">("all");
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
    if (!needsBookletConfirm) return;
    const card = bookletConfirmRef.current;
    card?.scrollIntoView({ block: "start", behavior: "smooth" });
    card?.focus({ preventScroll: true });
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
    fileSnapshots.current.clear();
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
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
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
    const confirming = confirmingRef.current && !!needsBookletConfirm;
    const data = new FormData(e.currentTarget);
    if (confirming) data.set("confirmBookletPadding", "true");
    const picked = data.get("file");
    if (picked instanceof File && picked.size > 0) {
      try {
        data.set("file", await fileSnapshots.current.get(picked));
      } catch (err) {
        // Nothing was sent; the choices and the question stay exactly as they are.
        setClientError(err instanceof Error ? err.message : "Choose the file again, then press Print.");
        return;
      }
    }
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

  function resetChoices() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable - nothing to forget */
    }
    setSides("two");
    setStaple("none");
    setBooklet("none");
    setCopiesText("1");
    setColorMode("bw");
    setPaperSize("letter");
    setPunch(false);
  }

  const paperChoice = profile?.declaredPaperSizes.includes(paperSize) ? paperSize : (profile?.declaredPaperSizes[0] ?? "letter");
  const showPaperColor = !isRaw;
  const showPunch = !isRaw && caps.punch;
  const liveLine = liveSummaryLine({ pages: selectedPages, copies, sides: effSides, staple: effStaple, booklet: effBooklet });
  const barError = needsBookletConfirm ? null : (clientError ?? serverError);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      {needsBookletConfirm && (
        <div
          ref={bookletConfirmRef}
          tabIndex={-1}
          role="alertdialog"
          aria-labelledby="booklet-confirm-title"
          aria-describedby="booklet-confirm-body"
          className="scroll-mt-20 rounded-[var(--radius-card)] border-2 border-[var(--color-warning)] bg-[var(--color-warning-soft)] p-4 text-sm shadow-[var(--shadow-card)] outline-none focus-visible:shadow-[var(--ring)] sm:p-5"
        >
          <p id="booklet-confirm-title" className="text-lg font-semibold leading-6">
            Your booklet needs blank pages
          </p>
          <p id="booklet-confirm-body" className="mt-1.5 text-[15px] leading-6">
            Your document has {needsBookletConfirm.sourcePages} {needsBookletConfirm.sourcePages === 1 ? "page" : "pages"}, and a booklet needs a multiple
            of 4. Add {needsBookletConfirm.blankPagesAdded} blank {needsBookletConfirm.blankPagesAdded === 1 ? "page" : "pages"} at the end to make{" "}
            {needsBookletConfirm.paddedPages}?
          </p>
          <ul className="mt-2 list-disc pl-5 text-[var(--color-text-2)]">
            <li>
              <strong className="text-[var(--color-text)]">Add blank pages and print</strong> sends the job now with the blank{" "}
              {needsBookletConfirm.blankPagesAdded === 1 ? "page" : "pages"} at the back.
            </li>
            <li>
              <strong className="text-[var(--color-text)]">Cancel booklet</strong> prints nothing and switches the booklet option off, so you can change
              your choices.
            </li>
          </ul>
          <FormError message={clientError ?? serverError} />
          <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => {
                setBooklet("none");
                setDismissedState(state);
              }}
            >
              Cancel booklet
            </Button>
            {/* type="button": only this click (via confirmBookletPadding) ever sends confirmBookletPadding=true.
                Enter in Copies/Pages submits nothing while this question is open (no submit button exists).
                `pending` matters because this re-uploads the whole file: a double-tap would otherwise print the
                booklet twice. */}
            <Button type="button" size="lg" pending={pending} pendingLabel="Submitting..." onClick={confirmBookletPadding}>
              Add blank pages &amp; print
            </Button>
          </div>
          <p className="mt-3 text-xs text-[var(--color-muted)]">
            Your file and choices are kept. Take as long as you need. Answering sends the file again, and if that does not go through you can press the
            button again.
          </p>
        </div>
      )}

      {/* 1. The file: the biggest thing on the page. The real input covers the whole card (invisible), so tapping,
          keyboard and dragging a file onto it all work natively. */}
      <div data-tour="print-file-picker">
        <div
          className={`relative flex items-center gap-4 rounded-[var(--radius-card)] border-2 border-dashed p-5 transition-colors focus-within:shadow-[var(--ring)] ${
            fileError
              ? "border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
              : fileName
                ? "border-[var(--color-primary)]/40 bg-[var(--color-surface)]"
                : "border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]/50"
          } ${fileName ? "min-h-28 text-left" : "min-h-40 flex-col items-center justify-center text-center sm:min-h-44"}`}
        >
          <input
            id="file"
            type="file"
            name="file"
            accept="application/pdf"
            required
            onChange={onFileChange}
            aria-label="Choose a PDF to print"
            aria-describedby={fileError ? "file-error" : undefined}
            aria-invalid={!!fileError || undefined}
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          />
          {/* Canvas always mounted (just hidden when empty) so its ref is available the moment a file is chosen - no
           *  render-order race with the async thumbnail draw. */}
          <div
            className="flex h-24 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-[var(--shadow-xs)]"
            data-tour="print-preview"
            hidden={!fileName}
          >
            {thumbnailLoading && <Spinner />}
            <canvas ref={canvasRef} className="max-h-full max-w-full" hidden={!thumbnailReady} />
            {!thumbnailLoading && !thumbnailReady && fileName && (
              <FileText className="h-6 w-6 text-[var(--color-faint)]" aria-hidden="true" />
            )}
          </div>
          {fileName ? (
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold leading-6">{fileName}</p>
              {!fileError && estimatedPages !== null && (
                <p className="text-sm text-[var(--color-muted)]">
                  {estimatedPages} {estimatedPages === 1 ? "page" : "pages"}
                  {fileSizeLabel ? ` · ${fileSizeLabel}` : ""}
                </p>
              )}
              {!fileError && previewSkipped && (
                <p className="text-sm text-[var(--color-muted)]">
                  {fileSizeLabel ? `${fileSizeLabel} · ` : ""}Too large to preview. It will still print, and the page count is confirmed after you press
                  Print.
                </p>
              )}
              <p className="mt-1 text-sm font-medium text-[var(--color-primary)]">Choose a different file</p>
            </div>
          ) : (
            <>
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <FileUp className="h-7 w-7" aria-hidden="true" />
              </span>
              <div>
                <p className="text-lg font-semibold leading-6">{fileError ? "Choose another PDF" : "Choose a PDF"}</p>
                <p className="mt-0.5 text-sm text-[var(--color-muted)]">Tap here, or drop a file. Up to {formatFileSize(maxUploadBytes)}.</p>
              </div>
            </>
          )}
        </div>
        {fileError && (
          <p id="file-error" role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-[var(--color-danger)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{fileError}</span>
          </p>
        )}
      </div>

      {/* 2. The basics: printer (only a choice when there is one), copies, sides. Everything else is one level down. */}
      <Card className="flex flex-col gap-5" data-tour="print-options">
        {/* Always rendered (the tour points at it), but it only asks for a choice when there is one to make. */}
        <fieldset className="flex min-w-0 flex-col gap-2" data-tour="print-printer-fieldset">
          <legend className="mb-1.5 text-sm font-medium">Printer</legend>
          {!hasPrinters && (
            <div className="flex items-start gap-2 rounded-xl bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning-ink)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                No printer is connected yet. You can still choose a file and set things up. Printing starts once an administrator adds a printer.
              </span>
            </div>
          )}
          {printerProfiles.length === 1 && profile && (
            <>
              <input type="hidden" name="printerProfileId" value={profile.id} />
              <div className="flex items-center gap-3 rounded-xl bg-[var(--color-surface-2)] p-3 text-sm">
                <Printer className="h-5 w-5 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{profile.label}</span>
                  {profile.description && <span className="truncate text-xs text-[var(--color-muted)]">{profile.description}</span>}
                </span>
                <StatusDot tone={profile.printerOnline ? "success" : "neutral"}>{profile.printerOnline ? "Ready" : "Offline"}</StatusDot>
              </div>
            </>
          )}
          {printerProfiles.length > 1 &&
            printerProfiles.map((p) => (
              <label
                key={p.id}
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-2 p-3 text-sm transition-colors has-[:focus-visible]:shadow-[var(--ring)] ${
                  profile?.id === p.id
                    ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]/60"
                    : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
                }`}
              >
                <input
                  type="radio"
                  name="printerProfileId"
                  value={p.id}
                  checked={profile?.id === p.id}
                  onChange={() => setProfileId(p.id)}
                  className="h-5 w-5 shrink-0 accent-[var(--color-primary)]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{p.label}</span>
                  {p.description && <span className="text-xs text-[var(--color-muted)]">{p.description}</span>}
                </span>
                <StatusDot tone={p.printerOnline ? "success" : "neutral"}>{p.printerOnline ? "Ready" : "Offline"}</StatusDot>
              </label>
            ))}
        </fieldset>

        <div>
          <FieldLabel htmlFor="copies">Copies</FieldLabel>
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              aria-label="Fewer copies"
              disabled={!copiesValid || copies <= 1}
              onClick={() => setCopiesText(String(clampCopies(copies - 1)))}
              className={STEPPER_BUTTON}
            >
              <Minus className="h-5 w-5" aria-hidden="true" />
            </button>
            <Input
              id="copies"
              name="copies"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={copiesText}
              invalid={!copiesValid}
              aria-describedby={copiesValid ? undefined : "copies-error"}
              onChange={(e) => setCopiesText(e.target.value)}
              onBlur={() => copiesValid && setCopiesText(String(copies))}
              className="!min-h-12 text-center text-xl font-semibold tabular-nums"
            />
            <button
              type="button"
              aria-label="More copies"
              disabled={copiesValid && copies >= MAX_COPIES}
              onClick={() => setCopiesText(String(clampCopies(copies + 1)))}
              className={STEPPER_BUTTON}
            >
              <Plus className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          {!copiesValid && (
            <div id="copies-error">
              <FieldError message={`Enter a number from 1 to ${MAX_COPIES}.`} />
            </div>
          )}
        </div>

        <Segmented<SidesChoice>
          name="sides"
          label="Sides"
          value={effSides}
          onChange={setSides}
          options={[
            { value: "one", label: "Single-sided", disabledReason: avail.sidesLocked ? "A booklet is always double-sided." : null },
            { value: "two", label: "Double-sided", disabledReason: caps.duplex ? null : "This printer can't print double-sided." },
          ]}
          hint={
            avail.sidesLocked
              ? "A booklet is always double-sided."
              : !caps.duplex
                ? "This printer prints single-sided only."
                : effSides === "two"
                  ? "Long edge: pages flip like a book."
                  : undefined
          }
        />
      </Card>

      {/* 3. One level down. Every section starts closed and says in one line what it is set to. */}
      <div className="flex flex-col gap-3">
        <Collapsible
          id="print-pages"
          title="Pages"
          icon={<ListOrdered className="h-4 w-4" aria-hidden="true" />}
          summary={rangeError ? <span className="text-[var(--color-danger)]">{rangeError}</span> : summarizePages(rangeText, estimatedPages, selectedPages)}
          forceOpen={!!rangeError}
        >
          <div className="flex flex-col gap-4">
            <Segmented<"all" | "range">
              label="Which pages?"
              value={pagesMode === "all" && !rangeText ? "all" : "range"}
              onChange={(next) => {
                setPagesMode(next);
                if (next === "all") setPageRange("");
              }}
              options={[
                { value: "all", label: "All pages" },
                { value: "range", label: "Some pages" },
              ]}
            />
            {!(pagesMode === "range" || rangeText) && <input type="hidden" name="pageRange" value="" />}
            {(pagesMode === "range" || rangeText) && (
              <div>
                <FieldLabel htmlFor="pageRange">Pages to print</FieldLabel>
                <Input
                  id="pageRange"
                  name="pageRange"
                  type="text"
                  autoComplete="off"
                  placeholder="For example 1-5, 8"
                  value={pageRange}
                  invalid={!!rangeError}
                  aria-describedby={rangeError ? "pageRange-error" : "pageRange-help"}
                  onChange={(e) => setPageRange(e.target.value)}
                />
                {rangeError ? (
                  <div id="pageRange-error">
                    <FieldError message={rangeError} />
                  </div>
                ) : (
                  <p id="pageRange-help" className="mt-1.5 text-[13px] text-[var(--color-muted)]">
                    Use commas and dashes. {estimatedPages ? `This file has ${estimatedPages} pages.` : ""}
                  </p>
                )}
              </div>
            )}
          </div>
        </Collapsible>

        <Collapsible
          id="print-finishing"
          title="Finishing"
          icon={<Paperclip className="h-4 w-4" aria-hidden="true" />}
          summary={summarizeFinishing({ staple: effStaple, booklet: effBooklet })}
        >
          <div className="flex flex-col gap-5">
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
                  ? "Folds and staples the pages into a booklet. Left edge reads left to right. Right edge is for right-to-left languages such as Hebrew."
                  : effBooklet === "left"
                    ? "Bound on the left edge, like an English book."
                    : "Bound on the right edge, like a Hebrew book.")
              }
            />
          </div>
        </Collapsible>

        {showPaperColor && (
          <Collapsible
            id="print-paper"
            title="Paper & color"
            icon={<Palette className="h-4 w-4" aria-hidden="true" />}
            summary={summarizePaperColor({ colorMode: caps.color ? colorMode : "bw", paperSize: paperChoice })}
          >
            <div className="flex flex-col gap-5">
              <Segmented<"bw" | "color">
                name="colorMode"
                label="Color"
                value={caps.color ? colorMode : "bw"}
                onChange={setColorMode}
                options={[
                  { value: "bw", label: "Black & white" },
                  { value: "color", label: "Color", disabledReason: caps.color ? null : "This printer can't print in color." },
                ]}
              />
              <div>
                <FieldLabel htmlFor="paperSize">Paper size</FieldLabel>
                <Select id="paperSize" name="paperSize" value={paperChoice} onChange={(e) => setPaperSize(e.target.value)}>
                  {(profile?.declaredPaperSizes.length ? profile.declaredPaperSizes : ["letter"]).map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </Collapsible>
        )}

        <Collapsible
          id="print-advanced"
          title="Advanced"
          icon={<SlidersHorizontal className="h-4 w-4" aria-hidden="true" />}
          summary={summarizeAdvanced({ punchAvailable: showPunch, punch })}
        >
          <div className="flex flex-col gap-4">
            {showPunch && (
              <Switch name="punch" label="Hole punch" description="Punches holes along the left edge." checked={punch} onChange={(e) => setPunch(e.target.checked)} />
            )}
            <div>
              <p className="mb-2 text-[13px] text-[var(--color-muted)]">This page remembers your last choices on this device. Forget them to start fresh.</p>
              <Button type="button" variant="secondary" size="sm" onClick={resetChoices}>
                Forget my saved choices
              </Button>
            </div>
          </div>
        </Collapsible>
      </div>

      {/* 4. The action bar. On a phone it floats just above the tab bar (--sticky-bottom, set by the member shell);
          from sm up it is a card that sticks to the bottom of the window. */}
      <div className="sticky bottom-[var(--sticky-bottom,0.75rem)] z-30 -mx-1 rounded-[1.25rem] border border-[var(--color-border)] bg-[var(--color-surface)]/95 p-3 shadow-[var(--shadow-pop)] backdrop-blur sm:static sm:mx-0 sm:p-4 sm:shadow-[var(--shadow-card)]">
        <div aria-live="polite" className="flex items-baseline justify-between gap-3">
          {fileName || estimatedPages ? (
            <p className="min-w-0 text-sm font-medium leading-5 text-[var(--color-text)]">{liveLine}</p>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Choose a PDF to get started.</p>
          )}
          {summary && (
            <p className="shrink-0 text-sm tabular-nums text-[var(--color-muted)]">
              {summary.sheets} {summary.sheets === 1 ? "sheet" : "sheets"}
            </p>
          )}
        </div>
        {summary && summary.blankPagesAdded > 0 && (
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            Includes {summary.blankPagesAdded} blank {summary.blankPagesAdded === 1 ? "page" : "pages"} to fill the booklet.
          </p>
        )}
        {!summary && fileName && rangeText && !estimatedPages && (
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">The page count is confirmed after you press Print.</p>
        )}

        {barError && (
          <div className="mt-2">
            <FormError message={barError} />
          </div>
        )}
        {needsBookletConfirm ? (
          <p className="mt-2 text-sm font-medium">Answer the question at the top of the page to continue.</p>
        ) : (
          <Button
            type="submit"
            size="lg"
            data-tour="print-submit-button"
            pending={pending}
            pendingLabel="Sending..."
            disabled={!canSubmit || !fileName}
            className="mt-3 min-h-14 w-full text-lg font-semibold"
            title={hasPrinters ? undefined : "No printer is connected yet."}
          >
            <Printer className="h-5 w-5" aria-hidden="true" />
            Print
          </Button>
        )}
        {!needsBookletConfirm && summary && (
          <p className="mt-2 hidden text-center text-xs text-[var(--color-faint)] sm:block">Sheets and any approval needed are confirmed after you press Print.</p>
        )}
      </div>
    </form>
  );
}

const STEPPER_BUTTON =
  "flex min-h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-surface-2)] focus-visible:outline-none focus-visible:shadow-[var(--ring)] active:bg-[var(--color-surface-2)] disabled:cursor-not-allowed disabled:opacity-45";
