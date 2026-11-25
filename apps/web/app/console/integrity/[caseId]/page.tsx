import { IntegrityWorkspace } from "@/components/integrity-workspace";
import type { IntegritySearchParams } from "@/lib/integrity-view";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Scientific-integrity cases — ASImposium",
  robots: { index: false, follow: false },
};

export default async function IntegrityPage({ params, searchParams }: {
  readonly params: Promise<{ readonly caseId: string }>;
  readonly searchParams?: Promise<IntegritySearchParams>;
}) {
  const { caseId } = await params;
  return <IntegrityWorkspace audience="sponsor" caseId={caseId} query={(await searchParams) ?? {}} />;
}
