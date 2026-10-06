"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { RenderedEmail } from "@/core/templates/types";
import { MAX_BODY_CHARS, MAX_FOLLOW_UPS, MAX_SUBJECT_CHARS } from "@/core/templates/steps";
import { UserError, parseInput, runAction, type ActionResult } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { RenderError, renderTemplatePreview } from "@/server/services/render";
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  renameTemplate,
  saveTemplate,
  searchPeopleForPreview,
  starMaster,
  type Actor,
  type PreviewPerson,
  type TemplateResult,
} from "@/server/services/templates";

/**
 * Server Actions for the Templates screens (SPEC §5): create, duplicate, rename, delete, star as
 * master, save, and the live preview. Members and the Owner can both use them (SPEC §1).
 * Every action checks the session first and answers in plain words (docs/dev/CONVENTIONS.md).
 */

function actorOf(user: SessionUser): Actor {
  return { id: user.id, name: user.name };
}

/** Turns a service result into a thrown UserError (with field errors) when it failed. */
function unwrap<T extends object>(res: TemplateResult<T>): T {
  if (!res.ok) throw new UserError(res.error, res.fieldErrors);
  return res;
}

/** runAction, with a success message that depends on the result. */
async function run<T>(fn: () => Promise<{ data: T; message: string }>): Promise<ActionResult<T>> {
  let message: string | undefined;
  const res = await runAction(async () => {
    const out = await fn();
    message = out.message;
    return out.data;
  });
  return res.ok ? { ...res, message } : res;
}

function refresh(id?: number) {
  revalidatePath("/templates");
  if (id) revalidatePath(`/templates/${id}`);
}

const idSchema = z.number({ error: "That template doesn't exist any more. Reload the page." }).int().positive();
const nameSchema = z.string({ error: "Give the template a name." }).max(500, { error: "Keep the name under 80 characters." });

export async function createTemplateAction(input: { name: string }): Promise<ActionResult<{ id: number; name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ name: nameSchema }), input);
    const { template } = unwrap(await createTemplate(actorOf(user), data.name));
    refresh();
    return { data: template, message: `Created "${template.name}". Write the first email, then save.` };
  });
}

export async function duplicateTemplateAction(input: { id: number }): Promise<ActionResult<{ id: number; name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ id: idSchema }), input);
    const { template } = unwrap(await duplicateTemplate(actorOf(user), data.id));
    refresh();
    return { data: template, message: `Made a copy called "${template.name}".` };
  });
}

export async function renameTemplateAction(input: { id: number; name: string }): Promise<ActionResult<{ id: number; name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ id: idSchema, name: nameSchema }), input);
    const { template } = unwrap(await renameTemplate(actorOf(user), data.id, data.name));
    refresh(template.id);
    return { data: template, message: "Template renamed." };
  });
}

export async function deleteTemplateAction(input: { id: number }): Promise<ActionResult<{ newMaster: { id: number; name: string } | null }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ id: idSchema }), input);
    const res = unwrap(await deleteTemplate(actorOf(user), data.id));
    refresh();
    return {
      data: { newMaster: res.newMaster },
      message: res.newMaster
        ? `Deleted "${res.name}". "${res.newMaster.name}" is now the master template.`
        : `Deleted "${res.name}".`,
    };
  });
}

export async function starTemplateAction(input: { id: number }): Promise<ActionResult<{ id: number; name: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ id: idSchema }), input);
    const res = unwrap(await starMaster(actorOf(user), data.id));
    refresh(res.template.id);
    return {
      data: res.template,
      message: res.changed
        ? `"${res.template.name}" is now the master template. New campaigns start from it.`
        : `"${res.template.name}" is already the master template.`,
    };
  });
}

const stepSchema = z.object({
  step: z.number().int().min(0).max(MAX_FOLLOW_UPS),
  enabled: z.boolean(),
  subject: z.string().max(MAX_SUBJECT_CHARS * 5).nullable().optional(),
  body: z.string().max(MAX_BODY_CHARS * 2, { error: "This email is too long to save." }),
  delayDays: z.number().finite(),
});

const saveSchema = z.object({
  id: idSchema,
  name: nameSchema,
  steps: z.array(stepSchema).min(1).max(MAX_FOLLOW_UPS + 1),
  /** When the editor opened (or last saved) the template: a save over someone's newer changes is refused. */
  updatedAt: z.iso.datetime({ error: "Reload the page and try again." }).optional(),
});

export async function saveTemplateAction(input: z.input<typeof saveSchema>): Promise<ActionResult<{ id: number; name: string; updatedAt: string }>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(saveSchema, input);
    const { template } = unwrap(
      await saveTemplate(actorOf(user), data.id, { name: data.name, steps: data.steps, expectedUpdatedAt: data.updatedAt }),
    );
    refresh(template.id);
    return { data: { id: template.id, name: template.name, updatedAt: template.updatedAt.toISOString() }, message: "Template saved." };
  });
}

const previewSchema = z.object({
  templateId: idSchema,
  step: z.number().int().min(0).max(MAX_FOLLOW_UPS),
  personId: z.number({ error: "Pick a contact to preview." }).int().positive({ error: "Pick a contact to preview." }),
  senderId: z.number({ error: "Pick a teammate to send as." }).int().positive({ error: "Pick a teammate to send as." }),
  draft: z
    .object({
      subject: z.string().max(MAX_SUBJECT_CHARS * 5).nullable(),
      body: z.string().max(MAX_BODY_CHARS * 2),
      firstSubject: z.string().max(MAX_SUBJECT_CHARS * 5).nullable().optional(),
    })
    .optional(),
});

/** The live preview: one step of a template (or its unsaved text) for a real contact and sender. */
export async function previewTemplateAction(input: z.input<typeof previewSchema>): Promise<ActionResult<RenderedEmail>> {
  return runAction(async () => {
    await requireUserAction();
    const data = parseInput(previewSchema, input);
    try {
      return await renderTemplatePreview(data);
    } catch (err) {
      if (err instanceof RenderError) throw new UserError(err.message);
      throw err;
    }
  });
}

/** People with an email address, for the preview's contact picker (also used by the campaign wizard). */
export async function searchPreviewPeopleAction(input: { q: string }): Promise<ActionResult<PreviewPerson[]>> {
  return runAction(async () => {
    await requireUserAction();
    const data = parseInput(z.object({ q: z.string().max(200, { error: "Type a shorter search." }) }), input);
    return searchPeopleForPreview(data.q);
  });
}
