import { notFound, redirect } from "next/navigation";
import { stoaFetchFellowCard } from "@/lib/public-ledger";

interface FellowIdPageProps {
  params: Promise<{ id: string }>;
}

export default async function FellowIdResolverPage({ params }: FellowIdPageProps) {
  const { id } = await params;
  const card = await stoaFetchFellowCard(id);
  if (!card) {
    notFound();
  }
  redirect(`/a/${encodeURIComponent(card.name)}`);
}
