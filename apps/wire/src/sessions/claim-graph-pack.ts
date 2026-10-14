import type { PackCandidate } from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import {
  CLAIM_GRAPH_BOUNDARY, CLAIM_GRAPH_ROOT_LIMIT, readClaimGraph, type ClaimGraphSnapshotReader,
} from "../ledger/claim-graph-read.ts";
import type { LedgerPackSection } from "./ledger-pack.ts";

/** Graph paths are derived ledger data, never trusted instructions. Selection
 * policy is separate system context. A bounded summary keeps the entire
 * limiting path rather than truncating it into an apparently complete proof.
 * Exact claim faces provide the full statement, provenance, evidence and
 * reviews at the same cut. Typed relations are composed separately: assertions
 * such as "implies" never become dependency evidence by appearing in a graph.
 */
export async function readClaimGraphPack(
  db: D1Database, problem: string, cursor: number, loadSnapshot?: ClaimGraphSnapshotReader,
): Promise<LedgerPackSection> {
  const context = (body: string): PackCandidate => ({
    kind: "standing-context", id: "SYS-claim-graph-selection", scope: "system", untrusted: false,
    tokens: 1, body, why_included: "state the bounded graph selection and its epistemic limits",
    stable_prefix: 10,
    composed_section: { profile: "claim-graph", name: "weakest-link-paths" },
  });
  try {
    const result = await readClaimGraph(db, problem, cursor, loadSnapshot);
    const candidates: PackCandidate[] = [];
    const omitted = [...result.omitted];
    for (const [index, graph] of result.graphs.entries()) {
      // The graph reader whitelists every field and every string is a validated
      // ID, path or computed-state token; there is no source prose in this body.
      // The shared renderer still treats it as untrusted and fences/escapes it.
      const body = JSON.stringify(graph);
      if (new TextEncoder().encode(body).length > 18000) {
        omitted.push({ reason: "item_too_large", detail: `claim-graph:${graph.target}: whole path summary omitted` });
        continue;
      }
      // The renderer caps item IDs at 64 characters, while a valid exact
      // claim target may already occupy all 64. This is a stable item key,
      // not a source digest or an additional scientific identity.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(graph.target));
      const itemKey = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
      candidates.push({
        kind: "claim-graph-path", id: `GRAPH-${itemKey}`, scope: "ledger", untrusted: true,
        tokens: 1, body,
        why_included: "selected exact claim version with its canonical limiting premise path and independent own standing",
        stable_prefix: 11 + index,
      });
    }
    const status = !result.scopeAvailable
      ? "Claim graph source is unavailable at this cut; no empty-graph conclusion is supported."
      : result.rootsExamined === 0 && omitted.length === 0
        ? "No published claim heads are recorded at this cursor."
        : `${result.rootsExamined} root snapshot(s) examined (limit ${CLAIM_GRAPH_ROOT_LIMIT}); ${candidates.length} path summary candidate(s). ${result.truncated ? "Other current roots are outside this selection." : ""} Available candidates may still be omitted by the pack budget.`;
    return { candidates: [context(`${status} ${CLAIM_GRAPH_BOUNDARY}`), ...candidates], omitted };
  } catch {
    // A graph-source failure must not erase independently readable relation
    // assertions. Do not echo SQL, payloads or private identifiers in errors.
    return {
      candidates: [context(`Claim graph assessment is temporarily unavailable. No evidence ceiling or empty graph is inferred. ${CLAIM_GRAPH_BOUNDARY}`)],
      omitted: [{ reason: "content_unavailable", detail: "claim-graph: refresh the graph pack before relying on a path assessment" }],
    };
  }
}
