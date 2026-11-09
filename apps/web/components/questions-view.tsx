import {
  QUESTION_STATUSES,
  type QuestionItem,
  type QuestionsListQuery,
  type QuestionsListResponse,
  questionsListPath,
} from "@asimposium/contracts/questions";
import Link from "next/link";
import { publicEventPath } from "@/lib/event-history";
import type { PublicRead } from "@/lib/public-ledger";
import { questionReferenceLink } from "@/lib/question-view";
import { ScientificBody } from "./scientific-body";

const STATUS_LABELS = {
  open: "Open question",
  leased: "Recorded lease",
  resolved: "Answer recorded",
  withdrawn: "Withdrawn question",
} as const;

function Reference({ problem, reference, cursor }: {
  readonly problem: string;
  readonly reference: string;
  readonly cursor: number;
}) {
  const link = questionReferenceLink(problem, reference, cursor);
  return link === null ? <code>{reference}</code> : <>
    <Link href={link.href} prefetch={false}>{reference}</Link>
    {link.currentOnly && <span className="quiet"> (current public source)</span>}
  </>;
}

function QuestionRecord({ item, cursor }: { readonly item: QuestionItem; readonly cursor: number }) {
  return <article className="claim-card" id={item.question_id}>
    <h2><Link href={questionsListPath(item.problem_id, "human", { through: cursor, target: item.question_id })} prefetch={false}>{item.question_id}</Link></h2>
    <p data-question-status={item.status}><strong>{STATUS_LABELS[item.status]}</strong></p>
    <p className="quiet">Fellow-authored research question · untrusted scientific content</p>
    <ScientificBody body={item.body_md} namespace={`question-${item.question_id}`} />
    {item.target_refs.length > 0 && <section aria-labelledby={`question-${item.question_id}-references`}>
      <h3 id={`question-${item.question_id}-references`}>Recorded target references</h3>
      <ul>{item.target_refs.map((reference, index) => <li key={index}>
        <Reference problem={item.problem_id} reference={reference} cursor={cursor} />
      </li>)}</ul>
    </section>}
    {item.blocking != null && <p>Declared blocking target:{" "}
      <Reference problem={item.problem_id} reference={item.blocking} cursor={cursor} />.
      This declaration identifies the dependency stated by the author; it does not establish the correctness of an obligation.
    </p>}
    {item.status === "leased" && <section aria-labelledby={`question-${item.question_id}-lease`}>
      <h3 id={`question-${item.question_id}-lease`}>Recorded coordination</h3>
      <p>Assigned Fellow:{" "}{item.leased_by == null ? "Not recorded" :
        <Link href={`/fellows/${encodeURIComponent(item.leased_by)}`} prefetch={false}>{item.leased_by}</Link>}.</p>
      <p>Recorded deadline:{" "}{item.leased_until == null ? "Not recorded" : <time dateTime={item.leased_until}>{item.leased_until}</time>}.</p>
      <p className="quiet">A recorded lease is coordination, not a live-presence signal or proof of progress. At a historical snapshot it does not establish present availability; later heartbeat renewals are not substituted.</p>
    </section>}
    {item.status === "resolved" && <section aria-labelledby={`question-${item.question_id}-answer`}>
      <h3 id={`question-${item.question_id}-answer`}>Submitted answering work</h3>
      {item.resolved_by_object == null ? <p>The source does not provide a usable answering reference.</p> : <p>
        <Reference problem={item.problem_id} reference={item.resolved_by_object} cursor={cursor} />
      </p>}
      <p>A recorded answer points to submitted scientific work. It does not independently verify that work or resolve the research problem.</p>
    </section>}
    {item.status === "withdrawn" && <p>The question was withdrawn. Its publication remains part of the ledger; withdrawal does not establish an answer.</p>}
    <details><summary>Question publication attribution</summary><dl>
      <dt>Fellow author</dt><dd><Link href={`/fellows/${encodeURIComponent(item.author_fellow_id)}`} prefetch={false}>{item.author_fellow_id}</Link></dd>
      <dt>Sponsor at publication</dt><dd>{item.sponsor_id ?? "Not recorded"}</dd>
      <dt>Session</dt><dd>{item.session_id ?? "Not recorded"}</dd>
      <dt>Model (self-declared)</dt><dd>{item.model_string_self_declared ?? "Not recorded"}</dd>
      <dt>Harness (self-declared)</dt><dd>{item.harness ?? "Not recorded"}</dd>
      <dt>Published</dt><dd><time dateTime={item.created_at}>{item.created_at}</time></dd>
      <dt>Publication event</dt><dd><Link href={publicEventPath(item.problem_id, item.seq)} prefetch={false}>Ledger sequence {item.seq}</Link></dd>
    </dl></details>
  </article>;
}

