import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { makeUser, setSettingValue } from "../campaigns/seed";

/**
 * The Member-refusal sweep (PLAN B7, B12 "Owner-only actions refused for Members", M6-DESIGN §5.4). It finds every
 * "use server" file under src/app and src/components (its first statement is the directive) and, with the TypeScript parser, every
 * exported function whose body calls requireOwnerAction(). Each one, called with `{}` by a signed-in Member, must
 * answer exactly "Only the Owner can do this." and change nothing in ten tables. Every other exported action must be on
 * the explicit everyone-list below, so a new action open to Members is added on purpose, never by accident.
 */

type TestUser = { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number };
const auth = vi.hoisted(() => ({ user: null as TestUser | null }));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock("@/lib/auth/dal", () => {
  class AuthError extends Error {
    constructor(
      message: string,
      readonly status: 401 | 403,
    ) {
      super(message);
      this.name = "AuthError";
    }
  }
  const requireUserAction = async () => {
    if (!auth.user) throw new AuthError("Your session has ended. Please sign in again.", 401);
    return auth.user;
  };
  const requireOwnerAction = async () => {
    const user = await requireUserAction();
    if (user.role !== "OWNER") throw new AuthError("Only the Owner can do this.", 403);
    return user;
  };
  return {
    AuthError,
    getUserOrNull: async () => auth.user,
    requireUserAction,
    requireOwnerAction,
    requireUser: requireUserAction,
    requireOwner: requireOwnerAction,
  };
});

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const APP = path.join(ROOT, "src", "app");
/**
 * Server Actions also live next to their components (the company panel, the inbox check card: MAIN-DOMAIN-DESIGN §8 P6),
 * so the sweep reads src/components too; their keys stay relative to src/app ("../components/…").
 */
const COMPONENTS = path.join(ROOT, "src", "components");

/**
 * Exported actions that any signed-in person (or, for the sign-in pages, anyone) may use, per "use server" file
 * (path under src/app). Adding an everyone-action means adding it here on purpose.
 */
