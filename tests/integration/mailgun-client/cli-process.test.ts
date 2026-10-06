import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

/**
 * M3-DESIGN §8 P2 "done when": `node scripts/fake-mailgun.mjs --port …` starts and answers GET /__fake/state.
 * Runs the real launcher (tsx loader) on a free port and stops it again.
 */

const children: ChildProcess[] = [];

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
});

function start(args: string[]): { child: ChildProcess; lines: string[] } {
  const child = spawn(process.execPath, ["scripts/fake-mailgun.mjs", ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  const collect = (d: Buffer) => lines.push(...String(d).split(/\r?\n/).filter(Boolean));
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  return { child, lines };
}

async function waitFor(lines: string[], pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  const startAt = Date.now();
  for (;;) {
    for (const l of lines) {
      const m = l.match(pattern);
      if (m) return m;
    }
    if (Date.now() - startAt > timeoutMs) throw new Error(`Timed out waiting for ${pattern}. Output:\n${lines.join("\n")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("scripts/fake-mailgun.mjs", () => {
  it("starts, prints the settings for the app and answers GET /__fake/state", async () => {
    const p = start(["--port", "0", "--domain", "send.example.com", "--api-key", "key-fake-api", "--signing-key", "key-fake-signing"]);
    const m = await waitFor(p.lines, /Set OUTREACH_MAILGUN_BASE_URL=(http:\/\/127\.0\.0\.1:\d+) for the app\. Use API key key-fake-api\./);
    const origin = m[1]!;
    const res = await fetch(`${origin}/__fake/state`);
    expect(res.status).toBe(200);
    const state = (await res.json()) as { domain: { name: string }; signingKey: string };
    expect(state.domain.name).toBe("send.example.com");
    expect(state.signingKey).toBe("key-fake-signing");
    p.child.kill();
  }, 60_000);

  it("refuses bad flags with a plain message", async () => {
    const p = start(["--app", "https://outreach.example.com"]);
    const code = await new Promise<number | null>((r) => p.child.on("exit", (c) => r(c)));
    expect(code).toBe(1);
    expect(p.lines.join("\n")).toMatch(/only posts to this PC/);
  }, 60_000);
});
