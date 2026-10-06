import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("team");
const { db, dbWrite } = await import("@/server/db");
const users = await import("@/server/services/users");
const { hashPassword, verifyPassword } = await import("@/lib/auth/password");
const { sha256 } = await import("@/lib/auth/tokens");

const HOUR = 3_600_000;

let ownerId = 0;

async function createUser(data: { email: string; name: string; role?: "OWNER" | "MEMBER"; password?: string | null }) {
  const passwordHash = data.password === null ? null : await hashPassword(data.password ?? "a long enough password");
  return dbWrite((c) =>
    c.user.create({ data: { email: data.email, name: data.name, role: data.role ?? "MEMBER", passwordHash } }),
  );
}

async function addSessions(userId: number, count: number) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = await dbWrite((c) =>
      c.session.create({
        data: { userId, tokenHash: sha256(`session-${userId}-${i}-${Math.random()}`), expiresAt: new Date(Date.now() + 86_400_000) },
      }),
    );
    ids.push(s.id);
  }
  return ids;
}

async function expectTeamError(p: Promise<unknown>, pattern?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(users.TeamError);
  if (pattern) expect((err as Error).message).toMatch(pattern);
  return err as InstanceType<typeof users.TeamError>;
}

beforeAll(async () => {
  const owner = await createUser({ email: "arslan@example.com", name: "Arslan", role: "OWNER", password: "owner password 123" });
  ownerId = owner.id;
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("invites", () => {
  it("creates a Member without a password and a 72-hour single-use link", async () => {
    const now = new Date();
    const issued = await users.inviteUser(ownerId, { name: "Ali Khan", email: "  Ali.Khan@Example.COM " }, now);
    expect(issued.user.email).toBe("ali.khan@example.com");
    expect(issued.purpose).toBe("INVITE");
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(72 * HOUR);

    const user = await db.user.findUniqueOrThrow({ where: { id: issued.user.id } });
    expect(user.role).toBe("MEMBER");
    expect(user.passwordHash).toBeNull();
    expect(user.senderDisplayName).toBe("Ali from Polygon Paradise");
    expect(user.replyInbox).toBe("ali.khan@example.com");

    // Only the hash is stored.
    const links = await db.accessLink.findMany({ where: { userId: user.id } });
    expect(links).toHaveLength(1);
    expect(links[0]!.tokenHash).toBe(sha256(issued.token));
    expect(links[0]!.tokenHash).not.toContain(issued.token);

    const log = await db.activityLog.findFirst({ where: { type: "user.invited", actorId: ownerId } });
    expect(log?.summary).toBe("Arslan invited Ali Khan (ali.khan@example.com)");

    const team = await users.listTeam();
    expect(team.find((m) => m.id === user.id)?.status).toBe("INVITED");
    expect(team[0]!.role).toBe("OWNER");
  });

  it("refuses a second account with the same email, and bad details", async () => {
    const dup = await expectTeamError(users.inviteUser(ownerId, { name: "Ali again", email: "ali.khan@example.com" }), /already uses/);
    expect(dup.fieldErrors?.email?.[0]).toMatch(/already uses ali.khan@example.com/);
    const bad = await expectTeamError(users.inviteUser(ownerId, { name: "", email: "not-an-email" }));
    expect(bad.fieldErrors?.name).toBeTruthy();
    expect(bad.fieldErrors?.email).toBeTruthy();
  });

  it("only lets the Owner invite", async () => {
    const member = await createUser({ email: "mira@example.com", name: "Mira" });
    await expectTeamError(users.inviteUser(member.id, { name: "X", email: "x@example.com" }), /Only the Owner/);
  });

  it("accepts an invite once: sets the password, uses up the link, notifies the Owner", async () => {
    const issued = await users.inviteUser(ownerId, { name: "Sara", email: "sara@example.com" });
    expect(await users.findUsableAccessLink(issued.token, "RESET")).toBeNull(); // wrong purpose
    expect((await users.findUsableAccessLink(issued.token, "INVITE"))?.user.name).toBe("Sara");

    const short = await expectTeamError(
      users.acceptAccessLink({ token: issued.token, purpose: "INVITE", password: "short", confirm: "short" }),
    );
    expect(short.fieldErrors?.password?.[0]).toMatch(/at least 10/);
    const mismatch = await expectTeamError(
      users.acceptAccessLink({ token: issued.token, purpose: "INVITE", password: "a good long password", confirm: "different one!!" }),
    );
    expect(mismatch.fieldErrors?.confirm?.[0]).toMatch(/don't match/);
    // Failed attempts don't use up the link.
    expect(await users.findUsableAccessLink(issued.token, "INVITE")).not.toBeNull();

    const accepted = await users.acceptAccessLink({
      token: issued.token,
      purpose: "INVITE",
      password: "a good long password",
      confirm: "a good long password",
    });
    expect(accepted.id).toBe(issued.user.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: accepted.id } });
    expect(await verifyPassword(user.passwordHash, "a good long password")).toBe(true);
    expect(user.lastLoginAt).not.toBeNull();
    const link = await db.accessLink.findFirstOrThrow({ where: { tokenHash: sha256(issued.token) } });
    expect(link.usedAt).not.toBeNull();

    const second = await expectTeamError(
      users.acceptAccessLink({ token: issued.token, purpose: "INVITE", password: "another long password", confirm: "another long password" }),
    );
    expect(second.code).toBe("link-invalid");
    expect(second.message).toBe(users.LINK_INVALID_MESSAGE);

    expect(await db.activityLog.count({ where: { type: "user.joined", actorId: accepted.id } })).toBe(1);
    const note = await db.notification.findFirst({ where: { userId: ownerId, type: "user.joined" } });
    expect(note?.title).toBe("Sara joined the team");
    expect((await users.listTeam()).find((m) => m.id === accepted.id)?.status).toBe("ACTIVE");
  });

  it("rejects expired links and unknown tokens", async () => {
    const longAgo = new Date(Date.now() - 73 * HOUR);
    const issued = await users.inviteUser(ownerId, { name: "Late Larry", email: "larry@example.com" }, longAgo);
    const err = await expectTeamError(
      users.acceptAccessLink({ token: issued.token, purpose: "INVITE", password: "a good long password", confirm: "a good long password" }),
    );
    expect(err.code).toBe("link-invalid");
    expect(await users.findUsableAccessLink("x".repeat(43), "INVITE")).toBeNull();
    expect(await users.findUsableAccessLink("", "INVITE")).toBeNull();
    const team = await users.listTeam();
    const larry = team.find((m) => m.email === "larry@example.com");
    expect(larry?.pendingLink).toBeNull();
  });

  it("a new invite link cancels the old one", async () => {
    const first = await users.inviteUser(ownerId, { name: "Nina", email: "nina@example.com" });
    const second = await users.issueAccessLink(ownerId, first.user.id, "INVITE");
    expect(await users.findUsableAccessLink(first.token, "INVITE")).toBeNull();
    expect(await users.findUsableAccessLink(second.token, "INVITE")).not.toBeNull();
    await expectTeamError(users.issueAccessLink(ownerId, first.user.id, "RESET"), /hasn't accepted their invite/);
  });
});

describe("password reset links", () => {
  it("expire in 24 hours, sign the person out everywhere and clear failed sign-ins", async () => {
    const tom = await createUser({ email: "tom@example.com", name: "Tom", password: "tom's old password" });
    await addSessions(tom.id, 2);
    await dbWrite((c) =>
      c.loginAttempt.createMany({
        data: [
          { emailNorm: "tom@example.com", sourceKey: "lan:1", success: false },
          { emailNorm: "tom@example.com", sourceKey: "lan:1", success: false },
          { emailNorm: "tom@example.com", sourceKey: "lan:1", success: true },
        ],
      }),
    );
    await expectTeamError(users.issueAccessLink(ownerId, tom.id, "INVITE"), /already chosen a password/);

    const now = new Date();
    const issued = await users.issueAccessLink(ownerId, tom.id, "RESET", now);
    expect(issued.expiresAt.getTime() - now.getTime()).toBe(24 * HOUR);
    expect(await users.findUsableAccessLink(issued.token, "INVITE")).toBeNull();

    await users.acceptAccessLink({ token: issued.token, purpose: "RESET", password: "tom's new password", confirm: "tom's new password" });
    const after = await db.user.findUniqueOrThrow({ where: { id: tom.id } });
    expect(await verifyPassword(after.passwordHash, "tom's new password")).toBe(true);
    expect(await verifyPassword(after.passwordHash, "tom's old password")).toBe(false);
    expect(await db.session.count({ where: { userId: tom.id } })).toBe(0);
    expect(await db.loginAttempt.count({ where: { emailNorm: "tom@example.com", success: false } })).toBe(0);
    expect(await db.loginAttempt.count({ where: { emailNorm: "tom@example.com", success: true } })).toBe(1);
    expect(await db.activityLog.count({ where: { type: "user.passwordReset" } })).toBe(2); // link made + password chosen
    const reused = await expectTeamError(
      users.acceptAccessLink({ token: issued.token, purpose: "RESET", password: "yet another password", confirm: "yet another password" }),
    );
    expect(reused.code).toBe("link-invalid");
  });

  it("changing your own password keeps this session and ends the others", async () => {
    const eve = await createUser({ email: "eve@example.com", name: "Eve", password: "eve's first password" });
    const [keep, other] = await addSessions(eve.id, 2);
    const wrong = await expectTeamError(
      users.changeOwnPassword(eve.id, { current: "nope", password: "eve's second password", confirm: "eve's second password" }, keep!),
    );
    expect(wrong.code).toBe("wrong-password");
    expect(wrong.fieldErrors?.current).toBeTruthy();
    const same = await expectTeamError(
      users.changeOwnPassword(eve.id, { current: "eve's first password", password: "eve's first password", confirm: "eve's first password" }, keep!),
    );
    expect(same.fieldErrors?.password?.[0]).toMatch(/different/);

    await users.changeOwnPassword(eve.id, { current: "eve's first password", password: "eve's second password", confirm: "eve's second password" }, keep!);
    const sessions = await db.session.findMany({ where: { userId: eve.id } });
    expect(sessions.map((s) => s.id)).toEqual([keep]);
    expect(sessions.map((s) => s.id)).not.toContain(other);
    const after = await db.user.findUniqueOrThrow({ where: { id: eve.id } });
    expect(await verifyPassword(after.passwordHash, "eve's second password")).toBe(true);
  });
});

describe("switching accounts off and on", () => {
  it("signs the person out everywhere, revokes their links and keeps their history", async () => {
    const zed = await createUser({ email: "zed@example.com", name: "Zed", password: "zed's password 1" });
    await addSessions(zed.id, 3);
    const link = await users.issueAccessLink(ownerId, zed.id, "RESET");
    await dbWrite((c) => c.activityLog.create({ data: { actorId: zed.id, type: "company.notes", summary: "Zed wrote a note" } }));

    await users.deactivateUser(ownerId, zed.id);
    const after = await db.user.findUniqueOrThrow({ where: { id: zed.id } });
    expect(after.active).toBe(false);
    expect(await db.session.count({ where: { userId: zed.id } })).toBe(0);
    expect(await users.findUsableAccessLink(link.token, "RESET")).toBeNull();
    const stored = await db.accessLink.findFirstOrThrow({ where: { tokenHash: sha256(link.token) } });
    expect(stored.revokedAt).not.toBeNull();
    expect(await db.activityLog.count({ where: { actorId: zed.id } })).toBeGreaterThan(0);
    expect(await db.activityLog.count({ where: { type: "user.deactivated" } })).toBe(1);
    expect((await users.listTeam()).find((m) => m.id === zed.id)?.status).toBe("OFF");

    await expectTeamError(users.deactivateUser(ownerId, zed.id), /already switched off/);
    await expectTeamError(users.issueAccessLink(ownerId, zed.id, "RESET"), /switched off/);
    await expectTeamError(users.transferOwnership(ownerId, zed.id), /switched off/);
    // A switched-off person's email is still taken.
    await expectTeamError(users.inviteUser(ownerId, { name: "Zed 2", email: "zed@example.com" }), /switched off/);

    await users.reactivateUser(ownerId, zed.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: zed.id } })).active).toBe(true);
    const note = await db.notification.findFirst({ where: { userId: zed.id, type: "user.reactivated" } });
    expect(note?.title).toBe("Your account is switched back on");
    await expectTeamError(users.reactivateUser(ownerId, zed.id), /already switched on/);
  });

  it("never switches off yourself or the Owner", async () => {
    await expectTeamError(users.deactivateUser(ownerId, ownerId), /can't switch yourself off/);
    const member = await createUser({ email: "max@example.com", name: "Max" });
    await expectTeamError(users.deactivateUser(member.id, ownerId), /Only the Owner/);
    expect(await db.user.count({ where: { role: "OWNER", active: true } })).toBe(1);
  });
});

