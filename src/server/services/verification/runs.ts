import type { Job, VerificationStatus, Risk } from "@/generated/prisma/client";
import { GENERAL_INBOX_NAME } from "@/core/email-address";
import { roundUsd } from "@/core/money";
import { DEFAULT_VERIFICATION_POLICY, type CheckDecision, type VerificationPolicy } from "@/core/rules/eligibility";
import { checkBucket, emptyCheckRunCounts } from "@/core/verification/policy";
import {
  EMPTY_VERIFY_CARRY,
  type CheckRunCounts,
  type CheckSingleOutcome,
  type RiskValue,
  type VerificationStatusValue,
  type VerifyRunCarry,
  type VerifyRunPayload,
} from "@/core/verification/types";
import { leftOutWords } from "@/core/verification/words";
import { db } from "@/server/db";
import { toPublicJob } from "@/server/jobs";
import { getSetting } from "@/server/settings";

/**
 * Check runs as the screens see them (M5-DESIGN §2.5, §2.11, §6.1, §6.11): a run's counts (from its
 * `VerificationCheck` rows plus the counters the job carries), its one-address outcome (panel and Settings runs), who
 * it left out, and the Verify step's current run. Per-address outcomes never go through `toPublicJob`: screens read
 * them here after the poll says the job is done.
 *
 * How the check job (P6) should leave its result so these readers find everything: `summary`, `counts` (the
 * CheckRunCounts it announced, frozen at the end), `carry` (VerifyRunCarry) and, for panel and Settings runs,
 * `single`. Without `counts`, they are counted again from the rows and `carry`. Unreadable answers are counted from
 * their rows (reason "app:unreadable_response") as not reached, so `carry.notReached` holds only addresses that got no
 * row at all.
 */

export const VERIFY_JOB_TYPE = "verify.addresses" as const;
/** The reason stored on a charged row whose answer couldn't be read (§2.3). */
export const UNREADABLE_REASON = "app:unreadable_response";

/**
 * A plain-language refusal of the check services (start, stop, views): paused, not ready, the count changed, over the
 * monthly limit… Server Actions show `message` as it is; `code` is a stable tag for tests and screens.
 */
export class CheckRunError extends Error {
  readonly userFacing = true as const;
  readonly code: string;
  constructor(message: string, code = "checks") {
    super(message);
    this.name = "CheckRunError";
    this.code = code;
  }
}

/** The refusal for a job id that isn't an address check run (Stop buttons act on their own job type only). */
export const NOT_A_CHECK_RUN = "This isn't an address check run.";

/** One row of "Who is left out": "Anna Berg · anna@firma.de · Firma GmbH — doesn't exist". */
export type CheckLeftOut = { personId: number; name: string; email: string; companyName: string; reason: string };

// ───────────────────────── lenient readers of the job's payload and result ─────────────────────────

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function ids(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0) : [];
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

const STATUSES: readonly VerificationStatusValue[] = ["VALID", "INVALID", "RISKY", "CATCH_ALL", "UNKNOWN", "DO_NOT_SEND"];
const RISKS: readonly RiskValue[] = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"];
const DECISIONS: readonly CheckDecision[] = ["send", "block", "recheck", "undeliverable", "do-not-send"];

/** A `verify.addresses` payload, or null when it isn't one. */
export function readVerifyRunPayload(v: unknown): VerifyRunPayload | null {
  const o = obj(v);
  if (!o) return null;
  const confirmedCount = count(o.confirmedCount);
  switch (o.source) {
    case "wizard":
      return typeof o.campaignId === "number" ? { source: "wizard", campaignId: o.campaignId, personIds: ids(o.personIds), confirmedCount } : null;
    case "contacts":
    case "list":
    case "panel":
      return {
        source: o.source,
        personIds: ids(o.personIds),
        confirmedCount,
        recheckRecent: o.recheckRecent === true,
        listId: typeof o.listId === "number" ? o.listId : null,
      };
    case "settings":
      return typeof o.address === "string" ? { source: "settings", address: o.address } : null;
    case "recheck":
      return { source: "recheck" };
    default:
      return null;
  }
}

