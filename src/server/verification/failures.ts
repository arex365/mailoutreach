import type { VerifyFailureKind } from "./verifier";

/**
 * Our plain sentence per failed address check (the verifier's `message`, docs/dev/M5-DESIGN.md §2.2): never an
 * address and never the provider's own text, so it is safe for logs and a job's summary. The provider's text goes to
 * `detail`, scrubbed, behind "Details".
 */
export const VERIFY_FAILURE_TEXT: Readonly<Record<VerifyFailureKind, string>> = {
  rejected: "Mailgun refused to check this address.",
  "rate-limited": "Mailgun asked us to slow down.",
  transient: "Mailgun couldn't be reached or had a problem on its side.",
  auth: "Mailgun didn't accept the key.",
  payment: "Mailgun refused address checks for a billing or plan reason.",
  "not-allowed": "Mailgun won't run address checks on this account right now.",
  "business-verification": "Mailgun is holding the account until business verification is finished.",
  "not-found": "Mailgun didn't recognise the check request.",
};
