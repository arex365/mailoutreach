import { limitUsdText, perCompanyUsd, runCostUsd } from "@/core/ai/estimate";
import {
  AI_PRICE_MAX,
  AI_PRICE_MIN,
  DEFAULT_AI_PRICES,
  HAIKU_MODEL,
  MODEL_PROFILES,
  resolveProfile,
  SONNET_MODEL,
} from "@/core/ai/types";
import { aboutUsd, formatUsd } from "@/core/money";
import type { AiCustomModel, AiModelPrices, AiPrices } from "@/core/setting-types";
import type { AiPauseKind } from "@/core/system-state";
import { plural } from "@/core/text";
import { formatShortDate } from "@/core/time/format";
import { logActivity } from "@/server/activity";
import {
  anthropicBaseOverride,
  anthropicBaseUrl,
  assertAnthropicKeyMatchesTarget,
  CLAUDE_NOT_READY_TEXT,
  ClaudeTargetError,
  createClaudeApi,
  type AiFailure,
  type ClaudeApi,
  type ModelCheck,
} from "@/server/anthropic";
import { db } from "@/server/db";
import { deleteSecret, getSecret, secretInfo, setSecret } from "@/server/secrets";
import { ServiceError } from "@/server/services/companies/mutations";
import { getSettings, setSetting } from "@/server/settings";
import { estimateDraftRun } from "./estimate";
import { getAiPause, resumeAi } from "./pause";
import type { AiActor } from "./review";
import { aiSpendThisMonth } from "./spend";

/**
 * Settings › AI (docs/dev/M5-DESIGN.md §3.11, §6.9; Owner only): the Anthropic key, the model, the monthly limit and
 * the prices, and everything the page shows about them.
 *
 * The web process talks to Anthropic only here, and only with the free `models.retrieve` (D14): saving a key checks it
 * against the current model, and saving "Another Claude model" checks that the model exists, lets this key use it and
 * can return structured answers. Built-in models, the limit and the prices are saved without any call. The practice
 * copy never talks to Anthropic: saving a key or a model there is refused before anything is sent.
 *
 * Each save lifts only the pause it fixes (M5-DESIGN §3.7): a new key lifts `key_rejected` and `no_permission`, a model
 * `model_not_found` (and `no_price`, since the saved model has prices), prices `no_price`, and a limit above this
 * month's spend `monthly_limit`. Problems the Owner can fix throw a ServiceError with the sentence to show
 * (`fieldErrors.detail` carries Anthropic's own words, scrubbed, for "Details").
 */

/** The model check waits this long per request while the Owner looks at the page (drafting uses 60 s). */
export const SETTINGS_CHECK_TIMEOUT_MS = 15_000;

/** The sentences of Settings › AI (§6.9; the ones the design left open are written in the same style). */
export const AI_SETTINGS_TEXT = {
  ownerOnly: "Only the Owner can change the AI settings.",
  practiceCopy: CLAUDE_NOT_READY_TEXT["practice-copy"],
  pasteKey: "Paste the API key from the Anthropic Console first.",
  notAKey: "That doesn't look like an API key. Copy it again from the Anthropic Console.",
  keyRejected: "Anthropic didn't accept this key. In the Anthropic Console, open API keys, create a key and paste it here.",
  keyNoPermission:
    "Anthropic doesn't let this key use Claude. Check the key in the Anthropic Console, or create a new one and paste it here.",
  keyMoneyWarning:
    "Anthropic says this account can't spend more right now. Check Billing and your spending limits in the Anthropic Console.",
  unreachable: "Couldn't reach Anthropic. Check this PC's internet connection and try again.",
  checkFailed: "Anthropic couldn't check this right now. Try again in a minute.",
  noKeyForModel: "Save your API key first, so the app can check the model.",
  savedKeyRejected: "Anthropic didn't accept the saved API key. Save a new key above, then save the model again.",
  noStructured: "This model can't return the structured answer the app needs. Pick Claude Haiku 4.5 or Sonnet 5.",
  modelId: "Enter the model ID exactly as Anthropic writes it, for example claude-sonnet-5.",
  prices: "Enter prices from $0.01 to $1,000 per million tokens.",
  pricesListChanged: "The list of models changed. Refresh the page and enter the prices again.",
  limit: "Enter an amount from $1 to $1,000.",
  noKeySaved: "No key saved yet. In the Anthropic Console, open API keys, create a key and paste it here.",
  keyRemoved: "The Anthropic key is removed. AI drafting waits until a new key is saved.",
  modelSaved: "Model saved.",
  runWaiting: "Drafting that's waiting uses it from now on.",
  limitSaved: "Limit saved.",
  pricesSaved: "Prices saved.",
  resumed: "AI drafting resumed.",
} as const;

