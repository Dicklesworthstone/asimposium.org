import { describe, expect, test } from "bun:test";
import {
  CANONICAL_CONTENT_LICENSE,
  CANONICAL_PATENT_WARNING_URL,
  CANONICAL_POLICY_URL,
  FORBIDDEN_PRIVATE_KINDS,
  getPublicResourceEntry,
  isForbiddenPrivateResource,
  isPublicResourceKind,
  LICENSE_POLICY_ID,
  listPublicResources,
  PUBLIC_RESOURCE_KINDS,
  PUBLIC_RESOURCE_REGISTRY,
  PublicResourceEntrySchema,
  type PublicResourceKind,
} from "../../src/public-resources.ts";

describe("Public Resource Face Registry (W6.1, bead 92x)", () => {
  test("every public resource entry validates against PublicResourceEntrySchema", () => {
    const entries = listPublicResources();
    expect(entries.length).toBeGreaterThanOrEqual(PUBLIC_RESOURCE_KINDS.length);

    for (const entry of entries) {
      const parsed = PublicResourceEntrySchema.safeParse(entry);
      expect(parsed.success).toBe(true);
      expect(entry.license).toBe(CANONICAL_CONTENT_LICENSE);
      expect(entry.license_policy_id).toBe(LICENSE_POLICY_ID);
      expect(entry.policy_url).toBe(CANONICAL_POLICY_URL);
      expect(entry.patent_warning_url).toBe(CANONICAL_PATENT_WARNING_URL);
    }
  });

  test("every declared public resource kind has an entry in the registry", () => {
    for (const kind of PUBLIC_RESOURCE_KINDS) {
      const entry = getPublicResourceEntry(kind);
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe(kind);
      expect(entry?.agent_markdown_url).toContain(".md");
      expect(entry?.human_route_key.length).toBeGreaterThan(0);
      expect(entry?.allowed_suffixes.length).toBeGreaterThan(0);
    }
  });

  test("forbidden private/workshop/moderation kinds are strictly excluded from public registry", () => {
    const registeredKinds = new Set(PUBLIC_RESOURCE_REGISTRY.map((e) => e.kind as string));
    for (const forbidden of FORBIDDEN_PRIVATE_KINDS) {
      expect(registeredKinds.has(forbidden)).toBe(false);
      expect(isPublicResourceKind(forbidden)).toBe(false);
      expect(isForbiddenPrivateResource(forbidden)).toBe(true);
    }
  });

  test("isForbiddenPrivateResource identifies arbitrary private/workshop/screening variations", () => {
    expect(isForbiddenPrivateResource("workshop-object")).toBe(true);
    expect(isForbiddenPrivateResource("screening-verdict")).toBe(true);
    expect(isForbiddenPrivateResource("private-claim")).toBe(true);
    expect(isForbiddenPrivateResource("problem")).toBe(false);
    expect(isForbiddenPrivateResource("claim")).toBe(false);
  });

  test("late producers are truthfully identified and bounded", () => {
    const lateProduced = PUBLIC_RESOURCE_REGISTRY.filter((e) => e.late_producer !== undefined);
    const lateKinds = new Set(lateProduced.map((e) => e.late_producer));
    expect(lateKinds).toEqual(new Set(["moves", "review-queue", "honors", "stats"]));
  });

  test("URL patterns maintain Diptych invariants (agent markdown face is canonical)", () => {
    for (const entry of PUBLIC_RESOURCE_REGISTRY) {
      expect(entry.agent_markdown_url).toMatch(/\.md($|\?)/);
      expect(entry.allowed_suffixes).toContain(".md");
      if (entry.json_url !== undefined) {
        expect(entry.allowed_suffixes.some((s) => s.includes("json"))).toBe(true);
      }
    }
  });
});
