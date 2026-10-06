import { APPLY_STEP_TEXTS } from "@/core/dns/checklist";
import { publicAddressProblem } from "@/core/mailgun/routes";
import { OWN_MAILBOX_TEXTS } from "@/core/sending/own-mailbox";
import { parseMailgunSetupState, parseUnsubscribeTest } from "@/core/system-state-parse";
import { STATE_KEYS, type CertificateState, type MailgunSetupState, type SetupStep, type SetupStepKey } from "@/core/system-state";
import { logActivity } from "../../activity";
import { db, dbWrite } from "../../db";
import { publicUrl } from "../../env";
import { enqueueJob, PlainJobError, redactText, type JobHandler } from "../../jobs";
import { getMailgunContext, mailgunSecrets, type MailgunContext, type MailgunContextResult } from "../../mailgun/context";
import { isMailgunError, plainMailgunError } from "../../mailgun/errors";
import type { DomainInfo } from "../../mailgun/types";
import { notifyOwner } from "../../notifications";
import { getSecret, setSecret } from "../../secrets";
import { getSettings } from "../../settings";
import { readTyped, updateTyped } from "../../state-typed";
import { routesOkText, syncRoutes } from "./routes";
import { registerWebhooks } from "./webhooks-setup";

export { publicAddressProblem } from "@/core/mailgun/routes";

/**
 * "Apply recommended settings" (PLAN B6.8, B6.10, M3-DESIGN §4.5.2): one job that makes the sending domain safe to use.
 * Each step is recorded in SystemState "mailgun.setup" as it finishes (the Domain checklist shows them live), and a
 * failing step never stops the next unless it depends on it:
 *
 *   public-address  https (or the fake's loopback), then GET <pub>/api/health through Cloudflare
 *   tracking-open / tracking-click   off (Mailgun must not add pixels or change links)
 *   unsubscribe     Setup A: on with both of Mailgun's own footers blank; Setup B: off
 *   spam-filter     spam_action "tag" (mark, never delete replies)
 *   retention       message_ttl = the stored-replies days × 86,400
 *   pii             webhooks_redact_pii false (only when it was on)
 *   certificate     the tracking host's certificate (x509), then polled every minute by its own job
 *   https           web_scheme https once the certificate is active
 *   signing-key     read (never regenerated) and saved
 *   webhooks        §4.5.3 (skipped while the public address doesn't work)
 *   routes          §4.5.4 (skipped while the public address doesn't work)
 *
 * Finally it asks for a fresh domain check (job "mailgun.checkDomain"), so the checklist rows catch up.
 *
 * Own-mailbox mode (`ctx.replies === "own-mailbox"`, MAIN-DOMAIN-DESIGN O8, O20, O21, §4): nothing inbound reaches
 * Mailgun, so the spam filter, the stored-reply retention and the routes are "Not needed" (no Mailgun call; `syncRoutes`
 * is never called); unsubscribe handling is always on (Setup A); without any public address the public-address step
 * says Mailgun's reports come through the hourly check (not a failure) and the webhooks are optional. Tracking, PII,
 * the certificate and https and the signing key are as in app mode, except that a 402 on the certificate ("not in plan",
 * the Free plan) is no failure there: the certificate step has no result and the https step says the links use http
 * (review DOMAIN-3). Apply never adds or asks for a DNS record, an MX record or a route.
 */

export type ApplyStepMode = "all" | "certificate-poll";

export type RunApplyOptions = {
  byUserId: number | null;
  jobId?: number | null;
  now?: Date;
  step?: ApplyStepMode;
  /** Certificate polls: 1 for the first one. */
  attempt?: number;
  mailgun?: () => Promise<MailgunContextResult>;
  /** For the public-address check (`GET <pub>/api/health`); default global fetch. */
  fetchImpl?: typeof fetch;
  /** Job progress (steps done, steps in total). */
  progress?: (done: number, total: number) => Promise<void>;
};

export const APPLY_DEDUPE_KEY = "mailgun:apply";
export const CERT_POLL_DEDUPE_KEY = "mailgun:cert-poll";
export const CERT_POLL_EVERY_MS = 60_000;
export const CERT_POLL_MAX = 30;
/** After Apply couldn't confirm the reply routes, the route sync tries again this much later. */
export const ROUTE_RETRY_AFTER_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const DAY_SECONDS = 86_400;