describe("ownership", () => {
  it("moves to another active teammate and there is always exactly one Owner", async () => {
    const invited = await users.inviteUser(ownerId, { name: "Pending Pat", email: "pat@example.com" });
    await expectTeamError(users.transferOwnership(ownerId, invited.user.id), /hasn't accepted/);
    await expectTeamError(users.transferOwnership(ownerId, ownerId), /already the Owner/);

    const lena = await createUser({ email: "lena@example.com", name: "Lena", password: "lena's password 1" });
    await expectTeamError(users.transferOwnership(lena.id, lena.id), /Only the Owner/);

    await users.transferOwnership(ownerId, lena.id);
    const owners = await db.user.findMany({ where: { role: "OWNER" } });
    expect(owners.map((o) => o.id)).toEqual([lena.id]);
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).role).toBe("MEMBER");
    const note = await db.notification.findFirst({ where: { userId: lena.id, type: "user.ownershipTransferred" } });
    expect(note?.title).toBe("You're now the Owner");
    expect(await db.activityLog.count({ where: { type: "user.ownershipTransferred" } })).toBe(1);

    // The old Owner is a Member now: Owner-only actions are refused.
    await expectTeamError(users.inviteUser(ownerId, { name: "Q", email: "q@example.com" }), /Only the Owner/);
    // The new Owner can't be switched off by anyone, including herself.
    await expectTeamError(users.deactivateUser(lena.id, lena.id), /can't switch yourself off/);

    await users.transferOwnership(lena.id, ownerId);
    expect(await db.user.count({ where: { role: "OWNER" } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).role).toBe("OWNER");
  });

  it("cancels the new Owner's open reset link, so the old Owner can't use it to take the account back (SECURITY-7)", async () => {
    const bea = await createUser({ email: "bea@example.com", name: "Bea", password: "bea's password 12" });
    const link = await users.issueAccessLink(ownerId, bea.id, "RESET");
    expect(await users.findUsableAccessLink(link.token, "RESET")).not.toBeNull();

    await users.transferOwnership(ownerId, bea.id);
    expect(await users.findUsableAccessLink(link.token, "RESET")).toBeNull();
    const stored = await db.accessLink.findFirstOrThrow({ where: { tokenHash: sha256(link.token) } });
    expect(stored.revokedAt).not.toBeNull();
    const err = await expectTeamError(
      users.acceptAccessLink({ token: link.token, purpose: "RESET", password: "taken over password", confirm: "taken over password" }),
    );
    expect(err.code).toBe("link-invalid");
    const after = await db.user.findUniqueOrThrow({ where: { id: bea.id } });
    expect(await verifyPassword(after.passwordHash, "bea's password 12")).toBe(true);
    const log = await db.activityLog.findFirstOrThrow({ where: { type: "user.ownershipTransferred" }, orderBy: { id: "desc" } });
    expect(log.summary).toBe("Arslan made Bea the Owner; Bea's unused link was cancelled");
    expect(log.data).toMatchObject({ fromUserId: ownerId, toUserId: bea.id, revokedLinks: 1 });

    await users.transferOwnership(bea.id, ownerId);
    const back = await db.activityLog.findFirstOrThrow({ where: { type: "user.ownershipTransferred" }, orderBy: { id: "desc" } });
    expect(back.summary).toBe("Bea made Arslan the Owner");
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).role).toBe("OWNER");
  });
});

