import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SENDING_DOMAIN_TEXTS } from "@/core/sender-address";
import { INBOX_CHECK_TEXTS, OWN_MAILBOX_TEXTS, OWN_REPLY_TEST_TEXTS, THEY_REPLIED_TEXTS } from "@/core/sending/own-mailbox";

/**
 * The whole-tree guards of own-mailbox mode (MAIN-DOMAIN-DESIGN §9.1 "Whole-tree guards", §8 P9). They read the source of
 * `src/**`, `worker/**` and `scripts/**` (tests are free to do anything) and keep the one-flag, one-door rules of §0.2
 * true as the code grows:
 *  (1) Setting "mailgun.replies" is spelled only by its reader and writers (§0.2 rule 5);
 *  (2) `validateTeamFromAddress(` is called only behind the one dispatch `validateFromAddressFor` (§2.2);
 *  (3) the own-mailbox sentences never use the app-mode words, and only `repliesAppHint` names the sending subdomain;
 *  (4) every MailgunClient the context builds carries a real `ownMailboxFrom` (O6, fail closed), and no other file
 *      that builds its own client sends with it;
 *  (5) Setting "sending.maxDailyCap" is read only by the one loader and the Limits form (O23);
 *  (6) the send-only "limit" rule of `classifyStatus` is switched on only by the client's send path (O24);
 *  (7) SystemState "sending.inboxCheck" is written only by `markInboxChecked` (O33), and reset to "nobody has read it" only
 *      by a restore (`forgetInboxCheck`, review REPLIES-02);
 *  (8) the app's own List-Unsubscribe (unsubscribe by email left out, review REPLIES-03) is added only by
 *      `MailgunClient.sendMessage`, and only while the client has an own-mailbox From.
 * Only non-comment lines count: code comments may name anything. Guards (4) and (7) read each file as a whole (review
 * SECURITY-04): a call formatted over several lines, or `ownMailboxFrom: null`, must not slip past them.
 */

const ROOT = process.cwd();
const SCANNED = ["src", "worker", "scripts"] as const;

type SourceFile = { rel: string; text: string; lines: string[] };

function walk(dir: string, out: SourceFile[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "generated" && entry.name !== "node_modules") walk(full, out);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, "utf8");
    out.push({ rel: path.relative(ROOT, full).split(path.sep).join("/"), text, lines: text.split(/\r?\n/) });
  }
}

const FILES: SourceFile[] = [];
for (const top of SCANNED) walk(path.join(ROOT, top), FILES);

const isComment = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/** Files (repo-relative, "/"-separated) with a non-comment line matching `re`. */
function filesWith(re: RegExp): string[] {
  return FILES.filter((f) => f.lines.some((l) => !isComment(l) && re.test(l)))
    .map((f) => f.rel)
    .sort();
}

/** A file's text without its comment-only lines. */
const code = (f: SourceFile): string => f.lines.filter((l) => !isComment(l)).join("\n");