/** "Key saved. It works with Claude Haiku 4.5." */
export function keySavedText(modelLabel: string): string {
  return `Key saved. It works with ${modelLabel}.`;
}

/** The key authenticated, but the current model isn't available to it (the key is saved). */
export function keyWrongModelText(modelLabel: string): string {
  return `The key works, but Anthropic doesn't let it use ${modelLabel}. Pick another model below.`;
}

/** "Anthropic doesn't know the model “claude-x”, or your account can't use it. Check the spelling." */
export function unknownModelText(id: string): string {
  return `Anthropic doesn't know the model “${id}”, or your account can't use it. Check the spelling.`;
}

/** "Radio" choices of the model card: the two built-in profiles, or "Another Claude model". */
export type AiModelChoice = "haiku" | "sonnet" | "custom";

export type SaveAiModelInput =
  | { choice: "haiku" | "sonnet" }
  | { choice: "custom"; id: string; inputPerMTok: number; outputPerMTok: number };

/** Everything Settings › AI shows, already worded (dates in the viewer's zone). */
export type AiSettingsView = {
  practiceCopy: boolean;
  /** "Test server: Claude calls go to …" while the app talks to the fake Claude server, else null. */
  fakeBanner: string | null;
  /** The AI queue's pause (its full sentence), or null. */
  pause: { kind: AiPauseKind | null; text: string } | null;
  /** `line`: "Key ending …a1b2, saved 3 Oct by Arslan." or the "no key yet" sentence; `problem`: a saved key that can't be used. */
  key: { set: boolean; line: string; problem: string | null };
  model: { id: string; choice: AiModelChoice; label: string };
  /** The radio labels with this app's estimate for 300 companies ("… about $1.69 per 300 companies"). */
  radios: { haiku: string; sonnet: string };
  /** The "Another Claude model" fields: the saved custom model (or a hand-set model id) and its prices. */
  custom: { id: string; label: string; inputPerMTok: number | null; outputPerMTok: number | null } | null;
  /** The monthly limit and "Spent in September: $3.10 of $20 (27 drafts)." */
  limit: { usd: number; spentLine: string };
  /** The price rows: Haiku, Sonnet and the custom model (null price = none saved yet). */
  prices: Array<{ id: string; label: string; inputPerMTok: number | null; outputPerMTok: number | null }>;
};

function requireOwner(actor: AiActor): void {
  if (actor.role !== "OWNER") throw new ServiceError(AI_SETTINGS_TEXT.ownerOnly);
}

async function refuseInPracticeCopy(): Promise<void> {
  const s = await getSettings(["practice.copy"] as const);
  if (s["practice.copy"] === true) throw new ServiceError(AI_SETTINGS_TEXT.practiceCopy);
}

/** Keys are trimmed and stripped of zero-width characters (a copy from a web page can carry them). */
export function cleanAnthropicKey(v: string | null | undefined): string {
  return (v ?? "").replace(/[​-‍⁠﻿]/g, "").trim();
}

/** Printable characters without spaces, 10–500 of them: anything else can't be an API key. */
const KEY_SHAPE = /^[\x21-\x7e]{10,500}$/;
/** Model ids as Anthropic writes them ("claude-sonnet-5", "claude-haiku-4-5-20251001"). */
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/;

