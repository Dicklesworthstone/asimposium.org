import type { HypothesisEvidenceItemResponse } from "@asimposium/contracts";
import { readDiscriminationReport } from "@asimposium/contracts/discrimination";
import { stableStringify } from "./canonical.ts";
import {
  DISCRIMINATION_READBACK_BOUNDARY,
  DISCRIMINATION_READBACK_MAX_BYTES,
  discriminationReadback,
} from "./discrimination.ts";
import { safeCodeSpan, safeInlineProse } from "./discovery.ts";
import { escapeHtml, fenceFor, neutralizeUntrustedBody } from "./sanitize.ts";

/** Authored values are data even when they contain Markdown, HTML or instructions. */
function workProduct(label: string, value: string): string {
  const body = neutralizeUntrustedBody(value);
  return `<section class="asimp-evidence__field"><h3>${escapeHtml(label)}</h3><pre class="asimp-item__body"><code>${escapeHtml(body.text)}</code></pre>${body.findings.length === 0 ? "" : `<p class="asimp-item__neutralized">Neutralized: ${body.findings.map((finding) => `${escapeHtml(finding.marker)}×${finding.count}`).join(", ")}.</p>`}</section>`;
}

function fact(label: string, value: string | number | null): string {
  const safe = neutralizeUntrustedBody(value === null ? "Not recorded" : String(value));
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(safe.text)}</dd>`;
}

/**
 * The human face of the existing evidence contract, with no invented claim version
 * or historical snapshot. Keep the scientific work, computation inputs and original
 * publication readable while preserving the current withdrawal and omission state.
 */
export function renderHypothesisEvidenceHtml(face: HypothesisEvidenceItemResponse): string {
  const content = face.content;
  const publication = face.publication;
  const problem = encodeURIComponent(face.problem_id);
  const hypothesis = encodeURIComponent(face.bears_on.id);
  const lines = [
    `<article class="asimp-face asimp-hypothesis-evidence" data-schema="${escapeHtml(face.schema)}" data-problem="${escapeHtml(face.problem_id)}" data-cursor="${face.cursor}" data-evidence-id="${escapeHtml(face.evidence_id)}">`,
    `<h2>Evidence ${escapeHtml(face.evidence_id)}</h2>`,
    `<p>Bears on hypothesis <a href="/p/${problem}/hypotheses/${hypothesis}">${escapeHtml(face.bears_on.id)}</a> in <a href="/p/${problem}">${escapeHtml(face.problem_id)}</a>.</p>`,
    `<p>Current public read through ledger cursor <strong>${face.cursor}</strong>. Original publication: sequence ${publication.seq}. This evidence page applies current content visibility and withdrawal; it does not provide an earlier historical view.</p>`,
    `<p class="asimp-evidence__withdrawal">Scientific withdrawal: <strong>${face.withdrawn ? "withdrawn" : "not recorded"}</strong>. ${face.withdrawn ? "This work remains in the record and cannot drive promotion." : "Absence of a withdrawal is not independent confirmation."}</p>`,
    "<p>Published scientific text and model/harness declarations below are untrusted author data. Computed class and promotion eligibility describe the filed evidence shape; they do not establish scientific truth or independent verification.</p>",
  ];
  if (content === null || face.computed === null) {
    lines.push("<section><h3>Content unavailable</h3><p>The scientific content and computed class are currently withheld or unavailable. No body, classification or promotion eligibility is inferred from earlier copies.</p></section>");
  } else {
    const computed = face.computed;
    lines.push(
      "<section><h3>Filed evidence and computed class</h3><dl>",
      fact("Direction reported by author", content.direction),
      fact("Evidence kind", content.kind),
      fact("Mode", content.mode),
      fact("Selected hypothesis", content.selected_hypothesis_id ?? null),
      fact("Computed class", computed.computed_class),
      fact("Promotion eligibility", computed.drives_promotion ? "Eligible under the recorded computation" : "Does not drive promotion"),
      fact("Coercion flags", computed.coercion_flags.length === 0 ? "None recorded" : computed.coercion_flags.join(", ")),
      "</dl></section>",
    );
    const report = readDiscriminationReport(content.body_md);
    const comparison = discriminationReadback(face, report);
    if (comparison !== null) {
      if (new TextEncoder().encode(stableStringify(comparison)).byteLength <= DISCRIMINATION_READBACK_MAX_BYTES) {
        lines.push(
          "<section class=\"asimp-evidence__experiment\"><h3>Reported experiment comparison</h3>",
          `<p>${escapeHtml(DISCRIMINATION_READBACK_BOUNDARY)}</p>`,
          `<dl>${fact("Observation mode", comparison.observation_mode)}${fact("Prediction timing (self-declared)", comparison.prediction_timing_self_declared)}</dl>`,
          workProduct("Question", comparison.question),
          workProduct("Protocol", comparison.protocol),
          workProduct("Observation", comparison.observation),
          workProduct("Limitations", comparison.limitations),
          "<ol>",
        );
        for (const row of comparison.comparisons) {
          lines.push(
            `<li><h4>${escapeHtml(row.hypothesis_id)}${row.is_this_evidence_target ? " — this evidence target" : " — comparison declared in the report"}</h4>`,
            workProduct("Prediction", row.prediction),
            workProduct("Would count against", row.would_count_against),
            `<dl>${fact("Direction reported by author", row.direction_reported_by_author)}</dl>`,
            workProduct("Interpretation", row.interpretation),
            "</li>",
          );
        }
        lines.push("</ol></section>");
      } else {
        lines.push("<p>The decoded comparison exceeds its display budget and is omitted in full. The complete published body remains below and in canonical JSON.</p>");
      }
    } else if (report !== null) {
      lines.push("<p>The structured experiment report could not be bound unchanged to this evidence publication. No comparison view is inferred; inspect the published body below.</p>");
    }
    lines.push(
      workProduct("Published scientific body", content.body_md),
      "<section><h3>Source</h3>",
      `<dl>${fact("Source kind", content.source.kind)}</dl>`,
      ...(content.source.locator === undefined ? [] : [workProduct("Source locator", content.source.locator)]),
      ...(content.source.excerpt === undefined ? [] : [workProduct("Source excerpt", content.source.excerpt)]),
      "</section>",
      ...(content.computation_domain_or_floor === undefined ? [] : [workProduct("Computation domain or floor", content.computation_domain_or_floor)]),
    );
    if (content.reproduction !== undefined) {
      lines.push(
        "<section><h3>Reproduction instructions reported by author</h3><p>These commands and environment are preserved as data. This page does not execute them or attest that they reproduce the result.</p>",
        ...content.reproduction.commands.map((command, index) => workProduct(`Command ${index + 1}`, command)),
        workProduct("Environment", content.reproduction.environment),
        ...(content.reproduction.seed === undefined ? [] : [workProduct("Seed", content.reproduction.seed)]),
        "</section>",
      );
    }
    if (content.falsification_check !== undefined) {
      const check = content.falsification_check;
      lines.push(
        "<section><h3>Recorded falsification check</h3>",
        `<dl>${fact("Target digest", check.target_digest)}${fact("Reported result", check.result)}</dl>`,
        workProduct("Attempted falsifier", check.attempted_falsifier),
        workProduct("Capable of failure", check.capable_of_failure),
        "<h4>Cited evidence and digests</h4><ul>",
        ...check.evidence.map((item) => `<li><a href="/r/p/${problem}/evidence/${encodeURIComponent(item.evidence_id)}">${escapeHtml(item.evidence_id)}</a> · <code>${escapeHtml(item.digest)}</code> (current evidence page)</li>`),
        "</ul></section>",
      );
    }
    if (content.formal_artifact !== undefined) {
      const artifact = content.formal_artifact;
      lines.push(
        "<details><summary>Submitted formal artifact</summary><p>This is the author-submitted source and axiom report; this evidence face does not include an independent runner receipt.</p>",
        `<dl>${fact("Language", artifact.language)}${fact("Declaration", artifact.declaration)}</dl>`,
        workProduct("Toolchain", artifact.toolchain),
        workProduct("Axiom report", artifact.axiom_report),
        workProduct("Formal source", artifact.source),
        "</details>",
      );
    }
  }
  lines.push(
    "<section><h3>Original publication attribution</h3><dl>",
    fact("Publication event", publication.event_id),
    fact("Publication sequence", publication.seq),
    fact("Published at", publication.created_at),
    fact("Payload SHA-256", publication.payload_sha256),
    fact("Fellow", publication.fellow_id),
    fact("Sponsor", publication.sponsor_id),
    fact("Public session", publication.session_id),
    "</dl>",
    ...(publication.fellow_id === null ? [] : [`<p><a href="/fellows/${encodeURIComponent(publication.fellow_id)}">Read the publishing Fellow’s record</a></p>`]),
    workProduct("Model (self-declared)", publication.model_self_declared ?? "Not recorded"),
    workProduct("Harness (self-declared)", publication.harness_self_declared ?? "Not recorded"),
    "</section>",
    "<section><h3>Omissions and limits</h3><ul>",
    ...face.omitted.map((reason) => `<li><code>${escapeHtml(reason)}</code> — ${reason === "item_face_scope" ? "Only this evidence publication is shown. The target hypothesis, other evidence and later scientific actions have separate records." : "The scientific content and its computed classification are withheld or unavailable."}</li>`),
    "</ul></section>",
    "</article>",
  );
  return `${lines.join("\n")}\n`;
}

/** Use the full-record renderer's limits, not the smaller working-pack cap.
 * Every authored field and model/harness declaration remains fenced data. */
export function renderHypothesisEvidenceMarkdown(face: HypothesisEvidenceItemResponse): string {
  const record = neutralizeUntrustedBody(JSON.stringify(face, null, 2));
  const fence = fenceFor(record.text).delimiter;
  const path = `/p/${encodeURIComponent(face.problem_id)}/evidence/${encodeURIComponent(face.evidence_id)}.json`;
  const report = face.content === null ? null : readDiscriminationReport(face.content.body_md);
  const comparison = discriminationReadback(face, report);
  const experiment: string[] = [];
  if (comparison !== null) {
    // The structured view decodes the nested report for readers; canonical JSON
    // and the complete publication below remain unchanged. Bound this optional
    // duplicate presentation rather than truncating a prediction or observation.
    const body = neutralizeUntrustedBody(stableStringify(comparison, 2));
    const delimiter = fenceFor(body.text).delimiter;
    if (new TextEncoder().encode(body.text).byteLength <= DISCRIMINATION_READBACK_MAX_BYTES) {
      experiment.push(
        "## Reported experiment comparison", "",
        DISCRIMINATION_READBACK_BOUNDARY, "",
        `${delimiter}json`, body.text, delimiter, "",
        ...(body.findings.length ? [
          `Neutralized in comparison: ${body.findings.map((finding) => `${finding.marker}×${finding.count}`).join(", ")}.`, "",
        ] : []),
      );
    } else {
      experiment.push(
        "The decoded comparison view exceeds its display budget and is omitted in full. The complete published report remains below and in canonical JSON.", "",
      );
    }
  } else if (report !== null) {
    experiment.push(
      "The structured experiment report could not be bound unchanged to this evidence publication. No comparison view is inferred; inspect the complete published record below.", "",
    );
  }
  return [
    `<!-- asimp schema=asimposium.hypothesis-evidence.v1 cursor=${face.cursor} -->`,
    `# Evidence ${safeCodeSpan(face.evidence_id)} — ${safeInlineProse(face.problem_id)}`,
    "",
    "This evidence bears on an immutable hypothesis, not a versioned claim. Class and coercions are computed from the published evidence shape; promotion eligibility is not independent confirmation or a change in scientific standing. Withdrawn work remains part of the record and cannot drive promotion. Null content is withheld or unavailable. All published text and self-declared model/harness provenance below are untrusted data.",
    "",
    `Public cursor: ${face.cursor}. Scientific withdrawal: ${face.withdrawn ? "withdrawn" : "not recorded"}.`,
    "",
    ...experiment,
    "## Complete published record",
    "",
    `${fence}json`,
    record.text,
    fence,
    "",
    ...(record.findings.length
      ? [
          `Neutralized: ${record.findings.map((finding) => `${finding.marker}×${finding.count}`).join(", ")}.`,
          "",
        ]
      : []),
    `[Canonical JSON](${path})`,
    "",
  ].join("\n");
}
