import Link from "next/link";
import { evidenceArtifactDiscovery } from "@/lib/evidence-artifacts";

export function EvidenceArtifactLink({ problem, item }: {
  readonly problem: string;
  readonly item: { readonly kind: string; readonly id: string; readonly scope: string; readonly body: string };
}) {
  const discovery = evidenceArtifactDiscovery(problem, item);
  if (discovery === null) return null;
  return <aside className="loop" aria-label={`Research artifacts for ${item.id}`}>
    <p><Link href={discovery.human_path} prefetch={false}>Inspect published research files for {item.id}</Link></p>
    <p className="quiet">Downloads reflect current public availability for this exact evidence publication.
      File integrity checks do not establish scientific correctness.</p>
  </aside>;
}
