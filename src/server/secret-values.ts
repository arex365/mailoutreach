import { redactText } from "./jobs";
import { mailgunSecrets } from "./mailgun/context";
import { getSecret } from "./secrets";

/**
 * Secret values for redaction, and the one scrubber for texts that come from a provider (docs/dev/M5-DESIGN.md §0.2
 * rule 13, §5.2). Used by the job runner (every failed task's error), the address checks (Mailgun's refusal texts,
 * pause details) and the drafting job (Claude's error texts).
 */

/** How long a scrubbed provider text may be (it is shown behind "Details" only). */
export const SCRUBBED_TEXT_MAX = 300;

/** Anything shaped like an email address (also inside a longer word), and its URL-encoded form (`anna%40firma.de`). */
const ADDRESS_SHAPED = /[^\s@]{1,64}@[^\s@]{1,255}/g;
const ENCODED_ADDRESS_SHAPED = /[^\s@%]{1,64}%40[^\s@]{1,255}/gi;

/**
 * Every saved secret, plus the Basic-auth forms (base64 "api:" + key) of the Mailgun keys and the address check key:
 * what a job error must never contain. Secrets that can't be read (the encryption key changed) are skipped: they can't
 * leak through this process either.
 */
export async function allSecretValues(): Promise<string[]> {
  const out = new Set(await mailgunSecrets());
  try {
    const anthropic = await getSecret("anthropic.apiKey");
    if (anthropic) out.add(anthropic);
  } catch {
    // unreadable: skipped
  }
  return [...out];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The address as it may appear in a provider's text: as given, and URL-encoded (both encodings). */
function addressForms(address: string): string[] {
  const a = address.trim();
  if (!a) return [];
  const forms = new Set([a, encodeURIComponent(a), new URLSearchParams({ a }).toString().slice(2)]);
  return [...forms].filter((f) => f.length > 0);
}

/**
 * A provider's text made safe to store and show behind "Details" (pause `detail`, job results, draft errors, logs):
 * `redactText` with every saved secret, then `address` (as given or URL-encoded, any case) and anything shaped like an
 * email address replaced by "[address]", capped at 300 characters. Addresses are personal data (§0.2 rule 9).
 */
export async function scrubProviderText(text: string, opts: { address?: string | null } = {}): Promise<string> {
  let out = String(text ?? "");
  for (const form of addressForms(opts.address ?? "")) {
    out = out.replace(new RegExp(escapeRegExp(form), "gi"), "[address]");
  }
  out = out.replace(ADDRESS_SHAPED, "[address]").replace(ENCODED_ADDRESS_SHAPED, "[address]");
  const secrets = await allSecretValues().catch(() => [] as string[]);
  out = redactText(out, secrets).trim();
  return out.length > SCRUBBED_TEXT_MAX ? `${out.slice(0, SCRUBBED_TEXT_MAX - 1)}…` : out;
}
