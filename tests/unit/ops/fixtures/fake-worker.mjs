// Stand-in for the background sender in the supervisor test.
// Crashes once when FAKE_WORKER_CRASH_FILE doesn't exist yet; stops cleanly on {type:"shutdown"}.
import fs from "node:fs";

const crashFile = process.env.FAKE_WORKER_CRASH_FILE;
if (crashFile && !fs.existsSync(crashFile)) {
  fs.writeFileSync(crashFile, "crashed once");
  console.log("fake worker crashing on purpose");
  process.exit(3);
}

console.log(`fake worker started OUTREACH_PROCESS=${process.env.OUTREACH_PROCESS}`);
const keepAlive = setInterval(() => undefined, 1000);
process.on("message", (message) => {
  if (message && message.type === "shutdown") {
    console.log("fake worker got shutdown");
    clearInterval(keepAlive);
    setTimeout(() => process.exit(0), 50);
  }
});
