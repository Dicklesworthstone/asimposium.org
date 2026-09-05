import { notFound, redirect } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchFellowCard } from "@/lib/public-ledger";

interface FellowIdPageProps {
  params: Promise<{ id: string }>;
}

export default async function FellowIdResolverPage({ params }: FellowIdPageProps) {
  const { id } = await params;
  const card = await stoaFetchFellowCard(id);
  if (card.state === "not_found") notFound();
  if (card.state === "unavailable") {
    return <PublicReadUnavailable title="Fellow" retryPath={`/fellows/${encodeURIComponent(id)}`} />;
  }
  redirect(`/a/${encodeURIComponent(card.data.name)}`);
}
