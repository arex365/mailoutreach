import { Prisma, type Person } from "@/generated/prisma/client";
import { dbTx, type Tx } from "@/server/db";
import { logActivity } from "@/server/activity";
import { enqueueJob } from "@/server/jobs";
import { getSetting } from "@/server/settings";
import { stopRecipients } from "@/server/services/mail-events/stops";
import { refreshCompanySearchText } from "@/server/company-search";
import { GENERAL_INBOX_NAME, isRoleAddress, parseEmail, type ParsedEmail } from "@/core/email-address";
import { SUPPRESSION_PRECEDENCE } from "@/core/mailgun/events";
import { firstNameFrom, normalizeText } from "@/core/text";
import { CLEARED_CHECK_FIELDS } from "@/core/verification/types";
import {
  ServiceError,
  cleanLine,
  cleanMultiline,
  cleanPersonalLine,
  companyLink,
  loadActiveCompany,
  personalLineProblem,
  type Actor,
  type ChangeResult,
} from "./companies/mutations";
import { companyCode } from "./companies/detail";

/**
 * People at a company (PLAN.md B4, CONVENTIONS "Person fields").
 *  - emailNorm is unique across ALL people, including removed ones, so history can't be dodged.
 *  - A role address (info@, kontakt@ …) with no name becomes "General inbox".
 *  - Changing the address clears its check result.
 */

export const INVALID_EMAIL_MESSAGE = "That doesn't look like an email address: check for typos like a missing @.";

export const PERSON_LIMITS = { name: 200, role: 200, notes: 5_000 } as const;

export type PersonInput = { name?: string | null; email?: string | null; role?: string | null };

type Derived = { name: string; firstName: string | null; isGeneric: boolean };

/** Name / first name / General inbox rules for a person. */
export function derivePersonName(nameInput: string | null | undefined, parsed: ParsedEmail | null): Derived {
  let name = cleanLine(nameInput);
  if (!name && parsed?.displayName) name = cleanLine(parsed.displayName);
  let isGeneric = false;
  if (!name && parsed && isRoleAddress(parsed.email)) {
    name = GENERAL_INBOX_NAME;
    isGeneric = true;
  } else if (name && normalizeText(name) === normalizeText(GENERAL_INBOX_NAME)) {
    name = GENERAL_INBOX_NAME;
    isGeneric = true;
  }
  return { name, isGeneric, firstName: firstNameFrom(name, isGeneric) || null };
}

/** "Anna Schmidt", "General inbox (info@acme.de)", or the address when there's no name. */
export function personLabel(p: { id: number; name: string; email: string | null; isGeneric?: boolean }): string {
  if (p.isGeneric && p.email) return `${p.name || GENERAL_INBOX_NAME} (${p.email})`;
  return p.name || p.email || `Person ${p.id}`;
}

function parseInputs(input: PersonInput): { parsed: ParsedEmail | null; role: string | null; rawName: string } {
  const rawEmail = (input.email ?? "").trim();
  const parsed = rawEmail ? parseEmail(rawEmail) : null;
  if (rawEmail && !parsed) {
    throw new ServiceError(INVALID_EMAIL_MESSAGE, { fieldErrors: { email: [INVALID_EMAIL_MESSAGE] } });
  }
  const rawName = cleanLine(input.name);
  if (rawName.length > PERSON_LIMITS.name) {
    const msg = `Keep the name under ${PERSON_LIMITS.name} characters.`;
    throw new ServiceError(msg, { fieldErrors: { name: [msg] } });
  }
  const role = cleanLine(input.role) || null;
  if (role && role.length > PERSON_LIMITS.role) {
    const msg = `Keep the role under ${PERSON_LIMITS.role} characters.`;
    throw new ServiceError(msg, { fieldErrors: { role: [msg] } });
  }
  if (!parsed && !rawName) {
    const msg = "Enter a name or an email address.";
    throw new ServiceError(msg, { fieldErrors: { name: [msg], email: [msg] } });
  }
  return { parsed, role, rawName };
}

type Owner = Person & { company: { id: number; name: string; deletedAt: Date | null } };

async function findEmailOwner(tx: Tx, emailNorm: string): Promise<Owner | null> {
  return tx.person.findUnique({
    where: { emailNorm },
    include: { company: { select: { id: true, name: true, deletedAt: true } } },
  });
}