describe("profile and preferences", () => {
  it("validates and saves the profile, and tells the Owner when a reply inbox changes", async () => {
    const kim = await createUser({ email: "kim@example.com", name: "Kim" });
    const bad = await expectTeamError(
      users.updateProfile(kim.id, { name: "", senderDisplayName: "Kim <x>", replyInbox: "nope", signature: "", timeZone: "Mars/Olympus" }),
    );
    expect(bad.fieldErrors?.name).toBeTruthy();
    expect(bad.fieldErrors?.senderDisplayName).toBeTruthy();
    expect(bad.fieldErrors?.replyInbox).toBeTruthy();
    expect(bad.fieldErrors?.timeZone).toBeTruthy();

    const res = await users.updateProfile(kim.id, {
      name: "Kim Berg",
      senderDisplayName: "Kim from Polygon Paradise",
      replyInbox: "kim.berg@gmail.com",
      signature: "Kim Berg\r\nPolygon Paradise\n\n",
      timeZone: "Europe/Oslo",
    });
    expect(res.changed.sort()).toEqual(["name", "replyInbox", "senderDisplayName", "signature", "timeZone"].sort());
    const saved = await db.user.findUniqueOrThrow({ where: { id: kim.id } });
    expect(saved.signature).toBe("Kim Berg\nPolygon Paradise");
    expect(saved.timeZone).toBe("Europe/Oslo");
    expect(await db.activityLog.count({ where: { type: "user.profile", actorId: kim.id } })).toBe(1);
    const note = await db.notification.findFirst({ where: { type: "user.replyInbox" } });
    expect(note?.userId).toBe(ownerId);
    expect(note?.body).toContain("kim.berg@gmail.com");

    const again = await users.updateProfile(kim.id, {
      name: "Kim Berg",
      senderDisplayName: "Kim from Polygon Paradise",
      replyInbox: "kim.berg@gmail.com",
      signature: "Kim Berg\nPolygon Paradise",
      timeZone: "Europe/Oslo",
    });
    expect(again.changed).toEqual([]);
    expect(await db.activityLog.count({ where: { type: "user.profile", actorId: kim.id } })).toBe(1);
  });

  it("stores desktop pop-up preferences without losing other keys", async () => {
    const pia = await createUser({ email: "pia@example.com", name: "Pia" });
    // Milestone 4: pop-up groups (replies by default) next to the M1–M3 switch.
    expect(await users.getNotifyPrefs(pia.id)).toEqual({ popupGroups: ["reply"], desktopReplies: false });
    await dbWrite((c) => c.user.update({ where: { id: pia.id }, data: { notifyPrefs: { somethingElse: 1 } } }));
    expect(await users.setNotifyPrefs(pia.id, { desktopReplies: true })).toEqual({ popupGroups: ["reply"], desktopReplies: true });
    const stored = await db.user.findUniqueOrThrow({ where: { id: pia.id } });
    expect(stored.notifyPrefs).toEqual({ somethingElse: 1, desktopReplies: true });
    expect(users.readNotifyPrefs(null)).toEqual({ popupGroups: ["reply"], desktopReplies: false });
    expect(users.readNotifyPrefs(["x"])).toEqual({ popupGroups: ["reply"], desktopReplies: false });
  });
});

