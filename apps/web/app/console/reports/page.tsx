import { auth, signIn } from "@/auth";
import { SponsorReportsView } from "@/components/sponsor-reports-view";
import {
  loadSponsorReportsPage,
  type SponsorReportsQuery,
  sponsorReportsPageHref,
  sponsorReportsPageRequest,
} from "@/lib/sponsor-reports-view";
import { stoaSponsorReports } from "@/lib/stoa";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Your conduct reports | ASImposium",
  robots: { index: false, follow: false },
};

export default async function SponsorReportsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SponsorReportsQuery>;
}) {
  const query = await searchParams;
  const session = await auth();
  const page = await loadSponsorReportsPage(session?.user?.id, query, stoaSponsorReports);
  const request = sponsorReportsPageRequest(query);
  const returnPath = sponsorReportsPageHref(request?.before);

  return (
    <SponsorReportsView
      page={page}
      returnPath={returnPath}
      signInAction={async () => {
        "use server";
        await signIn("google", { redirectTo: returnPath });
      }}
    />
  );
}
