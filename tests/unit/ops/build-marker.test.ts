import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDecision,
  collectBuildEntries,
  computeBuildHash,
  readBuildMarker,
  writeBuildMarker,
} from "../../../scripts/lib/build-marker.mjs";

let root = "";

beforeAll(() => {
  root = path.resolve("data", "test", `build-marker-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "generated", "prisma"), { recursive: true });
  fs.mkdirSync(path.join(root, "prisma"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "prisma", "schema.prisma"), "model A { id Int @id }");
  fs.writeFileSync(path.join(root, "src", "app", "page.tsx"), "export default 1;");
  fs.writeFileSync(path.join(root, "src", "generated", "prisma", "client.ts"), "generated");
  fs.writeFileSync(path.join(root, "src", "node_modules", "x.js"), "ignored");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("build fingerprint", () => {
  it("lists the build inputs but not generated code or node_modules", () => {
    const entries = collectBuildEntries(root).map((e: string) => e.split("|")[0]);
    expect(entries).toEqual(["package-lock.json", "prisma/schema.prisma", "src/app/page.tsx"]);
  });

  it("is stable while nothing changes", () => {
    expect(computeBuildHash(root)).toBe(computeBuildHash(root));
  });

  it("changes when a source file changes size or time", () => {
    const before = computeBuildHash(root);
    const file = path.join(root, "src", "app", "page.tsx");
    fs.writeFileSync(file, "export default 22;");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(computeBuildHash(root)).not.toBe(before);
  });

  it("changes when a file is added (a new worker file, for example)", () => {
    const before = computeBuildHash(root);
    fs.mkdirSync(path.join(root, "worker"), { recursive: true });
    fs.writeFileSync(path.join(root, "worker", "index.ts"), "run()");
    expect(computeBuildHash(root)).not.toBe(before);
  });

  it("ignores changes to generated code", () => {
    const before = computeBuildHash(root);
    fs.writeFileSync(path.join(root, "src", "generated", "prisma", "client.ts"), "regenerated with more text");
    expect(computeBuildHash(root)).toBe(before);
  });

  it("changes when the public address changes (it's baked into the build)", () => {
    expect(computeBuildHash(root, { publicUrl: "https://a.example.com" })).not.toBe(computeBuildHash(root, { publicUrl: "" }));
  });

  it("round-trips the marker file", () => {
    const marker = path.join(root, ".next", "outreach-build.json");
    expect(readBuildMarker(marker)).toBeNull();
    writeBuildMarker(marker, "abc", { node: "24.21.0" });
    expect(readBuildMarker(marker)).toMatchObject({ hash: "abc", node: "24.21.0" });
    fs.writeFileSync(marker, "not json");
    expect(readBuildMarker(marker)).toBeNull();
  });
});

describe("buildDecision", () => {
  const fresh = { buildIdExists: true, workerBundleExists: true, workerBuildScriptExists: true, marker: { hash: "h" }, currentHash: "h" };

  it("needs nothing when everything matches", () => {
    expect(buildDecision(fresh)).toEqual({ needed: false, reason: null });
  });

  it("builds when there's no build yet", () => {
    expect(buildDecision({ ...fresh, buildIdExists: false })).toEqual({ needed: true, reason: "missing" });
  });

  it("builds when the background sender bundle is missing", () => {
    expect(buildDecision({ ...fresh, workerBundleExists: false })).toEqual({ needed: true, reason: "worker-missing" });
    // …unless the project has no worker build step at all.
    expect(buildDecision({ ...fresh, workerBundleExists: false, workerBuildScriptExists: false }).needed).toBe(false);
  });

  it("builds when the fingerprint differs or the marker is missing", () => {
    expect(buildDecision({ ...fresh, currentHash: "other" })).toEqual({ needed: true, reason: "changed" });
    expect(buildDecision({ ...fresh, marker: null })).toEqual({ needed: true, reason: "changed" });
  });
});
