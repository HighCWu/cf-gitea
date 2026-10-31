/**
 * The Conan registry protocol service (SPEC-0016 §7 long tail) — the service
 * half of `/api/packages/{username}/conan/v1|v2/...` (upstream
 * routers/api/packages/conan/{conan,search}.go +
 * models/packages/conan/{references,search}.go +
 * modules/packages/conan/{reference,metadata,conanfile_parser,
 * conaninfo_parser}.go):
 *
 * The revisions dance: upstream models recipe/package REVISIONS as
 * FILE-PROPERTY aggregates — every file carries `conan.recipe.user`,
 * `conan.recipe.channel`, `conan.recipe.revision` (+ `conan.package.
 * reference` / `conan.package.revision` on package files) and a revision
 * list is `SELECT property.value, MAX(file.created_unix) … GROUP BY value
 * ORDER BY created DESC` over the files matching the (user, channel[,
 * revision][, package reference]) filter (references.go:35-76 — the count
 * subquery demands ALL filter properties). The same property lattice
 * disambiguates FILES within one version row: the composite key is
 * `user|channel|recipeRevision[|packageRef|packageRevision]`
 * (reference.go:92-95/:148-152), so ONE version row carries every
 * revision's recipe files and every package's files.
 *
 * - Upload (conan.go:338-461): the filename MUST be in the recipe set
 *   {conanfile.py, conanmanifest.txt, conan_sources.tgz, conan_export.tgz}
 *   or the package set {conaninfo.txt, conanmanifest.txt, conan_package.tgz}
 *   (else the 400-nil arm); conanfile.py parses the six-field metadata
 *   (conanfile_parser.go — author/homepage/url/license/description/topics)
 *   written into the version row (an EXISTING version is UPDATED in place,
 *   conan.go:404-419); conaninfo.txt parses into the Conaninfo JSON riding
 *   the `conan.package.info` property (conan.go:423-434). OverwriteExisting
 *   is TRUE — an existing file row (same name + composite key) is
 *   delete-and-reinsert (the helm posture); IsLead = conanfile.py.
 * - Snapshot/digests/urls: the composite-key file walk (conan.go:174-322).
 * - Revisions (conan.go:699-833 + references.go): list/latest for recipe
 *   and package revisions; the empty list is the ErrRecipeReferenceNotExist
 *   404.
 * - Deletes (conan.go:509-696): the v1 arms ignore the recipe revision
 *   (deleteRecipeOrPackage(ignoreRecipeRevision=true)); the v2 arms pin it
 *   when present; a package delete with NO ids sweeps every reference. The
 *   last-file deletion folds the version row away
 *   (packages_service.DeletePackageVersionAndReferences).
 * - Search (search.go): the recipe query `name/version@user/channel`
 *   carries SQL-LIKE wildcards (* → %, `_` literal) matched against the
 *   lead-file rows + the recipe user/channel properties; the package
 *   search answers {reference: conaninfo} over the resolved revision(s).
 *
 * Divergences (documented per AGENTS.md): the v1 Authenticate mints a
 * package-scoped token via the auth module's mint seam at the ROUTE (the
 * service carries no credentials); JSON rendering is JSON.stringify (no Go
 * Marshal HTML escaping; the trailing newline of Go's json.Encoder IS
 * appended — the jsonResponse shape); the X-Conan-Server-Capabilities
 * header value is upstream's single "revisions".
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageVersionRow,
  PropertyType,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  getFileDescriptors,
  getOrInsertPackage,
  getOrInsertVersion,
  getVersionByNameAndVersion,
  hasVersionFileReferences,
  tryInsertFile,
} from "./model";
import { packageFiles, packageProperties, packageVersions, packages } from "../../db/schema";
import {
  copySpoolToContentKey,
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { writeVersionMetadata } from "./protocol-common";
import { deletePackageFile, deletePackageVersionAndReferences } from "./model";

// ---------------------------------------------------------------------------
// The reference grammar (modules/packages/conan/reference.go)
// ---------------------------------------------------------------------------

/** reference.go:18-19 — the conan-io ref.py limits (min 2, max 51 chars). */
const CONAN_NAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_+\-.]{1,50}$/;
const CONAN_REVISION_PATTERN = /^[a-zA-Z0-9]{1,51}$/;

/** reference.go:21 — DefaultRevision. */
export const CONAN_DEFAULT_REVISION = "0";

export interface ConanRecipeReference {
  name: string;
  version: string;
  user: string;
  channel: string;
  revision: string;
}

export interface ConanPackageReference {
  recipe: ConanRecipeReference;
  reference: string;
  revision: string;
}

/** The ErrValidation arm (reference.go:23). */
export class ConanReferenceValidationError extends Error {
  constructor() {
    super("could not validate one or more reference fields");
    this.name = "ConanReferenceValidationError";
  }
}

/** NewRecipeReference (reference.go:37-78): the "_" placeholders blank, the
 *  user/channel pairing, the name/version/user/channel/revision gates. */
export function newConanRecipeReference(
  name: string,
  version: string,
  user: string,
  channel: string,
  revision: string,
): ConanRecipeReference {
  if (user === "_") user = "";
  if (channel === "_") channel = "";
  if ((user !== "" && channel === "") || (user === "" && channel !== "")) {
    throw new ConanReferenceValidationError();
  }
  if (!CONAN_NAME_PATTERN.test(name)) {
    throw new ConanReferenceValidationError();
  }
  const trimmedVersion = version.trim();
  if (trimmedVersion === "") {
    throw new ConanReferenceValidationError();
  }
  if (user !== "" && !CONAN_NAME_PATTERN.test(user)) {
    throw new ConanReferenceValidationError();
  }
  if (channel !== "" && !CONAN_NAME_PATTERN.test(channel)) {
    throw new ConanReferenceValidationError();
  }
  if (revision !== "" && !CONAN_REVISION_PATTERN.test(revision)) {
    throw new ConanReferenceValidationError();
  }
  return { name, version: trimmedVersion, user, channel, revision };
}