/** A panel or Settings run's one-address outcome, or null. */
export function readCheckSingleOutcome(v: unknown): CheckSingleOutcome | null {
  const o = obj(v);
  const outcome = o ? oneOf(o.outcome, ["checked", "refused", "skipped", "not-reached"] as const) : null;
  if (!o || !outcome) return null;
  return {
    personId: typeof o.personId === "number" && Number.isInteger(o.personId) ? o.personId : null,
    outcome,
    skipReason: oneOf(o.skipReason, ["suppressed", "no-email", "never-emailed"] as const),
    status: oneOf(o.status, STATUSES),
    risk: oneOf(o.risk, RISKS),
    disposable: o.disposable === true,
    decision: oneOf(o.decision, DECISIONS),
    ms: typeof o.ms === "number" && Number.isFinite(o.ms) && o.ms >= 0 ? o.ms : null,
    detail: typeof o.detail === "string" ? o.detail : null,
  };
}

function skipped(v: unknown): VerifyRunCarry["skipped"] {
  const o = obj(v) ?? {};
  return { fresh: count(o.fresh), suppressed: count(o.suppressed), noEmail: count(o.noEmail), neverEmailed: count(o.neverEmailed) };
}

/** The check job's carry (VerifyRunCarry), with anything missing or broken at its empty value. */
export function readVerifyRunCarry(v: unknown): VerifyRunCarry {
  const o = obj(v);
  if (!o) return { ...EMPTY_VERIFY_CARRY, pending: [], failed: [], timeouts: {}, uncommitted: [], skipped: { ...EMPTY_VERIFY_CARRY.skipped } };
  const timeouts: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(o.timeouts) ?? {})) {
    if (/^\d+$/.test(k) && count(n) > 0) timeouts[k] = count(n);
  }
  const uncommitted: VerifyRunCarry["uncommitted"] = [];
  for (const x of Array.isArray(o.uncommitted) ? o.uncommitted : []) {
    const u = obj(x);
    const result = u ? obj(u.result) : null;
    if (!u || !result || typeof u.emailNorm !== "string" || !oneOf(result.status, STATUSES)) continue;
    uncommitted.push(x as VerifyRunCarry["uncommitted"][number]);
  }
  return {
    cursor: count(o.cursor),
    pending: ids(o.pending),
    failed: ids(o.failed),
    timeouts,
    uncommitted,
    retries: count(o.retries),
    unreadableInARow: count(o.unreadableInARow),
    skipped: skipped(o.skipped),
    refused: count(o.refused),
    notReached: count(o.notReached),
    mayBeCharged: count(o.mayBeCharged),
    single: readCheckSingleOutcome(o.single),
  };
}

const COUNT_KEYS = [
  "checked",
  "canEmail",
  "lowRiskCatchAll",
  "invalid",
  "doNotSend",
  "risky",
  "catchAllBlocked",
  "disposable",
  "unknown",
  "refused",
  "notReached",
  "mayBeCharged",
] as const;

/** A run's counts as stored in its result (`result.counts`), or null when none (or a broken one) is stored. */
export function readCheckRunCounts(v: unknown): CheckRunCounts | null {
  const o = obj(v);
  if (!o) return null;
  const out = emptyCheckRunCounts();
  for (const k of COUNT_KEYS) {
    if (typeof o[k] !== "number") return null;
    out[k] = count(o[k]);
  }
  out.skipped = skipped(o.skipped);
  out.costUsd = typeof o.costUsd === "number" && Number.isFinite(o.costUsd) && o.costUsd > 0 ? roundUsd(o.costUsd) : 0;
  return out;
}

// ───────────────────────── counts ─────────────────────────

/** Setting "verification.policy" over the defaults (the same merge as the eligibility settings). */
async function currentPolicy(): Promise<VerificationPolicy> {
  const stored = (await getSetting("verification.policy")) as Partial<VerificationPolicy> | null;
  return { ...DEFAULT_VERIFICATION_POLICY, ...(stored ?? {}) };
}

type RunRow = {
  id: number;
  personId: number | null;
  emailNorm: string;
  status: VerificationStatus;
  risk: Risk;
  isDisposable: boolean;
  reasons: unknown;
  costUsd: number | null;
};

function isUnreadable(reasons: unknown): boolean {
  return Array.isArray(reasons) && reasons.includes(UNREADABLE_REASON);
}

/** A run's rows and, per address, the latest one (a resumed run never checks one address twice; this is defensive). */
async function runRows(jobId: number): Promise<{ rows: RunRow[]; latest: RunRow[] }> {
  const rows = await db.verificationCheck.findMany({
    where: { jobId },
    select: { id: true, personId: true, emailNorm: true, status: true, risk: true, isDisposable: true, reasons: true, costUsd: true },
    orderBy: { id: "asc" },
  });
  const byNorm = new Map<string, RunRow>();
  for (const r of rows) byNorm.set(r.emailNorm, r);
  return { rows, latest: [...byNorm.values()].sort((a, b) => a.id - b.id) };
}

