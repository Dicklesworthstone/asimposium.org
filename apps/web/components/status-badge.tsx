import type { FC } from "react";

export type StatusKind =
  | "strongly-supported"
  | "challenged"
  | "open"
  | "open · unchallenged"
  | "refuted"
  | "quarantined"
  | "stale"
  | "dormant"
  | "retired"
  | "active"
  | "sharpening"
  | "resolved"
  | "private-draft"
  | "under-result-review"
  | string;

export interface StatusBadgeProps {
  readonly status: StatusKind;
  readonly label?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}

export interface StatusDescriptor {
  readonly symbol: string;
  readonly defaultLabel: string;
  readonly ariaDescription: string;
  readonly tone: "supported" | "challenged" | "open" | "refuted" | "warning" | "neutral";
}

export function resolveStatusDescriptor(status: string): StatusDescriptor {
  const normalized = status.toLowerCase().trim();

  switch (normalized) {
    case "strongly-supported":
    case "strongly_supported":
      return {
        symbol: "●",
        defaultLabel: "strongly-supported",
        ariaDescription: "Strongly supported by evidence",
        tone: "supported",
      };
    case "challenged":
      return {
        symbol: "◐",
        defaultLabel: "challenged",
        ariaDescription: "Challenged by counter-evidence or refutation",
        tone: "challenged",
      };
    case "open · unchallenged":
    case "unchallenged":
      return {
        symbol: "○",
        defaultLabel: "open · unchallenged",
        ariaDescription: "Open and unchallenged",
        tone: "open",
      };
    case "open":
      return {
        symbol: "○",
        defaultLabel: "open",
        ariaDescription: "Open",
        tone: "open",
      };
    case "refuted":
      return {
        symbol: "✕",
        defaultLabel: "refuted",
        ariaDescription: "Refuted by decisive counter-evidence",
        tone: "refuted",
      };
    case "quarantined":
      return {
        symbol: "⚠",
        defaultLabel: "quarantined",
        ariaDescription: "Quarantined for screening or review anomaly",
        tone: "warning",
      };
    case "stale":
      return {
        symbol: "⚠",
        defaultLabel: "stale",
        ariaDescription: "Marked stale pending updated source material",
        tone: "warning",
      };
    case "active":
      return {
        symbol: "▶",
        defaultLabel: "active",
        ariaDescription: "Active problem",
        tone: "supported",
      };
    case "sharpening":
      return {
        symbol: "◇",
        defaultLabel: "sharpening",
        ariaDescription: "Sharpening formulation",
        tone: "neutral",
      };
    case "under-result-review":
    case "result-review":
      return {
        symbol: "◈",
        defaultLabel: "under result review",
        ariaDescription: "Under formal result review",
        tone: "challenged",
      };
    case "dormant":
      return {
        symbol: "■",
        defaultLabel: "dormant",
        ariaDescription: "Dormant",
        tone: "neutral",
      };
    case "resolved":
      return {
        symbol: "◆",
        defaultLabel: "resolved",
        ariaDescription: "Resolved",
        tone: "supported",
      };
    case "retired":
      return {
        symbol: "■",
        defaultLabel: "retired",
        ariaDescription: "Retired",
        tone: "neutral",
      };
    case "private-draft":
      return {
        symbol: "◌",
        defaultLabel: "private draft",
        ariaDescription: "Private draft",
        tone: "neutral",
      };
    default:
      return {
        symbol: "•",
        defaultLabel: status,
        ariaDescription: `Status: ${status}`,
        tone: "neutral",
      };
  }
}

/**
 * Redundant Status Badge (Rule A4 & WCAG 2.2 AA).
 * Status is never conveyed by color alone: combines distinct shape/symbol + textual label.
 */
export const StatusBadge: FC<StatusBadgeProps> = ({
  status,
  label,
  size = "md",
  className = "",
}) => {
  const descriptor = resolveStatusDescriptor(status);
  const displayLabel = label ?? descriptor.defaultLabel;

  const sizeClasses =
    size === "sm"
      ? "text-xs px-1.5 py-0.5 gap-1"
      : size === "lg"
        ? "text-base px-3 py-1 gap-2 font-medium"
        : "text-sm px-2 py-0.5 gap-1.5";

  return (
    <span
      className={`inline-flex items-center rounded-sm font-mono border transition-colors ${sizeClasses} ${className}`}
      role="status"
      aria-label={`${displayLabel} (${descriptor.ariaDescription})`}
      data-status={status}
      data-tone={descriptor.tone}
    >
      <span className="status-symbol select-none" aria-hidden="true">
        {descriptor.symbol}
      </span>
      <span className="status-label">{displayLabel}</span>
    </span>
  );
};
