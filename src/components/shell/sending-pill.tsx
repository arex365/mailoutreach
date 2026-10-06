import Link from "next/link";
import { cn } from "@/lib/utils";
import { sendingLabel, type SendingLabel } from "@/core/sending/label";
import { NOT_PAUSED } from "@/core/system-state-parse";
import { getSendingLabel, type SendingState } from "@/server/sending-state";

/**
 * The always-visible sending status label (PLAN.md A6, M3-DESIGN §4.1.5): "Dry run", "Test list
 * only", "Sending live" or "Paused: <reason>", with a tooltip that says what really goes out.
 * Grey for dry run / test list, green for live, red for paused. Never orange.
 * It links to Settings › Sending & Mailgun for the Owner; Members can't open that page, so for them
 * it's a plain label.
 *
 * A server component: it loads the full label itself (the tooltip needs the pause's fix text and the
 * active live/test campaigns). `state` (from the layout) is only used if that load fails.
 */

/** The fallback's words when the full label can't be loaded (M6-DESIGN §2.7): never a guess about what goes out. */
export const STATUS_UNAVAILABLE = {
  text: "Status unavailable",
  title: "The sending status couldn't be loaded. Refresh the page.",
} as const;

/**
 * The label from the layout's state alone, when the full label couldn't be loaded: a pause is still shown (red, with
 * its reason); every other state reads "Status unavailable" (neutral), because without the settings and campaigns the
 * app can't tell dry run, test list and live apart truthfully (M6-DESIGN §2.7, D3).
 */
export function fallbackLabel(state: SendingState): SendingLabel {
  if (state.kind === "paused") {
    return sendingLabel({
      pause: { ...NOT_PAUSED, also: [], paused: true, reason: state.reason },
      mode: "DRY_RUN",
      goLive: false,
      activeRealCampaigns: { live: 0, test: 0 },
    });
  }
  return { kind: state.kind, text: STATUS_UNAVAILABLE.text, title: STATUS_UNAVAILABLE.title, tone: "neutral" };
}

export async function SendingPill({ state, isOwner = true }: { state: SendingState; isOwner?: boolean }) {
  let label: SendingLabel;
  try {
    label = (await getSendingLabel()).label;
  } catch {
    label = fallbackLabel(state);
  }
  const tone =
    label.tone === "success"
      ? "border-success/40 bg-success/10 text-success"
      : label.tone === "danger"
        ? "border-destructive/50 bg-destructive/10 text-destructive"
        : "border-border bg-muted text-muted-foreground";
  const className = cn(
    "inline-flex h-7 max-w-[16rem] items-center gap-1.5 truncate rounded-full border px-2.5 text-xs font-medium",
    tone,
  );
  const content = (
    <>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current")} />
      <span className="truncate">{label.text}</span>
    </>
  );
  if (!isOwner) {
    return (
      <span title={label.title} className={className}>
        {content}
      </span>
    );
  }
  return (
    <Link href="/settings/sending" title={label.title} className={className}>
      {content}
    </Link>
  );
}
