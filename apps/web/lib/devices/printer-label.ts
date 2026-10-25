/** The name a device shows for the printer: Printio-<printer>-<user code>, e.g. Printio-MLMI-SZV. Built on the server
 *  (the gateway only passes it on) so the owner can tell, from any device's printer list, which printer and whose
 *  address it is. Only letters, digits and dashes, at most 63 characters. */
const MAX = 63;

function part(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function devicePrinterLabel(printerName: string | null | undefined, userCode: string | null | undefined): string {
  const code = part(userCode).toUpperCase();
  const prefix = "Printio";
  let printer = part(printerName);
  const fixed = prefix.length + (code ? code.length + 1 : 0) + (printer ? 1 : 0);
  if (printer && fixed + printer.length > MAX) printer = printer.slice(0, Math.max(0, MAX - fixed)).replace(/-+$/, "");
  return [prefix, printer, code].filter(Boolean).join("-");
}
