/** Milestone 4 contract (docs/dev/M4-DESIGN.md §3): reply classification and processing types. */
import type { HeaderPair } from "@/core/mailgun/inbound";
export type { HeaderPair };

export type Nature = "REPLY" | "AUTO" | "BOUNCE" | "POSSIBLE";
export type Confidence = "certain" | "high" | "medium" | "low";
export type AutoReason =
  | "out-of-office" | "auto-reply" | "helpdesk-ack" | "challenge" | "left-company" | "read-receipt" | "dsn" | "delay"
  | "process-failed" | "internal" | "spam";
export type ClassifyInput = {
  subject: string;
  /** Normalised bare address. */
  fromEmail: string;
  fromName?: string | null;
  /** SMTP MAIL FROM: "" = null sender; null/undefined = unknown. */
  envelopeSender?: string | null;
  headers: readonly HeaderPair[];
  /** Mailgun stripped-text, newlines kept (absent when Mailgun's parse failed). */
  strippedText?: string | null;
  /** Mailgun body-plain, newlines kept. */
  bodyPlain?: string | null;
  /** M3's collapsed ≤ 300-character snippet (rows stored before M4). */
  snippet?: string;
  /** false: recovered from Mailgun's log only. */
  bodyAvailable?: boolean;
  /** Subjects of our sent emails in the linked thread. */
  sentSubjects?: readonly string[];
  /** A thread, from-address, known-contact or named-address link was found (M4-DESIGN §3.4 rule 3). Default false. */
  linked?: boolean;
};
export type Verdict = { nature: Nature; confidence: Confidence; autoReason: AutoReason | null; delay: boolean; signals: string[] };

export type InboundKindValue = "REPLY" | "AUTO_REPLY" | "BOUNCE_NOTICE" | "POSSIBLE_REPLY" | "UNLINKED" | "TEST_REPLY";
/** "company": linked to a company without an email (known contact without a recent email, fail-safe, by hand). */
export type LinkTarget = "email" | "company" | "test" | "none";
export type LinkMethod =
  | "headers" | "body-id" | "from" | "person" | "bounce-address" | "named-address" | "manual" | "simulated";
export type ReplyScope = "real" | "campaign" | "none";
export type AnswerOutcome = "answered" | "not-needed" | "duplicate" | "spam";
export type HoldReason = "outage" | "possible-reply";
export type SimulateReplyKind = "reply" | "out-of-office" | "unclear";
/** Kinds on the "Replies waiting for an answer" list. */
export const WAITING_KINDS: readonly InboundKindValue[] = ["REPLY", "POSSIBLE_REPLY", "UNLINKED"];
/**
 * Added to a processed row's `signals` when its own `reply.attention` notice was really created (not a quiet row's
 * grouped notice, not skipped as a repeat, not to nobody). The "once per person and reason per 30 days" rule counts only
 * rows that carry it (M4-DESIGN §5.5). Like "process-failed", it says nothing about the message being automatic.
 */
export const ATTENTION_SENT_SIGNAL = "attention-sent";
