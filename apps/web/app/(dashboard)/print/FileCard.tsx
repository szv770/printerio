import type { ReactNode, RefObject } from "react";
import { FileText, FileUp, X } from "lucide-react";
import { Spinner } from "@/components/ui";

/**
 * The file step of the print page. Empty it is one calm drop area; once a file is chosen it becomes a compact card
 * (small thumbnail beside the details on a phone, a large page preview above them on a desktop) with Change and Remove.
 *
 * The real file input is passed in and sits invisibly over the whole card, so tapping, the keyboard and dragging a file
 * onto the card all work natively. Remove sits above it. The canvas is always mounted (only hidden when empty) so its ref
 * exists the moment a file is chosen: no render-order race with the asynchronous thumbnail draw.
 */
export function FileCard({
  input,
  canvasRef,
  fileName,
  meta,
  note,
  error,
  loading,
  thumbnailReady,
  imageUrl,
  maxLabel,
  onRemove,
}: {
  input: ReactNode;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  fileName: string | null;
  /** "12 pages · 1.2 MB" (or "Photo · 1 page · 800 KB"). */
  meta: string | null;
  /** E.g. "Too large to preview. It will still print." */
  note: string | null;
  error: boolean;
  loading: boolean;
  thumbnailReady: boolean;
  imageUrl: string | null;
  maxLabel: string;
  onRemove: () => void;
}) {
  const chosen = !!fileName;
  const frame = error
    ? "border-2 border-dashed border-[var(--color-danger)] bg-[var(--color-danger-soft)]"
    : chosen
      ? "border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
      : "border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]/40";
  return (
    <div
      className={`relative rounded-[var(--radius-card)] transition-colors duration-150 motion-reduce:transition-none focus-within:shadow-[var(--ring)] ${frame} ${
        chosen
          ? "flex items-center gap-4 p-4 lg:flex-col lg:items-stretch lg:gap-5 lg:p-6"
          : "flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center lg:min-h-80"
      }`}
    >
      {input}
      <div
        className="flex h-[4.5rem] w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] shadow-[var(--shadow-xs)] lg:mx-auto lg:h-72 lg:w-56 lg:rounded-xl"
        data-tour="print-preview"
        hidden={!chosen}
      >
        {loading && <Spinner />}
        <canvas ref={canvasRef} className="max-h-full max-w-full" hidden={!thumbnailReady} />
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL of the picked photo; next/image cannot optimise it
          <img src={imageUrl} alt="Preview of your photo" className="max-h-full max-w-full object-contain" />
        )}
        {!loading && !thumbnailReady && !imageUrl && chosen && <FileText className="h-6 w-6 text-[var(--color-faint)] lg:h-10 lg:w-10" aria-hidden="true" />}
      </div>
      {chosen ? (
        <div className="min-w-0 flex-1 lg:flex-none">
          <p className="truncate text-[15px] font-medium leading-6 text-[var(--color-text)]">{fileName}</p>
          {!error && meta && <p className="text-[13px] leading-5 text-[var(--color-muted)]">{meta}</p>}
          {!error && note && <p className="text-[13px] leading-5 text-[var(--color-muted)]">{note}</p>}
          <div className="mt-1 flex items-center gap-1">
            <span className="inline-flex min-h-11 items-center pr-3 text-sm font-medium text-[var(--color-primary)]">Change file</span>
            <button
              type="button"
              onClick={onRemove}
              className="relative z-20 inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:shadow-[var(--ring)]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <FileUp className="h-6 w-6" aria-hidden="true" />
          </span>
          <div>
            <p className="text-base font-semibold leading-6 text-[var(--color-text)]">{error ? "Choose another file" : "Choose a PDF or photo"}</p>
            <p className="mt-0.5 text-[13px] leading-5 text-[var(--color-muted)]">Tap here, or drop a file. Up to {maxLabel}.</p>
          </div>
        </>
      )}
    </div>
  );
}
