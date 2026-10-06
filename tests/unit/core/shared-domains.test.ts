import { describe, expect, it } from "vitest";
import { INSTAGRAM_NOT_PROFILES, instagramHandle, parseWebsite } from "@/core/shared-domains";

const key = (url: string) => parseWebsite(url)?.profileKey ?? null;
const url = (input: string) => parseWebsite(input)?.url ?? null;

describe("profile keys: one key per account, never per platform page (DATA-1)", () => {
  it("Etsy: the shop, never 'etsy.com/shop'", () => {
    expect(key("https://www.etsy.com/shop/FooMinis")).toBe("etsy.com/shop/foominis");
    expect(key("https://www.etsy.com/shop/BarBusts?ref=seller-platform-mcnav")).toBe("etsy.com/shop/barbusts");
    expect(key("https://www.etsy.com/de/shop/FooMinis")).toBe("etsy.com/shop/foominis");
    expect(key("https://www.etsy.com/shop/FooMinis/reviews")).toBe("etsy.com/shop/foominis");
    expect(key("https://foominis.etsy.com")).toBe("etsy.com/shop/foominis");
    expect(key("https://www.etsy.com/people/annasculpts")).toBe("etsy.com/people/annasculpts");
    expect(key("https://www.etsy.com/shop")).toBeNull();
    expect(key("https://www.etsy.com/listing/123456/resin-bust")).toBeNull();
    expect(key("https://www.etsy.com")).toBeNull();
  });

  it("Cults3D: /<lang>/users/<name> and /users/<name>", () => {
    expect(key("https://cults3d.com/en/users/FooMinis")).toBe("cults3d.com/users/foominis");
    expect(key("https://cults3d.com/de/users/FooMinis/3d-models")).toBe("cults3d.com/users/foominis");
    expect(key("https://cults3d.com/users/FooMinis")).toBe("cults3d.com/users/foominis");
    expect(key("https://cults3d.com/en")).toBeNull();
    expect(key("https://cults3d.com/en/users")).toBeNull();
    expect(key("https://cults3d.com/en/3d-model/game/dragon")).toBeNull();
  });

  it("MyMiniFactory: /users/<name>", () => {
    expect(key("https://www.myminifactory.com/users/BarBusts")).toBe("myminifactory.com/users/barbusts");
    expect(key("https://www.myminifactory.com/users")).toBeNull();
    expect(key("https://www.myminifactory.com/object/3d-print-dragon-123")).toBeNull();
  });

  it("LinkedIn: /company/<x> and /in/<x>", () => {
    expect(key("https://www.linkedin.com/company/acme-3d/")).toBe("linkedin.com/company/acme-3d");
    expect(key("https://de.linkedin.com/company/acme-3d/about")).toBe("linkedin.com/company/acme-3d");
    expect(key("https://www.linkedin.com/in/anna-schmidt-123/")).toBe("linkedin.com/in/anna-schmidt-123");
    expect(key("https://www.linkedin.com/company/")).toBeNull();
    expect(key("https://www.linkedin.com/feed/")).toBeNull();
  });

  it("YouTube: /@x and /channel|c|user/<x>; a video is no account", () => {
    expect(key("https://www.youtube.com/@AnnaSculpts")).toBe("youtube.com/@annasculpts");
    expect(key("https://www.youtube.com/@AnnaSculpts/videos")).toBe("youtube.com/@annasculpts");
    expect(key("https://www.youtube.com/channel/UCabc123")).toBe("youtube.com/channel/ucabc123");
    expect(key("https://www.youtube.com/c/AnnaSculpts")).toBe("youtube.com/c/annasculpts");
    expect(key("https://m.youtube.com/user/annasculpts")).toBe("youtube.com/user/annasculpts");
    expect(key("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(key("https://youtu.be/dQw4w9WgXcQ")).toBeNull();
  });

  it("Google Sites: /view/<x>", () => {
    expect(key("https://sites.google.com/view/foominis")).toBe("sites.google.com/view/foominis");
    expect(key("https://sites.google.com/view/foominis/home")).toBe("sites.google.com/view/foominis");
    expect(key("https://sites.google.com/view")).toBeNull();
    expect(key("https://www.google.com/maps/place/Acme")).toBeNull();
  });

  it("Facebook: profile.php?id=<id>, people/…/<id>, or the page name", () => {
    expect(key("https://www.facebook.com/profile.php?id=100083123")).toBe("facebook.com/profile.php?id=100083123");
    expect(key("https://m.facebook.com/profile.php?id=100083123&sk=about")).toBe("facebook.com/profile.php?id=100083123");
    expect(key("https://www.facebook.com/people/Anna-Sculpts/100083123/")).toBe("facebook.com/profile.php?id=100083123");
    expect(key("https://www.facebook.com/p/Anna-Sculpts-100083123/")).toBe("facebook.com/profile.php?id=100083123");
    expect(key("https://www.facebook.com/100083123")).toBe("facebook.com/profile.php?id=100083123");
    expect(key("https://www.facebook.com/AcmeMiniatures/")).toBe("facebook.com/acmeminiatures");
    expect(key("https://www.facebook.com/pg/AcmeMiniatures/posts")).toBe("facebook.com/acmeminiatures");
    expect(key("https://fb.me/AcmeMiniatures")).toBe("facebook.com/acmeminiatures");
    // Two different profile.php profiles are two companies.
    expect(key("https://facebook.com/profile.php?id=111111")).not.toBe(key("https://facebook.com/profile.php?id=222222"));
    for (const generic of [
      "https://www.facebook.com/profile.php",
      "https://www.facebook.com/groups/resinprinting",
      "https://www.facebook.com/watch/?v=123",
      "https://www.facebook.com/events/123456",
      "https://www.facebook.com/marketplace/item/123",
      "https://www.facebook.com/photo.php?fbid=123",
      "https://www.facebook.com/sharer/sharer.php?u=x",
      "https://www.facebook.com/pages",
    ]) {
      expect(key(generic), generic).toBeNull();
    }
  });

  it("Instagram: /<handle>, never p, reel, reels, tv, explore, stories or accounts", () => {
    expect(key("https://www.instagram.com/sculpt_by_anna/")).toBe("instagram.com/sculpt_by_anna");
    expect(key("https://instagram.com/Sculpt_By_Anna?igshid=abc")).toBe("instagram.com/sculpt_by_anna");
    expect(key("https://instagr.am/sculpt_by_anna")).toBe("instagram.com/sculpt_by_anna");
    for (const reserved of ["p", "reel", "reels", "tv", "explore", "stories", "accounts"]) {
      expect(INSTAGRAM_NOT_PROFILES.has(reserved)).toBe(true);
      expect(key(`https://www.instagram.com/${reserved}/CxYz123/`), reserved).toBeNull();
    }
  });

  it("TikTok, Patreon, X/Twitter and Linktree", () => {
    expect(key("https://www.tiktok.com/@anna.sculpts")).toBe("tiktok.com/@anna.sculpts");
    expect(key("https://www.tiktok.com/@anna.sculpts/video/123")).toBe("tiktok.com/@anna.sculpts");
    expect(key("https://www.tiktok.com/discover/resin")).toBeNull();
    expect(key("https://www.patreon.com/FooMinis")).toBe("patreon.com/foominis");
    expect(key("https://www.patreon.com/c/FooMinis/posts")).toBe("patreon.com/foominis");
    expect(key("https://www.patreon.com/user?u=123456")).toBe("patreon.com/user?u=123456");
    expect(key("https://www.patreon.com/posts/new-minis-123")).toBeNull();
    expect(key("https://x.com/FooMinis")).toBe("x.com/foominis");
    expect(key("https://twitter.com/FooMinis/status/123")).toBe("x.com/foominis");
    expect(key("https://x.com/search?q=resin")).toBeNull();
    expect(key("https://x.com/i/lists/123")).toBeNull();
    expect(key("https://linktr.ee/FooMinis")).toBe("linktr.ee/foominis");
    expect(key("https://linktr.ee/s/about")).toBeNull();
  });

  it("gives null for platforms without a rule and for bare platform links", () => {
    expect(key("https://www.amazon.de/dp/B0123")).toBeNull();
    expect(key("https://www.instagram.com/")).toBeNull();
    expect(key("https://www.facebook.com")).toBeNull();
    expect(parseWebsite("https://www.amazon.de/dp/B0123")?.isShared).toBe(true);
  });

  it("never joins two different shops of the same platform", () => {
    const shops = [
      "https://www.etsy.com/shop/FooMinis",
      "https://www.etsy.com/shop/BarBusts",
      "https://cults3d.com/en/users/FooMinis",
      "https://cults3d.com/en/users/BarBusts",
      "https://www.myminifactory.com/users/FooMinis",
      "https://www.myminifactory.com/users/BarBusts",
      "https://www.linkedin.com/company/foo",
      "https://www.linkedin.com/company/bar",
      "https://sites.google.com/view/foo",
      "https://sites.google.com/view/bar",
    ];
    const keys = shops.map(key);
    expect(new Set(keys).size).toBe(shops.length);
  });

  it("keeps company websites as before", () => {
    const acme = parseWebsite("www.acme-3d.de/about?utm_source=x");
    expect(acme).toMatchObject({ url: "https://www.acme-3d.de/about", domain: "acme-3d.de", profileKey: null, isShared: false });
  });
});

describe("the stored link keeps what identifies the account (DATA-7)", () => {
  it("keeps facebook's id and youtube's v/list, drops tracking", () => {
    expect(url("https://www.facebook.com/profile.php?id=100083123&fbclid=IwAR0abc")).toBe("https://www.facebook.com/profile.php?id=100083123");
    expect(url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&feature=share")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(url("https://www.youtube.com/playlist?list=PL123&utm_source=x")).toBe("https://www.youtube.com/playlist?list=PL123");
    expect(url("https://www.patreon.com/user?u=123456&utm_medium=social")).toBe("https://www.patreon.com/user?u=123456");
  });

  it("drops the query where it never identifies anything", () => {
    expect(url("https://www.instagram.com/sculpt_by_anna/?igshid=abc&utm_source=qr")).toBe("https://www.instagram.com/sculpt_by_anna");
    expect(url("https://www.etsy.com/shop/FooMinis?ref=simple-shop-header-name&listing_id=1")).toBe("https://www.etsy.com/shop/FooMinis");
  });

  it("keeps other parameters on shared hosts without a rule, minus tracking ones", () => {
    expect(url("https://www.amazon.de/s?me=A1B2C3&utm_source=x&ref=sr")).toBe("https://www.amazon.de/s?me=A1B2C3");
  });
});

describe("instagramHandle", () => {
  it("reads profile links and @handles", () => {
    expect(instagramHandle("https://www.instagram.com/Sculpt_By_Anna/")).toBe("sculpt_by_anna");
    expect(instagramHandle("instagram.com/anna.sculpts?igsh=xyz")).toBe("anna.sculpts");
    expect(instagramHandle("IG: instagram.com/anna.sculpts")).toBe("anna.sculpts");
    expect(instagramHandle("instagram.com/anna.sculpts, 12k followers")).toBe("anna.sculpts");
    expect(instagramHandle("@anna.sculpts")).toBe("anna.sculpts");
    expect(instagramHandle("anna.sculpts")).toBe("anna.sculpts");
  });

  it("gives null for posts, reels, stories and Instagram's own pages", () => {
    expect(instagramHandle("https://www.instagram.com/p/CxYz123/")).toBeNull();
    expect(instagramHandle("https://www.instagram.com/reel/CxYz123/")).toBeNull();
    expect(instagramHandle("https://www.instagram.com/stories/anna/123/")).toBeNull();
    expect(instagramHandle("https://www.instagram.com/explore/tags/resin/")).toBeNull();
    expect(instagramHandle("@reels")).toBeNull();
    expect(instagramHandle("https://www.instagram.com/")).toBeNull();
    expect(instagramHandle("https://notinstagram.com/anna")).toBeNull();
    expect(instagramHandle("https://facebook.com/anna")).toBeNull();
  });
});