/** A price in dollars per million tokens, when it is inside 0.01–1,000; else null. */
export function validPrice(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < AI_PRICE_MIN || n > AI_PRICE_MAX) return null;
  return Math.round(n * 1e6) / 1e6;
}

/** A monthly limit in dollars, when it is inside 1–1,000 (rounded to cents); else null. */
export function validLimit(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 1 || n > 1_000) return null;
  return Math.round(n * 100) / 100;
}

function labelOf(model: string, custom: AiCustomModel | null, prices: AiPrices): string {
  return resolveProfile(model, custom, prices).label;
}

/** A client for this key at this app's Anthropic address; wrong-target keys are refused before anything is sent. */
function claudeFor(key: string): ClaudeApi {
  const base = anthropicBaseUrl();
  try {
    assertAnthropicKeyMatchesTarget(key, base);
    return createClaudeApi(key, base, { timeoutMs: SETTINGS_CHECK_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ClaudeTargetError) throw new ServiceError(err.message, { fieldErrors: { key: [err.message] } });
    throw err;
  }
}

/** Anthropic's own words for "Details" (already scrubbed by the classifier), when there are any. */
function detailOf(failure: AiFailure): Record<string, string[]> | undefined {
  return failure.kind === "fail_draft" && failure.message ? { detail: [failure.message] } : undefined;
}

/** The sentence for a model check that couldn't be done (network, rate limit, anything unexpected). */
function unreachableOrFailed(failure: AiFailure): ServiceError {
  if (failure.kind === "backoff" || failure.kind === "requeue") return new ServiceError(AI_SETTINGS_TEXT.unreachable);
  return new ServiceError(AI_SETTINGS_TEXT.checkFailed, { fieldErrors: detailOf(failure) });
}

/** Lifts the pause kinds a save fixes; true when a pause was lifted. Never fails the save itself. */
async function lift(actor: AiActor, kinds: readonly AiPauseKind[], now: Date): Promise<boolean> {
  try {
    return (await resumeAi(actor, { onlyKinds: kinds, now })).resumed;
  } catch (err) {
    console.error("[ai] couldn't lift the AI pause after a settings save", err);
    return false;
  }
}

function withResumed(message: string, resumed: boolean): string {
  return resumed ? `${message} ${AI_SETTINGS_TEXT.resumed}` : message;
}

/**
 * Save key: checks the key with `models.retrieve` for the current model, then saves it (encrypted). Refused, and not
 * saved, when Anthropic doesn't accept it, can't be reached, or it is a test key on the real API (or a real key on the
 * test server). A key that works but can't use the current model is saved with a warning (`warning: true`), so the
 * Owner can pick another model next.
 */
export async function saveAnthropicKey(
  actor: AiActor,
  rawKey: string,
  opts: { now?: Date } = {},
): Promise<{ message: string; warning: boolean }> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  await refuseInPracticeCopy();
  const key = cleanAnthropicKey(rawKey);
  if (!key) throw new ServiceError(AI_SETTINGS_TEXT.pasteKey, { fieldErrors: { key: [AI_SETTINGS_TEXT.pasteKey] } });
  if (!KEY_SHAPE.test(key)) throw new ServiceError(AI_SETTINGS_TEXT.notAKey, { fieldErrors: { key: [AI_SETTINGS_TEXT.notAKey] } });

  const s = await getSettings(["ai.model", "ai.customModel", "ai.prices"] as const);
  const model = s["ai.model"];
  const label = labelOf(model, s["ai.customModel"], s["ai.prices"]);
  const check = await claudeFor(key).retrieveModel(model);

  let message: string;
  let warning = false;
  if (check.ok) {
    message = keySavedText(label);
  } else {
    const f = check.failure;
    if (f.kind === "pause" && f.reason === "key_rejected") {
      throw new ServiceError(AI_SETTINGS_TEXT.keyRejected, { fieldErrors: { key: [AI_SETTINGS_TEXT.keyRejected] } });
    }
    if (f.kind === "pause" && f.reason === "no_permission") {
      throw new ServiceError(AI_SETTINGS_TEXT.keyNoPermission, { fieldErrors: { key: [AI_SETTINGS_TEXT.keyNoPermission] } });
    }
    if (f.kind === "pause" && f.reason === "model_not_found") {
      message = keyWrongModelText(label);
      warning = true;
    } else if (f.kind === "pause") {
      // tier_spend_cap, own_spend_limit, billing: the key itself was accepted.
      message = `Key saved. ${AI_SETTINGS_TEXT.keyMoneyWarning}`;
      warning = true;
    } else {
      throw unreachableOrFailed(f);
    }
  }

  await setSecret("anthropic.apiKey", key, actor.id);
  await logActivity({
    actorId: actor.id,
    type: "settings.updated",
    summary: `${actor.name} saved a new Anthropic API key`,
    data: { key: "anthropic.apiKey" },
  });
  const resumed = await lift(actor, ["key_rejected", "no_permission"], now);
  return { message: withResumed(message, resumed), warning };
}

