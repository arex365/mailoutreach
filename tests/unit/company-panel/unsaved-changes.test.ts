import { afterEach, describe, expect, it, vi } from "vitest";
import { unsavedChanges } from "@/components/company-panel/unsaved-changes";

afterEach(() => unsavedChanges.clear());

describe("unsaved changes in the company panel", () => {
  it("is dirty while any editor holds unsaved text", () => {
    expect(unsavedChanges.any()).toBe(false);
    unsavedChanges.mark("company-panel-notes", true);
    unsavedChanges.mark("person-4-notes", true);
    expect(unsavedChanges.any()).toBe(true);
    unsavedChanges.mark("company-panel-notes", false);
    expect(unsavedChanges.any()).toBe(true);
    unsavedChanges.mark("person-4-notes", false);
    expect(unsavedChanges.any()).toBe(false);
  });

  it("forgets everything after the person chose Discard", () => {
    unsavedChanges.mark("company-panel-notes", true);
    unsavedChanges.clear();
    expect(unsavedChanges.any()).toBe(false);
  });

  it("tells listeners only when something changed", () => {
    const listener = vi.fn();
    const stop = unsavedChanges.subscribe(listener);
    unsavedChanges.mark("a", true);
    unsavedChanges.mark("a", true); // no change
    unsavedChanges.mark("a", false);
    unsavedChanges.clear(); // already clean
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    unsavedChanges.mark("a", true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
