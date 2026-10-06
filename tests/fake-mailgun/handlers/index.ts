import * as account from "./account";
import type { Handler } from "./context";
import * as domains from "./domains";
import { queryLogs } from "./logs";
import { sendMessage } from "./messages";
import * as routes from "./routes";
import { getStoredMessage } from "./storage";
import * as suppressions from "./suppressions";
import * as tracking from "./tracking";
import { VALIDATE_PATTERN, validate } from "./validate";
import * as webhooks from "./webhooks";
import * as x509 from "./x509";

/**
 * The fake's endpoint table, in match order (literal paths before parameters). `pattern` is also the fault key:
 * `fake.failNext("POST /v3/:d/messages", …)`. `:name(a|b)` limits a parameter to those values.
 * `auth`: "messages" accepts the API key or the sending key and answers a plain "Forbidden" on failure (as Mailgun's
 * send endpoint does); "api" accepts the API key only. `domain`: the path names a domain (":d") or a tracking host
 * (":host") that must be the fake's own domain in the requested region, else 404 "Domain not found".
 */
export type FakeRouteDef = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  pattern: string;
  handler: Handler;
  auth: "messages" | "api";
  domain?: "d" | "host";
};

const LISTS = ":list(bounces|complaints|unsubscribes)";

export const ROUTES: readonly FakeRouteDef[] = [
  { method: "POST", pattern: "/v3/:d/messages", handler: sendMessage, auth: "messages", domain: "d" },
  { method: "POST", pattern: "/v1/analytics/logs", handler: queryLogs, auth: "api" },
  // routes (account-wide) before anything with a ":d" in the same place
  { method: "GET", pattern: "/v3/routes/match", handler: routes.matchRoute, auth: "api" },
  { method: "GET", pattern: "/v3/routes", handler: routes.listRoutes, auth: "api" },
  { method: "POST", pattern: "/v3/routes", handler: routes.createRoute, auth: "api" },
  { method: "GET", pattern: "/v3/routes/:id", handler: routes.getRoute, auth: "api" },
  { method: "PUT", pattern: "/v3/routes/:id", handler: routes.updateRoute, auth: "api" },
  { method: "DELETE", pattern: "/v3/routes/:id", handler: routes.deleteRoute, auth: "api" },
  // domains
  { method: "GET", pattern: "/v3/domains/:d/webhooks", handler: webhooks.getWebhooks, auth: "api", domain: "d" },
  { method: "GET", pattern: "/v3/domains/:d/tracking", handler: tracking.getTracking, auth: "api", domain: "d" },
  {
    method: "PUT",
    pattern: "/v3/domains/:d/tracking/:which(open|click|unsubscribe)",
    handler: tracking.putTracking,
    auth: "api",
    domain: "d",
  },
  { method: "GET", pattern: "/v3/domains/:d/sending_queues", handler: domains.getSendingQueues, auth: "api", domain: "d" },
  { method: "GET", pattern: "/v3/domains/:d/messages/:key", handler: getStoredMessage, auth: "api", domain: "d" },
  { method: "POST", pattern: "/v4/domains/:d/webhooks", handler: webhooks.createWebhook, auth: "api", domain: "d" },
  { method: "PUT", pattern: "/v4/domains/:d/webhooks", handler: webhooks.updateWebhook, auth: "api", domain: "d" },
  { method: "DELETE", pattern: "/v4/domains/:d/webhooks", handler: webhooks.deleteWebhook, auth: "api", domain: "d" },
  { method: "PUT", pattern: "/v4/domains/:d/verify", handler: domains.verifyDomain, auth: "api", domain: "d" },
  { method: "GET", pattern: "/v4/domains/:d", handler: domains.getDomain, auth: "api", domain: "d" },
  { method: "PUT", pattern: "/v4/domains/:d", handler: domains.updateDomain, auth: "api", domain: "d" },
  // certificates
  { method: "GET", pattern: "/v2/x509/:host/status", handler: x509.certificateStatus, auth: "api", domain: "host" },
  { method: "POST", pattern: "/v2/x509/:host", handler: x509.startCertificate, auth: "api", domain: "host" },
  { method: "PUT", pattern: "/v2/x509/:host", handler: x509.regenerateCertificate, auth: "api", domain: "host" },
  // account
  { method: "GET", pattern: "/v5/accounts/http_signing_key", handler: account.getSigningKey, auth: "api" },
  { method: "POST", pattern: "/v5/accounts/http_signing_key", handler: account.regenerateSigningKey, auth: "api" },
  { method: "GET", pattern: "/v5/accounts/limit/custom/monthly", handler: account.getMonthlyLimit, auth: "api" },
  { method: "PUT", pattern: "/v5/accounts/limit/custom/monthly", handler: account.putMonthlyLimit, auth: "api" },
  // address validation (account-level, no domain; bulk, preview and /v3/address/* stay unrouted: 404)
  { method: "GET", pattern: VALIDATE_PATTERN, handler: validate, auth: "api" },
  { method: "POST", pattern: VALIDATE_PATTERN, handler: validate, auth: "api" },
  // suppressions
  { method: "GET", pattern: `/v3/:d/${LISTS}`, handler: suppressions.listSuppressions, auth: "api", domain: "d" },
  { method: "POST", pattern: "/v3/:d/unsubscribes", handler: suppressions.addUnsubscribes, auth: "api", domain: "d" },
  { method: "GET", pattern: `/v3/:d/${LISTS}/:address`, handler: suppressions.getSuppression, auth: "api", domain: "d" },
  { method: "DELETE", pattern: `/v3/:d/${LISTS}/:address`, handler: suppressions.deleteSuppression, auth: "api", domain: "d" },
];

/** Matches a decoded path against a pattern; returns the parameters or null. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    let g: string;
    try {
      g = decodeURIComponent(got[i]!);
    } catch {
      return null;
    }
    if (w.startsWith(":")) {
      const m = /^:([a-zA-Z]+)(?:\(([^)]*)\))?$/.exec(w);
      if (!m) return null;
      if (m[2] !== undefined && !m[2].split("|").includes(g)) return null;
      params[m[1]!] = g;
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

export function findRoute(method: string, path: string): { route: FakeRouteDef; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}