const EVERYONE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "(app)/ai-lines/actions.ts": ["approveDraftAction", "rejectDraftAction", "undoDraftAction", "regenerateDraftAction", "retryDraftAction", "stopDraftRunAction"],
  "(app)/campaigns/new/actions.ts": ["createDraftAction", "createDraftFromCompaniesAction"],
  "(app)/campaigns/outbox/actions.ts": ["simulateEmailAction", "simulateReplyAction"],
  "(app)/campaigns/[id]/actions.ts": [
    "pauseCampaignAction",
    "resumeCampaignAction",
    "cancelCampaignAction",
    "skipRecipientAction",
    "retryEmailAction",
    "editUnsentEmailAction",
    "discardUnsentEditAction",
  ],
  "(app)/campaigns/[id]/setup/actions.ts": [
    "renameDraftAction",
    "deleteDraftAction",
    "continueAction",
    "previewAudienceFilterAction",
    "addAudienceFilterAction",
    "removeAudienceCompanyAction",
    "clearAudienceAction",
    "tickPersonAction",
    "putBackCompanyAction",
    "setSenderAction",
    "saveStepsAction",
    "applyTemplateAction",
    "saveBackToTemplateAction",
    "previewStepAction",
    "searchRecipientsAction",
    "reviewDetailAction",
    "setIncludedAction",
    "editRecipientEmailAction",
    "resetRecipientEmailAction",
    "setCompanyLineAction",
    "setPersonLineAction",
    "setScheduleAction",
    "launchAction",
  ],
  "(app)/campaigns/[id]/setup/test-send-actions.ts": ["testSendInfoAction", "sendMeATestAction"],
  "(app)/campaigns/[id]/setup/verify-actions.ts": ["campaignCheckViewAction", "startCampaignChecksAction", "stopChecksAction"],
  "(app)/contacts/actions.ts": [
    "bulkSetStatusAction",
    "bulkSetPriorityAction",
    "bulkAddToListAction",
    "bulkRemoveFromListAction",
    "bulkAddTagAction",
    "bulkRemoveTagAction",
    "bulkDeleteAction",
    "selectAllMatchingAction",
    "createListAction",
    "renameListAction",
    "deleteListAction",
    "createCompanyAction",
    "restoreCompanyAction",
    "searchCompaniesAction",
  ],
  "(app)/contacts/ai-actions.ts": ["estimateDraftLinesAction", "startDraftLinesAction"],
  "(app)/contacts/check-actions.ts": ["estimateChecksAction", "startChecksAction", "checkPersonAction", "checkRunViewAction", "stopChecksAction"],
  "(app)/import/actions.ts": [
    "saveImportMappingAction",
    "saveImportOptionsAction",
    "checkImportAction",
    "setImportChoiceAction",
    "setImportDefaultsAction",
    "startImportAction",
    "importJobAction",
    "workerRunningAction",
    "discardImportAction",
  ],
  "(app)/notifications/actions.ts": ["markNotificationsReadAction", "markAllNotificationsReadAction"],
  "(app)/notifications/reply-actions.ts": [
    "markReplyAnsweredAction",
    "markReplyNotNeededAction",
    "reopenReplyAction",
    "confirmReplyAction",
    "linkReplyAction",
    "addReplySenderAction",
    "replyLinkCompanyAction",
    "continueMyFollowUpsAction",
  ],
  // Settings › Backups is the one mixed page: anyone may click Back up now (M6-DESIGN §5.1 R6).
  "(app)/settings/backups/actions.ts": ["backUpNowAction"],
  "(app)/settings/notifications/actions.ts": ["savePopupGroupsAction"],
  "(app)/settings/profile/actions.ts": ["updateProfileAction", "changePasswordAction"],
  "(app)/templates/actions.ts": [
    "createTemplateAction",
    "duplicateTemplateAction",
    "renameTemplateAction",
    "deleteTemplateAction",
    "starTemplateAction",
    "saveTemplateAction",
    "previewTemplateAction",
    "searchPreviewPeopleAction",
  ],
  // The signed-out pages (CONVENTIONS "Auth": the only public actions).
  "(auth)/actions.ts": ["loginAction", "logoutAction", "setupAction"],
  "(auth)/invite/actions.ts": ["acceptInviteAction"],
  "(auth)/reset/actions.ts": ["resetPasswordAction"],
  // "use server" files under src/components (keys relative to src/app). The company panel: every change anyone may make
  // to a company or its people, and "They replied" (MAIN-DOMAIN-DESIGN O17, markRepliedAction, open to Members on
  // purpose). The inbox check card: "I've read contact@…" (O33, markInboxCheckedAction, open to Members on purpose).
  "../components/company-panel/actions.ts": [
    "renameCompanyAction",
    "setCompanyStatusAction",
    "setCompanyPriorityAction",
    "markRepliedAction",
    "emailNowAction",
    "deleteCompanyAction",
    "restoreCompanyAction",
    "setCompanyCountryAction",
    "setCompanyTimeZoneAction",
    "setCompanyWebsiteAction",
    "setCompanyInstagramAction",
    "setCompanyNicheAction",
    "setCompanyNotesAction",
    "setCompanyPersonalLineAction",
    "setCompanyCustomFieldAction",
    "addCompanyToListAction",
    "removeCompanyFromListAction",
    "addCompanyTagAction",
    "removeCompanyTagAction",
    "addPersonAction",
    "updatePersonAction",
    "removePersonAction",
    "markPersonUnsubscribedAction",
    "setPersonPersonalLineAction",
    "setPersonNotesAction",
    "loadTimelineAction",
  ],
  "../components/replies/inbox-check-actions.ts": ["markInboxCheckedAction"],
};

type ServerAction = { name: string; ownerOnly: boolean };
type ServerFile = { rel: string; specifier: string; actions: ServerAction[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** True when the node (a function body) calls requireOwnerAction() anywhere inside, nested callbacks included. */
function callsRequireOwner(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "requireOwnerAction") {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Every "use server" file under src/app and src/components with its exported functions. */
function serverFiles(): ServerFile[] {
  const out: ServerFile[] = [];
  for (const file of [...walk(APP), ...walk(COMPONENTS)]) {
    const text = fs.readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const first = sf.statements[0];
    const isUseServer =
      first !== undefined && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
    if (!isUseServer) continue;
    const actions: ServerAction[] = [];
    for (const st of sf.statements) {
      if (!isExported(st)) continue;
      if (ts.isFunctionDeclaration(st) && st.name) {
        actions.push({ name: st.name.text, ownerOnly: callsRequireOwner(st) });
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            actions.push({ name: d.name.text, ownerOnly: callsRequireOwner(d.initializer) });
          }
        }
      }
    }
    const rel = path.relative(APP, file).replace(/\\/g, "/");
    const fromSrc = path.relative(SRC, file).replace(/\\/g, "/");
    out.push({ rel, specifier: `@/${fromSrc.replace(/\.tsx?$/, "")}`, actions });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const t = await createTestDb("owner-actions");
const { db } = await import("@/server/db");

let member: TestUser;

/** The ten tables an Owner-only action could change (M6-DESIGN §5.4), each row as JSON, in a stable order. */
async function snapshot(): Promise<Record<string, string[]>> {
  const tables = {
    Setting: await db.setting.findMany(),
    SystemState: await db.systemState.findMany(),
    Secret: await db.secret.findMany(),
    Job: await db.job.findMany(),
    User: await db.user.findMany(),
    AccessLink: await db.accessLink.findMany(),
    ActivityLog: await db.activityLog.findMany(),
    Notification: await db.notification.findMany(),
    Suppression: await db.suppression.findMany(),
    Backup: await db.backup.findMany(),
  };
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map((r) => JSON.stringify(r)).sort()]));
}

