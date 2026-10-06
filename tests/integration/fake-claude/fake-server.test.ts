import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkLine } from "@/core/ai/checks";
import { readLineAnswer } from "@/core/ai/parse";
import { buildLineRequest } from "@/core/ai/request";
import { DEFAULT_AI_PRICES, HAIKU_MODEL, resolveProfile, type LineAnswer } from "@/core/ai/types";
import { createClaudeApi, UnreadableAnswerError } from "@/server/anthropic";
import { ECHO_LINE, echoAnswer, fixtureAnswer, pagesFromUserText } from "../../fake-claude/answers";
import { parseCliArgs, runCli } from "../../fake-claude/cli";
import { FAKE_CLAUDE_KEY, startFakeClaude, type FakeClaude } from "../../fake-claude/server";

/** M5-DESIGN §7.2: the fake's fixture answers, its admin API and its command line. */

const haiku = resolveProfile(HAIKU_MODEL, null, DEFAULT_AI_PRICES);
const FIXTURE_ANSWER = {
  evidence_source: "second_page",
  evidence_quote: "Handbemalte Fantasy-Büsten im Maßstab 1:6 aus Kaltguss-Resin",
  line: "Your hand-painted 1:6 fantasy busts are cast in cold-cast resin.",
  reason_if_null: null,
};

let sitesDir: string;
let fake: FakeClaude;

function input(url: string, text = "Willkommen in unserer Werkstatt für Figuren und Büsten aus Resin.") {
  return {
    company: { name: "Figuren Werkstatt", country: "Germany", niche: null },
    pages: [{ source: "homepage" as const, url, lang: "de", title: "Start", text }],
  };
}

beforeAll(async () => {
  sitesDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-sites-"));
  const site = (name: string, json: object, claude?: string) => {
    fs.mkdirSync(path.join(sitesDir, name));
    fs.writeFileSync(path.join(sitesDir, name, "site.json"), JSON.stringify(json));
    if (claude !== undefined) fs.writeFileSync(path.join(sitesDir, name, "claude.json"), claude);
  };
  site("de-figuren", { origin: "https://www.figuren-werkstatt.example", pages: {} }, JSON.stringify(FIXTURE_ANSWER));
  site("no-answer", { origin: "https://no-answer.example", pages: {} });
  site("broken", { origin: "https://broken.example", aliases: ["https://kaputt.example"], pages: {} }, "{ not json");
  fs.mkdirSync(path.join(sitesDir, "not-a-site"));
  fake = await startFakeClaude({ sitesDir });
});
afterAll(async () => {
  await fake.close();
  fs.rmSync(sitesDir, { recursive: true, force: true });
});

describe("answers", () => {
  it("a fixture site's claude.json answers for its homepage (with or without www.)", async () => {
    const api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin);
    for (const url of ["https://www.figuren-werkstatt.example/", "https://figuren-werkstatt.example/start", "http://www.figuren-werkstatt.example/"]) {
      const read = readLineAnswer(await api.createLine(buildLineRequest(input(url), haiku)));
      expect(read).toEqual({ kind: "ok", value: FIXTURE_ANSWER });
    }
  });

  it("a site without claude.json, an unknown site and no fixtures fall back to the echo answer", async () => {
    const api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin);
    for (const url of ["https://no-answer.example/", "https://unknown.example/"]) {
      const read = readLineAnswer(await api.createLine(buildLineRequest(input(url), haiku)));
      expect(read.kind === "ok" && read.value.line).toBe(ECHO_LINE);
    }
    expect(fixtureAnswer(null, "<website_pages>\n{}\n</website_pages>")).toBeNull();
  });

  it("a broken claude.json is answered as it is (bad JSON), also for an alias origin", async () => {
    const api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin);
    expect(readLineAnswer(await api.createLine(buildLineRequest(input("https://kaputt.example/"), haiku)))).toMatchObject({ kind: "bad" });
  });

  it("the echo answer quotes the homepage's first 8 words; no homepage text means too little text", () => {
    const text = buildLineRequest(input("https://x.example/", "one two three four five six seven eight nine ten"), haiku).messages[0].content;
    expect(pagesFromUserText(text)).toHaveLength(1);
    expect(echoAnswer(text)).toEqual({
      evidence_source: "homepage",
      evidence_quote: "one two three four five six seven eight",
      line: ECHO_LINE,
      reason_if_null: null,
    });
    const empty = buildLineRequest({ company: { name: "X", country: null, niche: null }, pages: [] }, haiku).messages[0].content;
    expect(echoAnswer(empty)).toEqual({ evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "too_little_text" });
  });

  it("the echo line passes every check with no warning (not the banned 'your homepage', not too general)", () => {
    const text = "Hand-painted resin dragons and griffins for collectors, cast in small series in our workshop.";
    const answer = echoAnswer(buildLineRequest(input("https://x.example/", text), haiku).messages[0].content) as unknown as LineAnswer;
    const r = checkLine({
      answer,
      pages: [{ source: "homepage", title: "Start", text, lang: "en" }],
      companyName: "Anything GmbH",
      countryName: "Germany",
      companyDomain: "x.example",
      avoid: [],
    });
    expect(r.problems).toEqual([]);
    expect(r.flags).toEqual([]);
  });
});

