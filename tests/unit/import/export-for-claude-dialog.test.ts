import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The "Export for Claude" dialog (M5-DESIGN §4.1): the instruction it shows is PLAN.md B6.13's, and when
 * copying doesn't work (the plain-http office address) the box is selected and "Press Ctrl+C" shows.
 */

const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
const copy = vi.hoisted(() => ({ result: false, calls: [] as Array<{ text: string; el: unknown }> }));
vi.mock("@/components/copy-text", () => ({
  copyText: async (text: string, el?: unknown) => {
    copy.calls.push({ text, el });
    return copy.result;
  },
}));

const { copyInstruction, downloadStepText, EXPORT_FOR_CLAUDE_COPY, ExportForClaudeSteps } = await import(
  "@/components/contacts/export-for-claude-dialog"
);

/** PLAN.md B6.13, word for word. */
const B6_13 =
  "I've attached a CSV of companies. For each row, find the best email address for contacting this company about 3D modelling work (print-ready 3D models such as figurines, creatures, busts and statues). Prefer, in this order: a named person responsible for products, design or purchasing; then the company's general address (info@, hello@, kontakt@, post@). Use only addresses published on the company's own website, its official social profiles or a business directory. Never guess or construct an address. Return a CSV with exactly these columns: company_id, company, email, contact_name, role, source_url, note. Keep company_id exactly as given. If you find two good contacts, add a second row with the same company_id. If you find nothing, leave email empty and say why in note.";

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function render(copyState: "idle" | "copied" | "manual", total = 42) {
  return decode(
    renderToStaticMarkup(
      createElement(ExportForClaudeSteps, {
        total,
        downloadHref: "/api/export/missing-emails?country=DE&list=3",
        copyState,
        onCopy: () => undefined,
      }),
    ),
  );
}

beforeEach(() => {
  toastSuccess.mockClear();
  copy.calls.length = 0;
});

describe("the dialog's steps", () => {
  it("show the instruction exactly as PLAN.md B6.13 has it, in a read-only box of 8 rows", () => {
    const html = render("idle");
    const box = /<textarea([^>]*)>([\s\S]*?)<\/textarea>/.exec(html);
    expect(box).not.toBeNull();
    expect(box![2]).toBe(B6_13);
    expect(box![1].toLowerCase()).toContain('readonly=""');
    expect(box![1]).toContain('rows="8"');
  });

  it("step 1 downloads the CSV of this view, step 3 links to Import", () => {
    const html = render("idle");
    expect(html).toContain("1. Download the list of the 42 companies in this view.");
    expect(html).toContain('href="/api/export/missing-emails?country=DE&list=3"');
    expect(html).toContain(">Download CSV<");
    expect(html).toContain("Keep the file as it is: the company_id column tells the app where each email belongs.");
    expect(html).toContain("2. Open Claude, attach the file and paste this instruction:");
    expect(html).toContain(">Copy instruction<");
    expect(html).toContain(
      "3. When Claude sends back a CSV, import it on the Import page. The app sees the company_id column and adds the people to the right companies. It never creates companies.",
    );
    expect(html).toContain('href="/import"');
    expect(html).toContain(">Open Import<");
    // One orange button: the download. Copy is outline, Open Import is ghost.
    expect(html.match(/data-variant="default"/g) ?? []).toHaveLength(1);
  });

  it("says 'the company' for one", () => {
    expect(downloadStepText(1)).toBe("1. Download the list of the company in this view.");
    expect(downloadStepText(1250)).toBe("1. Download the list of the 1,250 companies in this view.");
  });

  it("shows the select-all hint only when copying didn't work", () => {
    expect(render("idle")).not.toContain(EXPORT_FOR_CLAUDE_COPY.selectAll);
    expect(render("copied")).not.toContain(EXPORT_FOR_CLAUDE_COPY.selectAll);
    const manual = render("manual");
    expect(manual).toContain("Press Ctrl+C to copy the selected text.");
    // The box says where the hint is, for screen readers.
    const describedBy = /<textarea[^>]*aria-describedby="([^"]+)"/.exec(manual)?.[1];
    expect(describedBy).toBeTruthy();
    expect(manual).toContain(`id="${describedBy}"`);
  });
});

describe("Copy instruction", () => {
  it("on the plain-http address (copyText false): selects the box for Ctrl+C, no toast", async () => {
    copy.result = false;
    const box = { focus: vi.fn(), select: vi.fn() };
    const state = await copyInstruction(box as unknown as HTMLTextAreaElement);
    expect(state).toBe("manual");
    expect(copy.calls).toEqual([{ text: B6_13, el: box }]);
    expect(box.focus).toHaveBeenCalled();
    expect(box.select).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("when copying works: the toast 'Instruction copied.'", async () => {
    copy.result = true;
    const box = { focus: vi.fn(), select: vi.fn() };
    expect(await copyInstruction(box as unknown as HTMLTextAreaElement)).toBe("copied");
    expect(toastSuccess).toHaveBeenCalledWith("Instruction copied.");
    expect(box.select).not.toHaveBeenCalled();
  });

  it("copes without the box", async () => {
    copy.result = false;
    expect(await copyInstruction(null)).toBe("manual");
  });
});
