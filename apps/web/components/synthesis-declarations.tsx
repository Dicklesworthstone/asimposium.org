import type { SynthesisDraftRecord } from "@asimposium/contracts";
import Link from "next/link";
import { synthesisAnchorLinks, synthesisConsolePath } from "@/lib/synthesis-view";

function DeclaredItems({ items }: { readonly items: readonly string[] }) {
  return <ul>{items.map((text, index) => <li key={index} className="whitespace-pre-wrap break-words">{text}</li>)}</ul>;
}

type SynthesisDetails = Pick<SynthesisDraftRecord,
  "problem_id" | "synthesis_id" | "covers_through" | "anchors" | "selection_policy" |
  "dropped_single_author_count" | "omitted" | "closing_resolution">;

/** Show the sources and declarations that accompany the same digest on the ledger. */
export function SynthesisDeclarations({ item, origin, draft = false }: {
  readonly item: SynthesisDetails;
  readonly origin?: string;
  readonly draft?: boolean;
}) {
  const prefix = draft ? `draft-${item.synthesis_id}` : "synthesis";
  const Heading = draft ? "h4" : "h2";
  const Subheading = draft ? "h5" : "h3";
  const declaration = item.closing_resolution;
  return (
    <>
      <section aria-labelledby={prefix + "-anchors"}>
        <Heading id={prefix + "-anchors"}>Recorded source anchors</Heading>
        <p>Anchors identify the publications the author referenced. A reference does not establish that its summary is correct, or that the source remains available.</p>
        <ol>{item.anchors.map((anchor, index) => {
          const links = synthesisAnchorLinks(item.problem_id, anchor, item.covers_through);
          return <li className="claim-card" key={index}>
            <p><strong>{anchor.target_kind}</strong>{" "}<code>{anchor.target_id}{anchor.target_version === undefined ? "" : `@${anchor.target_version}`}</code></p>
            {anchor.assertion_summary && <p className="whitespace-pre-wrap break-words">Author&apos;s summary: {anchor.assertion_summary}</p>}
            {links.human && <p><Link href={links.human} prefetch={false}>Read the referenced public record</Link></p>}
            {origin && links.agent && <p><a href={`${origin}${links.agent}`}>Read the exact canonical source (JSON)</a></p>}
            {links.event ? <p><Link href={links.event} prefetch={false}>Recorded source event at sequence {anchor.target_seq}</Link></p>
              : <p className="quiet">No exact event sequence was recorded for this anchor.</p>}
            {!links.human && !links.agent && <p className="quiet">This reference has no supported exact object link here; use its recorded event when available.</p>}
          </li>;
        })}</ol>
      </section>
      <section aria-labelledby={prefix + "-selection"}>
        <Heading id={prefix + "-selection"}>Selection policy and declared omissions</Heading>
        <p className="whitespace-pre-wrap break-words">{item.selection_policy}</p>
        <p>{item.dropped_single_author_count} single-author findings were recorded as dropped in this synthesis.</p>
        {item.omitted.length === 0 ? <p>The author declared no omitted items. This is not a guarantee of completeness.</p> : <DeclaredItems items={item.omitted} />}
      </section>
      {declaration && <section aria-labelledby={prefix + "-closing"}>
        <Heading id={prefix + "-closing"}>Author&apos;s closing declaration</Heading>
        <p>Proposed direction: <strong>{declaration.direction}</strong>. Publication does not establish that the problem has been resolved.</p>
        <p>Result claim: <Link href={`/p/${encodeURIComponent(item.problem_id)}/claims/${encodeURIComponent(`${declaration.result_claim.claim_id}@${declaration.result_claim.version}`)}?through=${item.covers_through}`} prefetch={false}>{declaration.result_claim.claim_id}@{declaration.result_claim.version}</Link>.</p>
        <Subheading>Declared verified scope</Subheading><DeclaredItems items={declaration.no_claim_boundary.verified} />
        <Subheading>Declared verification mechanisms</Subheading><DeclaredItems items={declaration.no_claim_boundary.mechanisms} />
        <Subheading>Declared independence tiers</Subheading><DeclaredItems items={declaration.no_claim_boundary.independence_tiers} />
        <Subheading>Remaining external validation</Subheading><DeclaredItems items={declaration.no_claim_boundary.remaining_external_validation} />
        {!draft && <>
          <p><Link href={synthesisConsolePath(item.problem_id, item.synthesis_id)} prefetch={false}>Review this closing synthesis in the sponsor console</Link></p>
          <p className="quiet">The console verifies current sponsor authority and loads this exact publication again before any separate resolution confirmation.</p>
        </>}
      </section>}
    </>
  );
}
