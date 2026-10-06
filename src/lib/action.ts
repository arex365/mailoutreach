import "server-only";
import { z } from "zod";
import { AuthError } from "@/lib/auth/dal";

/**
 * Standard result for every Server Action (PLAN.md A6: errors say what went wrong and how to fix it).
 * Actions never throw to the browser: wrap the body in runAction().
 */
export type ActionResult<T = null> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> };

/** An error whose message is already plain language and safe to show. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly fieldErrors?: Record<string, string[] | undefined>,
  ) {
    super(message);
    this.name = "UserError";
  }
}

export function ok<T>(data: T, message?: string): ActionResult<T> {
  return { ok: true, data, message };
}

export async function runAction<T>(fn: () => Promise<T>, successMessage?: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data, message: successMessage };
  } catch (err) {
    // Let Next.js redirect()/notFound() propagate.
    if (err && typeof err === "object" && "digest" in err && typeof (err as { digest?: unknown }).digest === "string") {
      const digest = (err as { digest: string }).digest;
      if (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK")) throw err;
    }
    if (err instanceof AuthError) return { ok: false, error: err.message };
    if (err instanceof UserError) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        error: "Some details need fixing. Check the highlighted fields.",
        fieldErrors: z.flattenError(err).fieldErrors as Record<string, string[] | undefined>,
      };
    }
    console.error("[action] unexpected error", err);
    return {
      ok: false,
      error: "Something went wrong on our side and nothing was saved. Try again; if it keeps happening, restart the app.",
    };
  }
}

/** Parses input with a zod schema, throwing a friendly UserError with field messages. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const res = schema.safeParse(input);
  if (!res.success) {
    throw new UserError(
      "Some details need fixing. Check the highlighted fields.",
      z.flattenError(res.error).fieldErrors as Record<string, string[] | undefined>,
    );
  }
  return res.data;
}
