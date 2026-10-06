"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { UserError, parseInput, runAction } from "@/lib/action";
import { requireUserAction } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/session";
import { COMPANY_STATUSES, PRIORITIES } from "@/core/labels";
import { THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";
import { markRepliedByHand } from "@/server/services/companies/replied-by-hand";
import {
  ServiceError,
  addCompanyTag,
  addCompanyToList,
  deleteCompany,
  removeCompanyFromList,
  removeCompanyTag,
  renameCompany,
  restoreCompany,
  setCompanyCountry,
  setCompanyCustomField,
  setCompanyInstagram,
  setCompanyNiche,
  setCompanyNotes,
  setCompanyPersonalLine,
  setCompanyPriority,
  setCompanyStatus,
  setCompanyTimeZone,
  setCompanyWebsite,
  type Actor,
} from "@/server/services/companies/mutations";
import {
  addPerson,
  markPersonUnsubscribed,
  removePerson,
  setPersonNotes,
  setPersonPersonalLine,
  updatePerson,
} from "@/server/services/people";
import { getCompanyTimeline } from "@/server/services/companies/detail";
import { toTimelineItemView, type TimelinePageView } from "./timeline-view";
import type { ErrorLink, PanelResult } from "./types";

/**
 * Server Actions behind the company panel. Each one checks the session first, validates its
 * input, calls the service (which logs activity and refreshes search), then refreshes /contacts.
 */

const CONTACTS_PATH = "/contacts";

function actorOf(user: SessionUser): Actor {
  return { id: user.id, name: user.name };
}

type Message<T> = string | ((data: T) => string | undefined);

/** runAction plus: ServiceError → UserError (keeping its link), and a message built from the result. */
async function run<T>(fn: () => Promise<T>, message?: Message<T>): Promise<PanelResult<T>> {
  let link: ErrorLink | undefined;
  const res = await runAction(async () => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ServiceError) {
        link = err.link;
        throw new UserError(err.message, err.fieldErrors);
      }
      throw err;
    }
  });
  if (res.ok) {
    return { ...res, message: typeof message === "function" ? message(res.data) : message };
  }
  return link ? { ...res, link } : res;
}

const REFRESH = "Something's missing. Refresh the page and try again.";
const id = z.number({ error: REFRESH }).int({ error: REFRESH }).positive({ error: REFRESH });
const text = (max: number, what = "This") =>
  z.string({ error: `${what} must be text.` }).max(max, { error: `${what} is too long.` });

// ───────────────────────── header ─────────────────────────

const renameSchema = z.object({ companyId: id, name: text(400, "The name") });

export async function renameCompanyAction(input: { companyId: number; name: string }) {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(renameSchema, input);
    const r = await renameCompany(actorOf(user), data.companyId, data.name);
    revalidatePath(CONTACTS_PATH);
    return r;
  }, "Name saved.");
}

const statusSchema = z.object({
  companyId: id,
  status: z.enum(COMPANY_STATUSES, { error: "Pick a status from the list." }),
});

export async function setCompanyStatusAction(input: { companyId: number; status: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(statusSchema, input);
      const r = await setCompanyStatus(actorOf(user), data.companyId, data.status);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => `Status set to ${r.label}.`,
  );
}

const prioritySchema = z.object({
  companyId: id,
  priority: z.enum(PRIORITIES, { error: "Pick a priority from the list." }),
});

export async function setCompanyPriorityAction(input: { companyId: number; priority: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(prioritySchema, input);
      const r = await setCompanyPriority(actorOf(user), data.companyId, data.priority);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => `Priority set to ${r.label}.`,
  );
}

const markRepliedSchema = z.object({ companyId: id, personId: id.optional() });

/**
 * "They replied" (MAIN-DOMAIN-DESIGN O17, §3.8): the company panel's header and the campaign person panel (with the
 * person). Open to everyone signed in, listed on purpose in EVERYONE_ACTIONS (tests/integration/security/
 * owner-actions.test.ts). Stops every follow-up to the company; the status and `repliedAt` follow the real-reply rule.
 */
export async function markRepliedAction(input: { companyId: number; personId?: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(markRepliedSchema, input);
      const r = await markRepliedByHand(actorOf(user), { companyId: data.companyId, personId: data.personId ?? null });
      revalidatePath(CONTACTS_PATH);
      revalidatePath("/campaigns", "layout");
      return r;
    },
    (r) => THEY_REPLIED_TEXTS.toast(r.stopped),
  );
}

const companyOnly = z.object({ companyId: id });

