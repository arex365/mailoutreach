/**
 * The website reader's entry point (docs/dev/M5-DESIGN.md §3.4, §5.4). Worker only: web code (src/app, src/components,
 * src/lib) never imports this folder, undici or cheerio (a unit test greps for it).
 *
 * `defaultWebsiteReader()` picks the transport: the saved fixture sites when OUTREACH_WEB_FIXTURES is set (and the
 * database isn't the owner's app.db), otherwise the real undici transport, and in a test run without fixtures it throws,
 * so no test can read a real website.
 */
import path from "node:path";
import { databaseFilePath } from "@/server/env";
import { isTestRun } from "@/server/mailgun/base-url";
import { fixtureTransport } from "./fixture-transport";
import { createPoliteness } from "./politeness";
import { createReader } from "./reader";
import { dbRobotsStore } from "./robots";
import { createRealTransport } from "./transport";
import type { Politeness, RobotsStore, Transport, WebsiteReader } from "./types";

export type {
  HeaderGetter,
  PageNote,
  Politeness,
  ReadNote,
  ReadPage,
  ReadResult,
  RobotsEntry,
  RobotsStore,
  Transport,
  TransportResponse,
  WebsiteReader,
} from "./types";
export { classifyPage, injectionHint, pageVerdict } from "@/core/ai/site-rules";
export { pickSecondPage } from "@/core/ai/picker";
export { capPagesToTokens, createReader, type ReaderDeps } from "./reader";
export { createRealTransport, type RealTransport, type RealTransportOptions } from "./transport";
export { fixtureTransport, loadFixtureSites, type FixtureSite, type FixtureTransport } from "./fixture-transport";
export { createPoliteness, immediatePoliteness } from "./politeness";
export { dbRobotsStore, memoryRobotsStore, type MemoryRobotsStore } from "./robots";
export { createSystemResolver, isPublicIp, makePublicOnlyLookup, type ResolveHost } from "./ssrf";

const TEST_RUN_WITHOUT_FIXTURES = "Test runs never read real websites (set OUTREACH_WEB_FIXTURES).";

let warnedAppDb = false;

/**
 * The fixture folder from OUTREACH_WEB_FIXTURES (absolute, or relative to the working directory), or null when unset
 * or when the database is the owner's app.db (ignored and logged once: fixture sites are never used on real data).
 */
export function webFixturesDir(): string | null {
  const raw = (process.env.OUTREACH_WEB_FIXTURES ?? "").trim();
  if (!raw) return null;
  if (path.basename(databaseFilePath()).toLowerCase() === "app.db") {
    if (!warnedAppDb) {
      warnedAppDb = true;
      console.warn("[web] Ignoring OUTREACH_WEB_FIXTURES: fixture websites are never used with the real database (app.db).");
    }
    return null;
  }
  return path.resolve(raw);
}

let sharedPoliteness: Politeness | null = null;
/** One politeness per process, so reads of different companies on the same host still wait for each other. */
function processPoliteness(): Politeness {
  sharedPoliteness ??= createPoliteness();
  return sharedPoliteness;
}

function defaultTransport(): Transport {
  const dir = webFixturesDir();
  if (dir) return fixtureTransport(dir);
  if (isTestRun()) throw new Error(TEST_RUN_WITHOUT_FIXTURES);
  return createRealTransport();
}

/** Real reader (worker), fixture reader (OUTREACH_WEB_FIXTURES), or an error in a test run without fixtures. */
export function defaultWebsiteReader(
  deps: { transport?: Transport; robotsStore?: RobotsStore; politeness?: Politeness } = {},
): WebsiteReader {
  return createReader({
    transport: deps.transport ?? defaultTransport(),
    robotsStore: deps.robotsStore ?? dbRobotsStore(),
    politeness: deps.politeness ?? processPoliteness(),
  });
}
