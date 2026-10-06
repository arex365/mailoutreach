import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/test-db";

const t = await createTestDb("activity");
const { db, dbWrite } = await import("@/server/db");
const { queryActivity, buildActivityWhere, startOfDayUtc, activityPeople } = await import("@/app/(app)/activity/activity-query");
const { parseActivityFilters } = await import("@/components/activity/activity-filters");

let arslan = 0;
let ali = 0;
let companyId = 0;
let deletedCompanyId = 0;

function filters(qs: string) {
  return parseActivityFilters(new URLSearchParams(qs));
}

beforeAll(async () => {
  arslan = (await dbWrite((c) => c.user.create({ data: { email: "arslan@example.com", name: "Arslan", role: "OWNER" } }))).id;
  ali = (await dbWrite((c) => c.user.create({ data: { email: "ali@example.com", name: "Ali", active: false } }))).id;
  companyId = (await dbWrite((c) => c.company.create({ data: { name: "Müller 3D", nameNorm: "muller 3d" } }))).id;
  deletedCompanyId = (
    await dbWrite((c) => c.company.create({ data: { name: "Gone GmbH", nameNorm: "gone", deletedAt: new Date() } }))
  ).id;
  const rows = [
    // 2020-03-01 20:00 UTC is already 2 March 01:00 in Pakistan (UTC+5).
    { at: "2020-03-01T20:00:00Z", actorId: ali, type: "company.status", summary: "Ali set status to Client", companyId },
    { at: "2020-03-02T10:00:00Z", actorId: arslan, type: "import.done", summary: "Arslan imported 37 companies" },
    { at: "2020-03-02T11:00:00Z", actorId: arslan, type: "user.invited", summary: "Arslan invited Ali (ali@example.com)" },
    { at: "2020-03-03T09:00:00Z", actorId: null, type: "email.sent", summary: "Sent first email to Anna", mode: "DRY_RUN" as const, companyId },
    { at: "2020-03-04T09:00:00Z", actorId: null, type: "backup.done", summary: "Daily backup made" },
    { at: "2020-03-05T09:00:00Z", actorId: ali, type: "person.updated", summary: "Ali changed Anna's email", companyId: deletedCompanyId },
    { at: "2020-03-06T09:00:00Z", actorId: arslan, type: "list.created", summary: "Arslan created the list Germany Q4" },
  ];
  await dbWrite((c) =>
    c.activityLog.createMany({
      data: rows.map((r) => ({ ...r, at: new Date(r.at) })),
    }),
  );
});

afterAll(async () => {
  await db.$disconnect();
  t.cleanup();
});

describe("activity query", () => {
  it("lists everything newest first with who did it and the company", async () => {
    const page = await queryActivity(filters(""), "Asia/Karachi");
    expect(page.total).toBe(7);
    expect(page.rows.map((r) => r.type)).toEqual([
      "list.created",
      "person.updated",
      "backup.done",
      "email.sent",
      "user.invited",
      "import.done",
      "company.status",
    ]);
    const sent = page.rows.find((r) => r.type === "email.sent")!;
    expect(sent.actorName).toBeNull(); // System
    expect(sent.mode).toBe("DRY_RUN");
    expect(sent.companyId).toBe(companyId);
    expect(sent.companyName).toBe("Müller 3D");
    expect(sent.companyDeleted).toBe(false);
    const onDeleted = page.rows.find((r) => r.type === "person.updated")!;
    expect(onDeleted.companyDeleted).toBe(true);
    expect(onDeleted.companyName).toBe("Gone GmbH");
    expect(page.rows.find((r) => r.type === "import.done")!.actorName).toBe("Arslan");
  });

  it("filters by person, including System", async () => {
    const aliRows = await queryActivity(filters(`person=${ali}`), "UTC");
    expect(aliRows.rows.map((r) => r.summary)).toEqual(["Ali changed Anna's email", "Ali set status to Client"]);
    const system = await queryActivity(filters("person=system"), "UTC");
    expect(system.rows.map((r) => r.type)).toEqual(["backup.done", "email.sent"]);
  });

  it("filters by kind", async () => {
    const types = async (kind: string) => (await queryActivity(filters(`kind=${kind}`), "UTC")).rows.map((r) => r.type);
    expect(await types("companies")).toEqual(["list.created", "person.updated", "company.status"]);
    expect(await types("imports")).toEqual(["import.done"]);
    expect(await types("team")).toEqual(["user.invited"]);
    expect(await types("emails")).toEqual(["email.sent"]);
    expect(await types("all")).toHaveLength(7);
    expect(await types("nonsense")).toHaveLength(7);
  });

  it("filters by dates in the viewer's own time zone", async () => {
    const inPakistan = await queryActivity(filters("from=2020-03-02&to=2020-03-02"), "Asia/Karachi");
    expect(inPakistan.rows.map((r) => r.type)).toEqual(["user.invited", "import.done", "company.status"]);
    const inUtc = await queryActivity(filters("from=2020-03-02&to=2020-03-02"), "UTC");
    expect(inUtc.rows.map((r) => r.type)).toEqual(["user.invited", "import.done"]);
    // Reversed dates are swapped; one-sided ranges work.
    expect((await queryActivity(filters("from=2020-03-05&to=2020-03-04"), "UTC")).total).toBe(2);
    expect((await queryActivity(filters("from=2020-03-05"), "UTC")).total).toBe(2);
    expect((await queryActivity(filters("to=2020-03-01"), "UTC")).total).toBe(1);
    // Combined filters.
    const combo = await queryActivity(filters(`person=${arslan}&kind=companies&from=2020-03-06`), "UTC");
    expect(combo.rows.map((r) => r.type)).toEqual(["list.created"]);
  });

  it("pages through the results", async () => {
    const p1 = await queryActivity(filters(""), "UTC", 3);
    expect(p1.pageCount).toBe(3);
    expect(p1.rows).toHaveLength(3);
    const p3 = await queryActivity(filters("page=3"), "UTC", 3);
    expect(p3.page).toBe(3);
    expect(p3.rows.map((r) => r.type)).toEqual(["company.status"]);
    const beyond = await queryActivity(filters("page=40"), "UTC", 3);
    expect(beyond.page).toBe(3);
  });

  it("builds the where clause and day boundaries", () => {
    expect(buildActivityWhere(filters(""), "UTC")).toEqual({});
    expect(startOfDayUtc("2020-03-02", "Asia/Karachi").toISOString()).toBe("2020-03-01T19:00:00.000Z");
    expect(startOfDayUtc("2020-07-01", "Europe/Berlin").toISOString()).toBe("2020-06-30T22:00:00.000Z");
    // An unknown zone falls back to UTC instead of failing the page.
    expect(startOfDayUtc("2020-03-02", "Not/AZone").toISOString()).toBe("2020-03-02T00:00:00.000Z");
  });

  it("lists everyone for the person filter, including switched-off people", async () => {
    const people = await activityPeople();
    expect(people.map((p) => [p.name, p.active])).toEqual([
      ["Ali", false],
      ["Arslan", true],
    ]);
  });
});
