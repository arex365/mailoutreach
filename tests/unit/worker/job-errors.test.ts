import { describe, expect, it, vi } from "vitest";

// Only the pure helpers are tested here: keep the real database client out of it.
vi.mock("@/server/db", () => ({ db: {}, dbWrite: vi.fn(), dbTx: vi.fn() }));

const { PlainJobError, UNEXPECTED_JOB_ERROR, describeJobError, isUserFacingError, redactText } = await import("@/server/jobs");

describe("which errors people may read as they are", () => {
  it("accepts marked errors and our own plain sentences", () => {
    expect(isUserFacingError(new PlainJobError("The disk is full."))).toBe(true);
    expect(isUserFacingError(new Error("This import no longer exists. Upload the file again from the Import page."))).toBe(true);
    expect(isUserFacingError(Object.assign(new Error("Anything"), { userFacing: true }))).toBe(true);
  });

  it("refuses library and system errors", () => {
    class PrismaClientKnownRequestError extends Error {}
    expect(isUserFacingError(new PrismaClientKnownRequestError("Unique constraint failed"))).toBe(false);
    expect(isUserFacingError(new TypeError("x is not a function"))).toBe(false);
    expect(isUserFacingError(Object.assign(new Error("no such file or directory"), { code: "ENOENT" }))).toBe(false);
    expect(isUserFacingError(new Error("Invalid `prisma.company.create()` invocation:"))).toBe(false);
    expect(isUserFacingError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isUserFacingError(new Error("EPERM: operation not permitted, rename 'a' -> 'b'"))).toBe(false);
    expect(isUserFacingError(new Error(""))).toBe(false);
    expect(isUserFacingError("a string")).toBe(false);
  });
});

describe("describeJobError", () => {
  it("keeps a plain sentence and its optional detail", () => {
    expect(describeJobError(new PlainJobError("Couldn't write the backup file.", "ENOSPC: no space left"))).toEqual({
      error: "Couldn't write the backup file.",
      detail: "ENOSPC: no space left",
    });
    expect(describeJobError(new Error("The disk is full."))).toEqual({ error: "The disk is full.", detail: null });
  });

  it("turns technical errors into one plain sentence and keeps the raw text (redacted) for Details", () => {
    const err = Object.assign(new Error("SQLITE_BUSY: database is locked; password=hunter2hunter2"), { code: "SQLITE_BUSY" });
    const out = describeJobError(err);
    expect(out.error).toBe(UNEXPECTED_JOB_ERROR);
    expect(out.detail).toBe("Error (SQLITE_BUSY): SQLITE_BUSY: database is locked; password: [hidden]");
    expect(describeJobError(new TypeError("Cannot read properties of undefined (reading 'id')")).detail).toBe(
      "TypeError: Cannot read properties of undefined (reading 'id')",
    );
    expect(describeJobError("thrown string")).toEqual({ error: UNEXPECTED_JOB_ERROR, detail: "thrown string" });
  });

  it("hides known secrets everywhere", () => {
    const out = describeJobError(new TypeError("key-abcdef123456 was rejected"), ["key-abcdef123456"]);
    expect(out.detail).toBe("TypeError: [hidden] was rejected");
  });
});

describe("redactText", () => {
  it("hides the credential of an Authorization header, not just the word Basic", () => {
    // base64("api:key-1"): the Basic-auth form of a Mailgun key (M3-DESIGN §3.6).
    const basic = redactText("authorization: Basic YXBpOmtleS0x");
    expect(basic).not.toContain("YXBp");
    expect(basic).toBe("authorization: [hidden]");
    expect(redactText("request failed; Authorization=Bearer abc.def.ghi; retrying")).toBe(
      "request failed; Authorization: [hidden] retrying",
    );
  });

  it("still hides key, token and password pairs", () => {
    expect(redactText("api_key=abc123 token: t0k3n password=hunter2")).toBe(
      "api_key: [hidden] token: [hidden] password: [hidden]",
    );
  });
});
