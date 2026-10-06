// Stand-in for a start.bat window in the pid-file and stop tests. Its command line contains
// "run-prod", like the real one, so supervisorState() accepts it.
//   FAKE_MODE=claim  claim FAKE_PID_FILE with claimPidFile(), print the result as JSON, stay alive FAKE_HOLD_MS
//   FAKE_MODE=busy   own FAKE_PID_FILE, be in phase FAKE_PHASE for FAKE_BUSY_MS, then (like
//                    runSupervisor between its steps) stop cleanly once FAKE_STOP_FILE exists
import fs from "node:fs";
import { claimPidFile } from "../../../../scripts/lib/proc.mjs";
import { clearPhase, writePhase } from "../../../../scripts/lib/supervisor.mjs";

const pidFile = process.env.FAKE_PID_FILE;
const stopFile = process.env.FAKE_STOP_FILE;

if (process.env.FAKE_MODE === "claim") {
  const r = await claimPidFile(pidFile);
  console.log(JSON.stringify(r));
  setTimeout(() => process.exit(0), Number(process.env.FAKE_HOLD_MS ?? 4000));
} else {
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  writePhase(pidFile, process.env.FAKE_PHASE ?? "migrating");
  console.log("busy");
  setTimeout(() => {
    clearPhase(pidFile);
    setInterval(() => {
      if (!fs.existsSync(stopFile)) return;
      fs.rmSync(stopFile, { force: true });
      fs.rmSync(pidFile, { force: true });
      console.log("stopped cleanly");
      process.exit(0);
    }, 100);
  }, Number(process.env.FAKE_BUSY_MS ?? 3000));
}
