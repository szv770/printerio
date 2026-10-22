// The printer description advertised to the OS. Ported from tools/ipp-spike/server.mjs `printerAttrs`
// (accepted by Windows 11 and Android). Contract changes vs the spike: Letter is the default size,
// `finishings` is "none" only, and the setup page / profile URLs are gone.
import { createHash } from "node:crypto";
import { attr, OP, TAG, type IppAttr } from "./codec.js";

/** Same list the spike advertised by default. Only PDF is actually accepted (see handlers). */
export const DOCUMENT_FORMATS = ["application/pdf", "image/pwg-raster", "image/jpeg", "application/octet-stream"];

export const MEDIA_SIZES = [
  { key: "na_letter_8.5x11in", x: 21590, y: 27940 },
  { key: "iso_a4_210x297mm", x: 21000, y: 29700 },
  { key: "iso_a3_297x420mm", x: 29700, y: 42000 },
] as const;

/** none, staple, staple-top-left, staple-top-right, saddle-stitch, booklet-maker. */
export const FINISHINGS_SUPPORTED = [3, 4, 20, 22, 8, 13] as const;

type MediaSize = (typeof MEDIA_SIZES)[number];

function mediaCol(s: MediaSize): IppAttr[] {
  return [
    {
      name: "media-size",
      tag: TAG.begCollection,
      values: [
        [
          { name: "x-dimension", tag: TAG.integer, values: [s.x] },
          { name: "y-dimension", tag: TAG.integer, values: [s.y] },
        ],
      ],
    },
  ];
}

export interface PrinterAttrsInput {
  /** Public base, e.g. https://u-<token>.szvtech.org (scheme from X-Forwarded-Proto, host from Host). */
  baseUrl: string;
  printerName: string;
  /** Stable per device; only hashed into printer-uuid. */
  uuidSeed: string;
  startedAt: number;
  now?: Date;
}