const files = serverFiles();
const ownerFiles = files.filter((f) => f.actions.some((a) => a.ownerOnly));

beforeAll(async () => {
  const owner = await makeUser("Arslan", { role: "OWNER" });
  const m = await makeUser("Ali");
  member = { id: m.id, email: m.email, name: m.name, role: "MEMBER", timeZone: "Europe/Berlin", sessionId: 1 };
  // A little of everything the snapshot compares, so a stray write shows up as a change.
  await setSettingValue("sending.mode", "DRY_RUN");
  await setSettingValue("sending.testList", ["tess@example.com"]);
  await setSettingValue("teamRule.days", 30);
  const { dbWrite } = await import("@/server/db");
  await dbWrite(async (c) => {
    await c.activityLog.create({ data: { actorId: owner.id, type: "settings.updated", summary: "Arslan saved something" } });
    await c.suppression.create({ data: { emailNorm: "gone@example.com", reason: "BOUNCED", source: "webhook" } });
  });
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("the sweep finds the Owner-only actions", () => {
  it("in every \"use server\" file, including the ones a fixed list would miss", () => {
    const owners = ownerFiles.flatMap((f) => f.actions.filter((a) => a.ownerOnly).map((a) => `${f.rel}#${a.name}`));
    expect(ownerFiles.length).toBeGreaterThanOrEqual(11);
    expect(owners.length).toBeGreaterThanOrEqual(47);
    for (const expected of [
      "(app)/settings/deliverability/check-actions.ts#resumeChecksAction",
      "(app)/ai-lines/actions.ts#resumeAiAction",
      "(app)/settings/limits/actions.ts#saveRulesAction",
      "(app)/settings/system/actions.ts#saveAccessChoiceAction",
      "(app)/settings/team/actions.ts#makeOwnerAction",
      "(app)/settings/backups/actions.ts#saveSecondFolderAction",
      "(app)/settings/sending/actions.ts#connectMailgunAction",
      "(app)/settings/sending/actions.ts#saveFromAddressAction",
      // Review SCREENS-01: "Remove the sending key" (Settings › Sending & Mailgun › Advanced) is Owner-only too.
      "(app)/settings/sending/actions.ts#removeSendingKeyAction",
    ]) {
      expect(owners).toContain(expected);
    }
  });
});

describe("a Member is refused by every Owner-only action", () => {
  for (const file of ownerFiles) {
    it(file.rel, async () => {
      const mod = (await import(/* @vite-ignore */ file.specifier)) as Record<string, unknown>;
      auth.user = member;
      for (const action of file.actions.filter((a) => a.ownerOnly)) {
        const fn = mod[action.name];
        expect(typeof fn, action.name).toBe("function");
        const before = await snapshot();
        const res = await (fn as (input: unknown) => Promise<unknown>)({});
        expect(res, action.name).toEqual({ ok: false, error: "Only the Owner can do this." });
        expect(await snapshot(), `${action.name} changed the database`).toEqual(before);
      }
    });
  }
});

describe("every other action is on the everyone-list on purpose", () => {
  it("lists exactly the exported actions that don't call requireOwnerAction()", () => {
    const found: Record<string, string[]> = {};
    for (const f of files) {
      const open = f.actions.filter((a) => !a.ownerOnly).map((a) => a.name);
      if (open.length > 0) found[f.rel] = [...open].sort();
    }
    const listed = Object.fromEntries(Object.entries(EVERYONE_ACTIONS).map(([rel, names]) => [rel, [...names].sort()]));
    expect(found).toEqual(listed);
  });
});
