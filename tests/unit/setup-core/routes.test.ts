import { describe, expect, it } from "vitest";
import {
  catchAllRouteSpec,
  dmarcRouteSpec,
  escapeRouteRegex,
  isSafeForwardAddress,
  parseRouteDescription,
  PUBLIC_ADDRESS_TEXTS,
  publicAddressProblem,
  routeCheckAddress,
  sameRoute,
  senderRouteSpec,
  sendingDomainOf,
} from "@/core/mailgun/routes";

const NOTIFY = "https://outreach.example.com/api/webhooks/mailgun/inbound";

describe("escapeRouteRegex", () => {
  it("escapes every regex special character", () => {
    expect(escapeRouteRegex("a.b")).toBe("a\\.b");
    expect(escapeRouteRegex("\\^$.|?*+()[]{}")).toBe("\\\\\\^\\$\\.\\|\\?\\*\\+\\(\\)\\[\\]\\{\\}");
    expect(escapeRouteRegex("ali_khan-1")).toBe("ali_khan-1");
  });
});

describe("route specs", () => {
  it("anchors and escapes a sender's address", () => {
    const spec = senderRouteSpec({ senderAddressId: 12, address: "ali.b@send.example.com", forwardTo: "ali.khan@gmail.com", notifyUrl: NOTIFY });
    expect(spec).toEqual({
      priority: 10,
      description: "outreach-app:sender:12",
      expression: 'match_recipient("^ali\\.b@send\\.example\\.com$")',
      actions: ['forward("ali.khan@gmail.com")', `store(notify="${NOTIFY}")`, "stop()"],
    });
    // The regex only matches that exact address, never a look-alike.
    const re = new RegExp(/match_recipient\("(.*)"\)/.exec(spec.expression)![1]!);
    expect(re.test("ali.b@send.example.com")).toBe(true);
    expect(re.test("alixb@send.example.com")).toBe(false);
    expect(re.test("ali.b@send.example.com.evil.org")).toBe(false);
    expect(re.test("xali.b@send.example.com")).toBe(false);
  });

  it("builds the catch-all with an anchored domain regex and the dmarc@ route without store", () => {
    expect(catchAllRouteSpec({ domain: "Send.Example.com", forwardTo: "owner@gmail.com", notifyUrl: NOTIFY })).toEqual({
      priority: 100,
      description: "outreach-app:catchall:send.example.com",
      expression: 'match_recipient("^.*@send\\.example\\.com$")',
      actions: ['forward("owner@gmail.com")', `store(notify="${NOTIFY}")`, "stop()"],
    });
    expect(dmarcRouteSpec({ domain: "send.example.com", forwardTo: "owner@gmail.com" })).toEqual({
      priority: 50,
      description: "outreach-app:dmarc:send.example.com",
      expression: 'match_recipient("^dmarc@send\\.example\\.com$")',
      actions: ['forward("owner@gmail.com")', "stop()"],
    });
  });

  it("reads the app's own descriptions and ignores everyone else's", () => {
    expect(parseRouteDescription("outreach-app:sender:12")).toEqual({ kind: "sender", senderAddressId: 12 });
    expect(parseRouteDescription("outreach-app:catchall:send.example.com")).toEqual({ kind: "catchall", domain: "send.example.com" });
    expect(parseRouteDescription("outreach-app:dmarc:send.example.com")).toEqual({ kind: "dmarc", domain: "send.example.com" });
    expect(parseRouteDescription("Sample route")).toBeNull();
    expect(parseRouteDescription("outreach-app:sender:abc")).toBeNull();
    expect(parseRouteDescription("outreach-app:sender:0")).toBeNull();
    expect(parseRouteDescription("outreach-app:other:x")).toBeNull();
  });

  it("compares priority, expression and every action in order", () => {
    const spec = senderRouteSpec({ senderAddressId: 1, address: "a@d.com", forwardTo: "x@gmail.com", notifyUrl: NOTIFY });
    expect(sameRoute({ ...spec }, spec)).toBe(true);
    expect(sameRoute({ ...spec, priority: 11 }, spec)).toBe(false);
    expect(sameRoute({ ...spec, expression: 'match_recipient("a@d.com")' }, spec)).toBe(false);
    expect(sameRoute({ ...spec, actions: [...spec.actions].reverse() }, spec)).toBe(false);
    expect(sameRoute({ ...spec, actions: spec.actions.slice(0, 2) }, spec)).toBe(false);
  });
});