/**
 * What a run counted (CheckRunCounts, M5-DESIGN §5.8): verdicts, buckets (with the current policy) and cost from the
 * job's `VerificationCheck` rows, the refused, not reached and skipped counters from its carry. `carry` defaults to the
 * one stored in the job's result; the check job passes its own (newer) carry when it finishes.
 */
export async function checkRunCounts(jobId: number, carry?: VerifyRunCarry | null): Promise<CheckRunCounts> {
  const [{ rows, latest }, policy, stored] = await Promise.all([
    runRows(jobId),
    currentPolicy(),
    carry === undefined ? db.job.findUnique({ where: { id: jobId }, select: { result: true } }) : Promise.resolve(null),
  ]);
  const used = carry === undefined ? readVerifyRunCarry(obj(stored?.result)?.carry) : (carry ?? readVerifyRunCarry(null));
  const c = emptyCheckRunCounts();
  let cost = 0;
  for (const r of rows) cost += r.costUsd ?? 0;
  for (const r of latest) {
    if (isUnreadable(r.reasons)) {
      c.notReached += 1;
      continue;
    }
    c.checked += 1;
    const b = checkBucket({ status: r.status, risk: r.risk, disposable: r.isDisposable }, policy);
    c[b.bucket] += 1;
    if (b.lowRiskCatchAll) c.lowRiskCatchAll += 1;
  }
  c.refused = used.refused;
  c.notReached += used.notReached;
  c.mayBeCharged = Math.min(used.mayBeCharged, c.notReached);
  c.skipped = { ...used.skipped };
  c.costUsd = roundUsd(cost);
  return c;
}

/** "Anna Berg", "General inbox", or the address when there's no name. */
function displayName(p: { name: string; isGeneric: boolean; email: string | null }): string {
  if (p.isGeneric) return GENERAL_INBOX_NAME;
  return p.name.trim() || p.email || "No name";
}

/**
 * The people a run's results leave out (for "Who is left out"): every checked person whose result the policy
 * doesn't send, except a first "no answer" that gets its second check. Unreadable answers leave nobody out.
 */
async function runLeftOut(jobId: number): Promise<CheckLeftOut[]> {
  const [{ latest }, policy] = await Promise.all([runRows(jobId), currentPolicy()]);
  const wanted: Array<{ personId: number; reason: string }> = [];
  for (const r of latest) {
    if (r.personId === null || isUnreadable(r.reasons)) continue;
    const b = checkBucket({ status: r.status, risk: r.risk, disposable: r.isDisposable }, policy);
    if (b.bucket === "canEmail" || (b.bucket === "unknown" && b.decision === "recheck")) continue;
    wanted.push({ personId: r.personId, reason: leftOutWords(b.bucket) });
  }
  if (wanted.length === 0) return [];
  const people = new Map<number, { name: string; isGeneric: boolean; email: string | null; company: { name: string } }>();
  const idList = wanted.map((w) => w.personId);
  for (let i = 0; i < idList.length; i += 400) {
    const found = await db.person.findMany({
      where: { id: { in: idList.slice(i, i + 400) } },
      select: { id: true, name: true, isGeneric: true, email: true, company: { select: { name: true } } },
    });
    for (const p of found) people.set(p.id, p);
  }
  const out: CheckLeftOut[] = [];
  for (const w of wanted) {
    const p = people.get(w.personId);
    if (!p) continue;
    out.push({ personId: w.personId, name: displayName(p), email: p.email ?? "", companyName: p.company.name, reason: w.reason });
  }
  return out;
}

// ───────────────────────── views ─────────────────────────

export type CheckRunView = {
  status: Job["status"];
  done: number;
  total: number;
  summary: string | null;
  /** A deferred run waits until this instant ("Waiting: …"). */
  waitingUntil: string | null;
  /** The plain sentence of a failed run (e.g. the key was removed after the start), else null. */
  error: string | null;
  /** When the run has finished (done, stopped or failed); null while it is queued or running. */
  counts: CheckRunCounts | null;
  /** Panel and Settings runs: their one address. */
  single: CheckSingleOutcome | null;
  /** Who the run's results leave out (empty until it has finished). */
  leftOut: CheckLeftOut[];
};

const FINISHED: ReadonlySet<Job["status"]> = new Set(["DONE", "FAILED", "CANCELLED"]);

