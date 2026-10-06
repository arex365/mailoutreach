/**
 * Address checks behind one adapter (docs/dev/M5-DESIGN.md §2.2, P4): `getVerifier()` picks Mailgun (or the test
 * checker in the practice copy); the check job (P6) calls `check()` and hands every answer to `commitCheckResult`
 * (@/server/services/verification/commit), the one door that stores a check result.
 */
export {
  getVerifier,
  NO_CHECK_KEY_TEXT,
  VERIFY_FAILURE_TEXT,
  type Verifier,
  type VerifierResult,
  type VerifyFailureKind,
  type VerifyOutcome,
} from "./verifier";
export { createFakeVerifier, type FakeVerifier, type FakeVerifierFault, type FakeVerifierOptions } from "./fake-verifier";
export { createMailgunVerifier, failureKindOf, VERIFY_TIMEOUT_MS, type MailgunVerifierOptions } from "./mailgun-verifier";
