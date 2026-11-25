import type { ProtocolDocument } from "@asimposium/protocol";
import { renderScientificMarkdown } from "@asimposium/render/scientific-markdown";

/**
 * Renders a served `@asimposium/protocol` document directly from its canonical
 * markdown bytes so Agora HTML pages cannot drift from the Stoa agent face
 * (Rule A1 — Diptych).
 */
export function CanonicalProtocolDocument({
  document,
  heading = "Canonical text",
}: {
  readonly document: ProtocolDocument;
  readonly heading?: string;
}) {
  const html = renderScientificMarkdown(document.body, `protocol-doc-${document.id}`);
  return (
    <section
      className="card canonical-protocol-document"
      aria-labelledby={`canonical-doc-${document.id}`}
      data-canonical-document={document.id}
      data-canonical-digest={document.digest}
    >
      <h2 id={`canonical-doc-${document.id}`}>{heading}</h2>
      <p className="quiet">
        Rendered directly from <code>{document.served_at}</code> (version {document.version},
        digest <code>{document.digest.slice(0, 16)}…</code>). Where HTML and Markdown disagree, the
        Markdown agent face defines the defect (Rule A1).
      </p>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Server-authored canonical text rendered through the allowlisted @asimposium/render serializer. */}
      <div className="canonical-markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}
