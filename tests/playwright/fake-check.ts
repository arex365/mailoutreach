import { E2E_INSTANCES, e2eStateFromEnv, fakeDkimProblem, fakeMailgunArgs, fakeOwnMailboxProblem } from "./instances";

/**
 * Playwright's global setup (playwright.config.ts): runs once the servers are up, whether the config started them or
 * reused ones that already answered. The ready and live states run in shared-From mode (docs/dev/SHARED-FROM-DESIGN.md
 * §8 P6), so their fake Mailgun must sign send.example.com's email with example.com's key (`--dkim-authority
 * example.com`); the own state (docs/dev/MAIN-DOMAIN-DESIGN.md §9.4) needs a fake on the Free plan whose domain's mail
 * goes elsewhere, with the tracking settings the seeded Apply run left (`--plan free --mx-elsewhere --settings-applied`,
 * review SCREENS-12). The fake's `GET /__fake/state` says so, or the run stops before any
 * test with the sentence to fix it. The empty and busy fakes are started plain and never asked. Only the fake's loopback
 * address is ever fetched.
 */
export default async function checkFakeMailgun(): Promise<void> {
  const state = e2eStateFromEnv();
  const { dkimAuthority, fakeArgs, fakeMailgunPort } = E2E_INSTANCES[state];
  if (!dkimAuthority && !fakeArgs) return;
  const url = `http://127.0.0.1:${fakeMailgunPort}/__fake/state`;
  let body: unknown;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    body = await res.json();
  } catch {
    throw new Error(`Nothing answers at ${url}. Start the fake Mailgun first: node scripts/fake-mailgun.mjs --port ${fakeMailgunPort} ${fakeMailgunArgs(state)}`);
  }
  const problem = fakeDkimProblem(state, body) ?? fakeOwnMailboxProblem(state, body);
  if (problem) throw new Error(problem);
}
