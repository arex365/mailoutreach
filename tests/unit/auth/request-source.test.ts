import { beforeEach, describe, expect, it, vi } from "vitest";

const current = { headers: new Headers() };
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => current.headers }));

const { isHttpsRequest, requestSourceKey } = await import("@/lib/request");

beforeEach(() => {
  current.headers = new Headers();
});

describe("request source key", () => {
  it("uses CF-Connecting-IP through the tunnel, otherwise the first X-Forwarded-For address", async () => {
    current.headers = new Headers({ "cf-connecting-ip": " 203.0.113.9 ", "x-forwarded-for": "10.0.0.2" });
    expect(await requestSourceKey()).toBe("tunnel:203.0.113.9");
    current.headers = new Headers({ "x-forwarded-for": "192.168.1.10, 10.0.0.1" });
    expect(await requestSourceKey()).toBe("lan:192.168.1.10");
    current.headers = new Headers({ "x-forwarded-for": "::ffff:127.0.0.1" });
    expect(await requestSourceKey()).toBe("lan:::ffff:127.0.0.1");
    current.headers = new Headers();
    expect(await requestSourceKey()).toBe("lan:unknown");
  });

  it("keeps a faked header short and to address characters, so it can't bloat the database (SECURITY-4)", async () => {
    current.headers = new Headers({ "x-forwarded-for": "1".repeat(10_000) });
    expect((await requestSourceKey()).length).toBeLessThanOrEqual("lan:".length + 64);
    current.headers = new Headers({ "x-forwarded-for": "<script>alert(1)</script>" });
    expect(await requestSourceKey()).toBe("lan:scriptalert1script");
    current.headers = new Headers({ "cf-connecting-ip": "\"'<>" });
    expect(await requestSourceKey()).toBe("lan:unknown");
  });

  it("reads https from x-forwarded-proto", async () => {
    current.headers = new Headers({ "x-forwarded-proto": "https" });
    expect(await isHttpsRequest()).toBe(true);
    current.headers = new Headers({ "x-forwarded-proto": "http" });
    expect(await isHttpsRequest()).toBe(false);
  });
});