/** One check run for its screen (`checkRunViewAction`). Refuses a job id of any other type. */
export async function checkRunView(jobId: number, now: Date = new Date()): Promise<CheckRunView> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.type !== VERIFY_JOB_TYPE) throw new CheckRunError(NOT_A_CHECK_RUN, "not-a-check-run");
  const pub = toPublicJob(job, now);
  const result = obj(job.result);
  const finished = FINISHED.has(job.status);
  const counts = finished ? (readCheckRunCounts(result?.counts) ?? (await checkRunCounts(jobId))) : null;
  const single = readCheckSingleOutcome(result?.single) ?? readVerifyRunCarry(result?.carry).single;
  return {
    status: job.status,
    done: job.progressDone,
    total: job.progressTotal,
    summary: pub.summary,
    waitingUntil: pub.waitingUntil,
    error: pub.error,
    counts,
    single,
    leftOut: finished ? await runLeftOut(jobId) : [],
  };
}

/** The dedupe key of a campaign's Verify-step run (M5-DESIGN §2.5). */
export function campaignRunKey(campaignId: number): string {
  return `verify:campaign:${campaignId}`;
}

/** True when a check run other than `jobId` is running right now (a queued run waits for it: one per lane). */
async function otherRunRunning(jobId: number): Promise<boolean> {
  return (await db.job.count({ where: { type: VERIFY_JOB_TYPE, status: "RUNNING", id: { not: jobId } } })) > 0;
}

/**
 * A campaign's queued or running check run (the launch refuses while there is one, M5-DESIGN §6.1), or null.
 * `queuedBehindOther`: it is due but waits for another check run.
 */
export async function activeCampaignCheckRun(
  campaignId: number,
  now: Date = new Date(),
): Promise<{ jobId: number; done: number; total: number; queuedBehindOther: boolean } | null> {
  const job = await db.job.findUnique({ where: { activeDedupeKey: campaignRunKey(campaignId) } });
  if (!job || job.type !== VERIFY_JOB_TYPE || (job.status !== "QUEUED" && job.status !== "RUNNING")) return null;
  const queuedBehindOther = job.status === "QUEUED" && job.runAt <= now && (await otherRunRunning(job.id));
  return { jobId: job.id, done: job.progressDone, total: job.progressTotal, queuedBehindOther };
}

/** The Verify step's run: the campaign's active run, else its latest one. */
export type CampaignCheckRunInfo = {
  jobId: number;
  status: string;
  done: number;
  total: number;
  summary: string | null;
  waitingUntil: string | null;
  /** Queued and due, but another check run is going on. */
  blockedByOtherRun: boolean;
};

/** The id of the campaign's latest Verify-step run (any status), or null. */
async function latestCampaignRunId(campaignId: number): Promise<number | null> {
  try {
    const rows = await db.$queryRaw<Array<{ id: number | bigint }>>`
      SELECT id FROM "Job"
      WHERE type = ${VERIFY_JOB_TYPE}
        AND json_extract(payload, '$.source') = 'wizard'
        AND json_extract(payload, '$.campaignId') = ${campaignId}
      ORDER BY id DESC
      LIMIT 1`;
    return rows[0] ? Number(rows[0].id) : null;
  } catch {
    // Fallback if the stored JSON can't be read by SQLite's json functions: the newest runs, read in code.
    const recent = await db.job.findMany({
      where: { type: VERIFY_JOB_TYPE },
      select: { id: true, payload: true },
      orderBy: { id: "desc" },
      take: 500,
    });
    const hit = recent.find((j) => {
      const p = readVerifyRunPayload(j.payload);
      return p?.source === "wizard" && p.campaignId === campaignId;
    });
    return hit?.id ?? null;
  }
}

/** The campaign's current (or else latest) Verify-step run for the Verify step, or null when it never had one. */
export async function campaignCheckRun(campaignId: number, now: Date = new Date()): Promise<CampaignCheckRunInfo | null> {
  let job = await db.job.findUnique({ where: { activeDedupeKey: campaignRunKey(campaignId) } });
  if (!job || job.type !== VERIFY_JOB_TYPE) {
    const id = await latestCampaignRunId(campaignId);
    job = id !== null ? await db.job.findUnique({ where: { id } }) : null;
  }
  if (!job) return null;
  const pub = toPublicJob(job, now);
  const due = job.status === "QUEUED" && job.runAt <= now;
  return {
    jobId: job.id,
    status: job.status,
    done: job.progressDone,
    total: job.progressTotal,
    summary: pub.summary,
    waitingUntil: pub.waitingUntil,
    blockedByOtherRun: due && (await otherRunRunning(job.id)),
  };
}
