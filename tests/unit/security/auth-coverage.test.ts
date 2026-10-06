import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PLAN.md B7: every Server Action ("use server" export) and every Route Handler must
 * check who is signed in, except an explicit allowlist of public entry points.
 * This test reads the source files and fails the build when a check is missing.
 */

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");

const AUTH_CALLS = /\b(requireUserAction|requireOwnerAction|requireUser|requireOwner|getUserOrNull)\s*\(/;

/** Public on purpose (no session yet, or the link token / signature is the credential). */
const PUBLIC_ACTIONS = new Set([
  "src/app/(auth)/actions.ts#loginAction",
  "src/app/(auth)/actions.ts#logoutAction",
  "src/app/(auth)/actions.ts#setupAction",
  "src/app/(auth)/invite/actions.ts#acceptInviteAction",
  "src/app/(auth)/reset/actions.ts#resetPasswordAction",
]);
const PUBLIC_ROUTES = new Set([
  "src/app/api/health/route.ts#GET",
  "src/app/api/webhooks/mailgun/events/route.ts#POST", // HMAC-checked (M3-DESIGN §4.4.1)
  "src/app/api/webhooks/mailgun/inbound/route.ts#POST", // HMAC-checked (M3-DESIGN §4.4.1)
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Returns the text of the block starting at the first "{" at or after `from` (strings/comments aware enough for our code). */
function blockFrom(src: string, from: number): string {
  const start = src.indexOf("{", from);
  if (start < 0) return "";
  let depth = 0;
  let i = start;
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && next === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

type Export = { name: string; body: string };

function exportedFunctions(src: string): Export[] {
  const out: Export[] = [];
  const fnRe = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  for (const m of src.matchAll(fnRe)) {
    // Skip the parameter list: find the ")" that closes it.
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Skip a return type annotation such as Promise<ActionResult<{ name: string }>>:
    // the body is the first "{" that is not inside <…>.
    let angle = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "<") angle++;
      else if (ch === ">" && src[j - 1] !== "=") angle--;
      else if (ch === "{" && angle === 0) break;
    }
    out.push({ name: m[1]!, body: blockFrom(src, j) });
  }
  const constRe = /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*async\b/g;
  for (const m of src.matchAll(constRe)) out.push({ name: m[1]!, body: blockFrom(src, m.index!) });
  return out;
}

const files = walk(SRC).map((f) => ({ abs: f, rel: path.relative(ROOT, f).split(path.sep).join("/") }));

describe("every entry point checks who is signed in (PLAN B7)", () => {
  const actionFiles = files.filter((f) => /^\s*["']use server["']/m.test(fs.readFileSync(f.abs, "utf8").slice(0, 200)));
  const routeFiles = files.filter((f) => /\/route\.ts$/.test(f.rel) && f.rel.startsWith("src/app/"));

  it("finds the entry points (sanity)", () => {
    expect(actionFiles.length).toBeGreaterThan(5);
    expect(routeFiles.length).toBeGreaterThan(3);
  });

  for (const f of actionFiles) {
    const src = fs.readFileSync(f.abs, "utf8");
    for (const fn of exportedFunctions(src)) {
      const key = `${f.rel}#${fn.name}`;
      it(`server action ${key}`, () => {
        if (PUBLIC_ACTIONS.has(key)) return;
        expect(AUTH_CALLS.test(fn.body), `${key} must call requireUserAction()/requireOwnerAction()`).toBe(true);
      });
    }
  }

  for (const f of routeFiles) {
    const src = fs.readFileSync(f.abs, "utf8");
    for (const fn of exportedFunctions(src).filter((e) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(e.name))) {
      const key = `${f.rel}#${fn.name}`;
      it(`route ${key}`, () => {
        if (PUBLIC_ROUTES.has(key)) return;
        expect(AUTH_CALLS.test(fn.body), `${key} must check the session (getUserOrNull)`).toBe(true);
      });
    }
  }
});
