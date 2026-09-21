"use server";

import { revalidatePath } from "next/cache";
import {
  AdminAreaRenameRequestSchema,
  AdminContentControlRequestSchema,
  AdminQuarantineDecisionRequestSchema,
  AdminReportResolutionRequestSchema,
  assertNoScientificDispositionOverride,
} from "@asimposium/contracts";

import { requireOperatorSession } from "@/lib/admin";
import {
  stoaAdminContentControl,
  stoaAdminRenameArea,
  stoaAdminResolveQuarantine,
  stoaAdminResolveReport,
} from "@/lib/stoa";

/**
 * Adjudicates a quarantine hold (release or uphold rejection).
 * Requires step-up authentication and non-empty audit reason.
 */
export async function resolveQuarantineAction(
  formData: FormData,
): Promise<void> {
  const session = await requireOperatorSession();
  if (session.state !== "authorized") {
    return;
  }

  const raw = {
    case_id: String(formData.get("case_id") ?? ""),
    decision: String(formData.get("decision") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  };

  try {
    assertNoScientificDispositionOverride(raw);
    const parsed = AdminQuarantineDecisionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }

    const idempotencyKey = `admin-quarantine-${crypto.randomUUID()}`;
    await stoaAdminResolveQuarantine(session.operatorId, parsed.data, idempotencyKey);
    revalidatePath("/admin");
  } catch {
    // Fail-closed
  }
}

/**
 * Resolves a content or conduct report.
 */
export async function resolveReportAction(
  formData: FormData,
): Promise<void> {
  const session = await requireOperatorSession();
  if (session.state !== "authorized") {
    return;
  }

  const raw = {
    report_id: String(formData.get("report_id") ?? ""),
    resolution: String(formData.get("resolution") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  };

  try {
    assertNoScientificDispositionOverride(raw);
    const parsed = AdminReportResolutionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }

    const idempotencyKey = `admin-report-${crypto.randomUUID()}`;
    await stoaAdminResolveReport(session.operatorId, parsed.data, idempotencyKey);
    revalidatePath("/admin");
  } catch {
    // Fail-closed
  }
}

/**
 * Applies content controls (hide, restore, ban_sponsor).
 * Structural check strictly prevents disposition tampering.
 */
export async function contentControlAction(
  formData: FormData,
): Promise<void> {
  const session = await requireOperatorSession();
  if (session.state !== "authorized") {
    return;
  }

  const raw: Record<string, unknown> = {
    target_id: String(formData.get("target_id") ?? ""),
    target_kind: String(formData.get("target_kind") ?? ""),
    action: String(formData.get("action") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  };

  // If client maliciously supplied disposition in formData, it gets captured here:
  const disposition = formData.get("disposition");
  if (disposition !== null) {
    raw.disposition = String(disposition);
  }

  try {
    assertNoScientificDispositionOverride(raw);
    const parsed = AdminContentControlRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }

    const idempotencyKey = `admin-content-${crypto.randomUUID()}`;
    await stoaAdminContentControl(session.operatorId, parsed.data, idempotencyKey);
    revalidatePath("/admin");
  } catch {
    // Fail-closed
  }
}

/**
 * Renames an area with an audited reason.
 */
export async function renameAreaAction(
  formData: FormData,
): Promise<void> {
  const session = await requireOperatorSession();
  if (session.state !== "authorized") {
    return;
  }

  const raw = {
    area_id: String(formData.get("area_id") ?? ""),
    new_title: String(formData.get("new_title") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  };

  const parsed = AdminAreaRenameRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }

  const idempotencyKey = `admin-area-${crypto.randomUUID()}`;
  await stoaAdminRenameArea(session.operatorId, parsed.data, idempotencyKey);
  revalidatePath("/admin");
}
