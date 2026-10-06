import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeClaude } from "./server";
import { FAKE_CLAUDE_KEY, type FakeClaude, type FakeClaudeOptions } from "./types";

/**
 * Command line for the fake Claude server (M5-DESIGN §7.2, §7.5), for the lead's manual browser checks:
 *
 *   node scripts/fake-claude.mjs --port 4020 --sites tests/fixtures/sites
 *
 * (Fallback without the launcher: `npx tsx tests/fake-claude/cli.ts …`.) Other flags: --input-tokens N and
 * --output-tokens N (the usage every answer reports). The admin API (/__fake/…) is described in
 * tests/fake-claude/admin.ts. Ctrl+C stops it.
 */

export const USAGE = `Usage: node scripts/fake-claude.mjs [--port 4020] [--sites tests/fixtures/sites]
  [--input-tokens 3000] [--output-tokens 120]`;

/** Parses the flags into server options. Throws a plain Error with the problem for bad input. */
export function parseCliArgs(argv: string[]): FakeClaudeOptions {
  const opts: FakeClaudeOptions = { port: 4020 };
  let input: number | null = null;
  let output: number | null = null;
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
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.`);
      i++;
      return v;
    };
    switch (flag) {
      case "--port":
        opts.port = int(value(), "--port", 0, 65_535);
        break;
      case "--sites":
        opts.sitesDir = path.resolve(value());
        break;
      case "--input-tokens":
        input = int(value(), "--input-tokens");
        break;
      case "--output-tokens":
        output = int(value(), "--output-tokens");
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown option ${a}.\n${USAGE}`);
    }
  }
  if (input !== null || output !== null) opts.usage = { input: input ?? 3_000, output: output ?? 120 };
  return opts;
}

/** Starts the fake from command-line flags, prints where it listens and what the app needs, stops on Ctrl+C. */
export async function runCli(argv: string[], out: (line: string) => void = (l) => console.log(l)): Promise<FakeClaude> {
  const opts = parseCliArgs(argv);
  const fake = await startFakeClaude(opts);
  out(`Fake Claude listening on ${fake.origin}.`);
  out(`Set OUTREACH_ANTHROPIC_BASE_URL=${fake.origin} for the app. Use the key ${FAKE_CLAUDE_KEY}.`);
  out(opts.sitesDir ? `Fixture answers come from ${opts.sitesDir}.` : "No --sites given: every answer is the echo answer.");
  out(`Admin API: GET ${fake.origin}/__fake/requests; POST /__fake/fail-next, /__fake/usage, /__fake/script, /__fake/reset.`);
  const stop = () => {
    void fake.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return fake;
}

/** True when this file is the program being run (`npx tsx tests/fake-claude/cli.ts …`). */
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
