import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeAbiChanged, readRecordedAbi, recordedAbiFile } from "@/server/node-abi";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-abi-"));

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

describe("Node ABI guard (PLAN.md B11)", () => {
  it("reads the record written by setup.bat / update.bat", () => {
    expect(readRecordedAbi(write("a", "137\n"))).toBe("137");
    expect(readRecordedAbi(write("b", "  137  \r\n"))).toBe("137");
  });

  it("treats a missing or unreadable record as no record", () => {
    expect(readRecordedAbi(path.join(dir, "does-not-exist"))).toBeNull();
    expect(readRecordedAbi(write("c", ""))).toBeNull();
    expect(readRecordedAbi(write("d", "not a number"))).toBeNull();
  });

  it("only blocks when a record exists and differs", () => {
    expect(nodeAbiChanged("137", "137")).toBe(false);
    expect(nodeAbiChanged(null, "137")).toBe(false);
    expect(nodeAbiChanged("137", "141")).toBe(true);
    expect(nodeAbiChanged(readRecordedAbi(write("e", `${process.versions.modules}\n`)))).toBe(false);
  });

  it("looks in data\\.node-abi under the app folder", () => {
    expect(recordedAbiFile("C:\\outreach")).toBe(path.join("C:\\outreach", "data", ".node-abi"));
  });
});