describe("link throttling", () => {
  it("blocks a source after 10 bad links in 15 minutes", async () => {
    for (let i = 0; i < 9; i++) await users.recordLinkFailure("lan:10.0.0.9");
    expect(await users.linkAttemptsBlocked("lan:10.0.0.9")).toBe(false);
    await users.recordLinkFailure("lan:10.0.0.9");
    expect(await users.linkAttemptsBlocked("lan:10.0.0.9")).toBe(true);
    expect(await users.linkAttemptsBlocked("lan:10.0.0.10")).toBe(false);
    expect(await users.linkAttemptsBlocked("lan:10.0.0.9", new Date(Date.now() + 16 * 60_000))).toBe(false);
  });

  it("never blocks everyone: failures from many sources don't add up (SECURITY-6)", async () => {
    for (let i = 0; i < 120; i++) await users.recordLinkFailure(`lan:10.1.${Math.floor(i / 250)}.${i % 250}`);
    expect(await users.linkAttemptsBlocked("lan:192.168.1.10")).toBe(false);
  });

  it("a usable link always works, even from a blocked source; only broken links count (SECURITY-6)", async () => {
    const blocked = "lan:10.0.0.77";
    for (let i = 0; i < 10; i++) await users.recordLinkFailure(blocked);
    expect(await users.linkAttemptsBlocked(blocked)).toBe(true);

    const issued = await users.inviteUser(ownerId, { name: "Vic", email: "vic@example.com" });
    const joined = await users.acceptAccessLinkFrom(blocked, {
      token: issued.token,
      purpose: "INVITE",
      password: "vic's good password",
      confirm: "vic's good password",
    });
    expect(joined.id).toBe(issued.user.id);

    // A broken link from the blocked source: told to wait, nothing more stored.
    const before = await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY, sourceKey: blocked } });
    const wait = await expectTeamError(
      users.acceptAccessLinkFrom(blocked, { token: "y".repeat(43), purpose: "INVITE", password: "a good long password", confirm: "a good long password" }),
    );
    expect(wait.message).toBe(users.LINK_THROTTLED_MESSAGE);
    expect(await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY, sourceKey: blocked } })).toBe(before);

    // A broken link from elsewhere: the usual message, and one failure recorded for that source.
    const other = await expectTeamError(
      users.acceptAccessLinkFrom("lan:10.0.0.78", { token: "y".repeat(43), purpose: "RESET", password: "a good long password", confirm: "a good long password" }),
    );
    expect(other.message).toBe(users.LINK_INVALID_MESSAGE);
    expect(await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY, sourceKey: "lan:10.0.0.78" } })).toBe(1);
    // Password problems with a good link aren't link failures.
    const next = await users.issueAccessLink(ownerId, issued.user.id, "RESET");
    const short = await expectTeamError(
      users.acceptAccessLinkFrom("lan:10.0.0.79", { token: next.token, purpose: "RESET", password: "short", confirm: "short" }),
    );
    expect(short.fieldErrors?.password).toBeTruthy();
    expect(await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY, sourceKey: "lan:10.0.0.79" } })).toBe(0);
  });

  it("stops storing link failures above the cap, so the table can't be flooded", async () => {
    await dbWrite((c) =>
      c.loginAttempt.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({ emailNorm: users.LINK_THROTTLE_KEY, sourceKey: `lan:flood-${i}`, success: false })),
      }),
    );
    const before = await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY } });
    await users.recordLinkFailure("lan:10.0.0.80");
    expect(await db.loginAttempt.count({ where: { emailNorm: users.LINK_THROTTLE_KEY } })).toBe(before);
    // The limit is still per source, so nobody else is blocked by the flood.
    expect(await users.linkAttemptsBlocked("lan:10.0.0.80")).toBe(false);
  });
});

