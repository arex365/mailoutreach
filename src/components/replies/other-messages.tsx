/**
 * The Owner's "Messages we couldn't link (last 30 days)" (M4-DESIGN §5.5, §9.1): automatic replies, delivery notices and
 * messages Mailgun marked as spam that weren't linked to a company, collapsed by default. Each row: from, subject, what
 * it was, when it arrived. Plain text only; nothing here links or stops anything.
 */
export function OtherMessages({
  rows,
}: {
  rows: ReadonlyArray<{ id: number; fromEmail: string; subject: string; what: string; receivedExact: string }>;
}) {
  return (
    <details className="group rounded-xl bg-card ring-1 ring-foreground/10">
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium marker:hidden">
        Messages we couldn&apos;t link (last 30 days)
        <span className="ml-2 text-muted-foreground tabular">{rows.length.toLocaleString("en-US")}</span>
      </summary>
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">None in the last 30 days.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-0.5 px-4 py-2 text-sm">
              <span className="min-w-0 break-words">
                <span className="font-medium">{r.fromEmail}</span>
                <span className="text-muted-foreground"> · {r.subject.trim() || "(no subject)"}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {r.what} · {r.receivedExact}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
