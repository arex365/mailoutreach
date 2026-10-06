"use client";

import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RenderedEmail } from "@/core/templates/types";
import { previewTemplateAction } from "@/app/(app)/templates/actions";
import { EmailPreview } from "./email-preview";
import { PersonPicker, type PreviewPersonOption } from "./person-picker";

const OFFLINE = "Couldn't reach the preview. Check your connection; it updates again when you type.";

/**
 * The template editor's live preview: pick any real contact and any active teammate as the sender,
 * and see the current tab's email (unsaved text included) exactly as it would be sent.
 */
export function TemplatePreviewPanel({
  templateId,
  step,
  subject,
  body,
  firstSubject,
  senders,
  defaultSenderId,
  defaultPerson,
}: {
  templateId: number;
  step: number;
  /** The first email's subject (step 0) — for follow-ups it becomes "Re: …". */
  subject: string;
  body: string;
  firstSubject: string;
  senders: Array<{ id: number; name: string }>;
  defaultSenderId: number | null;
  defaultPerson: PreviewPersonOption | null;
}) {
  const [person, setPerson] = useState<PreviewPersonOption | null>(defaultPerson);
  const [senderId, setSenderId] = useState<number | null>(defaultSenderId ?? senders[0]?.id ?? null);
  const [email, setEmail] = useState<RenderedEmail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    if (!person || !senderId) return;
    const rid = ++requestId.current;
    const timer = setTimeout(async () => {
      setPending(true);
      try {
        const res = await previewTemplateAction({
          templateId,
          step,
          personId: person.id,
          senderId,
          draft: { subject: step === 0 ? subject : null, body, firstSubject },
        });
        if (rid !== requestId.current) return;
        if (res.ok) {
          setEmail(res.data);
          setError(null);
        } else {
          setError(res.error);
        }
      } catch {
        if (rid === requestId.current) setError(OFFLINE);
      } finally {
        if (rid === requestId.current) setPending(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [templateId, step, subject, body, firstSubject, person, senderId]);

  return (
    <section aria-labelledby="template-preview-title" className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <div>
        <h2 id="template-preview-title" className="text-sm font-medium">
          Preview
        </h2>
        <p className="text-xs text-muted-foreground">Exactly what this contact gets, including your unsaved changes.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="template-preview-person">Contact</Label>
          <PersonPicker id="template-preview-person" value={person} onChange={setPerson} />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="template-preview-sender">Sent by</Label>
          <Select
            value={senderId ? String(senderId) : undefined}
            onValueChange={(v) => setSenderId(Number(v))}
            disabled={senders.length === 0}
          >
            <SelectTrigger id="template-preview-sender" className="w-full">
              <SelectValue placeholder="Pick a teammate" />
            </SelectTrigger>
            <SelectContent>
              {senders.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <EmailPreview
        email={person && senderId ? email : null}
        pending={pending}
        error={person && senderId ? error : null}
        emptyText={
          person
            ? "Pick a teammate to send as."
            : "No contact picked yet. Pick one above, or import contacts with an email address to preview real emails."
        }
      />
    </section>
  );
}
