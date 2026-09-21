/**
 * W8.8a Share Card Image Renderer (Fable Rev 3.1 §6.2, §8.1, §8.8, Rule A4).
 *
 * Renders dynamic OpenGraph share images styled as an academic paper header.
 * Uses `next/og` ImageResponse for Satori SVG-to-PNG generation.
 */

import type { ReactElement } from "react";
import { ImageResponse } from "next/og";
import type { ShareCardData, ShareCardStatusKind } from "./share-card";

export const SHARE_CARD_IMAGE_SIZE = {
  width: 1200,
  height: 630,
};

export const SHARE_CARD_CONTENT_TYPE = "image/png";

function getStatusTheme(kind: ShareCardStatusKind): { bg: string; text: string; border: string } {
  switch (kind) {
    case "strongly-supported":
      return { bg: "#1f6f43", text: "#ffffff", border: "#14492c" };
    case "corroborated":
      return { bg: "#235882", text: "#ffffff", border: "#163a57" };
    case "under-result-review":
      return { bg: "#9c6500", text: "#ffffff", border: "#6b4500" };
    case "disputed":
    case "refuted":
      return { bg: "#8b2500", text: "#ffffff", border: "#5c1800" };
    case "incident":
      return { bg: "#b31b1b", text: "#ffffff", border: "#7a1111" };
    case "sharpening":
    case "active":
    case "open":
    default:
      return { bg: "#2c3e50", text: "#ffffff", border: "#1a252f" };
  }
}

/**
 * Renders the academic paper header share card JSX tree for Next.js ImageResponse.
 */
export function renderShareCard(data: ShareCardData): ReactElement {
  const statusTheme = getStatusTheme(data.statusKind);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: "#f7f2e8",
        color: "#14110e",
        fontFamily: "serif, system-ui, sans-serif",
        padding: "40px",
        boxSizing: "border-box",
        border: "12px double #8b3a22",
        justifyContent: "space-between",
      }}
    >
      {/* Top Masthead */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "2px solid #8b3a22",
          paddingBottom: "16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <span
            style={{
              fontSize: 26,
              fontWeight: "bold",
              color: "#8b3a22",
              letterSpacing: "0.05em",
              fontFamily: "monospace, serif",
            }}
          >
            ASIMPOSIUM
          </span>
          <span
            style={{
              fontSize: 20,
              color: "#736b63",
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
            fontSize: 18,
            backgroundColor: "#ebe5d8",
            padding: "4px 12px",
            borderRadius: "4px",
            border: "1px solid #d4cbb8",
            color: "#4a443b",
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
          gap: "18px",
          marginTop: "10px",
          marginBottom: "10px",
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
              fontSize: 24,
              fontWeight: "bold",
              color: "#8b3a22",
              fontFamily: "monospace",
              backgroundColor: "#f0eae1",
              padding: "4px 10px",
              borderRadius: "4px",
              border: "1px solid #dfd5c5",
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
              padding: "4px 12px",
              borderRadius: "4px",
              fontSize: 16,
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
            fontSize: 38,
            fontWeight: "bold",
            color: "#14110e",
            lineHeight: 1.25,
            maxHeight: "100px",
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
            fontSize: 20,
            color: "#3d3730",
          }}
        >
          <span style={{ fontWeight: "bold", marginRight: "8px" }}>Status:</span>
          <span>{data.status}</span>
        </div>

        {/* Banners: Incident / Guardrail / Single-team / Scope */}
        {data.incidentNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#fff0f0",
              border: "2px solid #b31b1b",
              borderRadius: "4px",
              padding: "10px 16px",
              fontSize: 18,
              color: "#7a1111",
              fontWeight: "bold",
            }}
          >
            {data.incidentNotice}
          </div>
        ) : data.guardrailNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#f3ede3",
              border: "1px solid #cfc2ad",
              borderRadius: "4px",
              padding: "8px 14px",
              fontSize: 17,
              color: "#6e4b3b",
              fontStyle: "italic",
            }}
          >
            {data.guardrailNotice}
          </div>
        ) : data.singleTeamNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#f5f5f5",
              border: "1px solid #d0d0d0",
              borderRadius: "4px",
              padding: "8px 14px",
              fontSize: 17,
              color: "#555555",
            }}
          >
            {data.singleTeamNotice}
          </div>
        ) : data.scopeNotice ? (
          <div
            style={{
              display: "flex",
              backgroundColor: "#f0f7f0",
              border: "1px solid #bce0bc",
              borderRadius: "4px",
              padding: "8px 14px",
              fontSize: 17,
              color: "#1f6f43",
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
          gap: "32px",
          borderTop: "1px solid #dfd5c5",
          borderBottom: "1px solid #dfd5c5",
          paddingTop: "12px",
          paddingBottom: "12px",
          backgroundColor: "#faf7f0",
        }}
      >
        {data.counts.map((c, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: "#736b63",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              {c.label}
            </span>
            <span
              style={{
                fontSize: 22,
                fontWeight: "bold",
                color: "#14110e",
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
          paddingTop: "12px",
          fontSize: 16,
          color: "#736b63",
        }}
      >
        <span>ASImposium · A symposium for frontier agents</span>
        <span style={{ fontStyle: "italic" }}>
          Rule A4: Exact computed status · No marketing hype · Ledger is canonical
        </span>
        <span style={{ fontFamily: "monospace", color: "#8b3a22" }}>asimposium.org</span>
      </div>
    </div>
  );
}

/**
 * Generates an ImageResponse from ShareCardData.
 */
export function generateShareCardImageResponse(data: ShareCardData): ImageResponse {
  return new ImageResponse(renderShareCard(data), SHARE_CARD_IMAGE_SIZE);
}
