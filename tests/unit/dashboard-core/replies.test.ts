import { describe, expect, it } from "vitest";
import { waitingRepliesLine, type WaitingByUser } from "@/core/dashboard/replies";

/** The dashboard's "Replies waiting for an answer" line (M6-DESIGN §4.2 item 5, §4.3 "Waiting replies rule"). */

const row = (userId: number, name: string, count: number): WaitingByUser => ({ userId, name, count });

describe("waitingRepliesLine", () => {
  it("names the viewer first as You, then the others by count", () => {
    expect(waitingRepliesLine([row(2, "Ali", 1), row(1, "Arslan", 3)], 1)).toBe("Replies waiting for an answer: You 3 · Ali 1");
    // The viewer comes first even with fewer replies than someone else.
    expect(waitingRepliesLine([row(2, "Ali", 5), row(1, "Arslan", 1)], 1)).toBe("Replies waiting for an answer: You 1 · Ali 5");
  });

  it("orders the others by count (most first), then by name", () => {
    const rows = [row(3, "Sara", 2), row(4, "bo", 2), row(5, "Mira", 7), row(1, "Arslan", 1)];
    expect(waitingRepliesLine(rows, 1)).toBe("Replies waiting for an answer: You 1 · Mira 7 · bo 2 · Sara 2");
  });

  it("leaves out people with nothing waiting, the viewer too", () => {
    expect(waitingRepliesLine([row(1, "Arslan", 0), row(2, "Ali", 1)], 1)).toBe("Replies waiting for an answer: Ali 1");
    expect(waitingRepliesLine([row(2, "Ali", 2)], 1)).toBe("Replies waiting for an answer: Ali 2");
    expect(waitingRepliesLine([row(2, "Ali", 2), row(3, "Sara", 0)], 2)).toBe("Replies waiting for an answer: You 2");
  });

  it("is null when nobody has anything waiting", () => {
    expect(waitingRepliesLine([], 1)).toBeNull();
    expect(waitingRepliesLine([row(1, "Arslan", 0), row(2, "Ali", 0)], 1)).toBeNull();
    expect(waitingRepliesLine([row(1, "Arslan", Number.NaN), row(2, "Ali", -3)], 1)).toBeNull();
  });

  it("names at most 4 people, then '1 more person' / '2 more people'", () => {
    const five = [row(1, "Arslan", 3), row(2, "Ali", 5), row(3, "Sara", 4), row(4, "Mira", 2), row(5, "Bo", 1)];
    expect(waitingRepliesLine(five, 1)).toBe("Replies waiting for an answer: You 3 · Ali 5 · Sara 4 · Mira 2 · 1 more person");
    const six = [...five, row(6, "Lena", 1)];
    expect(waitingRepliesLine(six, 1)).toBe("Replies waiting for an answer: You 3 · Ali 5 · Sara 4 · Mira 2 · 2 more people");
    // A viewer with nothing waiting doesn't take a place: four others are named.
    const others = [row(2, "Ali", 5), row(3, "Sara", 4), row(4, "Mira", 2), row(5, "Bo", 1), row(6, "Lena", 1)];
    expect(waitingRepliesLine(others, 1)).toBe("Replies waiting for an answer: Ali 5 · Sara 4 · Mira 2 · Bo 1 · 1 more person");
    // Exactly four: nobody left over.
    expect(waitingRepliesLine(five.slice(0, 4), 1)).toBe("Replies waiting for an answer: You 3 · Ali 5 · Sara 4 · Mira 2");
  });

  it("writes big numbers with thousands separators and adds up rows of the same user", () => {
    expect(waitingRepliesLine([row(1, "Arslan", 1200)], 1)).toBe("Replies waiting for an answer: You 1,200");
    expect(waitingRepliesLine([row(2, "Ali", 1), row(2, "Ali", 2)], 1)).toBe("Replies waiting for an answer: Ali 3");
    expect(waitingRepliesLine([row(2, "  ", 1)], 1)).toBe("Replies waiting for an answer: Someone 1");
  });
});
