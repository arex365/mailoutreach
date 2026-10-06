/**
 * Whether the app's folder sits somewhere another program can take over (M6-DESIGN §2.4, G10, D37): Windows' own
 * Desktop, Documents and Pictures folders (OneDrive's folder backup and Windows' ransomware protection watch them),
 * a OneDrive folder, Dropbox or Google Drive. A sync program or a blocked write can damage the SQLite database while
 * the app runs, so the go-live card recommends moving the folder to C:\Outreach first. Only a recommendation, never a
 * blocker. Pure: the caller passes `process.cwd()` and the two environment variables.
 */

/** Folder names that are risky wherever they appear in the path (compared case-insensitively). */
const RISKY_NAMES = ["desktop", "documents", "pictures", "dropbox", "google drive"];

function segmentsOf(path: string): string[] {
  return path
    .replace(/\//g, "\\")
    .split("\\")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `inner` lies inside (or is) `outer`, compared as Windows paths (case-insensitive, either slash). */
function isInside(inner: readonly string[], outer: readonly string[]): boolean {
  if (outer.length === 0 || inner.length < outer.length) return false;
  return outer.every((s, i) => s.toLowerCase() === inner[i]!.toLowerCase());
}

/**
 * The name of the risky folder the app folder is inside, as written in the path ("Pictures", "OneDrive - Firma",
 * "Dropbox", …), the outermost one first; null when the folder is safe (e.g. `C:\Outreach`). The user profile's own
 * folders (`C:\Users\polyg`) are never counted, so a user called "Desktop" doesn't trip it; the OneDrive folder from
 * the `OneDrive` variable counts whatever it is called.
 */
export function riskyAppFolder(appFolder: string, env: { USERPROFILE?: string; OneDrive?: string }): string | null {
  const parts = segmentsOf(appFolder ?? "");
  if (parts.length === 0) return null;
  const oneDrive = segmentsOf(env.OneDrive ?? "");
  const profile = segmentsOf(env.USERPROFILE ?? "");
  // The OneDrive folder the variable names (it may be called anything, e.g. "OneDrive - Firma").
  const oneDriveName = oneDrive.length > 0 && isInside(parts, oneDrive) ? oneDrive[oneDrive.length - 1]! : null;
  const skip = isInside(parts, profile) ? profile.length : 1; // never the drive ("C:") or the profile itself
  for (let i = skip; i < parts.length; i++) {
    const name = parts[i]!;
    if (oneDriveName && i === oneDrive.length - 1) return oneDriveName;
    const lower = name.toLowerCase();
    if (lower.startsWith("onedrive") || RISKY_NAMES.includes(lower)) return name;
  }
  return oneDriveName;
}
