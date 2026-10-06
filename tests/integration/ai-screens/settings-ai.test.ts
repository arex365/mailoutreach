import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { connectFakeClaude, type FakeClaudeConnection } from "../helpers/claude";
import { makeAiJob, makeCompany, makeDraft, seedSessionUsers, type TestUser } from "./seed";

/**
 * Settings › AI against the fake Claude (docs/dev/M5-DESIGN.md §3.11, §6.9, §8 P9): save key (works, 401, works but
 * the model is unknown, Anthropic unreachable), remove key, the model radios' amounts, another model (works, no
 * structured outputs, unknown, missing or 0 prices, no key yet), the limit (lifting a monthly pause), the prices (0 and
 * 5,000 refused, saving lifts a no-price pause), the practice copy (key and model saves refused, the fake gets nothing)
 * and Members refused for every action. Nothing leaves the PC: the fake runs on 127.0.0.1.
 */

const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction: async () => {
      const user = await requireUserAction();
      if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
      return user;
    },
  };
});

const t = await createTestDb("ai-screens-settings");
const { db, dbWrite } = await import("@/server/db");
const { getSettings, setSetting, SETTING_DEFAULTS } = await import("@/server/settings");
const { deleteSecret, getSecret, secretInfo, setSecret } = await import("@/server/secrets");
const { STATE_KEYS } = await import("@/core/system-state");
const { getAiPause, pauseAi } = await import("@/server/services/ai/pause");
const { loadAiSettings } = await import("@/server/services/ai/settings");
const actions = await import("@/app/(app)/settings/ai/actions");

let owner: TestUser;
let ali: TestUser;
let cl: FakeClaudeConnection;

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const status = (code: number, type: string, message: string) => ({
  kind: "status" as const,
  status: code,
  body: { type: "error", error: { type, message } },
});
const modelRequests = () => cl.fake.requests.filter((r) => r.method === "GET" && r.path.startsWith("/v1/models/"));

beforeAll(async () => {
  ({ owner, ali } = await seedSessionUsers());
  cl = await connectFakeClaude();
});

afterAll(async () => {
  await cl.stop();
  await db.$disconnect();
  t.cleanup();
});

beforeEach(async () => {
  auth.user = owner;
  cl.fake.reset();
  await dbWrite(async (c) => {
    await c.aiDraft.deleteMany({});
    await c.job.deleteMany({});
    await c.activityLog.deleteMany({});
    await c.notification.deleteMany({});
    await c.company.deleteMany({});
    await c.setting.deleteMany({ where: { key: { in: ["ai.model", "ai.customModel", "ai.prices", "ai.monthlyLimitUsd", "practice.copy"] } } });
    await c.systemState.deleteMany({ where: { key: { in: [STATE_KEYS.aiPause, STATE_KEYS.notices] } } });
  });
  await setSecret("anthropic.apiKey", cl.apiKey, owner.id);
});

