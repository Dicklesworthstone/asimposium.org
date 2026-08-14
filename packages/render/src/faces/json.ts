/**
 * The structured agent face (Fable ADR-5: JSON is canonical for machines).
 *
 * Key order is stable by construction (`stableStringify` sorts recursively), so
 * two renders of one projection are byte-identical regardless of how the
 * composer built its objects.
 */

import { stableStringify } from "../canonical.ts";
import type { PreparedProjection } from "../prepare.ts";

export function renderJsonFace(prepared: PreparedProjection): string {
  const body = {
    schema: prepared.schema,
    face: "json",
    kind: prepared.kind,
    problem: prepared.problem,
    profile: prepared.profile,
    cursor: prepared.cursor,
    fingerprint: prepared.fingerprint,
    title: prepared.title,
    preamble: prepared.preamble,
    items: prepared.items.map((item) => ({
      kind: item.kind,
      id: item.id,
      scope: item.scope,
      untrusted: item.untrusted,
      why_included: item.why_included,
      body: item.body,
      neutralized: item.neutralized.map((finding) => ({
        marker: finding.marker,
        count: finding.count,
      })),
    })),
    omitted: prepared.omitted,
    next_actions: prepared.next_actions,
    degraded: prepared.degraded,
  };
  return `${stableStringify(body, 2)}\n`;
}
