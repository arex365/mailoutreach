import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ACCESS_OFF_TEXT } from "@/core/dns/checklist";
import type { TunnelState } from "@/core/system-state";
import { formatDateTime, formatTime, timeAgo } from "@/core/time/format";
import { cn } from "@/lib/utils";
import { PUBLIC_ADDRESS_SETUP_TEXT } from "./public-address-text";

/**
 * Settings › System › "Remote access" (Owner, M3-DESIGN §5.9, M6-DESIGN §2.8): is Cloudflare's tunnel connected to
 * this PC, does the public address answer, and is the app behind Cloudflare's login. Reads SystemState "tunnel.status"
 * (written by the background sender every 5 and 30 minutes, and by "Check now"). With "We don't use Cloudflare Access"
 * on, an open sign-in page is expected and says so in the same words as the Domain checklist's remote-access row.
 * Server component; the button comes in as `action`, the Access switch as `accessControl`.
 */

export type RemoteAccessTone = "ok" | "warn" | "bad" | "muted";
export type RemoteAccessLine = { tone: RemoteAccessTone; text: string };
export type RemoteAccessView = {
  /** The main line: tunnel state (or "Public address: Not set yet"). */
  status: RemoteAccessLine;
  /**
   * The public checks and the Access line (empty before the first check or without a public address; the Access line
   * only while the public address answers).
   */
  lines: RemoteAccessLine[];
  /** For "Details": connections and the cloudflared version. */
  details: string[];
};

const SETUP_GUIDE = "docs\\setup\\3-cloudflare.md";

/**
 * Access switched off on purpose (M6-DESIGN §2.8): the Domain checklist's remote-access sentence itself
 * (`ACCESS_OFF_TEXT`), so the card and the row can never say different things.
 */
export const ACCESS_OFF_LINE = ACCESS_OFF_TEXT;

function checkedAgo(at: string | null, now: Date): string {
  return at ? ` · checked ${timeAgo(at, now)}` : "";
}

/**
 * The card's wording (pure, so it can be tested without rendering). `accessOff` is Setting "remoteAccess.accessOff":
 * an open sign-in page is then expected, so instead of the "Anyone on the internet…" problem the card says Access is
 * off. A sign-in page Cloudflare does protect still reads "Only your team gets past Cloudflare's login."
 */
