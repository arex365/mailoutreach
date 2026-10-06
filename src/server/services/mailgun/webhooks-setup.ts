import { redactText } from "../../jobs";
import type { MailgunContext } from "../../mailgun/context";
import { isMailgunError, plainMailgunError } from "../../mailgun/errors";
import type { WebhookMap, WebhookType } from "../../mailgun/types";

/**
 * Registers the app's event webhook with Mailgun (M3-DESIGN §4.5.3, research §4.5). One URL
 * (`<APP_PUBLIC_URL>/api/webhooks/mailgun/events`) for exactly the five event types the app uses. Mailgun has no v4 GET,
 * so the current state is read through v3; POST creates, PUT replaces a URL's types, DELETE removes a URL.
 */

/** The events the app needs: deliveries, both kinds of failure, complaints and unsubscribes (never opens or clicks). */
export const WEBHOOK_TYPES: readonly WebhookType[] = ["delivered", "permanent_fail", "temporary_fail", "complained", "unsubscribed"];

export const WEBHOOKS_OK_TEXT = "Mailgun tells the app about deliveries, bounces, complaints and unsubscribes.";
export const WEBHOOKS_NOT_KEPT_TEXT =
  "Mailgun didn't keep the app's webhooks. Click Apply recommended settings again; if it keeps happening, check Send › Webhooks in Mailgun.";

/** "Mailgun can't find outreach.example.com yet. Finish the Cloudflare guide so the public address works, then try again." */
export function webhookHostNotFoundText(host: string): string {
  return `Mailgun can't find ${host} yet. Finish the Cloudflare guide so the public address works, then try again.`;
}

function typesWith(map: WebhookMap, url: string): WebhookType[] {
  return (Object.keys(map) as WebhookType[]).filter((t) => (map[t] ?? []).includes(url));
}

function sameSet(a: readonly WebhookType[], b: readonly WebhookType[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

function pathOf(u: string): string | null {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Makes Mailgun send the five event types to `url`, and only there:
 *  1. read the webhooks (v3);
 *  2. remove the app's old URLs (same path on another host, e.g. before the public address changed);
 *  3. none of the types list `url` → POST (a 400 "already exists" → PUT); a different set → PUT (a 404 → POST);
 *  4. read back and compare.
 * Never throws: `ok: false` comes with the plain sentence for the checklist and the technical text in `detail`.
 */
export async function registerWebhooks(ctx: MailgunContext, url: string): Promise<{ ok: boolean; text: string; detail: string | null }> {
  const client = ctx.client;
  const domain = ctx.domain;
  const wanted = [...WEBHOOK_TYPES];
  try {
    let map = await client.getWebhooks(domain);

    const ourPath = pathOf(url);
    const old = new Set<string>();
    for (const urls of Object.values(map)) {
      for (const u of urls ?? []) if (u !== url && ourPath !== null && pathOf(u) === ourPath) old.add(u);
    }
    for (const u of old) map = await client.deleteWebhook(domain, u);

    const ours = typesWith(map, url);
    if (ours.length === 0) {
      try {
        await client.createWebhook(domain, url, wanted);
      } catch (err) {
        if (!(isMailgunError(err) && err.status === 400 && /already exists/i.test(err.mailgunMessage))) throw err;
        await client.updateWebhook(domain, url, wanted);
      }
    } else if (!sameSet(ours, wanted)) {
      try {
        await client.updateWebhook(domain, url, wanted);
      } catch (err) {
        if (!(isMailgunError(err) && err.status === 404)) throw err;
        await client.createWebhook(domain, url, wanted);
      }
    }

    const after = typesWith(await client.getWebhooks(domain), url);
    if (wanted.every((t) => after.includes(t))) {
      return { ok: true, text: WEBHOOKS_OK_TEXT, detail: old.size ? `Removed the old address${old.size === 1 ? "" : "es"}: ${[...old].join(", ")}` : null };
    }
    return { ok: false, text: WEBHOOKS_NOT_KEPT_TEXT, detail: `Mailgun lists ${url} for: ${after.join(", ") || "nothing"}.` };
  } catch (err) {
    if (isMailgunError(err)) {
      if (err.status === 400 && /host not found|no such host|not resolve/i.test(err.mailgunMessage)) {
        let host = url;
        try {
          host = new URL(url).host;
        } catch {
          /* keep the whole URL */
        }
        return { ok: false, text: webhookHostNotFoundText(host), detail: err.message };
      }
      return { ok: false, text: plainMailgunError(err, { domain, region: ctx.region }), detail: err.message };
    }
    return {
      ok: false,
      text: "Something unexpected went wrong while setting up the webhooks. Try again.",
      detail: redactText(err instanceof Error ? err.message : String(err)),
    };
  }
}