describe("isSafeForwardAddress", () => {
  const domains = ["send.example.com"];
  it("accepts a plain mailbox", () => {
    expect(isSafeForwardAddress("ali.khan@gmail.com", domains)).toBe(true);
    expect(isSafeForwardAddress("o'brien@outlook.com", domains)).toBe(true);
    expect(isSafeForwardAddress("owner@example.com", domains)).toBe(true); // the parent domain isn't a sending domain
  });
  it("refuses an inbox on or under a sending domain (a mail loop)", () => {
    expect(isSafeForwardAddress("ali@send.example.com", domains)).toBe(false);
    expect(isSafeForwardAddress("ali@reply.send.example.com", domains)).toBe(false);
    expect(isSafeForwardAddress("ALI@SEND.EXAMPLE.COM", domains)).toBe(false);
    expect(sendingDomainOf("ali@reply.send.example.com", domains)).toBe("send.example.com");
    expect(sendingDomainOf("ali@gmail.com", domains)).toBeNull();
  });
  it("shared-From mode: the shared From address is a valid reply inbox; the loop rule stays on the sending domain (SHARED-FROM-DESIGN F9)", () => {
    const owner = ["mail.polygonparadise.com"];
    expect(isSafeForwardAddress("contact@polygonparadise.com", owner)).toBe(true);
    expect(isSafeForwardAddress("ali@mail.polygonparadise.com", owner)).toBe(false);
    expect(sendingDomainOf("contact@polygonparadise.com", owner)).toBeNull();
  });
  it("refuses anything that could break out of forward(\"…\")", () => {
    for (const bad of ['a"b@gmail.com', "Ali <ali@gmail.com>", "a@gmail.com, b@gmail.com", "a b@gmail.com", "a@gmail.com;", "", "not-an-email"]) {
      expect(isSafeForwardAddress(bad, domains)).toBe(false);
    }
  });
});

describe("routeCheckAddress and publicAddressProblem", () => {
  it("builds the probe address on the domain", () => {
    expect(routeCheckAddress("Send.Example.com", "a1B2c3")).toBe("pp-route-check-a1b2c3@send.example.com");
  });

  it("wants https, or the fake's loopback address in fake mode", () => {
    expect(publicAddressProblem("https://outreach.example.com", false)).toBeNull();
    expect(publicAddressProblem("https://outreach.example.com/", true)).toBeNull();
    expect(publicAddressProblem(null, false)).toBe(PUBLIC_ADDRESS_TEXTS.missing);
    expect(publicAddressProblem("  ", true)).toBe(PUBLIC_ADDRESS_TEXTS.missing);
    expect(publicAddressProblem("http://outreach.example.com", false)).toBe(PUBLIC_ADDRESS_TEXTS.notHttps);
    expect(publicAddressProblem("http://127.0.0.1:3100", false)).toBe(PUBLIC_ADDRESS_TEXTS.notHttps);
    expect(publicAddressProblem("http://127.0.0.1:3100", true)).toBeNull();
    expect(publicAddressProblem("http://localhost:3100", true)).toBe(PUBLIC_ADDRESS_TEXTS.notHttps);
    expect(publicAddressProblem("https://user:pw@outreach.example.com", false)).toBe(PUBLIC_ADDRESS_TEXTS.notHttps);
    expect(publicAddressProblem("not a url", false)).toBe(PUBLIC_ADDRESS_TEXTS.notHttps);
  });
});