export function remoteAccessView(
  t: TunnelState,
  publicUrl: string | null,
  now: Date,
  timeZone: string,
  fakeMode = false,
  accessOff = false,
): RemoteAccessView {
  if (!publicUrl) {
    return {
      status: { tone: "muted", text: `Public address: Not set yet. ${PUBLIC_ADDRESS_SETUP_TEXT}` },
      lines: [],
      details: [],
    };
  }
  let status: RemoteAccessLine;
  if (fakeMode) {
    status = { tone: "muted", text: "Test setup: the public address is this PC itself, so there is no Cloudflare tunnel to check." };
  } else if (!t.checkedAt || t.state === "unknown") {
    status = { tone: "muted", text: "Not checked yet. Click Check now." };
  } else if (t.state === "connected") {
    status = { tone: "ok", text: `Remote access works${checkedAgo(t.checkedAt, now)}` };
  } else if (t.state === "degraded") {
    status = { tone: "warn", text: `Remote access works, but the connection to Cloudflare is weak${checkedAgo(t.checkedAt, now)}` };
  } else if (t.state === "down") {
    const since = t.downSince ? ` since ${now.getTime() - Date.parse(t.downSince) < 20 * 3_600_000 ? formatTime(t.downSince, timeZone) : formatDateTime(t.downSince, timeZone)}` : "";
    status = {
      tone: "bad",
      text: `Not connected${since}. Remote staff and Mailgun can't reach the app. Check that this PC is on and the Cloudflared service is running.`,
    };
  } else {
    status = {
      tone: "bad",
      text: `cloudflared isn't running on this PC. If you haven't set up remote access yet, follow ${SETUP_GUIDE}.`,
    };
  }

  const lines: RemoteAccessLine[] = [];
  if (t.versionWarning && !fakeMode) lines.push({ tone: "warn", text: t.versionWarning });
  if (t.publicCheck) {
    lines.push(
      t.publicCheck.ok
        ? { tone: "ok", text: `Public address check: ${publicUrl}/api/health answered · ${timeAgo(t.publicCheck.at, now)}` }
        : {
            tone: "bad",
            text: `Public address check: ${publicUrl}/api/health didn't answer · ${timeAgo(t.publicCheck.at, now)}. ${t.publicCheck.error ?? ""}`.trim(),
          },
    );
  }
  if (t.webhookPathCheck && !t.webhookPathCheck.ok) {
    lines.push({
      tone: "bad",
      text: "The webhook address shows Cloudflare's login page. In Cloudflare, check that the 'Outreach public endpoints' app covers api/webhooks/* (Cloudflare guide, step 6).",
    });
  }
  // The sign-in page line (either tone) only once the public address answers, as the checklist's remote-access row
  // does: while it doesn't, the sign-in check only saw Cloudflare's error page, and "Remote access works" would
  // contradict the red lines above it.
  if (t.appProtectedCheck && t.publicCheck?.ok) {
    lines.push(
      t.appProtectedCheck.ok
        ? { tone: "ok", text: "Only your team gets past Cloudflare's login." }
        : accessOff
          ? { tone: "ok", text: ACCESS_OFF_LINE }
          : {
              tone: "bad",
              text: "Anyone on the internet can reach your app's sign-in page. In Cloudflare, check the 'Outreach' application (Cloudflare guide, step 5).",
            },
    );
  }

  const details: string[] = [];
  if (t.readyConnections) details.push(`Connections to Cloudflare: ${t.readyConnections} (4 is healthy)`);
  if (t.version) details.push(`cloudflared version: ${t.version}`);
  if (t.port) details.push(`Metrics port on this PC: ${t.port}`);
  if (t.webhookPathCheck?.error) details.push(`Webhook address: ${t.webhookPathCheck.error}`);
  if (t.appProtectedCheck?.error) details.push(`Sign-in page: ${t.appProtectedCheck.error}`);
  return { status, lines, details };
}

const TONE_TEXT: Record<RemoteAccessTone, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  bad: "text-destructive",
  muted: "text-muted-foreground",
};
const TONE_DOT: Record<RemoteAccessTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  muted: "bg-muted-foreground",
};

export function RemoteAccessCard({
  tunnel,
  publicUrl,
  timeZone,
  now,
  fakeMode = false,
  accessOff = false,
  action,
  accessControl,
}: {
  tunnel: TunnelState;
  publicUrl: string | null;
  timeZone: string;
  now: Date;
  fakeMode?: boolean;
  /** Setting "remoteAccess.accessOff". */
  accessOff?: boolean;
  /** "Check now" (shown once a public address is set). */
  action?: React.ReactNode;
  /** The "We don't use Cloudflare Access" switch. */
  accessControl?: React.ReactNode;
}) {
  const view = remoteAccessView(tunnel, publicUrl, now, timeZone, fakeMode, accessOff);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Remote access</CardTitle>
        <CardDescription>
          {accessOff ? (
            "Staff away from the office and Mailgun reach the app through Cloudflare."
          ) : (
            <>
              Staff away from the office and Mailgun reach the app through Cloudflare. Only your team gets past Cloudflare&apos;s
              login; Mailgun&apos;s messages get through without it.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="flex items-start gap-2 text-sm font-medium">
          <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[view.status.tone])} />
          <span className={TONE_TEXT[view.status.tone]}>{view.status.text}</span>
        </p>
        {view.lines.length > 0 ? (
          <ul className="grid gap-1.5 text-sm">
            {view.lines.map((l) => (
              <li key={l.text} className={TONE_TEXT[l.tone]}>
                {l.text}
              </li>
            ))}
          </ul>
        ) : null}
        {view.details.length > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Details</summary>
            <ul className="mt-1 grid gap-0.5 text-muted-foreground">
              {view.details.map((d) => (
                <li key={d} className="break-all">
                  {d}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {publicUrl && action ? <div>{action}</div> : null}
        {accessControl ?? null}
      </CardContent>
    </Card>
  );
}
