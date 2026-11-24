import Link from "next/link";
import {
  INTEGRITY_CASE_PUBLIC_NOTICE,
  type PublicIntegrityNoticesResponse,
} from "@asimposium/contracts/integrity-cases";
import { integrityNoticesPath } from "@/lib/integrity-view";
import { IntegrityPublication } from "./integrity-case-view";

/** Render only the deliberately narrow public projection, never a private case. */
export function IntegrityNoticesView({ page, after }: {
  readonly page: PublicIntegrityNoticesResponse;
  readonly after?: string;
}) {
  return <main className="landing col problem-page" id="content">
    <header className="masthead">
      <h1>Scientific-integrity notices</h1>
      <p><Link href={"/p/" + encodeURIComponent(page.problem_id)}>← {page.problem_id}</Link></p>
      <p>These notices reflect current public visibility. Any private concern, sponsor response, outcome and rationale remain in the case workspace.</p>
      <p><a href={integrityNoticesPath(page.problem_id, "json", after)}>JSON</a>{" · "}
        <a href={integrityNoticesPath(page.problem_id, "md", after)}>Markdown</a></p>
    </header>
    {after !== undefined ? <p><Link href={integrityNoticesPath(page.problem_id)}>Read notices from the start</Link></p> : null}
    {page.notices.length === 0 ? <p>{page.has_more
      ? "No currently readable notice appears in this segment. Continue to inspect the next segment."
      : "No currently readable public integrity notices appear on this page."}</p> :
      <ol className="col">{page.notices.map((notice) => <li className="card" key={notice.case_id}>
        <h2>{notice.case_id}</h2>
        <p>{INTEGRITY_CASE_PUBLIC_NOTICE}</p>
        <p>{notice.state === "open" ? "Review open" : "Review concluded"}</p>
        <p>Opened <time dateTime={notice.opened_at}>{notice.opened_at}</time>{" · "}
          updated <time dateTime={notice.updated_at}>{notice.updated_at}</time></p>
        <h3>Source publication</h3><IntegrityPublication pin={notice.source} />
        {notice.corrections.length > 0 ? <div><h3>Published correction references</h3>
          {notice.corrections.map((pin) => <IntegrityPublication key={pin.event_id} pin={pin} />)}</div> : null}
      </li>)}</ol>}
    {page.has_more && page.next_after !== null ? <p><Link
      href={integrityNoticesPath(page.problem_id, "human", page.next_after)}>
      Continue through public notices
    </Link></p> : null}
  </main>;
}
