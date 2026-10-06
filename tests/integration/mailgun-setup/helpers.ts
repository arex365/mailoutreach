/**
 * Test data for the Mailgun setup, sender address and test-send integration tests (M3-DESIGN §8 P5). Call createTestDb()
 * (and usually connectFakeMailgun()) first: every helper imports server modules lazily.
 */
import type { CheckStatus, ChecklistRowKey, ChecklistGroup } from "@/core/system-state";

let seq = 0;

export async function makeUser(
  name: string,
  opts: { role?: "OWNER" | "MEMBER"; email?: string; replyInbox?: string | null; active?: boolean; signature?: string } = {},
) {
  const { dbWrite } = await import("@/server/db");
  seq += 1;
  const email = opts.email ?? `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@polygonparadise.test`;
  return dbWrite((c) =>
    c.user.create({
      data: {
        name,
        email,
        role: opts.role ?? "MEMBER",
        senderDisplayName: `${name} from Polygon Paradise`,
        replyInbox: opts.replyInbox === undefined ? `${name.toLowerCase()}.${seq}@gmail.com` : opts.replyInbox,
        active: opts.active ?? true,
        signature: opts.signature ?? name,
      },
    }),
  );
}

/** A sending address on a domain, like setSenderLocalPart makes (without the route sync). */
export async function addSenderAddress(userId: number, domainId: number, localPart: string, routeStatus: string | null = "pending") {
  const { dbWrite, db } = await import("@/server/db");
  const domain = await db.sendingDomain.findUniqueOrThrow({ where: { id: domainId } });
  return dbWrite((c) =>
    c.senderAddress.create({ data: { userId, domainId, localPart, address: `${localPart}@${domain.name}`, routeStatus } }),
  );
}

/**
 * The rows every call writes (today's 20, per-person mode). Partial on purpose: the shared-From rows ("from-mx",
 * "from-spf", SHARED-FROM-DESIGN §7.5) are written only when `statuses` names them, so existing callers are unchanged.
 */
const GROUP: Partial<Record<ChecklistRowKey, ChecklistGroup>> = {
  "mailgun-domain": "mailgun",
  spf: "dns",
  dkim: "dns",
  mx: "dns",
  "tracking-cname": "dns",
  "https-links": "dns",
  dmarc: "dns",
  "tracking-off": "settings",
  unsubscribe: "settings",
  "spam-filter": "settings",
  retention: "settings",
  "signing-key": "settings",
  webhooks: "settings",
  "reply-routes": "settings",
  "sending-allowed": "settings",
  "monthly-limit": "settings",
  "remote-access": "connection",
  "reply-test": "connection",
  postmaster: "optional",
  "domain-age": "optional",
};

/** The shared-From rows, in checklist order (right after dmarc), group "dns". */
const TEAM_FROM_ROWS: readonly ChecklistRowKey[] = ["from-mx", "from-spf"];

/**
 * Writes SystemState "domain.check" as the domain check (P4) would: every row "ok" unless `statuses` says otherwise. The
 * shared-From rows (from-mx, from-spf) are written only when `statuses` names them, right after dmarc.
 */
export async function writeDomainCheck(domain: string, statuses: Partial<Record<ChecklistRowKey, CheckStatus>> = {}) {
  const { setState } = await import("@/server/state");
  const keys = (Object.keys(GROUP) as ChecklistRowKey[]).flatMap((key) =>
    key === "dmarc" ? [key, ...TEAM_FROM_ROWS.filter((k) => statuses[k] !== undefined)] : [key],
  );
  const rows = keys.map((key) => ({
    key,
    group: GROUP[key] ?? "dns",
    status: statuses[key] ?? "ok",
    title: `Row ${key}`,
    text: `Text of ${key}`,
    fix: statuses[key] && statuses[key] !== "ok" ? `Fix ${key}` : null,
    records: [],
    detail: null,
  }));
  await setState("domain.check", { domain, region: "EU", checkedAt: new Date().toISOString(), lastVerifyAt: null, rows, error: null });
}

/** A fetch that answers `<pub>/api/health` like the app does (and nothing else). */
export function healthFetch(opts: { status?: number; body?: unknown; location?: string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith("/api/health")) throw new Error(`Unexpected fetch in a test: ${url}`);
    const status = opts.status ?? 200;
    return new Response(opts.body === undefined ? JSON.stringify({ ok: true, database: "ok", workerLastSeen: null, time: new Date().toISOString() }) : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body), {
      status,
      headers: { "content-type": "application/json", ...(opts.location ? { location: opts.location } : {}) },
    });
  }) as typeof fetch;
}

/** getMailgunContext without waits between retries (fake 404s and 429s would otherwise wait 5–60 s). */
export async function fastMailgun() {
  const { getMailgunContext } = await import("@/server/mailgun/context");
  return getMailgunContext({ retryDelayMs: () => 0 });
}

export async function setSettingValue(key: string, value: unknown) {
  const { dbWrite } = await import("@/server/db");
  await dbWrite((c) => c.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } }));
}

/** A loopback port nothing listens on (bound, then closed), for "Mailgun can't be reached". */
export async function closedPort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Jobs of one type still queued. */
export async function queuedJobs(type: string) {
  const { db } = await import("@/server/db");
  return db.job.findMany({ where: { type, status: "QUEUED" }, orderBy: { id: "asc" } });
}

export async function clearJobs() {
  const { dbWrite } = await import("@/server/db");
  await dbWrite((c) => c.job.deleteMany({}));
}