describe("the Anthropic key", () => {
  it("a key that works with the current model is saved", async () => {
    await deleteSecret("anthropic.apiKey");
    const res = await actions.saveAnthropicKeyAction({ key: "  sk-ant-fake-new-key-1234​ " });
    expect(res).toEqual({ ok: true, data: { warning: false }, message: "Key saved. It works with Claude Haiku 4.5." });
    expect(await getSecret("anthropic.apiKey")).toBe("sk-ant-fake-new-key-1234");
    expect(modelRequests().map((r) => r.path)).toEqual([`/v1/models/${HAIKU}`]);
    expect(modelRequests()[0]!.headers["x-api-key"]).toBe("[hidden]");
    const activity = await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } });
    expect(activity.summary).toBe("Arslan saved a new Anthropic API key");
    expect(JSON.stringify(activity.data)).not.toContain("sk-ant-");
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.key.set).toBe(true);
    expect(view.key.line).toMatch(/^Key ending …1234, saved \d{1,2} \w{3,4} by Arslan\.$/);
    expect(view.key.problem).toBeNull();
  });

  it("a key Anthropic refuses (401) isn't saved", async () => {
    cl.fake.failNext("GET /v1/models/:id", status(401, "authentication_error", "invalid x-api-key"));
    const res = await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-refused-0000" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("Anthropic didn't accept this key. In the Anthropic Console, open API keys, create a key and paste it here.");
      expect(res.fieldErrors?.key?.[0]).toBe(res.error);
    }
    expect(await getSecret("anthropic.apiKey")).toBe(cl.apiKey);
  });

  it("a key that works but can't use the current model is saved with the warning", async () => {
    cl.fake.failNext("GET /v1/models/:id", status(404, "not_found_error", `model: ${HAIKU}`));
    const res = await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-no-haiku-000" });
    expect(res).toEqual({
      ok: true,
      data: { warning: true },
      message: "The key works, but Anthropic doesn't let it use Claude Haiku 4.5. Pick another model below.",
    });
    expect(await getSecret("anthropic.apiKey")).toBe("sk-ant-fake-no-haiku-000");
  });

  it("Anthropic can't be reached: nothing saved", async () => {
    cl.fake.failNext("GET /v1/models/:id", status(500, "api_error", "Internal server error"), 3);
    const res = await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-unreached-00" });
    expect(res).toEqual({ ok: false, error: "Couldn't reach Anthropic. Check this PC's internet connection and try again." });
    expect(await getSecret("anthropic.apiKey")).toBe(cl.apiKey);
  });

  it("a real key is never sent to the test server; an empty or odd one is refused before anything is sent", async () => {
    const real = await actions.saveAnthropicKeyAction({ key: "sk-ant-api03-realkey-00000000" });
    expect(real).toMatchObject({ ok: false, error: "The fake Claude server only takes test keys (sk-ant-fake-…). A real key is never sent to it." });
    expect(await actions.saveAnthropicKeyAction({ key: "   " })).toMatchObject({ ok: false, error: "Paste the API key from the Anthropic Console first." });
    expect(await actions.saveAnthropicKeyAction({ key: "sk ant with spaces" })).toMatchObject({
      ok: false,
      error: "That doesn't look like an API key. Copy it again from the Anthropic Console.",
    });
    expect(cl.fake.requests).toHaveLength(0);
  });

  it("saving a key lifts a key pause", async () => {
    await pauseAi("key_rejected", { text: "AI drafting paused: Anthropic didn't accept the API key.", until: null });
    const res = await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-fixed-key-00" });
    expect(res).toMatchObject({ ok: true, message: "Key saved. It works with Claude Haiku 4.5. AI drafting resumed." });
    expect((await getAiPause()).paused).toBe(false);
  });

  it("Remove key", async () => {
    const res = await actions.removeAnthropicKeyAction();
    expect(res).toEqual({ ok: true, data: null, message: "The Anthropic key is removed. AI drafting waits until a new key is saved." });
    expect((await secretInfo("anthropic.apiKey")).set).toBe(false);
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } })).summary).toBe("Arslan removed the Anthropic API key");
    expect((await loadAiSettings("Europe/Berlin")).key).toEqual({
      set: false,
      line: "No key saved yet. In the Anthropic Console, open API keys, create a key and paste it here.",
      problem: null,
    });
  });
});

