// Starts the local fake Mailgun server for manual checks (docs/dev/M3-DESIGN.md §6.3). Never talks to the real Mailgun.
//   node scripts/fake-mailgun.mjs --port 4010 --domain send.example.com --api-key key-fake-api --signing-key key-fake-signing --app http://127.0.0.1:3100
// Shared From address checks (docs/dev/SHARED-FROM-DESIGN.md §9.4): add --dkim-authority example.com, so the sending
// domain's DKIM record is named after its main domain (pdk1._domainkey.example.com), as Mailgun does by default.
// Own-mailbox checks (docs/dev/MAIN-DOMAIN-DESIGN.md §7.8): --plan foundation|basic|free, --mx-elsewhere (the domain's
// MX isn't Mailgun's), --daily-limit N, --authorized a@example.com,b@example.com.
// Fallback if the tsx loader can't be registered: npx tsx tests/fake-mailgun/cli.ts --port 4010 …
import { register } from "tsx/esm/api";

register();
const { runCli } = await import("../tests/fake-mailgun/cli.ts");
try {
  await runCli(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
