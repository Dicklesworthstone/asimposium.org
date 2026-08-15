/**
 * The served-text registry (bead asimposiumorg-8xn, OPS.1).
 *
 * Metadata lives here rather than in front matter so the asset file *is* the served body, byte for
 * byte: no stripping step between what a maintainer reads on disk, what the digest covers, and what
 * an agent receives. The version string is also stated inside each document, and the two are
 * drift-checked (see `assertProtocolInvariants`), so metadata cannot quietly disagree with prose.
 */

/// <reference path="./assets.d.ts" />

import capsuleMarkdown from "../assets/capsule.md" with { type: "text" };
import handbookMarkdown from "../assets/handbook.md" with { type: "text" };
import llmsText from "../assets/llms.txt" with { type: "text" };
import policyMarkdown from "../assets/policy.md" with { type: "text" };
import protocolMarkdown from "../assets/protocol.md" with { type: "text" };
import skillMarkdown from "../assets/skill.md" with { type: "text" };
import type { DocumentId, DocumentStatus } from "./types.ts";

export interface DocumentSource {
  readonly id: DocumentId;
  readonly title: string;
  readonly version: string;
  readonly status: DocumentStatus;
  readonly served_at: string;
  readonly media_type: string;
  readonly source_path: string;
  readonly raw: string;
}

const MARKDOWN = "text/markdown; charset=utf-8";
const PLAIN = "text/plain; charset=utf-8";

/** Ordered by id so `listDocuments()` is byte-stable across runs. */
export const DOCUMENT_SOURCES: readonly DocumentSource[] = [
  {
    id: "capsule",
    title: "Join Capsule",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/join/ASIMP-EN-<id>",
    media_type: MARKDOWN,
    source_path: "packages/protocol/assets/capsule.md",
    raw: capsuleMarkdown,
  },
  {
    id: "handbook",
    title: "ASImposium agent handbook",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/",
    media_type: MARKDOWN,
    source_path: "packages/protocol/assets/handbook.md",
    raw: handbookMarkdown,
  },
  {
    id: "llms",
    title: "llms.txt",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/llms.txt",
    media_type: PLAIN,
    source_path: "packages/protocol/assets/llms.txt",
    raw: llmsText,
  },
  {
    id: "policy",
    title: "Conduct Floor and Content Policy",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/policy.md",
    media_type: MARKDOWN,
    source_path: "packages/protocol/assets/policy.md",
    raw: policyMarkdown,
  },
  {
    id: "protocol",
    title: "The Symposium Protocol",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/protocol.md",
    media_type: MARKDOWN,
    source_path: "packages/protocol/assets/protocol.md",
    raw: protocolMarkdown,
  },
  {
    id: "skill",
    title: "Participation skill",
    version: "0.1.0-draft",
    status: "draft",
    served_at: "/skill.md",
    media_type: MARKDOWN,
    source_path: "packages/protocol/assets/skill.md",
    raw: skillMarkdown,
  },
];

export const DOCUMENT_IDS: readonly DocumentId[] = DOCUMENT_SOURCES.map((source) => source.id);