export function uuidFromSeed(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function buildPrinterAttributes(input: PrinterAttrsInput): IppAttr[] {
  const now = input.now ?? new Date();
  const uri = `${input.baseUrl}/ipp/print`;
  const secure = uri.startsWith("https");
  const dpi600 = { x: 600, y: 600, units: 3 };
  const letter = MEDIA_SIZES[0];
  return [
    attr(TAG.uri, "printer-uri-supported", uri),
    attr(TAG.keyword, "uri-security-supported", secure ? "tls" : "none"),
    attr(TAG.keyword, "uri-authentication-supported", "none"),
    attr(TAG.name, "printer-name", input.printerName),
    attr(TAG.text, "printer-info", "Printio cloud print"),
    attr(TAG.text, "printer-location", ""),
    attr(TAG.text, "printer-make-and-model", "Printio Cloud Print"),
    attr(TAG.text, "printer-device-id", "MFG:Printio;MDL:Cloud Print;CMD:PDF;"),
    attr(TAG.uri, "printer-uuid", uuidFromSeed(input.uuidSeed)),
    attr(TAG.enum, "printer-state", 3),
    attr(TAG.keyword, "printer-state-reasons", "none"),
    attr(TAG.boolean, "printer-is-accepting-jobs", true),
    attr(TAG.integer, "queued-job-count", 0),
    attr(TAG.integer, "printer-up-time", Math.floor((now.getTime() - input.startedAt) / 1000) + 1),
    attr(TAG.dateTime, "printer-current-time", now),
    attr(TAG.keyword, "ipp-versions-supported", "1.1", "2.0"),
    attr(TAG.keyword, "ipp-features-supported", "ipp-everywhere"),
    attr(TAG.enum, "operations-supported", ...Object.values(OP)),
    attr(TAG.charset, "charset-configured", "utf-8"),
    attr(TAG.charset, "charset-supported", "utf-8"),
    attr(TAG.language, "natural-language-configured", "en"),
    attr(TAG.language, "generated-natural-language-supported", "en"),
    attr(TAG.mime, "document-format-default", DOCUMENT_FORMATS[0] as string),
    attr(TAG.mime, "document-format-supported", ...DOCUMENT_FORMATS),
    attr(TAG.keyword, "pdl-override-supported", "attempted"),
    attr(TAG.keyword, "compression-supported", "none"),
    attr(TAG.boolean, "multiple-document-jobs-supported", false),
    attr(TAG.integer, "copies-default", 1),
    attr(TAG.range, "copies-supported", [1, 99]),
    attr(TAG.keyword, "sides-default", "one-sided"),
    attr(TAG.keyword, "sides-supported", "one-sided", "two-sided-long-edge", "two-sided-short-edge"),
    attr(TAG.enum, "orientation-requested-default", 3),
    attr(TAG.enum, "orientation-requested-supported", 3, 4, 5, 6),
    attr(TAG.enum, "print-quality-default", 4),
    attr(TAG.enum, "print-quality-supported", 4),
    attr(TAG.keyword, "print-color-mode-default", "monochrome"),
    attr(TAG.keyword, "print-color-mode-supported", "monochrome"),
    attr(TAG.keyword, "print-scaling-default", "auto"),
    attr(TAG.keyword, "print-scaling-supported", "auto", "fit", "fill", "none"),
    attr(TAG.boolean, "page-ranges-supported", true),
    attr(TAG.integer, "number-up-default", 1),
    attr(TAG.integer, "number-up-supported", 1),
    // Only finishings the website maps AND the printer is proven to deliver (apps/web/lib/gateway/ipp-choices.ts,
    // docs/kyocera-raw-print.md). RFC 8011 / PWG 5100.1 values: 3 none, 4 staple, 20 staple-top-left,
    // 22 staple-top-right, 8 saddle-stitch, 13 booklet-maker. NOT advertised on purpose: 21 bottom-left (no
    // storage for it yet), 28-31 dual staples, punch, fold - the dialog must not offer what cannot be delivered.
    // UNVERIFIED: which of these Windows 11 / Android actually draw in their dialog (nothing is captured yet; the
    // OS may show only some, or only the generic "staple"). Whatever arrives that is not listed is held, never guessed.
    attr(TAG.enum, "finishings-default", 3),
    attr(TAG.enum, "finishings-supported", ...FINISHINGS_SUPPORTED),
    attr(TAG.resolution, "printer-resolution-default", dpi600),
    attr(TAG.resolution, "printer-resolution-supported", dpi600),
    attr(TAG.keyword, "media-default", letter.key),
    attr(TAG.keyword, "media-supported", ...MEDIA_SIZES.map((s) => s.key)),
    attr(TAG.keyword, "media-ready", letter.key),
    attr(TAG.begCollection, "media-col-default", mediaCol(letter)),
    attr(TAG.begCollection, "media-col-ready", mediaCol(letter)),
    attr(TAG.begCollection, "media-col-database", ...MEDIA_SIZES.map(mediaCol)),
    attr(TAG.keyword, "media-col-supported", "media-size"),
    attr(
      TAG.keyword,
      "job-creation-attributes-supported",
      "copies",
      "sides",
      "media",
      "media-col",
      "orientation-requested",
      "print-quality",
      "print-color-mode",
      "print-scaling",
      "page-ranges",
      "printer-resolution",
      "finishings",
    ),
    attr(TAG.resolution, "pwg-raster-document-resolution-supported", { x: 300, y: 300, units: 3 }, dpi600),
    attr(TAG.keyword, "pwg-raster-document-type-supported", "sgray_8"),
    attr(TAG.keyword, "pwg-raster-document-sheet-back", "normal"),
  ];
}

/** Filter by requested-attributes, same rule as the spike ("all" / group names return everything). */
export function filterRequested(attrs: IppAttr[], requested: string | string[] | undefined): IppAttr[] {
  if (requested === undefined) return attrs;
  const set = new Set(([] as string[]).concat(requested));
  const all = ["all", "printer-description", "job-template"].some((k) => set.has(k));
  return all ? attrs : attrs.filter((a) => set.has(a.name));
}
