import { describe, expect, it } from "vitest";
import {
  STOP_PRECEDENCE,
  SUPPRESSION_PRECEDENCE,
  displayResult,
  eventEffect,
  isHardBounce,
  makeSimulatedEvent,
  normalizeLogItem,
  normalizeMessageId,
  normalizeWebhookEventData,
  parseUserVariables,
  type NormalizedEvent,
} from "@/core/mailgun/events";

/** The permanent-failure webhook from the research (mailgun-api-reference §13.1), with our user-variables. */
function bounceWebhook(): Record<string, unknown> {
  return {
    event: "failed",
    id: "2kFItcrLQuKTdp-Ia2Xr7w",
    timestamp: 1770918175.5923693,
    severity: "permanent",
    reason: "bounce",
    "log-level": "error",
    recipient: "badrecipient@sample.mailgun.com",
    "recipient-domain": "sample.mailgun.com",
    domain: { name: "sample.mailgun.com" },
    account: { id: "1234567890303a4bd1f33898" },
    message: {
      headers: {
        "message-id": "20260212174255.58bbb7ce85a423e5@mailgun.com",
        from: "Sample Sender <sender@sample.mailgun.com>",
        to: "badrecipient@sample.mailgun.com",
        subject: "Sample webhook payload",
      },
      attachments: [],
      size: 384,
    },
    flags: { "is-authenticated": true, "is-routed": false, "is-big": false, "is-system-test": false, "is-test-mode": false },
    "delivery-status": {
      "attempt-no": 1,
      code: 550,
      message: "5.5.0 Requested action not taken: mailbox unavailable",
      description: null,
      "enhanced-code": "5.5.0",
      "mx-host": "802679870.pamx1.hotmail.com",
      "bounce-type": "hard",
      "session-seconds": 0.208,
    },
    envelope: { sender: "sender@sample.mailgun.com", targets: "badrecipient@sample.mailgun.com", transport: "smtp" },
    storage: { key: "XXXXAQVV4uE1s5YYj9ZJq7Ge6flueUXXXX", url: "https://storage-us-east4.api.mailgun.net/v3/domains/sample.mailgun.com/messages/BAABAAfjqLGlFIjZf6pPUoM8bTIKzkQ5Zg" },
    tags: ["outreach", "step-1"],
    campaigns: [],
    "user-variables": { send_id: "8f0c", campaign_id: "c_12", step: "1" },
  };
}

/** An unsubscribe webhook with the documented quirks: storage [], user-variables [], tags ["*"]. */
function unsubscribeWebhook(): Record<string, unknown> {
  return {
    event: "unsubscribed",
    id: "Ase7i2zsRYeDXztHGENqRA",
    timestamp: "1770918300.25",
    "log-level": "info",
    recipient: "Anna@Studio.DE",
    domain: { name: "send.example.com" },
    message: { headers: { "message-id": "<PP.abc123@send.example.com>" } },
    storage: [],
    tags: ["*"],
    "user-variables": [],
    flags: { "is-test-mode": false },
  };
}

/** A Logs item in the §2.2 shape: @timestamp, user-variables as a JSON string, storage.url as an array. */
function logItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "JDhSWf9mT5OFxCkZfpDU5d",
    event: "failed",
    "@timestamp": "2024-07-08T16:30:18.530Z",
    account: { id: "12345" },
    "delivery-status": { message: "Turret client: server connection failed", "attempt-no": 5, code: 680, "session-seconds": 15.026, "retry-seconds": 145 },
    domain: { name: "example.com" },
    recipient: "example@gmail.com",
    message: { headers: { "message-id": "pp.x1@example.com", to: "example@gmail.com" } },
    "user-variables": '{"send_id":"abc","campaign_id":"12","step":"0"}',
    flags: { "is-test-mode": true, "is-webhook": false },
    storage: { key: "k1", url: ["https://storage-europe-west1.api.mailgun.net/v3/domains/example.com/messages/k1"] },
    ...overrides,
  };
}

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    dedupeKey: "e:2026-09-23",
    providerEventId: "e",
    type: "failed",
    severity: "permanent",
    reason: null,
    occurredAt: new Date("2026-09-23T10:00:00Z"),
    messageId: "pp.1@send.example.com",
    recipient: "anna@studio.de",
    userVariables: {},
    tags: [],
    isTestMode: false,
    domain: "send.example.com",
    deliveryStatus: null,
    raw: {},
    ...partial,
  };
}

