import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * One health rule's numbers for the neutral bar: problems counted now and the count at which sending pauses. `line`
 * already names "your limit" and Mailgun's. `href` points at the list of the emails that count (Settings ›
 * Deliverability's own tables); leave it out where that list isn't on the page.
 */
export type HealthMeter = { label: string; line: string; count: number; limit: number; note: string | null; href?: string | null };

/** A neutral bar (PLAN A6: bars stay neutral): how close the count is to the automatic pause. */
function Meter({ count, limit, label }: { count: number; limit: number; label: string }) {
  const pauseAt = Math.max(1, limit + 1);
  const pct = Math.min(100, Math.round((Math.max(0, count) / pauseAt) * 100));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={pauseAt}
      aria-valuenow={Math.min(count, pauseAt)}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-muted-foreground" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The two rows (bounces, complaints) and the "Counting since …" note, without any card around them. */
function HealthRows({ bounce, complaint, sinceNote }: { bounce: HealthMeter; complaint: HealthMeter; sinceNote: string | null }) {
  return (
    <div className="grid gap-5">
      {[bounce, complaint].map((m) => (
        <div key={m.label} className="grid gap-2">
          <p className="text-sm">{m.line}</p>
          <Meter count={m.count} limit={m.limit} label={m.label} />
          {m.note || m.href ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{m.note ?? ""}</span>
              {m.href ? (
                <a href={m.href} className="underline underline-offset-4 hover:text-foreground">
                  See which emails count
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      {sinceNote ? <p className="text-sm text-muted-foreground">{sinceNote}</p> : null}
    </div>
  );
}

/**
 * Settings › Deliverability › Health (§5.5): "3 of the last 200 emails bounced · sending pauses above 6 (3%) ·
 * Mailgun's own limit is 5%." and the same for complaints, with a neutral bar each, the small-sample notes and the
 * "Counting since you resumed" note. `compact` (the dashboard's Domain health tile, M6-DESIGN §4.3): the same two rows
 * and note without the card, its title and description. Numbers and strings only. Server component.
 */
export function HealthCard({
  bounce,
  complaint,
  sinceNote,
  compact = false,
}: {
  bounce: HealthMeter;
  complaint: HealthMeter;
  sinceNote: string | null;
  compact?: boolean;
}) {
  if (compact) return <HealthRows bounce={bounce} complaint={complaint} sinceNote={sinceNote} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardDescription>
          Sending pauses by itself when too many recent emails bounce or are marked as spam, before Mailgun has to step in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <HealthRows bounce={bounce} complaint={complaint} sinceNote={sinceNote} />
      </CardContent>
    </Card>
  );
}
