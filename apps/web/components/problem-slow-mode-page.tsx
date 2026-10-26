import { ProblemIdSchema } from "@asimposium/contracts";
import Link from "next/link";
import { signIn } from "@/auth";
import {
  problemSlowModeSession,
  type SlowModeAudience,
  slowModeAuthIsRecent,
} from "@/lib/problem-slow-mode";
import { stoaProblemSlowMode } from "@/lib/stoa";
import { ProblemSlowModeControl } from "./problem-slow-mode-control";

export interface ProblemSlowModePageProps {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

/** One selected problem means one bounded private read, even for large consoles. */
export async function ProblemSlowModePage({
  audience,
  searchParams,
}: ProblemSlowModePageProps & { readonly audience: SlowModeAudience }) {
  const query = await searchParams;
  const validQuery = Object.keys(query).every((key) => key === "problem") &&
    (query.problem === undefined || ProblemIdSchema.safeParse(query.problem).success);
  const problemId = validQuery && typeof query.problem === "string" ? query.problem : undefined;
  const basePath = audience === "operator" ? "/admin/slow-mode" : "/console/slow-mode";
  const returnPath = problemId === undefined ? basePath : `${basePath}?problem=${encodeURIComponent(problemId)}`;
  const session = await problemSlowModeSession(audience);
  const result = session.state === "authorized" && problemId !== undefined
    ? await stoaProblemSlowMode(session.principalId, audience, problemId)
    : undefined;
  const canChange = session.state === "authorized" && slowModeAuthIsRecent(session.authIssuedAt);

  return (
    <main className="landing col console" id="content">
      <header className="masthead console-head">
        <h1 className="console-title">Temporary publication limit</h1>
        <p><Link href={audience === "operator" ? "/admin" : "/console"}>← {audience === "operator" ? "Operator" : "Sponsor"} console</Link></p>
        <p>Inspect the current mode before setting a temporary limit or clearing it.</p>
      </header>
      {session.state === "forbidden" ? (
        <p role="alert">This account is not authorized for operator controls.</p>
      ) : session.state === "unauthenticated" ? (
        <p>Sign in to inspect publication limits for problems you may manage.</p>
      ) : (
        <>
          {audience === "sponsor" ? <p>You must be the current explicit steward of the published problem. Stoa verifies that authority on every read and change.</p> : null}
          {!validQuery ? <p role="alert">Choose one valid problem identifier. Other filters and repeated values are not supported.</p> : null}
          <form action={basePath} method="get" className="card">
            <label>
              Published problem identifier
              <input name="problem" defaultValue={problemId ?? ""} required maxLength={128} placeholder="P-SP4D" />
            </label>
            <button className="btn-quiet" type="submit">Inspect current mode</button>
          </form>
          {result === undefined ? null : !result.ok ? (
            <section className="card" aria-labelledby="slow-mode-unavailable">
              <h2 id="slow-mode-unavailable">Current mode unavailable</h2>
              <p role="alert">
                {result.reason === "unconfigured"
                  ? "Publication limit controls are not configured on this deployment."
                  : result.reason === "refused" && result.status === 404
                    ? "The published problem is unavailable to this account. Sponsors must be its current explicit steward."
                    : "The current mode could not be verified. Reload before attempting a change."}
              </p>
              <p><a href={returnPath}>Reload the current mode</a></p>
            </section>
          ) : (
            <ProblemSlowModeControl
              key={`${audience}:${result.data.problem_id}:${result.data.revision}:${session.authIssuedAt}`}
              audience={audience}
              initial={result.data}
              canChange={canChange}
              returnPath={returnPath}
            />
          )}
        </>
      )}
      {session.state !== "forbidden" && !canChange ? (
        <section className="card" aria-labelledby="slow-mode-auth-heading">
          <h2 id="slow-mode-auth-heading">{session.state === "unauthenticated" ? "Sign in" : "Recent authentication required"}</h2>
          <p>Changes require Google authentication within the last 15 minutes.</p>
          <form action={async () => {
            "use server";
            await signIn("google", { redirectTo: returnPath }, { prompt: "select_account" });
          }}>
            <button className="btn-google" type="submit">{session.state === "unauthenticated" ? "Sign in with Google" : "Re-authenticate with Google"}</button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
