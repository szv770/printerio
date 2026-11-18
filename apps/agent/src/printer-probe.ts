import net from "node:net";
import { parsePjlInfoStatus, type PrinterProbeFacts } from "@printio/shared";

/**
 * Asks a direct-port printer how it is, so Printio can tell people when a job is waiting because the printer needs
 * something (paper, a jam, a door). It sends ONLY the status question (`@PJL INFO STATUS`), never anything that could
 * print or change a setting, and it never throws: a printer that cannot be reached is a normal answer.
 */

const UEL = "\x1b%-12345X";
const QUESTION = `${UEL}@PJL\r\n@PJL INFO STATUS\r\n${UEL}`;
export const PROBE_TIMEOUT_MS = 4000;

export async function probePrinter(target: { host: string; port: number }, opts: { timeoutMs?: number } = {}): Promise<PrinterProbeFacts> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let reachable = false;
    let text = "";
    let done = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const parsed = parsePjlInfoStatus(text);
      resolve(parsed ? { reachable: true, answered: true, ...parsed } : { reachable, answered: false });
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on("connect", () => {
      reachable = true;
      socket.write(QUESTION, "latin1");
    });
    socket.on("data", (d) => {
      text += d.toString("latin1");
      // The answer ends with a form feed; the ONLINE line is its last part.
      if (/ONLINE\s*=\s*(TRUE|FALSE)/i.test(text) || text.includes("\f")) finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}
