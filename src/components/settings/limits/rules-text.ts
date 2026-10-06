/**
 * The words of "The 30-day rule" card on Settings › Limits & warm-up (M6-DESIGN §5.3). Pure and browser-safe; the
 * errors and save messages come from the server (`RULES_TEXT` in src/server/services/settings/rules.ts).
 */

export const RULES_CARD = {
  title: "The 30-day rule",
  description: "Who may email a company that a teammate emailed recently.",
  daysLabel: "Days a company stays with whoever emailed it",
  daysHint: "Nobody else can add the company to a campaign during these days. It's checked at launch and before every email.",
  expiryLabel: "Days a paused campaign keeps its companies",
  expiryHint: "After that, other campaigns may email those companies; whoever launched the paused campaign and the Owner are told.",
  domainsLabel: "Shared email domains",
  domainsHint:
    "Domains many unrelated companies use, like gmail.com. The app never groups companies, applies the 30-day rule or links replies by these domains.",
  domainsPlaceholder: "firma.example",
  save: "Save rules",
  saving: "Saving…",
  confirmTitle: "Save these rules?",
  confirmButton: "Save anyway",
  cancel: "Cancel",
  offline: "Couldn't reach the app, so nothing was saved. Check your connection and try again.",
} as const;

/** The rule keeps its name whatever its length (§2.7): "Now 21 days." is added when the setting isn't 30. */
export function rulesCardDescription(teamRuleDays: number): string {
  if (teamRuleDays === 30) return RULES_CARD.description;
  const days = `${teamRuleDays.toLocaleString("en-US")} ${teamRuleDays === 1 ? "day" : "days"}`;
  return `${RULES_CARD.description} Now ${days}.`;
}

/** "Built in: gmail.com, outlook.com, … (129)." for the collapsed built-in list under the domains box. */
export function builtInSummary(builtIn: readonly string[]): string {
  const known = ["gmail.com", "outlook.com"].filter((d) => builtIn.includes(d));
  const first = known.length > 0 ? known : builtIn.slice(0, 2);
  return `Built in: ${first.join(", ")}${builtIn.length > first.length ? ", …" : ""} (${builtIn.length.toLocaleString("en-US")}).`;
}
