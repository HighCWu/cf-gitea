/**
 * Shared seam between the protocol services (SPEC-0016 §7 — pypi.ts, helm.ts
 * and npm.ts). Everything here is a multi-consumer helper the landed M1 model
 * deliberately does not carry: the version-metadata write (upstream sets
 * MetadataJSON at INSERT time inside createPackageAndVersion,
 * services/packages/packages.go:218-245 — a re-published version keeps its
 * original metadata, so the write is gated on the versionCreated answer), the
 * URL validation arm (upstream validation.IsValidURL,
 * modules/validation/helpers.go:42-50 — absolute http/https URI), and the
 * package-property READ the per-ecosystem extension seam needs (upstream
 * GetProperties, models/packages/package_property.go — npm dist-tags are
 * version-scoped property rows, npm.go:387-395; property WRITES ride the
 * callers' drizzle batches).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packageProperties, packageVersions } from "../../db/schema";

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

// ---------------------------------------------------------------------------
// Package properties — the per-ecosystem extension seam
// (models/packages/package_property.go: PropertyType iota 0=version/1=file/
// 2=package; GetProperties orders by id — the insert order, package_property.go)
// ---------------------------------------------------------------------------

/** A property row as the protocol services consume it. */
export interface PackagePropertyRow {
  id: number;
  refType: number;
  refId: number;
  name: string;
  value: string;
}

/** `GetProperties` (package_property.go:60-70) — every property of one ref. */
export async function getPackageProperties(
  d1: D1Database,
  refType: number,
  refId: number,
): Promise<PackagePropertyRow[]> {
  return drizzle(d1)
    .select({
      id: packageProperties.id,
      refType: packageProperties.refType,
      refId: packageProperties.refId,
      name: packageProperties.name,
      value: packageProperties.value,
    })
    .from(packageProperties)
    .where(and(eq(packageProperties.refType, refType), eq(packageProperties.refId, refId)))
    .orderBy(asc(packageProperties.id))
    .all();
}