export async function deleteCompanyAction(input: { companyId: number }) {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(companyOnly, input);
    const r = await deleteCompany(actorOf(user), data.companyId);
    revalidatePath(CONTACTS_PATH);
    return r;
  }, "Company deleted. Its email history is kept.");
}

export async function restoreCompanyAction(input: { companyId: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(companyOnly, input);
      const r = await restoreCompany(actorOf(user), data.companyId);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) =>
      r.domainAlsoUsedBy
        ? `Company restored. Heads up: ${r.domainAlsoUsedBy.label} uses the same website, so you may have a duplicate.`
        : "Company restored.",
  );
}

// ───────────────────────── details ─────────────────────────

const fieldSchema = (max: number, what: string) => z.object({ companyId: id, value: text(max, what) });

export async function setCompanyCountryAction(input: { companyId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(fieldSchema(100, "The country"), input);
      const r = await setCompanyCountry(actorOf(user), data.companyId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => {
      if (!r.changed) return undefined;
      const base = r.countryName ? `Country set to ${r.countryName}.` : "Country removed.";
      return r.timeZoneChanged && r.timeZone ? `${base} Time zone changed to ${r.timeZone} to match.` : base;
    },
  );
}

const timeZoneSchema = z.object({ companyId: id, timeZone: text(100, "The time zone").nullable() });

/** timeZone null = reset to the country's default. */
export async function setCompanyTimeZoneAction(input: { companyId: number; timeZone: string | null }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(timeZoneSchema, input);
      const r = await setCompanyTimeZone(actorOf(user), data.companyId, data.timeZone);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.changed ? `Time zone set to ${r.timeZone}.` : undefined),
  );
}

export async function setCompanyWebsiteAction(input: { companyId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(fieldSchema(2000, "The website"), input);
      const r = await setCompanyWebsite(actorOf(user), data.companyId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.host ? "Website saved." : "Website removed."),
  );
}

export async function setCompanyInstagramAction(input: { companyId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(fieldSchema(300, "The Instagram handle"), input);
      const r = await setCompanyInstagram(actorOf(user), data.companyId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.instagram ? "Instagram saved." : "Instagram removed."),
  );
}

export async function setCompanyNicheAction(input: { companyId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(fieldSchema(300, "The niche"), input);
      const r = await setCompanyNiche(actorOf(user), data.companyId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.niche ? "Niche saved." : "Niche removed."),
  );
}

export async function setCompanyNotesAction(input: { companyId: number; value: string }) {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(fieldSchema(20_000, "The notes"), input);
    const r = await setCompanyNotes(actorOf(user), data.companyId, data.value);
    revalidatePath(CONTACTS_PATH);
    return r;
  }, "Notes saved.");
}

export async function setCompanyPersonalLineAction(input: { companyId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(fieldSchema(2000, "The personal line"), input);
      const r = await setCompanyPersonalLine(actorOf(user), data.companyId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.line ? "Personal line saved." : "Personal line removed."),
  );
}

const customSchema = z.object({
  companyId: id,
  key: z.string({ error: REFRESH }).min(1, { error: REFRESH }).max(200, { error: REFRESH }),
  value: text(5000, "The value"),
});

export async function setCompanyCustomFieldAction(input: { companyId: number; key: string; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(customSchema, input);
      const r = await setCompanyCustomField(actorOf(user), data.companyId, data.key, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => `${r.label} saved.`,
  );
}

// ───────────────────────── lists and tags ─────────────────────────

const membershipSchema = z.object({
  companyId: id,
  id: id.optional(),
  name: text(200, "The name").optional(),
});

function targetOf(data: { id?: number; name?: string }): { id: number } | { name: string } {
  if (data.id) return { id: data.id };
  if (data.name !== undefined) return { name: data.name };
  throw new UserError(REFRESH);
}

export async function addCompanyToListAction(input: { companyId: number; id?: number; name?: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(membershipSchema, input);
      const r = await addCompanyToList(actorOf(user), data.companyId, targetOf(data));
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) =>
      r.created
        ? `Created the list ${r.name} and added this company.`
        : r.changed
          ? `Added to ${r.name}.`
          : `Already in ${r.name}.`,
  );
}

const removeMembershipSchema = z.object({ companyId: id, id });

export async function removeCompanyFromListAction(input: { companyId: number; id: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(removeMembershipSchema, input);
      const r = await removeCompanyFromList(actorOf(user), data.companyId, data.id);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.changed ? `Removed from ${r.name}.` : undefined),
  );
}

export async function addCompanyTagAction(input: { companyId: number; id?: number; name?: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(membershipSchema, input);
      const r = await addCompanyTag(actorOf(user), data.companyId, targetOf(data));
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.changed ? `Tagged ${r.name}.` : `Already tagged ${r.name}.`),
  );
}

