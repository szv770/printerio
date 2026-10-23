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
