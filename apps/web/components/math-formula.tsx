"use client";

import { type FC, useState } from "react";

export interface MathFormulaProps {
  readonly formula: string;
  readonly display?: "inline" | "block";
  readonly title?: string;
  readonly className?: string;
}

/**
 * Math Formula Component (Fable §8.3 & §14.3).
 *
 * Requirements:
 * 1. KaTeX trust mode strictly off (never executes raw HTML or untrusted commands).
 * 2. Copyable LaTeX source affordance.
 * 3. Non-JS accessible: LaTeX source is directly readable inside code tags.
 * 4. Screen-reader accessible: sr-only mathematical expression label.
 */
export const MathFormula: FC<MathFormulaProps> = ({
  formula,
  display = "block",
  title,
  className = "",
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(formula);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback if clipboard API is restricted
      setCopied(false);
    }
  };

  if (display === "inline") {
    return (
      <span
        className={`math-formula inline-math inline-flex items-center gap-1 font-mono text-sm bg-card px-1 py-0.5 rounded border border-line ${className}`}
        title={title ?? `LaTeX: ${formula}`}
        role="math"
        aria-label={`Formula: ${formula}`}
      >
        <span className="sr-only">Mathematical expression: {formula}</span>
        <code className="select-all" aria-hidden="true">
          ${formula}$
        </code>
      </span>
    );
  }

  return (
    <figure
      className={`math-formula block-math my-4 p-3 bg-card border border-line rounded-sm ${className}`}
      role="group"
      aria-label={title ?? "Mathematical formula"}
    >
      {title && <figcaption className="text-xs text-muted mb-2 font-serif italic">{title}</figcaption>}
      <div className="flex items-start justify-between gap-4">
        <div className="overflow-x-auto py-2 font-mono text-sm text-ink flex-1" role="math" aria-label={`Formula: ${formula}`}>
          <span className="sr-only">Mathematical expression: {formula}</span>
          <pre className="latex-source whitespace-pre-wrap select-all">
            <code>$${formula}$$</code>
          </pre>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs font-mono px-2 py-1 bg-paper border border-line hover:border-clay rounded text-ink2 transition-colors cursor-pointer shrink-0"
          aria-label="Copy LaTeX formula"
          title="Copy LaTeX formula to clipboard"
        >
          {copied ? "Copied ✓" : "Copy LaTeX"}
        </button>
      </div>
    </figure>
  );
};
