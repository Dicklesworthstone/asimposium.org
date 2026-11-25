/**
 * W8.8a Share Card Image Renderer (Fable Rev 3.1 §6.2, §8.1, §8.8, Rule A4).
 *
 * Renders dynamic OpenGraph share images styled as an academic paper header.
 * Uses `next/og` ImageResponse for Satori SVG-to-PNG generation.
 */

import { ImageResponse } from "next/og";
import type { ReactElement } from "react";
import type { ShareCardData, ShareCardStatusKind } from "./share-card";

export const SHARE_CARD_IMAGE_SIZE = {
  width: 1200,
  height: 630,
};

export const SHARE_CARD_CONTENT_TYPE = "image/png";

function getStatusTheme(kind: ShareCardStatusKind): { bg: string; text: string; border: string } {
  switch (kind) {
    case "strongly-supported":
      return { bg: "#4b6524", text: "#fdfaf4", border: "#344719" };
    case "corroborated":
      return { bg: "#235887", text: "#fdfaf4", border: "#183e60" };
    case "under-result-review":
      return { bg: "#7f6129", text: "#fdfaf4", border: "#59441c" };
    case "disputed":
    case "refuted":
    case "malformed":
      return { bg: "#a2442a", text: "#fdfaf4", border: "#732f1c" };
    case "incident":
      return { bg: "#a3261c", text: "#fdfaf4", border: "#731a13" };
    case "record":
    case "sharpening":
    case "active":
    case "open":
    default:
      return { bg: "#4a4238", text: "#fdfaf4", border: "#1f1b16" };
  }
}

/**
 * Renders the academic paper header share card JSX tree for Next.js ImageResponse.
 */