export const APPLY_TEXTS = {
  openOff: "Open tracking is off.",
  clickOff: "Click tracking is off.",
  openKept: "Mailgun kept open tracking on. In Mailgun: Domain settings › Tracking, switch Open tracking off, then apply again.",
  clickKept: "Mailgun kept click tracking on. In Mailgun: Domain settings › Tracking, switch Click tracking off, then apply again.",
  unsubscribeOn: "Mailgun's unsubscribe handling is on, with its own footers blank.",
  unsubscribeNotOn:
    "Mailgun's unsubscribe handling didn't switch on. In Mailgun: Domain settings › Tracking › Unsubscribes, switch it on and clear both footers, then apply again.",
  footersKept:
    "Mailgun kept its own unsubscribe footer. In Mailgun: Domain settings › Tracking › Unsubscribes, clear both footers, then apply again.",
  unsubscribeOffB: "Mailgun's unsubscribe handling is off for the Setup B check.",
  unsubscribeStillOnB:
    "Mailgun's unsubscribe handling is still on. In Mailgun: Domain settings › Tracking › Unsubscribes, switch it off, then apply again.",
  spamFilter: "Suspicious replies are marked, never deleted.",
  retentionTooLong:
    "Your Mailgun plan keeps stored replies for less time. Set 'stored replies' in Settings › Sending & Mailgun to what your plan allows.",
  pii: "Mailgun no longer hides addresses in its reports to the app.",
  certPreparing: "Mailgun is preparing the certificate for secure unsubscribe links.",
  certStillPreparing: "Mailgun is still preparing the certificate. Check again later.",
  certReady: "The certificate for secure unsubscribe links is ready.",
  httpsOn: "Unsubscribe links use https.",
  // The same sentence as APPLY_STEP_TEXTS.certNotInPlan (the Recommended settings card words the step by it; a unit
  // test pins the two together). Spelled out here because the guides quote it from this file.
  certNotInPlan: "Your Mailgun plan doesn't include secure (https) unsubscribe links. Foundation and higher do.",
  httpsWaiting: "Secure unsubscribe links switch on once the certificate is ready.",
  httpsNeedsCert: "Secure unsubscribe links need the certificate first.",
  signingKeySaved: "Webhook signing key saved.",
  signingKeyMissing:
    "Mailgun hasn't made a webhook signing key for your account yet. In Mailgun, open API Security and create the HTTP webhook signing key, then click Apply recommended settings again.",
  skippedNoPublicAddress: "Skipped until the public address works.",
  skippedNoDomain: "Skipped until Mailgun finds the domain.",
} as const;

/**
 * True when a certificate host belongs to `domain` (Apply uses `<web prefix>.<domain>`, normally email.<domain>). A host
 * of another domain is left over from before a domain change.
 */
export function certificateHostFits(host: string, domain: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  return Boolean(d) && h.endsWith(`.${d}`);
}

/**
 * Whether the stored "Apply recommended settings" run can belong to `domain`: false when its certificate is for another
 * domain's host (a run for the old domain that finished after a domain change). Runs without a certificate can't tell;
 * connectMailgun empties the state on every domain change.
 */
export function setupFitsDomain(setup: MailgunSetupState, domain: string): boolean {
  return !setup.certificate || certificateHostFits(setup.certificate.host, domain);
}

/** The empty state: no Apply run on record (after a domain change, the old domain's steps mean nothing). */
export const EMPTY_SETUP_STATE: MailgunSetupState = { runAt: null, byUserId: null, jobId: null, steps: [], certificate: null };

/** "Mailgun can't check email.<d> yet. Fix the 'Unsubscribe links work' row first." */
export function certCnameText(host: string): string {
  return `Mailgun can't check ${host} yet. Fix the 'Unsubscribe links work' row first.`;
}

/** "The app's public address doesn't answer yet (<pub>/api/health). …" */
export function publicAddressDownText(pub: string): string {
  return `The app's public address doesn't answer yet (${pub}/api/health). Finish the Cloudflare guide, check it on your phone, then try again.`;
}

export function retentionOkText(days: number): string {
  return `Mailgun keeps stored replies for ${days} day${days === 1 ? "" : "s"}.`;
}

/** "The public address answers: https://outreach.example.com." */
function publicAddressOkText(pub: string): string {
  return `The public address answers: ${pub}.`;
}

