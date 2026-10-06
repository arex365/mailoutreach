import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The five Milestone 5 packages (M5-DESIGN §5.5), and htmlparser2 and encoding-sniffer (direct dependencies since M6,
 * M6-DESIGN §7.5), load in the forms the code imports them, with the exports the app uses; the worker's `--self-test`
 * checks the same in the built bundle. The versions are the pinned ones: undici 7.x and ipaddr.js 2.x must not resolve
 * to shadcn's transitive copies (7.29.1, 1.9.1).
 */

/** The top-level copy's version (what `import` resolves to), read from its package.json on disk. */
function version(name: string): string {
  const file = path.resolve("node_modules", ...name.split("/"), "package.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
}

describe("Milestone 5 packages", () => {
  it("@anthropic-ai/sdk exports the client class", async () => {
    const mod = await import("@anthropic-ai/sdk");
    expect(typeof mod.default).toBe("function");
  });

  it("cheerio exports load and loadBuffer", async () => {
    const cheerio = await import("cheerio");
    expect(typeof cheerio.load).toBe("function");
    expect(typeof cheerio.loadBuffer).toBe("function");
  });

  it("htmlparser2 and encoding-sniffer (imported by the website reader) export what it uses", async () => {
    const hp2 = await import("htmlparser2");
    expect(typeof hp2.Parser).toBe("function");
    expect(typeof hp2.DomHandler).toBe("function");
    const sniffer = await import("encoding-sniffer");
    expect(typeof sniffer.decodeBuffer).toBe("function");
    expect(sniffer.decodeBuffer(Buffer.from("<p>Grüße</p>", "utf8"), { transportLayerEncodingLabel: "utf-8" })).toBe("<p>Grüße</p>");
  });

  it("undici exports fetch, Agent and buildConnector", async () => {
    const undici = await import("undici");
    expect(typeof undici.fetch).toBe("function");
    expect(typeof undici.Agent).toBe("function");
    expect(typeof undici.buildConnector).toBe("function");
  });

  it("robots-parser and ipaddr.js load through ESM interop", async () => {
    const robotsParser = (await import("robots-parser")).default;
    expect(typeof robotsParser).toBe("function");
    expect(robotsParser("https://www.example.com/robots.txt", "User-agent: *\nDisallow: /private").isAllowed("https://www.example.com/")).toBe(true);
    const ipaddr = (await import("ipaddr.js")).default;
    expect(ipaddr.isValid("127.0.0.1")).toBe(true);
    expect(ipaddr.process("::ffff:127.0.0.1").range()).toBe("loopback");
  });

  it("are the pinned versions", () => {
    expect(version("@anthropic-ai/sdk")).toBe("0.128.0");
    expect(version("cheerio")).toBe("1.2.0");
    expect(version("undici")).toBe("7.30.0");
    expect(version("robots-parser")).toBe("3.0.1");
    expect(version("ipaddr.js")).toBe("2.5.0");
    // Direct dependencies since M6 (L13, M6-DESIGN §7.5): src/server/web/extract.ts imports them itself, so a cheerio
    // update can no longer move or drop the reader's parser. cheerio 1.2.0 uses the same top-level copies.
    expect(version("htmlparser2")).toBe("10.1.0");
    expect(version("encoding-sniffer")).toBe("0.2.1");
  });

  it("list htmlparser2 and encoding-sniffer in package.json's dependencies at the exact versions", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["htmlparser2"]).toBe("10.1.0");
    expect(pkg.dependencies["encoding-sniffer"]).toBe("0.2.1");
  });
});
