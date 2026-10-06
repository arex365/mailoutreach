import { safeEqualHex, sha256 } from "./tokens";

/** Must match scripts/lib/setup-code.mjs. */
export function normalizeSetupCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function setupCodeMatches(code: string, expectedHash: string): boolean {
  return safeEqualHex(sha256(normalizeSetupCode(code)), expectedHash);
}