describe("the model", () => {
  it("the radios say what 300 companies cost with this app's estimate", async () => {
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.radios).toEqual({
      haiku: "Claude Haiku 4.5 (recommended): low cost, about $1.69 per 300 companies",
      sonnet: "Claude Sonnet 5: better at spotting specific details, about $5.91 per 300 companies",
    });
    expect(view.model).toEqual({ id: HAIKU, choice: "haiku", label: "Claude Haiku 4.5" });
    expect(view.prices).toEqual([
      { id: HAIKU, label: "Claude Haiku 4.5", inputPerMTok: 1, outputPerMTok: 5 },
      { id: SONNET, label: "Claude Sonnet 5", inputPerMTok: 2, outputPerMTok: 10 },
    ]);
    // New prices change the amount.
    await setSetting("ai.prices", { ...SETTING_DEFAULTS["ai.prices"], [HAIKU]: { inputPerMTok: 2, outputPerMTok: 10 } }, owner.id);
    expect((await loadAiSettings("Europe/Berlin")).radios.haiku).toBe("Claude Haiku 4.5 (recommended): low cost, about $3.38 per 300 companies");
  });

  it("Sonnet 5 is saved without a call; a waiting run hears it goes on with it; a model pause lifts", async () => {
    await makeAiJob("QUEUED");
    await pauseAi("model_not_found", { text: `AI drafting paused: Anthropic doesn't know the model “${HAIKU}”.`, until: null, model: HAIKU });
    const res = await actions.saveAiModelAction({ choice: "sonnet" });
    expect(res).toEqual({ ok: true, data: null, message: "Model saved. Drafting that's waiting uses it from now on." });
    expect((await getSettings(["ai.model"] as const))["ai.model"]).toBe(SONNET);
    expect(cl.fake.requests).toHaveLength(0);
    expect((await getAiPause()).paused).toBe(false);
    expect((await db.activityLog.findFirstOrThrow({ where: { type: "settings.updated" } })).summary).toBe("Arslan set the AI model to Claude Sonnet 5");
    expect(await actions.saveAiModelAction({ choice: "haiku" })).toMatchObject({ ok: true });
  });

  it("another model that works: its profile, prices and label are saved", async () => {
    const res = await actions.saveAiModelAction({ choice: "custom", id: " claude-test-custom ", inputPerMTok: 3, outputPerMTok: 15 });
    expect(res).toEqual({ ok: true, data: null, message: "Model saved." });
    const s = await getSettings(["ai.model", "ai.customModel", "ai.prices"] as const);
    expect(s["ai.model"]).toBe("claude-test-custom");
    expect(s["ai.customModel"]).toMatchObject({ id: "claude-test-custom", label: "Claude Test Custom", maxTokens: 8_192, effortLow: true });
    expect(s["ai.prices"]["claude-test-custom"]).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(modelRequests().map((r) => r.path)).toEqual(["/v1/models/claude-test-custom"]);
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.model).toEqual({ id: "claude-test-custom", choice: "custom", label: "Claude Test Custom" });
    expect(view.custom).toEqual({ id: "claude-test-custom", label: "Claude Test Custom", inputPerMTok: 3, outputPerMTok: 15 });
    expect(view.prices.map((p) => p.id)).toEqual([HAIKU, SONNET, "claude-test-custom"]);
  });

  it("another model without structured outputs, or unknown, is refused", async () => {
    const none = await actions.saveAiModelAction({ choice: "custom", id: "claude-test-nostructured", inputPerMTok: 1, outputPerMTok: 5 });
    expect(none).toMatchObject({ ok: false, error: "This model can't return the structured answer the app needs. Pick Claude Haiku 4.5 or Sonnet 5." });
    const unknown = await actions.saveAiModelAction({ choice: "custom", id: "claude-x", inputPerMTok: 1, outputPerMTok: 5 });
    expect(unknown).toMatchObject({ ok: false, error: "Anthropic doesn't know the model “claude-x”, or your account can't use it. Check the spelling." });
    expect((await getSettings(["ai.model"] as const))["ai.model"]).toBe(HAIKU);
  });

  it("another model needs both prices (0.01–1,000) and a saved key, checked before anything is sent", async () => {
    const zero = await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: 0, outputPerMTok: 5 });
    expect(zero).toMatchObject({ ok: false, error: "Enter prices from $0.01 to $1,000 per million tokens." });
    if (!zero.ok) expect(zero.fieldErrors?.inputPerMTok).toEqual(["Enter prices from $0.01 to $1,000 per million tokens."]);
    const missing = await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: Number.NaN, outputPerMTok: 5 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.fieldErrors?.inputPerMTok).toEqual(["Enter prices from $0.01 to $1,000 per million tokens."]);
    expect(await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: 1, outputPerMTok: 5_000 })).toMatchObject({
      ok: false,
      error: "Enter prices from $0.01 to $1,000 per million tokens.",
    });
    expect(await actions.saveAiModelAction({ choice: "custom", id: "not a model id!", inputPerMTok: 1, outputPerMTok: 5 })).toMatchObject({
      ok: false,
      error: "Enter the model ID exactly as Anthropic writes it, for example claude-sonnet-5.",
    });
    await deleteSecret("anthropic.apiKey");
    expect(await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: 1, outputPerMTok: 5 })).toMatchObject({
      ok: false,
      error: "Save your API key first, so the app can check the model.",
    });
    expect(cl.fake.requests).toHaveLength(0);
  });
});

