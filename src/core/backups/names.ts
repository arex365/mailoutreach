/**
 * The backups the scripts make (M6-DESIGN §3.2, §3.3): update.bat, restore.bat, setup.bat and start.bat's supervisor
 * save the database as `app-<kind>-YYYY-MM-DD_HH-MM-SS(-N).db` (the PC's local time) before they change anything. They
 * get no `Backup` row; the app lists them by these names and tidies them up after every app backup: the newest 3 of
 * each kind stay, and none younger than 14 days is deleted, so the undo backup of a recent restore always survives
 * two weeks. Pure and browser-safe.
 *
 * `scripts/lib/backups.mjs` keeps its own copy of the name rules (the scripts don't import TypeScript);
 * `tests/unit/ops/backups.test.ts` pins both to the same table.
 */

/** app-preupdate-2026-09-23_14-05-09.db, app-prerestore-…-2.db (a second one in the same second), app-premigrate-…. */
export const SCRIPT_BACKUP_PATTERN =
  /^app-(preupdate|prerestore|premigrate)-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?\.db$/;

/** The newest this many script backups of each kind are always kept. */
export const SCRIPT_BACKUP_KEEP = 3;

/** A script backup younger than this many days is never deleted, whatever the count. */
export const SCRIPT_BACKUP_MIN_AGE_DAYS = 14;

export type ScriptBackupKind = "PRE_UPDATE" | "PRE_RESTORE" | "PRE_MIGRATE";

const KIND_BY_WORD: Record<string, ScriptBackupKind> = {
  preupdate: "PRE_UPDATE",
  prerestore: "PRE_RESTORE",
  premigrate: "PRE_MIGRATE",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The kind of a script backup from its file name, or null for any other file. */
export function scriptBackupKind(name: string): ScriptBackupKind | null {
  const m = SCRIPT_BACKUP_PATTERN.exec(name);
  return m ? (KIND_BY_WORD[m[1]!] ?? null) : null;
}

/**
 * The moment a script backup's name records, in the PC's local time (as `scripts/lib/backups.mjs parseBackupTime`
 * reads it), or null for other names and impossible dates such as 31 February.
 */
export function scriptBackupDate(name: string): Date | null {
  const m = SCRIPT_BACKUP_PATTERN.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(2, 8).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(date.getTime()) || date.getDate() !== d ? null : date;
}

/**
 * Which script backups to delete (M6-DESIGN §3.3): per kind, everything beyond the newest `SCRIPT_BACKUP_KEEP`, but
 * never one younger than `SCRIPT_BACKUP_MIN_AGE_DAYS` (a date in the future, after the PC's clock went back, counts
 * as young). The age comes from the name, else from the file time. Other files are never chosen. The caller deletes
 * a `-wal` companion together with each file.
 */
export function scriptBackupsToDelete(files: ReadonlyArray<{ name: string; mtimeMs: number }>, now: Date): string[] {
  const byKind = new Map<ScriptBackupKind, Array<{ name: string; at: number }>>();
  for (const f of files) {
    const kind = scriptBackupKind(f.name);
    if (!kind) continue;
    const at = scriptBackupDate(f.name)?.getTime() ?? f.mtimeMs;
    const list = byKind.get(kind) ?? [];
    list.push({ name: f.name, at });
    byKind.set(kind, list);
  }
  const minAgeMs = SCRIPT_BACKUP_MIN_AGE_DAYS * DAY_MS;
  const out: string[] = [];
  for (const list of byKind.values()) {
    list.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const f of list.slice(SCRIPT_BACKUP_KEEP)) {
      if (now.getTime() - f.at >= minAgeMs) out.push(f.name);
    }
  }
  return out;
}
