// Controls the background services for start.bat and stop.bat.
//   node scripts/service-control.mjs status [--quiet]   exit code 0 when both services run
//   node scripts/service-control.mjs open               wait for the app, print addresses, open the browser
//   node scripts/service-control.mjs start [--open]     (administrator) start the app, then the background sender
//   node scripts/service-control.mjs stop               (administrator) stop the background sender, then the app
// It never builds or upgrades anything: that is update.bat's job. So it refuses to start the services
// while update.bat hasn't finished (run\update-in-progress) or the build is missing or out of date.
import { parseArgs } from "node:util";
import { PATHS } from "./lib/paths.mjs";
import { lanUrls } from "./lib/lan.mjs";
import { readEnvFile } from "./lib/supervisor.mjs";
import { startBlocker } from "./lib/app-control.mjs";
import { isElevated, openInBrowser, waitForHealth } from "./lib/proc.mjs";
import { WEB_SERVICE, WORKER_SERVICE, queryService, startServices, stopServices } from "./lib/services.mjs";
import * as ui from "./lib/ui.mjs";

const PORT = 3000;
const { values, positionals } = parseArgs({
  options: { quiet: { type: "boolean", default: false }, open: { type: "boolean", default: false } },
  allowPositionals: true,
  strict: true,
});
const command = positionals[0] ?? "status";

const STATE_WORDS = {
  RUNNING: "running",
  STOPPED: "stopped",
  START_PENDING: "starting",
  STOP_PENDING: "stopping",
  PAUSED: "paused",
};

function describe(name) {
  const q = queryService(name);
  if (!q.installed) return "not installed";
  return STATE_WORDS[q.state] ?? String(q.state ?? "unknown").toLowerCase();
}

function printAddresses() {
  const env = readEnvFile(PATHS.env);
  const lines = ["Polygon Paradise Outreach is running.", "", `On this PC:            http://localhost:${PORT}`];
  const lan = lanUrls(PORT);
  lan.forEach((a, i) => lines.push(`${i === 0 ? "Office computers:     " : "                      "} ${a.url}`));
  lines.push(`Remote staff (https):  ${(env.APP_PUBLIC_URL ?? "").trim() || "not set up yet (see docs\\setup\\3-cloudflare.md)"}`);
  lines.push("", "It runs in the background: you can close this window.");
  console.log("");
  ui.box(lines);
}

async function waitAndOpen(openBrowser) {
  ui.info("Waiting for the app to answer...");
  const health = await waitForHealth(PORT, 60_000, { requireHealthy: false });
  if (!health.ok) {
    ui.fail("The services are running, but the app didn't answer within a minute. Look at logs\\web.log, or run status.bat.");
    return 1;
  }
  if (!health.healthy) ui.warn("The app answers, but its health check reports a problem. Run status.bat for details.");
  printAddresses();
  if (openBrowser) openInBrowser(`http://localhost:${PORT}`);
  return 0;
}

async function main() {
  switch (command) {
    case "status": {
      const web = queryService(WEB_SERVICE);
      const worker = queryService(WORKER_SERVICE);
      if (!values.quiet) {
        ui.say(`The app (${WEB_SERVICE}): ${describe(WEB_SERVICE)}`);
        ui.say(`The background sender (${WORKER_SERVICE}): ${describe(WORKER_SERVICE)}`);
      }
      return web.state === "RUNNING" && worker.state === "RUNNING" ? 0 : 1;
    }
    case "open":
      ui.title("Polygon Paradise Outreach");
      return waitAndOpen(true);
    case "start": {
      ui.title("Polygon Paradise Outreach: start the services");
      if (!isElevated()) {
        ui.fail("Starting the services needs administrator rights. Double-click start.bat (it asks Windows for permission).");
        return 1;
      }
      // Never start a half-updated or half-built app (update.bat stopped with an error).
      const blocked = startBlocker({ services: true, publicUrl: (readEnvFile(PATHS.env).APP_PUBLIC_URL ?? "").trim() });
      if (blocked) {
        ui.fail(blocked);
        return 1;
      }
      const r = await startServices(ui.info);
      if (!r.ok) {
        ui.fail(r.message);
        return 1;
      }
      ui.ok("The app and the background sender are running.");
      return waitAndOpen(values.open);
    }
    case "stop": {
      ui.title("Polygon Paradise Outreach: stop the services");
      if (!isElevated()) {
        ui.fail("Stopping the services needs administrator rights. Double-click stop.bat (it asks Windows for permission).");
        return 1;
      }
      const r = await stopServices(ui.info);
      if (!r.ok) {
        ui.fail(r.message);
        return 1;
      }
      ui.ok("The app and the background sender are stopped. No emails go out until they start again.");
      ui.info("They start again by themselves when Windows restarts, or when you double-click start.bat.");
      // Review fix SCREENS-01: stopping isn't enough on a PC that is being replaced (README "Moving to a new PC").
      ui.info("To stop them starting with Windows (for example on a PC you're replacing), double-click uninstall-services.bat.");
      return 0;
    }
    default:
      ui.fail(`Unknown command "${command}". Use status, open, start or stop.`);
      return 2;
  }
}

process.exit(await main());
