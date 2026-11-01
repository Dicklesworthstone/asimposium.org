/**
 * One GFM + math pipeline for scientific prose (Fable §14.3).
 * Remark parses; an allowlisted serializer emits HTML through the existing
 * sanitizer. Raw HTML and arbitrary AST attributes never become markup.
 */
import type { Definition, FootnoteDefinition, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { contentFingerprint } from "./canonical.ts";
import { renderMathHtml } from "./math.ts";
import { escapeHtml, neutralizeUntrustedBody } from "./sanitize.ts";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_RENDER_DEPTH = 64;
const MAX_MATH_EXPRESSIONS = 128;

interface RenderContext {
  readonly source: string;
  readonly definitions: Map<string, Definition>;
  readonly footnotes: Map<string, FootnoteDefinition>;
  readonly footnoteOrder: string[];
  readonly namespace: string;
  mathCount: number;
}

/** Only explicit web URLs and same-site paths/fragments become navigation. */
function safeHref(value: string): string | undefined {
  if (/[\p{Cc}\p{Cf}\s\\]/u.test(value)) return undefined;
  if (value.startsWith("#")) return value;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // Unresolved paths and unknown schemes stay legible text.
  }
  return undefined;
}

function link(body: string, url: string, title?: string | null): string {
  const href = safeHref(url);
  if (href === undefined) return `${body} <code>${escapeHtml(url)}</code>`;
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(href)}"${titleAttribute} rel="nofollow noopener noreferrer" referrerpolicy="no-referrer">${body}</a>`;
}

function sourceFor(node: RootContent, context: RenderContext): string {
  return context.source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
}

function renderNodes(nodes: readonly RootContent[], context: RenderContext, depth: number): string {
  return nodes.map((node) => renderNode(node, context, depth)).join("");
}

