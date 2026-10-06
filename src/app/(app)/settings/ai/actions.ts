"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireOwnerAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { ServiceError } from "@/server/services/companies/mutations";
import type { AiActor } from "@/server/services/ai/review";
import {
  removeAnthropicKey,
  saveAiLimit,
  saveAiModel,
  saveAiPrices,
  saveAnthropicKey,
  type SaveAiModelInput,
} from "@/server/services/ai/settings";

/**
 * Settings › AI (docs/dev/M5-DESIGN.md §3.11, §6.9, §6.11). Every action is Owner-only (API keys, the model, the limit
 * and the prices are settings, SPEC §1). The services check the key and the model with Anthropic's free
 * `models.retrieve` and never in the practice copy; their refusals are plain sentences (Anthropic's own words only in
 * `fieldErrors.detail`, for "Details").
 */

function actorOf(user: SessionUser): AiActor {
  return { id: user.id, name: user.name, role: user.role };
}

/** Runs a service call, turning its ServiceError (a sentence for the Owner) into a UserError for runAction. */
async function service<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ServiceError) throw new UserError(err.message, err.fieldErrors);
    throw err;
  }
}

/**
 * Every save here can lift an AI drafting pause (a new key, a higher limit, the missing prices), which the top of the
 * AI lines page and the dashboard's attention list show: refresh every page (M6-DESIGN §5.1 R5).
 */
function revalidateAiPages(): void {
  revalidatePath("/", "layout");
}

const keySchema = z.object({ key: z.string({ error: "Paste the API key from the Anthropic Console first." }).max(1_000) });

/** "Save key": checks the key with Anthropic, then saves it. `warning`: saved, but the current model isn't usable. */
export async function saveAnthropicKeyAction(input: z.infer<typeof keySchema>): Promise<ActionResult<{ warning: boolean }>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { key } = parseInput(keySchema, input);
    const out = await service(() => saveAnthropicKey(actorOf(user), key));
    message = out.message;
    revalidateAiPages();
    return { warning: out.warning };
  });
  return res.ok ? { ...res, message } : res;
}

/** "Remove key": AI drafting waits until a new key is saved. */
export async function removeAnthropicKeyAction(): Promise<ActionResult> {
  return runAction(async () => {
    const user = await requireOwnerAction();
    await service(() => removeAnthropicKey(actorOf(user)));
    revalidateAiPages();
    return null;
  }, "The Anthropic key is removed. AI drafting waits until a new key is saved.");
}

const priceNumber = z.number({ error: "Enter prices from $0.01 to $1,000 per million tokens." });

/** The prices are checked by the service (0.01–1,000, both required), so an empty box gets its own field message. */
const modelSchema = z.object({
  choice: z.enum(["haiku", "sonnet", "custom"], { error: "Choose a model." }),
  id: z.string({ error: "Enter the model ID exactly as Anthropic writes it, for example claude-sonnet-5." }).max(200).optional(),
  inputPerMTok: z.unknown().optional(),
  outputPerMTok: z.unknown().optional(),
});

/** A price box as a number (an empty or unreadable box is NaN, which the service refuses with its sentence). */
function priceOf(v: unknown): number {
  return typeof v === "number" ? v : Number.NaN;
}

/** "Save model": Claude Haiku 4.5, Claude Sonnet 5, or another Claude model (checked with Anthropic). */
export async function saveAiModelAction(input: SaveAiModelInput): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const raw = parseInput(modelSchema, input);
    const data: SaveAiModelInput =
      raw.choice === "custom"
        ? { choice: "custom", id: raw.id ?? "", inputPerMTok: priceOf(raw.inputPerMTok), outputPerMTok: priceOf(raw.outputPerMTok) }
        : { choice: raw.choice };
    const out = await service(() => saveAiModel(actorOf(user), data));
    message = out.message;
    revalidateAiPages();
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const limitSchema = z.object({ usd: z.number({ error: "Enter an amount from $1 to $1,000." }) });

/** "Save limit": dollars per office month; a higher limit lifts a monthly-limit pause. */
export async function saveAiLimitAction(input: z.infer<typeof limitSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { usd } = parseInput(limitSchema, input);
    const out = await service(() => saveAiLimit(actorOf(user), usd));
    message = out.message;
    revalidateAiPages();
    return null;
  });
  return res.ok ? { ...res, message } : res;
}

const pricesSchema = z.object({
  prices: z.record(
    z.string().min(1).max(200),
    z.object({ inputPerMTok: priceNumber, outputPerMTok: priceNumber }),
  ),
});

/** "Save prices": dollars per million tokens for each model row; lifts a no-price pause. */
export async function saveAiPricesAction(input: z.infer<typeof pricesSchema>): Promise<ActionResult> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const user = await requireOwnerAction();
    const { prices } = parseInput(pricesSchema, input);
    if (Object.keys(prices).length > 10) throw new UserError("Enter prices from $0.01 to $1,000 per million tokens.");
    const out = await service(() => saveAiPrices(actorOf(user), prices));
    message = out.message;
    revalidateAiPages();
    return null;
  });
  return res.ok ? { ...res, message } : res;
}
