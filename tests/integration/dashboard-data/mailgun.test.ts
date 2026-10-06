import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";

/**
 * "Is Mailgun set up?" for the dashboard (M6-DESIGN §4.6, §0.2 rule 8, critique R8): real data, a sending domain and a
 * Mailgun API key row. It never decrypts a key and never writes (getMailgunContext does both, so the dashboard can't
 * use it).
 */

const spies = vi.hoisted(() => ({ getSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock("@/server/secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/secrets")>();
  spies.getSecret.mockImplementation(actual.getSecret);
  spies.decryptSecret.mockImplementation(actual.decryptSecret);
  return { ...actual, getSecret: spies.getSecret, decryptSecret: spies.decryptSecret };
});

const t = await createTestDb("dashboard-mailgun");
const { db, dbWrite } = await import("@/server/db");
const { setSetting } = await import("@/server/settings");
// Loaded here so the spies are the module's functions for anything that imports it (none should call them).
const secrets = await import("@/server/secrets");
const { mailgunConfigured } = await import("@/server/services/dashboard/mailgun");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  await dbWrite(async (c) => {
    await c.secret.deleteMany({});
    await c.setting.deleteMany({});
    await c.sendingDomain.deleteMany({});
  });
  spies.getSecret.mockClear();
  spies.decryptSecret.mockClear();
});

/** A Secret row as setSecret stores it; the ciphertext is never read here, so any text will do. */
async function keyRow(key: string, ciphertext = "v1:not:a:real-key") {
  await dbWrite((c) => c.secret.create({ data: { key, ciphertext, last4: "1234" } }));
}

describe("mailgunConfigured", () => {
  it("is false without a domain or without a key row", async () => {
    expect(await mailgunConfigured()).toBe(false);
    await setSetting("mailgun.domain", "send.example.com", null);
    expect(await mailgunConfigured()).toBe(false);
    // Another key doesn't count.
    await keyRow("mailgun.sendingKey");
    await keyRow("verification.apiKey");
    expect(await mailgunConfigured()).toBe(false);
  });

  it("is true with a domain and a Mailgun API key row, without reading the key", async () => {
    await keyRow("mailgun.apiKey");
    expect(await mailgunConfigured()).toBe(false); // no domain yet
    await setSetting("mailgun.domain", "  ", null);
    expect(await mailgunConfigured()).toBe(false); // a blank domain isn't one
    await setSetting("mailgun.domain", "send.example.com", null);
    expect(await mailgunConfigured()).toBe(true);
    // The stored text isn't a key anyone could decrypt: it was never read.
    expect(secrets.getSecret).toBe(spies.getSecret);
    expect(spies.getSecret).not.toHaveBeenCalled();
    expect(spies.decryptSecret).not.toHaveBeenCalled();
    // (The spy works: reading the key for real would decrypt it, and this one can't be.)
    await expect(secrets.getSecret("mailgun.apiKey")).rejects.toThrow();
    expect(spies.getSecret).toHaveBeenCalledTimes(1);
  });

  it("is false in the practice copy", async () => {
    await keyRow("mailgun.apiKey");
    await setSetting("mailgun.domain", "send.example.com", null);
    await setSetting("practice.copy", true, null);
    expect(await mailgunConfigured()).toBe(false);
  });

  it("writes nothing (getMailgunContext would add the missing SendingDomain row)", async () => {
    await keyRow("mailgun.apiKey");
    await setSetting("mailgun.domain", "send.example.com", null);
    const before = await Promise.all([db.sendingDomain.count(), db.setting.count(), db.secret.count(), db.systemState.count()]);
    expect(await mailgunConfigured()).toBe(true);
    expect(await Promise.all([db.sendingDomain.count(), db.setting.count(), db.secret.count(), db.systemState.count()])).toEqual(before);
    expect(before[0]).toBe(0);
  });
});
