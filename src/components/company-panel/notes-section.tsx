"use client";

import { setCompanyNotesAction } from "./actions";
import { PanelSection } from "./panel-ui";
import { NotesEditor } from "./text-editors";

/** The company's shared notes: a textarea with Save (each save is logged with its text). */
export function NotesSection({ companyId, notes, readOnly }: { companyId: number; notes: string; readOnly: boolean }) {
  return (
    <PanelSection title="Notes" id="company-panel-notes-title">
      <NotesEditor
        key={notes}
        id="company-panel-notes"
        label="Notes about this company"
        value={notes}
        readOnly={readOnly}
        placeholder="Anything the team should know: what they make, who to ask for, what was agreed…"
        onSave={(value) => setCompanyNotesAction({ companyId, value })}
      />
    </PanelSection>
  );
}
