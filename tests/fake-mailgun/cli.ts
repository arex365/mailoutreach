import path from "node:path";
import { fileURLToPath } from "node:url";
import { INBOUND_PRESETS } from "./inbound-presets";
import { startFakeMailgun, type FakeMailgun } from "./server";
import { DEFAULT_SWITCHES, type FakeMailgunOptions, type FakeSwitches } from "./state";
import { assertLoopbackUrl } from "./webhooks";

/**
 * Command line for the fake Mailgun server (M3-DESIGN §6.3), for the lead's manual browser checks:
 *
 *   node scripts/fake-mailgun.mjs --port 4010 --domain send.example.com --api-key key-fake-api \
 *     --signing-key key-fake-signing --app http://127.0.0.1:3100
 *
 * (Fallback without the launcher: `npx tsx tests/fake-mailgun/cli.ts …`.) Other flags: --region EU|US,
 * --plan foundation|basic|free, --index-lag-ms N, --retention-days N, --switch name[=true|false|N] (repeatable),
 * --dkim-authority <domain> (the domain whose DKIM key signs, e.g. example.com for send.example.com: SHARED-FROM-DESIGN
 * §7.8, the shared-From manual checks). Own-mailbox mode (MAIN-DOMAIN-DESIGN §7.8): --plan free (100 messages a day,
 * no tracking certificate, one inbound route, 1 day of logs), --mx-elsewhere (the domain's MX isn't Mailgun's: every
 * preset reply lands "outside"), --daily-limit N, --authorized a@x,b@y (only these recipients). --settings-applied
 * starts the domain as "Apply recommended settings" leaves it (tracking off, unsubscribe handling on, blank footers), for a
 * seeded database that records a finished Apply run (the own state of the screen checks, review SCREENS-12). The admin
 * API (/__fake/…) is described in tests/fake-mailgun/admin.ts. Ctrl+C stops it.
 */

export const USAGE = `Usage: node scripts/fake-mailgun.mjs [--port 4010] [--domain send.example.com] [--region EU|US]
  [--api-key key-fake-api] [--signing-key key-fake-signing] [--app http://127.0.0.1:3100]
  [--plan foundation|basic|free] [--index-lag-ms 0] [--retention-days 5] [--dkim-authority example.com]
  [--mx-elsewhere] [--daily-limit 100] [--authorized a@example.com,b@example.com] [--settings-applied]
  [--switch name[=value]]...`;

