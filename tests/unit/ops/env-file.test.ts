import path from "node:path";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import {
  databasePathFromUrl,
  databaseUrlFor,
  dedupeEnvText,
  duplicateEnvKeys,
  generateEncryptionKey,
  getEnvValue,
  isValidEncryptionKey,
  newEnvFileText,
  parseEnv,
  setEnvValue,
  validatePublicUrl,
} from "../../../scripts/lib/env-file.mjs";

const SAMPLE = [
  "# Polygon Paradise Outreach settings. Keep a copy of this file somewhere safe.",
  'DATABASE_URL="file:./data/app.db"',
  'APP_ENCRYPTION_KEY="abc+/def=="',
  "APP_PUBLIC_URL=",
  "export SETUP_CODE_HASH='1234' # comment",
  "UNQUOTED=value with spaces # and a comment",
  "",
].join("\r\n");

describe("parseEnv / getEnvValue", () => {
  it("reads quoted, unquoted, empty and exported values and skips comments", () => {
    const env = parseEnv(SAMPLE);
    expect(env.DATABASE_URL).toBe("file:./data/app.db");
    expect(env.APP_ENCRYPTION_KEY).toBe("abc+/def==");
    expect(env.APP_PUBLIC_URL).toBe("");
    expect(env.SETUP_CODE_HASH).toBe("1234");
    expect(env.UNQUOTED).toBe("value with spaces");
    expect(Object.keys(env)).not.toContain("#");
  });

  it("tells a missing key (undefined) from an empty one", () => {
    expect(getEnvValue(SAMPLE, "APP_PUBLIC_URL")).toBe("");
    expect(getEnvValue(SAMPLE, "NOPE")).toBeUndefined();
  });

  it("uses the LAST line of a repeated key, like dotenv and Next.js", () => {
    expect(getEnvValue("A=1\nA=2\n", "A")).toBe("2");
    expect(getEnvValue('APP_PUBLIC_URL=""\r\n# note\r\nAPP_PUBLIC_URL="https://outreach.example.com"\r\n', "APP_PUBLIC_URL")).toBe(
      "https://outreach.example.com",
    );
  });

  it("reads the same values as dotenv, which the app and the background sender use", () => {
    const text = [
      'DATABASE_URL="file:./data/app.db"',
      'APP_PUBLIC_URL=""',
      "SETUP_CODE_HASH='aaa'",
      'DATABASE_URL="file:./data/other.db"',
      "APP_PUBLIC_URL=https://outreach.example.com # added by hand",
      "SETUP_CODE_HASH=\"bbb\"",
      "",
    ].join("\r\n");
    const ours = parseEnv(text);
    const theirs = dotenv.parse(text);
    for (const key of ["DATABASE_URL", "APP_PUBLIC_URL", "SETUP_CODE_HASH"]) expect(ours[key], key).toBe(theirs[key]);
  });

  it("lists keys that are set more than once", () => {
    expect(duplicateEnvKeys("A=1\nB=2\n# A=3\nA=4\nC=5\nB=6\n")).toEqual(["A", "B"]);
    expect(duplicateEnvKeys(SAMPLE)).toEqual([]);
  });
});

describe("dedupeEnvText", () => {
  it("turns the lines a later line overrides into comments, keeping what the app uses", () => {
    const text = 'A="1"\r\nB="x"\r\nA="2"\r\n';
    const r = dedupeEnvText(text);
    expect(r.keys).toEqual(["A"]);
    expect(r.text.split("\r\n")).toEqual(['# Not used: a later A line replaces this one. A="1"', 'B="x"', 'A="2"', ""]);
    expect(parseEnv(r.text)).toEqual(parseEnv(text));
  });

  it("leaves a file without duplicates exactly as it is", () => {
    expect(dedupeEnvText(SAMPLE)).toEqual({ text: SAMPLE, keys: [] });
  });
});

