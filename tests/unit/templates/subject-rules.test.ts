import { describe, expect, it } from "vitest";
import { FIRST_SUBJECT_OUTLOOK_WARNING, FIRST_SUBJECT_REPLY_ERROR, firstSubjectProblem } from "@/core/templates/subject-rules";

const error = { level: "error", text: FIRST_SUBJECT_REPLY_ERROR };
const warning = { level: "warning", text: FIRST_SUBJECT_OUTLOOK_WARNING };

describe("firstSubjectProblem (M4-DESIGN §2.13)", () => {
  it("uses the design's sentences", () => {
    expect(FIRST_SUBJECT_REPLY_ERROR).toBe(
      "Don't start a first email with “Re:” or “Fwd:”. Gmail's rules forbid it for emails that aren't real replies. Follow-ups get “Re:” automatically.",
    );
    expect(FIRST_SUBJECT_OUTLOOK_WARNING).toBe(
      "Outlook would show the follow-ups as a separate conversation, because the subject starts with a short word and a colon. Reword the start of the subject.",
    );
  });

  const table: Array<[string, typeof error | typeof warning | null]> = [
    ["Re: 3D models for your shop", error],
    ["RE: 3D models", error],
    ["re: models", error],
    ["Re : models", error],
    ["Re:models", error],
    ["  Re: models", error],
    ["Fwd: 3D models", error],
    ["FW: 3D models", error],
    ["Fw: 3D models", error],
    ["fwd : models", error],
    ["Art: new models", warning],
    ["FYI: new models", warning],
    ["AW: new models", warning],
    ["Neu: Modelle", warning],
    ["Ä: x", warning],
    ["Art : new models", warning],
    ["3D: new models", null],
    ["3D models for your shop", null],
    ["Reply to your post", null],
    ["Report: 3D trends", null],
    ["Art:no space", null],
    ["Fwdx: models", null],
    ["", null],
  ];

  it.each(table)("%j", (subject, want) => {
    expect(firstSubjectProblem(subject)).toEqual(want);
  });

  it("ignores anything that isn't a string", () => {
    expect(firstSubjectProblem(undefined as unknown as string)).toBeNull();
  });
});