describe("admin API (loopback only)", () => {
  async function admin(method: string, p: string, body?: unknown) {
    const res = await fetch(`${fake.origin}${p}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as unknown };
  }

  it("lists requests, queues faults, sets usage, scripts answers and resets", async () => {
    fake.reset();
    const api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin);
    await api.createLine(buildLineRequest(input("https://unknown.example/"), haiku));
    const listed = await admin("GET", "/__fake/requests");
    expect(listed.status).toBe(200);
    expect(listed.json).toHaveLength(1);
    expect((listed.json as Array<{ path: string }>)[0]!.path).toBe("/v1/messages");

    expect(
      (await admin("POST", "/__fake/fail-next", { route: "POST /v1/messages", fault: { kind: "stop", stopReason: "refusal" }, times: 1 })).status,
    ).toBe(200);
    expect(readLineAnswer(await api.createLine(buildLineRequest(input("https://unknown.example/"), haiku)))).toEqual({ kind: "refusal" });

    expect((await admin("POST", "/__fake/usage", { input: 100, output: 10 })).status).toBe(200);
    expect((await api.createLine(buildLineRequest(input("https://unknown.example/"), haiku))).usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });

    const scripted = { evidence_source: "none", evidence_quote: null, line: null, reason_if_null: "unrelated_business" };
    expect((await admin("POST", "/__fake/script", { contains: "Scripted Co", answer: scripted })).status).toBe(200);
    const read = readLineAnswer(
      await api.createLine(buildLineRequest({ ...input("https://unknown.example/"), company: { name: "Scripted Co", country: null, niche: null } }, haiku)),
    );
    expect(read).toEqual({ kind: "ok", value: scripted });

    expect((await admin("POST", "/__fake/reset")).status).toBe(200);
    expect(fake.requests).toHaveLength(0);
    expect((await api.createLine(buildLineRequest(input("https://unknown.example/"), haiku))).usage.inputTokens).toBe(3_000);
  });

  it("queues a body that breaks off (cutBody) for the manual checks", async () => {
    fake.reset();
    const api = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs: 2_000 });
    expect((await admin("POST", "/__fake/fail-next", { route: "POST /v1/messages", fault: { kind: "cutBody" } })).status).toBe(200);
    await expect(api.createLine(buildLineRequest(input("https://unknown.example/"), haiku))).rejects.toBeInstanceOf(UnreadableAnswerError);
    expect((await admin("POST", "/__fake/fail-next", { route: "POST /v1/messages", fault: { kind: "cutBody", stall: true } })).status).toBe(200);
    const quick = createClaudeApi(FAKE_CLAUDE_KEY, fake.origin, { timeoutMs: 300 });
    await expect(quick.createLine(buildLineRequest(input("https://unknown.example/"), haiku))).rejects.toBeInstanceOf(UnreadableAnswerError);
    fake.reset();
  });

  it("refuses bad admin input", async () => {
    expect((await admin("POST", "/__fake/fail-next", { route: "POST /v3/messages", fault: { kind: "hang" } })).status).toBe(400);
    expect((await admin("POST", "/__fake/fail-next", { route: "POST /v1/messages", fault: { kind: "explode" } })).status).toBe(400);
    expect((await admin("POST", "/__fake/fail-next", { route: "POST /v1/messages", fault: { kind: "status", status: 42 } })).status).toBe(400);
    expect((await admin("POST", "/__fake/usage", { input: -1, output: 1 })).status).toBe(400);
    expect((await admin("POST", "/__fake/script", { contains: "", answer: {} })).status).toBe(400);
    expect((await admin("POST", "/__fake/nothing", {})).status).toBe(404);
    expect(() => fake.failNext("POST /v9/nothing" as never, { kind: "hang" })).toThrow(/Unknown route/);
  });
});

describe("command line", () => {
  it("parses its flags", () => {
    expect(parseCliArgs([])).toEqual({ port: 4020 });
    expect(parseCliArgs(["--port", "0", "--sites", "tests/fixtures/sites", "--input-tokens=100"])).toEqual({
      port: 0,
      sitesDir: path.resolve("tests/fixtures/sites"),
      usage: { input: 100, output: 120 },
    });
    expect(() => parseCliArgs(["--port", "70000"])).toThrow(/--port must be a whole number/);
    expect(() => parseCliArgs(["--sites"])).toThrow("--sites needs a value.");
    expect(() => parseCliArgs(["--nope"])).toThrow(/Unknown option --nope/);
  });

  it("starts the fake, says how to point the app at it, and answers /__fake/requests", async () => {
    const lines: string[] = [];
    const before = { int: process.listeners("SIGINT"), term: process.listeners("SIGTERM") };
    const cliFake = await runCli(["--port", "0"], (l) => lines.push(l));
    try {
      expect(lines[0]).toBe(`Fake Claude listening on ${cliFake.origin}.`);
      expect(lines[1]).toBe(`Set OUTREACH_ANTHROPIC_BASE_URL=${cliFake.origin} for the app. Use the key sk-ant-fake-key.`);
      const res = await fetch(`${cliFake.origin}/__fake/requests`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await cliFake.close();
      // Only the Ctrl+C handlers runCli added; the test runner's own stay.
      for (const l of process.listeners("SIGINT")) if (!before.int.includes(l)) process.removeListener("SIGINT", l);
      for (const l of process.listeners("SIGTERM")) if (!before.term.includes(l)) process.removeListener("SIGTERM", l);
    }
  });
});