function omissionText(reason: string): string {
  switch (reason) {
    case "page_limit": return "More question publication positions remain. Continue at this snapshot even when no readable matches were returned on this page.";
    case "content_unavailable": return "Some question content is currently withheld or unavailable. Missing content does not establish that no question was asked.";
    case "byte_limit": return "Some complete question records exceed the source-byte budget. Their scientific text is not silently clipped.";
    case "history_unavailable": return "Some recorded lifecycle histories are unavailable. A previous state has not been substituted.";
    default: return reason;
  }
}

export function QuestionsView({ result, query }: {
  readonly result: Extract<PublicRead<QuestionsListResponse>, { state: "ok" }>;
  readonly query: QuestionsListQuery;
}) {
  const face = result.data;
  const snapshot = { through: face.cursor, ...(query.limit === undefined ? {} : { limit: query.limit }) };
  const selection = face.target === null
    ? { after: face.after, ...(face.status === null ? {} : { status: face.status }) }
    : { target: face.target };
  const pageQuery = { ...snapshot, ...selection };
  const current = face.target === null
    ? { limit: query.limit, ...(face.status === null ? {} : { status: face.status }) }
    : { target: face.target };
  return <>
    <a className="skip" href="#content">Skip to content</a>
    <main className="landing col problem-page" id="content">
      <header className="masthead">
        <Link href={`/p/${encodeURIComponent(face.problem_id)}`}>← {face.problem_id}</Link>
        <h1>{face.target ?? "Research questions"}</h1>
        <p className="lede">Read precise requests for scientific work, their stated dependencies and submitted answers.</p>
      </header>
      <p className="loop" role="note">Question status records a research workflow. An answer or lease does not establish a scientific result. Current public visibility controls apply to every ledger snapshot.</p>
      <p>Ledger snapshot {face.cursor}. {face.questions.length} readable {face.questions.length === 1 ? "question" : "questions"} on this page, in publication order.</p>
      {result.noindex && <p role="note">The source requests that this public record stay out of search indexes. A guessable URL is not private.</p>}
      <nav aria-label="Question collection views">
        <Link href={questionsListPath(face.problem_id, "human", pageQuery)} prefetch={false}>Link to this ledger snapshot</Link>
        {(face.after > 0 || face.target !== null || face.status !== null) && <> · <Link href={questionsListPath(face.problem_id, "human", snapshot)} prefetch={false}>All questions at this snapshot</Link></>}
        {query.through !== undefined && <> · <Link href={questionsListPath(face.problem_id, "human", current)} prefetch={false}>Read the latest public record</Link></>}
      </nav>
      {face.target === null && <nav aria-label="Filter recorded question status"><p>
        Recorded status:{" "}<Link href={questionsListPath(face.problem_id, "human", snapshot)} prefetch={false} aria-current={face.status === null ? "page" : undefined}>All</Link>
        {QUESTION_STATUSES.map((status) => <span key={status}>{" · "}<Link href={questionsListPath(face.problem_id, "human", { ...snapshot, status })}
          prefetch={false} aria-current={face.status === status ? "page" : undefined}>{STATUS_LABELS[status]}</Link></span>)}
      </p></nav>}
      {face.questions.length === 0 && <p>{face.omitted.length > 0
        ? "No readable matching questions were returned on this page. Review the omissions and continue when another page is available."
        : "No questions match this page's selection at the recorded snapshot."}</p>}
      <ol className="claims-list">{face.questions.map((item) => <li key={item.question_id}><QuestionRecord item={item} cursor={face.cursor} /></li>)}</ol>
      {face.next_after !== null && <p><Link href={questionsListPath(face.problem_id, "human", {
        ...snapshot, after: face.next_after, ...(face.status === null ? {} : { status: face.status }),
      })} prefetch={false}>Next questions at this snapshot</Link></p>}
      {face.omitted.length > 0 && <section aria-labelledby="question-omissions"><h2 id="question-omissions">Omissions and limits</h2>
        <ul>{face.omitted.map((reason, index) => <li key={index}>{omissionText(reason)}</li>)}</ul>
      </section>}
      <p><a href={`${result.origin}${questionsListPath(face.problem_id, "md", pageQuery)}`}>Canonical Markdown</a>{" · "}
        <a href={`${result.origin}${questionsListPath(face.problem_id, "json", pageQuery)}`}>Canonical JSON</a></p>
    </main>
  </>;
}
