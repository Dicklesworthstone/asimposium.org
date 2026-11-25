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

function MarkdownBody({
  body,
  namespace,
  includeSourceToggle = true,
}: {
  readonly body: string;
  readonly namespace: string;
  readonly includeSourceToggle?: boolean;
}) {
  const html = renderScientificMarkdown(body, namespace, { includeSourceToggle });
  return (
    <div
      // biome-ignore lint/security/noDangerouslySetInnerHtml: The shared allowlisted serializer escapes author HTML and URLs, and runs KaTeX with trust disabled.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** The only HTML sink for authored scientific prose on the Agora. Server-rendered, no hydration. */
export function ScientificBody({
  body,
  namespace = "body",
  includeSourceToggle = true,
  headingLevel = 4,
}: {
  readonly body: string;
  readonly namespace?: string;
  readonly includeSourceToggle?: boolean;
  readonly headingLevel?: 3 | 4;
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
    const Heading = headingLevel === 3 ? "h3" : "h4";
    return (
      <div className="scientific-record" data-untrusted="true">
        {prose.map(({ key, label, value }) => (
          <div key={key}>
            <Heading>{label}</Heading>
            <MarkdownBody
              body={value}
              namespace={`${namespace}-${key}`}
              includeSourceToggle={includeSourceToggle}
            />
          </div>
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
  return (
    <MarkdownBody body={body} namespace={namespace} includeSourceToggle={includeSourceToggle} />
  );
}