export function renderShareCard(data: ShareCardData): ReactElement {
  const statusTheme = getStatusTheme(data.statusKind);
  // Resolution scope must fit alongside the guardrail and screening notice.
  // Compact the decoration and title, never the scientific qualifications.
  const compact =
    data.scopeNotice !== undefined || data.closingSynthesisScreeningNotice !== undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: "#f7f2e8",
        color: "#1f1b16",
        fontFamily: "serif, system-ui, sans-serif",
        padding: compact ? "24px" : "40px",
        boxSizing: "border-box",
        border: "12px solid #a2442a",
        justifyContent: "space-between",
      }}
    >
      {/* Top Masthead */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "2px solid #a2442a",
          paddingBottom: compact ? "8px" : "16px",
          ...(compact ? { flexShrink: 0 } : {}),
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <svg width={compact ? 28 : 34} height={compact ? 28 : 34} viewBox="0 0 40 40" fill="none">
            <path d="M4 13.5h32c-1 7.2-7.6 11.6-16 11.6S5 20.7 4 13.5Z" fill="#a2442a" />
            <path
              d="M7.2 16.2c-4.6.2-5.6-4.9-2.1-5.4M32.8 16.2c4.6.2 5.6-4.9 2.1-5.4"
              stroke="#a2442a"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
            <path d="M18.5 24.8h3l-.5 5.4h-2Z" fill="#a2442a" />
            <path d="M11.5 33.4c2.4-3 14.6-3 17 0-2.6 1.2-14.4 1.2-17 0Z" fill="#a2442a" />
            <path
              d="M9 17.4h22M12.5 17.4v-1.8h2.4v1.8M18.8 17.4v-1.8h2.4v1.8M25.1 17.4v-1.8h2.4v1.8"
              stroke="#f7f2e8"
              strokeWidth="1.1"
            />
          </svg>
          <span
            style={{
              fontSize: compact ? 22 : 26,
              fontWeight: "bold",
              color: "#a2442a",
              letterSpacing: "0.08em",
              fontFamily: "serif",
            }}
          >
            ASIMPOSIUM
          </span>
          <span
            style={{
              fontSize: compact ? 16 : 20,
              color: "#655b4e",
              fontStyle: "italic",
            }}
          >
            συμπόσιον · public scientific ledger
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: compact ? 16 : 18,
            backgroundColor: "#efe7d8",
            padding: compact ? "3px 10px" : "4px 12px",
            borderRadius: "4px",
            border: "1px solid #cbbda3",
            color: "#4a4238",
            fontFamily: "monospace",
          }}
        >
          <span>Cursor:</span>
          <span style={{ fontWeight: "bold" }}>#{data.cursor}</span>
        </div>
      </div>

      {/* Main Paper Header Content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: compact ? "6px" : data.screeningNotice ? "12px" : "18px",
          marginTop: compact ? "6px" : "10px",
          marginBottom: compact ? "6px" : "10px",
          ...(compact ? { flexShrink: 0 } : {}),
        }}
      >
        {/* Code & Entity Kind */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span
            style={{
              fontSize: compact ? 20 : 24,
              fontWeight: "bold",
              color: "#a2442a",
              fontFamily: "monospace",
              backgroundColor: "#fdfaf4",
              padding: compact ? "3px 8px" : "4px 10px",
              borderRadius: "4px",
              border: "1px solid #e4d9c6",
            }}
          >
            {data.code}
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: statusTheme.bg,
              color: statusTheme.text,
              border: `1px solid ${statusTheme.border}`,
              padding: compact ? "3px 10px" : "4px 12px",
              borderRadius: "4px",
              fontSize: compact ? 14 : 16,
              fontWeight: "bold",
              letterSpacing: "0.05em",
            }}
          >
            {data.statusBadge}
          </div>
        </div>

        {/* Paper Title */}
        <div
          style={{
            fontSize: compact ? 28 : data.screeningNotice ? 34 : 38,
            fontWeight: "bold",
            color: "#1f1b16",
            lineHeight: compact ? 1.15 : 1.25,
            maxHeight: compact ? "65px" : "100px",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {data.title}
        </div>

        {/* Exact Status Line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: compact ? 18 : 20,
            ...(compact ? { lineHeight: 1.2 } : {}),
            color: "#4a4238",
          }}
        >
          <span style={{ fontWeight: "bold", marginRight: "8px" }}>Status:</span>
          <span>{data.status}</span>
        </div>

        {data.screeningNotice && (
          <div
            style={{
              display: "flex",
              backgroundColor: "#fdfaf4",
              border: "1px solid #7f6129",
              borderRadius: "4px",
              padding: "6px 12px",
              fontSize: 16,
              color: "#4a4238",
              ...(compact ? { lineHeight: 1.25, flexShrink: 0 } : {}),
            }}
          >
            {data.screeningNotice}
          </div>
        )}

        {data.closingSynthesisScreeningNotice && (
          <div
            style={{
              display: "flex",
              backgroundColor: "#fdfaf4",
              border: "1px solid #7f6129",
              borderRadius: "4px",
              padding: "6px 12px",
              fontSize: 16,
              color: "#4a4238",
              lineHeight: 1.25,
              flexShrink: 0,
            }}
          >
            Closing synthesis: {data.closingSynthesisScreeningNotice}
          </div>
        )}

        {/* Banners: Incident / Guardrail / Single-team / Scope */}
        {data.incidentNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#fdfaf4",
              border: "2px solid #a3261c",
              borderRadius: "4px",
              padding: compact ? "6px 10px" : "10px 16px",
              fontSize: compact ? 16 : 18,
              color: "#a3261c",
              fontWeight: "bold",
              ...(compact ? { lineHeight: 1.25, flexShrink: 0 } : {}),
            }}
          >
            {data.incidentNotice}
          </div>
        ) : data.guardrailNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#efe7d8",
              border: "1px solid #cbbda3",
              borderRadius: "4px",
              padding: compact ? "6px 10px" : "8px 14px",
              fontSize: compact ? 16 : 17,
              color: "#4a4238",
              fontStyle: "italic",
              ...(compact ? { lineHeight: 1.25, flexShrink: 0 } : {}),
            }}
          >
            {data.guardrailNotice}
          </div>
        ) : data.singleTeamNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#efe7d8",
              border: "1px solid #cbbda3",
              borderRadius: "4px",
              padding: compact ? "6px 10px" : "8px 14px",
              fontSize: compact ? 16 : 17,
              color: "#4a4238",
              ...(compact ? { lineHeight: 1.25, flexShrink: 0 } : {}),
            }}
          >
            {data.singleTeamNotice}
          </div>
        ) : null}
        {data.scopeNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#fdfaf4",
              border: "1px solid #4b6524",
              borderRadius: "4px",
              padding: "6px 10px",
              fontSize: 16,
              color: "#4b6524",
              lineHeight: 1.25,
              flexShrink: 0,
            }}
          >
            {data.scopeNotice}
          </div>
        ) : null}
      </div>

      {/* Honest Counts Bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-start",
          gap: compact ? "24px" : "32px",
          borderTop: "1px solid #e4d9c6",
          borderBottom: "1px solid #e4d9c6",
          paddingTop: compact ? "6px" : "12px",
          paddingBottom: compact ? "6px" : "12px",
          backgroundColor: "#fdfaf4",
          ...(compact ? { flexShrink: 0 } : {}),
        }}
      >
        {data.counts.map((c) => (
          <div
            key={c.label}
            style={{
              display: "flex",
              flexDirection: compact ? "row" : "column",
              ...(compact ? { alignItems: "baseline" as const } : {}),
              gap: compact ? "8px" : "2px",
            }}
          >
            <span
              style={{
                fontSize: compact ? 13 : 14,
                color: "#655b4e",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {c.label}
            </span>
            <span
              style={{
                fontSize: compact ? 18 : 22,
                fontWeight: "bold",
                color: "#1f1b16",
                fontFamily: "monospace",
              }}
            >
              {String(c.value)}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          paddingTop: compact ? "8px" : "12px",
          fontSize: compact ? 14 : 16,
          color: "#655b4e",
          ...(compact ? { flexShrink: 0 } : {}),
        }}
      >
        <span>
          {compact
            ? "ASImposium · Public scientific ledger"
            : "ASImposium · A symposium for frontier agents"}
        </span>
        {!compact && (
          <span style={{ fontStyle: "italic" }}>
            Rule A4: Exact computed status · No marketing hype · Ledger is canonical
          </span>
        )}
        <span style={{ fontFamily: "monospace", color: "#a2442a" }}>asimposium.org</span>
      </div>
    </div>
  );
}

/**
 * Generates an ImageResponse from ShareCardData, preserving explicit HTTP
 * status and cache headers (e.g., 404/503 + no-store on unavailable records).
 */
export function generateShareCardImageResponse(
  data: ShareCardData,
  options?: { readonly status?: number; readonly headers?: HeadersInit },
): ImageResponse {
  return new ImageResponse(renderShareCard(data), {
    ...SHARE_CARD_IMAGE_SIZE,
    ...(options?.status !== undefined ? { status: options.status } : {}),
    ...(options?.headers !== undefined ? { headers: options.headers } : {}),
  });
}
