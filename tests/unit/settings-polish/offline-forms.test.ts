import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Couldn't reach the app" (review SCREENS-11, M6-DESIGN §5.1 R9): a save whose request never reaches the app (no
 * connection, the office PC restarting, Cloudflare's error page) must not throw inside the transition, where React would
 * hand it to the error screen and throw away what was typed. There is no DOM here, so the components run as plain
 * functions with a tiny stand-in for useState and useTransition, and the form's own handlers are called.
 */

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  sets: [] as Array<[number, unknown]>,
  index: 0,
  transitions: [] as Promise<unknown>[],
}));

vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      const i = hooks.index++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        hooks.sets.push([i, v]);
        hooks.slots[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(hooks.slots[i]) : v;
      };
      return [hooks.slots[i], set];
    },
    useTransition: () => [false, (fn: () => unknown) => hooks.transitions.push(Promise.resolve().then(fn))],
  };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const actions = vi.hoisted(() => ({
  updateProfileAction: vi.fn(),
  saveSecondFolderAction: vi.fn(),
  clearSecondFolderAction: vi.fn(),
  inviteTeammateAction: vi.fn(),
  newInviteLinkAction: vi.fn(),
}));
vi.mock("@/app/(app)/settings/profile/actions", () => ({ updateProfileAction: actions.updateProfileAction, changePasswordAction: vi.fn() }));
vi.mock("@/app/(app)/settings/backups/actions", () => ({
  backUpNowAction: vi.fn(),
  saveSecondFolderAction: actions.saveSecondFolderAction,
  clearSecondFolderAction: actions.clearSecondFolderAction,
}));
vi.mock("@/app/(app)/settings/team/actions", () => ({
  inviteTeammateAction: actions.inviteTeammateAction,
  newInviteLinkAction: actions.newInviteLinkAction,
  resetPasswordLinkAction: vi.fn(),
  switchOffAction: vi.fn(),
  switchOnAction: vi.fn(),
  makeOwnerAction: vi.fn(),
}));

const { ProfileForm, PROFILE_OFFLINE } = await import("@/components/settings/profile-form");
const { SecondFolderForm, SECOND_FOLDER_OFFLINE } = await import("@/app/(app)/settings/backups/second-folder-form");
const { InviteForm, TeamManager, TEAM_OFFLINE } = await import("@/components/settings/team-manager");

/** Runs a component once as a function (its hooks go to `hooks`) and returns what it rendered. */
function run<P>(component: (props: P) => ReactNode, props: P): ReactElement {
  hooks.index = 0;
  return component(props) as ReactElement;
}

