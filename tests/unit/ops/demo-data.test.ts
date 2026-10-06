/**
 * The practice copy's made-up data: the dataset itself, and the real make-demo-data script run
 * against a temporary database under data/test/.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_COMPANIES, DEMO_LISTS, DEMO_PASSWORD, DEMO_USERS } from "../../../scripts/lib/demo-dataset";

const SHARED = /(^|\.)(instagram\.com|gmail\.com)$/;

describe("demo dataset", () => {
  it("has about 80 companies in the four old-tool lists", () => {
    expect(DEMO_COMPANIES.length).toBeGreaterThanOrEqual(75);
    expect(DEMO_COMPANIES.length).toBeLessThanOrEqual(90);
    expect(DEMO_LISTS.map((l) => l.name)).toEqual(["German 3D Companies", "Norway 3D Companies", "Worldwide Directory", "Instagram Creators"]);
    for (const l of DEMO_LISTS) expect(DEMO_COMPANIES.some((c) => c.lists.includes(l.key))).toBe(true);
  });

  it("only uses made-up .example domains, plus instagram.com and gmail.com for creators", () => {
    for (const c of DEMO_COMPANIES) {
      if (c.website) {
        const host = new URL(c.website.includes("://") ? c.website : `https://${c.website}`).hostname;
        expect(host.endsWith(".example") || SHARED.test(host), c.website).toBe(true);
      }
      for (const p of c.people) {
        if (!p.email) continue;
        const domain = p.email.split("@")[1]!;
        expect(domain.endsWith(".example") || SHARED.test(domain), p.email).toBe(true);
        if (domain === "gmail.com") expect(p.email).toMatch(/demo@gmail\.com$/);
      }
    }
  });

  it("has unique names and addresses", () => {
    const names = DEMO_COMPANIES.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const emails = DEMO_COMPANIES.flatMap((c) => c.people.map((p) => p.email?.toLowerCase())).filter(Boolean);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("covers the situations worth practising", () => {
    const statuses = new Set(DEMO_COMPANIES.map((c) => c.status ?? "NOT_CONTACTED"));
    expect([...statuses].sort()).toEqual(["CLIENT", "CONTACTED", "DO_NOT_CONTACT", "NOT_CONTACTED", "NOT_INTERESTED", "REPLIED"]);
    expect(new Set(DEMO_COMPANIES.map((c) => c.priority ?? "NORMAL")).size).toBe(3);
    expect(DEMO_COMPANIES.filter((c) => (c.lastContactDaysAgo ?? 999) <= 30).length).toBeGreaterThanOrEqual(3);
    expect(DEMO_COMPANIES.filter((c) => (c.lastContactDaysAgo ?? 0) > 30).length).toBeGreaterThanOrEqual(3);
    expect(DEMO_COMPANIES.some((c) => c.people.length === 0)).toBe(true);
    expect(DEMO_COMPANIES.some((c) => c.people.length > 0 && c.people.every((p) => !p.email))).toBe(true);
    expect(DEMO_COMPANIES.some((c) => c.people.some((p) => !p.name && /^(info|post|kontakt)@/.test(p.email ?? "")))).toBe(true);
    expect(DEMO_COMPANIES.filter((c) => c.personalLine).length).toBeGreaterThanOrEqual(3);
    expect(DEMO_COMPANIES.some((c) => c.custom?.followers)).toBe(true);
    expect(DEMO_COMPANIES.some((c) => c.custom?.est_revenue)).toBe(true);
    expect(DEMO_COMPANIES.some((c) => c.custom?.platforms)).toBe(true);
    expect(DEMO_COMPANIES.some((c) => !c.country)).toBe(true);
    for (const c of DEMO_COMPANIES) expect(c.people.length).toBeLessThanOrEqual(3);
  });

  it("has the documented practice logins", () => {
    expect(DEMO_PASSWORD).toBe("practice-only-password");
    expect(DEMO_USERS.map((u) => [u.name, u.email, u.role])).toEqual([
      ["Demo Owner", "demo@example.com", "OWNER"],
      ["Ali Demo", "ali@example.com", "MEMBER"],
    ]);
  });
});

describe("make-demo-data.ts (temporary database)", () => {
  const ROOT = path.resolve(".");
  const dir = path.join(ROOT, "data", "test", `demo-${process.pid}-${Date.now()}`);
  const dbFile = path.join(dir, "demo.db");

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_QUIET: "true" };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts", "make-demo-data.ts"), ...args], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  it("refuses to write into app.db", () => {
    const r = run(["--db", path.join(dir, "app.db")]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("app.db");
    expect(fs.existsSync(path.join(dir, "app.db"))).toBe(false);
  });

  it("creates the practice data with the app's derived fields", { timeout: 120_000 }, () => {
    fs.mkdirSync(dir, { recursive: true });
    const r = run(["--db", dbFile]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("demo@example.com");

    const db = new Database(dbFile, { readonly: true });
    const one = <T>(sql: string) => db.prepare(sql).get() as T;
    const all = <T>(sql: string) => db.prepare(sql).all() as T[];
    try {
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM Company").n).toBe(DEMO_COMPANIES.length);
      expect(all<{ email: string; role: string }>('SELECT email, role FROM "User" ORDER BY id')).toEqual([
        { email: "demo@example.com", role: "OWNER" },
        { email: "ali@example.com", role: "MEMBER" },
      ]);
      expect(one<{ value: string }>("SELECT value FROM Setting WHERE key = 'sending.mode'").value).toBe('"DRY_RUN"');
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM List").n).toBe(4);

      // Derived fields, as the app would store them.
      const werkstatt = one<Record<string, unknown>>("SELECT * FROM Company WHERE name = 'Werkstatt Nord 3D GmbH'");
      expect(werkstatt).toMatchObject({ nameNorm: "werkstatt nord 3d", domain: "werkstatt-nord-3d.example", country: "DE", timeZone: "Europe/Berlin", priorityRank: 1 });
      expect(String(werkstatt.searchText)).toContain("jonas becker");
      const creator = one<Record<string, unknown>>("SELECT * FROM Company WHERE name = 'Anna Sculpts'");
      expect(creator).toMatchObject({ domain: null, profileKey: "instagram.com/anna.sculpts.demo", instagram: "anna.sculpts.demo" });
      const inbox = one<Record<string, unknown>>("SELECT * FROM Person WHERE emailNorm = 'post@fjordprint.example'");
      expect(inbox).toMatchObject({ name: "General inbox", isGeneric: 1, firstName: null });

      // "Last emailed" shows and sorts by lastContactAt = the newer of lastEmailedAt and the old
      // tool's date. The practice copy never sends, so it equals the old tool's date everywhere.
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM Company WHERE lastEmailedAt IS NOT NULL").n).toBe(0);
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM Company WHERE lastContactAt IS NOT importedLastContactAt").n).toBe(0);
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM Company WHERE lastContactAt IS NOT NULL").n).toBe(
        DEMO_COMPANIES.filter((c) => c.lastContactDaysAgo !== undefined).length,
      );

      // Nothing outside the made-up domains.
      const badDomains = all<{ domain: string }>("SELECT domain FROM Company WHERE domain IS NOT NULL AND domain NOT LIKE '%.example'");
      expect(badDomains).toEqual([]);
      const badEmails = all<{ emailNorm: string }>(
        "SELECT emailNorm FROM Person WHERE emailNorm IS NOT NULL AND emailNorm NOT LIKE '%.example' AND emailNorm NOT LIKE '%demo@gmail.com'",
      );
      expect(badEmails).toEqual([]);
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM ActivityLog").n).toBeGreaterThan(20);
    } finally {
      db.close();
    }

    // Running it again leaves the data alone.
    const again = run(["--db", dbFile]);
    expect(again.status).toBe(0);
    expect(again.out).toContain("already has");
  });
});
