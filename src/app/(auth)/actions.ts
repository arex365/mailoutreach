"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { dbTx, dbWrite } from "@/server/db";
import { logActivity } from "@/server/activity";
import { setupCodeHash } from "@/server/env";
import { safeAppPath } from "@/core/safe-path";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { checkSignIn } from "@/lib/auth/login";
import { createSession, destroySession } from "@/lib/auth/session";
import { recordSetupFailure, setupAttemptsBlocked } from "@/lib/auth/throttle";
import { setupCodeMatches } from "@/lib/auth/setup-code";
import { cameThroughTunnel, requestSourceKey } from "@/lib/request";
import { UserError, runAction, type ActionResult } from "@/lib/action";

/** The page to open after signing in: a path on this site only (see @/core/safe-path), else the dashboard (M6-DESIGN §4.5). */
function safeNext(next: unknown): string {
  return safeAppPath(next) ?? "/dashboard";
}

export async function loginAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const next = safeNext(formData.get("next"));
  const result = await runAction(async () => {
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    if (!email || !password) throw new UserError("Enter your email and password.");

    // Validation, throttling and the password check (same message for every kind of mismatch): lib/auth/login.
    const check = await checkSignIn({ email, password, sourceKey: await requestSourceKey() });
    if (!check.ok) throw new UserError(check.error);

    await dbWrite((c) => c.user.update({ where: { id: check.userId }, data: { lastLoginAt: new Date() } }));
    await createSession(check.userId);
    return null;
  });
  if (result.ok) redirect(next);
  return result;
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

const setupSchema = z
  .object({
    code: z.string().trim().min(1, { error: "Enter the setup code that setup.bat printed." }),
    name: z.string().trim().min(1, { error: "Enter your name." }).max(100),
    email: z.email({ error: "Enter a valid email address, for example arslan@example.com." }),
    password: z.string(),
    confirm: z.string(),
  })
  .superRefine((v, ctx) => {
    const problem = passwordProblem(v.password);
    if (problem) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
    if (v.password !== v.confirm) ctx.addIssue({ code: "custom", path: ["confirm"], message: "The two passwords don't match." });
  });

export async function setupAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    if (await cameThroughTunnel()) {
      throw new UserError("For safety, the first account can only be created on the office network or on this PC itself.");
    }
    const expected = setupCodeHash();
    if (!expected) {
      throw new UserError("There's no setup code yet. Double-click setup.bat on the PC to create one, then try again.");
    }
    // Wrong codes are counted per source (the code is 128-bit, so this is only a light brake). A spoofed
    // source can't block the Owner for long: running setup.bat again prints a new code and clears the count.
    const source = await requestSourceKey();
    if (await setupAttemptsBlocked(source)) {
      throw new UserError("Too many wrong setup codes. Wait an hour, or run setup.bat again for a new code.");
    }

    const input = setupSchema.safeParse(Object.fromEntries(formData));
    if (!input.success) {
      throw new UserError("Some details need fixing. Check the highlighted fields.", z.flattenError(input.error).fieldErrors);
    }
    if (!setupCodeMatches(input.data.code, expected)) {
      await recordSetupFailure(source);
      throw new UserError("That setup code isn't right. Check the code in the setup.bat window and type it again.", {
        code: ["That code isn't right."],
      });
    }
    const passwordHash = await hashPassword(input.data.password);
    const email = input.data.email.toLowerCase();
    const owner = await dbTx(async (tx) => {
      const count = await tx.user.count();
      if (count > 0) throw new UserError("Setup is already done. Sign in instead.");
      return tx.user.create({
        data: {
          email,
          name: input.data.name,
          role: "OWNER",
          passwordHash,
          senderDisplayName: input.data.name,
          replyInbox: email,
          lastLoginAt: new Date(),
        },
      });
    });
    await logActivity({ actorId: owner.id, type: "user.created", summary: `${owner.name} set up the app as Owner` });
    await createSession(owner.id);
    return null;
  });
  // The dashboard's "Get started" card shows the first steps (M6-DESIGN §4.4, §4.5).
  if (result.ok) redirect("/dashboard");
  return result;
}
