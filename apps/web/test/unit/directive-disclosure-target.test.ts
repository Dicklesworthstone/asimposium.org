import { expect, test } from "bun:test";
import {
  directiveDisclosureClaimHref,
  directiveDisclosureDocumentHref,
  directiveDisclosureHref,
  directiveDisclosureSelection,
  isDirectiveDisclosureTarget,
} from "../../lib/directive-disclosure-target";

const target = { problemId: "P-4DSP", claimId: "C-7", version: 2 };

test("disclosure navigation retains one exact claim version without selecting a sponsor", () => {
  const link = new URL(directiveDisclosureHref(target), "https://asimposium.org");
  expect(link.pathname).toBe("/console/disclosures");
  expect(directiveDisclosureSelection(Object.fromEntries(link.searchParams)))
    .toEqual({ state: "selected", target });
  expect(directiveDisclosureClaimHref(target)).toBe("/p/P-4DSP/claims/C-7%402");
  expect(directiveDisclosureSelection({})).toEqual({ state: "empty" });
  expect(directiveDisclosureHref()).toBe("/console/disclosures");
});

test("canonical disclosure links stay on the configured trusted Stoa origin", () => {
  const eventId = `DD-${"a".repeat(32)}`;
  expect(directiveDisclosureDocumentHref(target, eventId, "https://a-staging.asimposium.org"))
    .toBe(`https://a-staging.asimposium.org/p/P-4DSP/disclosures/${eventId}.md`);
  for (const origin of [undefined, "https://attacker.invalid", "https://a.asimposium.org/evil", "javascript:alert(1)"]) {
    expect(directiveDisclosureDocumentHref(target, eventId, origin)).toBeNull();
  }
  for (const id of [eventId + "\n", "../private", eventId + "?secret=fixture"]) {
    expect(directiveDisclosureDocumentHref(target, id, "https://a.asimposium.org")).toBeNull();
  }
});

test("partial, ambiguous and noncanonical disclosure selections cannot become signed targets", () => {
  const valid = { problem: "P-4DSP", claim: "C-7", version: "2" };
  for (const candidate of [
    { ...valid, sponsor: "usr_other" }, { ...valid, through: "35" },
    { ...valid, problem: ["P-4DSP", "P-OTHER"] },
    { ...valid, claim: ["C-7", "C-8"] }, { ...valid, version: ["2", "3"] },
    { ...valid, problem: "https://attacker.invalid" },
    { ...valid, problem: "P-4DSP\n" }, { ...valid, claim: "C-7\n" },
    { ...valid, claim: "C-7@2" }, { ...valid, claim: "../C-7" },
    { ...valid, version: "02" }, { ...valid, version: "2\n" },
    { ...valid, version: "0" }, { ...valid, version: "-1" },
    { ...valid, version: "1e2" }, { ...valid, version: "1.5" },
    { ...valid, version: "9007199254740992" },
    { ...valid, version: undefined }, { problem: valid.problem },
  ]) expect(directiveDisclosureSelection(candidate)).toEqual({ state: "invalid" });
  for (const candidate of [null, [], {}, { ...target, version: Infinity },
    { ...target, version: 1.5 }, { ...target, sponsorId: "usr_other" }]) {
    expect(isDirectiveDisclosureTarget(candidate)).toBe(false);
  }
});
