/** Milestone 4 contract (docs/dev/M4-DESIGN.md §2.8): CampaignRecipient.holdReason, "a,b" sorted, or null. */
import type { HoldReason } from "@/core/replies/types";
export const HOLD_REASONS: readonly HoldReason[] = ["outage", "possible-reply"];
export function parseHoldReasons(v: string | null | undefined): HoldReason[] {
  const parts = new Set((v ?? "").split(",").map((s) => s.trim()));
  return HOLD_REASONS.filter((r) => parts.has(r));
}
export function formatHoldReasons(list: readonly HoldReason[]): string | null {
  const set = new Set(list);
  const out = HOLD_REASONS.filter((r) => set.has(r));
  return out.length ? out.join(",") : null;
}
export function withHoldReason(v: string | null | undefined, reason: HoldReason, on: boolean): string | null {
  const list = parseHoldReasons(v).filter((r) => r !== reason);
  return formatHoldReasons(on ? [...list, reason] : list);
}
/** The reasons that really hold a recipient: none unless state is HELD (a stale value never counts). */
export function heldReasonsOf(r: { state: string; holdReason: string | null | undefined }): HoldReason[] {
  return r.state === "HELD" ? parseHoldReasons(r.holdReason) : [];
}
/** §2.8.3: a new log gap starting inside the window whose hold was already applied needs no new hold. */
export function outageGapCovered(
  state: { heldFor: string | null; heldTo: string | null },
  gap: { from: string },
): boolean {
  if (!state.heldFor || !state.heldTo) return false;
  const f = Date.parse(gap.from), hf = Date.parse(state.heldFor), ht = Date.parse(state.heldTo);
  return Number.isFinite(f) && Number.isFinite(hf) && Number.isFinite(ht) && hf <= f && f < ht;
}