describe("the monthly limit and the prices", () => {
  it("the limit is $1–$1,000; raising it above this month's spend lifts a monthly-limit pause", async () => {
    expect(await actions.saveAiLimitAction({ usd: 0.5 })).toMatchObject({ ok: false, error: "Enter an amount from $1 to $1,000." });
    expect(await actions.saveAiLimitAction({ usd: 5_000 })).toMatchObject({ ok: false, error: "Enter an amount from $1 to $1,000." });
    const companyId = await makeCompany({ name: "Firma GmbH", website: "https://firma.de" });
    await makeDraft({ companyId, status: "APPROVED", calls: 1, costUsd: 20.4, draftedAt: new Date() });
    await pauseAi("monthly_limit", { text: "AI drafting stopped: this month's limit of $20 is reached.", until: new Date(Date.now() + 86_400_000) });

    expect(await actions.saveAiLimitAction({ usd: 15 })).toEqual({ ok: true, data: null, message: "Limit saved." });
    expect((await getAiPause()).paused).toBe(true);
    expect(await actions.saveAiLimitAction({ usd: 25 })).toEqual({ ok: true, data: null, message: "Limit saved. AI drafting resumed." });
    expect((await getAiPause()).paused).toBe(false);
    expect((await getSettings(["ai.monthlyLimitUsd"] as const))["ai.monthlyLimitUsd"]).toBe(25);
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.limit.usd).toBe(25);
    expect(view.limit.spentLine).toMatch(/^Spent in \w+: \$20\.40 of \$25 \(1 draft\)\.$/);
  });

  it("prices: 0 and 5,000 refused; saving them lifts a no-price pause", async () => {
    const zero = await actions.saveAiPricesAction({ prices: { [HAIKU]: { inputPerMTok: 0, outputPerMTok: 5 } } });
    expect(zero).toMatchObject({ ok: false, error: "Enter prices from $0.01 to $1,000 per million tokens." });
    const big = await actions.saveAiPricesAction({ prices: { [SONNET]: { inputPerMTok: 2, outputPerMTok: 5_000 } } });
    expect(big).toMatchObject({ ok: false, error: "Enter prices from $0.01 to $1,000 per million tokens." });
    expect(await actions.saveAiPricesAction({ prices: { "claude-unknown": { inputPerMTok: 1, outputPerMTok: 5 } } })).toMatchObject({
      ok: false,
      error: "The list of models changed. Refresh the page and enter the prices again.",
    });

    await pauseAi("no_price", { text: "AI drafting paused: no price is saved for the model “claude-x”.", until: null, model: "claude-x" });
    const res = await actions.saveAiPricesAction({
      prices: { [HAIKU]: { inputPerMTok: 1.25, outputPerMTok: 6 }, [SONNET]: { inputPerMTok: 2, outputPerMTok: 10 } },
    });
    expect(res).toEqual({ ok: true, data: null, message: "Prices saved. AI drafting resumed." });
    expect((await getSettings(["ai.prices"] as const))["ai.prices"][HAIKU]).toEqual({ inputPerMTok: 1.25, outputPerMTok: 6 });
    expect((await getAiPause()).paused).toBe(false);
    expect(cl.fake.requests).toHaveLength(0);
  });
});

describe("the practice copy and Members", () => {
  it("the practice copy refuses the key and model saves, and the fake gets no request", async () => {
    await setSetting("practice.copy", true, owner.id);
    const text = "The practice copy never talks to Anthropic.";
    expect(await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-practice-00" })).toEqual({ ok: false, error: text });
    expect(await actions.saveAiModelAction({ choice: "sonnet" })).toEqual({ ok: false, error: text });
    expect(await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: 1, outputPerMTok: 5 })).toEqual({ ok: false, error: text });
    expect(cl.fake.requests).toHaveLength(0);
    expect((await getSettings(["ai.model"] as const))["ai.model"]).toBe(HAIKU);
    // The practice copy's radios still say what a real run would cost.
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.practiceCopy).toBe(true);
    expect(view.radios.haiku).toContain("about $1.69 per 300 companies");
  });

  it("every Settings › AI action refuses a Member", async () => {
    auth.user = ali;
    const refused = { ok: false, error: "Only the Owner can do this." };
    expect(await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-member-000" })).toEqual(refused);
    expect(await actions.removeAnthropicKeyAction()).toEqual(refused);
    expect(await actions.saveAiModelAction({ choice: "sonnet" })).toEqual(refused);
    expect(await actions.saveAiLimitAction({ usd: 50 })).toEqual(refused);
    expect(await actions.saveAiPricesAction({ prices: { [HAIKU]: { inputPerMTok: 1, outputPerMTok: 5 } } })).toEqual(refused);
    expect(cl.fake.requests).toHaveLength(0);
    expect(await getSecret("anthropic.apiKey")).toBe(cl.apiKey);
    expect((await getSettings(["ai.model", "ai.monthlyLimitUsd"] as const))).toEqual({ "ai.model": HAIKU, "ai.monthlyLimitUsd": 20 });
  });
});
