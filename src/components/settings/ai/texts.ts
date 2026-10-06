/**
 * Fixed sentences of Settings › AI (docs/dev/M5-DESIGN.md §6.9). The sentences that depend on data (the key's line, the
 * radio amounts, this month's spend) come from the server (`loadAiSettings`).
 */
export const AI_SETTINGS_PAGE = {
  title: "AI",
  description: "Claude drafts personal lines from company websites. Every line is reviewed before it's used.",
  keyTitle: "Anthropic API key",
  keyDescription: "The key the app uses to ask Claude for personal lines. It's stored encrypted and never shown again.",
  keyChecking: "Checking the key with Anthropic…",
  removeTitle: "Remove the Anthropic key?",
  removeText: "AI drafting stops until a new key is saved.",
  modelTitle: "Model",
  modelDescription: "Which Claude model drafts the lines. The estimate is for 300 companies.",
  customLabel: "Another Claude model",
  modelChecking: "Checking the model with Anthropic…",
  modelHint: "Anthropic retires older models from time to time. If drafting stops with “model not found”, pick another model here.",
  limitTitle: "Monthly limit",
  limitText: "AI drafting stops when this month's drafts have cost this much, and starts again on the 1st.",
  pricesTitle: "Prices",
  pricesNote:
    "Dollars per million tokens, used for estimates and the monthly limit. Correct on 26 Sep 2026; update them if Anthropic changes its prices.",
  readingTitle: "Website reading",
  readingText:
    "The app reads each company's homepage and one more page (such as About, Portfolio or Products) as PolygonParadiseBot. It follows each site's robots.txt (also a “Claude-User” block and a “noai” tag, because the text goes to Claude), waits between requests, never logs in and skips Instagram and other social pages.",
} as const;

/** The one-sentence descriptions of the cards whose own text sits in their forms (M6-DESIGN §5.1 R3). */
export const AI_CARD_DESCRIPTIONS = {
  limit: "The most AI drafting may cost in one month.",
  prices: "What each Claude model costs, for the app's estimates.",
  reading: "How the app reads company websites before Claude drafts a line.",
} as const;

/** "1.5" and "1,5" are both one and a half; an empty box is no number. */
export function parseAmount(v: string): number {
  const t = v.trim().replace(/^\$/, "").replace(",", ".");
  return t === "" ? Number.NaN : Number(t);
}
