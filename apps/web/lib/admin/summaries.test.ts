import { describe, expect, it } from "vitest";
import {
  agentCommandsSummary,
  agentMachineSummary,
  agentQueuesSummary,
  agentVersionSummary,
  deviceTone,
  printerNeedsAttention,
  printerSummary,
  printerTone,
  queueCountLabel,
} from "./summaries";

describe("printers", () => {
  it("maps status to a dot tone", () => {
    expect(printerTone("online")).toBe("success");
    expect(printerTone("error")).toBe("danger");
    expect(printerTone("offline")).toBe("neutral");
    expect(printerTone("unknown")).toBe("warning");
    expect(printerTone("weird")).toBe("neutral");
  });
  it("opens a card only for a printer that reports an error", () => {
    expect(printerNeedsAttention("error")).toBe(true);
    expect(printerNeedsAttention("online")).toBe(false);
    expect(printerNeedsAttention("offline")).toBe(false);
  });
  it("counts queues in plain words", () => {
    expect(queueCountLabel(0)).toBe("No queues yet");
    expect(queueCountLabel(1)).toBe("1 queue");
    expect(queueCountLabel(3)).toBe("3 queues");
  });
  it("writes the closed one-liner", () => {
    expect(printerSummary({ status: "online", queues: 2, serverName: "MLM Office" })).toBe("Online, 2 queues, server MLM Office");
    expect(printerSummary({ status: "error", queues: 0, serverName: null })).toBe("Has a problem, no queues yet");
    expect(printerSummary({ status: "unknown", queues: 1, serverName: null })).toBe("Not reported yet, 1 queue");
  });
});

describe("print server summaries", () => {
  it("machine", () => {
    expect(agentMachineSummary({ os_version: "Windows 11", hostname: "MLM Office" })).toBe("Windows 11, MLM Office");
    expect(agentMachineSummary({ os_version: null, hostname: null })).toBe("Not reported yet");
    expect(agentMachineSummary({ os_version: null, hostname: "PC1" })).toBe("PC1");
  });
  it("version", () => {
    expect(agentVersionSummary({ reported: "1.4.0", state: "current" })).toBe("1.4.0, up to date");
    expect(agentVersionSummary({ reported: "1.3.0", state: "outdated" })).toBe("1.3.0, update available");
    expect(agentVersionSummary({ reported: null, state: "unknown" })).toBe("Not reported yet");
  });
  it("queues", () => {
    expect(agentQueuesSummary(2)).toBe("2 queues");
    expect(agentQueuesSummary(0)).toBe("No queues yet");
  });
  it("commands", () => {
    expect(agentCommandsSummary([])).toBe("Nothing sent yet");
    expect(agentCommandsSummary([{ command: "CHECK_FOR_UPDATE", status: "completed" }])).toBe("Last: Update server, done");
    expect(agentCommandsSummary([{ command: "RESTART_SERVICE", status: "failed" }])).toBe("Last: Restart service, failed");
    expect(agentCommandsSummary([{ command: "CLEAR_TEMP_FILES", status: "pending" }])).toBe("Last: Clear temp files, waiting");
  });
});

describe("deviceTone", () => {
  it("highlights open problems first", () => {
    expect(deviceTone({ statusKey: "printed", openIssues: 1, stuck: null })).toBe("danger");
    expect(deviceTone({ statusKey: "connected", openIssues: 0, stuck: "connected_no_job" })).toBe("warning");
    expect(deviceTone({ statusKey: "printed", openIssues: 0, stuck: null })).toBe("success");
    expect(deviceTone({ statusKey: "revoked", openIssues: 0, stuck: null })).toBe("neutral");
    expect(deviceTone({ statusKey: "created", openIssues: 0, stuck: null })).toBe("neutral");
  });
});
