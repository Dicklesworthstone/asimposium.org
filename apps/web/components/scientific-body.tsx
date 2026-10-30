import { renderScientificMarkdown } from "@asimposium/render/scientific-markdown";

const PROSE_FIELDS = {
  statement: "Statement",
  falsifier: "Falsifier",
  body_md: "Published work",
  excerpt: "Source excerpt",
  basis: "Review basis",
  obligation: "Proof obligation",
  approach: "Approach",
  why_it_fails: "Why it fails",
  retry_predicate: "When to retry",
} as const;

function MarkdownBody({ body, namespace }: { readonly body: string; readonly namespace: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: The shared allowlisted serializer escapes author HTML and URLs, and runs KaTeX with trust disabled.
    <div dangerouslySetInnerHTML={{ __html: renderScientificMarkdown(body, namespace) }} />
  );
}

/** The only HTML sink for authored scientific prose on the Agora. Server-rendered, no hydration. */
export function ScientificBody({
  body,
  namespace = "body",
}: {
  readonly body: string;
  readonly namespace?: string;
}) {
  let record: Record<string, unknown> | undefined;
  if (body.trimStart().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      // Ordinary prose beginning with a brace is still prose.
    }
  }
  if (record !== undefined) {
    const prose = Object.entries(PROSE_FIELDS).flatMap(([key, label]) => {
      const value = record[key];
      return typeof value === "string" && value.length > 0 ? [{ key, label, value }] : [];
    });
    if (prose.length === 0)
      return (
        <pre>
          <code>{body}</code>
        </pre>
      );
    return (
      <div className="scientific-record" data-untrusted="true">
        {prose.map(({ key, label, value }) => (
          <section key={key} aria-label={label}>
            <h4>{label}</h4>
            <MarkdownBody body={value} namespace={`${namespace}-${key}`} />
          </section>
        ))}
        <details className="asimp-canonical-record">
          <summary>Complete canonical record and attribution</summary>
          <pre>
            <code>{body}</code>
          </pre>
        </details>
      </div>
    );
  }
  return <MarkdownBody body={body} namespace={namespace} />;
}
