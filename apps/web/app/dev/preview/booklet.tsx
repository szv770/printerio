import { PDFDocument, StandardFonts } from "pdf-lib";
import { imposeBookletPdf } from "@/lib/pdf/imposition";
import { BookletPreview } from "@/app/(dashboard)/print/BookletPreview";

/** DEV-ONLY: the booklet preview panel on a generated 8-page, Word-style document (?section=booklet&side=right). */
export async function BookletPreviewSection({ side }: { side: "left" | "right" }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 8; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText("Quarterly report - draft", { x: 72, y: 752, size: 9, font });
    for (let l = 0; l < 44; l++) page.drawText(`Line ${l + 1} of body text on page ${i + 1}.`, { x: 72, y: 712 - l * 14.5, size: 12, font });
    page.drawText(String(i + 1), { x: 306, y: 36, size: 10, font });
  }
  const bytes = await imposeBookletPdf(await doc.save(), { width: 612, height: 792 }, side, { fit: "fill" });
  return (
    <div className="mx-auto max-w-2xl p-4">
      <BookletPreview data={{ pdfBase64: Buffer.from(bytes).toString("base64"), bindingSide: side, sheets: 2, blankPagesAdded: 0 }} />
    </div>
  );
}
