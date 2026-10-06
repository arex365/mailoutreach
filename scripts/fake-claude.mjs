// Starts the local fake Claude server for manual checks (docs/dev/M5-DESIGN.md §7.2, §7.5). Never talks to Anthropic.
//   node scripts/fake-claude.mjs --port 4020 --sites tests/fixtures/sites
// Fallback if the tsx loader can't be registered: npx tsx tests/fake-claude/cli.ts --port 4020 …
import { register } from "tsx/esm/api";

register();
const { runCli } = await import("../tests/fake-claude/cli.ts");
try {
  await runCli(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
