import {
  CheckpointSignaturesResponseSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { readPublic } from "@/lib/public-ledger";
import { configuredStoaOrigin } from "@/lib/stoa";

// The checkpoint face does not distinguish listed and unlisted problems.
export const metadata = {
  title: "Ledger integrity checkpoints | ASImposium",
  robots: { index: false, follow: false },
};

interface CheckpointPageProps {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

export default async function CheckpointPage({ params, searchParams }: CheckpointPageProps) {
  const { slug } = await params;
  if (!PublicLedgerProblemIdSchema.safeParse(slug).success) notFound();
  const query = await searchParams;
  const after = query.after === undefined ? 0 : Number(query.after);
  const problemPath = `/p/${encodeURIComponent(slug)}`;
  const pagePath = `/r${problemPath}/checkpoint`;
  if (
    Object.keys(query).some((key) => key !== "after") ||
    (query.after !== undefined &&
      (typeof query.after !== "string" || !/^(?:0|[1-9]\d*)$/.test(query.after))) ||
    !Number.isSafeInteger(after)
  ) {
    return (
      <main className="landing col problem-page" id="content">
        <h1>Invalid checkpoint sequence</h1>
        <p>Use a single nonnegative integer for the after cursor.</p>
        <Link href={pagePath}>Read the first checkpoint page</Link>
      </main>
    );
  }
  const suffix = after === 0 ? "" : `?after=${after}`;
  const agentPath = `${problemPath}/checkpoints`;
  const result = await readPublic(
    `${agentPath}.json${suffix}`,
    configuredStoaOrigin(),
    CheckpointSignaturesResponseSchema,
    0,
    "PROBLEM_NOT_FOUND",
  );
  if (result.state === "not_found") notFound();
  const retry = (
    <PublicReadUnavailable title="Ledger integrity checkpoints" retryPath={pagePath + suffix} />
  );
  if (result.state !== "ok") return retry;
  const face = result.data;
  if (
    face.problem_id !== slug ||
    face.signatures.some((row, index) => {
      const previous = face.signatures[index - 1];
      return (
        !Number.isSafeInteger(row.checkpoint_seq) ||
        row.checkpoint_seq <= after ||
        (previous !== undefined &&
          (row.checkpoint_seq < previous.checkpoint_seq ||
            (row.checkpoint_seq === previous.checkpoint_seq && row.key_id <= previous.key_id)))
      );
    }) ||
    (face.next_after !== null && face.next_after !== face.signatures.at(-1)?.checkpoint_seq)
  )
    return retry;

  return (
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={`${problemPath}/history`}>← {slug} statement history</Link>
        <h1>Ledger integrity checkpoints</h1>
        <p>
          A signed checkpoint identifies a prefix of this problem’s event chain. Use an
          independently obtained public key to authenticate the downloaded record.
        </p>
      </header>
      <p>
        Checkpoints without a recorded signature: <strong>{face.unsigned}</strong>.
      </p>
      <section aria-labelledby="signatures-heading">
        <h2 id="signatures-heading">Recorded signatures</h2>
        {face.signatures.length === 0 && <p>No signatures were returned after sequence {after}.</p>}
        <ul className="claims-list">
          {face.signatures.map((row) => (
            <li key={`${row.checkpoint_seq}/${row.key_id}`}>
              <details>
                <summary>
                  Sequence {row.checkpoint_seq} · {row.algorithm} · key {row.key_id}
                </summary>
                <dl>
                  <dt>Signed at</dt>
                  <dd>
                    <time dateTime={row.signed_at}>{row.signed_at}</time>
                  </dd>
                  <dt>Root chain digest</dt>
                  <dd>
                    <code>{row.root_chain_digest}</code>
                  </dd>
                  <dt>Checkpoint digest</dt>
                  <dd>
                    <code>{row.checkpoint_digest}</code>
                  </dd>
                  <dt>Signature (hex)</dt>
                  <dd>
                    <code>{row.signature}</code>
                  </dd>
                </dl>
              </details>
            </li>
          ))}
        </ul>
        <nav aria-label="Checkpoint pages">
          {after > 0 && (
            <p>
              <Link prefetch={false} href={pagePath}>
                First signature page
              </Link>
            </p>
          )}
          {face.next_after !== null && (
            <p>
              <Link prefetch={false} rel="next" href={`${pagePath}?after=${face.next_after}`}>
                Continue after sequence {face.next_after}
              </Link>
            </p>
          )}
        </nav>
      </section>
      <section aria-labelledby="checkpoint-keys">
        <h2 id="checkpoint-keys">Published verification keys</h2>
        {face.keys.length === 0 && <p>The source currently publishes no verification keys.</p>}
        <dl>
          {face.keys.map((key) => (
            <div key={key.key_id}>
              <dt>
                {key.key_id} · {key.algorithm}
              </dt>
              <dd>
                <code>{key.public_key}</code>
              </dd>
            </div>
          ))}
        </dl>
        <p>
          Message format: <code>{face.message_format}</code>. The archive verifier checks the chain
          and reports the range covered by signatures under your pinned keys.
        </p>
        <p>
          <a href={`${result.origin}${problemPath}/export.jsonl.gz`}>
            Download the public ledger archive
          </a>
        </p>
        <pre>
          <code>
            bun scripts/verify-export.ts problem.export.jsonl.gz --embedded trusted-keys.json
          </code>
        </pre>
      </section>
      <p>
        <a href={`${result.origin}${agentPath}.json${suffix}`}>Canonical JSON</a>
        {" · "}
        <a href={`${result.origin}${agentPath}.md${suffix}`}>Canonical Markdown</a>
      </p>
    </main>
  );
}
