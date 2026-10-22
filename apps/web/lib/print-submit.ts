/**
 * Client-side resilience for the print form's two-step flow ("add 2 blank pages?" and then the answer).
 *
 * The server keeps NOTHING between those two steps: the answer is a brand-new submission that re-sends the whole
 * file (see print/actions.ts and lib/jobs/create-print-job.ts - no cookie, cache, signed URL or timer). So the
 * only thing that can age during a long wait is the browser's handle on the picked file: a File chosen from disk
 * is a live reference, and when the file changed or was touched since (OneDrive/antivirus on a synced Desktop is
 * the everyday case) or the handle was released, reading it again throws NotReadableError - after which the
 * second submit failed without the member seeing why. The fix is to copy the bytes into memory on the first
 * Print press (while the handle is good) and re-send that copy for the answer, however long it takes.
 */

export interface SubmitState {
  error?: string;
  fieldErrors?: { pageRange?: string };
  needsBookletConfirm?: { sourcePages: number; paddedPages: number; blankPagesAdded: number };
}

const UNREADABLE_FILE =
  "Your browser can no longer read the file you picked (it may have changed or been moved). Your options are kept - choose the file again, then press Print.";

export const SUBMIT_FAILED =
  "That didn't go through (the connection dropped or the server took too long). Your file and choices are still here - press the button again.";

export interface FileSnapshotCache {
  /** An in-memory copy of `picked` (reading it once; the same copy on later calls for the same picked file). */
  get(picked: File): Promise<File>;
  clear(): void;
}

export function createFileSnapshotCache(): FileSnapshotCache {
  let source: File | null = null;
  let copy: File | null = null;
  return {
    async get(picked) {
      if (source === picked && copy) return copy;
      let bytes: ArrayBuffer;
      try {
        bytes = await picked.arrayBuffer();
      } catch {
        throw new Error(UNREADABLE_FILE);
      }
      source = picked;
      copy = new File([bytes], picked.name, { type: picked.type, lastModified: picked.lastModified });
      return copy;
    },
    clear() {
      source = null;
      copy = null;
    },
  };
}

function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND"));
}

/**
 * Wraps the submit server action so a failed call (network drop, timeout, an expired deployment) becomes a plain
 * message in the form instead of an error boundary or silence. When the call was the answer to the blank-pages
 * question and it did not succeed, the question is kept open so the member can simply press the button again.
 */
export function wrapSubmitAction<S extends SubmitState>(
  action: (prev: S, formData: FormData) => Promise<S>,
): (prev: S, formData: FormData) => Promise<S> {
  return async (prev, formData) => {
    const wasConfirming = formData.get("confirmBookletPadding") === "true";
    let result: S;
    try {
      result = await action(prev, formData);
    } catch (err) {
      if (isNextControlFlow(err)) throw err;
      result = { error: SUBMIT_FAILED } as S;
    }
    if (wasConfirming && result.error && !result.needsBookletConfirm && prev.needsBookletConfirm) {
      return { ...result, needsBookletConfirm: prev.needsBookletConfirm };
    }
    return result;
  };
}
