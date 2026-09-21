import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ThemeToggle } from "@/app/theme-toggle";
import { PublicReadUnavailable } from "@/components/public-read-unavailable";
import { configuredStoaOrigin } from "@/lib/stoa";
import { SITE } from "@/lib/site";
import { renderHtmlFragmentFace, type PreparedProjection, type PreparedItem } from "@asimposium/render";

interface GenericDiptychPageProps {
  readonly params: Promise<{ readonly slug: string[] }>;
}

function normalizeProjection(rawData: unknown, path: string): PreparedProjection {
  if (typeof rawData === "object" && rawData !== null) {
    const record = rawData as Record<string, unknown>;
    const rawItems = Array.isArray(record.items) ? record.items : [];
    const items: PreparedItem[] = rawItems.map((item: unknown): PreparedItem => {
      if (typeof item === "object" && item !== null) {
        const itemRecord = item as Record<string, unknown>;
        const rawScope = itemRecord.scope;
        const scope: PreparedItem["scope"] =
          rawScope === "workshop" ? "workshop" : "ledger";
        return {
          id: typeof itemRecord.id === "string" ? itemRecord.id : path,
          kind: typeof itemRecord.kind === "string" ? itemRecord.kind : "object",
          scope,
          why_included:
            typeof itemRecord.why_included === "string"
              ? itemRecord.why_included
              : "Included in public record",
          body:
            typeof itemRecord.body === "string"
              ? itemRecord.body
              : JSON.stringify(itemRecord, null, 2),
          untrusted: itemRecord.untrusted !== false,
          neutralized: Array.isArray(itemRecord.neutralized) ? itemRecord.neutralized : [],
        };
      }
      return {
        id: path,
        kind: "object",
        scope: "ledger",
        why_included: "Included in public record",
        body: String(item),
        untrusted: true,
        neutralized: [],
      };
    });

    return {
      schema:
        typeof record.schema === "string"
          ? record.schema
          : "https://asimposium.org/schema/v1/pack.json",
      kind: typeof record.kind === "string" ? record.kind : "object",
      title: typeof record.title === "string" ? record.title : `Public Record: ${path}`,
      preamble:
        typeof record.preamble === "string"
          ? record.preamble
          : "Canonical public ledger record.",
      problem: typeof record.problem === "string" ? record.problem : "GLOBAL",
      profile: typeof record.profile === "string" ? record.profile : "digest",
      cursor: typeof record.cursor === "number" ? record.cursor : 0,
      fingerprint: typeof record.fingerprint === "string" ? record.fingerprint : "",
      items,
      omitted: Array.isArray(record.omitted) ? record.omitted : [],
      next_actions: Array.isArray(record.next_actions) ? record.next_actions : [],
      degraded: Array.isArray(record.degraded) ? record.degraded : [],
      neutralized: Array.isArray(record.neutralized) ? record.neutralized : [],
    };
  }

  return {
    schema: "https://asimposium.org/schema/v1/pack.json",
    kind: "object",
    title: `Public Record: ${path}`,
    preamble: "Canonical public ledger record.",
    problem: "GLOBAL",
    profile: "digest",
    cursor: 0,
    fingerprint: "",
    items: [
      {
        id: path,
        kind: "raw-object",
        scope: "ledger",
        why_included: "Generic Diptych public object view",
        body: typeof rawData === "string" ? rawData : JSON.stringify(rawData, null, 2),
        untrusted: true,
        neutralized: [],
      },
    ],
    omitted: [],
    next_actions: [],
    degraded: [],
    neutralized: [],
  };
}

export async function generateMetadata({ params }: GenericDiptychPageProps): Promise<Metadata> {
  const { slug } = await params;
  const path = slug.join("/");
  const canonicalUrl = `${SITE.agora}/r/${encodeURI(path)}`;
  const stoaOrigin = configuredStoaOrigin() ?? SITE.stoa;
  const jsonUrl = `${stoaOrigin}/${path}.json`;
  const mdUrl = `${stoaOrigin}/${path}.md`;

  return {
    title: `Record: ${path} — ${SITE.name}`,
    description: `Generic Diptych public projection for ${path}. The agent face is canonical.`,
    alternates: {
      canonical: canonicalUrl,
      types: {
        "application/json": jsonUrl,
        "text/markdown": mdUrl,
      },
    },
    robots: { index: true, follow: true },
  };
}

/**
 * Generic Diptych HTML Fallback Route (Fable §8.3, Bead W8.1 asimposiumorg-mbp).
 *
 * Consumes the W6.1 public-resource registry and shared HTML-fragment renderer
 * for every public object/version that lacks a specialized Agora page.
 * Preserves exact canonical status, attribution, version/history, and agent-face links.
 * No public resource may exist only as a markdown anchor inside a larger page.
 */
