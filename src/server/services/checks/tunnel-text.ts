/**
 * cloudflared's version, read from its metrics, and the warning shown when it is known to be broken or too old
 * (research cloudflare-steps.md §6, M3-DESIGN §4.4.7). Pure: no database, no network.
 */

const UPDATE_STEPS = "Update it: open PowerShell as Administrator and run cloudflared update, then net start cloudflared.";
const KNOWN_BAD_VERSIONS: ReadonlySet<string> = new Set(["2026.8.0", "2026.8.1"]);

/** `build_info{…,version="2026.9.1"} 1` in cloudflared's Prometheus metrics → "2026.9.1". */
export function parseBuildVersion(metrics: string): string | null {
  const m = /build_info\{[^}]*\bversion="([^"]+)"/.exec(metrics);
  return m ? m[1]! : null;
}

/** A plain warning for a known-bad cloudflared, or one more than a year older than `now` (by year.month). */
export function versionWarning(version: string | null, now: Date): string | null {
  if (!version) return null;
  const v = version.trim();
  if (KNOWN_BAD_VERSIONS.has(v)) return `cloudflared ${v} has a known problem. ${UPDATE_STEPS}`;
  const m = /^(\d{4})\.(\d{1,2})\./.exec(v);
  if (!m) return null;
  const age = now.getUTCFullYear() * 12 + now.getUTCMonth() + 1 - (Number(m[1]) * 12 + Number(m[2]));
  if (age > 12) return `cloudflared ${v} is more than a year old and no longer supported. ${UPDATE_STEPS}`;
  return null;
}