/** Remove key: deletes the saved Anthropic key; drafting waits (it pauses with "Add your Anthropic API key…"). */
export async function removeAnthropicKey(actor: AiActor): Promise<void> {
  requireOwner(actor);
  const had = (await secretInfo("anthropic.apiKey")).set;
  await deleteSecret("anthropic.apiKey");
  if (had) {
    await logActivity({
      actorId: actor.id,
      type: "settings.updated",
      summary: `${actor.name} removed the Anthropic API key`,
      data: { key: "anthropic.apiKey", removed: true },
    });
  }
}

/** The saved key, or the sentence why it can't be used to check a model. */
async function savedKeyForCheck(): Promise<string> {
  let key: string | null;
  try {
    key = await getSecret("anthropic.apiKey");
  } catch {
    throw new ServiceError(CLAUDE_NOT_READY_TEXT.unreadable);
  }
  if (!key || !key.trim()) throw new ServiceError(AI_SETTINGS_TEXT.noKeyForModel);
  return key.trim();
}

/** A model check for "Another Claude model", in the Owner's words. */
async function checkCustomModel(id: string): Promise<ModelCheck & { ok: true }> {
  const key = await savedKeyForCheck();
  const base = anthropicBaseUrl();
  let api: ClaudeApi;
  try {
    assertAnthropicKeyMatchesTarget(key, base);
    api = createClaudeApi(key, base, { timeoutMs: SETTINGS_CHECK_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof ClaudeTargetError) throw new ServiceError(CLAUDE_NOT_READY_TEXT.mismatch);
    throw err;
  }
  const check = await api.retrieveModel(id);
  if (check.ok) {
    if (!check.structuredOutputs) throw new ServiceError(AI_SETTINGS_TEXT.noStructured, { fieldErrors: { id: [AI_SETTINGS_TEXT.noStructured] } });
    return check;
  }
  const f = check.failure;
  if (f.kind === "pause" && f.reason === "model_not_found") {
    const text = unknownModelText(id);
    throw new ServiceError(text, { fieldErrors: { id: [text] } });
  }
  if (f.kind === "pause" && (f.reason === "key_rejected" || f.reason === "no_permission")) {
    throw new ServiceError(AI_SETTINGS_TEXT.savedKeyRejected);
  }
  if (f.kind === "pause") {
    // A billing or spending limit: the model exists and the key works, but the check can't say more.
    throw new ServiceError(AI_SETTINGS_TEXT.keyMoneyWarning);
  }
  throw unreachableOrFailed(f);
}

/** How many drafting runs are waiting or running (they use the saved model from their next company on, §3.3). */
async function activeRunCount(): Promise<number> {
  return db.job.count({ where: { type: "ai.draftLines", status: { in: ["QUEUED", "RUNNING"] } } });
}

/**
 * Save model: Claude Haiku 4.5 or Sonnet 5 (no call), or another Claude model, which is checked with `models.retrieve`
 * (it must exist, be usable with the saved key and support structured outputs) and needs both prices (0.01–1,000).
 * The custom model gets `effort: "low"` only when Anthropic says it supports it (D37), and at most 4,000 output tokens.
 */
export async function saveAiModel(actor: AiActor, input: SaveAiModelInput, opts: { now?: Date } = {}): Promise<{ message: string }> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  await refuseInPracticeCopy();
  const s = await getSettings(["ai.model", "ai.customModel", "ai.prices"] as const);
  const before = s["ai.model"];
  let model: string;
  let label: string;

  if (input.choice !== "custom") {
    model = input.choice === "sonnet" ? SONNET_MODEL : HAIKU_MODEL;
    label = MODEL_PROFILES[model]!.label;
    await setSetting("ai.model", model, actor.id);
  } else {
    const id = (input.id ?? "").trim();
    if (!MODEL_ID_SHAPE.test(id)) throw new ServiceError(AI_SETTINGS_TEXT.modelId, { fieldErrors: { id: [AI_SETTINGS_TEXT.modelId] } });
    const inputPrice = validPrice(input.inputPerMTok);
    const outputPrice = validPrice(input.outputPerMTok);
    if (inputPrice === null || outputPrice === null) {
      const fieldErrors: Record<string, string[]> = {};
      if (inputPrice === null) fieldErrors.inputPerMTok = [AI_SETTINGS_TEXT.prices];
      if (outputPrice === null) fieldErrors.outputPerMTok = [AI_SETTINGS_TEXT.prices];
      throw new ServiceError(AI_SETTINGS_TEXT.prices, { fieldErrors });
    }
    const check = await checkCustomModel(id);
    // models.retrieve may resolve an alias to the pinned id: drafts store the id Anthropic answered with.
    model = check.id.trim() || id;
    const prices: AiPrices = { ...s["ai.prices"], [model]: { inputPerMTok: inputPrice, outputPerMTok: outputPrice } };
    if (MODEL_PROFILES[model]) {
      label = MODEL_PROFILES[model]!.label;
    } else {
      const custom: AiCustomModel = {
        id: model,
        label: check.displayName.trim() || model,
        maxTokens: check.maxTokens ?? 4_000,
        effortLow: check.effortLow,
        checkedAt: now.toISOString(),
      };
      label = custom.label;
      await setSetting("ai.customModel", custom, actor.id);
    }
    await setSetting("ai.prices", prices, actor.id);
    await setSetting("ai.model", model, actor.id);
  }

  if (before !== model) {
    await logActivity({
      actorId: actor.id,
      type: "settings.updated",
      summary: `${actor.name} set the AI model to ${label}`,
      data: { key: "ai.model", from: before, to: model },
    });
  }
  await lift(actor, ["model_not_found", "no_price"], now);
  const waiting = (await activeRunCount()) > 0;
  return { message: waiting ? `${AI_SETTINGS_TEXT.modelSaved} ${AI_SETTINGS_TEXT.runWaiting}` : AI_SETTINGS_TEXT.modelSaved };
}

