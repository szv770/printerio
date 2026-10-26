/** Small, pure helpers for showing the Mafteiach library clearly: friendlier file names, which entries have English, and search. */

const FRIENDLY: Record<string, string> = {
  שיחה: "Hebrew sicha",
  מתורגם: "English translation",
};

/** The library names its buttons in one Hebrew word ("שיחה", "מתורגם"); show those in plain words. Other labels are unchanged. */
export function friendlyFileLabel(label: string): string {
  return FRIENDLY[label.trim()] ?? label;
}

/** True when any file is an English translation, or the section the files are in is the English one. */
export function hasEnglish(files: { label: string }[], sectionTitle = ""): boolean {
  if (sectionTitle.trim().toLowerCase() === "english") return true;
  return files.some((f) => f.label.trim() === "מתורגם" || /english/i.test(f.label));
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[“”״]/g, '"')
    .replace(/[‘’׳]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** Every word of the search must appear somewhere in the given texts. An empty search matches everything. */
export function matchesQuery(texts: string[], query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(texts.join(" "));
  return words.every((w) => haystack.includes(w));
}
