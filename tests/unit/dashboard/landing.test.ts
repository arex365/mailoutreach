import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The landing page switch (M6-DESIGN §4.5, D10): "/" and every way into the app (sign-in, first-run setup, an invite,
 * a password reset, a signed-in visit to the sign-in page) lead to the dashboard, and a Member who opens an Owner-only
 * page is sent there with `?notice=owner-only`. Runs the real pages, actions and `requireOwner` with the session,
 * the database and the credential checks stubbed; `redirect` throws like Next's.
 */

const state = vi.hoisted(() => ({
  session: null as null | { id: number; email: string; name: string; role: "OWNER" | "MEMBER"; timeZone: string; sessionId: number },
  userCount: 1,
}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super("NEXT_REDIRECT");
  }
  get digest(): string {
    return `NEXT_REDIRECT;replace;${this.url};307;`;
  }
}

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/auth/session", () => ({
  readSession: async () => state.session,
  createSession: vi.fn(async () => undefined),
  destroySession: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/login", () => ({ checkSignIn: vi.fn(async () => ({ ok: true, userId: 1 })) }));
vi.mock("@/lib/auth/password", () => ({ hashPassword: vi.fn(async () => "hash"), passwordProblem: () => null }));
vi.mock("@/lib/auth/throttle", () => ({ recordSetupFailure: vi.fn(async () => undefined), setupAttemptsBlocked: vi.fn(async () => false) }));
vi.mock("@/lib/auth/setup-code", () => ({ setupCodeMatches: () => true }));
vi.mock("@/lib/request", () => ({ cameThroughTunnel: vi.fn(async () => false), requestSourceKey: vi.fn(async () => "test-source") }));
vi.mock("@/server/env", () => ({ setupCodeHash: () => "hash-of-the-setup-code" }));
vi.mock("@/server/activity", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/server/db", () => {
  const client = {
    user: {
      count: async () => state.userCount,
      update: async () => ({ id: 1 }),
      create: async (args: { data: { name: string } }) => ({ id: 1, name: args.data.name }),
    },
  };
  return {
    db: client,
    dbWrite: async (fn: (c: typeof client) => unknown) => fn(client),
    dbTx: async (fn: (c: typeof client) => unknown) => {
      state.userCount = 0;
      return fn(client);
    },
  };
});
vi.mock("@/app/(auth)/invite/complete-link", () => ({ completeAccessLink: vi.fn(async () => ({ ok: true, data: null })) }));
vi.mock("@/app/(auth)/login/login-form", () => ({ LoginForm: () => null }));

const OWNER = { id: 1, email: "arslan@example.com", name: "Arslan", role: "OWNER" as const, timeZone: "Asia/Karachi", sessionId: 1 };
const MEMBER = { ...OWNER, id: 2, email: "ali@example.com", name: "Ali", role: "MEMBER" as const, sessionId: 2 };

/** Where `fn` redirects to (it must redirect). */
async function redirectOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof Redirect) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  state.session = null;
  state.userCount = 1;
});

describe("landing on the dashboard", () => {
  it("/ goes to the dashboard (and to sign-in when signed out)", async () => {
    const { default: Home } = await import("@/app/(app)/page");
    state.session = MEMBER;
    expect(await redirectOf(() => Home())).toBe("/dashboard");
    state.session = null;
    expect(await redirectOf(() => Home())).toBe("/login");
  });

  it("the sign-in page sends a signed-in person to the dashboard", async () => {
    const { default: LoginPage } = await import("@/app/(auth)/login/page");
    state.session = OWNER;
    expect(await redirectOf(() => LoginPage({ searchParams: Promise.resolve({}) } as never))).toBe("/dashboard");
    state.session = null;
    state.userCount = 0;
    expect(await redirectOf(() => LoginPage({ searchParams: Promise.resolve({}) } as never))).toBe("/setup");
  });

  it("signing in lands on the dashboard unless the link asked for a page of this site", async () => {
    const { loginAction } = await import("@/app/(auth)/actions");
    const creds = { email: "ali@example.com", password: "a long password" };
    expect(await redirectOf(() => loginAction(null, form({ ...creds, next: "" })))).toBe("/dashboard");
    expect(await redirectOf(() => loginAction(null, form({ ...creds, next: "/campaigns/4" })))).toBe("/campaigns/4");
    expect(await redirectOf(() => loginAction(null, form({ ...creds, next: "//evil.example/x" })))).toBe("/dashboard");
    expect(await redirectOf(() => loginAction(null, form({ ...creds, next: "https://evil.example" })))).toBe("/dashboard");
  });

  it("the first-run setup lands on the dashboard (no ?welcome=1 any more)", async () => {
    const { setupAction } = await import("@/app/(auth)/actions");
    state.userCount = 0;
    const url = await redirectOf(() =>
      setupAction(
        null,
        form({ code: "ABCD-EFGH", name: "Arslan", email: "arslan@example.com", password: "a long password", confirm: "a long password" }),
      ),
    );
    expect(url).toBe("/dashboard");
    expect(url).not.toContain("welcome");
  });

  it("accepting an invite and resetting a password land on the dashboard", async () => {
    const { acceptInviteAction } = await import("@/app/(auth)/invite/actions");
    const { resetPasswordAction } = await import("@/app/(auth)/reset/actions");
    expect(await redirectOf(() => acceptInviteAction(null, form({ token: "t", password: "p", confirm: "p" })))).toBe("/dashboard");
    expect(await redirectOf(() => resetPasswordAction(null, form({ token: "t", password: "p", confirm: "p" })))).toBe("/dashboard");
  });

  it("a Member opening an Owner-only page lands on the dashboard with the owner-only notice", async () => {
    const { requireOwner } = await import("@/lib/auth/dal");
    state.session = MEMBER;
    expect(await redirectOf(() => requireOwner())).toBe("/dashboard?notice=owner-only");
    state.session = OWNER;
    await expect(requireOwner()).resolves.toMatchObject({ id: 1, role: "OWNER" });
    state.session = null;
    expect(await redirectOf(() => requireOwner())).toBe("/login");
  });

  it("the page-not-found screen offers the dashboard", async () => {
    const { notFoundCopy } = await import("@/components/error-copy");
    expect(notFoundCopy("/nowhere").next).toEqual({ href: "/dashboard", label: "Go to the dashboard" });
  });
});
