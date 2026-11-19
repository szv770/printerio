"use client";

import { printerStatusLabel } from "@/lib/printers/status-label";
import { useActionState, useEffect, useRef, useState, startTransition } from "react";
import { AlertTriangle, BookOpen, FileText, FileUp, ListOrdered, Minus, Palette, Paperclip, Plus, Printer, SlidersHorizontal } from "lucide-react";
import { parsePageRange } from "@printio/shared";
import { bookletBlankPagesNote } from "@/lib/booklet-note";
import { PagePicker } from "@/components/print/PagePicker";
import { Button, Card, Collapsible, FieldError, FieldLabel, FormError, Input, Segmented, Spinner, StatusDot, Switch } from "@/components/ui";
import { hasType3Fonts, PICTURE_COPY_MAX_PAGES, TYPE3_HELD_MESSAGE, TYPE3_PICTURE_NOTICE } from "@printio/pdf/type3-fonts";
import { formatFileSize, precheckPdfHeader, precheckSelectedFile, shouldPreviewInBrowser } from "@/lib/pdf/client-precheck";
import { renderPdfPageToCanvas } from "@/lib/pdf/render-page";
import { MAX_COPIES, buildSummary } from "@/lib/print-choices";
import {
  CARDSTOCK_WARNING,
  CLEAN_CHOICES,
  applyTap,
  fitToPrinter,
  settleState,
  type BookletValue,
  type ChoiceState,
  type ChoiceTap,
  type EdgeValue,
  type SidesValue,
  type SizeValue,
  type StapleValue,
  type PaperValue,
} from "@/lib/print-choice-rules";
import type { PrintAgainFormChoices } from "@/lib/jobs/print-again";
import { CLEAN_START, resolveStartChoices, type RememberedChoices } from "@/lib/print-start-choices";
import { liveSummaryLine, summarizeAdvanced, summarizeColor, summarizeFinishing, summarizePages } from "@/lib/print-form-summary";
import dynamic from "next/dynamic";
import { submitPrintJobAction, type SubmitJobState } from "./actions";
import { previewBookletAction, type BookletPreviewState } from "./preview-action";
import { createUploadSlotAction } from "./stage-upload-action";
import { DIRECT_UPLOAD_THRESHOLD_BYTES, browserUpload, stageLargeFile } from "@/lib/pdf/direct-upload";
import type { BookletPreviewData } from "./BookletPreview";

// Loaded only when a preview is asked for: it pulls in pdfjs-dist, which most visits never need.
const BookletPreview = dynamic(() => import("./BookletPreview").then((m) => m.BookletPreview), { ssr: false });
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
  /** What the printer itself reports (see lib/printers/status-label.ts); absent in older callers. */
  printerStatus?: string;
  printerDetail?: string | null;
}

/** Ready, Offline, or the printer's own words when it needs someone (paper out, a jam). */
function statusFor(p: { printerOnline: boolean; printerStatus?: string; printerDetail?: string | null }) {
  return printerStatusLabel(p.printerStatus ?? (p.printerOnline ? "online" : "offline"), p.printerDetail);
}

const THUMBNAIL_MAX_WIDTH_PX = 200;
/** The key the page used to remember choices under in the browser. It no longer remembers anything there; the key is just cleaned up. */
const LEGACY_STORAGE_KEY = "printio.print-choices.v1";