/** NewPackageReference (reference.go:120-133). */
export function newConanPackageReference(
  recipe: ConanRecipeReference,
  reference: string,
  revision: string,
): ConanPackageReference {
  if (reference === "" || !CONAN_REVISION_PATTERN.test(reference)) {
    throw new ConanReferenceValidationError();
  }
  if (revision !== "" && !CONAN_REVISION_PATTERN.test(revision)) {
    throw new ConanReferenceValidationError();
  }
  return { recipe, reference, revision };
}

/** RevisionOrDefault (reference.go:80-85). */
export function conanRevisionOrDefault(revision: string): string {
  return revision === "" ? CONAN_DEFAULT_REVISION : revision;
}

/** String() (reference.go:87-96) — the display/reference form. */
export function conanRecipeString(r: ConanRecipeReference): string {
  const rev = r.revision === "" ? "" : `#${r.revision}`;
  if (r.user === "" || r.channel === "") {
    return `${r.name}/${r.version}${rev}`;
  }
  return `${r.name}/${r.version}@${r.user}/${r.channel}${rev}`;
}

/** LinkName (reference.go:98-109) — the v1 file-path form. */
export function conanRecipeLinkName(r: ConanRecipeReference): string {
  const user = r.user === "" ? "_" : r.user;
  const channel = r.channel === "" ? "_" : r.channel;
  return `${r.name}/${r.version}/${user}/${channel}/${conanRevisionOrDefault(r.revision)}`;
}

/** WithRevision (reference.go:111-113). */
export function conanRecipeWithRevision(r: ConanRecipeReference, revision: string): ConanRecipeReference {
  return { name: r.name, version: r.version, user: r.user, channel: r.channel, revision };
}

/** AsKey (reference.go:115-117) — the recipe composite key. */
export function conanRecipeAsKey(r: ConanRecipeReference): string {
  return `${r.user}|${r.channel}|${conanRevisionOrDefault(r.revision)}`;
}

/** LinkName (reference.go:135-137) — the package file-path form. */
export function conanPackageLinkName(p: ConanPackageReference): string {
  return `${p.reference}/${conanRevisionOrDefault(p.revision)}`;
}

/** WithRevision (reference.go:139-141). */
export function conanPackageWithRevision(p: ConanPackageReference, revision: string): ConanPackageReference {
  return { recipe: p.recipe, reference: p.reference, revision };
}

/** AsKey (reference.go:143-145) — the package composite key. */
export function conanPackageAsKey(p: ConanPackageReference): string {
  return `${p.recipe.user}|${p.recipe.channel}|${conanRevisionOrDefault(p.recipe.revision)}|${p.reference}|${conanRevisionOrDefault(p.revision)}`;
}

// The property keys (metadata.go) — upstream spellings verbatim.
export const CONAN_PROPERTY_RECIPE_USER = "conan.recipe.user";
export const CONAN_PROPERTY_RECIPE_CHANNEL = "conan.recipe.channel";
export const CONAN_PROPERTY_RECIPE_REVISION = "conan.recipe.revision";
export const CONAN_PROPERTY_PACKAGE_REFERENCE = "conan.package.reference";
export const CONAN_PROPERTY_PACKAGE_REVISION = "conan.package.revision";
export const CONAN_PROPERTY_PACKAGE_INFO = "conan.package.info";

// The upload filename sets (conan.go:32-52).
export const CONAN_FILE_CONANFILE = "conanfile.py";
export const CONAN_FILE_CONANINFO = "conaninfo.txt";
export const CONAN_RECIPE_FILES: readonly string[] = [
  CONAN_FILE_CONANFILE,
  "conanmanifest.txt",
  "conan_sources.tgz",
  "conan_export.tgz",
];
export const CONAN_PACKAGE_FILES: readonly string[] = [CONAN_FILE_CONANINFO, "conanmanifest.txt", "conan_package.tgz"];

// ---------------------------------------------------------------------------
// The parsers (conanfile_parser.go / conaninfo_parser.go)
// ---------------------------------------------------------------------------

/** The conanfile Metadata (metadata.go in modules/packages/conan). */
export interface ConanMetadata {
  author: string;
  license: string;
  project_url: string;
  repository_url: string;
  description: string;
  keywords: string[];
}

/** conanfile_parser.go:12-18 — the field patterns (`(?im)^\s*name\s*=\s*
 *  ['"\(](.+)['"\)]`). */
function conanfilePattern(field: string): RegExp {
  return new RegExp(`^[ \\t]*${field}[ \\t]*=[ \\t]*['"\\[](.+)['"\\)]`, "im");
}

