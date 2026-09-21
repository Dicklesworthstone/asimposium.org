"use client";

import { useState } from "react";

interface ShareCardPanelProps {
  readonly code: string;
  readonly statusBadge: string;
  readonly statusText: string;
  readonly suggestedText: string;
  readonly ogImageUrl?: string;
  readonly guardrailNotice?: string;
  readonly singleTeamNotice?: string;
  readonly incidentNotice?: string;
}

/**
 * W8.8a Human UI Panel for Honest Share Cards and Suggested Share Text (Fable §8.8).
 * Provides a copyable text block and preview conforming strictly to Rule A4.
 */
export function ShareCardPanel({
  code,
  statusBadge,
  statusText,
  suggestedText,
  ogImageUrl,
  guardrailNotice,
  singleTeamNotice,
  incidentNotice,
}: ShareCardPanelProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(suggestedText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } catch {
      // Fallback: select text for manual copy
    }
  }

  return (
    <section className="share-honesty-section" aria-labelledby="share-section-heading">
      <div className="share-panel-header">
        <h2 id="share-section-heading">
          <span className="gr" aria-hidden="true">
            ε
          </span>
          Share with verified status
        </h2>
        <span className="share-honesty-badge" title="Guaranteed free of PROVED or AI-solved hype">
          Rule A4 · Share Honesty
        </span>
      </div>

      <p className="quiet">
        Share cards and suggested text carry the exact computed status from the public ledger.
        Resolution-shaped language for unresolved work is strictly forbidden.
      </p>

      {incidentNotice && (
        <div className="incident-alert-banner" role="alert">
          <strong>Incident Notice:</strong> {incidentNotice}
        </div>
      )}

      {guardrailNotice && (
        <div className="guardrail-alert-banner" role="status">
          <strong>Famous-Problem Guardrail:</strong> {guardrailNotice}
        </div>
      )}

      {singleTeamNotice && (
        <div className="single-team-alert-banner" role="status">
          <strong>Single-Team Problem:</strong> {singleTeamNotice}
        </div>
      )}

      <div className="share-card-preview-box">
        <div className="share-preview-meta">
          <span className="share-code">{code}</span>
          <span className="share-badge-pill">{statusBadge}</span>
          <span className="share-status-summary">{statusText}</span>
        </div>

        <div className="share-text-box">
          <label htmlFor="suggested-share-textarea" className="visually-hidden">
            Suggested share text
          </label>
          <textarea
            id="suggested-share-textarea"
            className="share-textarea"
            readOnly
            rows={5}
            value={suggestedText}
          />
        </div>

        <div className="share-actions-row">
          <button
            type="button"
            className="btn-share-copy"
            onClick={handleCopy}
            aria-live="polite"
          >
            {copied ? "Copied to clipboard!" : "Copy suggested share text"}
          </button>
          {ogImageUrl && (
            <a
              href={ogImageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-og-preview"
            >
              View generated share image (PNG)
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
