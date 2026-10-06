// Test environment: never touch the real database or keys.
import path from "node:path";

process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.APP_PUBLIC_URL ??= "";
process.env.SETUP_CODE_HASH ??= "";
// Integration tests that need a database create their own temporary file and set DATABASE_URL
// before importing server modules (see tests/integration/helpers/test-db.ts). The default is a file in a folder that
// never exists (M6-DESIGN §7.9, L16), so a test that forgot createTestDb() fails at once with a path that says why,
// instead of leaving a database next to data\app.db.
process.env.DATABASE_URL ??= "file:./data/test/__use-createTestDb__/none.db";
// Mailgun (docs/dev/M3-DESIGN.md §2.5, §6.4): a test run refuses every Mailgun host except the local fake server.
// The default points at a dead loopback port (it must have 2–5 digits, or base-url.ts ignores it), so a test that
// forgot connectFakeMailgun() fails fast with ECONNREFUSED instead of reaching anything real.
process.env.OUTREACH_TEST_RUN = "1";
process.env.OUTREACH_MAILGUN_BASE_URL ??= "http://127.0.0.1:19";
// Claude and websites (docs/dev/M5-DESIGN.md §5.4): Anthropic calls go to the same dead loopback port unless a test
// connects the fake Claude, and the website reader reads the saved fixture sites instead of the internet.
process.env.OUTREACH_ANTHROPIC_BASE_URL ??= "http://127.0.0.1:19";
process.env.OUTREACH_WEB_FIXTURES ??= path.resolve("tests/fixtures/sites");