const CONANFILE_AUTHOR = conanfilePattern("author");
const CONANFILE_HOMEPAGE = conanfilePattern("homepage");
const CONANFILE_URL = conanfilePattern("url");
const CONANFILE_LICENSE = conanfilePattern("license");
const CONANFILE_DESCRIPTION = conanfilePattern("description");
const CONANFILE_TOPICS = /^[ \t]*topics[ \t]*=[ \t]*\((.+)\)/im;
const CONANFILE_TOPIC_ITEM = /['"](.+?)['"]/g;

/**
 * ParseConanfile (conanfile_parser.go:24-67): the six regex arms over the
 * ≤ 1 MiB read; the license strips quote characters; the topics tuple
 * feeds the keywords.
 */
export function parseConanConanfile(text: string): ConanMetadata {
  const content = text.slice(0, 1024 * 1024);
  const metadata: ConanMetadata = {
    author: "",
    license: "",
    project_url: "",
    repository_url: "",
    description: "",
    keywords: [],
  };
  const capture = (pattern: RegExp): string => {
    const match = pattern.exec(content);
    return match?.[1] ?? "";
  };
  metadata.author = capture(CONANFILE_AUTHOR);
  metadata.project_url = capture(CONANFILE_HOMEPAGE);
  metadata.repository_url = capture(CONANFILE_URL);
  metadata.license = capture(CONANFILE_LICENSE).replaceAll('"', "").replaceAll("'", "");
  metadata.description = capture(CONANFILE_DESCRIPTION);
  const topics = CONANFILE_TOPICS.exec(content);
  if (topics !== null && topics[1] !== undefined && topics[1] !== "") {
    for (const match of topics[1].matchAll(CONANFILE_TOPIC_ITEM)) {
      if (match[1] !== undefined) metadata.keywords.push(match[1]);
    }
  }
  return metadata;
}

/** The Conaninfo struct (conaninfo_parser.go:16-26) in its json-tag order. */
export interface ConanInfo {
  settings: Record<string, string> | null;
  full_settings: Record<string, string> | null;
  requires: string[] | null;
  full_requires: string[] | null;
  options: Record<string, string> | null;
  full_options: Record<string, string> | null;
  recipe_hash: string | null;
  environment: Record<string, string[]> | null;
}

/** conaninfo_parser.go:137-146 — the invalid arm (content before ANY
 *  section header). */
export class ConanInfoInvalidError extends Error {
  constructor() {
    super("invalid conaninfo.txt");
    this.name = "ConanInfoInvalidError";
  }
}

function conaninfoToMap(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0 || eq === line.length - 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function conaninfoToMapArray(lines: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0 || eq === line.length - 1) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    out[key] = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1).split(",") : [value];
  }
  return out;
}

/**
 * ParseConaninfo (conaninfo_parser.go:29-62): the [section] walk; content
 * before any header is the invalid arm; empty sections keep their nil
 * fields (the json-tag shape renders null).
 */
export function parseConanConaninfo(text: string): ConanInfo {
  const sections = new Map<string, string[]>();
  let section = "";
  let lines: string[] = [];
  for (const raw of text.slice(0, 1024 * 1024).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      if (section !== "") sections.set(section, lines);
      section = line.slice(1, -1);
      lines = [];
      continue;
    }
    if (section !== "") {
      if (line !== "") lines.push(line);
      continue;
    }
    if (line !== "") {
      throw new ConanInfoInvalidError();
    }
  }
  if (section !== "") sections.set(section, lines);

  const info: ConanInfo = {
    settings: null,
    full_settings: null,
    requires: null,
    full_requires: null,
    options: null,
    full_options: null,
    recipe_hash: null,
    environment: null,
  };
  const take = (name: string): string[] => sections.get(name) ?? [];
  if (take("settings").length > 0) info.settings = conaninfoToMap(take("settings"));
  if (take("full_settings").length > 0) info.full_settings = conaninfoToMap(take("full_settings"));
  if (take("options").length > 0) info.options = conaninfoToMap(take("options"));
  if (take("full_options").length > 0) info.full_options = conaninfoToMap(take("full_options"));
  if (take("requires").length > 0) info.requires = take("requires");
  if (take("full_requires").length > 0) info.full_requires = take("full_requires");
  const recipeHash = take("recipe_hash");
  if (recipeHash.length > 0) info.recipe_hash = recipeHash[0] ?? null;
  if (take("env").length > 0) info.environment = conaninfoToMapArray(take("env"));
  return info;
}

// ---------------------------------------------------------------------------
// The property-file walk (models/packages/conan/references.go:35-76)
// ---------------------------------------------------------------------------

export interface ConanPropertyValue {
  value: string;
  created: Date;
}

interface ConanFileWithProps {
  file: PackageFileRow;
  version: PackageVersionRow;
  pkgName: string;
  props: Map<string, string>;
}

/** Every conan file of one owner with its property map attached (the
 *  reference.go walks' JS reduction — registry-small volumes). */
async function listConanFilesWithProps(d1: D1Database, ownerId: number): Promise<ConanFileWithProps[]> {
  const rows = await drizzle(d1)
    .select({ file: packageFiles, version: packageVersions, pkgName: packages.name })
    .from(packageFiles)
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        eq(packages.ownerId, ownerId),
        eq(packages.type, "conan"),
        eq(packages.isInternal, false),
        eq(packageVersions.isInternal, false),
      ),
    )
    .all();
  if (rows.length === 0) return [];
  const props = await drizzle(d1)
    .select({ refId: packageProperties.refId, name: packageProperties.name, value: packageProperties.value })
    .from(packageProperties)
    .where(
      and(
        eq(packageProperties.refType, PropertyType.File),
        inArray(
          packageProperties.refId,
          rows.map((row) => row.file.id),
        ),
      ),
    )
    .all();
  const byFile = new Map<number, Map<string, string>>();
  for (const prop of props) {
    const map = byFile.get(prop.refId) ?? new Map<string, string>();
    map.set(prop.name, prop.value);
    byFile.set(prop.refId, map);
  }
  return rows.map((row) => ({ file: row.file, version: row.version, pkgName: row.pkgName, props: byFile.get(row.file.id) ?? new Map() }));
}

/** A file's property map ⊇ the filter (the count-subquery semantics). */
function conanPropsMatch(props: Map<string, string>, filter: Record<string, string>): boolean {
  for (const [name, value] of Object.entries(filter)) {
    if (props.get(name) !== value) return false;
  }
  return true;
}

/** findPropertyValues (references.go:35-76): the cond carries the recipe's
 *  lower_name + lower_version beside the property filter; the property
 *  value groups with MAX(created), created DESC. */