/** Save limit: 1–1,000 dollars per office month. A limit above this month's spend lifts a monthly_limit pause. */
export async function saveAiLimit(actor: AiActor, usd: number, opts: { now?: Date } = {}): Promise<{ message: string }> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  const limit = validLimit(usd);
  if (limit === null) throw new ServiceError(AI_SETTINGS_TEXT.limit, { fieldErrors: { usd: [AI_SETTINGS_TEXT.limit] } });
  const before = Number((await getSettings(["ai.monthlyLimitUsd"] as const))["ai.monthlyLimitUsd"]);
  await setSetting("ai.monthlyLimitUsd", limit, actor.id);
  if (before !== limit) {
    await logActivity({
      actorId: actor.id,
      type: "settings.updated",
      summary: `${actor.name} set the AI monthly limit to ${limitUsdText(limit)}`,
      data: { key: "ai.monthlyLimitUsd", from: Number.isFinite(before) ? before : null, to: limit },
    });
  }
  const spent = (await aiSpendThisMonth(now)).usd;
  const resumed = limit > spent ? await lift(actor, ["monthly_limit"], now) : false;
  return { message: withResumed(AI_SETTINGS_TEXT.limitSaved, resumed) };
}

/** The model ids the price rows may be saved for: the built-in ones and the saved custom model. */
function priceableModels(model: string, custom: AiCustomModel | null): Set<string> {
  const ids = new Set<string>([HAIKU_MODEL, SONNET_MODEL]);
  if (custom?.id) ids.add(custom.id);
  if (model) ids.add(model);
  return ids;
}

