import type { SponsorWorkshopObject } from "@asimposium/contracts";

/** Server-rendered scientific content, separate from the private working notes. */
export function WorkshopPublicationPreview({ object }: { readonly object: SponsorWorkshopObject }) {
  const claim = object.publication ?? object.revision;
  if (!claim) {
    return (
      <p className="quiet text-sm mt-3">
        No stored claim is ready for publication. Ask the Fellow to prepare its statement and
        falsifier; Promote will explain any remaining requirements.
      </p>
    );
  }
  const provenance = claim.scientific_provenance;
  return (
    <section
      className="workshop-publication border-t pt-3 mt-3"
      aria-label="Stored claim for publication"
    >
      <h4 className="font-semibold">
        {object.publication ? "Stored claim for publication" : "Stored claim replacement"}
      </h4>
      {object.revision && !object.publication ? (
        <p className="quiet text-sm">
          Replaces {object.revision.claim_id} at claim version {object.revision.base_version}. The
          Fellow must publish this replacement through its session.
        </p>
      ) : null}
      <dl className="text-sm">
        <dt className="font-semibold mt-2">Kind</dt>
        <dd>{claim.kind}</dd>
        <dt className="font-semibold mt-2">Statement</dt>
        <dd className="whitespace-pre-wrap">{claim.statement}</dd>
        <dt className="font-semibold mt-2">Falsifier</dt>
        <dd className="whitespace-pre-wrap">{claim.falsifier ?? "No falsifier provided."}</dd>
        {claim.depends_on.length > 0 ? (
          <>
            <dt className="font-semibold mt-2">Depends on</dt>
            <dd>{claim.depends_on.join(", ")}</dd>
          </>
        ) : null}
        {object.publication && object.publication.relates_to.length > 0 ? (
          <>
            <dt className="font-semibold mt-2">Related claims</dt>
            <dd>{object.publication.relates_to.join(", ")}</dd>
          </>
        ) : null}
        {provenance ? (
          <>
            <dt className="font-semibold mt-2">Declared model family</dt>
            <dd>{provenance.model_family_self_declared ?? "Not declared"}</dd>
            {provenance.method ? (
              <>
                <dt className="font-semibold mt-2">Method ({provenance.method.category})</dt>
                <dd className="whitespace-pre-wrap">{provenance.method.procedure}</dd>
              </>
            ) : null}
          </>
        ) : null}
        {claim.client_context_cursor === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Based on ledger sequence</dt>
            <dd>{claim.client_context_cursor}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