async function findConanPropertyValues(
  d1: D1Database,
  ownerId: number,
  recipeName: string,
  recipeVersion: string,
  propertyName: string,
  filter: Record<string, string>,
): Promise<ConanPropertyValue[]> {
  const files = await listConanFilesWithProps(d1, ownerId);
  const best = new Map<string, Date>();
  for (const entry of files) {
    if (entry.pkgName.toLowerCase() !== recipeName.toLowerCase()) continue;
    if (entry.version.lowerVersion !== recipeVersion.toLowerCase()) continue;
    if (!conanPropsMatch(entry.props, filter)) continue;
    const value = entry.props.get(propertyName);
    if (value === undefined) continue;
    const created = entry.file.createdUnix;
    const current = best.get(value);
    if (current === undefined || created.getTime() > current.getTime()) {
      best.set(value, created);
    }
  }
  return [...best.entries()]
    .map(([value, created]) => ({ value, created }))
    .sort((a, b) => b.created.getTime() - a.created.getTime());
}

/** GetRecipeRevisions (references.go:79-91) — user + channel filter. */
export function listConanRecipeRevisions(d1: D1Database, ownerId: number, ref: ConanRecipeReference): Promise<ConanPropertyValue[]> {
  return findConanPropertyValues(d1, ownerId, ref.name, ref.version, CONAN_PROPERTY_RECIPE_REVISION, {
    [CONAN_PROPERTY_RECIPE_USER]: ref.user,
    [CONAN_PROPERTY_RECIPE_CHANNEL]: ref.channel,
  });
}

/** RecipeExists (references.go:26-32). */
export async function conanRecipeExists(d1: D1Database, ownerId: number, ref: ConanRecipeReference): Promise<boolean> {
  return (await listConanRecipeRevisions(d1, ownerId, ref)).length > 0;
}

/** The two not-exist sentinels (references.go:21-24). */
export class ConanRecipeReferenceNotExistError extends Error {
  constructor() {
    super("recipe reference does not exist");
    this.name = "ConanRecipeReferenceNotExistError";
  }
}

export class ConanPackageReferenceNotExistError extends Error {
  constructor() {
    super("package reference does not exist");
    this.name = "ConanPackageReferenceNotExistError";
  }
}

/** GetLastRecipeRevision (references.go:94-105). */
export async function getConanLastRecipeRevision(
  d1: D1Database,
  ownerId: number,
  ref: ConanRecipeReference,
): Promise<ConanPropertyValue> {
  const revisions = await listConanRecipeRevisions(d1, ownerId, ref);
  const first = revisions[0];
  if (first === undefined) throw new ConanRecipeReferenceNotExistError();
  return first;
}

/** GetPackageReferences (references.go:108-121) — the RAW recipe revision
 *  in the filter (an unpinned revision matches nothing, upstream's shape). */
export function listConanPackageReferences(
  d1: D1Database,
  ownerId: number,
  ref: ConanRecipeReference,
): Promise<ConanPropertyValue[]> {
  return findConanPropertyValues(d1, ownerId, ref.name, ref.version, CONAN_PROPERTY_PACKAGE_REFERENCE, {
    [CONAN_PROPERTY_RECIPE_USER]: ref.user,
    [CONAN_PROPERTY_RECIPE_CHANNEL]: ref.channel,
    [CONAN_PROPERTY_RECIPE_REVISION]: ref.revision,
  });
}

/** GetPackageRevisions (references.go:124-138). */
export function listConanPackageRevisions(
  d1: D1Database,
  ownerId: number,
  pref: ConanPackageReference,
): Promise<ConanPropertyValue[]> {
  return findConanPropertyValues(d1, ownerId, pref.recipe.name, pref.recipe.version, CONAN_PROPERTY_PACKAGE_REVISION, {
    [CONAN_PROPERTY_RECIPE_USER]: pref.recipe.user,
    [CONAN_PROPERTY_RECIPE_CHANNEL]: pref.recipe.channel,
    [CONAN_PROPERTY_RECIPE_REVISION]: pref.recipe.revision,
    [CONAN_PROPERTY_PACKAGE_REFERENCE]: pref.reference,
  });
}

/** GetLastPackageRevision (references.go:141-152). */
export async function getConanLastPackageRevision(
  d1: D1Database,
  ownerId: number,
  pref: ConanPackageReference,
): Promise<ConanPropertyValue> {
  const revisions = await listConanPackageRevisions(d1, ownerId, pref);
  const first = revisions[0];
  if (first === undefined) throw new ConanPackageReferenceNotExistError();
  return first;
}

/** GetPackageInfo (search.go:110-133) — the conan.package.info property of
 *  the FULLY-matched file. Throws ErrPackageReferenceNotExist when none. */
export async function getConanPackageInfo(
  d1: D1Database,
  ownerId: number,
  pref: ConanPackageReference,
): Promise<string> {
  const files = await listConanFilesWithProps(d1, ownerId);
  for (const entry of files) {
    if (entry.pkgName.toLowerCase() !== pref.recipe.name.toLowerCase()) continue;
    if (entry.version.lowerVersion !== pref.recipe.version.toLowerCase()) continue;
    if (
      conanPropsMatch(entry.props, {
        [CONAN_PROPERTY_RECIPE_USER]: pref.recipe.user,
        [CONAN_PROPERTY_RECIPE_CHANNEL]: pref.recipe.channel,
        [CONAN_PROPERTY_RECIPE_REVISION]: pref.recipe.revision,
        [CONAN_PROPERTY_PACKAGE_REFERENCE]: pref.reference,
        [CONAN_PROPERTY_PACKAGE_REVISION]: pref.revision,
      })
    ) {
      const info = entry.props.get(CONAN_PROPERTY_PACKAGE_INFO);
      if (info !== undefined) return info;
    }
  }
  throw new ConanPackageReferenceNotExistError();
}

// ---------------------------------------------------------------------------
// Upload (conan.go:338-461)
// ---------------------------------------------------------------------------

