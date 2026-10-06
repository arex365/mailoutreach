/**
 * Worker log lines: "<ISO time> <level> <message>". NSSM writes stdout/stderr to logs\*.log,
 * so every line carries its own timestamp. No database imports here (safe to load first).
 */

export type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, message: string): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}\n`;
  if (level === "error") process.stderr.write(line);
  else process.stdout.write(line);
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export const log = {
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string, err?: unknown) => write("error", err === undefined ? message : `${message}: ${errorText(err)}`),
};

export type Logger = typeof log;

/**
 * Logs a repeating problem (e.g. "database is locked" every 2 s) at most once a minute per key,
 * with a count of how many times it happened in between.
 */
export function createThrottledLogger(logger: Logger = log, intervalMs = 60_000) {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return {
    error(key: string, message: string, err?: unknown, now = Date.now()): void {
      const entry = seen.get(key);
      if (entry && now - entry.at < intervalMs) {
        entry.suppressed += 1;
        return;
      }
      const extra = entry && entry.suppressed > 0 ? ` (happened ${entry.suppressed} more times)` : "";
      seen.set(key, { at: now, suppressed: 0 });
      logger.error(message + extra, err);
    },
    /** Call when the problem is gone, so the next occurrence is logged straight away. */
    clear(key: string): void {
      seen.delete(key);
    },
  };
}