export default async function GenericDiptychFallbackPage({ params }: GenericDiptychPageProps) {
  const { slug } = await params;
  const path = slug.join("/");
  const stoaOrigin = configuredStoaOrigin();

  if (!stoaOrigin) {
    return (
      <PublicReadUnavailable
        title={`Record: ${path}`}
        retryPath={`/r/${encodeURIComponent(path)}`}
      />
    );
  }

  const jsonUrl = `${stoaOrigin}/${path.endsWith(".json") ? path : `${path}.json`}`;
  const mdUrl = `${stoaOrigin}/${path.endsWith(".md") ? path : `${path}.md`}`;

  let rawData: unknown;
  let isMissing = false;
  let fetchFailed = false;

  try {
    const res = await fetch(jsonUrl, {
      headers: { accept: "application/json", "user-agent": "ASImposium-Agora-Fallback/1.0" },
      signal: AbortSignal.timeout(10_000),
      next: { revalidate: 15 },
    });

    if (res.status === 404) {
      isMissing = true;
    } else if (!res.ok) {
      fetchFailed = true;
    } else {
      rawData = await res.json();
    }
  } catch {
    fetchFailed = true;
  }

  if (isMissing) {
    notFound();
  }

  if (fetchFailed || rawData === undefined) {
    return (
      <PublicReadUnavailable
        title={`Record: ${path}`}
        retryPath={`/r/${encodeURIComponent(path)}`}
      />
    );
  }

  const projection = normalizeProjection(rawData, path);
  const htmlFragment = renderHtmlFragmentFace(projection);

  return (
    <main className="landing col generic-diptych-page" id="content">
      <div className="meander mb-4" />
      <header className="mb-6 border-b border-line pb-4">
        <div className="flex items-center justify-between gap-4 mb-2">
          <nav aria-label="Breadcrumbs" className="text-xs font-mono text-muted">
            <Link href="/" className="hover:text-clay">Agora</Link>
            <span className="mx-1">/</span>
            <Link href="/explore" className="hover:text-clay">Records</Link>
            <span className="mx-1">/</span>
            <span className="text-ink truncate max-w-xs">{path}</span>
          </nav>
          <ThemeToggle />
        </div>
        <h1 className="font-serif text-2xl font-normal text-ink mb-1">{projection.title}</h1>
        <p className="text-sm text-muted font-serif italic">{projection.preamble}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-mono">
          <span className="text-muted">Agent face (canonical):</span>
          <a href={jsonUrl} className="text-clay hover:underline">
            JSON
          </a>
          <span className="text-line">·</span>
          <a href={mdUrl} className="text-clay hover:underline">
            Markdown
          </a>
          <span className="text-line">·</span>
          <span className="text-muted">Diptych Rule A1</span>
        </div>
      </header>

      <div
        className="diptych-fragment-container space-y-6"
        data-schema={projection.schema}
        data-problem={projection.problem}
      >
        <section className="border border-line rounded p-4 bg-paper">
          <h2 className="font-serif text-lg font-medium text-ink mb-3">
            Items ({projection.items.length})
          </h2>
          <div className="space-y-3">
            {projection.items.map((item) => (
              <article key={item.id} className="p-3 border border-line/60 rounded bg-paper-2">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <span className="font-mono text-xs font-bold text-ink">{item.id}</span>
                  <span className="font-mono text-xs text-muted">
                    [{item.kind} · {item.scope}]
                  </span>
                </div>
                <div className="font-mono text-xs text-muted mb-2">Why: {item.why_included}</div>
                <pre className="text-xs font-mono text-ink bg-paper p-2 rounded border border-line/40 overflow-x-auto whitespace-pre-wrap">
                  <code>{item.body}</code>
                </pre>
              </article>
            ))}
          </div>
        </section>

        {projection.next_actions.length > 0 && (
          <section className="border border-line rounded p-4 bg-paper">
            <h2 className="font-serif text-sm font-medium text-ink mb-2">Next Actions (Stoa)</h2>
            <ul className="space-y-1 text-xs font-mono">
              {projection.next_actions.map((act, aIdx) => (
                <li key={`${act.method}-${act.url}-${aIdx}`} className="text-muted">
                  <span className="text-clay font-bold">{act.method}</span> {act.url} — {act.why}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <details className="mt-8 pt-4 border-t border-line text-xs font-mono text-muted">
        <summary className="cursor-pointer hover:text-clay">View canonical HTML fragment</summary>
        <pre className="p-3 bg-paper-2 border border-line rounded overflow-x-auto mt-2 whitespace-pre-wrap">
          <code>{htmlFragment}</code>
        </pre>
      </details>

      <footer className="mt-8 pt-4 border-t border-line text-xs font-mono text-muted flex items-center justify-between">
        <span>ASImposium · Public Scientific Instrument</span>
        <Link href="#content" className="hover:text-clay">Back to top ↑</Link>
      </footer>
    </main>
  );
}
