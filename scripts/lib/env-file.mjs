// Reading and updating the settings file (.env) one line at a time.
// Rule number one: an existing APP_ENCRYPTION_KEY is never replaced. Without it the saved
// API keys can't be read any more (PLAN.md B10: setup.bat is idempotent).
// Rule number two: a key set twice means the LAST line counts, as in dotenv and Next.js, so the
// scripts read, back up, migrate and update exactly what the running app uses.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?$/;

function unquote(raw) {
  const v = (raw ?? "").trim();
  // A quoted value, optionally followed by a comment: KEY="value" # note
  const quoted = v.match(/^(["'`])(.*?)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2];
  // Unquoted: an inline comment starts at " #".
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/** The key set by one line, or null for comments, blank lines and anything else. */
function keyOfLine(line) {
  if (/^\s*(#|$)/.test(line)) return null;
  const m = line.match(LINE_RE);
  return m ? m[1] : null;
}

/**
 * Parses .env text into a plain object. When a key appears more than once, the LAST line wins,
 * exactly like dotenv and Next.js (@next/env), so the scripts always see the values the app uses.
 * @param {string | null | undefined} text
 * @returns {Record<string, string>}
 */
export function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!keyOfLine(line)) continue;
    const m = line.match(LINE_RE);
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

/**
 * Keys that are set on more than one line, in the order they first appear.
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function duplicateEnvKeys(text) {
  const counts = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const key = keyOfLine(line);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([key]) => key);
}

const duplicateComment = (key, line) => `# Not used: a later ${key} line replaces this one. ${line.trim()}`;

/**
 * Turns every line that a later line of the same key overrides into a comment, so each key is set
 * once and the file says what the app really uses. Nothing is deleted. Returns { text, keys }.
 */
export function dedupeEnvText(text) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    const key = keyOfLine(line);
    if (key) lastIndex.set(key, i);
  });
  const keys = new Set();
  const out = lines.map((line, i) => {
    const key = keyOfLine(line);
    if (!key || lastIndex.get(key) === i) return line;
    keys.add(key);
    return duplicateComment(key, line);
  });
  return { text: keys.size ? out.join(eol) : src, keys: [...keys] };
}

/**
 * The value of one key, or undefined when the key isn't in the file at all.
 * @param {string | null | undefined} text
 * @param {string} key
 * @returns {string | undefined}
 */
export function getEnvValue(text, key) {
  return parseEnv(text)[key];
}

/** Formats a value for the file. Values are always written in double quotes. */
export function formatEnvValue(value) {
  const v = String(value ?? "");
  if (/["\r\n]/.test(v)) throw new Error(`A value in .env can't contain quotes or line breaks (${v.slice(0, 20)}…).`);
  return `"${v}"`;
}

/**
 * Sets KEY="value": replaces the LAST line for that key (the one the app reads), turns any
 * earlier lines for the same key into comments, and keeps every other line exactly as it was.
 * Appends the line when the key isn't there. Keeps the file's line-ending style.
 */
export function setEnvValue(text, key, value) {
  const src = String(text ?? "");
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.length ? src.split(/\r?\n/) : [];
  const newLine = `${key}=${formatEnvValue(value)}`;
  const indexes = [];
  lines.forEach((l, i) => {
    if (keyOfLine(l) === key) indexes.push(i);
  });
  if (indexes.length > 0) {
    const last = indexes.pop();
    for (const i of indexes) lines[i] = duplicateComment(key, lines[i]);
    lines[last] = newLine;
    return lines.join(eol);
  }
  // Append, making sure the file ends with exactly one line break before the new line.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(newLine, "");
  return lines.join(eol);
}

export function generateEncryptionKey() {
  return crypto.randomBytes(32).toString("base64");
}

/** True when the value is exactly 32 bytes of standard base64. */
export function isValidEncryptionKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const buf = Buffer.from(value, "base64");
  return buf.length === 32 && buf.toString("base64") === value;
}

/** Text of a brand-new settings file. */
export function newEnvFileText({ databaseUrl, encryptionKey, publicUrl = "", setupCodeHash = "" }) {
  return [
    "# Polygon Paradise Outreach settings. Keep a copy of this file somewhere safe.",
    "# Without APP_ENCRYPTION_KEY the saved API keys can't be read. Never share this file.",
    `DATABASE_URL=${formatEnvValue(databaseUrl)}`,
    `APP_ENCRYPTION_KEY=${formatEnvValue(encryptionKey)}`,
    `APP_PUBLIC_URL=${formatEnvValue(publicUrl)}`,
    `SETUP_CODE_HASH=${formatEnvValue(setupCodeHash)}`,
    "",
  ].join("\r\n");
}

/** Writes a file via a temporary file and a rename, so a power cut can't leave half a file. */
export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Checks the public https address typed by the owner.
 * "" or "none" means "not set up yet". Returns the cleaned origin, e.g. "https://outreach.example.com".
 */
export function validatePublicUrl(input) {
  const raw = String(input ?? "").trim();
  if (raw === "" || /^(none|-|off)$/i.test(raw)) return { ok: true, value: "" };
  if (!/^https:\/\//i.test(raw)) {
    return { ok: false, error: "The address must start with https:// (for example https://outreach.example.com)." };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That doesn't look like a web address. Type it like https://outreach.example.com." };
  }
  if (!url.hostname.includes(".") || url.username || url.password) {
    return { ok: false, error: "That doesn't look like a web address. Type it like https://outreach.example.com." };
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    return { ok: false, error: `Type only the address itself, without anything after it: https://${url.host}` };
  }
  return { ok: true, value: url.origin };
}

/** DATABASE_URL for a file: relative ("file:./data/app.db") inside the project, absolute otherwise. */
export function databaseUrlFor(dbPath, root) {
  const abs = path.resolve(root, dbPath);
  const rel = path.relative(root, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return "file:./" + rel.split(path.sep).join("/");
  return "file:" + abs.split(path.sep).join("/");
}

/** Absolute file path for a DATABASE_URL (same rule as src/server/env.ts databaseFilePath()). */
export function databasePathFromUrl(url, root) {
  const raw = String(url || "file:./data/app.db").replace(/^file:/, "");
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw);
}