function renderNode(node: RootContent, context: RenderContext, depth: number): string {
  if (depth > MAX_RENDER_DEPTH) return escapeHtml(sourceFor(node, context));
  const children = () => ("children" in node ? renderNodes(node.children, context, depth + 1) : "");
  switch (node.type) {
    case "text":
    case "html":
      return escapeHtml(node.value);
    case "paragraph":
      return `<p>${children()}</p>\n`;
    case "heading": {
      const level = Math.min(node.depth + 2, 6);
      return `<h${level}>${children()}</h${level}>\n`;
    }
    case "emphasis":
      return `<em>${children()}</em>`;
    case "strong":
      return `<strong>${children()}</strong>`;
    case "delete":
      return `<del>${children()}</del>`;
    case "inlineCode":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "code":
      return `<pre><code>${escapeHtml(node.value)}</code></pre>\n`;
    case "break":
      return "<br>\n";
    case "thematicBreak":
      return "<hr>\n";
    case "blockquote":
      return `<blockquote>${children()}</blockquote>\n`;
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const start =
        node.ordered && node.start !== null && node.start !== undefined
          ? ` start="${node.start}"`
          : "";
      return `<${tag}${start}>${children()}</${tag}>\n`;
    }
    case "listItem": {
      const checked =
        typeof node.checked === "boolean"
          ? `<span class="asimp-task-state" role="img" aria-label="${node.checked ? "Completed" : "Not completed"}">${node.checked ? "☑" : "☐"}</span> `
          : "";
      return `<li>${checked}${children()}</li>\n`;
    }
    case "link":
      return link(children(), node.url, node.title);
    case "image":
      // Link illustrations instead of fetching authors' tracking pixels during reading.
      return link(escapeHtml(node.alt ?? "Image"), node.url, node.title);
    case "linkReference":
    case "imageReference": {
      const definition = context.definitions.get(node.identifier.toUpperCase());
      const body = node.type === "imageReference" ? escapeHtml(node.alt ?? "Image") : children();
      return definition ? link(body, definition.url, definition.title) : body;
    }
    case "definition":
    case "footnoteDefinition":
      return "";
    case "footnoteReference": {
      const id = node.identifier.toUpperCase();
      if (!context.footnotes.has(id)) return escapeHtml(`[^${node.label ?? node.identifier}]`);
      let index = context.footnoteOrder.indexOf(id);
      if (index === -1) {
        index = context.footnoteOrder.length;
        context.footnoteOrder.push(id);
      }
      return `<sup><a href="#${context.namespace}-fn-${index + 1}" aria-label="Footnote ${index + 1}">${index + 1}</a></sup>`;
    }
    case "table": {
      const rows = node.children.map((row, rowIndex) => {
        const cells = row.children
          .map((cell, column) => {
            const tag = rowIndex === 0 ? "th" : "td";
            const align = node.align?.[column];
            const alignment =
              align === "left" || align === "right" || align === "center"
                ? ` class="asimp-align-${align}"`
                : "";
            return `<${tag}${rowIndex === 0 ? ' scope="col"' : ""}${alignment}>${renderNodes(cell.children, context, depth + 1)}</${tag}>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      });
      return `<div class="asimp-table"><table><thead>${rows[0] ?? ""}</thead><tbody>${rows.slice(1).join("")}</tbody></table></div>\n`;
    }
    case "tableRow":
    case "tableCell":
      return children();
    case "math":
    case "inlineMath":
      context.mathCount += 1;
      return context.mathCount <= MAX_MATH_EXPRESSIONS
        ? renderMathHtml(node.value, node.type === "math")
        : `<code class="asimp-math-fallback">${escapeHtml(sourceFor(node, context))}</code>`;
    default:
      return escapeHtml(sourceFor(node, context));
  }
}

function collectDefinitions(
  nodes: readonly RootContent[],
  context: RenderContext,
  depth = 0,
): void {
  if (depth > MAX_RENDER_DEPTH) return;
  for (const node of nodes) {
    if (node.type === "definition" && !context.definitions.has(node.identifier.toUpperCase())) {
      context.definitions.set(node.identifier.toUpperCase(), node);
    }
    if (
      node.type === "footnoteDefinition" &&
      !context.footnotes.has(node.identifier.toUpperCase())
    ) {
      context.footnotes.set(node.identifier.toUpperCase(), node);
    }
    if ("children" in node) collectDefinitions(node.children, context, depth + 1);
  }
}

/** Safe server-rendered HTML with complete copyable source, including without JavaScript. */
export function renderScientificMarkdown(body: string, namespace = "body"): string {
  const source = neutralizeUntrustedBody(body).text;
  const sourceHtml = `<pre><code>${escapeHtml(source)}</code></pre>`;
  if (source.length > MAX_MARKDOWN_LENGTH) {
    return `<div class="scientific-markdown"><p>Large record shown as source.</p>${sourceHtml}</div>`;
  }
  const tree = parser.parse(source) as Root;
  const context: RenderContext = {
    source,
    definitions: new Map(),
    footnotes: new Map(),
    footnoteOrder: [],
    namespace: `asimp-md-${contentFingerprint(`${namespace}\n${source}`).replace(":", "-")}`,
    mathCount: 0,
  };
  collectDefinitions(tree.children, context);
  let html = renderNodes(tree.children, context, 0);
  // Referenced notes may reference other notes; each identifier is rendered once.
  if (context.footnoteOrder.length > 0) {
    html += '<section class="asimp-footnotes" aria-label="Footnotes"><ol>';
    for (let i = 0; i < context.footnoteOrder.length; i += 1) {
      const note = context.footnotes.get(context.footnoteOrder[i] as string);
      if (note)
        html += `<li id="${context.namespace}-fn-${i + 1}">${renderNodes(note.children, context, 0)}</li>`;
    }
    html += "</ol></section>";
  }
  return `<div class="scientific-markdown" data-untrusted="true">${html}<details class="asimp-source"><summary>Copy Markdown / LaTeX source</summary>${sourceHtml}</details></div>`;
}
