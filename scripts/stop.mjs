// stop.bat (when the background services are NOT installed) → node scripts/stop.mjs [--demo | --all]
// Asks the start.bat window to stop (run\stop.request), waits up to 15 s, then ends it. While the
// window upgrades the database or builds the app, it waits for that step instead, and it never
// ends a database upgrade.
import { parseArgs } from "node:util";
import { PATHS } from "./lib/paths.mjs";
import { servicesInstalled } from "./lib/services.mjs";
import { stopResultMessage, stopSupervisor } from "./lib/supervisor.mjs";
import { portInUse } from "./lib/proc.mjs";
import * as ui from "./lib/ui.mjs";

const { values } = parseArgs({
  options: { demo: { type: "boolean", default: false }, all: { type: "boolean", default: false } },
  strict: true,
});

ui.title("Polygon Paradise Outreach: stop");

const targets = [];
if (!values.demo || values.all) targets.push({ label: "The app", pidFile: PATHS.supervisorPid, stopFile: PATHS.stopRequest, port: 3000 });
if (values.demo || values.all) targets.push({ label: "The practice copy", pidFile: PATHS.demoPid, stopFile: PATHS.demoStopRequest, port: 3001 });

let exitCode = 0;
for (const t of targets) {
  const r = await stopSupervisor({ pidFile: t.pidFile, stopFile: t.stopFile, timeoutMs: 15_000, log: ui.info });
  if (!r.wasRunning) {
    if (t.port === 3000 && servicesInstalled()) {
      ui.info("The app runs as a background service. Double-click stop.bat to stop it (it asks Windows for permission).");
    } else if (await portInUse(t.port)) {
      ui.warn(`${t.label} wasn't started with start.bat, but something is using port ${t.port}. Close that program, or restart the PC.`);
      exitCode = 1;
    } else {
      ui.ok(`${t.label} isn't running.`);
    }
    continue;
  }
  const message = stopResultMessage(t.label, r);
  if (r.refused) {
    ui.warn(message);
    exitCode = 1;
  } else if (r.forced) {
    ui.warn(message);
  } else {
    ui.ok(message);
  }
}
ui.closeInput();
process.exit(exitCode);
