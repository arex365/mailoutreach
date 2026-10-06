import { describe, expect, it } from "vitest";
import { isEmptyRenumber, renumberMap, type KeyedStep } from "@/components/campaign-wizard/message-state";
import { SAVED, SerialQueue, isNotDraftError, retryDelayMs, type SaveResult } from "@/components/campaign-wizard/save-queue";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the Message step's saves", () => {
  it("run one at a time, each starting only after the one before has finished", async () => {
    const q = new SerialQueue<string>();
    const log: string[] = [];
    const first = deferred<string>();
    const a = q.run(async () => {
      log.push("start a");
      return first.promise;
    });
    const b = q.run(async () => {
      log.push("start b");
      return "b";
    });
    const c = q.run(async () => {
      log.push("start c");
      return "c";
    });
    await tick();
    expect(log).toEqual(["start a"]);
    expect(q.busy).toBe(true);
    first.resolve("a");
    expect(await Promise.all([a, b, c])).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["start a", "start b", "start c"]);
    expect(q.busy).toBe(false);
  });

  it("keep going after a save that failed", async () => {
    const q = new SerialQueue<string>();
    const failing = q.run(async () => {
      throw new Error("offline");
    });
    const next = q.run(async () => "ok");
    await expect(failing).rejects.toThrow("offline");
    expect(await next).toBe("ok");
    await q.idle();
    expect(q.busy).toBe(false);
  });

  // The bug this guards against: a timer save and a Continue/link flush both waited for the same slow
  // save, then both sent the same follow-up renumbering, and the server moved Review edits twice.
  it("send a follow-up renumbering only once when saves pile up behind a slow one", async () => {
    const q = new SerialQueue<SaveResult>();
    let saved: KeyedStep[] = [
      { key: 1, step: 0 },
      { key: 2, step: 1 },
      { key: 3, step: 2 },
      { key: 4, step: 3 },
    ];
    // Follow-up 1 removed: follow-ups 2 and 3 move up.
    const current: KeyedStep[] = [
      { key: 1, step: 0 },
      { key: 3, step: 1 },
      { key: 4, step: 2 },
    ];
    const sent: Array<Record<number, number | null>> = [];
    const slow = deferred<void>();
    let textChanged = true;

    function saveNow(wait?: Promise<void>) {
      return q.run(async () => {
        // Everything up to the first await runs as soon as it's this save's turn.
        const renumber = renumberMap(saved, current);
        if (!textChanged && isEmptyRenumber(renumber)) return SAVED;
        textChanged = false;
        sent.push(renumber);
        await wait;
        saved = current;
        return SAVED;
      });
    }

    const timerSave = saveNow(slow.promise);
    textChanged = true; // the person keeps typing while it's slow
    const secondTimerSave = saveNow();
    const continueFlush = saveNow();
    await tick();
    slow.resolve();
    await Promise.all([timerSave, secondTimerSave, continueFlush]);
    expect(sent).toEqual([{ 1: null, 2: 1, 3: 2 }, {}]);
  });

  it("wait longer and longer between tries while the app can't be reached", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([2_000, 5_000, 10_000, 30_000, 60_000, 60_000]);
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(Number.NaN)).toBe(2_000);
  });

  it("recognise a save refused because the campaign isn't a draft any more", () => {
    expect(isNotDraftError("This campaign has already been launched, so it can't be changed here. Open the campaign page instead.")).toBe(true);
    expect(isNotDraftError("This campaign was cancelled, so it can't be changed. Start a new one instead.")).toBe(true);
    expect(isNotDraftError("This campaign is being launched right now. Wait a moment, then open the campaign page.")).toBe(true);
    expect(isNotDraftError("Your session has ended. Sign in again.")).toBe(false);
    expect(isNotDraftError("This email is too long to save.")).toBe(false);
  });
});
