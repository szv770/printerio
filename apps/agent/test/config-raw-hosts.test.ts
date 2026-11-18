import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = { PRINTIO_API_URL: "https://printio.example.org" } as NodeJS.ProcessEnv;

describe("PRINTIO_RAW_ALLOWED_HOSTS", () => {
  it("is unset by default", () => {
    expect(loadConfig({ env: base }).rawAllowedHosts).toBeUndefined();
  });
  it("is read as a trimmed, lower-cased list", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_RAW_ALLOWED_HOSTS: " 192.168.100.168 , Printer.LAN " } }).rawAllowedHosts).toEqual(["192.168.100.168", "printer.lan"]);
  });
});

describe("PRINTIO_PRINTER_FEEDBACK", () => {
  it("is ON by default (the owner asked for it; set it to false to switch it off)", () => {
    expect(loadConfig({ env: base }).printerFeedback).toBe(true);
  });
  it("is switched off with false", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_PRINTER_FEEDBACK: "false" } }).printerFeedback).toBe(false);
  });
  it("is switched on with true", () => {
    expect(loadConfig({ env: { ...base, PRINTIO_PRINTER_FEEDBACK: "true" } }).printerFeedback).toBe(true);
  });
});

describe("PRINTIO_LIBRARY_WORKER (the optional library worker, owner's own server only)", () => {
  it("is OFF by default", () => {
    expect(loadConfig({ env: base }).libraryWorker).toBe(false);
  });
  it("only 1 or true switch it on (any case, spaces ignored)", () => {
    for (const v of ["1", "true", "TRUE", " True "]) expect(loadConfig({ env: { ...base, PRINTIO_LIBRARY_WORKER: v } }).libraryWorker, v).toBe(true);
  });
  it("anything else is off, and a typo never stops the agent from starting", () => {
    for (const v of ["", "0", "false", "yes", "on", "2", "enabled"]) expect(loadConfig({ env: { ...base, PRINTIO_LIBRARY_WORKER: v } }).libraryWorker, v).toBe(false);
  });
});
