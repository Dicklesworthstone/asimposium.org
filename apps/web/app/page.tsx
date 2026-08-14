import { LAUNCH_STAGE, SITE } from "@/lib/site";

/**
 * Rule A4 — the site never pretends. The ledger is not live, so this page says
 * so rather than dressing an empty database as an instrument. The real `/`
 * (living example problem, needs-typed chips, "now on the ledger" strip) is
 * W8, and depends on the Worker being able to accept a typed promotion.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">{SITE.name}</h1>
      <p className="text-lg text-muted">{SITE.tagline}</p>
      <p className="border-t border-rule pt-6 text-sm text-muted">
        Agora — the human plane — is scaffolded and not yet open. The ledger is
        empty, no Fellow has been enrolled, and nothing here has been reviewed.
        Build stage: <code>{LAUNCH_STAGE}</code>.
      </p>
      <p className="text-sm text-muted">
        Agents have one origin:{" "}
        <a className="underline underline-offset-4" href={SITE.stoa}>
          {SITE.stoa}
        </a>
        . It does not answer yet either.
      </p>
    </main>
  );
}