/** Save prices: every row 0.01–1,000 dollars per million tokens (a 0 price would switch the monthly limit off). Lifts no_price. */
export async function saveAiPrices(actor: AiActor, input: AiPrices, opts: { now?: Date } = {}): Promise<{ message: string }> {
  requireOwner(actor);
  const now = opts.now ?? new Date();
  const s = await getSettings(["ai.model", "ai.customModel", "ai.prices"] as const);
  const allowed = priceableModels(s["ai.model"], s["ai.customModel"]);
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) throw new ServiceError(AI_SETTINGS_TEXT.prices, { fieldErrors: { prices: [AI_SETTINGS_TEXT.prices] } });
  const next: AiPrices = { ...s["ai.prices"] };
  for (const [id, row] of entries) {
    if (!allowed.has(id)) throw new ServiceError(AI_SETTINGS_TEXT.pricesListChanged);
    const inputPrice = validPrice((row as Partial<AiModelPrices> | null)?.inputPerMTok);
    const outputPrice = validPrice((row as Partial<AiModelPrices> | null)?.outputPerMTok);
    if (inputPrice === null || outputPrice === null) {
      throw new ServiceError(AI_SETTINGS_TEXT.prices, { fieldErrors: { prices: [AI_SETTINGS_TEXT.prices], [id]: [AI_SETTINGS_TEXT.prices] } });
    }
    next[id] = { inputPerMTok: inputPrice, outputPerMTok: outputPrice };
  }
  await setSetting("ai.prices", next, actor.id);
  await logActivity({
    actorId: actor.id,
    type: "settings.updated",
    summary: `${actor.name} updated the AI prices`,
    data: { key: "ai.prices", models: entries.map(([id]) => id) },
  });
  const resumed = await lift(actor, ["no_price"], now);
  return { message: withResumed(AI_SETTINGS_TEXT.pricesSaved, resumed) };
}

function choiceOf(model: string): AiModelChoice {
  return model === HAIKU_MODEL ? "haiku" : model === SONNET_MODEL ? "sonnet" : "custom";
}

/** The "about" amount for 300 companies with the profile defaults (the practice copy, which drafts for free). */
function defaultAboutUsd(model: string, custom: AiCustomModel | null, prices: AiPrices): number {
  const profile = resolveProfile(model, custom, prices);
  const per = perCompanyUsd(profile, {
    systemTokens: profile.defaultSystemTokens,
    avgPageTokens: profile.defaultPageTokens,
    avgOutputTokens: profile.defaultOutputTokens,
  });
  return runCostUsd(300, per).aboutUsd;
}

/** The key's line and any problem with the saved key (it can't be read, or it doesn't fit this server). */
async function keyView(timeZone: string, now: Date): Promise<AiSettingsView["key"]> {
  const info = await secretInfo("anthropic.apiKey");
  if (!info.set) return { set: false, line: AI_SETTINGS_TEXT.noKeySaved, problem: null };
  const by = info.updatedById ? (await db.user.findUnique({ where: { id: info.updatedById }, select: { name: true } }))?.name?.trim() : null;
  const line = `Key ending …${info.last4}, saved ${formatShortDate(info.updatedAt, timeZone, now)}${by ? ` by ${by}` : ""}.`;
  let problem: string | null = null;
  try {
    const key = await getSecret("anthropic.apiKey");
    if (key) {
      try {
        assertAnthropicKeyMatchesTarget(key, anthropicBaseUrl());
      } catch (err) {
        if (err instanceof ClaudeTargetError) problem = CLAUDE_NOT_READY_TEXT.mismatch;
      }
    }
  } catch {
    problem = CLAUDE_NOT_READY_TEXT.unreadable;
  }
  return { set: true, line, problem };
}

