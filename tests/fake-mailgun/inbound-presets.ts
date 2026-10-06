import { bareAddress, stripBrackets } from "./handlers/context";
import type { ReceiveInput } from "./server";
import type { FakeMessage } from "./state";

/**
 * Ready-made answers to one of the fake's own sent messages (M4-DESIGN §7.3), for the admin `POST /__fake/inbound`
 * (`{"preset": "out-of-office", "inReplyTo": "<a sent message's id>", "notify": true}`) and for tests. Each preset takes
 * `from` = the sent message's recipient, `to` = its real target (below) and the subject, headers, envelope and text
 * below (the same as the app's "Simulate a reply" buttons, M4-DESIGN §7.1); explicit fields override the preset.
 *
 * Real targets (SHARED-FROM-DESIGN §7.8, critiques C1-4, C2-24): `reply`, `out-of-office`, `unclear` and `spam` go to
 * the sent message's Reply-To when it had one, else its From ("reply-to"); `new-email` and `bounce-notice` always go to
 * the visible From address ("from"). In per-person mode the app sends no Reply-To, so both targets are the same
 * address and every preset lands where it did before. In shared-From mode "from" is the shared address on the main
 * domain, which the fake doesn't receive for (see `deliveredToFake`).
 */

/** Every preset the admin inbound endpoint knows. */
export const INBOUND_PRESETS = ["reply", "out-of-office", "unclear", "bounce-notice", "new-email", "spam"] as const;
export type InboundPreset = (typeof INBOUND_PRESETS)[number];

/** Which address of the sent message a preset is addressed to: its Reply-To (else its From), or always its From. */
export type PresetTarget = "reply-to" | "from";

/** Each preset's real target (SHARED-FROM-DESIGN §7.8). */
export const PRESET_TARGETS: Readonly<Record<InboundPreset, PresetTarget>> = {
  reply: "reply-to",
  "out-of-office": "reply-to",
  unclear: "reply-to",
  spam: "reply-to",
  "new-email": "from",
  "bounce-notice": "from",
};

/** A preset answer: the email the fake receives, plus which target it was addressed to. */
export type PresetInbound = ReceiveInput & { target: PresetTarget };

/** True for one of INBOUND_PRESETS. */
export function isInboundPreset(v: unknown): v is InboundPreset {
  return typeof v === "string" && (INBOUND_PRESETS as readonly string[]).includes(v);
}

/** True for "reply-to" or "from". */
export function isPresetTarget(v: unknown): v is PresetTarget {
  return v === "reply-to" || v === "from";
}

/**
 * Whether mail to `address` reaches the fake (Mailgun's MX): its domain is one of `domains` (the fake's domain and its
 * otherDomains) or under one. Anything else lands in some mail provider's inbox, which the fake doesn't model.
 */
export function deliveredToFake(address: string, domains: readonly string[]): boolean {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf("@");
  const d = at > 0 ? bare.slice(at + 1) : "";
  if (!d) return false;
  return domains.some((x) => {
    const own = x.trim().toLowerCase();
    return Boolean(own) && (d === own || d.endsWith(`.${own}`));
  });
}

/** The ReceiveInput of a preset answer, without its `target`. */
export function withoutTarget(p: PresetInbound): ReceiveInput {
  const out: ReceiveInput & { target?: PresetTarget } = { ...p };
  delete out.target;
  return out;
}

/** A sent message by the id Mailgun answered with, or by the Message-Id the app gave it (brackets and case ignored). */
export function findSentMessage(messages: readonly FakeMessage[], id: string): FakeMessage | null {
  const want = stripBrackets(id).toLowerCase();
  if (!want) return null;
  return (
    messages.find((m) => m.id.toLowerCase() === want) ??
    messages.find((m) => stripBrackets(m.fields["h:Message-Id"]?.[0] ?? "").toLowerCase() === want) ??
    null
  );
}

/** "Anna Berg <anna@firma.de>" → "Anna"; "anna.berg@firma.de" → "Anna". */
function firstName(address: string): string {
  const display = /^\s*"?([^"<]*?)"?\s*</.exec(address)?.[1]?.trim();
  const word = display ? display.split(/\s+/)[0]! : bareAddress(address).split("@")[0]!.split(/[._+-]/)[0]!;
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "there";
}