export interface UploadConanFileInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  recipe: ConanRecipeReference;
  /** The package half — null for a recipe file. */
  packageReference: { reference: string; revision: string } | null;
  filename: string;
  content: ReadableStream<Uint8Array>;
  declaredLength: number | undefined;
  quota: PackagesQuotaConfig;
  now?: Date;
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadConanFileResult {
  version: PackageVersionRow;
  file: PackageFileRow;
  blob: PackageBlobRow;
}

/** The filename filter arm (conan.go:344-347). */
export function isConanFilenameAllowed(filename: string, hasPackage: boolean): boolean {
  const set = hasPackage ? CONAN_PACKAGE_FILES : CONAN_RECIPE_FILES;
  return set.includes(filename);
}

/**
 * uploadFile (conan.go:338-461): the filter arm, the parse arms
 * (conanfile.py → the version metadata — an EXISTING version is UPDATED;
 * conaninfo.txt → the `conan.package.info` property), the quota arms, the
 * OverwriteExisting file insert (delete-and-reinsert, the helm posture).
 */
export async function uploadConanFile(input: UploadConanFileInput): Promise<UploadConanFileResult> {
  const hasPackage = input.packageReference !== null;
  if (!isConanFilenameAllowed(input.filename, hasPackage)) {
    throw new Error("filename is not allowed");
  }
  const pref =
    hasPackage && input.packageReference !== null
      ? newConanPackageReference(input.recipe, input.packageReference.reference, input.packageReference.revision)
      : null;
  const fileKey = pref !== null ? conanPackageAsKey(pref) : conanRecipeAsKey(input.recipe);

  const now = input.now ?? new Date();
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }

  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const bytes = new Uint8Array(await spoolObject.arrayBuffer());

    // The parse arms (conan.go:397-441) — BEFORE the version insert.
    let metadata: ConanMetadata | null = null;
    let infoJson: string | null = null;
    if (input.filename === CONAN_FILE_CONANFILE) {
      metadata = parseConanConanfile(new TextDecoder().decode(bytes));
    } else if (input.filename === CONAN_FILE_CONANINFO) {
      infoJson = JSON.stringify(parseConanConaninfo(new TextDecoder().decode(bytes)));
    }

    await checkSizeQuotaExceeded(input.d1, input.doer.isAdmin, input.owner.id, "conan", bytes.byteLength, input.quota);

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "conan",
      name: input.recipe.name,
      semverCompatible: false,
      now,
    });
    // conan.go:404-419 — an EXISTING version keeps its row (the conanfile
    // metadata UPDATES it in place); a fresh one carries the metadata.
    let version = await getVersionByNameAndVersion(input.d1, input.owner.id, "conan", input.recipe.name, input.recipe.version);
    if (version === null) {
      const { row } = await getOrInsertVersion(input.d1, {
        packageId: pkg.id,
        creatorId: input.doer.id,
        version: input.recipe.version,
        now,
      });
      version = row;
    }
    if (metadata !== null) {
      await writeVersionMetadata(input.d1, version.id, buildConanMetadataJson(metadata));
    }

    const { row: blob } = await getOrInsertBlob(input.d1, {
      size: bytes.byteLength,
      sha256: spooled.sha256,
      sha1: spooled.sha1,
      sha512: spooled.sha512,
      now,
    });

    const contentKey = packageBlobContentKey(spooled.sha256);
    if ((await input.bucket.head(contentKey)) !== null) {
      await input.bucket.delete(spooled.spoolKey);
    } else {
      await copySpoolToContentKey(input.bucket, spooled.spoolKey, spooled.sha256);
    }

    // conan.go:376-390 — Filename lowercased, CompositeKey the reference
    // key, IsLead the conanfile; OverwriteExisting: true (:389) — an
    // existing row is delete-and-reinsert (the helm posture; identical
    // bytes short-circuit idempotently).
    const filename = input.filename.toLowerCase();
    let fileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: filename,
      isLead: input.filename === CONAN_FILE_CONANFILE,
      compositeKey: fileKey,
      now,
    });
    if (fileResult.outcome !== "created") {
      const existing = fileResult.row;
      if (fileResult.outcome === "identical" && existing.blobId === blob.id && infoJson === null) {
        // The identical-blob re-upload without an info write: upstream's
        // OverwriteExisting replace is content-equal — keep the row (its
        // properties already stand).
      } else {
        await deletePackageFile(input.d1, existing.id);
        fileResult = await tryInsertFile(input.d1, {
          versionId: version.id,
          blobId: blob.id,
          name: filename,
          isLead: input.filename === CONAN_FILE_CONANFILE,
          compositeKey: fileKey,
          now,
        });
        if (fileResult.outcome !== "created") {
          throw new Error("conan file overwrite raced");
        }
      }
    }

    // The property lattice (conan.go:384-395): the recipe triple always;
    // the package pair when present; the info JSON property last.
    const propertyValues: Record<string, string> = {
      [CONAN_PROPERTY_RECIPE_USER]: input.recipe.user,
      [CONAN_PROPERTY_RECIPE_CHANNEL]: input.recipe.channel,
      [CONAN_PROPERTY_RECIPE_REVISION]: conanRevisionOrDefault(input.recipe.revision),
    };
    if (pref !== null) {
      propertyValues[CONAN_PROPERTY_PACKAGE_REFERENCE] = pref.reference;
      propertyValues[CONAN_PROPERTY_PACKAGE_REVISION] = conanRevisionOrDefault(pref.revision);
    }
    if (infoJson !== null) {
      propertyValues[CONAN_PROPERTY_PACKAGE_INFO] = infoJson;
    }
    await drizzle(input.d1)
      .insert(packageProperties)
      .values(
        Object.entries(propertyValues).map(([name, value]) => ({
          refType: PropertyType.File,
          refId: fileResult.row.id,
          name,
          value,
        })),
      )
      .run();

    return { version, file: fileResult.row, blob };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/** buildConanMetadataJson — the metadata.go tag order (omitempty set). */
