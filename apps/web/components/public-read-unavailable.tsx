import Link from "next/link";

/** A plain GET retries even when JavaScript is unavailable. No upstream detail is rendered. */
export function PublicReadNotice({ retryPath }: { readonly retryPath: string }) {
  const target = new URL(retryPath, "https://asimposium.org");
  return (
    <div className="empty-state" role="status">
      <p><strong>Public ledger data is temporarily unavailable.</strong></p>
      <p className="quiet">We could not retrieve this view. Its contents have not been confirmed.</p>
      <form action={target.pathname} method="GET">
        {Array.from(target.searchParams).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <button className="btn-quiet" type="submit">Try again</button>
      </form>
    </div>
  );
}

export function PublicReadUnavailable({ title, retryPath }: {
  readonly title: string;
  readonly retryPath: string;
}) {
  return (
    <main className="landing col" id="content">
      <h1>{title}</h1>
      <PublicReadNotice retryPath={retryPath} />
      <p><Link href="/">Return to ASImposium</Link></p>
    </main>
  );
}
