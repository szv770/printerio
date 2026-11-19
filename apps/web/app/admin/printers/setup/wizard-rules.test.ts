import { describe, expect, it } from "vitest";
import { allQueuesChosen, queueEntryMode, serverStatusNote } from "./wizard-rules";

describe("queueEntryMode", () => {
  it("raw-port printers never need a Windows queue", () => {
    expect(queueEntryMode(true, 0)).toBe("raw");
    expect(queueEntryMode(true, 5)).toBe("raw");
  });
  it("picks from the list when the print server reported queues", () => {
    expect(queueEntryMode(false, 2)).toBe("pick");
  });
  it("lets the admin type the queue name when nothing was reported (print server offline or brand new)", () => {
    expect(queueEntryMode(false, 0)).toBe("type");
  });
});

describe("serverStatusNote", () => {
  it("is ready with an online server", () => {
    expect(serverStatusNote(1, 1)).toEqual({ tone: "ready", text: "1 print server online and ready." });
    expect(serverStatusNote(2, 3).text).toBe("2 print servers online and ready.");
  });
  it("is only a note, never a blocker, with no server online", () => {
    const none = serverStatusNote(0, 0);
    expect(none.tone).toBe("waiting");
    expect(none.text).toContain("none registered yet");
    expect(none.text).toContain("you can finish setting up now");
    const offline = serverStatusNote(0, 2);
    expect(offline.text).toContain("2 registered, none connected right now");
  });
});

describe("allQueuesChosen", () => {
  const cardKeys = ["single", "booklet"];
  it("typed queue names are required for every card, and blank spaces do not count", () => {
    const base = { mode: "type" as const, cardKeys, rawHostValid: false, rawPortOk: false };
    expect(allQueuesChosen({ ...base, queueByCardKey: {} })).toBe(false);
    expect(allQueuesChosen({ ...base, queueByCardKey: { single: "KX Single", booklet: "   " } })).toBe(false);
    expect(allQueuesChosen({ ...base, queueByCardKey: { single: "KX Single", booklet: "KX Booklet" } })).toBe(true);
  });
  it("a picked queue works the same way", () => {
    expect(allQueuesChosen({ mode: "pick", cardKeys, queueByCardKey: { single: "A", booklet: "B" }, rawHostValid: false, rawPortOk: false })).toBe(true);
    expect(allQueuesChosen({ mode: "pick", cardKeys, queueByCardKey: { single: "A" }, rawHostValid: false, rawPortOk: false })).toBe(false);
  });
  it("raw mode only needs a valid host and port, no queue names", () => {
    expect(allQueuesChosen({ mode: "raw", cardKeys, queueByCardKey: {}, rawHostValid: true, rawPortOk: true })).toBe(true);
    expect(allQueuesChosen({ mode: "raw", cardKeys, queueByCardKey: {}, rawHostValid: false, rawPortOk: true })).toBe(false);
    expect(allQueuesChosen({ mode: "raw", cardKeys, queueByCardKey: {}, rawHostValid: true, rawPortOk: false })).toBe(false);
  });
});
