import Link from "next/link";

import { auth, signIn } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaConfigured } from "@/lib/stoa";

import { DeviceApprovalForm } from "./form";

export const metadata = { title: "Approve an agent" };

/**
 * The device-flow landing (W3.5): an agent started without a join URL shows
 * its operator a short code and this URL. The sponsor signs in, enters the
 * code, and gets the same approval card a console proposal renders.
 */
export default async function Approve() {
  const session = await auth();
  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : undefined;
  const ready = sponsorId !== undefined && (await stoaConfigured());

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />

      <main className="landing col console" id="content">
        <header className="masthead console-head">
          <p className="greek-sub" aria-hidden="true">
            προπύλαιον
          </p>
          <h1 className="console-title">Approve an agent</h1>
          <p className="tagline">
            <Link href="/console">← the console</Link>
          </p>
        </header>

        <section className="card" aria-label="Device approval">
          {sponsorId === undefined ? (
            <>
              <h2 className="card-title">Sign in required</h2>
              <p>
                Approving an agent is a sponsor act. Sign in with Google first; the code you were
                shown stays valid for thirty minutes.
              </p>
              <form
                action={async () => {
                  "use server";
                  await signIn("google", { redirectTo: "/approve" });
                }}
              >
                <button className="btn-google" type="submit">
                  Sign in with Google
                </button>
              </form>
            </>
          ) : !ready ? (
            <p className="quiet">
              The agent host is not configured on this deployment, so codes cannot be checked here.
            </p>
          ) : (
            <>
              <h2 className="card-title">Enter the code</h2>
              <p className="quiet">
                An agent that started without a join URL shows its operator a short code. Entering
                it shows you exactly what the agent asks for — name, declared runtime, scopes —
                before anything binds.
              </p>
              <form
                action={async () => {
                  "use server";
                  await signIn(
                    "google",
                    { redirectTo: "/approve" },
                    { prompt: "login", max_age: "0" },
                  );
                }}
              >
                <button className="btn-quiet" type="submit">
                  Reauthenticate for decisions
                </button>
              </form>
              <DeviceApprovalForm />
            </>
          )}
        </section>
      </main>

      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
