import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { seedSessionUsers, type TestUser } from "./seed";

/**
 * Settings › AI as the real app would talk to Anthropic (docs/dev/M5-DESIGN.md §6.9, §7.4): a test key
 * (sk-ant-fake-…) is refused with "This is a test key…" before anything is sent, and a saved test key is reported as
 * not fitting this server. The Anthropic address is pretended to be the real one; `fetch` is watched and must never be
 * called (the test run's own guards would refuse the real host anyway).
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
// Real mode: the app's Anthropic address is Anthropic's own (nothing is sent: the key is refused first).
vi.mock("@/server/anthropic/base-url", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/anthropic/base-url")>();
  return { ...actual, anthropicBaseUrl: () => actual.ANTHROPIC_HOST, anthropicBaseOverride: () => null, isAnthropicFakeMode: () => false };
});

const t = await createTestDb("ai-screens-real-mode");
const { db } = await import("@/server/db");
const { getSecret, setSecret } = await import("@/server/secrets");
const { loadAiSettings } = await import("@/server/services/ai/settings");
const actions = await import("@/app/(app)/settings/ai/actions");

let owner: TestUser;
// Watched and refused: even a regression that tried to send could never reach Anthropic from this test.
const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new TypeError("fetch refused: this test must never reach the network");
});

beforeAll(async () => {
  ({ owner } = await seedSessionUsers());
});

afterAll(async () => {
  fetchSpy.mockRestore();
  await db.$disconnect();
  t.cleanup();
});

describe("Settings › AI in real mode", () => {
  it("a test key is refused before anything is sent", async () => {
    auth.user = owner;
    const res = await actions.saveAnthropicKeyAction({ key: "sk-ant-fake-key-000000" });
    expect(res).toMatchObject({ ok: false, error: "This is a test key. Paste a key from the Anthropic Console." });
    if (!res.ok) expect(res.fieldErrors?.key).toEqual(["This is a test key. Paste a key from the Anthropic Console."]);
    expect(await getSecret("anthropic.apiKey")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a saved test key is reported as not fitting this server, and no fake banner shows", async () => {
    await setSecret("anthropic.apiKey", "sk-ant-fake-key-000000", owner.id);
    const view = await loadAiSettings("Europe/Berlin");
    expect(view.key.problem).toBe(
      "The saved Anthropic key doesn't fit this server (a test key on the real Anthropic API, or the other way round). Save the right key in Settings › AI.",
    );
    expect(view.fakeBanner).toBeNull();
    // Another model can't be checked with it either, and nothing is sent.
    auth.user = owner;
    expect(await actions.saveAiModelAction({ choice: "custom", id: "claude-test-custom", inputPerMTok: 1, outputPerMTok: 5 })).toMatchObject({
      ok: false,
      error: "The saved Anthropic key doesn't fit this server (a test key on the real Anthropic API, or the other way round). Save the right key in Settings › AI.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
