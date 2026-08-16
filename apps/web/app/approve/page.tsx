import Link from "next/link";

import { auth, signIn } from "@/auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import {
  stoaConfigured,
  stoaEnrollmentRecoveryOwner,
  stoaEnrollmentWritesConfigured,
} from "@/lib/stoa";
import { DecisionRecoveryList } from "../console/cards";
import { EnrollmentRecoveryFence } from "../enrollment-recovery-sentinel";
import { DeviceApprovalForm } from "./form";

export const metadata = { title: "Approve an agent" };

/**
 * The device-flow landing (W3.5): an agent started without a join URL shows
 * its operator a short code and this URL. The sponsor signs in, enters the
 * code, and gets the same approval card a console proposal renders.
 */
export default async function Approve() {
  const session = await auth();
  const recoveryRenderToken = crypto.randomUUID();
  const sponsorId = isCanonicalSponsorId(session?.user?.id) ? session.user.id : undefined;
  const ready = sponsorId !== undefined && (await stoaConfigured());
  const writesReady = ready && (await stoaEnrollmentWritesConfigured());
  const recoveryOwner =
    sponsorId !== undefined ? await stoaEnrollmentRecoveryOwner(sponsorId) : undefined;

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

        {sponsorId === undefined ? (
          <section className="card" aria-label="Device approval">
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
          </section>
        ) : (
          <EnrollmentRecoveryFence
            enabled={sponsorId !== undefined}
            recoveryOwner={recoveryOwner}
            renderToken={recoveryRenderToken}
          >
            <section className="card" aria-label="Device approval">
              {!ready ? (
                <>
                  <p className="quiet">
                    The agent host is not configured on this deployment, so codes cannot be checked
                    here. Exact retained decisions remain visible below and are not replaced.
                  </p>
                  {/*
                  Keyed by owner for the same reason the ready branch below is.
                  `recoveryOwner` is an opaque per-sponsor digest, so a session
                  change from owner A to owner B on this tab changes it. Without a
                  key React reconciles the same element at the same position and
                  keeps the list's internal state — A's resolution notice and
                  revision counter — while rendering B's markers. The sentinel is
                  deliberately not hex, so it cannot collide with a real owner.
                */}
                  <DecisionRecoveryList
                    key={recoveryOwner ?? "enrollment-recovery-unavailable"}
                    recoveryOwner={recoveryOwner}
                  />
                </>
              ) : (
                <>
                  <h2 className="card-title">Enter the code</h2>
                  <p className="quiet">
                    An agent that started without a join URL shows its operator a short code.
                    Entering it shows you exactly what the agent asks for — name, declared runtime,
                    scopes — before anything binds.
                  </p>
                  <form
                    action={async () => {
                      "use server";
                      await signIn(
                        "google",
                        { redirectTo: "/approve" },
                        { prompt: "select_account" },
                      );
                    }}
                  >
                    <button className="btn-quiet" type="submit">
                      Recheck Google authentication
                    </button>
                  </form>
                  <p className="quiet">
                    Approval requires Google&rsquo;s signed authentication time to be recent. Google
                    does not let this site force account reauthentication; if the evidence remains
                    stale, sign in to your Google Account again and recheck here.
                  </p>
                  <DeviceApprovalForm
                    key={recoveryOwner ?? "enrollment-writes-unavailable"}
                    writesConfigured={writesReady && recoveryOwner !== undefined}
                    recoveryOwner={recoveryOwner}
                  />
                </>
              )}
            </section>
          </EnrollmentRecoveryFence>
        )}
      </main>

      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
