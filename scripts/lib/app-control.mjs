// Stopping and starting the whole app, whichever way it runs (background services or a
// start.bat window). Used by update.bat and restore.bat (and start.bat's service part).
import { PATHS } from "./paths.mjs";
import { portInUse, sleep, startInNewWindow } from "./proc.mjs";
import { WEB_SERVICE, WORKER_SERVICE, queryService, servicesInstalled, startServices, stopServices } from "./services.mjs";
import { stopResultMessage, stopSupervisor } from "./supervisor.mjs";
import { buildState } from "./build.mjs";
import { UPDATE_UNFINISHED_MESSAGE, updateInProgress } from "./update-marker.mjs";

/**
 * Stops the app. With includeDemo, also the practice copy (it uses the same build).
 * Returns { ok, services, wasRunning, message }.
 */
export async function stopApp({ includeDemo = false, port = 3000, log = () => undefined } = {}) {
  const services = servicesInstalled();
  let wasRunning = false;
  if (services) {
    const states = [queryService(WEB_SERVICE).state, queryService(WORKER_SERVICE).state];
    wasRunning = states.some((s) => s && s !== "STOPPED");
    const r = await stopServices(log);
    if (!r.ok) return { ok: false, services, wasRunning, message: r.message };
  }
  const s = await stopSupervisor({ log });
  if (s.wasRunning) {
    wasRunning = true;
    if (s.refused) return { ok: false, services, wasRunning, message: stopResultMessage("The start.bat window", s) };
    log(s.forced ? stopResultMessage("The start.bat window", s) : "The start.bat window has stopped the app.");
  }
  if (includeDemo) {
    const d = await stopSupervisor({ pidFile: PATHS.demoPid, stopFile: PATHS.demoStopRequest, log });
    if (d.refused) return { ok: false, services, wasRunning, message: stopResultMessage("The practice copy", d) };
    if (d.wasRunning) log("The practice copy has stopped too.");
  }
  const deadline = Date.now() + 10_000;
  while ((await portInUse(port)) && Date.now() < deadline) await sleep(1000);
  if (await portInUse(port)) {
    return {
      ok: false,
      services,
      wasRunning,
      message: `Something is still using port ${port} after stopping the app. Close any other program that uses it (or restart the PC), then try again.`,
    };
  }
  return { ok: true, services, wasRunning, message: wasRunning ? "The app is stopped." : "The app wasn't running." };
}

/**
 * Why the app must not be started now, in plain words, or null when it may start.
 * `build` is buildState()'s answer; only the services need it (start.bat builds by itself).
 * @param {{ updateUnfinished: boolean, build?: { needed: boolean, reason: string | null } | null }} o
 * @returns {string | null}
 */
export function startBlockMessage({ updateUnfinished, build = null }) {
  if (updateUnfinished) return UPDATE_UNFINISHED_MESSAGE;
  if (build?.needed) {
    return build.reason === "changed"
      ? "The app's files changed since the last build (or the last build didn't finish), so the services aren't started with an old build. Double-click update.bat: it builds the app and starts it."
      : "The app isn't completely built, so the services aren't started. Double-click update.bat: it builds the app and starts it.";
  }
  return null;
}

/** startBlockMessage() for this install. `services` = whether the background services are used. */
export function startBlocker({ services, publicUrl = "" }) {
  return startBlockMessage({
    updateUnfinished: updateInProgress(),
    build: services ? buildState({ publicUrl }) : null,
  });
}

/** Starts the app again: the services, or start.bat in a new window. */
export async function startApp({ services, log = () => undefined } = {}) {
  if (services) return startServices(log);
  startInNewWindow("Polygon Paradise Outreach", PATHS.startBat);
  return { ok: true, message: "The app is starting in a new start.bat window." };
}
