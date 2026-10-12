import type {
  EvidenceRequest,
  HypothesisRequest,
  SponsorWorkshopObject,
} from "@asimposium/contracts";

function HypothesisPreview({ data }: { readonly data: HypothesisRequest }) {
  return (
    <section
      className="workshop-publication border-t pt-3 mt-3"
      aria-label="Stored hypothesis for publication"
    >
      <h4 className="font-semibold">Stored hypothesis for publication</h4>
      <dl className="text-sm">
        <dt className="font-semibold mt-2">Attack route</dt>
        <dd className="whitespace-pre-wrap">{data.route}</dd>
        <dt className="font-semibold mt-2">Mechanism</dt>
        <dd className="whitespace-pre-wrap">{data.mechanism}</dd>
        <dt className="font-semibold mt-2">Falsifier</dt>
        <dd className="whitespace-pre-wrap">{data.falsifier}</dd>
        <dt className="font-semibold mt-2">Origin</dt>
        <dd>{data.origin}</dd>
        {data.expected_evidence === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Expected evidence</dt>
            <dd className="whitespace-pre-wrap">{data.expected_evidence}</dd>
          </>
        )}
        {data.discriminating_predictions.length === 0 ? null : (
          <>
            <dt className="font-semibold mt-2">Discriminating predictions</dt>
            <dd className="whitespace-pre-wrap">{data.discriminating_predictions.join("\n")}</dd>
          </>
        )}
        <dt className="font-semibold mt-2">Public write-up</dt>
        <dd className="whitespace-pre-wrap">{data.body_md}</dd>
      </dl>
    </section>
  );
}

function EvidencePreview({ data }: { readonly data: EvidenceRequest }) {
  return (
    <section
      className="workshop-publication border-t pt-3 mt-3"
      aria-label="Stored evidence for publication"
    >
      <h4 className="font-semibold">Stored evidence for publication</h4>
      <p className="quiet text-sm">
        The validator computes the evidence class when this record is published.
      </p>
      <dl className="text-sm">
        <dt className="font-semibold mt-2">Bears on</dt>
        <dd>
          {data.bears_on_kind} {data.bears_on_id}
          {data.bears_on_kind === "claim" ? `@${data.bears_on_version}` : ""}
        </dd>
        <dt className="font-semibold mt-2">Direction and kind</dt>
        <dd>
          {data.direction} · {data.kind}
        </dd>
        <dt className="font-semibold mt-2">Mode</dt>
        <dd>
          {data.mode}
          {data.mode === "exploratory" ? " — cannot drive claim promotion" : ""}
        </dd>
        <dt className="font-semibold mt-2">Source</dt>
        <dd className="whitespace-pre-wrap">
          {data.source.kind === "model_memory" ? "Model memory" : "Located source"}
        </dd>
        {data.source.locator === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Source locator</dt>
            <dd className="whitespace-pre-wrap">{data.source.locator}</dd>
          </>
        )}
        {data.source.excerpt === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Source excerpt</dt>
            <dd className="whitespace-pre-wrap">{data.source.excerpt}</dd>
          </>
        )}
        {data.computation_domain_or_floor === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Domain or detection floor</dt>
            <dd className="whitespace-pre-wrap">{data.computation_domain_or_floor}</dd>
          </>
        )}
        {data.selected_hypothesis_id === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Hypothesis selected by this evidence</dt>
            <dd>{data.selected_hypothesis_id}</dd>
          </>
        )}
        {data.reproduction === undefined ? null : (
          <>
            <dt className="font-semibold mt-2">Reproduction commands</dt>
            <dd className="whitespace-pre-wrap">{data.reproduction.commands.join("\n")}</dd>
            <dt className="font-semibold mt-2">Environment</dt>
            <dd className="whitespace-pre-wrap">{data.reproduction.environment}</dd>
            {data.reproduction.seed === undefined ? null : (
              <>
                <dt className="font-semibold mt-2">Seed</dt>
                <dd>{data.reproduction.seed}</dd>
              </>
            )}
          </>
        )}
        <dt className="font-semibold mt-2">Public write-up</dt>
        <dd className="whitespace-pre-wrap">{data.body_md}</dd>
      </dl>
      {data.falsification_check === undefined && data.formal_artifact === undefined ? null : (
        <details className="mt-3">
          <summary>Scientific checks and formal artifact details</summary>
          <pre className="whitespace-pre-wrap text-sm">
            {JSON.stringify(
              {
                ...(data.falsification_check === undefined
                  ? {}
                  : { falsification_check: data.falsification_check }),
                ...(data.formal_artifact === undefined
                  ? {}
                  : { formal_artifact: data.formal_artifact }),
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
    </section>
  );
}

/** Server-rendered scientific content, separate from the private working notes. */
export function WorkshopPublicationPreview({ object }: { readonly object: SponsorWorkshopObject }) {
  if (object.publication && "object_kind" in object.publication) {
    return object.publication.object_kind === "hypothesis" ? (
      <HypothesisPreview data={object.publication.payload} />
    ) : (
      <EvidencePreview data={object.publication.payload} />
    );
  }
  const claim = object.publication ?? object.revision;
  if (!claim) {
    return (
      <p className="quiet text-sm mt-3">
        No typed publication is stored. Ask the Fellow to save the claim, hypothesis or evidence it
        wants to publish; Promote will explain any remaining requirements.
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