/** Every element in a rendered tree (without running child components). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const visit = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!isValidElement<Record<string, unknown>>(n)) return;
    out.push(n);
    visit(n.props.children as ReactNode);
  };
  visit(node);
  return out;
}

const textOf = (n: ReactNode): string =>
  Array.isArray(n) ? n.map(textOf).join("") : isValidElement<{ children?: ReactNode }>(n) ? textOf(n.props.children) : typeof n === "string" ? n : "";

async function settle() {
  await Promise.all(hooks.transitions);
  await new Promise((r) => setTimeout(r, 0));
}

const setsOf = (slot: number) => hooks.sets.filter(([i]) => i === slot).map(([, v]) => v);
const event = (currentTarget: unknown = {}) => ({ preventDefault: vi.fn(), currentTarget });

beforeEach(() => {
  hooks.slots = [];
  hooks.sets = [];
  hooks.transitions = [];
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe("My profile", () => {
  const initial = {
    name: "Ali",
    email: "ali@polygonparadise.example",
    senderDisplayName: "Ali from Polygon Paradise",
    replyInbox: "ali@gmail.example",
    signature: "",
    timeZone: "Asia/Karachi",
    senderLocalPart: "ali",
  };
  // useState order in ProfileForm: values, fieldErrors, formError.
  const VALUES = 0;
  const FORM_ERROR = 2;

  it("keeps the typed signature and says the app couldn't be reached", async () => {
    actions.updateProfileAction.mockImplementation(offline);
    // The teammate typed a long signature.
    const typed = { ...initial, signature: "Ali\nPolygon Paradise\n3D models for print, ready in a week" };
    hooks.slots[VALUES] = typed;
    const form = run(ProfileForm, { initial, zones: [{ value: "Asia/Karachi", label: "Karachi" }] });
    (form.props as { onSubmit: (e: unknown) => void }).onSubmit(event());
    await settle();
    expect(actions.updateProfileAction).toHaveBeenCalledWith(expect.objectContaining({ signature: typed.signature }));
    expect(setsOf(FORM_ERROR)).toEqual([PROFILE_OFFLINE]);
    expect(setsOf(VALUES)).toEqual([]);
    expect(hooks.slots[VALUES]).toEqual(typed);
    expect(toast.success).not.toHaveBeenCalled();
    expect(PROFILE_OFFLINE).toBe("Couldn't reach the app, so nothing was saved. Check your connection and try again.");
  });

  it("still shows the app's own answer when it could be reached", async () => {
    actions.updateProfileAction.mockResolvedValue({ ok: false, error: "Check the fields below.", fieldErrors: { replyInbox: ["Type an email address."] } });
    const form = run(ProfileForm, { initial, zones: [] });
    (form.props as { onSubmit: (e: unknown) => void }).onSubmit(event());
    await settle();
    expect(setsOf(FORM_ERROR)).toEqual(["Check the fields below."]);
    expect(setsOf(1)).toEqual([{ replyInbox: ["Type an email address."] }]);
  });
});

describe("Settings › Backups › Second folder", () => {
  // useState order in SecondFolderForm: folder, error, warning.
  const FOLDER = 0;
  const ERROR = 1;

  it("Save folder keeps the typed folder and says the app couldn't be reached", async () => {
    actions.saveSecondFolderAction.mockImplementation(offline);
    hooks.slots[FOLDER] = "E:\\Outreach backups";
    const form = run(SecondFolderForm, { value: "D:\\Backups", canEdit: true });
    (form.props as { onSubmit: (e: unknown) => void }).onSubmit(event());
    await settle();
    expect(actions.saveSecondFolderAction).toHaveBeenCalledWith({ folder: "E:\\Outreach backups" });
    expect(setsOf(ERROR)).toEqual([null, SECOND_FOLDER_OFFLINE.save]);
    expect(setsOf(FOLDER)).toEqual([]);
    expect(hooks.slots[FOLDER]).toBe("E:\\Outreach backups");
  });

  it("Stop copying says nothing changed, and the folder stays", async () => {
    actions.clearSecondFolderAction.mockImplementation(offline);
    const form = run(SecondFolderForm, { value: "D:\\Backups", canEdit: true });
    const stop = elements(form).find((e) => textOf(e.props.children as ReactNode) === "Stop copying");
    expect(stop).toBeDefined();
    (stop!.props.onClick as () => void)();
    await settle();
    expect(setsOf(ERROR)).toEqual([null, SECOND_FOLDER_OFFLINE.clear]);
    expect(setsOf(FOLDER)).toEqual([]);
    expect(hooks.slots[FOLDER]).toBe("D:\\Backups");
    expect(SECOND_FOLDER_OFFLINE.clear).toBe("Couldn't reach the app, so nothing changed. Check your connection and try again.");
  });
});

describe("Settings › Team", () => {
  it("Invite a teammate: the dialog stays with the typed name and email and says the app couldn't be reached", async () => {
    actions.inviteTeammateAction.mockImplementation(offline);
    vi.stubGlobal(
      "FormData",
      class {
        get(key: string) {
          return ({ name: "Sara", email: "sara@polygonparadise.example" } as Record<string, string>)[key] ?? null;
        }
      },
    );
    const onInvited = vi.fn();
    const tree = run(InviteForm, { onInvited });
    const form = elements(tree).find((e) => e.type === "form")!;
    (form.props.onSubmit as (e: unknown) => void)(event({}));
    await settle();
    expect(actions.inviteTeammateAction).toHaveBeenCalledWith({ name: "Sara", email: "sara@polygonparadise.example" });
    // useState order in InviteForm: fieldErrors, formError.
    expect(setsOf(1)).toEqual([TEAM_OFFLINE]);
    expect(onInvited).not.toHaveBeenCalled();
  });

  it("a row's New invite link says the app couldn't be reached instead of failing silently", async () => {
    actions.newInviteLinkAction.mockImplementation(offline);
    const row = {
      id: 2,
      name: "Sara",
      email: "sara@polygonparadise.example",
      role: "MEMBER" as const,
      status: "INVITED" as const,
      lastSignIn: null,
      lastSignInAgo: null,
      pendingLink: null,
      isYou: false,
      activeCampaigns: [],
      waitingReplies: 0,
    };
    const tree = run(TeamManager, { rows: [row] });
    const menu = elements(tree).find((e) => typeof e.props.onNewInvite === "function");
    expect(menu).toBeDefined();
    (menu!.props.onNewInvite as (r: typeof row) => void)(row);
    await settle();
    expect(actions.newInviteLinkAction).toHaveBeenCalledWith({ userId: 2 });
    expect(toast.error).toHaveBeenCalledWith(TEAM_OFFLINE);
  });
});