function belongsElsewhereError(email: string, owner: Owner): ServiceError {
  const removed = Boolean(owner.deletedAt || owner.company.deletedAt);
  const msg =
    `${email} already belongs to ${companyCode(owner.company.id)} ${owner.company.name}.` +
    (removed ? " It was removed there, but it's kept so its email history still counts." : "");
  return new ServiceError(msg, { fieldErrors: { email: [msg] }, link: companyLink(owner.company) });
}

function isUniqueClash(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const CLASH_MESSAGE = "That email address was added somewhere else a moment ago. Refresh the page and try again.";

async function loadActivePerson(tx: Tx, personId: number) {
  const p = await tx.person.findUnique({
    where: { id: personId },
    include: { company: { select: { id: true, name: true, deletedAt: true } } },
  });
  if (!p || p.deletedAt) throw new ServiceError("This person was removed. Refresh the page to see the latest.");
  return p;
}

export type AddPersonResult = { personId: number; label: string; restored: boolean };

/** Adds a person to a company (or brings back a removed person at the same company with this address). */
export async function addPerson(actor: Actor, companyId: number, input: PersonInput): Promise<AddPersonResult> {
  const { parsed, role, rawName } = parseInputs(input);
  try {
    return await dbTx(async (tx) => {
      const c = await loadActiveCompany(tx, companyId);
      if (parsed) {
        const owner = await findEmailOwner(tx, parsed.norm);
        if (owner && owner.companyId !== c.id) throw belongsElsewhereError(parsed.email, owner);
        if (owner && !owner.deletedAt) {
          const msg = `${parsed.email} is already on this company.`;
          throw new ServiceError(msg, { fieldErrors: { email: [msg] } });
        }
        if (owner) {
          // Same company, removed earlier: bring them back rather than lose their history.
          const d = rawName || parsed.displayName ? derivePersonName(rawName, parsed) : null;
          const person = await tx.person.update({
            where: { id: owner.id },
            data: {
              deletedAt: null,
              ...(d ? { name: d.name, firstName: d.firstName, isGeneric: d.isGeneric } : {}),
              ...(role ? { role } : {}),
            },
          });
          await refreshCompanySearchText(tx, [c.id]);
          const label = personLabel(person);
          await logActivity(
            {
              actorId: actor.id,
              type: "person.created",
              summary: `${actor.name} added back ${label}`,
              companyId: c.id,
              personId: person.id,
              data: { email: person.email, restored: true },
            },
            tx,
          );
          return { personId: person.id, label, restored: true };
        }
      }
      const d = derivePersonName(rawName, parsed);
      const person = await tx.person.create({
        data: {
          companyId: c.id,
          name: d.name,
          firstName: d.firstName,
          isGeneric: d.isGeneric,
          role,
          email: parsed?.email ?? null,
          emailNorm: parsed?.norm ?? null,
        },
      });
      await refreshCompanySearchText(tx, [c.id]);
      const label = personLabel(person);
      await logActivity(
        {
          actorId: actor.id,
          type: "person.created",
          summary: `${actor.name} added ${label}`,
          companyId: c.id,
          personId: person.id,
          data: { name: person.name, email: person.email, role: person.role },
        },
        tx,
      );
      return { personId: person.id, label, restored: false };
    });
  } catch (err) {
    if (isUniqueClash(err)) throw new ServiceError(CLASH_MESSAGE, { fieldErrors: { email: [CLASH_MESSAGE] } });
    throw err;
  }
}

export type UpdatePersonResult = ChangeResult & { label: string; checkCleared: boolean };

/**
 * Edits name, email and role. A new address clears the check result (all six check fields, `CLEARED_CHECK_FIELDS`)
 * and a bounce on the old address.
 */
export async function updatePerson(actor: Actor, personId: number, input: PersonInput): Promise<UpdatePersonResult> {
  const { parsed, role, rawName } = parseInputs(input);
  try {
    return await dbTx(async (tx) => {
      const p = await loadActivePerson(tx, personId);
      if (p.company.deletedAt) throw new ServiceError("This company was deleted. Restore it first to make changes.");
      const newNorm = parsed?.norm ?? null;
      const normChanged = newNorm !== p.emailNorm;
      if (parsed && normChanged) {
        const owner = await findEmailOwner(tx, parsed.norm);
        if (owner && owner.id !== p.id) {
          if (owner.companyId !== p.companyId) throw belongsElsewhereError(parsed.email, owner);
          const msg = owner.deletedAt
            ? `${parsed.email} belonged to someone removed from this company. Use Add a person with this address to bring them back.`
            : `${parsed.email} is already on this company.`;
          throw new ServiceError(msg, { fieldErrors: { email: [msg] } });
        }
      }
      const d = derivePersonName(rawName, parsed);
      const next = {
        name: d.name,
        firstName: d.firstName,
        isGeneric: d.isGeneric,
        role,
        email: parsed?.email ?? null,
        emailNorm: newNorm,
      };
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      if (next.name !== p.name) changes.name = { from: p.name || null, to: next.name || null };
      if (next.email !== p.email) changes.email = { from: p.email, to: next.email };
      if (next.role !== p.role) changes.role = { from: p.role, to: next.role };
      const flagsChanged = next.isGeneric !== p.isGeneric || next.firstName !== p.firstName;
      const before = personLabel(p);
      if (Object.keys(changes).length === 0 && !flagsChanged) {
        return { changed: false, label: before, checkCleared: false };
      }
      const checkCleared =
        normChanged &&
        Boolean(
          p.verificationStatus ||
            p.verifiedAt ||
            p.verificationProvider ||
            p.verificationRisk ||
            p.verificationDisposable ||
            p.verificationUnknowns > 0,
        );
      await tx.person.update({
        where: { id: p.id },
        data: {
          ...next,
          ...(normChanged
            ? {
                // All six check fields together (M5-DESIGN §2.6): the new address needs its own check.
                ...CLEARED_CHECK_FIELDS,
                // A bounce belongs to the old address (which stays on the do-not-email list).
                bouncedAt: null,
              }
            : {}),
        },
      });
      await refreshCompanySearchText(tx, [p.companyId]);
      const words: string[] = [];
      if (changes.name) words.push(`name to ${next.name || "(no name)"}`);
      if (changes.email) words.push(`email to ${next.email ?? "(no email)"}`);
      if (changes.role) words.push(`role to ${next.role ?? "(no role)"}`);
      const summary =
        words.length > 0
          ? `${actor.name} changed ${before}'s ${words.join(", ")}${checkCleared ? " and cleared the address check" : ""}`
          : `${actor.name} updated ${before}`;
      await logActivity(
        {
          actorId: actor.id,
          type: "person.updated",
          summary,
          companyId: p.companyId,
          personId: p.id,
          data: { changes, checkCleared, bounceCleared: normChanged && Boolean(p.bouncedAt) },
        },
        tx,
      );
      return { changed: true, label: personLabel({ id: p.id, ...next }), checkCleared };
    });
  } catch (err) {
    if (isUniqueClash(err)) throw new ServiceError(CLASH_MESSAGE, { fieldErrors: { email: [CLASH_MESSAGE] } });
    throw err;
  }
}

/** Soft delete: the person disappears from the company but their history stays. */
export async function removePerson(actor: Actor, personId: number): Promise<ChangeResult & { label: string }> {
  return dbTx(async (tx) => {
    const p = await loadActivePerson(tx, personId);
    if (p.company.deletedAt) throw new ServiceError("This company was deleted. Restore it first to make changes.");
    await tx.person.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    await refreshCompanySearchText(tx, [p.companyId]);
    const label = personLabel(p);
    await logActivity(
      {
        actorId: actor.id,
        type: "person.deleted",
        summary: `${actor.name} removed ${label}`,
        companyId: p.companyId,
        personId: p.id,
        data: { email: p.email },
      },
      tx,
    );
    return { changed: true, label };
  });
}

/**
 * Marks the person unsubscribed and puts the address on the do-not-email list for every sender (an address already
 * listed for a stronger reason, a spam complaint, keeps it: SUPPRESSION_PRECEDENCE, like everywhere else).
 * Works even on a deleted company: it's a safety action.
 * In the same transaction every open recipient with this address stops (their waiting emails are skipped at once,
 * M3-DESIGN §4.4.6); afterwards the push to Mailgun's unsubscribes list is queued (never in the practice copy).
 */
export async function markPersonUnsubscribed(
  actor: Actor,
  personId: number,
): Promise<ChangeResult & { email: string }> {
  const res = await markUnsubscribedInTx(actor, personId);
  if (res.changed || res.stopped > 0) {
    try {
      if ((await getSetting("practice.copy")) !== true) {
        await enqueueJob({ type: "mailgun.syncSuppressions", dedupeKey: "mailgun:push", priority: 10, createdById: actor.id });
      }
    } catch (err) {
      // The next catch-up pushes it anyway (every local entry without pushedToMailgunAt).
      console.error("[people] couldn't queue the push to Mailgun", err);
    }
  }
  return { changed: res.changed, email: res.email };
}

async function markUnsubscribedInTx(actor: Actor, personId: number): Promise<ChangeResult & { email: string; stopped: number }> {
  return dbTx(async (tx) => {
    const p = await loadActivePerson(tx, personId);
    if (!p.emailNorm || !p.email) throw new ServiceError("This person has no email address, so there's nothing to unsubscribe.");
    const now = new Date();
    const stopped = await stopRecipients(tx, { emailNorm: p.emailNorm, reason: "unsubscribed", scope: "real", now });
    let changed = false;
    if (!p.unsubscribedAt) {
      await tx.person.update({ where: { id: p.id }, data: { unsubscribedAt: now } });
      changed = true;
    }
    const existing = await tx.suppression.findUnique({ where: { emailNorm: p.emailNorm } });
    const detail = `Marked unsubscribed by ${actor.name}`;
    if (!existing) {
      await tx.suppression.create({ data: { emailNorm: p.emailNorm, reason: "UNSUBSCRIBED", source: "manual", detail } });
      changed = true;
    } else if (SUPPRESSION_PRECEDENCE.indexOf("UNSUBSCRIBED") > SUPPRESSION_PRECEDENCE.indexOf(existing.reason)) {
      // Only a weaker reason (do not email, invalid, bounced) is raised: a spam complaint stays a complaint.
      // Unsubscribes are pushed to Mailgun as such, so reset the push marker.
      await tx.suppression.update({
        where: { id: existing.id },
        data: { reason: "UNSUBSCRIBED", source: "manual", detail, pushedToMailgunAt: null },
      });
      changed = true;
    }
    if (!changed) return { changed: false, email: p.email, stopped };
    await logActivity(
      {
        actorId: actor.id,
        type: "person.unsubscribed",
        summary: `${actor.name} marked ${p.email} as unsubscribed`,
        companyId: p.companyId,
        personId: p.id,
        data: { email: p.email, stopped },
      },
      tx,
    );
    return { changed: true, email: p.email, stopped };
  });
}

/** The person's own personal line, used instead of the company's line in emails to them. */
export async function setPersonPersonalLine(
  actor: Actor,
  personId: number,
  input: string,
): Promise<ChangeResult & { line: string | null }> {
  const line = cleanPersonalLine(input) || null;
  const problem = line ? personalLineProblem(line) : null;
  if (problem) throw new ServiceError(problem, { fieldErrors: { line: [problem] } });
  return dbTx(async (tx) => {
    const p = await loadActivePerson(tx, personId);
    if (p.company.deletedAt) throw new ServiceError("This company was deleted. Restore it first to make changes.");
    if (p.personalLineOverride === line) return { changed: false, line };
    await tx.person.update({ where: { id: p.id }, data: { personalLineOverride: line } });
    const label = personLabel(p);
    await logActivity(
      {
        actorId: actor.id,
        type: "person.updated",
        summary: line
          ? `${actor.name} wrote a personal line for ${label}`
          : `${actor.name} removed the personal line for ${label}`,
        companyId: p.companyId,
        personId: p.id,
        data: { field: "personalLineOverride", line },
      },
      tx,
    );
    return { changed: true, line };
  });
}

export async function setPersonNotes(actor: Actor, personId: number, input: string): Promise<ChangeResult> {
  const notes = cleanMultiline(input);
  if (notes.length > PERSON_LIMITS.notes) {
    const msg = `Notes can be up to ${PERSON_LIMITS.notes.toLocaleString("en-US")} characters. Shorten them a little.`;
    throw new ServiceError(msg, { fieldErrors: { notes: [msg] } });
  }
  return dbTx(async (tx) => {
    const p = await loadActivePerson(tx, personId);
    if (p.company.deletedAt) throw new ServiceError("This company was deleted. Restore it first to make changes.");
    if (p.notes === notes) return { changed: false };
    await tx.person.update({ where: { id: p.id }, data: { notes } });
    const label = personLabel(p);
    await logActivity(
      {
        actorId: actor.id,
        type: "person.updated",
        summary: notes ? `${actor.name} updated the notes for ${label}` : `${actor.name} cleared the notes for ${label}`,
        companyId: p.companyId,
        personId: p.id,
        data: { field: "notes", text: notes },
      },
      tx,
    );
    return { changed: true };
  });
}