export async function removeCompanyTagAction(input: { companyId: number; id: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(removeMembershipSchema, input);
      const r = await removeCompanyTag(actorOf(user), data.companyId, data.id);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.changed ? `Removed the tag ${r.name}.` : undefined),
  );
}

// ───────────────────────── people ─────────────────────────

const personFields = {
  name: text(400, "The name").optional(),
  email: text(400, "The email address").optional(),
  role: text(400, "The role").optional(),
};

const addPersonSchema = z.object({ companyId: id, ...personFields });

export async function addPersonAction(input: { companyId: number; name?: string; email?: string; role?: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(addPersonSchema, input);
      const r = await addPerson(actorOf(user), data.companyId, data);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.restored ? `${r.label} is back on this company.` : `${r.label} added.`),
  );
}

const updatePersonSchema = z.object({ personId: id, ...personFields });

export async function updatePersonAction(input: { personId: number; name?: string; email?: string; role?: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(updatePersonSchema, input);
      const r = await updatePerson(actorOf(user), data.personId, data);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) =>
      !r.changed ? "Nothing changed." : r.checkCleared ? "Saved. The new address needs checking again." : "Saved.",
  );
}

const personOnly = z.object({ personId: id });

export async function removePersonAction(input: { personId: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(personOnly, input);
      const r = await removePerson(actorOf(user), data.personId);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => `${r.label} removed.`,
  );
}

export async function markPersonUnsubscribedAction(input: { personId: number }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(personOnly, input);
      const r = await markPersonUnsubscribed(actorOf(user), data.personId);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.changed ? `${r.email} is unsubscribed. Nobody will email it again.` : `${r.email} was already unsubscribed.`),
  );
}

const personTextSchema = (max: number, what: string) => z.object({ personId: id, value: text(max, what) });

export async function setPersonPersonalLineAction(input: { personId: number; value: string }) {
  return run(
    async () => {
      const user = await requireUserAction();
      const data = parseInput(personTextSchema(2000, "The personal line"), input);
      const r = await setPersonPersonalLine(actorOf(user), data.personId, data.value);
      revalidatePath(CONTACTS_PATH);
      return r;
    },
    (r) => (r.line ? "Personal line saved." : "Personal line removed."),
  );
}

export async function setPersonNotesAction(input: { personId: number; value: string }) {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(personTextSchema(10_000, "The notes"), input);
    const r = await setPersonNotes(actorOf(user), data.personId, data.value);
    revalidatePath(CONTACTS_PATH);
    return r;
  }, "Notes saved.");
}

// ───────────────────────── timeline ─────────────────────────

const timelineSchema = z.object({
  companyId: id,
  filter: z.enum(["all", "emails", "replies", "changes"], { error: REFRESH }),
  cursor: z.string().max(40).nullable().optional(),
});

/** Loads a page of the company's timeline (newest first, 30 at a time). */
export async function loadTimelineAction(input: {
  companyId: number;
  filter: string;
  cursor?: string | null;
}): Promise<PanelResult<TimelinePageView>> {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(timelineSchema, input);
    const page = await getCompanyTimeline(data.companyId, { filter: data.filter, cursor: data.cursor ?? null });
    const now = new Date();
    return {
      items: page.entries.map((e) => toTimelineItemView(e, user.timeZone, now)),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * "Email now" (company header): one click makes a one-company campaign and launches it, every launch rule still
 * applying. When the wizard has to fix something first the draft is kept: `launched` is false, `href` is the wizard
 * step and `message` says why. Open to everyone signed in (listed in EVERYONE_ACTIONS). The campaign modules load on
 * the first click, so this file stays importable where the panel is rendered outside Next.
 */
export async function emailNowAction(input: { companyId: number }) {
  return run(async () => {
    const user = await requireUserAction();
    const data = parseInput(z.object({ companyId: id }), input);
    const [{ emailCompanyNow }, { CampaignError }, { wizardHref }] = await Promise.all([
      import("@/server/services/campaigns/email-now"),
      import("@/server/services/campaigns/errors"),
      import("@/components/campaign-wizard/steps"),
    ]);
    try {
      const res = await emailCompanyNow(actorOf(user), data.companyId, { timeZone: user.timeZone });
      revalidatePath("/campaigns");
      revalidatePath(CONTACTS_PATH);
      if (res.launched) return { launched: true, href: `/campaigns/${res.campaignId}`, message: res.message };
      return { launched: false, href: wizardHref(res.campaignId, res.step), message: res.problem };
    } catch (err) {
      if (err instanceof CampaignError) throw new UserError(err.message);
      throw err;
    }
  });
}
