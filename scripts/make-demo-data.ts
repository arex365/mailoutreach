/// <reference types="node" />
/**
 * Creates the practice copy's database with made-up companies (PLAN.md A1, B6.5).
 *
 *   node --import tsx scripts/make-demo-data.ts            fill data/demo.db (only when it's empty)
 *   node --import tsx scripts/make-demo-data.ts --reset    delete data/demo.db and create it again
 *   --db <path>                                           another file (tests); never data/app.db
 *
 * DATABASE_URL is pointed at the practice database BEFORE any server module is imported, so
 * the real data can't be touched. Every derived field uses the same helpers as the app.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DEMO_COMPANIES,
  DEMO_CUSTOM_FIELDS,
  DEMO_IMPORT_DAYS_AGO,
  DEMO_LISTS,
  DEMO_PASSWORD,
  DEMO_USERS,
  type DemoCompany,
  type DemoUserKey,
  type ListKey,
} from "./lib/demo-dataset";
import { databasePathFromUrl, parseEnv } from "./lib/env-file.mjs";
import { supervisorState } from "./lib/proc.mjs";
import type { Tx } from "@/server/db";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const { values: args } = parseArgs({
  options: { reset: { type: "boolean", default: false }, db: { type: "string" } },
  strict: true,
});

const target = path.resolve(ROOT, args.db ?? "data/demo.db");

function sameFile(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function refuse(message: string): never {
  console.log(`  [x]  ${message}`);
  process.exit(1);
}

// Never the real database: not data/app.db, and not whatever .env points at.
if (path.basename(target).toLowerCase() === "app.db") refuse("The practice data can't be written into app.db (your real data).");
try {
  const realUrl = parseEnv(fs.readFileSync(path.join(ROOT, ".env"), "utf8")).DATABASE_URL;
  if (realUrl && sameFile(databasePathFromUrl(realUrl, ROOT), target)) {
    refuse("That file is the database in .env (your real data). The practice copy uses data\\demo.db.");
  }
} catch {
  /* no .env yet: nothing to protect */
}
if (sameFile(target, path.join(ROOT, "data", "demo.db")) && supervisorState(path.join(ROOT, "run", "demo.pid")).running) {
  refuse("The practice copy is running. Close its window first, then try again.");
}

const databaseUrl = "file:" + target.replace(/\\/g, "/");
process.env.DATABASE_URL = databaseUrl;

if (args.reset) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(target + suffix, { force: true });
  console.log("  Deleted the old practice data.");
}

fs.mkdirSync(path.dirname(target), { recursive: true });
const migrate = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1", DOTENV_CONFIG_QUIET: "true" },
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.status !== 0) {
  console.log(`${migrate.stdout ?? ""}${migrate.stderr ?? ""}`);
  refuse("Creating the practice database failed (prisma migrate deploy).");
}

// Server modules only now, after DATABASE_URL points at the practice database.
const { db, dbTx } = await import("@/server/db");
const { hashPassword } = await import("@/lib/auth/password");
const { refreshCompanySearchText } = await import("@/server/company-search");
const { priorityRank, lastContactAt } = await import("@/server/services/companies/filters");
const { normalizeCompanyName, firstNameFrom } = await import("@/core/text");
const { parseEmail, isRoleAddress, GENERAL_INBOX_NAME } = await import("@/core/email-address");
const { parseWebsite, instagramHandle } = await import("@/core/shared-domains");
const { normalizeCountry, defaultTimeZoneFor } = await import("@/core/geo/countries");
const { COMPANY_STATUS_LABELS } = await import("@/core/labels");

type ActivityRow = {
  at: Date;
  actorId: number | null;
  type: string;
  summary: string;
  companyId?: number | null;
  personId?: number | null;
  data?: Record<string, string | number | boolean>;
};

const now = Date.now();
const daysAgo = (days: number, hour = 0) => new Date(now - days * 86_400_000 + hour * 3_600_000);