function clampDays(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

async function loadContext(mailgun?: () => Promise<MailgunContextResult>): Promise<MailgunContext> {
  let ctx: MailgunContextResult;
  try {
    ctx = await (mailgun ?? (() => getMailgunContext()))();
  } catch (err) {
    throw new PlainJobError("Mailgun isn't connected yet. Open Settings › Sending & Mailgun.", err instanceof Error ? err.message : String(err));
  }
  if (!ctx.connected) throw new PlainJobError(ctx.text);
  return ctx;
}

/**
 * GET <pub>/api/health without following redirects: only the app's own JSON counts (a Cloudflare login page or an
 * error page means Mailgun couldn't get through either).
 */
export async function checkPublicHealth(pub: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; detail: string | null }> {
  const url = `${pub.replace(/\/+$/, "")}/api/health`;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const text = await res.text().catch(() => "");
    if (res.status !== 200) {
      const location = res.headers.get("location");
      return { ok: false, detail: `${url} answered ${res.status}${location ? ` (redirect to ${location})` : ""}.` };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const body = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
    if (!body || body.ok !== true || typeof body.database !== "string") {
      return { ok: false, detail: `${url} answered, but not with the app's health check (${text.slice(0, 120) || "empty"}).` };
    }
    return { ok: true, detail: null };
  } catch (err) {
    return { ok: false, detail: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function plain(err: unknown, ctx: MailgunContext): string {
  if (isMailgunError(err)) return plainMailgunError(err, { domain: ctx.domain, region: ctx.region });
  return "Something unexpected went wrong. Try again.";
}

function detailOf(err: unknown): string | null {
  if (isMailgunError(err)) return err.message;
  return err instanceof Error ? redactText(err.message) : null;
}

/** Releases the running poll job's own dedupe key, so it can queue the next poll under the same key. */
async function releaseDedupeKey(jobId: number | null | undefined, key: string): Promise<void> {
  if (!jobId) return;
  await dbWrite((c) => c.job.updateMany({ where: { id: jobId, activeDedupeKey: key }, data: { activeDedupeKey: null } }));
}

async function enqueueCertPoll(attempt: number, now: Date, byUserId: number | null, jobId: number | null | undefined): Promise<void> {
  await releaseDedupeKey(jobId, CERT_POLL_DEDUPE_KEY);
  await enqueueJob({
    type: "mailgun.applySettings",
    payload: { step: "certificate-poll", attempt },
    runAt: new Date(now.getTime() + CERT_POLL_EVERY_MS),
    dedupeKey: CERT_POLL_DEDUPE_KEY,
    priority: 30,
    maxAttempts: 2,
    createdById: byUserId,
  });
}

/** A route sync in a minute (job "mailgun.syncRoutes"; it retries by itself while Mailgun doesn't answer). */
async function enqueueRouteSync(now: Date, byUserId: number | null): Promise<void> {
  await enqueueJob({
    type: "mailgun.syncRoutes",
    payload: {},
    runAt: new Date(now.getTime() + ROUTE_RETRY_AFTER_MS),
    dedupeKey: "mailgun:routes",
    priority: 30,
    createdById: byUserId,
  });
}

async function enqueueDomainCheck(byUserId: number | null): Promise<void> {
  await enqueueJob({
    type: "mailgun.checkDomain",
    payload: {},
    dedupeKey: "mailgun:domain-check",
    priority: 20,
    createdById: byUserId,
  });
}

type StepInput = { key: SetupStepKey; ok: boolean | null; text: string; detail?: string | null };

/** Replaces the steps with the same keys (keeps the order of the first run), for certificate polls. */
function mergeSteps(old: SetupStep[], fresh: SetupStep[]): SetupStep[] {
  const out = old.map((s) => fresh.find((f) => f.key === s.key) ?? s);
  for (const f of fresh) if (!out.some((s) => s.key === f.key)) out.push(f);
  return out;
}

/**
 * Runs "Apply recommended settings" (`step: "all"`) or one certificate poll (`step: "certificate-poll"`), writes
 * SystemState "mailgun.setup" and returns it. Throws a PlainJobError only when Mailgun isn't connected; every Mailgun
 * problem becomes a failed step with the owner's wording.
 */
export async function runApplySettings(opts: RunApplyOptions): Promise<MailgunSetupState> {
  const ctx = await loadContext(opts.mailgun);
  if (opts.step === "certificate-poll") return runCertificatePoll(ctx, opts);
  return runAll(ctx, opts);
}

async function runAll(ctx: MailgunContext, opts: RunApplyOptions): Promise<MailgunSetupState> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const byUserId = opts.byUserId ?? null;
  const steps: SetupStep[] = [];
  let certificate: CertificateState | null = null;
  const TOTAL = 12;

  const save = async (): Promise<MailgunSetupState> => {
    const state: MailgunSetupState = { runAt: at, byUserId, jobId: opts.jobId ?? null, steps: [...steps], certificate };
    await updateTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState, () => state);
    return state;
  };
  const add = async (s: StepInput) => {
    steps.push({ key: s.key, ok: s.ok, text: s.text, detail: s.detail ?? null, at });
    await save();
    if (opts.progress) await opts.progress(steps.length, TOTAL).catch(() => undefined);
  };

  const settings = await getSettings(["mailgun.messageRetentionDays", "mailgun.unsubscribeTest"] as const);
  const own = ctx.replies === "own-mailbox";
  // Own-mailbox mode always uses Setup A (O13): a restored Setup B never switches unsubscribe handling off here.
  const setup = own ? "A" : parseUnsubscribeTest(settings["mailgun.unsubscribeTest"]).setup;
  const retentionDays = clampDays(settings["mailgun.messageRetentionDays"], 1, 7, 1);
  const d = ctx.domain;
  const client = ctx.client;

  // ── public address ──
  const pub = publicUrl();
  let pubOk = false;
  const pubProblem = publicAddressProblem(pub, ctx.fakeMode);
  if (own && pub === null) {
    // O21: optional in own-mailbox mode; Mailgun's reports come through the hourly Logs check instead.
    await add({ key: "public-address", ok: null, text: OWN_MAILBOX_TEXTS.applyNoPublicAddress });
  } else if (pubProblem) {
    await add({ key: "public-address", ok: false, text: pubProblem });
  } else {
    const health = await checkPublicHealth(pub!, opts.fetchImpl);
    pubOk = health.ok;
    await add(
      health.ok
        ? { key: "public-address", ok: true, text: publicAddressOkText(pub!) }
        : { key: "public-address", ok: false, text: publicAddressDownText(pub!), detail: health.detail },
    );
  }

  // ── the domain as Mailgun has it (needed by several steps) ──
  let info: DomainInfo | null = null;
  let domainError: unknown = null;
  try {
    info = await client.getDomain(d);
  } catch (err) {
    domainError = err;
  }
  if (!info) {
    // Say why once; the steps that need the domain wait for it. The signing key is the account's, so it still runs.
    // In own-mailbox mode the inbound steps aren't needed at all, found or not.
    await add({ key: "tracking-open", ok: false, text: plain(domainError, ctx), detail: detailOf(domainError) });
    for (const key of ["tracking-click", "unsubscribe", "spam-filter", "retention", "certificate", "https"] as const) {
      const notNeeded = own && (key === "spam-filter" || key === "retention");
      await add({ key, ok: null, text: notNeeded ? OWN_MAILBOX_TEXTS.applyNotNeeded : APPLY_TEXTS.skippedNoDomain });
    }
    await signingKeyStep(ctx, add);
    await add({ key: "webhooks", ok: null, text: APPLY_TEXTS.skippedNoDomain });
    await add({ key: "routes", ok: null, text: own ? OWN_MAILBOX_TEXTS.applyNotNeeded : APPLY_TEXTS.skippedNoDomain });
    return finish(ctx, opts, await save(), steps);
  }

  // ── tracking: open, click, unsubscribe (then one read-back) ──
  const putErrors: Partial<Record<"open" | "click" | "unsubscribe", unknown>> = {};
  try {
    await client.setOpenTracking(d, false);
  } catch (err) {
    putErrors.open = err;
  }
  try {
    await client.setClickTracking(d, false);
  } catch (err) {
    putErrors.click = err;
  }
  try {
    await client.setUnsubscribeTracking(d, setup !== "B", { html: "", text: "" });
  } catch (err) {
    putErrors.unsubscribe = err;
  }
  let tracking: Awaited<ReturnType<typeof client.getTracking>> | null = null;
  let trackingError: unknown = null;
  try {
    tracking = await client.getTracking(d);
  } catch (err) {
    trackingError = err;
  }
  for (const which of ["open", "click"] as const) {
    const key = which === "open" ? "tracking-open" : "tracking-click";
    const err = putErrors[which] ?? trackingError;
    if (err) await add({ key, ok: false, text: plain(err, ctx), detail: detailOf(err) });
    else if (which === "open" ? tracking!.openActive : tracking!.clickActive) {
      await add({ key, ok: false, text: which === "open" ? APPLY_TEXTS.openKept : APPLY_TEXTS.clickKept });
    } else await add({ key, ok: true, text: which === "open" ? APPLY_TEXTS.openOff : APPLY_TEXTS.clickOff });
  }
  {
    const err = putErrors.unsubscribe ?? trackingError;
    if (err) {
      await add({ key: "unsubscribe", ok: false, text: plain(err, ctx), detail: detailOf(err) });
    } else if (setup === "B") {
      await add(
        tracking!.unsubscribeActive
          ? { key: "unsubscribe", ok: false, text: APPLY_TEXTS.unsubscribeStillOnB }
          : { key: "unsubscribe", ok: true, text: APPLY_TEXTS.unsubscribeOffB },
      );
    } else if (!tracking!.unsubscribeActive) {
      await add({ key: "unsubscribe", ok: false, text: APPLY_TEXTS.unsubscribeNotOn });
    } else if (tracking!.htmlFooter.trim() !== "" || tracking!.textFooter.trim() !== "") {
      await add({
        key: "unsubscribe",
        ok: false,
        text: APPLY_TEXTS.footersKept,
        detail: `Mailgun's footers: HTML ${JSON.stringify(tracking!.htmlFooter).slice(0, 200)}, text ${JSON.stringify(tracking!.textFooter).slice(0, 200)}`,
      });
    } else {
      await add({ key: "unsubscribe", ok: true, text: APPLY_TEXTS.unsubscribeOn });
    }
  }

  // ── spam filter, retention, PII ──
  if (own) {
    // Nothing inbound reaches Mailgun in own-mailbox mode: neither setting is touched (no Mailgun call).
    await add({ key: "spam-filter", ok: null, text: OWN_MAILBOX_TEXTS.applyNotNeeded });
    await add({ key: "retention", ok: null, text: OWN_MAILBOX_TEXTS.applyNotNeeded });
  } else {
    try {
      if (info.spamAction !== "tag") info = await client.updateDomain(d, { spam_action: "tag" });
      await add({ key: "spam-filter", ok: true, text: APPLY_TEXTS.spamFilter });
    } catch (err) {
      await add({ key: "spam-filter", ok: false, text: plain(err, ctx), detail: detailOf(err) });
    }
    const ttl = retentionDays * DAY_SECONDS;
    try {
      if (info.messageTtl !== ttl) info = await client.updateDomain(d, { message_ttl: ttl });
      await add({ key: "retention", ok: true, text: retentionOkText(retentionDays) });
    } catch (err) {
      const tooLong = isMailgunError(err) && err.status === 400;
      await add({ key: "retention", ok: false, text: tooLong ? APPLY_TEXTS.retentionTooLong : plain(err, ctx), detail: detailOf(err) });
    }
  }
  if (info.webhooksRedactPii === true) {
    try {
      info = await client.updateDomain(d, { webhooks_redact_pii: false });
      await add({ key: "pii", ok: true, text: APPLY_TEXTS.pii });
    } catch (err) {
      await add({ key: "pii", ok: false, text: plain(err, ctx), detail: detailOf(err) });
    }
  }

  // ── certificate and https ──
  const host = `${info.webPrefix || "email"}.${d}`;
  const cnameValid = info.sending.some(
    (r) => r.recordType.toUpperCase() === "CNAME" && (r.name ?? "").toLowerCase().replace(/\.$/, "") === host && r.valid === "valid",
  );
  const cert = await startOrCheckCertificate(ctx, host, cnameValid, now);
  certificate = cert.state;
  // Review DOMAIN-3: in own-mailbox mode a plan without the certificate (Free, O20) is expected, not a failure: the step
  // has no result ("Not in your plan" on the card), the job summary doesn't count it as left to do, and the https step
  // says the links use http. App mode keeps it red (Foundation and higher include the certificate).
  const notInPlan = own && cert.state.status === "not-in-plan";
  await add({ key: "certificate", ok: notInPlan ? null : cert.ok, text: cert.text, detail: cert.detail });
  if (cert.state.status === "processing") await enqueueCertPoll(1, now, byUserId, opts.jobId);
  if (cert.state.status === "active") {
    await add(await httpsStep(ctx, info.webScheme));
  } else {
    await add({
      key: "https",
      ok: null,
      text: notInPlan
        ? APPLY_STEP_TEXTS.httpsNotInPlanOwn
        : cert.state.status === "processing"
          ? APPLY_TEXTS.httpsWaiting
          : APPLY_TEXTS.httpsNeedsCert,
    });
  }

  // ── signing key, webhooks, routes ──
  await signingKeyStep(ctx, add);
  if (own) {
    // O8, O21: webhooks only with a working public address; never a route (the one door, syncRoutes, isn't called).
    // Without any public address they are optional (review SCREENS-06); a public address that doesn't work yet waits.
    if (!pubOk) {
      await add({ key: "webhooks", ok: null, text: pub === null ? APPLY_STEP_TEXTS.webhooksOptionalOwn : APPLY_TEXTS.skippedNoPublicAddress });
    } else {
      const hooks = await registerWebhooks(ctx, `${pub!.replace(/\/+$/, "")}/api/webhooks/mailgun/events`);
      await add({ key: "webhooks", ok: hooks.ok, text: hooks.text, detail: hooks.detail });
    }
    await add({ key: "routes", ok: null, text: OWN_MAILBOX_TEXTS.applyNotNeeded });
  } else if (!pubOk) {
    await add({ key: "webhooks", ok: null, text: APPLY_TEXTS.skippedNoPublicAddress });
    await add({ key: "routes", ok: null, text: APPLY_TEXTS.skippedNoPublicAddress });
  } else {
    const hooks = await registerWebhooks(ctx, `${pub!.replace(/\/+$/, "")}/api/webhooks/mailgun/events`);
    await add({ key: "webhooks", ok: hooks.ok, text: hooks.text, detail: hooks.detail });
    const routes = await syncRoutes({ now, mailgun: async () => ctx, byUserId });
    await add(
      routes.ok
        ? { key: "routes", ok: true, text: routesOkText(routes.senders) }
        : { key: "routes", ok: false, text: routes.problems.join(" ") || "The reply routes couldn't be set up. Try again." },
    );
    // Mailgun didn't answer, or couldn't confirm a new route yet: the route sync job tries again by itself.
    if (!routes.ok && routes.retryable) await enqueueRouteSync(now, byUserId);
  }

  return finish(ctx, opts, await save(), steps);
}

/** Activity, then a fresh domain check. */
async function finish(ctx: MailgunContext, opts: RunApplyOptions, state: MailgunSetupState, steps: SetupStep[]): Promise<MailgunSetupState> {
  const done = steps.filter((s) => s.ok === true).length;
  const actor = opts.byUserId ? await db.user.findUnique({ where: { id: opts.byUserId }, select: { name: true } }) : null;
  await logActivity({
    actorId: opts.byUserId ?? null,
    type: "mailgun.settingsApplied",
    summary: `${actor?.name ?? "The app"} applied the recommended Mailgun settings to ${ctx.domain}: ${done} of ${steps.length} steps done`,
    data: { domain: ctx.domain, done, total: steps.length, failed: steps.filter((s) => s.ok === false).map((s) => s.key) },
  }).catch((err: unknown) => console.error("[apply] couldn't log the activity", err));
  await enqueueDomainCheck(opts.byUserId ?? null);
  return state;
}

type AddFn = (s: StepInput) => Promise<void>;

async function signingKeyStep(ctx: MailgunContext, add: AddFn): Promise<void> {
  try {
    const key = await ctx.client.getSigningKey();
    let saved: string | null = null;
    try {
      saved = await getSecret("mailgun.webhookSigningKey");
    } catch {
      saved = null; // unreadable: save the fresh one
    }
    if (saved !== key) await setSecret("mailgun.webhookSigningKey", key, null);
    await add({ key: "signing-key", ok: true, text: APPLY_TEXTS.signingKeySaved });
  } catch (err) {
    const missing = isMailgunError(err) && err.status === 400;
    await add({ key: "signing-key", ok: false, text: missing ? APPLY_TEXTS.signingKeyMissing : plain(err, ctx), detail: detailOf(err) });
  }
}

type CertOutcome = { state: CertificateState; ok: boolean | null; text: string; detail: string | null };

/** Looks at the certificate first (an active one needs nothing), then starts or renews it when the CNAME allows. */
async function startOrCheckCertificate(ctx: MailgunContext, host: string, cnameValid: boolean, now: Date): Promise<CertOutcome> {
  const at = now.toISOString();
  const state = (status: CertificateState["status"], error: string | null = null, startedAt: string | null = null): CertificateState => ({
    host,
    status,
    startedAt,
    lastPolledAt: at,
    error,
  });
  let current: Awaited<ReturnType<typeof ctx.client.getCertificateStatus>>;
  try {
    current = await ctx.client.getCertificateStatus(host);
  } catch (err) {
    return { state: state("error", detailOf(err)), ok: false, text: plain(err, ctx), detail: detailOf(err) };
  }
  if (current.status === "active") return { state: state("active"), ok: true, text: APPLY_TEXTS.certReady, detail: null };
  if (current.status === "processing") {
    return { state: state("processing", null, at), ok: true, text: APPLY_TEXTS.certPreparing, detail: null };
  }
  if (!cnameValid) return { state: state("cname-missing"), ok: false, text: certCnameText(host), detail: null };
  try {
    if (current.status === "expired") {
      const r = await ctx.client.regenerateCertificate(host);
      if (r === "still-valid") return { state: state("active"), ok: true, text: APPLY_TEXTS.certReady, detail: null };
    } else {
      await ctx.client.startCertificate(host);
    }
    return { state: state("processing", null, at), ok: true, text: APPLY_TEXTS.certPreparing, detail: null };
  } catch (err) {
    if (isMailgunError(err) && err.status === 400) {
      return { state: state("cname-missing", err.mailgunMessage), ok: false, text: certCnameText(host), detail: err.message };
    }
    if (isMailgunError(err) && err.status === 402) {
      return { state: state("not-in-plan", err.mailgunMessage), ok: false, text: APPLY_TEXTS.certNotInPlan, detail: err.message };
    }
    return { state: state("error", detailOf(err)), ok: false, text: plain(err, ctx), detail: detailOf(err) };
  }
}

/** web_scheme https (the certificate is active), checked by reading the tracking settings back. */
async function httpsStep(ctx: MailgunContext, webScheme: DomainInfo["webScheme"]): Promise<StepInput> {
  try {
    if (webScheme !== "https") await ctx.client.updateDomain(ctx.domain, { web_scheme: "https" });
    const tracking = await ctx.client.getTracking(ctx.domain);
    if (tracking.webScheme !== "https") {
      return { key: "https", ok: false, text: "Mailgun didn't switch unsubscribe links to https yet. Click Apply recommended settings again in a few minutes." };
    }
    return { key: "https", ok: true, text: APPLY_TEXTS.httpsOn };
  } catch (err) {
    return { key: "https", ok: false, text: plain(err, ctx), detail: detailOf(err) };
  }
}

/**
 * One certificate poll (every 60 s, its own job, up to 30 times): active → web_scheme https, read back, tell the Owner;
 * expired → renew and keep polling; still processing at 30 → "check again later"; failed → a red step. Afterwards (when
 * it stops polling) a fresh domain check. It only polls the certificate Apply recorded for the current domain: after a
 * domain change a queued poll for the old host stops without calling Mailgun.
 */
async function runCertificatePoll(ctx: MailgunContext, opts: RunApplyOptions): Promise<MailgunSetupState> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const attempt = Math.max(1, Math.floor(opts.attempt ?? 1));
  const byUserId = opts.byUserId ?? null;
  const stored = await readSetup();
  const previous = stored.certificate;
  if (!previous || !certificateHostFits(previous.host, ctx.domain)) {
    // Nothing of this domain to poll: no certificate on record (the domain changed and its old Apply run was cleared),
    // or one for the old domain's host. Polling it would start a certificate nobody asked for, or switch this domain to
    // https because another domain's certificate is ready. Clear what belongs to the old domain and stop.
    let value = stored;
    if (previous) {
      const res = await updateTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState, (cur) =>
        cur.certificate && !certificateHostFits(cur.certificate.host, ctx.domain) ? EMPTY_SETUP_STATE : null,
      );
      value = res.value;
    }
    await enqueueDomainCheck(byUserId);
    if (opts.progress) await opts.progress(1, 1).catch(() => undefined);
    return value;
  }
  const host = previous.host;
  const cert = (status: CertificateState["status"], error: string | null = null): CertificateState => ({
    host,
    status,
    startedAt: previous.startedAt ?? at,
    lastPolledAt: at,
    error,
  });
  const fresh: SetupStep[] = [];
  let certificate: CertificateState;
  let keepPolling = false;

  try {
    const status = await ctx.client.getCertificateStatus(host);
    if (status.status === "active") {
      certificate = cert("active");
      fresh.push({ key: "certificate", ok: true, text: APPLY_TEXTS.certReady, detail: null, at });
      const info = await ctx.client.getDomain(ctx.domain).catch(() => null);
      const https = await httpsStep(ctx, info?.webScheme ?? null);
      fresh.push({ key: "https", ok: https.ok, text: https.text, detail: https.detail ?? null, at });
      if (https.ok && previous.status !== "active") {
        await notifyOwner({
          type: "system.mailgun",
          title: "Secure unsubscribe links are ready",
          body: "Mailgun finished the certificate, so the unsubscribe links in your emails now use https.",
          link: "/settings/domain",
        }).catch((err: unknown) => console.error("[apply] couldn't notify the Owner", err));
      }
    } else if (status.status === "processing" || status.status === "expired" || status.status === "none") {
      if (status.status === "expired") await ctx.client.regenerateCertificate(host);
      if (status.status === "none") await ctx.client.startCertificate(host);
      if (attempt >= CERT_POLL_MAX) {
        certificate = cert("processing");
        fresh.push({ key: "certificate", ok: null, text: APPLY_TEXTS.certStillPreparing, detail: null, at });
      } else {
        certificate = cert("processing");
        fresh.push({ key: "certificate", ok: true, text: APPLY_TEXTS.certPreparing, detail: `Check ${attempt} of ${CERT_POLL_MAX}.`, at });
        keepPolling = true;
      }
    } else {
      certificate = cert("error", status.error);
      fresh.push({
        key: "certificate",
        ok: false,
        text: `Mailgun couldn't make the certificate${status.error ? ` (${status.error})` : ""}. Click Apply recommended settings to try again.`,
        detail: status.error,
        at,
      });
    }
  } catch (err) {
    certificate = cert("error", detailOf(err));
    fresh.push({ key: "certificate", ok: false, text: plain(err, ctx), detail: detailOf(err), at });
    keepPolling = !(isMailgunError(err) && err.status !== null && err.status >= 400 && err.status < 500) && attempt < CERT_POLL_MAX;
  }

  const res = await updateTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState, (cur) => ({
    ...cur,
    steps: mergeSteps(cur.steps, fresh),
    certificate,
  }));
  if (keepPolling) await enqueueCertPoll(attempt + 1, now, byUserId, opts.jobId);
  else await enqueueDomainCheck(byUserId);
  if (opts.progress) await opts.progress(1, 1).catch(() => undefined);
  return res.value;
}

