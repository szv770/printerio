// The worker entry ships without types; it is only handed to pdfjs as globalThis.pdfjsWorker (content-analysis.ts, text-fidelity.ts, type3-rasterize.ts; they reference this file so any project that compiles them sees it).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
