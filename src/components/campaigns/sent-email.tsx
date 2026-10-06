import { footerStart } from "@/core/templates/email";
import { UNSUBSCRIBE_PLACEHOLDER, UNSUBSCRIBE_PREVIEW_TEXT } from "@/core/templates/html";

/**
 * A sent (or sending) email as the person panel shows it (M3-DESIGN §5.8). The stored text is exactly what went to
 * Mailgun, so its footer still holds Mailgun's %unsubscribe_url% placeholder, which Mailgun turns into each person's own
 * link. People see "[unsubscribe link]" instead, as in every preview (PLAN A7).
 */
export function sentEmailParts(text: string): { main: string; footer: string } {
  const shown = text.split(UNSUBSCRIBE_PLACEHOLDER).join(UNSUBSCRIBE_PREVIEW_TEXT);
  const cut = footerStart(shown);
  return {
    main: cut >= 0 ? shown.slice(0, cut).trimEnd() : shown,
    footer: cut >= 0 ? shown.slice(cut) : "",
  };
}

export function SentEmail({ subject, text }: { subject: string; text: string }) {
  const { main, footer } = sentEmailParts(text);
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-background p-4">
      <div className="grid gap-0.5 border-b border-border pb-3">
        <span className="text-xs text-muted-foreground">Subject</span>
        <span className="font-medium break-words">{subject || <span className="text-muted-foreground">No subject</span>}</span>
      </div>
      <div className="text-sm leading-relaxed break-words whitespace-pre-wrap">{main || <span className="text-muted-foreground">No text was stored.</span>}</div>
      {footer ? <div className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
