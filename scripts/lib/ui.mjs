// Console helpers for the double-click scripts: short, friendly lines, simple questions,
// and "Press any key to close". Colours only when writing to a real console window.
import readline from "node:readline";

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

export function say(text = "") {
  console.log(text);
}

export function title(text) {
  console.log("");
  console.log(bold(text));
  console.log(bold("=".repeat(text.length)));
}

export function step(text) {
  console.log("");
  console.log(cyan(text));
}

export function ok(text) {
  console.log(`${green("  [ok]")} ${text}`);
}

export function info(text) {
  console.log(`       ${text}`);
}

export function warn(text) {
  console.log(`${yellow("  [!] ")} ${text}`);
}

export function fail(text) {
  console.log(`${red("  [x] ")} ${text}`);
}

/** Draws a simple ASCII box around some lines (used for the setup code and addresses). */
export function box(lines) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const edge = "  +" + "-".repeat(width) + "+";
  console.log(edge);
  for (const line of lines) console.log("  |  " + line + " ".repeat(width - line.length - 2) + "|");
  console.log(edge);
}

// One shared line reader, so several questions in a row also work when answers are piped in.
let reader = null;
let closed = false;
const queued = [];
const waiting = [];

function ensureReader() {
  if (reader || closed) return;
  reader = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  reader.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queued.push(line);
  });
  reader.on("close", () => {
    closed = true;
    reader = null;
    while (waiting.length) waiting.shift()(null);
  });
  // In a console window readline catches Ctrl+C itself; treat it as "cancel" and stop.
  reader.on("SIGINT", () => {
    console.log("");
    console.log("Cancelled.");
    process.exit(130);
  });
}

/**
 * Asks a question and returns the trimmed answer, or null when there is no input
 * (for example when the window has no keyboard attached).
 */
export async function ask(question) {
  ensureReader();
  if (queued.length) {
    process.stdout.write(question);
    const line = queued.shift();
    process.stdout.write(line + "\n");
    return line.trim();
  }
  if (closed || !reader) return null;
  reader.setPrompt(question);
  reader.prompt();
  const line = await new Promise((resolve) => waiting.push(resolve));
  return line === null ? null : line.trim();
}

/** Yes/no question. Enter (or no input) returns the default. */
export async function askYesNo(question, defaultValue = false) {
  for (;;) {
    const answer = await ask(`${question} (Y/N) `);
    if (answer === null || answer === "") return defaultValue;
    const a = answer.toLowerCase();
    if (a === "y" || a === "yes" || a === "j" || a === "ja") return true;
    if (a === "n" || a === "no" || a === "nei" || a === "nein") return false;
    warn("Type Y for yes or N for no.");
  }
}

/** Stops listening to the keyboard so the script can exit. */
export function closeInput() {
  if (reader) reader.close();
  reader = null;
}

/** "Press any key to close this window." Only waits in a real console window. */
export async function pressAnyKey(message = "Press any key to close this window.") {
  closeInput();
  if (!process.stdin.isTTY) return;
  console.log("");
  console.log(message);
  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

/** An error whose message is already written for the owner (no stack trace needed). */
export class FriendlyError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "FriendlyError";
    this.details = details;
  }
}
