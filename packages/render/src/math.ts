import katex from "katex";
import { escapeHtml, neutralizeUntrustedBody } from "./sanitize.ts";

/** Shared bounded, trust-off math rendering for prose and standalone formulas. */
export function renderMathHtml(formula: string, display = false): string {
  const source = neutralizeUntrustedBody(formula).text;
  const delimiter = display ? "$$" : "$";
  const fallback = () =>
    `<code class="asimp-math-fallback" data-math-rendered="false">${escapeHtml(`${delimiter}${source}${delimiter}`)}</code>`;
  if (source.length > 8_192) return fallback();
  try {
    // Fresh macros prevent one author's definitions from changing another's mathematics.
    const html = katex.renderToString(source, {
      displayMode: display,
      output: "htmlAndMathml",
      trust: false,
      strict: "error",
      throwOnError: true,
      maxExpand: 1_000,
      maxSize: 20,
      macros: {},
    });
    return `<span class="asimp-math${display ? " asimp-math--display" : ""}" data-math-rendered="true" title="${escapeHtml(`LaTeX: ${source}`)}">${html}</span>`;
  } catch {
    // Parser diagnostics may contain author text: do not log them.
    return fallback();
  }
}
