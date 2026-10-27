import {
  type SessionDeclaredMetadata,
  type SessionProvenance,
  SessionProvenanceSchema,
} from "@asimposium/contracts";
import { protocolVersionPair } from "@asimposium/protocol";
import type { FellowCredentialBinding } from "../enrollment/service.ts";

/** A session cannot redeclare the identity its sponsor approved (ADR-3).
 * Neither the attempted values nor credential material belong in diagnostics. */
export class SessionDeclarationMismatchError extends Error {
  constructor() {
    super("SESSION_DECLARATION_MISMATCH");
  }
}

/** Capture once, inside session creation. Later document amendments and
 * idempotent retries must never replace the rules served when a session opened.
 * An enrolled model string remains a self-declaration, not an attestation that
 * the platform observed a particular model or harness execute. */
export function snapshotSessionProvenance(
  binding: Pick<FellowCredentialBinding, "model" | "harness">,
  openedVia: "explicit" | "implicit",
  declared?: SessionDeclaredMetadata,
): SessionProvenance {
  if (
    declared !== undefined &&
    (declared.model !== binding.model || declared.harness !== binding.harness)
  ) {
    throw new SessionDeclarationMismatchError();
  }
  return SessionProvenanceSchema.parse({
    declared: declared ?? { model: binding.model, harness: binding.harness },
    attestation: "self_declared",
    documents: protocolVersionPair(),
    observed: { opened_via: openedVia },
  });
}

/** Legacy rows deliberately have no snapshot. Do not infer historical
 * acceptance from today's protocol or fill it in during a read. Malformed
 * non-null storage is a read failure, never a fabricated legacy session. */
export function readSessionProvenance(raw: string | null): SessionProvenance | null {
  return raw === null ? null : SessionProvenanceSchema.parse(JSON.parse(raw));
}

/** A captured snapshot can exceed a small pack's entire byte budget for legal
 * runtime declarations. Its absence from this face is different from legacy
 * null: disclose the exact authenticated read that retains the complete bytes. */
export function sessionPackProvenanceBudgetOmission(sessionId: string): {
  readonly reason: string;
  readonly detail: string;
} {
  return {
    reason: "session_provenance_budget",
    detail: `Full captured snapshot: GET /v1/sessions/${sessionId}.`,
  };
}

export function sessionPackProvenanceReference(
  sessionId: string,
  provenance: SessionProvenance,
): string {
  return `Session terms pair SHA-256: ${provenance.documents.pair_digest}. Full self-declared identity and terms: GET /v1/sessions/${sessionId}.`;
}

/** The complete declared tools note is available on the owning status read.
 * Packs retain the identity and served-document snapshot without making a private
 * free-text note mandatory overhead in every small token bucket. */
export function sessionPackProvenance(
  sessionId: string,
  provenance: SessionProvenance | null,
): {
  readonly provenance: SessionProvenance | null;
  readonly omitted: readonly { readonly reason: string; readonly detail: string }[];
} {
  if (provenance === null) {
    return {
      provenance: null,
      omitted: [
        {
          reason: "session_provenance_missing",
          detail: "This historical session has no recorded identity and protocol/policy snapshot.",
        },
      ],
    };
  }
  const { tools_note: toolsNote, ...declared } = provenance.declared;
  return {
    provenance: { ...provenance, declared },
    omitted:
      toolsNote === undefined
        ? []
        : [
            {
              reason: "session_provenance_detail",
              detail: `The declared tools note is available from the owning GET /v1/sessions/${sessionId} status read.`,
            },
          ],
  };
}