const STAGED_REUSE_MS = 20 * 60 * 1000;
const stagedNow = () => Date.now();
/** The path of an earlier direct upload of this very file, while it is fresh enough that the weekly cleanup cannot have taken it. */
function reusableStagedPath(entry: { file: File; path: string; at: number } | null, file: File): string | null {
  return entry && entry.file === file && stagedNow() - entry.at < STAGED_REUSE_MS ? entry.path : null;
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
  blockType3Fonts = true,
  again,
  remembered,
}: {
  /** "Print again": the earlier job's choices. Applied once after mount, over the remembered ones; every control stays changeable. */
  again?: PrintAgainFormChoices;
  /** Only present when the member switched on "Remember my last print choices" (validated on the server, never with a booklet). Without it every visit starts clean. */
  remembered?: RememberedChoices;
  printerProfiles: PrinterOption[];
  /** organization_settings.max_upload_size_bytes, forwarded only so the file picker can reject an oversized file
   *  instantly. Advisory: print/actions.ts re-reads the same setting server-side and is the real gate. */
  maxUploadBytes: number;
  /** Refuse, the moment a file is picked, a PDF with Type 3 fonts (they can crash the printer). The server holds them too. Default on. */
  blockType3Fonts?: boolean;
}) {
  const [state, formAction, pending] = useActionState(safeSubmitPrintJobAction, initialSubmitJobState);

  const [profileId, setProfileId] = useState(printerProfiles[0]?.id ?? "");
  const [estimatedPages, setEstimatedPages] = useState<number | null>(null);
  /** The chosen file's bytes (only when small enough to preview in the browser): the tap-to-pick pages draw their thumbnails from it. */
  const [pickedBytes, setPickedBytes] = useState<ArrayBuffer | null>(null);
  const [pickMode, setPickMode] = useState<"tap" | "type">("tap");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSizeLabel, setFileSizeLabel] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
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
  /** A large file already uploaded straight to storage (see prepareLargeFile); reused by the answer to the blank-pages question and by Preview. */
  const staged = useRef<{ file: File; path: string; at: number } | null>(null);
  /** True while a large file is on its way to storage (before the print action itself runs). */
  const [uploading, setUploading] = useState(false);
  /** Bumped whenever a different file is picked, so the booklet prompt below cannot outlive the file it asked about. */
  const [fileVersion, setFileVersion] = useState(0);
  /** What the form looked like when the server last asked the padding question (null = not asked / cleared). */
  const [askedSignature, setAskedSignature] = useState<string | null>(null);
  /** The server response whose booklet prompt the member cancelled - that response's prompt stays hidden. */
  const [dismissedState, setDismissedState] = useState<SubmitJobState | null>(null);
  /** Set by a refused submit (Enter pressed while the form is invalid); cleared by the next valid submit. */
  const [clientError, setClientError] = useState<string | null>(null);

  /** The quick controls (sides, flip edge, staple, punch, booklet, size, paper type) as one value; every tap goes through applyTap (lib/print-choice-rules.ts). */
  const [choice, setChoice] = useState<ChoiceState>(CLEAN_CHOICES);
  /** What the last tap had to switch besides itself, in plain words ("Single-sided because hole punch with a staple needs it."). Shown in the live summary. */
  const [tapNote, setTapNote] = useState<string | null>(null);
  const [copiesText, setCopiesText] = useState("1");
  const [pageRange, setPageRange] = useState("");
  /** Presentation only: whether the "Some pages" box is showing. The text in pageRange is still what is submitted. */
  const [pagesMode, setPagesMode] = useState<"all" | "range">("all");
  const [colorMode, setColorMode] = useState<"bw" | "color">("bw");
  /** Booklets only: "fill" crops the document's own blank margins so the content fills the page; "keep" scales the whole page. */
  const [bookletFit, setBookletFit] = useState<"fill" | "keep">("fill");
  /** Set when the page was opened from the booklet builder: the booklet preview then builds itself once the file is in. */
  const [autoPreview, setAutoPreview] = useState(false);
  const autoPreviewFired = useRef(false);
  const [preview, setPreview] = useState<{ status: "idle" | "loading" | "error" | "ready"; error?: string; data?: BookletPreviewData; signature?: string }>({ status: "idle" });
  /** False until the start choices have been applied (the booklet preview waits for it). */
  const [restored, setRestored] = useState(false);

  const profile = printerProfiles.find((p) => p.id === profileId) ?? printerProfiles[0];
  const hasPrinters = printerProfiles.length > 0;
  const isRaw = profile?.isRaw ?? false;
  // With no printer at all the form is a preview only (Submit is disabled), so nothing is greyed out.
  const caps = profile?.declaredCapabilities ?? { duplex: true, color: true, staple: true, booklet: true, punch: true };

  // Apply the start choices after mount (never during the first render: it would not match the server-rendered HTML).
  // Clean by default; the member's remembered choices only when they switched that on; then the handoffs (print again, the
  // booklet builder, a library page range) over both. See lib/print-start-choices.ts. A timer rather than a direct setState
  // keeps this out of the render/commit cascade.
  useEffect(() => {
    const t = setTimeout(() => {
      // This page used to remember choices in the browser; it no longer does (the setting lives on the member's profile).
      try {
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* storage unavailable - nothing to clean up */
      }
      const c = resolveStartChoices({ printers: printerProfiles, remembered, again, search: window.location.search });
      if (c.profileId) setProfileId(c.profileId);
      const startRaw = (printerProfiles.find((p) => p.id === (c.profileId ?? printerProfiles[0]?.id)) ?? printerProfiles[0])?.isRaw ?? false;
      // A handoff (the booklet builder, Print again) may bring a mix that does not fit together: the booklet wins, silently, before anything is touched.
      setChoice(
        settleState(
          {
            sides: c.sides,
            edge: c.flip,
            staple: c.staple === "profile" ? "top-left" : c.staple,
            punch: c.punch,
            booklet: c.booklet === "profile" ? "left" : c.booklet,
            size: c.size,
            paper: c.paper,
          },
          { raw: startRaw },
        ),
      );
      setTapNote(null);
      setCopiesText(String(c.copies));
      setColorMode(c.colorMode);
      setBookletFit(c.bookletFit);
      setPagesMode(c.pagesMode);
      setPageRange(c.pageRange);
      if (c.autoPreview) setAutoPreview(true);
      setRestored(true);
    }, 0);
    return () => clearTimeout(t);
    // Runs once; the printer list does not change while the page is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copiesNumber = /^\d+$/.test(copiesText.trim()) ? parseInt(copiesText, 10) : NaN;
  const copiesValid = Number.isInteger(copiesNumber) && copiesNumber >= 1 && copiesNumber <= MAX_COPIES;
  const copies = copiesValid ? copiesNumber : 1;

  /**
   * What the form will actually submit, given what the selected printer can do. The raw picks stay in state, so
   * switching back to a printer that supports an option restores it; but what is shown and sent is always the
   * effective value, so the page never shows something it will not do.
   */
  const declared = profile?.declaredPaperSizes ?? ["letter", "11x17"];
  /** How this printer spells 11x17 (raw printers: "11x17"; a queue may declare "tabloid"). */
  const tabloidValue = declared.includes("tabloid") && !declared.includes("11x17") ? "tabloid" : "11x17";
  const offersTabloid = declared.includes("11x17") || declared.includes("tabloid");
  const letterValue = declared.includes("letter") ? "letter" : (declared[0] ?? "letter");
  const ruleCtx = { raw: isRaw };
  const eff = fitToPrinter(choice, { raw: isRaw, duplex: caps.duplex, staple: caps.staple, booklet: caps.booklet, punch: caps.punch, tabloid: offersTabloid });
  const effBooklet: BookletValue = eff.booklet;
  const effStaple: StapleValue = eff.staple;
  const effSides: SidesValue = eff.sides;
  /** One tap on a quick control: the rules decide what else must switch and say so in plain words. Taps start from what is shown. */
  function tap(t: ChoiceTap) {
    const r = applyTap(eff, t, ruleCtx);
    setChoice(r.state);
    setTapNote(r.note);
  }

  // The page range, checked as far as the browser can (the server checks it again against the real document).
  const rangeText = pageRange.trim();
  const rangeCheck = rangeText && estimatedPages ? parsePageRange(rangeText, estimatedPages) : null;
  const rangeError = (rangeCheck && !rangeCheck.ok ? rangeCheck.reason : null) ?? state.fieldErrors?.pageRange ?? null;
  const selectedPages = rangeCheck?.ok ? rangeCheck.pages.length : rangeText && !estimatedPages ? null : estimatedPages;
  const bookletNote = effBooklet !== "none" ? bookletBlankPagesNote(selectedPages) : null;
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
    staged.current = null;
    setEstimatedPages(null);
    setPickedBytes(null);
    setFileError(null);
    setFileNotice(null);
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
    // Its own copy: pdf.js takes ownership of (empties) any buffer it is given, and the form hands this one to it next.
    setPickedBytes(bytes.slice(0));

    try {
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      if (blockType3Fonts && hasType3Fonts(doc)) {
        // Printio prints a picture copy of these (up to a page limit); longer ones are refused with the explanation.
        if (doc.getPageCount() > PICTURE_COPY_MAX_PAGES) {
          rejectSelectedFile(input, TYPE3_HELD_MESSAGE);
          return;
        }
        setFileNotice(TYPE3_PICTURE_NOTICE);
      }
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

  /**
   * Vercel rejects Server Action bodies over about 4.5 MB, so a bigger PDF is uploaded straight to storage first and
   * the action gets only its staged path (lib/jobs/staged-upload.ts). Small files keep travelling inside the form.
   * Returns an error message (shown to the member) or null once `data` carries stagedPath + fileName instead of the file.
   */
  async function prepareLargeFile(data: FormData, snapshot: File): Promise<string | null> {
    if (snapshot.size <= DIRECT_UPLOAD_THRESHOLD_BYTES) return null;
    let path = reusableStagedPath(staged.current, snapshot);
    if (!path) {
      setUploading(true);
      try {
        const r = await stageLargeFile(snapshot, { getSlot: createUploadSlotAction, upload: browserUpload });
        if (!r.ok) return r.error;
        path = r.path;
        staged.current = { file: snapshot, path, at: stagedNow() };
      } finally {
        setUploading(false);
      }
    }
    data.delete("file");
    data.set("stagedPath", path);
    data.set("fileName", snapshot.name);
    return null;
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
    if (pending || uploading) return;
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
    // No extra question for a booklet: blank pages are simply added at the end (the inline note says how many).
    if (confirming || effBooklet !== "none") data.set("confirmBookletPadding", "true");
    const picked = data.get("file");
    if (picked instanceof File && picked.size > 0) {
      try {
        const snapshot = await fileSnapshots.current.get(picked);
        data.set("file", snapshot);
        const uploadError = await prepareLargeFile(data, snapshot);
        if (uploadError) {
          setClientError(uploadError);
          return;
        }
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

  /** The preview belongs to one exact set of choices and one file; any change hides it (and a new press rebuilds it). */
  const previewSignature = JSON.stringify([formSignature, bookletFit, eff.size, rangeText]);

  async function onPreviewBooklet() {
    if (preview.status === "loading") return;
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    const picked = data.get("file");
    if (!(picked instanceof File) || picked.size === 0) {
      setPreview({ status: "error", error: "Choose a PDF first." });
      return;
    }
    const signature = previewSignature;
    setPreview({ status: "loading" });
    try {
      const snapshot = await fileSnapshots.current.get(picked);
      data.set("file", snapshot);
      const uploadError = await prepareLargeFile(data, snapshot);
      if (uploadError) {
        setPreview({ status: "error", error: uploadError });
        return;
      }
      const res: BookletPreviewState = await previewBookletAction(data);
      if (!res.ok) {
        setPreview({ status: "error", error: res.fieldErrors?.pageRange ?? res.error });
        return;
      }
      setPreview({
        status: "ready",
        signature,
        data: { pdfUrl: res.pdfUrl, bindingSide: res.bindingSide, sheets: res.sheets, blankPagesAdded: res.blankPagesAdded },
      });
    } catch {
      setPreview({ status: "error", error: "The preview didn't load (the connection dropped or the file is too large to preview). Printing is not affected." });
    }
  }

  // From the booklet builder: show the preview (cover, contents and all) without a press, as soon as the built file is in
  // the form. The file arrives a moment after the page, so this waits for its page count.
  useEffect(() => {
    if (!autoPreview || !restored || estimatedPages === null || !hasPrinters || rangeError || fileError || effBooklet === "none") return;
    if (autoPreviewFired.current) return;
    autoPreviewFired.current = true;
    // Deferred a tick: state is not set inside the effect body.
    void Promise.resolve().then(() => {
      setAutoPreview(false);
      void onPreviewBooklet();
    });
    // onPreviewBooklet reads the form and current state when it runs; it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPreview, restored, estimatedPages, hasPrinters, rangeError, fileError, effBooklet]);

  /** Back to the clean start (only offered when the member's "remember my last choices" setting is on). */
  function resetChoices() {
    setChoice(CLEAN_CHOICES);
    setTapNote(null);
    setCopiesText(String(CLEAN_START.copies));
    setColorMode(CLEAN_START.colorMode);
  }

  const showColor = !isRaw;
  const showPunch = !isRaw && caps.punch;
  // A raw printer shows hole punch next to the staple choices; a Windows queue keeps it under Advanced.
  const showPunchFinishing = isRaw && caps.punch;
  const effPunch = eff.punch;
  const liveLine = liveSummaryLine({
    pages: selectedPages,
    copies,
    sides: effSides,
    staple: effStaple,
    booklet: effBooklet,
    punch: showPunchFinishing && effPunch,
    edge: isRaw ? eff.edge : "long",
    size: eff.size,
    paper: isRaw ? eff.paper : "plain",
  });
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
                tap({ kind: "booklet", value: "none" });
                setDismissedState(state);
              }}
            >
              Cancel booklet
            </Button>
            {/* type="button": only this click (via confirmBookletPadding) ever sends confirmBookletPadding=true.
                Enter in Copies/Pages submits nothing while this question is open (no submit button exists).
                `pending` matters because this re-uploads the whole file: a double-tap would otherwise print the
                booklet twice. */}
            <Button type="button" size="lg" pending={pending || uploading} pendingLabel={uploading ? "Uploading your file..." : "Submitting..."} onClick={confirmBookletPadding}>
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
        {fileNotice && !fileError && (
          <p role="status" className="mt-2 flex items-start gap-1.5 text-sm text-[var(--color-muted)]">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{fileNotice}</span>
          </p>
        )}
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
                <StatusDot tone={statusFor(profile).tone}>{statusFor(profile).label}</StatusDot>
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
                <StatusDot tone={statusFor(p).tone}>{statusFor(p).label}</StatusDot>
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

        {/* Quick controls: one tap each. Nothing here is ever greyed out because of another choice: a tap switches what it
            cannot live with and the live summary below says what it switched (lib/print-choice-rules.ts). */}
        <Segmented<SidesValue>
          name="sides"
          label="Sides"
          value={effBooklet !== "none" ? "two" : effSides}
          onChange={(v) => tap({ kind: "sides", value: v })}
          options={[
            { value: "one", label: "Single-sided" },
            { value: "two", label: "Double-sided", disabledReason: caps.duplex ? null : "This printer can't print double-sided." },
          ]}
          hint={!caps.duplex ? "This printer prints single-sided only." : undefined}
        />
        {isRaw && effSides === "two" && effBooklet === "none" && (
          <Segmented<EdgeValue>
            name="flip"
            label="Flip on"
            value={eff.edge}
            onChange={(v) => tap({ kind: "edge", value: v })}
            options={[
              { value: "long", label: "Long edge (like a book)" },
              { value: "short", label: "Short edge (like a notepad)" },
            ]}
          />
        )}

        {/* The hidden input carries the printer's own spelling of the size (a raw printer asks for "11x17"). */}
        <input type="hidden" name="paperSize" value={eff.size === "tabloid" ? tabloidValue : letterValue} />
        {offersTabloid && (
          <Segmented<SizeValue>
            label="Page size"
            value={eff.size}
            onChange={(v) => tap({ kind: "size", value: v })}
            options={[
              { value: "letter", label: "Letter" },
              { value: "tabloid", label: "Tabloid (11x17)" },
            ]}
          />
        )}

        {isRaw && (
          <div>
            <Segmented<PaperValue>
              name="paperType"
              label="Paper type"
              value={eff.paper}
              onChange={(v) => tap({ kind: "paper", value: v })}
              options={[
                { value: "plain", label: "Plain" },
                { value: "cardstock", label: "Cardstock" },
              ]}
            />
            {eff.paper === "cardstock" && (
              <p role="status" className="mt-2 flex items-start gap-1.5 rounded-xl bg-[var(--color-warning-soft)] px-3 py-2 text-sm text-[var(--color-warning-ink)]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{CARDSTOCK_WARNING}</span>
              </p>
            )}
          </div>
        )}

        {caps.booklet && caps.duplex && (
          <div>
            <Segmented<BookletValue>
              name="booklet"
              label="Booklet"
              value={effBooklet}
              onChange={(v) => tap({ kind: "booklet", value: v })}
              options={[
                { value: "none", label: "Off" },
                { value: "left", label: "Left binding" },
                { value: "right", label: "Right binding" },
              ]}
              hint={
                effBooklet === "none"
                  ? "Folds and staples the pages into a booklet. Left binding reads left to right. Right binding is for right-to-left languages such as Hebrew."
                  : effBooklet === "left"
                    ? "Bound on the left edge, like an English book."
                    : "Bound on the right edge, like a Hebrew book."
              }
            />
            {effBooklet !== "none" && (
              <div className="mt-4 flex flex-col gap-4">
                {bookletNote && (
                  <p role="status" className="rounded-xl bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-muted)]">
                    {bookletNote}
                  </p>
                )}
                <Segmented<SizeValue>
                  name="bookletSheet"
                  label="Booklet size"
                  value={eff.size}
                  onChange={(v) => tap({ kind: "size", value: v })}
                  options={[
                    { value: "letter", label: "Regular (Letter sheet)" },
                    { value: "tabloid", label: "11x17 (full-size pages)" },
                  ]}
                  hint={
                    eff.size === "letter"
                      ? "Each page is scaled to fit a statement-size page (half a Letter sheet), as big as it can be without being cut off."
                      : "Letter pages stay about full size on an 11x17 sheet, folded and stapled in the middle. Not tested yet - may not come out right. Put 11x17 paper in the printer first."
                  }
                />
                {eff.size === "letter" && (
                  <Segmented<"fill" | "keep">
                    name="bookletFit"
                    label="Booklet fit"
                    value={bookletFit}
                    onChange={setBookletFit}
                    options={[
                      { value: "fill", label: "Fill the page (recommended)" },
                      { value: "keep", label: "Keep original margins" },
                    ]}
                    hint={
                      bookletFit === "fill"
                        ? "Trims your document's own blank margins so the text fills each booklet page. Pages of the same size are trimmed the same, so the text stays one size. Scans of other sizes are fitted on their own."
                        : "Shrinks the whole page, margins included, to fit. Text comes out smaller."
                    }
                  />
                )}
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!fileName || !!fileError || !hasPrinters || !!rangeError}
                    pending={preview.status === "loading"}
                    pendingLabel="Building preview..."
                    onClick={onPreviewBooklet}
                  >
                    <BookOpen className="h-4 w-4" aria-hidden="true" />
                    Preview booklet
                  </Button>
                  {!fileName && <p className="mt-1 text-xs text-[var(--color-muted)]">Choose a PDF to preview the booklet.</p>}
                  {preview.status === "error" && preview.error && <FormError message={preview.error} />}
                  {preview.status === "ready" && preview.data && preview.signature === previewSignature && <BookletPreview data={preview.data} />}
                  {preview.status === "ready" && preview.signature !== previewSignature && (
                    <p className="mt-2 text-xs text-[var(--color-muted)]">Your choices changed. Press Preview booklet to see the new layout.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
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
            {(pagesMode === "range" || rangeText) && pickedBytes && estimatedPages && (
              <Segmented<"tap" | "type">
                label="How do you want to choose?"
                value={pickMode}
                onChange={setPickMode}
                options={[
                  { value: "tap", label: "Tap pages" },
                  { value: "type", label: "Type pages" },
                ]}
              />
            )}
            {(pagesMode === "range" || rangeText) && pickedBytes && estimatedPages && pickMode === "tap" && (
              <>
                <input type="hidden" name="pageRange" value={pageRange} />
                <PagePicker bytes={pickedBytes} totalPages={estimatedPages} value={pageRange} onChange={setPageRange} />
                {rangeError && <FieldError message={rangeError} />}
              </>
            )}
            {(pagesMode === "range" || rangeText) && !(pickedBytes && estimatedPages && pickMode === "tap") && (
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
          summary={summarizeFinishing({ staple: effStaple, booklet: effBooklet, punch: showPunchFinishing && effPunch })}
        >
          <div className="flex flex-col gap-5">
            <Segmented<StapleValue>
              name="staple"
              label="Staple"
              value={effStaple}
              onChange={(v) => tap({ kind: "staple", value: v })}
              disabled={!caps.staple}
              options={
                isRaw
                  ? [
                      { value: "none", label: "None" },
                      { value: "top-left", label: "Top-left" },
                      { value: "top-right", label: "Top-right" },
                      ...(caps.staple ? [{ value: "dual-left" as const, label: "Two staples, left" }] : []),
                    ]
                  : [
                      { value: "none", label: "None" },
                      { value: "top-left", label: "Staple" },
                    ]
              }
              hint={!caps.staple ? "This printer can't staple." : undefined}
            />
            {showPunchFinishing && (
              <Switch
                name="punch"
                label="Hole punch (3 holes, left)"
                description="Punches 3 holes along the left edge."
                checked={effPunch}
                onChange={(e) => tap({ kind: "punch", value: e.target.checked })}
              />
            )}
          </div>
        </Collapsible>

        {showColor && (
          <Collapsible
            id="print-paper"
            title="Color"
            icon={<Palette className="h-4 w-4" aria-hidden="true" />}
            summary={summarizeColor({ colorMode: caps.color ? colorMode : "bw" })}
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
            </div>
          </Collapsible>
        )}

        {(showPunch || remembered !== undefined) && (
        <Collapsible
          id="print-advanced"
          title="Advanced"
          icon={<SlidersHorizontal className="h-4 w-4" aria-hidden="true" />}
          summary={summarizeAdvanced({ punchAvailable: showPunch, punch: effPunch })}
        >
          <div className="flex flex-col gap-4">
            {showPunch && (
              <Switch name="punch" label="Hole punch" description="Punches holes along the left edge." checked={effPunch} onChange={(e) => tap({ kind: "punch", value: e.target.checked })} />
            )}
            {remembered !== undefined && (
              <div>
                <p className="mb-2 text-[13px] text-[var(--color-muted)]">This page started from what you chose last time (your Profile setting). Start fresh to clear it.</p>
                <Button type="button" variant="secondary" size="sm" onClick={resetChoices}>
                  Start fresh
                </Button>
              </div>
            )}
          </div>
        </Collapsible>
        )}
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
        {tapNote && (
          <p role="status" data-testid="choice-note" className="mt-1 text-sm font-medium text-[var(--color-warning-ink)]">
            {tapNote}
          </p>
        )}
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
            pending={pending || uploading}
            pendingLabel={uploading ? "Uploading your file..." : "Sending..."}
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
