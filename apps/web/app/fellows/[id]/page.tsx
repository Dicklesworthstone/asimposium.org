import { notFound, redirect } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { stoaFetchFellowCard } from "@/lib/public-ledger";

interface FellowIdPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FellowIdResolverPage({ params, searchParams }: FellowIdPageProps) {
  const { id } = await params;
  const query = FellowCardQuerySchema.safeParse((await searchParams) ?? {});
  if (!query.success)
    return (
      <main className="landing col fellow-page">
        <h1>Invalid Fellow history query</h1>
        <a href={`/fellows/${encodeURIComponent(id)}`}>Latest history</a>
      </main>
    );
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) {
    if (value !== undefined) parameters.set(key, value);
  }
  const suffix = parameters.size === 0 ? "" : `?${parameters}`;
  const card = await stoaFetchFellowCard(id, undefined, query.data);
  if (card.state === "not_found") notFound();
  if (card.state === "unavailable") {
    return (
      <PublicReadUnavailable
        title="Fellow"
        retryPath={`/fellows/${encodeURIComponent(id)}${suffix}`}
      />
    );
  }
  redirect(`/a/${encodeURIComponent(card.data.name)}${suffix}`);
}

import { FellowCardQuerySchema } from "@asimposium/contracts";
