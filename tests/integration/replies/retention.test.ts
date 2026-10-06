import { afterAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

/** Reply texts are kept for 30 days after processing (M4-DESIGN §3.2, D26); the first lines and decisions stay. */

const t = await createTestDb("replies-retention");
const { db, dbWrite } = await import("@/server/db");
const { clearOldReplyTexts, REPLY_TEXT_DAYS } = await import("@/server/services/replies");

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

const DAY = 86_400_000;
let seq = 0;

async function reply(processedDaysAgo: number | null) {
  seq += 1;
  return dbWrite((c) =>
    c.inboundMessage.create({
      data: {
        receivedAt: new Date(Date.now() - 40 * DAY),
        toAddress: "ali@send.example.com",
        fromEmail: `p${seq}@example.org`,
        subject: "Re: Hello",
        snippet: "Yes please",
        bodyText: "Yes please.\n\nOn Mon … wrote:\n> Hello",
        strippedText: "Yes please.",
        kind: processedDaysAgo === null ? null : "REPLY",
        signals: [],
        source: "NOTIFY",
        processedAt: processedDaysAgo === null ? null : new Date(Date.now() - processedDaysAgo * DAY),
      },
    }),
  );
}

describe("clearOldReplyTexts", () => {
  it("clears the texts of replies processed more than 30 days ago, in chunks, and keeps everything else", async () => {
    expect(REPLY_TEXT_DAYS).toBe(30);
    const old = await Promise.all([reply(31), reply(45), reply(60)]);
    const recent = await reply(29);
    const unprocessed = await reply(null);
    expect(await clearOldReplyTexts({ chunk: 2 })).toBe(3);
    for (const r of old) {
      expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({
        bodyText: null,
        strippedText: null,
        snippet: "Yes please",
        kind: "REPLY",
      });
    }
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: recent.id } })).toMatchObject({ strippedText: "Yes please." });
    expect(await db.inboundMessage.findUniqueOrThrow({ where: { id: unprocessed.id } })).toMatchObject({ strippedText: "Yes please." });
    expect(await clearOldReplyTexts()).toBe(0);
  });
});