/** "Anna Berg <anna@firma.de>" → "Anna Berg"; a bare address → undefined. */
function displayName(address: string): string | undefined {
  const display = /^\s*"?([^"<]*?)"?\s*</.exec(address)?.[1]?.trim();
  return display ? display : undefined;
}

/** The ids a reply to `message` carries in References: the message's own References, then its id (as received). */
function referencesOf(message: FakeMessage): string[] {
  const own = (message.fields["h:References"]?.[0] ?? "")
    .split(/[\s,]+/)
    .map(stripBrackets)
    .filter((s) => s.includes("@"));
  return [...new Set([...own, message.id])];
}

/** The sent message's h:Reply-To (first address, bare, lowercase), or null when it had none. */
function sentReplyTo(message: FakeMessage): string | null {
  const key = Object.keys(message.fields).find((k) => k.toLowerCase() === "h:reply-to");
  const raw = key ? (message.fields[key]?.[0] ?? "") : "";
  const first = bareAddress(raw.split(",")[0] ?? "");
  return first.includes("@") ? first : null;
}

/**
 * The fake's answer of kind `preset` to one of its own sent messages (before explicit overrides), addressed to the
 * preset's real target (`PRESET_TARGETS`), or to `opts.to` when given. The greeting uses the From line's display name.
 */
export function presetInbound(preset: InboundPreset, message: FakeMessage, opts: { to?: PresetTarget } = {}): PresetInbound {
  const target = opts.to ?? PRESET_TARGETS[preset];
  return { ...presetInput(preset, message, target), target };
}

function presetInput(preset: InboundPreset, message: FakeMessage, target: PresetTarget): ReceiveInput {
  const sentFrom = message.fields.from?.[0] ?? "";
  const sentTo = message.fields.to?.[0] ?? "";
  const subject = message.fields.subject?.[0] ?? "";
  const prospect = bareAddress(sentTo.split(",")[0] ?? "");
  const ours = target === "reply-to" ? (sentReplyTo(message) ?? bareAddress(sentFrom)) : bareAddress(sentFrom);
  const thread = { inReplyTo: message.id, references: referencesOf(message) };
  const person = { from: prospect, fromName: displayName(sentTo), to: ours };
  switch (preset) {
    case "reply":
      return {
        ...person,
        ...thread,
        subject: `Re: ${subject}`,
        text: `Hi ${firstName(sentFrom)},\n\nThanks, this sounds interesting. Could you send a few examples and your prices?\n\nBest,\n${firstName(sentTo)}`,
      };
    case "out-of-office":
      return {
        ...person,
        ...thread,
        subject: `Automatic reply: ${subject}`,
        text: "I am out of the office until next Monday with limited access to email.",
        headers: [
          ["Auto-Submitted", "auto-replied"],
          ["X-Autoreply", "yes"],
        ],
        envelopeSender: "",
      };
    case "unclear":
      return {
        ...person,
        ...thread,
        subject: `Re: ${subject}`,
        text: "I'm out of the office this week, but yes, we're interested. Please send details.",
      };
    case "bounce-notice":
      return {
        from: `mailer-daemon@${prospect.split("@")[1] ?? "example.com"}`,
        to: ours,
        ...thread,
        subject: `Undeliverable: ${subject}`,
        text: `Delivery has failed to these recipients or groups:\n\n${prospect}\nThe email address couldn't be found.\n\nOriginal message headers:\n\nMessage-ID: <${message.id}>`,
        contentType: 'multipart/report; report-type=delivery-status; boundary="b"',
        envelopeSender: "",
      };
    case "new-email":
      return { ...person, subject: "Question", text: "Hi, do you also make figurines?" };
    case "spam":
      return {
        from: "offers@bulk-mailer.example",
        to: ours,
        subject: "Grow your sales 300% this month",
        text: "Get more customers today. Reply to this email to learn how.",
        headers: [
          ["X-Mailgun-Sflag", "Yes"],
          ["X-Mailgun-Sscore", "12.5"],
        ],
      };
  }
}