async function readSetup(): Promise<MailgunSetupState> {
  return (await readTyped(STATE_KEYS.mailgunSetup, parseMailgunSetupState)).value;
}

/** The job payload: `{step?: "all" | "certificate-poll", attempt?: number}`. */
export function parseApplyPayload(payload: unknown): { step: ApplyStepMode; attempt: number } {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const step: ApplyStepMode = p.step === "certificate-poll" ? "certificate-poll" : "all";
  const attempt = typeof p.attempt === "number" && Number.isFinite(p.attempt) && p.attempt >= 1 ? Math.floor(p.attempt) : 1;
  return { step, attempt };
}

/** Job "mailgun.applySettings" (dedupe "mailgun:apply"; certificate polls "mailgun:cert-poll"). */
export const applySettingsHandler: JobHandler = async (payload, jobCtx) => {
  const { step, attempt } = parseApplyPayload(payload);
  try {
    const state = await runApplySettings({
      byUserId: jobCtx.createdById,
      jobId: jobCtx.jobId,
      step,
      attempt,
      progress: jobCtx.progress,
    });
    if (step === "certificate-poll") {
      const status = state.certificate?.status ?? "none";
      return { summary: `Certificate: ${status} (check ${attempt} of ${CERT_POLL_MAX}).`, status };
    }
    const done = state.steps.filter((s) => s.ok === true).length;
    const failed = state.steps.filter((s) => s.ok === false).length;
    return {
      summary: failed
        ? `${done} of ${state.steps.length} steps done. Open the Domain checklist to see what's left.`
        : `All ${done} steps done.`,
      done,
      failed,
    };
  } catch (err) {
    if (err instanceof PlainJobError) throw err;
    throw new PlainJobError(
      "Apply recommended settings didn't finish. Try again in a few minutes.",
      redactText(err instanceof Error ? err.message : String(err), await mailgunSecrets()),
    );
  }
};