/** Parses the flags into server options. Throws a plain Error with the problem for bad input. */
export function parseCliArgs(argv: string[]): FakeMailgunOptions {
  const opts: FakeMailgunOptions = { port: 4010 };
  const switches: Partial<FakeSwitches> = {};
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return v;
  };
  const int = (v: string, flag: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be a whole number between ${min} and ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = take(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case "--port":
        opts.port = int(value(), "--port", 0, 65_535);
        break;
      case "--domain":
        opts.domain = value().toLowerCase();
        break;
      case "--region": {
        const r = value().toUpperCase();
        if (r !== "EU" && r !== "US") throw new Error("--region must be EU or US.");
        opts.region = r;
        break;
      }
      case "--api-key":
        opts.apiKey = value();
        break;
      case "--signing-key": {
        const k = value();
        opts.signingKey = k === "none" ? null : k;
        break;
      }
      case "--app": {
        const app = value().replace(/\/+$/, "");
        assertLoopbackUrl(app);
        opts.appUrl = app;
        break;
      }
      case "--plan": {
        const p = value();
        if (p !== "foundation" && p !== "basic" && p !== "free") throw new Error("--plan must be foundation, basic or free.");
        opts.plan = p;
        break;
      }
      case "--mx-elsewhere":
        // A flag without a value (MAIN-DOMAIN-DESIGN §7.8): the domain's MX isn't Mailgun's.
        if (inline !== undefined) throw new Error("--mx-elsewhere takes no value.");
        opts.receivesMail = false;
        break;
      case "--settings-applied":
        // A flag without a value: tracking off, unsubscribe handling on, blank footers (review SCREENS-12).
        if (inline !== undefined) throw new Error("--settings-applied takes no value.");
        opts.settingsApplied = true;
        break;
      case "--daily-limit":
        opts.dailyLimit = int(value(), "--daily-limit", 0, 1_000_000);
        break;
      case "--authorized": {
        const list = value()
          .split(",")
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean);
        if (!list.length || list.some((a) => !/^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(a))) {
          throw new Error("--authorized must be a comma-separated list of email addresses, for example a@example.com,b@example.com.");
        }
        opts.authorizedRecipients = list;
        break;
      }
      case "--index-lag-ms":
        opts.indexLagMs = int(value(), "--index-lag-ms");
        break;
      case "--retention-days":
        opts.retentionDays = int(value(), "--retention-days", 1, 60);
        break;
      case "--dkim-authority": {
        const d = value().trim().toLowerCase().replace(/\.+$/, "");
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
          throw new Error("--dkim-authority must be a domain name, for example example.com.");
        }
        opts.dkimAuthority = d;
        break;
      }
      case "--switch": {
        const raw = value();
        const [name, v] = raw.split("=") as [string, string | undefined];
        if (!(name in DEFAULT_SWITCHES)) throw new Error(`Unknown switch ${name}. Known: ${Object.keys(DEFAULT_SWITCHES).join(", ")}.`);
        const key = name as keyof FakeSwitches;
        if (key === "certPolls") switches.certPolls = int(v ?? "2", "--switch certPolls", 1, 100);
        else if (key === "validateSlowMs") switches.validateSlowMs = int(v ?? "1500", "--switch validateSlowMs", 0, 600_000);
        else if (key === "validateMaxActive") {
          switches.validateMaxActive = v === undefined || v === "null" ? null : int(v, "--switch validateMaxActive", 0, 100);
        } else if (key === "validateEngagement") {
          if (v !== "object" && v !== "empty" && v !== "null" && v !== "absent") {
            throw new Error("--switch validateEngagement must be object, empty, null or absent.");
          }
          switches.validateEngagement = v;
        } else (switches as Record<string, boolean>)[key] = v === undefined ? true : v === "true";
        break;
      }
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown option ${a}.\n${USAGE}`);
    }
  }
  if (Object.keys(switches).length) opts.switches = switches;
  return opts;
}

/** Starts the fake from command-line flags, prints where it listens and what the app needs, stops on Ctrl+C. */
export async function runCli(argv: string[], out: (line: string) => void = (l) => console.log(l)): Promise<FakeMailgun> {
  const opts = parseCliArgs(argv);
  const fake = await startFakeMailgun(opts);
  const apiKey = fake.options.apiKey;
  out(`Fake Mailgun listening on ${fake.origin} (domain ${fake.options.domain}, region ${fake.options.region}).`);
  if (fake.dkimAuthority !== fake.options.domain) out(`DKIM: ${fake.options.domain} is signed by ${fake.dkimAuthority}'s key.`);
  if (fake.options.plan !== "foundation") out(`Plan: ${fake.options.plan}${fake.options.dailyLimit !== null ? ` (${fake.options.dailyLimit} messages a day)` : ""}.`);
  if (!fake.options.receivesMail) out(`MX elsewhere: replies to ${fake.options.domain} land at its mail provider, never here.`);
  if (fake.options.authorizedRecipients) out(`Authorized recipients only: ${fake.options.authorizedRecipients.join(", ")}.`);
  if (opts.settingsApplied) out("Settings applied: open and click tracking off, unsubscribe handling on with blank footers.");
  out(`Set OUTREACH_MAILGUN_BASE_URL=${fake.origin} for the app. Use API key ${apiKey}.`);
  out(fake.options.appUrl ? `Signed webhooks go to ${fake.options.appUrl}.` : "No --app given: webhook: true and notify: true are off.");
  out(`Admin API: GET ${fake.origin}/__fake/state, /__fake/messages; POST /__fake/deliver, /__fake/bounce, /__fake/inbound, /__fake/reset …`);
  out(`Replies: POST ${fake.origin}/__fake/inbound {"preset": "${INBOUND_PRESETS.join('" | "')}", "inReplyTo": "<a sent message id>", "notify": true}`);
  out(`Address checks: GET /v4/address/validate answers by the test domains and local parts (bad…, temp…, x@greylist.test…); POST ${fake.origin}/__fake/validation {"address", "status"?, "body"?, "times"?} overrides one address.`);
  const stop = () => {
    void fake.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return fake;
}

/** True when this file is the program being run (`npx tsx tests/fake-mailgun/cli.ts …`). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
