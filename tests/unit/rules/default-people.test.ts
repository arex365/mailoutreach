import { describe, expect, it } from "vitest";
import { pickDefaultPeople, pickDefaultPerson, tickedPeopleWarning, type DefaultPickPerson } from "@/core/rules/default-people";

const p = (id: number, over: Partial<DefaultPickPerson> = {}): DefaultPickPerson => ({
  id,
  name: `Person ${id}`,
  isGeneric: false,
  emailNorm: `p${id}@acme.de`,
  verificationStatus: null,
  ...over,
});

describe("who is ticked by default", () => {
  it("picks the first person with a valid check, even when others come first", () => {
    const people = [p(1), p(2, { verificationStatus: "CATCH_ALL" }), p(3, { verificationStatus: "VALID" }), p(4, { verificationStatus: "VALID" })];
    expect(pickDefaultPeople(people)).toEqual([3]);
  });

  it("otherwise picks the first named person with an email", () => {
    const people = [
      p(1, { name: "General inbox", isGeneric: true, emailNorm: "info@acme.de" }),
      p(2, { emailNorm: null }),
      p(3, { name: "Anna Berg" }),
      p(4, { name: "Bob" }),
    ];
    expect(pickDefaultPerson(people)).toBe(3);
  });

  it("falls back to the General inbox", () => {
    const people = [p(1, { emailNorm: null }), p(2, { name: "General inbox", isGeneric: true, emailNorm: "info@acme.de" })];
    expect(pickDefaultPeople(people)).toEqual([2]);
  });

  it("never picks someone who can't be emailed", () => {
    const people = [p(1, { verificationStatus: "VALID", eligible: false }), p(2, { name: "Bob" })];
    expect(pickDefaultPeople(people)).toEqual([2]);
    expect(pickDefaultPeople([p(1, { eligible: false }), p(2, { emailNorm: null })])).toEqual([]);
    expect(pickDefaultPeople([])).toEqual([]);
  });

  it("uses an unnamed person with an email as the last resort", () => {
    expect(pickDefaultPeople([p(1, { name: "" })])).toEqual([1]);
  });

  it("warns when more than one person at a company is ticked", () => {
    expect(tickedPeopleWarning(0)).toBeNull();
    expect(tickedPeopleWarning(1)).toBeNull();
    expect(tickedPeopleWarning(2)).toBe("2 people at this company are ticked. Each of them gets the emails.");
  });
});