export function buildConanMetadataJson(m: ConanMetadata): string {
  const out: Record<string, unknown> = {};
  if (m.author !== "") out.author = m.author;
  if (m.license !== "") out.license = m.license;
  if (m.project_url !== "") out.project_url = m.project_url;
  if (m.repository_url !== "") out.repository_url = m.repository_url;
  if (m.description !== "") out.description = m.description;
  if (m.keywords.length > 0) out.keywords = m.keywords;
  return JSON.stringify(out);
}

/** The stored metadata JSON back into the struct (loose). */
export function loadConanMetadata(version: PackageVersionRow): ConanMetadata {
  const zero: ConanMetadata = { author: "", license: "", project_url: "", repository_url: "", description: "", keywords: [] };
  if (version.metadataJson === null) return zero;
  try {
    const parsed: unknown = JSON.parse(version.metadataJson);
    if (parsed === null || typeof parsed !== "object") return zero;
    const record = parsed as Record<string, unknown>;
    const str = (key: string): string => (typeof record[key] === "string" ? (record[key]) : "");
    return {
      author: str("author"),
      license: str("license"),
      project_url: str("project_url"),
      repository_url: str("repository_url"),
      description: str("description"),
      keywords: Array.isArray(record.keywords) ? record.keywords.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return zero;
  }
}

// ---------------------------------------------------------------------------
// The composite-key file walks (conan.go:174-322)
// ---------------------------------------------------------------------------

export interface ConanFileEntry {
  file: PackageFileRow;
  blob: PackageBlobRow;
}

/** The files of one version whose composite key matches (SearchFiles'
 *  CompositeKey filter), descriptor order (lower_name ASC). */
export async function listConanFilesByKey(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  fileKey: string,
): Promise<{ version: PackageVersionRow; entries: ConanFileEntry[] } | null> {
  const version = await getVersionByNameAndVersion(d1, ownerId, "conan", recipe.name, recipe.version);
  if (version === null) return null;
  const descriptors = await getFileDescriptors(d1, version.id);
  const entries = descriptors.filter((descriptor) => descriptor.file.compositeKey === fileKey);
  return { version, entries };
}

/** serveSnapshot (conan.go:187-224): {filename: md5} — the WebCrypto
 *  reduction renders the EMPTY md5 (the landed blob-row note). */
export async function buildConanSnapshot(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  fileKey: string,
): Promise<Record<string, string> | null> {
  const found = await listConanFilesByKey(d1, ownerId, recipe, fileKey);
  if (found === null || found.entries.length === 0) return null;
  const files: Record<string, string> = {};
  for (const entry of found.entries) {
    files[entry.file.name] = entry.blob.hashMd5 ?? "";
  }
  return files;
}

/** serveDownloadURLs (conan.go:248-281): {filename: url}. */
export async function buildConanDownloadUrls(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  fileKey: string,
  urlBase: string,
): Promise<Record<string, string> | null> {
  const found = await listConanFilesByKey(d1, ownerId, recipe, fileKey);
  if (found === null || found.entries.length === 0) return null;
  const urls: Record<string, string> = {};
  for (const entry of found.entries) {
    urls[entry.file.name] = `${urlBase}/${entry.file.name}`;
  }
  return urls;
}

/** serveUploadURLs (conan.go:305-322): the requested sizes' JSON body
 *  {filename: size} filtered by the file set. The body rides the caller's
 *  bounded read. */
export function buildConanUploadUrls(sizes: Record<string, number>, hasPackage: boolean, urlBase: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const filename of Object.keys(sizes)) {
    if (isConanFilenameAllowed(filename, hasPackage)) {
      urls[filename] = `${urlBase}/${filename}`;
    }
  }
  return urls;
}

/** downloadFile (conan.go:477-506): the version → file (name + composite
 *  key) → blob walk with the lead GET bump. Null = the 404. */
export async function openConanFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  ownerId: number,
  recipe: ConanRecipeReference,
  fileKey: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<{ file: PackageFileRow; blob: PackageBlobRow; stream: ReadableStream; size: number } | null> {
  if (!isConanFilenameAllowed(filename, fileKey.split("|").length > 3)) {
    return null;
  }
  const found = await listConanFilesByKey(d1, ownerId, recipe, fileKey);
  if (found === null) return null;
  const match = found.entries.find((entry) => entry.file.name === filename);
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (match.file.isLead && method === "GET") {
    const { incrementDownloadCounter } = await import("./model");
    await incrementDownloadCounter(d1, found.version.id);
  }
  return { file: match.file, blob: match.blob, stream: object.body, size: object.size };
}

// ---------------------------------------------------------------------------
// The revision lists (conan.go:699-833)
// ---------------------------------------------------------------------------

export interface ConanRevisionInfo {
  revision: string;
  time: string;
}

/** listRevisions (conan.go:729-745): null = the ErrRecipeReferenceNotExist
 *  404 (the EMPTY list arm). */
export async function listConanRecipeRevisionsJson(
  d1: D1Database,
  ownerId: number,
  ref: ConanRecipeReference,
): Promise<{ revisions: ConanRevisionInfo[] } | null> {
  const revisions = await listConanRecipeRevisions(d1, ownerId, ref);
  if (revisions.length === 0) return null;
  return {
    revisions: revisions.map((entry) => ({ revision: entry.value, time: entry.created.toISOString() })),
  };
}

export async function listConanPackageRevisionsJson(
  d1: D1Database,
  ownerId: number,
  pref: ConanPackageReference,
): Promise<{ revisions: ConanRevisionInfo[] } | null> {
  const revisions = await listConanPackageRevisions(d1, ownerId, pref);
  if (revisions.length === 0) return null;
  return {
    revisions: revisions.map((entry) => ({ revision: entry.value, time: entry.created.toISOString() })),
  };
}

