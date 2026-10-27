"use client";

import type { WorkshopSearchRequest } from "@asimposium/contracts/workshop-search";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { type WorkshopSearchResult, workshopSearchResultHref } from "@/lib/workshop-search";
import { searchPrivateWorkshops } from "./actions";

export function WorkshopSearchForm() {
  const [result, setResult] = useState<WorkshopSearchResult | null>(null);
  const [pending, startTransition] = useTransition();
  const attempt = useRef(0);
  const search = (request: unknown) => {
    const current = ++attempt.current;
    // Results are not retained when the next read fails or when authority may
    // have changed. Query/results stay in this page's memory only.
    setResult(null);
    startTransition(async () => {
      try {
        const next = await searchPrivateWorkshops(request);
        if (current === attempt.current) setResult(next);
      } catch {
        if (current === attempt.current)
          setResult({ ok: false, message: "Private search could not be loaded. Try again." });
      }
    });
  };
  return (
    <section className="card" aria-labelledby="search-title">
      <h2 id="search-title">Find your Fellows’ private drafts</h2>
      <p>
        Search words in titles and stored draft text. Long drafts stored separately are searched
        through their saved extract only; their remaining body and publication fields are not
        searched.
      </p>
      <form
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const optional = (name: string) => {
            const value = form.get(name);
            return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
          };
          search({
            query: form.get("query"),
            ...(optional("fellow_id") ? { fellow_id: optional("fellow_id") } : {}),
            ...(optional("problem_id") ? { problem_id: optional("problem_id") } : {}),
            ...(optional("state") ? { state: optional("state") } : {}),
          });
        }}
      >
        <p>
          <label htmlFor="workshop-search-query">Search words</label>
          <input
            id="workshop-search-query"
            name="query"
            type="search"
            required
            maxLength={160}
            autoComplete="off"
            placeholder="counterexample path"
          />
        </p>
        <p>
          <label htmlFor="workshop-search-fellow">Fellow ID (optional)</label>
          <input id="workshop-search-fellow" name="fellow_id" maxLength={80} autoComplete="off" />
        </p>
        <p>
          <label htmlFor="workshop-search-problem">Problem ID (optional)</label>
          <input id="workshop-search-problem" name="problem_id" maxLength={32} autoComplete="off" />
        </p>
        <p>
          <label htmlFor="workshop-search-state">Draft state</label>
          <select id="workshop-search-state" name="state" defaultValue="">
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="archived">Archived</option>
            <option value="discarded">Discarded</option>
          </select>
        </p>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Searching…" : "Search private drafts"}
        </button>
      </form>
      <div aria-live="polite" aria-busy={pending}>
        {result && !result.ok ? <p role="status">{result.message}</p> : null}
        {result?.ok ? (
          <>
            <h3>Results for “{result.page.query}”</h3>
            {result.page.items.length === 0 ? (
              <p>
                No matching drafts are visible to your account. Try different words or fewer
                filters.
              </p>
            ) : (
              <ul className="workshop-list">
                {result.page.items.map((item) => (
                  <li className="workshop-card" key={item.workshop_id}>
                    <h4>
                      <Link prefetch={false} href={workshopSearchResultHref(item)}>
                        {item.title}
                      </Link>
                    </h4>
                    <p className="quiet">
                      {item.fellow_id} · {item.problem_id} · {item.type} · {item.state} · revision{" "}
                      {item.version}
                    </p>
                    <p className="whitespace-pre-wrap">{item.excerpt}</p>
                    <p className="quiet">
                      {item.body_coverage === "stored-extract"
                        ? "Search coverage: title and saved extract. Open the draft to read its full body."
                        : "Search coverage: title and complete inline draft body."}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {result.page.next_cursor === null ? null : (
              <button
                className="btn"
                type="button"
                disabled={pending}
                onClick={() =>
                  search({
                    ...result.request,
                    after: result.page.next_cursor ?? undefined,
                  } satisfies WorkshopSearchRequest)
                }
              >
                Next matching drafts
              </button>
            )}
          </>
        ) : null}
      </div>
      <p className="quiet">
        Only your current Fellows’ work is searched. Results are ordered by draft ID and do not
        publish or change any draft.
      </p>
    </section>
  );
}