describe("normalizeMessageId", () => {
  it("strips the angle brackets and lowercases", () => {
    expect(normalizeMessageId("<PP.Abc@Send.Example.com>")).toBe("pp.abc@send.example.com");
    expect(normalizeMessageId("  pp.abc@x.com ")).toBe("pp.abc@x.com");
    expect(normalizeMessageId("<>")).toBeNull();
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

describe("parseUserVariables", () => {
  it("reads an object, [] and a JSON string", () => {
    expect(parseUserVariables({ send_id: "a", step: 1, flag: true, extra: { x: 1 }, none: null })).toEqual({
      send_id: "a",
      step: "1",
      flag: "true",
      extra: '{"x":1}',
    });
    expect(parseUserVariables([])).toEqual({});
    expect(parseUserVariables('{"send_id":"abc","step":"0"}')).toEqual({ send_id: "abc", step: "0" });
    expect(parseUserVariables("not json")).toEqual({});
    expect(parseUserVariables("[1,2]")).toEqual({});
    expect(parseUserVariables(null)).toEqual({});
  });
});

describe("normalizeWebhookEventData", () => {
  it("reads the research's permanent failure", () => {
    const n = normalizeWebhookEventData(bounceWebhook())!;
    expect(n).toMatchObject({
      dedupeKey: "2kFItcrLQuKTdp-Ia2Xr7w:2026-02-12",
      providerEventId: "2kFItcrLQuKTdp-Ia2Xr7w",
      type: "failed",
      severity: "permanent",
      reason: "bounce",
      messageId: "20260212174255.58bbb7ce85a423e5@mailgun.com",
      recipient: "badrecipient@sample.mailgun.com",
      userVariables: { send_id: "8f0c", campaign_id: "c_12", step: "1" },
      tags: ["outreach", "step-1"],
      isTestMode: false,
      domain: "sample.mailgun.com",
      deliveryStatus: { code: 550, message: "5.5.0 Requested action not taken: mailbox unavailable", description: null, bounceType: "hard" },
    });
    expect(n.occurredAt.getTime()).toBe(1770918175592);
    expect(n.raw).toEqual(bounceWebhook());
  });

  it("handles storage [], user-variables [], tags ['*'] and a timestamp sent as a string", () => {
    const n = normalizeWebhookEventData(unsubscribeWebhook())!;
    expect(n.type).toBe("unsubscribed");
    expect(n.userVariables).toEqual({});
    expect(n.tags).toEqual(["*"]);
    expect(n.messageId).toBe("pp.abc123@send.example.com");
    expect(n.recipient).toBe("anna@studio.de");
    expect(n.severity).toBeNull();
    expect(n.deliveryStatus).toBeNull();
    expect(n.occurredAt.getTime()).toBe(1770918300250);
    expect(n.dedupeKey).toBe("Ase7i2zsRYeDXztHGENqRA:2026-02-12");
  });

  it("maps event names it doesn't use to 'other'", () => {
    expect(normalizeWebhookEventData({ ...bounceWebhook(), event: "opened" })?.type).toBe("other");
    expect(normalizeWebhookEventData({ ...bounceWebhook(), event: "rejected" })?.type).toBe("other");
  });

  it("returns null when the id, event or timestamp is missing", () => {
    const { id: _id, ...noId } = bounceWebhook();
    const { event: _event, ...noEvent } = bounceWebhook();
    const { timestamp: _ts, ...noTime } = bounceWebhook();
    expect(normalizeWebhookEventData(noId)).toBeNull();
    expect(normalizeWebhookEventData(noEvent)).toBeNull();
    expect(normalizeWebhookEventData(noTime)).toBeNull();
    expect(normalizeWebhookEventData({ ...bounceWebhook(), timestamp: "soon" })).toBeNull();
    expect(normalizeWebhookEventData(null)).toBeNull();
    expect(normalizeWebhookEventData([])).toBeNull();
    // A missing Message-ID is allowed (the event may still match by send_id).
    const { message: _m, ...noMessage } = bounceWebhook();
    expect(normalizeWebhookEventData(noMessage)?.messageId).toBeNull();
  });
});

describe("normalizeLogItem", () => {
  it("reads @timestamp, the JSON-string user-variables and the test-mode flag", () => {
    const n = normalizeLogItem(logItem())!;
    expect(n).toMatchObject({
      dedupeKey: "JDhSWf9mT5OFxCkZfpDU5d:2024-07-08",
      type: "failed",
      severity: null,
      reason: null,
      messageId: "pp.x1@example.com",
      recipient: "example@gmail.com",
      userVariables: { send_id: "abc", campaign_id: "12", step: "0" },
      isTestMode: true,
      domain: "example.com",
      deliveryStatus: { code: 680, message: "Turret client: server connection failed", description: null, bounceType: null },
    });
    expect(n.occurredAt.toISOString()).toBe("2024-07-08T16:30:18.530Z");
  });

  it("gives a webhook event and its Logs twin the same dedupe key", () => {
    const hook = normalizeWebhookEventData(bounceWebhook())!;
    const twin = normalizeLogItem(
      logItem({ id: "2kFItcrLQuKTdp-Ia2Xr7w", "@timestamp": "2026-02-12T17:42:55.592Z", severity: "permanent", reason: "bounce" }),
    )!;
    expect(twin.dedupeKey).toBe(hook.dedupeKey);
  });

  it("returns null when the id, event or time is missing", () => {
    expect(normalizeLogItem(logItem({ id: undefined }))).toBeNull();
    expect(normalizeLogItem(logItem({ event: "" }))).toBeNull();
    expect(normalizeLogItem(logItem({ "@timestamp": "not a date" }))).toBeNull();
    expect(normalizeLogItem("item")).toBeNull();
  });
});

describe("eventEffect", () => {
  it("delivered", () => {
    expect(eventEffect(ev({ type: "delivered", severity: null }))).toEqual({
      dateField: "deliveredAt",
      stop: null,
      stopEveryCampaign: false,
      suppression: null,
      personField: null,
      inMailgunList: false,
      health: null,
      provesAccepted: true,
    });
  });

  it("temporary failure", () => {
    expect(eventEffect(ev({ severity: "temporary", reason: "generic" }))).toEqual({
      dateField: "tempFailedAt",
      stop: null,
      stopEveryCampaign: false,
      suppression: null,
      personField: null,
      inMailgunList: false,
      health: null,
      provesAccepted: true,
    });
  });

  it("permanent hard bounce", () => {
    const hard = {
      dateField: "bouncedAt",
      stop: "bounced",
      stopEveryCampaign: true,
      suppression: "BOUNCED",
      personField: "bouncedAt",
      inMailgunList: true,
      health: "bounce",
      provesAccepted: true,
    };
    expect(eventEffect(normalizeWebhookEventData(bounceWebhook())!)).toEqual(hard);
    expect(eventEffect(ev({ reason: "hardfail" }))).toEqual(hard);
    expect(eventEffect(ev({ reason: "generic", deliveryStatus: { code: 550, message: null, description: null, bounceType: "hard" } }))).toEqual(hard);
  });

  it("other permanent failures stop only this recipient and count for health, without a lifetime block", () => {
    for (const reason of ["espblock", "generic", "old", "blacklisted", "unknown", null]) {
      expect(eventEffect(ev({ reason }))).toEqual({
        dateField: "bouncedAt",
        stop: "bounced",
        stopEveryCampaign: false,
        suppression: null,
        personField: null,
        inMailgunList: false,
        health: "bounce",
        provesAccepted: true,
      });
    }
  });

  it("each suppress-* drop reads 'Bounced', uses Mailgun's list, and never counts for health", () => {
    const base = { dateField: "bouncedAt", stopEveryCampaign: true, inMailgunList: true, health: null, provesAccepted: true };
    expect(eventEffect(ev({ reason: "suppress-bounce" }))).toEqual({ ...base, stop: "bounced", suppression: "BOUNCED", personField: "bouncedAt" });
    expect(eventEffect(ev({ reason: "suppress-unsubscribe" }))).toEqual({
      ...base,
      stop: "unsubscribed",
      suppression: "UNSUBSCRIBED",
      personField: "unsubscribedAt",
    });
    expect(eventEffect(ev({ reason: "suppress-complaint" }))).toEqual({
      ...base,
      stop: "complained",
      suppression: "COMPLAINED",
      personField: "complainedAt",
    });
    // Mailgun drops them with severity permanent; even without it they are drops, never temporary.
    expect(eventEffect(ev({ reason: "suppress-bounce", severity: null })).health).toBeNull();
    expect(eventEffect(ev({ reason: "suppress-bounce", severity: null })).dateField).toBe("bouncedAt");
  });

  it("complained", () => {
    expect(eventEffect(ev({ type: "complained", severity: null }))).toEqual({
      dateField: "complainedAt",
      stop: "complained",
      stopEveryCampaign: true,
      suppression: "COMPLAINED",
      personField: "complainedAt",
      inMailgunList: true,
      health: null,
      provesAccepted: true,
    });
  });

  it("unsubscribed", () => {
    expect(eventEffect(normalizeWebhookEventData(unsubscribeWebhook())!)).toEqual({
      dateField: "unsubscribedAt",
      stop: "unsubscribed",
      stopEveryCampaign: true,
      suppression: "UNSUBSCRIBED",
      personField: "unsubscribedAt",
      inMailgunList: true,
      health: null,
      provesAccepted: true,
    });
  });

  it("accepted proves the send and nothing else; other events do nothing", () => {
    expect(eventEffect(ev({ type: "accepted", severity: null }))).toEqual({
      dateField: null,
      stop: null,
      stopEveryCampaign: false,
      suppression: null,
      personField: null,
      inMailgunList: false,
      health: null,
      provesAccepted: true,
    });
    expect(eventEffect(ev({ type: "other", severity: null })).provesAccepted).toBe(false);
    expect(eventEffect(ev({ type: "other", severity: null })).dateField).toBeNull();
  });

  it("never counts test-mode events for health", () => {
    const testBounce = eventEffect(ev({ reason: "bounce", isTestMode: true }));
    expect(testBounce.health).toBeNull();
    expect(testBounce.stop).toBe("bounced");
    expect(eventEffect(ev({ reason: "old", isTestMode: true })).health).toBeNull();
    // Test mode "delivered" (code 650) is a normal delivered event.
    const delivered650 = normalizeLogItem(logItem({ event: "delivered", "delivery-status": { code: 650 } }))!;
    expect(delivered650.isTestMode).toBe(true);
    expect(eventEffect(delivered650).dateField).toBe("deliveredAt");
  });
});

describe("isHardBounce", () => {
  it("is true for permanent bounce, hardfail, suppress-bounce and bounce-type hard", () => {
    expect(isHardBounce(ev({ reason: "bounce" }))).toBe(true);
    expect(isHardBounce(ev({ reason: "hardfail" }))).toBe(true);
    expect(isHardBounce(ev({ reason: "suppress-bounce" }))).toBe(true);
    expect(isHardBounce(ev({ reason: "generic", deliveryStatus: { code: 550, message: null, description: null, bounceType: "hard" } }))).toBe(true);
  });

  it("is false for temporary failures, other reasons and other events", () => {
    expect(isHardBounce(ev({ severity: "temporary", reason: "bounce" }))).toBe(false);
    expect(isHardBounce(ev({ reason: "espblock" }))).toBe(false);
    expect(isHardBounce(ev({ reason: "suppress-unsubscribe" }))).toBe(false);
    expect(isHardBounce(ev({ type: "delivered", severity: null, reason: "bounce" }))).toBe(false);
  });
});

describe("makeSimulatedEvent", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  const input = { emailId: 12, messageId: "<PP.abc@Send.Example.com>", recipient: "Anna@Studio.de", now };

  it("simulates a hard bounce that behaves like the real one", () => {
    const e = makeSimulatedEvent({ ...input, kind: "bounce" });
    expect(e).toMatchObject({
      dedupeKey: "sim:12:failed",
      type: "failed",
      severity: "permanent",
      reason: "bounce",
      messageId: "pp.abc@send.example.com",
      recipient: "anna@studio.de",
      domain: "send.example.com",
      isTestMode: false,
    });
    expect(e.occurredAt.toISOString()).toBe(now.toISOString());
    expect(isHardBounce(e)).toBe(true);
    expect(eventEffect(e).suppression).toBe("BOUNCED");
  });

  it("simulates delivered, a complaint and an unsubscribe with their own keys", () => {
    expect(makeSimulatedEvent({ ...input, kind: "delivered" }).dedupeKey).toBe("sim:12:delivered");
    expect(eventEffect(makeSimulatedEvent({ ...input, kind: "delivered" })).dateField).toBe("deliveredAt");
    expect(makeSimulatedEvent({ ...input, kind: "complaint" }).dedupeKey).toBe("sim:12:complained");
    expect(eventEffect(makeSimulatedEvent({ ...input, kind: "complaint" })).stop).toBe("complained");
    const unsub = makeSimulatedEvent({ ...input, kind: "unsubscribe" });
    expect(unsub.dedupeKey).toBe("sim:12:unsubscribed");
    expect(unsub.tags).toEqual(["*"]);
    expect(eventEffect(unsub).suppression).toBe("UNSUBSCRIBED");
  });
});

describe("precedence and display", () => {
  it("orders stops and suppressions from weakest to strongest", () => {
    expect(STOP_PRECEDENCE).toEqual(["bounced", "unsubscribed", "complained"]);
    expect(SUPPRESSION_PRECEDENCE).toEqual(["MANUAL", "INVALID", "BOUNCED", "UNSUBSCRIBED", "COMPLAINED"]);
  });

  it("shows the strongest result an email has", () => {
    const d = new Date();
    expect(displayResult({ sentAt: d, deliveredAt: d, bouncedAt: d, unsubscribedAt: d, complainedAt: d })).toBe("complained");
    expect(displayResult({ sentAt: d, deliveredAt: d, bouncedAt: d, unsubscribedAt: d })).toBe("unsubscribed");
    expect(displayResult({ sentAt: d, deliveredAt: d, bouncedAt: d })).toBe("bounced");
    expect(displayResult({ sentAt: d, deliveredAt: d })).toBe("delivered");
    expect(displayResult({ sentAt: d, deliveredAt: null })).toBe("sent");
    expect(displayResult({})).toBeNull();
  });
});
