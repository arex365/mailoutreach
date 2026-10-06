import { describe, expect, it } from "vitest";
import { LEASE_TTL_MS, decideLease, holdsLiveLease } from "../../../worker/lease-decision";

const now = new Date("2026-09-23T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("decideLease", () => {
  it("takes the lease when there is no lease row yet", () => {
    expect(decideLease(now, null, "me")).toBe("take");
  });

  it("renews its own lease, even if the heartbeat is old", () => {
    expect(decideLease(now, { workerId: "me", heartbeatAt: ago(5_000) }, "me")).toBe("renew");
    expect(decideLease(now, { workerId: "me", heartbeatAt: ago(10 * 60_000) }, "me")).toBe("renew");
  });

  it("waits while another worker's heartbeat is fresh (60 s or less)", () => {
    expect(decideLease(now, { workerId: "other", heartbeatAt: ago(1_000) }, "me")).toBe("wait");
    expect(decideLease(now, { workerId: "other", heartbeatAt: ago(LEASE_TTL_MS) }, "me")).toBe("wait");
  });

  it("takes over when the other worker's heartbeat is older than 60 s", () => {
    expect(decideLease(now, { workerId: "other", heartbeatAt: ago(LEASE_TTL_MS + 1) }, "me")).toBe("take");
    expect(decideLease(now, { workerId: "other", heartbeatAt: new Date(0) }, "me")).toBe("take");
  });

  it("waits when the other heartbeat is in the future (clock differences)", () => {
    expect(decideLease(now, { workerId: "other", heartbeatAt: new Date(now.getTime() + 30_000) }, "me")).toBe("wait");
  });
});

describe("holdsLiveLease", () => {
  it("is true only for my own lease with a recent heartbeat", () => {
    expect(holdsLiveLease(now, { workerId: "me", heartbeatAt: ago(10_000) }, "me")).toBe(true);
    expect(holdsLiveLease(now, { workerId: "me", heartbeatAt: ago(46_000) }, "me")).toBe(false);
    expect(holdsLiveLease(now, { workerId: "other", heartbeatAt: ago(1_000) }, "me")).toBe(false);
    expect(holdsLiveLease(now, null, "me")).toBe(false);
  });
});