/** LatestRecipeRevision (conan.go:748-762) — the revision string or null. */
export async function getConanLatestRecipeRevision(
  d1: D1Database,
  ownerId: number,
  ref: ConanRecipeReference,
): Promise<ConanRevisionInfo | null> {
  try {
    const revision = await getConanLastRecipeRevision(d1, ownerId, ref);
    return { revision: revision.value, time: revision.created.toISOString() };
  } catch (error) {
    if (error instanceof ConanRecipeReferenceNotExistError) return null;
    throw error;
  }
}

export async function getConanLatestPackageRevision(
  d1: D1Database,
  ownerId: number,
  pref: ConanPackageReference,
): Promise<ConanRevisionInfo | null> {
  try {
    const revision = await getConanLastPackageRevision(d1, ownerId, pref);
    return { revision: revision.value, time: revision.created.toISOString() };
  } catch (error) {
    if (error instanceof ConanPackageReferenceNotExistError) return null;
    throw error;
  }
}

/** ListRecipeRevisionFiles / ListPackageRevisionFiles (conan.go:781-833):
 *  {files: {name: null}} — null = the 404 (the missing version OR the
 *  empty file list). */
export async function listConanRevisionFiles(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  fileKey: string,
): Promise<{ files: Record<string, null> } | null> {
  const found = await listConanFilesByKey(d1, ownerId, recipe, fileKey);
  if (found === null || found.entries.length === 0) return null;
  const files: Record<string, null> = {};
  for (const entry of found.entries) {
    files[entry.file.name] = null;
  }
  return { files };
}

// ---------------------------------------------------------------------------
// Deletes (conan.go:509-696)
// ---------------------------------------------------------------------------

export type ConanDeleteOutcome =
  | { kind: "deleted"; versionDeleted: boolean }
  | { kind: "not-found" }
  | { kind: "reference-not-exist" };

/**
 * deleteRecipeOrPackage (conan.go:631-696): the version → the property-
 * matched files → delete each → fold the empty version away.
 * `ignoreRecipeRevision` is the v1 arm; `ignorePackageRevision` rides the
 * package sweep.
 */
export async function deleteConanRecipeOrPackage(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  ignoreRecipeRevision: boolean,
  pref: ConanPackageReference | null,
  ignorePackageRevision: boolean,
): Promise<ConanDeleteOutcome> {
  const version = await getVersionByNameAndVersion(d1, ownerId, "conan", recipe.name, recipe.version);
  if (version === null) return { kind: "not-found" };

  const filter: Record<string, string> = {
    [CONAN_PROPERTY_RECIPE_USER]: recipe.user,
    [CONAN_PROPERTY_RECIPE_CHANNEL]: recipe.channel,
  };
  if (!ignoreRecipeRevision) {
    filter[CONAN_PROPERTY_RECIPE_REVISION] = conanRevisionOrDefault(recipe.revision);
  }
  if (pref !== null) {
    filter[CONAN_PROPERTY_PACKAGE_REFERENCE] = pref.reference;
    if (!ignorePackageRevision) {
      filter[CONAN_PROPERTY_PACKAGE_REVISION] = conanRevisionOrDefault(pref.revision);
    }
  }

  const files = await listConanFilesWithProps(d1, ownerId);
  const matched = files.filter((entry) => entry.version.id === version.id && conanPropsMatch(entry.props, filter));
  if (matched.length === 0) return { kind: "reference-not-exist" };

  for (const entry of matched) {
    await deletePackageFile(d1, entry.file.id);
  }
  let versionDeleted = false;
  if (!(await hasVersionFileReferences(d1, version.id))) {
    versionDeleted = true;
    await deletePackageVersionAndReferences(d1, version.id);
  }
  return { kind: "deleted", versionDeleted };
}

/**
 * DeleteRecipeV1 (conan.go:509-521) — the revision-ignoring sweep.
 */
export function deleteConanRecipeV1(d1: D1Database, ownerId: number, recipe: ConanRecipeReference): Promise<ConanDeleteOutcome> {
  return deleteConanRecipeOrPackage(d1, ownerId, recipe, true, null, false);
}

/**
 * DeleteRecipeV2 (conan.go:524-536) — the pinned revision, or the full
 * sweep when the reference carried none.
 */
export function deleteConanRecipeV2(d1: D1Database, ownerId: number, recipe: ConanRecipeReference): Promise<ConanDeleteOutcome> {
  return deleteConanRecipeOrPackage(d1, ownerId, recipe, recipe.revision === "", null, false);
}

/**
 * DeletePackageV1 (conan.go:539-585): the `package_ids` body — an EMPTY
 * list sweeps EVERY reference of EVERY revision.
 */
export async function deleteConanPackageV1(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  packageIds: string[],
): Promise<ConanDeleteOutcome> {
  const revisions = await listConanRecipeRevisions(d1, ownerId, recipe);
  let outcome: ConanDeleteOutcome = { kind: "deleted", versionDeleted: false };
  for (const revision of revisions) {
    const current = conanRecipeWithRevision(recipe, revision.value);
    let references: ConanPropertyValue[];
    if (packageIds.length === 0) {
      references = await listConanPackageReferences(d1, ownerId, current);
    } else {
      references = packageIds.map((value) => ({ value, created: new Date(0) }));
    }
    for (const reference of references) {
      const pref = newConanPackageReference(current, reference.value, CONAN_DEFAULT_REVISION);
      const deleted = await deleteConanRecipeOrPackage(d1, ownerId, current, true, pref, true);
      if (deleted.kind !== "deleted") return deleted;
      outcome = deleted;
    }
  }
  return outcome;
}

/**
 * DeletePackageV2 (conan.go:588-629): a PINNED package reference deletes
 * that package; an unpinned one sweeps every reference (the empty set is
 * the reference-not-exist arm).
 */
