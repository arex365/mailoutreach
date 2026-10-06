"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DraftWithAiButton } from "@/components/ai/draft-with-ai-button";
import { setCompanyPersonalLineAction } from "./actions";
import { PanelSection } from "./panel-ui";
import { LineEditor } from "./text-editors";
import type { PersonalLineView } from "./types";

/** "Drafting a line…" while an AI draft is being written for this company (M5-DESIGN §6.5). */
export const DRAFTING_TEXT = "Drafting a line…";
/** A READY AI draft waits on the AI lines page. */
export const WAITING_TEXT = "A drafted line is waiting for review.";

/** Where the company's AI drafting stands: nothing, being drafted, or waiting for review with a link to the queue. */
function DraftState({ state }: { state: PersonalLineView["draftState"] }) {
  if (state === "drafting") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {DRAFTING_TEXT}
      </p>
    );
  }
  if (state === "waiting") {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span>{WAITING_TEXT}</span>
        <Link href="/ai-lines" className="underline underline-offset-4 hover:no-underline">
          Open AI lines
        </Link>
      </p>
    );
  }
  return null;
}

/**
 * The company's approved personal line, where it came from, and an editor; "Draft with AI" opens the start dialog for
 * this company, and the section says when a drafted line is being written or waits for review.
 */
export function PersonalLineSection({ view }: { view: PersonalLineView }) {
  const [editing, setEditing] = useState(false);

  return (
    <PanelSection
      title="Personal line"
      id="company-panel-line"
      actions={!view.readOnly ? <DraftWithAiButton companyId={view.companyId} /> : null}
    >
      {editing ? (
        <LineEditor
          id="company-panel-line-editor"
          label="Personal line"
          value={view.line}
          hint="Used as {{personal_line}} in emails to everyone here, unless a person has their own line."
          onSave={(value) => setCompanyPersonalLineAction({ companyId: view.companyId, value })}
          onDone={() => setEditing(false)}
        />
      ) : view.line ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
          <blockquote className="text-sm break-words">“{view.line}”</blockquote>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{view.sourceText}</span>
            {!view.readOnly ? (
              <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(true)} aria-label="Edit the personal line">
                Edit
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
          <p className="text-sm text-muted-foreground">No personal line yet.</p>
          {!view.readOnly ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              Write one
            </Button>
          ) : null}
        </div>
      )}
      {!view.readOnly ? <DraftState state={view.draftState ?? null} /> : null}
    </PanelSection>
  );
}