/** Everything Settings › AI shows, for the Owner (`timeZone`: the viewer's). */
export async function loadAiSettings(timeZone: string, opts: { now?: Date } = {}): Promise<AiSettingsView> {
  const now = opts.now ?? new Date();
  const s = await getSettings(["ai.model", "ai.customModel", "ai.prices", "ai.monthlyLimitUsd", "practice.copy"] as const);
  const practiceCopy = s["practice.copy"] === true;
  const model = s["ai.model"];
  const custom = s["ai.customModel"];
  const prices = s["ai.prices"];
  const priceOf = (id: string): AiModelPrices | null => prices[id] ?? DEFAULT_AI_PRICES[id] ?? null;

  const aboutFor = async (id: string): Promise<string> =>
    aboutUsd(practiceCopy ? defaultAboutUsd(id, custom, prices) : (await estimateDraftRun(300, now, { model: id })).aboutUsd);
  const [haikuAbout, sonnetAbout, pause, key, spend] = await Promise.all([
    aboutFor(HAIKU_MODEL),
    aboutFor(SONNET_MODEL),
    getAiPause(now),
    keyView(timeZone, now),
    aiSpendThisMonth(now),
  ]);

  const customId = custom?.id && !MODEL_PROFILES[custom.id] ? custom.id : !MODEL_PROFILES[model] ? model : null;
  const customPrices = customId ? (prices[customId] ?? null) : null;
  const limitRaw = Number(s["ai.monthlyLimitUsd"]);
  const limitUsd = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;
  const override = anthropicBaseOverride();

  const priceRows: AiSettingsView["prices"] = [HAIKU_MODEL, SONNET_MODEL].map((id) => ({
    id,
    label: MODEL_PROFILES[id]!.label,
    inputPerMTok: priceOf(id)?.inputPerMTok ?? null,
    outputPerMTok: priceOf(id)?.outputPerMTok ?? null,
  }));
  if (customId) {
    priceRows.push({
      id: customId,
      label: labelOf(customId, custom, prices),
      inputPerMTok: customPrices?.inputPerMTok ?? null,
      outputPerMTok: customPrices?.outputPerMTok ?? null,
    });
  }

  return {
    practiceCopy,
    fakeBanner: override ? `Test server: Claude calls go to ${override} (OUTREACH_ANTHROPIC_BASE_URL). Nothing reaches the real Anthropic API.` : null,
    pause: pause.paused ? { kind: pause.kind, text: pause.text } : null,
    key,
    model: { id: model, choice: choiceOf(model), label: labelOf(model, custom, prices) },
    radios: {
      haiku: `${MODEL_PROFILES[HAIKU_MODEL]!.label} (recommended): low cost, ${haikuAbout} per 300 companies`,
      sonnet: `${MODEL_PROFILES[SONNET_MODEL]!.label}: better at spotting specific details, ${sonnetAbout} per 300 companies`,
    },
    custom: customId
      ? {
          id: customId,
          label: labelOf(customId, custom, prices),
          inputPerMTok: customPrices?.inputPerMTok ?? null,
          outputPerMTok: customPrices?.outputPerMTok ?? null,
        }
      : null,
    limit: {
      usd: limitUsd,
      spentLine: `Spent in ${spend.bounds.label}: ${formatUsd(spend.usd)} of ${limitUsdText(limitUsd)} (${plural(spend.drafts, "draft", "drafts")}).`,
    },
    prices: priceRows,
  };
}
