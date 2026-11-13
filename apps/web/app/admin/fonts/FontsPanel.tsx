"use client";

import { useRef, useState, useTransition } from "react";
import { Info, Trash2, Type } from "lucide-react";
import { Badge, Button, Card, EmptyState, FormError, FormSuccess } from "@/components/ui";
import { formatFileSize } from "@/lib/pdf/client-precheck";
import { deleteFontAction, uploadFontAction } from "./actions";

export interface FontRowView {
  id: string;
  name: string;
  fileName: string | null;
  sizeBytes: number | null;
  hasVowels: boolean;
  hasCantillation: boolean;
}

const MAX_BYTES = 8 * 1024 * 1024;

export function FontsPanel({ fonts, maxFonts }: { fonts: FontRowView[]; maxFonts: number }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const full = fonts.length >= maxFonts;

  function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    const form = e.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a font file (.ttf or .otf).");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That font file is bigger than 8 MB. Choose a smaller file.");
      return;
    }
    const data = new FormData();
    data.set("file", file);
    startTransition(async () => {
      try {
        const result = await uploadFontAction(data);
        if (result.ok) {
          setSuccess(result.message);
          formRef.current?.reset();
        } else {
          setError(result.message);
        }
      } catch {
        setError("Couldn't upload the font. Check your connection and try again.");
      }
    });
  }

  function onDelete(font: FontRowView) {
    if (!confirm(`Remove "${font.name}"? Booklets already printed stay as they are, but new ones can no longer use this font.`)) return;
    setError(undefined);
    setSuccess(undefined);
    setBusyId(font.id);
    startTransition(async () => {
      try {
        const result = await deleteFontAction(font.id);
        if (result.ok) setSuccess(result.message);
        else setError(result.message);
      } catch {
        setError("Couldn't remove the font. Try again in a moment.");
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 text-sm text-[var(--color-text-2)]">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          Only upload fonts you are licensed to use. Printio keeps them private to your organization and only draws them into your
          PDFs.
        </p>
      </div>

      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">Add a font</h2>
        <p className="mt-1 text-[13px] text-[var(--color-muted)]">
          A .ttf or .otf file with Hebrew letters, up to 8 MB. Fonts with vowel points and cantillation marks (such as SBL Hebrew)
          work best for the daily study.
        </p>
        <form ref={formRef} onSubmit={onUpload} className="mt-4 flex flex-col gap-3">
          <label htmlFor="font-file" className="sr-only">
            Font file
          </label>
          <input
            id="font-file"
            type="file"
            name="file"
            accept=".ttf,.otf,font/ttf,font/otf"
            required
            disabled={full || pending}
            className="block w-full min-h-11 rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-sm text-[var(--color-text-2)] file:mr-3 file:min-h-11 file:cursor-pointer file:border-0 file:bg-[var(--color-surface-2)] file:px-4 file:text-sm file:font-medium file:text-[var(--color-text)]"
          />
          {full && (
            <p className="text-[13px] text-[var(--color-muted)]">
              You have {maxFonts} fonts, the most you can keep. Remove one to add another.
            </p>
          )}
          <div>
            <Button type="submit" pending={pending && busyId === null} pendingLabel="Uploading..." disabled={full || pending}>
              Upload font
            </Button>
          </div>
        </form>
        <div className="mt-3 flex flex-col gap-2" aria-live="polite">
          <FormError message={error} />
          <FormSuccess message={success} />
        </div>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">
          Your fonts{" "}
          <span className="text-[13px] font-normal text-[var(--color-muted)]">
            ({fonts.length} of {maxFonts})
          </span>
        </h2>
        {fonts.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No fonts yet" description="The booklets use Printio's built-in Hebrew font until you add one." />
          </div>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-[var(--color-border)]">
            {fonts.map((font) => (
              <li key={font.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                    <Type className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{font.name}</p>
                    <p className="truncate text-[13px] text-[var(--color-muted)]">
                      {[font.fileName, font.sizeBytes ? formatFileSize(font.sizeBytes) : ""].filter(Boolean).join(" - ")}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {font.hasVowels && <Badge tone="success">vowels</Badge>}
                      {font.hasCantillation && <Badge tone="success">cantillation marks</Badge>}
                      {!font.hasVowels && !font.hasCantillation && <Badge>letters only</Badge>}
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline-danger"
                  size="sm"
                  onClick={() => onDelete(font)}
                  pending={pending && busyId === font.id}
                  pendingLabel="Removing..."
                  disabled={pending}
                  aria-label={`Remove ${font.name}`}
                  className="self-start sm:self-center"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