/** The argument text of every `name(` call in `text` (balanced parentheses; strings are not special-cased). */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${name}(`, from);
    if (at < 0) return out;
    let depth = 0;
    let i = at + name.length;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    out.push(text.slice(at + name.length + 1, i));
    from = i;
  }
}

describe("own-mailbox mode: whole-tree guards (MAIN-DOMAIN-DESIGN §9.1)", () => {
  it("scans the tree (a guard over nothing would pass for the wrong reason)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    for (const rel of ["src/server/settings.ts", "src/server/mailgun/context.ts", "src/server/mailgun/client.ts", "worker/index.ts"]) {
      expect(FILES.map((f) => f.rel)).toContain(rel);
    }
  });

  it('(1) Setting "mailgun.replies" is spelled only in settings.ts, the three mailgun services and the seeds', () => {
    const found = filesWith(/["'`]mailgun\.replies["'`]/);
    const allowed = new Set([
      "src/server/settings.ts",
      "src/server/services/mailgun/team-from.ts",
      "src/server/services/mailgun/plan.ts",
      "src/server/services/mailgun/connect.ts",
    ]);
    expect(found.filter((rel) => !allowed.has(rel) && !/^scripts\/seed-[^/]+\.ts$/.test(rel))).toEqual([]);
    // The reader and the one writer are really there.
    expect(found).toEqual(expect.arrayContaining(["src/server/services/mailgun/team-from.ts", "src/server/services/mailgun/connect.ts"]));
  });

  it("(2) validateTeamFromAddress( is called only in from-address.ts, own-mailbox.ts and team-from.ts", () => {
    expect(filesWith(/\bvalidateTeamFromAddress\(/)).toEqual([
      "src/core/sending/from-address.ts",
      "src/core/sending/own-mailbox.ts",
      "src/server/services/mailgun/team-from.ts",
    ]);
    // Every writer and the From card go through the one dispatch.
    expect(filesWith(/\bvalidateFromAddressFor\(/)).toEqual(
      expect.arrayContaining(["src/server/services/mailgun/connect.ts", "src/components/settings/sending/from-address-card.tsx"]),
    );
  });

  it("(4) every new MailgunClient( in src/server/mailgun/context.ts passes a real ownMailboxFrom", () => {
    const context = FILES.find((f) => f.rel === "src/server/mailgun/context.ts")!;
    const calls = callArgs(code(context), "new MailgunClient");
    expect(calls.length).toBeGreaterThanOrEqual(2); // the account key's client and the domain sending key's
    for (const args of calls) expect(carriesOwnMailboxFrom(args), args).toBe(true);
  });

  it("(4) the check itself: the shorthand or a value passes; null, undefined or leaving it out doesn't", () => {
    expect(carriesOwnMailboxFrom("{ apiKey, ...shared, ownMailboxFrom }")).toBe(true);
    expect(carriesOwnMailboxFrom("{ apiKey: sendingKey, ...shared, ownMailboxFrom }")).toBe(true);
    expect(carriesOwnMailboxFrom("{\n  apiKey,\n  ...shared,\n  ownMailboxFrom: ownMailboxRuleFrom(team.replies, team.ownFrom),\n}")).toBe(true);
    expect(carriesOwnMailboxFrom("{ apiKey, ownMailboxFrom: rule, ...shared }")).toBe(true);
    for (const bad of [
      "{ apiKey, ...shared }",
      "{ apiKey, ...shared, ownMailboxFrom: null }",
      "{ apiKey, ...shared, ownMailboxFrom: undefined }",
      "{ apiKey, ...shared, ownMailboxFrom:\n    null,\n}",
      "{ apiKey, ...shared, ownMailboxFrom: void 0 }",
      "{ apiKey, ownMailboxFrom, ...shared, ownMailboxFrom: null }",
      "{ apiKey, ...shared, notOwnMailboxFrom: x }",
    ]) {
      expect(carriesOwnMailboxFrom(bad), bad).toBe(false);
    }
  });

  it("(4) a file that builds its own MailgunClient (outside the context and the client) never sends with it", () => {
    const builders = FILES.filter((f) => /\bnew MailgunClient\s*\(/.test(code(f))).map((f) => f.rel);
    // The connection test, the address checks' own key: neither sends an email.
    expect(builders).toEqual(expect.arrayContaining(["src/server/mailgun/context.ts", "src/server/mailgun/client.ts"]));
    const sending = FILES.filter(
      (f) => builders.includes(f.rel) && f.rel !== "src/server/mailgun/context.ts" && f.rel !== "src/server/mailgun/client.ts" && /\.sendMessage\s*\(/.test(code(f)),
    ).map((f) => f.rel);
    expect(sending).toEqual([]);
  });

  it('(5) Setting "sending.maxDailyCap" is read only by settings.ts, the plan loader and the Limits form', () => {
    expect(filesWith(/["'`]sending\.maxDailyCap["'`]/)).toEqual([
      "src/app/(app)/settings/limits/actions.ts",
      "src/app/(app)/settings/limits/page.tsx",
      "src/server/services/mailgun/plan.ts",
      "src/server/settings.ts",
    ]);
  });

  it("(6) classifyStatus( gets its send option only from the client, and only the send call spec sets send: true", () => {
    const withOptions: string[] = [];
    for (const f of FILES) {
      if (f.rel === "src/server/mailgun/errors.ts") continue; // the definition
      for (const args of callArgs(code(f), "classifyStatus")) {
        if (/\bsend\b/.test(args)) withOptions.push(f.rel);
      }
    }
    expect([...new Set(withOptions)]).toEqual(["src/server/mailgun/client.ts"]);

    const sendTrue = FILES.flatMap((f) =>
      f.lines.flatMap((l, i) => (!isComment(l) && /\bsend:\s*true\b/.test(l) ? [{ rel: f.rel, i, lines: f.lines }] : [])),
    );
    expect(sendTrue.map((s) => s.rel)).toEqual(["src/server/mailgun/client.ts"]);
    // …inside the call spec of POST /v3/{domain}/messages.
    const spec = sendTrue[0]!;
    expect(spec.lines.slice(Math.max(0, spec.i - 8), spec.i).join("\n")).toMatch(/path: `\/v3\/\$\{enc\(domain\)\}\/messages`/);
  });

  it('(7) SystemState "sending.inboxCheck" is written only by markInboxChecked, and reset only by a restore', () => {
    // Writer calls, also when formatted over several lines (review SECURITY-04).
    const writers = FILES.filter((f) => inboxCheckWriteCalls(code(f)).length > 0)
      .map((f) => f.rel)
      .sort();
    expect(writers).toEqual([INBOX_CHECK_FILE, RESTORE_FILE]);
    // The restore's one write only ever resets it to "nobody has read it" (review REPLIES-02).
    const restoreWrites = inboxCheckWriteCalls(code(FILES.find((f) => f.rel === RESTORE_FILE)!));
    expect(restoreWrites).toHaveLength(1);
    expect(restoreWrites[0]).toMatch(/\{\s*at:\s*null,\s*byUserId:\s*null\s*\}/);
    // Nobody spells the key itself except its definition (a raw write would need it).
    expect(filesWith(/["'`]sending\.inboxCheck["'`]/)).toEqual(["src/core/system-state.ts"]);
    // No raw SystemState write names the key object, on one line or several.
    expect(FILES.filter((f) => RAW_WRITE.test(code(f))).map((f) => f.rel)).toEqual([]);
    // Everywhere else the key is only read: every use is readTyped's first argument (so a new writer, however it is
    // spelled, fails here), and nobody reaches it another way (STATE_KEYS["inboxCheck"], a destructured key).
    const otherUses = FILES.filter((f) => f.rel !== INBOX_CHECK_FILE && f.rel !== "src/core/system-state.ts").flatMap((f) =>
      keyUsesOutsideReads(code(f)).map((u) => `${f.rel}: ${u}`),
    );
    expect(otherUses).toEqual([`${RESTORE_FILE}: updateTyped(STATE_KEYS.inboxCheck`]);
    expect(filesWith(/STATE_KEYS\s*\[\s*["'`]inboxCheck["'`]\s*\]/)).toEqual([]);
    expect(FILES.filter((f) => /\{[^}]*\binboxCheck\b[^}]*\}\s*=\s*STATE_KEYS\b/.test(code(f))).map((f) => f.rel)).toEqual([]);
    // The readers are really there (a guard over nothing would pass for the wrong reason).
    expect(FILES.filter((f) => /\breadTyped\s*(?:<[^>]*>)?\(\s*STATE_KEYS\.inboxCheck\b/.test(code(f))).map((f) => f.rel)).toEqual(
      expect.arrayContaining(["src/server/services/sending/gates.ts", INBOX_CHECK_FILE]),
    );
  });

  it("(7) the checks themselves catch the forms prettier writes over several lines", () => {
    const multiLineSet = "await setState(\n  STATE_KEYS.inboxCheck,\n  { at: now.toISOString(), byUserId: 1 },\n);";
    const multiLineUpsert =
      "await tx.systemState.upsert({\n  where: { key: STATE_KEYS.inboxCheck },\n  create: { key: STATE_KEYS.inboxCheck, value: {} },\n  update: { value: {} },\n});";
    const typed = "await updateTyped<InboxCheckState>(\n  STATE_KEYS.inboxCheck,\n  parseInboxCheckState,\n  () => next,\n);";
    expect(inboxCheckWriteCalls(multiLineSet)).toHaveLength(1);
    expect(inboxCheckWriteCalls(typed)).toHaveLength(1);
    expect(RAW_WRITE.test(multiLineUpsert)).toBe(true);
    expect(RAW_WRITE.test("await db.systemState.deleteMany({\n  where: { key: { in: [STATE_KEYS.inboxCheck] } },\n});")).toBe(true);
    // Any other use of the key than a read is named.
    expect(keyUsesOutsideReads("const k = STATE_KEYS.inboxCheck;\nawait writeSomehow(k);")).toEqual(["const k = STATE_KEYS.inboxCheck"]);
    expect(keyUsesOutsideReads("const s = await readTyped(\n  STATE_KEYS.inboxCheck,\n  parseInboxCheckState,\n);")).toEqual([]);
    expect(keyUsesOutsideReads(multiLineUpsert)).toHaveLength(2);
  });

  it("(8) the app's own List-Unsubscribe is added only by MailgunClient.sendMessage (review REPLIES-03, the last resort)", () => {
    // One place builds the header, so the reply test's pasted original proves what every email carries (campaign
    // emails, "Send me a test" and the reply test all go through it). The transport, the loop and the test sends never do.
    expect(filesWith(/["'`]h:List-Unsubscribe["'`]/i)).toEqual(["src/server/mailgun/client.ts"]);
    expect(filesWith(/\bWEB_ONLY_LIST_UNSUBSCRIBE\b/)).toEqual(["src/core/sending/own-mailbox.ts", "src/server/mailgun/client.ts"]);
    // The choice is stored only by the one service, and the client asks only while it has an own-mailbox From (app mode never).
    const client = code(FILES.find((f) => f.rel === "src/server/mailgun/client.ts")!);
    const at = client.indexOf('"h:List-Unsubscribe"');
    expect(client.slice(Math.max(0, at - 600), at)).toMatch(/if \(this\.#opts\.ownMailboxFrom\) \{/);
    expect(filesWith(/\bleaveOutMailto:\s*true\b/)).toEqual(["src/server/services/reply-test.ts"]);
  });
});

/** The own-mailbox inbox check's one writer, and the restore that resets it (review REPLIES-02). */
const INBOX_CHECK_FILE = "src/server/services/sending/inbox-check.ts";
const RESTORE_FILE = "src/server/services/sending/restore.ts";

/** A raw SystemState write whose arguments name the inbox check's key, over any number of lines. */
const RAW_WRITE = /systemState\.(upsert|update|updateMany|create|createMany|delete|deleteMany)\s*\(\s*\{[\s\S]{0,400}?STATE_KEYS\.inboxCheck\b/;

/** The argument text of every typed or raw SystemState writer call whose first argument is the inbox check's key. */
function inboxCheckWriteCalls(text: string): string[] {
  const out: string[] = [];
  for (const name of ["updateTyped", "casState", "setState"]) {
    for (const args of callArgs(text.replace(new RegExp(`\\b${name}\\s*<[^>(]*>\\s*\\(`, "g"), `${name}(`), name)) {
      if (/^\s*STATE_KEYS\.inboxCheck\b/.test(args)) out.push(args);
    }
  }
  return out;
}

/**
 * Every use of `STATE_KEYS.inboxCheck` in `text` that isn't readTyped's first argument, as the text from the start of its
 * line (or its call) up to the key.
 */
function keyUsesOutsideReads(text: string): string[] {
  const out: string[] = [];
  const key = "STATE_KEYS.inboxCheck";
  for (let at = text.indexOf(key); at >= 0; at = text.indexOf(key, at + key.length)) {
    const before = text.slice(Math.max(0, at - 200), at);
    if (/\breadTyped\s*(?:<[^>]*>)?\(\s*$/.test(before)) continue;
    const call = /\b\w+\s*(?:<[^>]*>)?\(\s*$/.exec(before);
    const lead = call ? call[0].replace(/\s+$/, "") : before.slice(before.lastIndexOf("\n") + 1).trimStart();
    out.push(lead + key);
  }
  return out;
}

/**
 * Guard (4): `ownMailboxFrom` is passed (shorthand, or a value) and never as null, undefined or void 0, on one line or
 * several (review SECURITY-04).
 */
function carriesOwnMailboxFrom(args: string): boolean {
  const uses = [...args.matchAll(/(?<![\w$.])ownMailboxFrom\b\s*(:\s*([^,}]*))?/g)];
  if (uses.length === 0) return false;
  return uses.every((m) => {
    if (m[1] === undefined) return true;
    const value = (m[2] ?? "").trim();
    return value !== "" && !/^(null|undefined|void\s+0)\b/.test(value);
  });
}

describe("(3) own-mailbox sentences never use the app-mode words (MAIN-DOMAIN-DESIGN §9.1)", () => {
  const D = "polygonparadise.com";
  const FROM = `contact@${D}`;
  const APP_WORDS = /reply address|sending address|reply route/i;
  const SUBDOMAIN = `mail.${D}`;

  /** Sample arguments for every function, by object and key: each is called with every variant listed. */
  const CALLS: Record<string, Record<string, unknown[][]>> = {
    OWN_MAILBOX_TEXTS: {
      domainMisfit: [[FROM, D]],
      switchedSummary: [
        ["Arslan", D, "own-mailbox"],
        ["Arslan", D, "app"],
      ],
      hint: [["Arslan from Polygon Paradise", FROM, D]],
      missingHere: [[D]],
      misfitHere: [["contact@other.example", D]],
      goodToKnow: [[FROM, D]],
      savedOn: [[FROM]],
      savedOff: [[D]],
      clearedSummary: [["Arslan"]],
      fromMissing: [[D]],
      misfit: [["contact@other.example", D]],
      fromWrongDomain: [[D]],
      checklistLine: [
        [FROM, D],
        [null, D],
      ],
      followUpReminder: [[FROM]],
      noSendingAddress: [[FROM]],
      simulateReply: [[FROM]],
      repliesEmpty: [[FROM]],
      mailgunDomainFix: [[D]],
      putBackMx: [
        [
          [
            { priority: 20, host: "mx2.zoho.com" },
            { priority: 10, host: "mx.zoho.com" },
          ],
        ],
        [null],
        [[]],
      ],
      websiteInAppMode: [[D]],
      profileFromLine: [["Arslan from Polygon Paradise", FROM]],
      testInboxHint: [[FROM]],
      signatureHint: [[FROM]],
      switchOff: [["Ali", FROM]],
      senderStepInfo: [[FROM]],
      healthBounceNote: [[FROM]],
    },
    INBOX_CHECK_TEXTS: {
      intro: [[FROM]],
      more: [[1], [1234]],
      last: [["today at 09:12", "Arslan"]],
      button: [[FROM]],
      item: [
        [1, FROM],
        [12, FROM],
      ],
      notificationBody: [[FROM]],
      activity: [["Arslan", FROM]],
    },
    THEY_REPLIED_TEXTS: {
      confirmTitleCompany: [["Acme Studio"]],
      confirmTitlePerson: [["Anna Berg"]],
      bodyStatusChanges: [["Acme Studio"]],
      bodyStatusStays: [["Acme Studio"]],
      bodyTestOnly: [["Acme Studio"]],
      bodyPerson: [["Anna Berg"]],
      toast: [[0], [1], [3]],
      activity: [
        ["Arslan", "Acme Studio", "Anna Berg"],
        ["Arslan", "Acme Studio", null],
      ],
    },
    OWN_REPLY_TEST_TEXTS: {
      intro: [[FROM]],
      replyQuestion: [[FROM]],
      replyUnanswered: [["t.gmail@gmail.com", FROM]],
      replyFailed: [["t.gmail@gmail.com", FROM]],
      returnPathFailed: [["mailgun.example", D]],
      mailtoQuestion: [
        [`u+x@${D}`, FROM],
        ["u+x@mailgun.example", FROM],
      ],
      mailtoFailed: [
        [`u+x@${D}`, D, FROM],
        [`bounce@${D}`, D, FROM],
      ],
      reportGone: [["t.gmail@gmail.com"]],
      leaveOutActivity: [
        ["Arslan", true],
        ["Arslan", false],
      ],
      leaveOutBusy: [["“Germany Q4”, “Mailbox rehearsal”"]],
      sectionFailed: [[FROM]],
      passedRow: [[" on 22 Sep", FROM]],
      failedRow: [[FROM]],
      returnPathOwn: [[D]],
      returnPathElsewhere: [["mailgun.example", D]],
      mailtoOwn: [[`u+x@${D}`]],
    },
  };

  const OBJECTS: Record<string, Readonly<Record<string, unknown>>> = {
    OWN_MAILBOX_TEXTS,
    INBOX_CHECK_TEXTS,
    THEY_REPLIED_TEXTS,
    OWN_REPLY_TEST_TEXTS,
  };

  /** label → every string it produces (plain strings as they are, functions called with each variant). */
  function produced(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [name, texts] of Object.entries(OBJECTS)) {
      for (const [key, v] of Object.entries(texts)) {
        if (typeof v === "string") {
          out.push([`${name}.${key}`, v]);
          continue;
        }
        for (const args of CALLS[name]?.[key] ?? []) {
          const r: unknown = (v as (...a: unknown[]) => unknown)(...args);
          for (const s of Array.isArray(r) ? r : [r]) out.push([`${name}.${key}(${JSON.stringify(args)})`, String(s)]);
        }
      }
    }
    return out;
  }

  it("every function of the four objects has sample calls here (a new one is added on purpose)", () => {
    const missing: string[] = [];
    for (const [name, texts] of Object.entries(OBJECTS)) {
      for (const [key, v] of Object.entries(texts)) {
        if (typeof v === "function" && !(CALLS[name]?.[key]?.length ?? 0)) missing.push(`${name}.${key}`);
      }
    }
    expect(missing).toEqual([]);
    // …and every sample names a function that exists.
    const stale = Object.entries(CALLS).flatMap(([name, keys]) =>
      Object.keys(keys).filter((k) => typeof OBJECTS[name]?.[k] !== "function").map((k) => `${name}.${k}`),
    );
    expect(stale).toEqual([]);
  });

  it("no sentence says 'reply address', 'sending address' or 'reply route'", () => {
    const said = produced().filter(([, s]) => APP_WORDS.test(s));
    expect(said).toEqual([]);
  });

  it("only repliesAppHint names mail.polygonparadise.com", () => {
    const named = produced()
      .filter(([, s]) => s.includes(SUBDOMAIN))
      .map(([label]) => label);
    expect(named).toEqual(["OWN_MAILBOX_TEXTS.repliesAppHint"]);
  });

  it("the own-mailbox sending-domain refusals use polygonparadise.com as the example, never the subdomain", () => {
    for (const key of ["www", "emptyOwn", "invalidOwn", "sandboxOwn", "sharedOwn"] as const) {
      const s = SENDING_DOMAIN_TEXTS[key];
      expect(s, key).toContain(D);
      expect(s, key).not.toContain(SUBDOMAIN);
      expect(s, key).not.toMatch(APP_WORDS);
    }
  });
});
