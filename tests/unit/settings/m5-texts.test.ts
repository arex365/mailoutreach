import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_LIST_TEXTS } from "@/components/settings/sending/texts";
import { CLEARED_CHECK_FIELDS } from "@/core/verification/types";

/**
 * Texts that must match Milestone 5 (M5 review SCREENS-11, DATA-03, DATA-09): no screen says address checks are still
 * to come, the owner guide promises no "Remove" for "Invalid" do-not-email entries (only test-list addresses and reply
 * inboxes can be removed), and the developer conventions name all six check fields an email change clears.
 */

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("address checks have arrived", () => {
  it("the test-list hint on Settings › Sending & Mailgun says test campaigns don't need checks", () => {
    expect(TEST_LIST_TEXTS.hint).not.toMatch(/arrive/i);
    expect(TEST_LIST_TEXTS.hint).toContain("Until then they also count as checked, so test campaigns don't need address checks.");
  });

  it("no source file says address checks (or anything of Milestone 5) are still to come", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .filter((f) => /address checks arrive|arrives? in Milestone 5|arrive with Milestone 5/i.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });
});

describe("the owner guide on 'Invalid' do-not-email entries", () => {
  const section = (() => {
    const text = read("README.md");
    const start = text.indexOf("## Address checks");
    return text.slice(start, text.indexOf("\n## ", start + 1));
  })();

  it("promises no Remove the app doesn't have", () => {
    expect(section).not.toMatch(/removing the entry/i);
    expect(section).toContain("Settings › Deliverability offers **Remove** only for your test-list addresses and your team's reply inboxes.");
    expect(section).toContain("the new address can be checked again");
  });
});

describe("the developer conventions on an email change", () => {
  const text = read("docs/dev/CONVENTIONS.md");

  it("say all six check fields are cleared, through CLEARED_CHECK_FIELDS", () => {
    expect(Object.keys(CLEARED_CHECK_FIELDS)).toHaveLength(6);
    expect(text).not.toContain("clears `verificationStatus/Risk/At/Provider`");
    const bullet = text.slice(text.indexOf("- Person fields:"), text.indexOf("- Log every change"));
    expect(bullet).toContain("clears all six check fields");
    expect(bullet).toContain("`CLEARED_CHECK_FIELDS` from `@/core/verification/types`");
  });
});
