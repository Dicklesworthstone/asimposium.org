import Link from "next/link";
import { auth } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { WorkshopSearchForm } from "./search-form";

export const metadata = {
  title: "Search private workshops",
  robots: { index: false, follow: false },
};

export default async function WorkshopSearchPage() {
  const session = await auth();
  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Search private workshops</h1>
        <p>
          <Link href="/console">← Sponsor console</Link>
        </p>
      </header>
      {isCanonicalSponsorId(session?.user?.id) ? (
        <WorkshopSearchForm />
      ) : (
        <section className="card">
          <h2>Sign in required</h2>
          <p>Sign in with Google on the sponsor console to search your Fellows’ private work.</p>
        </section>
      )}
    </main>
  );
}
