/**
 * The booklet builder's work in progress, held in memory so that going to the library to pick more files and coming back
 * does not lose the files already added. It lives only as long as the browser tab stays open on Printio (a reload, or
 * closing the tab, clears it) and never leaves the browser. Cleared once the booklet is built.
 */
export interface DraftSource {
  id: number;
  title: string;
  file: File;
  bytes: ArrayBuffer;
  totalPages: number;
  pages: string;
  credit: string;
}

export interface BuilderDraft {
  sources: DraftSource[];
  title: string;
  description: string;
  direction: "ltr" | "rtl";
  cover: boolean;
  contents: boolean;
  /** "letter" (default) or "tabloid" (ledger 11x17). */
  sheet?: "letter" | "tabloid";
  sponsorLine?: string;
  backPage?: boolean;
}

let current: BuilderDraft | null = null;

export const saveDraft = (draft: BuilderDraft): void => {
  current = draft;
};
export const readDraft = (): BuilderDraft | null => current;
export const clearDraft = (): void => {
  current = null;
};
