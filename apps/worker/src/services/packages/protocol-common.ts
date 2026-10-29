/**
 * Shared seam between the M3 protocol services (SPEC-0016 §7 — pypi.ts and
 * helm.ts). Everything here is a two-consumer helper the landed M1 model
 * deliberately does not carry: the version-metadata write (upstream sets
 * MetadataJSON at INSERT time inside createPackageAndVersion,
 * services/packages/packages.go:218-245 — a re-published version keeps its
 * original metadata, so the write is gated on the versionCreated answer) and
 * the URL validation arm (upstream validation.IsValidURL,
 * modules/validation/helpers.go:42-50 — absolute http/https URI).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions } from "../../db/schema";

/**
 * Persist the per-ecosystem metadata JSON on a freshly created version row.
 * Callers pass the JSON string already serialized in upstream's tag order;
 * only the versionCreated branch may call this (see the module note).
 */
export async function writeVersionMetadata(d1: D1Database, versionId: number, metadataJson: string): Promise<void> {
  await drizzle(d1)
    .update(packageVersions)
    .set({ metadataJson })
    .where(eq(packageVersions.id, versionId))
    .run();
}

/**
 * `validation.IsValidURL` (helpers.go:42-50) reduced to the JS platform:
 * an absolute URL whose scheme is http or https (Go's ParseRequestURI +
 * scheme check; the port check is dropped — WHATWG URL normalizes ports and
 * the protocols only use the value for display/redirect purposes).
 */
export function isValidAbsoluteHttpUrl(value: string): boolean {
  if (value === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