describe("link addresses", () => {
  it("uses the public address when set, plus the office address from the Host header", () => {
    const both = users.buildAccessLinkUrls({
      purpose: "INVITE",
      token: "abc_DEF-123",
      publicUrl: "https://outreach.example.com/",
      requestHost: "192.168.1.20:3000",
    });
    expect(both.primary).toEqual({ kind: "public", url: "https://outreach.example.com/invite/abc_DEF-123" });
    expect(both.office).toBe("http://192.168.1.20:3000/invite/abc_DEF-123");
    expect(both.officeIsLocalOnly).toBe(false);

    const viaTunnel = users.buildAccessLinkUrls({
      purpose: "RESET",
      token: "t",
      publicUrl: "https://outreach.example.com",
      requestHost: "outreach.example.com",
    });
    expect(viaTunnel.primary.url).toBe("https://outreach.example.com/reset/t");
    expect(viaTunnel.office).toBeNull();

    const lanOnly = users.buildAccessLinkUrls({ purpose: "INVITE", token: "t", publicUrl: null, requestHost: "192.168.1.20:3000" });
    expect(lanOnly.primary).toEqual({ kind: "office", url: "http://192.168.1.20:3000/invite/t" });
    expect(lanOnly.office).toBeNull();

    const local = users.buildAccessLinkUrls({ purpose: "INVITE", token: "t", publicUrl: null, requestHost: "localhost:3000" });
    expect(local.officeIsLocalOnly).toBe(true);

    const junk = users.buildAccessLinkUrls({ purpose: "INVITE", token: "t", publicUrl: null, requestHost: "evil.com/<script>" });
    expect(junk.primary.url).toBe("http://localhost:3000/invite/t");
  });

  it("accepts only plain host names in the Host header", () => {
    expect(users.cleanRequestHost("192.168.1.20:3000")).toBe("192.168.1.20:3000");
    expect(users.cleanRequestHost("Outreach.Example.com, proxy")).toBe("outreach.example.com");
    expect(users.cleanRequestHost("[::1]:3000")).toBe("[::1]:3000");
    expect(users.cleanRequestHost("bad host")).toBeNull();
    expect(users.cleanRequestHost("a@b")).toBeNull();
    expect(users.cleanRequestHost(null)).toBeNull();
    expect(users.isLocalOnlyHost("127.0.0.1:3000")).toBe(true);
    expect(users.isLocalOnlyHost("192.168.0.5:3000")).toBe(false);
  });

  it("suggests a sender name and reads member status", () => {
    expect(users.suggestedSenderName("Ali Khan")).toBe("Ali from Polygon Paradise");
    expect(users.memberStatus({ active: true, passwordHash: null })).toBe("INVITED");
    expect(users.memberStatus({ active: true, passwordHash: "x" })).toBe("ACTIVE");
    expect(users.memberStatus({ active: false, passwordHash: "x" })).toBe("OFF");
  });
});
