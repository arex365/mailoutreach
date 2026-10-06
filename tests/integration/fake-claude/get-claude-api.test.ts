import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * M5-DESIGN §3.5.2, §7.2, §7.4: getClaudeApi reads the saved key and refuses the practice copy, a missing, unreadable
 * or mismatched key; connectFakeClaude points the app at the fake with the test key.
 */

const t = await createTestDb("claude-api");
const { getClaudeApi, anthropicSecrets, CLAUDE_NOT_READY_TEXT, ANTHROPIC_HOST } = await import("@/server/anthropic");
const { setSecret, deleteSecret } = await import("@/server/secrets");
const { setSetting } = await import("@/server/settings");
const { db, dbWrite } = await import("@/server/db");
const { buildLineRequest } = await import("@/core/ai/request");
const { readLineAnswer } = await import("@/core/ai/parse");
const { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile } = await import("@/core/ai/types");
const { connectFakeClaude } = await import("../helpers/claude");

const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
const INPUT = {
  company: { name: "Figuren Werkstatt", country: "Germany", niche: null },
  pages: [{ source: "homepage" as const, url: "https://unknown.example/", lang: "en", title: "Figures", text: "Hand-painted resin figures for fantasy wargames and dioramas." }],
};

beforeAll(async () => {
  await setSetting("practice.copy", false, null);
});
// Disconnect first: on Windows an open connection keeps the database file (and its -wal/-shm) from being deleted.
afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("getClaudeApi", () => {
  it("no key saved → no-key, and no secrets to redact", async () => {
    await deleteSecret("anthropic.apiKey");
    expect(await getClaudeApi()).toEqual({ ok: false, reason: "no-key", text: "Add your Anthropic API key in Settings › AI first." });
    expect(await anthropicSecrets()).toEqual([]);
  });

  it("the practice copy never talks to Anthropic, even with a key", async () => {
    await setSecret("anthropic.apiKey", "sk-ant-fake-key", null);
    await setSetting("practice.copy", true, null);
    try {
      expect(await getClaudeApi()).toEqual({ ok: false, reason: "practice-copy", text: CLAUDE_NOT_READY_TEXT["practice-copy"] });
      expect(CLAUDE_NOT_READY_TEXT["practice-copy"]).toBe("The practice copy never talks to Anthropic.");
    } finally {
      await setSetting("practice.copy", false, null);
    }
  });

  it("a key that can't be decrypted → unreadable", async () => {
    await dbWrite((c) =>
      c.secret.upsert({
        where: { key: "anthropic.apiKey" },
        create: { key: "anthropic.apiKey", ciphertext: "v1:bad:bad:bad", last4: "xxxx" },
        update: { ciphertext: "v1:bad:bad:bad" },
      }),
    );
    expect(await getClaudeApi()).toEqual({ ok: false, reason: "unreadable", text: CLAUDE_NOT_READY_TEXT.unreadable });
    expect(await anthropicSecrets()).toEqual([]);
  });

  it("a real key while the app talks to the fake → mismatch (the key is never sent)", async () => {
    await setSecret("anthropic.apiKey", "sk-ant-api03-a-real-looking-key", null);
    const res = await getClaudeApi();
    expect(res).toEqual({ ok: false, reason: "mismatch", text: CLAUDE_NOT_READY_TEXT.mismatch });
    expect(await anthropicSecrets()).toEqual(["sk-ant-api03-a-real-looking-key"]);
  });

  it("in a test run without the fake it throws instead of reaching Anthropic", async () => {
    const keep = process.env.OUTREACH_ANTHROPIC_BASE_URL;
    delete process.env.OUTREACH_ANTHROPIC_BASE_URL;
    try {
      await setSecret("anthropic.apiKey", "sk-ant-fake-key", null);
      await expect(getClaudeApi()).rejects.toThrow("Test runs must use the fake Claude server");
      expect(ANTHROPIC_HOST).toBe("https://api.anthropic.com");
    } finally {
      process.env.OUTREACH_ANTHROPIC_BASE_URL = keep;
    }
  });
});

describe("connectFakeClaude", () => {
  it("saves the test key, points the app at the fake and puts the setting back on stop", async () => {
    const before = process.env.OUTREACH_ANTHROPIC_BASE_URL;
    const cl = await connectFakeClaude({ sitesDir: null });
    try {
      expect(process.env.OUTREACH_ANTHROPIC_BASE_URL).toBe(cl.fake.origin);
      const res = await getClaudeApi({ timeoutMs: 5_000 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.fakeMode).toBe(true);
      const answer = await res.api.createLine(buildLineRequest(INPUT, haiku));
      expect(readLineAnswer(answer).kind).toBe("ok");
      expect(cl.fake.requests).toHaveLength(1);
      expect(await anthropicSecrets()).toEqual(["sk-ant-fake-key"]);
    } finally {
      await cl.stop();
    }
    expect(process.env.OUTREACH_ANTHROPIC_BASE_URL).toBe(before);
  });

  it("refuses a key that isn't a test key", async () => {
    await expect(connectFakeClaude({ apiKey: "sk-ant-api03-real" })).rejects.toThrow(/sk-ant-fake-/);
  });
});
