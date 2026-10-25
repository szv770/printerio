/**
 * Where pdf.js finds its decoders in the browser (copied there by scripts/copy-pdfjs-assets.mjs on every dev/build).
 * Pass this to every client-side `getDocument`. Without `wasmUrl`, pdf.js 6 silently skips JBIG2 and JPEG 2000 images
 * (typical in scanned PDFs), so those pages render as blank white.
 */
export const PDFJS_ASSET_BASE = "/pdfjs";

export function pdfjsAssetOptions(): { wasmUrl: string; iccUrl: string; standardFontDataUrl: string } {
  return {
    wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
    iccUrl: `${PDFJS_ASSET_BASE}/iccs/`,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
  };
}