async function seed() {
  if ((await db.user.count()) > 0) {
    console.log("  The practice copy already has its made-up data.");
    console.log("  To start it over: node --import tsx scripts/make-demo-data.ts --reset");
    return;
  }

  // Password hashing is slow on purpose; do it outside any transaction.
  const passwordHashes = await Promise.all(DEMO_USERS.map(() => hashPassword(DEMO_PASSWORD)));

  const userIds = {} as Record<DemoUserKey, number>;
  const userNames = {} as Record<DemoUserKey, string>;
  await dbTx(async (tx) => {
    for (const [i, u] of DEMO_USERS.entries()) {
      const created = await tx.user.create({
        data: {
          email: u.email,
          name: u.name,
          role: u.role,
          passwordHash: passwordHashes[i],
          senderDisplayName: u.name,
          replyInbox: u.email,
          signature: `${u.name}\nPolygon Paradise (practice copy)`,
          timeZone: u.timeZone,
          createdAt: daysAgo(u.createdDaysAgo),
        },
      });
      userIds[u.key] = created.id;
      userNames[u.key] = u.name;
    }
    // Dry run, and the marker that this database is the practice copy (PLAN.md B6.5).
    for (const [key, value] of [
      ["sending.mode", "DRY_RUN"],
      ["practice.copy", true],
    ] as const) {
      await tx.setting.upsert({
        where: { key },
        create: { key, value, updatedById: userIds.owner },
        update: { value, updatedById: userIds.owner },
      });
    }
  });

  const listIds = {} as Record<ListKey, number>;
  const tagIds = new Map<string, number>();
  await dbTx(async (tx) => {
    for (const l of DEMO_LISTS) {
      const created = await tx.list.create({
        data: { name: l.name, description: l.description, createdById: userIds.owner, createdAt: daysAgo(DEMO_IMPORT_DAYS_AGO) },
      });
      listIds[l.key] = created.id;
    }
    const tagNames = [...new Set(DEMO_COMPANIES.flatMap((c) => c.tags ?? []))].sort();
    for (const name of tagNames) tagIds.set(name, (await tx.tag.create({ data: { name } })).id);
    for (const f of DEMO_CUSTOM_FIELDS) {
      await tx.customField.create({ data: { key: f.key, label: f.label, entity: "COMPANY", createdAt: daysAgo(DEMO_IMPORT_DAYS_AGO) } });
    }
  });

  const activity: ActivityRow[] = [
    { at: daysAgo(50), actorId: userIds.owner, type: "user.created", summary: "Demo Owner set up the app as Owner" },
    { at: daysAgo(45), actorId: userIds.owner, type: "user.invited", summary: "Demo Owner invited Ali Demo" },
  ];
  for (const l of DEMO_LISTS) {
    const count = DEMO_COMPANIES.filter((c) => c.lists[0] === l.key && !c.addedBy).length;
    activity.push({
      at: daysAgo(DEMO_IMPORT_DAYS_AGO, 1),
      actorId: userIds.owner,
      type: "import.done",
      summary: `Demo Owner imported ${count} companies into ${l.name}`,
      data: { list: l.name, created: count },
    });
  }
  const suppressions: { emailNorm: string; reason: "BOUNCED" | "UNSUBSCRIBED"; at: Date }[] = [];

  let created = 0;
  const CHUNK = 10;
  for (let i = 0; i < DEMO_COMPANIES.length; i += CHUNK) {
    const chunk = DEMO_COMPANIES.slice(i, i + CHUNK);
    await dbTx(async (tx) => {
      const ids: number[] = [];
      for (const c of chunk) {
        ids.push(await createCompany(tx, c));
        created++;
      }
      await refreshCompanySearchText(tx, ids);
    });
  }

  async function createCompany(tx: Tx, c: DemoCompany): Promise<number> {
    const site = parseWebsite(c.website);
    const country = normalizeCountry(c.country);
    const priority = c.priority ?? "NORMAL";
    const status = c.status ?? "NOT_CONTACTED";
    const addedBy = c.addedBy ?? "owner";
    const createdAt = c.addedBy ? daysAgo(10) : daysAgo(DEMO_IMPORT_DAYS_AGO, 1);
    const lastContact = c.lastContactDaysAgo !== undefined ? daysAgo(c.lastContactDaysAgo) : null;
    const repliedPerson = c.people.find((p) => p.repliedDaysAgo !== undefined);
    const firstBy = c.firstContactedBy ? userIds[c.firstContactedBy] : null;
    const isInstagram = Boolean(site?.isShared && /(^|\.)instagram\.com$/.test(site.host));

    const company = await tx.company.create({
      data: {
        name: c.name,
        nameNorm: normalizeCompanyName(c.name),
        website: site?.url ?? null,
        domain: site?.domain ?? null,
        profileKey: site?.profileKey ?? null,
        instagram: isInstagram ? instagramHandle(c.website) : null,
        country,
        timeZone: defaultTimeZoneFor(country),
        niche: c.niche,
        priority,
        priorityRank: priorityRank(priority),
        status,
        notes: c.notes ?? "",
        personalLine: c.personalLine ?? null,
        personalLineSource: c.personalLine ? "manual" : null,
        personalLineUpdatedAt: c.personalLine ? daysAgo(8) : null,
        personalLineUpdatedById: c.personalLine ? userIds.owner : null,
        customFields: c.custom ?? undefined,
        importedLastContactAt: lastContact,
        // What "Last emailed" shows and sorts by. The practice copy never sends, so no lastEmailedAt.
        lastContactAt: lastContactAt(null, lastContact),
        firstContactedById: firstBy,
        firstContactedAt: firstBy ? lastContact : null,
        repliedAt: repliedPerson ? daysAgo(repliedPerson.repliedDaysAgo!) : null,
        createdById: userIds[addedBy],
        createdAt,
      },
    });

    for (const p of c.people) {
      const parsed = p.email ? parseEmail(p.email) : null;
      if (p.email && !parsed) throw new Error(`The practice address ${p.email} isn't valid.`);
      const isGeneric = Boolean(parsed && !p.name && isRoleAddress(parsed.email));
      const name = p.name ?? (isGeneric ? GENERAL_INBOX_NAME : "");
      const person = await tx.person.create({
        data: {
          companyId: company.id,
          name,
          firstName: firstNameFrom(name, isGeneric) || null,
          role: p.role ?? null,
          email: parsed?.email ?? null,
          emailNorm: parsed?.norm ?? null,
          isGeneric,
          verificationStatus: p.verification?.status ?? null,
          verificationRisk: p.verification?.risk ?? null,
          verifiedAt: p.verification ? daysAgo(p.verification.daysAgo) : null,
          verificationProvider: p.verification ? "fake" : null,
          bouncedAt: p.bouncedDaysAgo !== undefined ? daysAgo(p.bouncedDaysAgo) : null,
          unsubscribedAt: p.unsubscribedDaysAgo !== undefined ? daysAgo(p.unsubscribedDaysAgo) : null,
          repliedAt: p.repliedDaysAgo !== undefined ? daysAgo(p.repliedDaysAgo) : null,
          notes: p.notes ?? "",
          createdAt,
        },
      });
      if (parsed && p.bouncedDaysAgo !== undefined) {
        suppressions.push({ emailNorm: parsed.norm, reason: "BOUNCED", at: daysAgo(p.bouncedDaysAgo) });
        activity.push({
          at: daysAgo(p.bouncedDaysAgo),
          actorId: null,
          type: "email.bounced",
          summary: `An email to ${parsed.email} bounced (practice data)`,
          companyId: company.id,
          personId: person.id,
        });
      }
      if (parsed && p.unsubscribedDaysAgo !== undefined) {
        suppressions.push({ emailNorm: parsed.norm, reason: "UNSUBSCRIBED", at: daysAgo(p.unsubscribedDaysAgo) });
        activity.push({
          at: daysAgo(p.unsubscribedDaysAgo),
          actorId: null,
          type: "person.unsubscribed",
          summary: `${parsed.email} unsubscribed (practice data)`,
          companyId: company.id,
          personId: person.id,
        });
      }
      if (p.repliedDaysAgo !== undefined) {
        activity.push({
          at: daysAgo(p.repliedDaysAgo),
          actorId: null,
          type: "reply.received",
          summary: `${name || parsed?.email} replied (practice data)`,
          companyId: company.id,
          personId: person.id,
        });
      }
    }

    for (const key of c.lists) {
      await tx.companyList.create({
        data: { companyId: company.id, listId: listIds[key], addedAt: createdAt, addedById: userIds[addedBy] },
      });
    }
    for (const tag of c.tags ?? []) {
      await tx.companyTag.create({ data: { companyId: company.id, tagId: tagIds.get(tag)! } });
    }

    if (c.addedBy) {
      activity.push({ at: createdAt, actorId: userIds[addedBy], type: "company.created", summary: `${userNames[addedBy]} added ${c.name}`, companyId: company.id });
    }
    if (status !== "NOT_CONTACTED") {
      const actor = c.firstContactedBy ?? (status === "CONTACTED" ? "owner" : "ali");
      const when = lastContact ? new Date(Math.min(now - 3_600_000, lastContact.getTime() + 86_400_000)) : daysAgo(2);
      activity.push({
        at: when,
        actorId: userIds[actor],
        type: "company.status",
        summary: `${userNames[actor]} set status to ${COMPANY_STATUS_LABELS[status]}`,
        companyId: company.id,
        data: { status },
      });
    }
    if (c.notes) {
      activity.push({ at: daysAgo(6), actorId: userIds.ali, type: "company.notes", summary: "Ali Demo edited the notes", companyId: company.id });
    }
    if (c.personalLine) {
      activity.push({ at: daysAgo(8), actorId: userIds.owner, type: "company.personalLine", summary: "Demo Owner updated the personal line", companyId: company.id });
    }
    return company.id;
  }

  // Activity has historical times, so it's written directly (logActivity always uses "now").
  await dbTx(async (tx) => {
    for (const s of suppressions) {
      await tx.suppression.create({
        data: { emailNorm: s.emailNorm, reason: s.reason, source: "practice", detail: "Made-up entry in the practice copy", createdAt: s.at },
      });
    }
    activity.sort((a, b) => a.at.getTime() - b.at.getTime());
    await tx.activityLog.createMany({
      data: activity.map((a) => ({
        at: a.at,
        actorId: a.actorId,
        type: a.type,
        summary: a.summary,
        companyId: a.companyId ?? null,
        personId: a.personId ?? null,
        data: a.data,
      })),
    });
  });

  console.log(`  Practice copy ready: ${created} made-up companies in ${DEMO_LISTS.length} lists.`);
  console.log(`  Sign in as demo@example.com / ${DEMO_PASSWORD} (or ali@example.com, same password).`);
}

let exitCode = 0;
try {
  await seed();
} catch (err) {
  exitCode = 1;
  console.log("  [x]  Creating the practice data failed.");
  console.log(`       ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  await db.$disconnect().catch(() => undefined);
}
process.exit(exitCode);