describe("setEnvValue", () => {
  it("replaces only the one line and keeps every other line byte for byte", () => {
    const next = setEnvValue(SAMPLE, "APP_PUBLIC_URL", "https://outreach.example.com");
    const before = SAMPLE.split("\r\n");
    const after = next.split("\r\n");
    expect(after).toHaveLength(before.length);
    after.forEach((line, i) => {
      if (before[i]!.startsWith("APP_PUBLIC_URL")) expect(line).toBe('APP_PUBLIC_URL="https://outreach.example.com"');
      else expect(line).toBe(before[i]);
    });
  });

  it("keeps CRLF files CRLF and LF files LF", () => {
    expect(setEnvValue("A=1\r\nB=2\r\n", "B", "3")).toBe('A=1\r\nB="3"\r\n');
    expect(setEnvValue("A=1\nB=2\n", "B", "3")).toBe('A=1\nB="3"\n');
  });

  it("appends a missing key with exactly one line break before it", () => {
    expect(setEnvValue("A=1\n\n\n", "B", "x")).toBe('A=1\nB="x"\n');
    expect(setEnvValue("A=1", "B", "x")).toBe('A=1\nB="x"\n');
    expect(setEnvValue("", "B", "x")).toBe('B="x"\n');
  });

  it("never touches a commented-out line with the same name", () => {
    const text = '# APP_PUBLIC_URL="old"\nAPP_PUBLIC_URL=""\n';
    expect(setEnvValue(text, "APP_PUBLIC_URL", "https://a.example.com")).toBe(
      '# APP_PUBLIC_URL="old"\nAPP_PUBLIC_URL="https://a.example.com"\n',
    );
  });

  it("updates the LAST line of a repeated key (the one the app reads) and comments out the earlier ones", () => {
    const text = 'SETUP_CODE_HASH=""\nDATABASE_URL="file:./data/app.db"\nSETUP_CODE_HASH="old"\n';
    const next = setEnvValue(text, "SETUP_CODE_HASH", "new");
    expect(next).toBe(
      '# Not used: a later SETUP_CODE_HASH line replaces this one. SETUP_CODE_HASH=""\nDATABASE_URL="file:./data/app.db"\nSETUP_CODE_HASH="new"\n',
    );
    expect(getEnvValue(next, "SETUP_CODE_HASH")).toBe("new");
    expect(dotenv.parse(next).SETUP_CODE_HASH).toBe("new");
    expect(duplicateEnvKeys(next)).toEqual([]);
  });

  it("refuses values that would break the file", () => {
    expect(() => setEnvValue("", "A", 'say "hi"')).toThrow();
    expect(() => setEnvValue("", "A", "two\nlines")).toThrow();
  });
});

describe("encryption key", () => {
  it("generates 32 random bytes as base64", () => {
    const a = generateEncryptionKey();
    const b = generateEncryptionKey();
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isValidEncryptionKey(a)).toBe(true);
  });

  it("rejects keys of the wrong length or with junk", () => {
    expect(isValidEncryptionKey(Buffer.alloc(16).toString("base64"))).toBe(false);
    expect(isValidEncryptionKey("not base64 at all!")).toBe(false);
    expect(isValidEncryptionKey("")).toBe(false);
    expect(isValidEncryptionKey(undefined)).toBe(false);
  });
});

describe("new settings file", () => {
  it("has the four settings in the order the app expects", () => {
    const text = newEnvFileText({ databaseUrl: "file:./data/app.db", encryptionKey: "KEY" });
    const env = parseEnv(text);
    expect(env).toEqual({ DATABASE_URL: "file:./data/app.db", APP_ENCRYPTION_KEY: "KEY", APP_PUBLIC_URL: "", SETUP_CODE_HASH: "" });
    expect(text.startsWith("# Polygon Paradise Outreach settings")).toBe(true);
  });
});

describe("validatePublicUrl", () => {
  it("accepts https addresses and keeps only the origin", () => {
    expect(validatePublicUrl("https://outreach.example.com")).toEqual({ ok: true, value: "https://outreach.example.com" });
    expect(validatePublicUrl("  HTTPS://Outreach.Example.com/  ")).toEqual({ ok: true, value: "https://outreach.example.com" });
  });

  it("treats empty and 'none' as not set up", () => {
    expect(validatePublicUrl("")).toEqual({ ok: true, value: "" });
    expect(validatePublicUrl("none")).toEqual({ ok: true, value: "" });
  });

  it("explains what is wrong", () => {
    expect(validatePublicUrl("http://outreach.example.com")).toMatchObject({ ok: false, error: expect.stringContaining("https://") });
    expect(validatePublicUrl("outreach.example.com")).toMatchObject({ ok: false });
    expect(validatePublicUrl("https://localhost")).toMatchObject({ ok: false });
    expect(validatePublicUrl("https://outreach.example.com/app")).toMatchObject({
      ok: false,
      error: expect.stringContaining("https://outreach.example.com"),
    });
  });
});

describe("database paths", () => {
  const root = path.resolve("C:/proj");

  it("makes relative URLs inside the project and absolute ones outside", () => {
    expect(databaseUrlFor("data/test/x.db", root)).toBe("file:./data/test/x.db");
    expect(databaseUrlFor(path.resolve("D:/elsewhere/x.db"), root)).toBe("file:D:/elsewhere/x.db");
  });

  it("resolves URLs the same way the app does", () => {
    expect(databasePathFromUrl("file:./data/app.db", root)).toBe(path.join(root, "data", "app.db"));
    expect(databasePathFromUrl(undefined, root)).toBe(path.join(root, "data", "app.db"));
    expect(databasePathFromUrl("file:D:/x/y.db", root)).toBe(path.normalize("D:/x/y.db"));
  });
});