export async function deleteConanPackageV2(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  pref: ConanPackageReference | null,
): Promise<ConanDeleteOutcome> {
  if (pref !== null) {
    return deleteConanRecipeOrPackage(d1, ownerId, recipe, false, pref, pref.revision === "");
  }
  const references = await listConanPackageReferences(d1, ownerId, recipe);
  if (references.length === 0) return { kind: "reference-not-exist" };
  let outcome: ConanDeleteOutcome = { kind: "deleted", versionDeleted: false };
  for (const reference of references) {
    const target = newConanPackageReference(recipe, reference.value, CONAN_DEFAULT_REVISION);
    const deleted = await deleteConanRecipeOrPackage(d1, ownerId, recipe, false, target, true);
    if (deleted.kind !== "deleted") return deleted;
    outcome = deleted;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Search (search.go)
// ---------------------------------------------------------------------------

export interface ConanRecipeQuery {
  name: string;
  version: string;
  user: string;
  channel: string;
}

/** parseQuery (search.go:30-48): the `@`→`/` split; the `*` or missing
 *  parts stay empty (unfiltered). */
export function parseConanRecipeQuery(query: string): ConanRecipeQuery {
  const opts: ConanRecipeQuery = { name: "", version: "", user: "", channel: "" };
  if (query === "") return opts;
  const parts = query.replaceAll("@", "/").split("/");
  opts.name = parts[0] ?? "";
  if (parts.length > 1 && parts[1] !== "*") opts.version = parts[1] ?? "";
  if (parts.length > 2 && parts[2] !== "*") opts.user = parts[2] ?? "";
  if (parts.length > 3 && parts[3] !== "*") opts.channel = parts[3] ?? "";
  return opts;
}

/** buildCondition (references/search.go:21-26): the LIKE wildcard —
 *  `*` matches anything, `_` is a literal underscore. */
function conanLikeToRegex(value: string): RegExp {
  let pattern = "";
  for (const ch of value) {
    if (ch === "*") pattern += "[\\s\\S]*";
    else pattern += ch.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`, "i");
}

function conanQueryMatches(opts: ConanRecipeQuery, name: string, version: string, user: string, channel: string): boolean {
  const check = (filter: string, value: string): boolean => {
    if (filter === "") return true;
    if (filter.includes("*")) return conanLikeToRegex(filter).test(value);
    return filter.toLowerCase() === value.toLowerCase();
  };
  return (
    check(opts.name, name) &&
    check(opts.version, version) &&
    check(opts.user, user) &&
    check(opts.channel, channel)
  );
}

/**
 * SearchRecipes (search.go:17-56): the unique `name/version@user/channel`
 * strings over the lead files + the recipe user/channel properties (the
 * recipe string carries the @user/channel only when BOTH stand — the
 * search.go:56-75 assembly).
 */
export async function searchConanRecipes(d1: D1Database, ownerId: number, query: string): Promise<string[]> {
  const opts = parseConanRecipeQuery(query);
  const files = await listConanFilesWithProps(d1, ownerId);
  const unique = new Set<string>();
  for (const entry of files) {
    if (!entry.file.isLead) continue;
    const user = entry.props.get(CONAN_PROPERTY_RECIPE_USER) ?? "";
    const channel = entry.props.get(CONAN_PROPERTY_RECIPE_CHANNEL) ?? "";
    if (!conanQueryMatches(opts, entry.pkgName, entry.version.version, user, channel)) {
      continue;
    }
    const base = `${entry.pkgName}/${entry.version.version}`;
    unique.add(user !== "" && channel !== "" ? `${base}@${user}/${channel}` : base);
  }
  return [...unique];
}

/**
 * SearchPackages (search.go:59-133): the reference → conaninfo map over
 * the resolved revisions. `searchAllRevisions` is the V1 flag; the v2
 * unpinned arm resolves the LAST revision first (the 404 when none).
 */
export async function searchConanPackages(
  d1: D1Database,
  ownerId: number,
  recipe: ConanRecipeReference,
  searchAllRevisions: boolean,
): Promise<Record<string, ConanInfo> | null> {
  let revisions: ConanPropertyValue[];
  if (searchAllRevisions) {
    revisions = await listConanRecipeRevisions(d1, ownerId, recipe);
    if (revisions.length === 0) return null;
  } else if (recipe.revision !== "") {
    if (!(await conanRecipeExists(d1, ownerId, recipe))) return null;
    revisions = [{ value: recipe.revision, created: new Date(0) }];
  } else {
    const last = await getConanLastRecipeRevision(d1, ownerId, recipe).catch(() => null);
    if (last === null) return null;
    revisions = [last];
  }

  const result: Record<string, ConanInfo> = {};
  for (const revision of revisions) {
    const current = conanRecipeWithRevision(recipe, revision.value);
    const references = await listConanPackageReferences(d1, ownerId, current);
    for (const reference of references) {
      if (result[reference.value] !== undefined) continue;
      let lastPackageRevision: ConanPropertyValue;
      try {
        const probe = newConanPackageReference(current, reference.value, "");
        lastPackageRevision = await getConanLastPackageRevision(d1, ownerId, probe);
      } catch (error) {
        if (error instanceof ConanPackageReferenceNotExistError) return null;
        throw error;
      }
      const pref = newConanPackageReference(current, reference.value, lastPackageRevision.value);
      const infoRaw = await getConanPackageInfo(d1, ownerId, pref);
      result[pref.reference] = parseConanConaninfoJsonText(infoRaw);
    }
  }
  return result;
}

/** GetPackageInfo's JSON decode (search.go:126-131) — a malformed row is
 *  the plain error (the 500 arm). */
function parseConanConaninfoJsonText(raw: string): ConanInfo {
  try {
    return JSON.parse(raw) as ConanInfo;
  } catch {
    throw new Error("the stored conaninfo is malformed");
  }
}
