/**
 * The Conda registry battery (SPEC-0016 §7 long tail) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/conda/conda.go +
 * modules/packages/conda/metadata.go at the pin, through the SERVICE face
 * (the terraform.test.ts precedent; the route arms ride packages-conda):
 *
 *  - the parse: the REAL system-bzip2 fixtures (bzip2 1.0.8 -9, embedded
 *    base64 — authored with the upstream tool on purpose; the in-repo
 *    encoder landed later as ./bz2-encode.ts, wall 3 ADOPTED)
 *    covering index+about, the about-less minimal, the name/version gates
 *    (the conda-build grammar), the missing-index structure sentinel, the
 *    corrupt-stream archive class, the URL validation (a relative home
 *    clears, an ftp:// absolute clears — validation.IsValidURL's
 *    http/https-only gate, helpers.go:42-51), and the decode-error class
 *    (a string build_number, an array document, a non-string depends
 *    element) vs the JSON-null no-op corner (null index decodes to the
 *    zero struct → the name gate);
 *  - the `.conda` parse (wall 2 ADOPTED): REAL conda containers authored
 *    with python's tarfile + zstandard(3) + zipfile at write time —
 *    stored- and deflate-member zips over `info-*.tar.zst`, the
 *    is_conda=true flip, the no-info-member structure sentinel, the
 *    corrupt-zip / broken-inner-zstd archive classes, and the name gate
 *    through the container;
 *  - the metadata JSON renders: the FileMetadata/VersionMetadata tag order
 *    with the omitempty sweep (is_conda always present);
 *  - the upload: rows under the channel-prefixed package name, the
 *    `{name}-{version}-{build}.tar.bz2` stored file under the subdir
 *    composite key, the conda.name/channel/subdir/metadata properties (the
 *    EMPTY-channel row included), the version metadata written at VERSION
 *    creation only (a second file does NOT rewrite it), the duplicate
 *    stored name 409, blob dedupe + the R2 content-key byte parity;
 *  - the repodata: the exact RepoData render (struct order, the Go map-key
 *    sort, the trailing newline), the empty-404 null, the channel/subdir
 *    filters, the is_conda split, the md5 "" render (no WebCrypto MD5);
 *  - the download: the EXACTLY-one gate (a same-name pair is the 404 class),
 *    the GET-only counter bump, byte parity.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import { packageBlobs, packageFiles, packageProperties, packageVersions, packages, users } from "../../db/schema";
import { DuplicatePackageFileError } from "./generic";
import { PropertyType, QuotaTotalCountError, getOrInsertVersion, packagesQuotaFromEnv, tryInsertFile } from "./model";
import {
  CONDA_PROPERTY_CHANNEL,
  CONDA_PROPERTY_METADATA,
  CONDA_PROPERTY_NAME,
  CONDA_PROPERTY_SUBDIR,
  CONDA_REPODATA_NAMES,
  CondaArchiveError,
  CondaInvalidNameError,
  CondaInvalidStructureError,
  CondaInvalidVersionError,
  buildCondaFileMetadataJson,
  buildCondaVersionMetadataJson,
  buildCondaRepodata,
  condaCheckName,
  condaCheckVersion,
  condaRepodataContentType,
  encodeCondaRepodataBody,
  isCondaPackageFileName,
  isValidCondaUrl,
  loadCondaFileMetadata,
  openCondaFileForDownload,
  parseCondaPackageConda,
  parseCondaPackageTarBz2,
  searchCondaFiles,
  uploadCondaPackageFile,
  type UploadCondaPackageInput,
} from "./conda";
import { bzip2Decompress } from "./bz2";
import { base64ToBytes, bytesToHex } from "./distro-common";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "repositories",
    "personal_access_tokens",
    "auth_failures",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
});

const db = () => drizzle(env.DB);

async function seedUser(username: string): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: "public",
      createdAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// The fixtures — REAL conda packages authored with system tar + bzip2
// 1.0.8 (-9) at write time, embedded base64 (the composer bz2 posture:
// upstream-tool output on purpose — the in-repo encoder arrived later,
// ./bz2-encode.ts, and the parse keeps testing REAL tool bytes).
// ---------------------------------------------------------------------------

/** index.json + about.json, the full form (numpy 1.26.0, linux-64). */
const F1_FULL = "QlpoOTFBWSZTWfWVxcoAAX//gsaQAiBQF//3PAFqCv//3+pAAAIIQAH8kTWyGiaTKT9U2T0hmkNE9IYmmh6h6QHqaG1ANIEwmk0aekZAAjIMBGjEBtA5hMAmAEwmE0wAACZNNAwkkTEmSehpMEYIDQA0aA0A002nUjzPS4YC6oIjSzMkhp0hCw4sDpJGJWDEi2TATiLqGQA5My2dzPFMjWhy/WLu9X46iMqPZGrPhHKcGVOXuuW1mt6heVGo+EiYPf5W9wGrCB+GSEYMKUoz81AKxytLYVJl6GRdkIRMybtOaJDtb90hPja6rESJddCTzJwrkSKrWhkjBrohxwEj1NeQ0IoYRAQyJDhFFnH2PmRBpI6XNOi88RbioNJ6KhEdPhq04MyHSRUikVwcOYQwtxRV+m2tVjPPOIsDhETPXMQLSRlq8noUloVocPUHQYX2zV13bGkNoq19/Vxisd9JMZB+KIbxv5buJsEdfIJwQYsGDvZ2aJILNcsgO39jJLJ0Q/fXeLAMmqF0KhakF46lHHpFIU4pMcPE8yHeXUEGQMYjhSYYlIep39Zloie4IiY8OWGcYJmjJdQJZgPBGVTzmHUEGez3CZEnvmzsJgx3I0sygbuJX43iqvM0h04wJgDzzOoryooJ0REkWSEAlcqUsMGSQCLfRoY6yKXxsJ7I8AnXDEIhEQXYB6wa0EdVyVS1vkJs1sA9oVNCDCw75a2ow2YldrlR/IuE00dtDjDlcD2ymyVKAP8XckU4UJD1lcXK";
/** index.json only — about.json absent (the zero-filled metadata). */
const F2_MINIMAL = "QlpoOTFBWSZTWTXyhRMAALj7hsSQACBQBf+QIAj/d5/aAARAAAAIMADa0wlTUNA1ND1MmQ9QaGmmmjGoJVM0iepmk00xMAQ0BiAJKSNMQxG0Jk0GjRiGmFJ53cYc3RggIHhCQ11DXmm9ms2BEMEgcMXCEvIDuuPrxb2ltSwXmkAnAHOywG1KNoNQDtbUKQFG1YOcsvx5EjGigY0cWBAlqDRHpFrUChIpowWsIWKEK0LMSm/7jKVhyxJukafqIi6bIJWF+j9J3NHy51FC1JloNYuQTCBK3sJ5FVkzyJw8nhpuWJBoLuSKcKEga+UKJg==";
/** index.json name "NumPy" — the lowercase gate. */
const F3_BAD_NAME = "QlpoOTFBWSZTWUsa8WYAAKf/gsKQACBQBf+QAAFgCG9zn+pAAAAIMAC1UJUnpRptIYmTJkBpiZB7SgkoNQm1NDIAYgABoYAGjQ0YRk0GjTQGbTlKuqJRgkBOJzkIQzIsfYSrYmRkHCQPFQaehB9tF6LZLZuX2b+DCMLogPF9AxoRDkCuTy8ufMOCaknC+55QMqoQg4HDUYgjEIUry8K/poCan6NFDGSC8ofuZOrFNiazzjBxGPgSzCjsMzMJB/F3JFOFCQSxrxZg";
/** index.json version "1.0-rc1" — the '-' gate. */
const F4_BAD_VERSION = "QlpoOTFBWSZTWYFWZdoAAKf7gsKQACBQB/+QIAh/d5/aQAAACDAAtawlSekTTQGmQYjT1A2oNk9UElRlDQyNHohgIyGjEYJVPUAmmCZGAEwAmJpi2HnwaQZpAbBCQ0TtbjexpqCIeEgfP74weIX27XZcJbOOpI/DXUMmC6QDq6kY0JChAs0oOLFWRAZcJAtRRorYH1lRAQYb8AuuCzggfNzN4XS/Ye2kQxw9LHosHFe5kSdJiD68lJxTRaKZ20vNEg0F3JFOFCQgVZl2gA==";
/** no info/index.json — the structure sentinel. */
const F5_NO_INDEX = "QlpoOTFBWSZTWdGSGFMAAJ37gsKQCCBAAf+AIAhu457AQAAACCAAkQlSGgeoGgAAD1BKE0mSaBtQ9Tamg0GmtT3hjuciiAXyQREHooUlQ2s5cHAURAYsyQNBjN+xGswmCZWvEgCmTIXKWKxIBFJnEMVJDmDMoKXxmwO4QQqb1MzuFtac/Sx0/A5Gp2kaE/HwrRRflLhRz4xgfi7kinChIaMkMKY=";
/** about.json with a relative home + an ftp:// dev_url — the URL validation. */
const F7_BAD_URLS = "QlpoOTFBWSZTWY95SOQAAOz7hsaQACBQB//QIAj/d9/qAoBAAAAIMAD7TAyinpMTyaE00aepoAaGgNHlCNFACYmgxGI0MmEwEwNqSaBNANNAAaMgDQDSVK5PeX5QjWmEDRgAqFPEihSUF2JQkaL4wQIkGhIFBaEHerK5mhVY+lJo0pmsWkpIZoZIOcoDtnF++B/iRlqxLMidFLJFSryiUCGKnCVNY55tTkSxDGA1omcPLcoOREpI3jKuqZQkMaHEGMSsSbsEmWrdYfmFvsF3NoEnpMgmuMRV9BRN+fC9lN69oSBkblpqQAp4CEPMtbAoVVtxLKLGAeFMTPARFQnSw6qEhy3iBkpmXrMDa2KhwjEZBA/i7kinChIR7ykcgA==";
/** f1 truncated mid-stream — the corrupt-archive class. */
const F6_CORRUPT = "QlpoOTFBWSZTWfWVxcoAAX//gsaQAiBQF//3PAFqCv//3+pAAAIIQAH8kTWyGiaTKT9U2T0hmkNE9IYmmh6h6QHqaG1ANIEwmk0aekZAAjIMBGjEBtA5hMAmAEwmE0wAACZNNAwkkTEmSehpMEYIDQA0aA0A002n";
/** index.json build_number as a STRING — the int64 decode-error class. */
const F8_TYPE_MISMATCH = "QlpoOTFBWSZTWbkAKRIAAKx7g8KQACBQBf+QIAj/d5/aQAAABAAIMACxBKij1P1Q9Ro00DJiMTTJo2pvVBKTQUwnqHqGmmjEAANAwBpoaNGIyAaADQyw40yi4/IgE+IQRCUoBnmcY2OIBkGCICmCjTqKOu15n7qsGPPlZYvcjIIhsYBdfIRoMJ1CopVNV5AaD4UCtL1GVjxowjMgpdCege8G0saWNOvwuwS8MEdTi9xAEhcq5U710/qiTQyGRrzoXntXiHPipt7CmZ7ZGuGMD+LuSKcKEhcgBSJA";
/** index.json is an ARRAY — the decode-error class. */
const F9_ARRAY = "QlpoOTFBWSZTWf6uek8AAKF7gsGQADBABf+AIApvcZ7AQAAACCAAkglICj0mmT1GT0IA2mQSU1J+pqeptQ09TTBAANgf+89tHHSAlFCSHtgFI0J8XIhaQEgYwZVHkY5fvQ85hIFlnIVQQJMFZqY3wzKxgd/EzaNL3RFMFFsEFkn2chzgYlWrNj+Gn1RUPPuHyU0mUmUqMKEShVYiBuLuSKcKEh/Vz0ng";
/** index.json is `null` with trailing-whitespace padding (a JSON doc may
 *  carry trailing whitespace; the mass keeps the bzip2 stream off the
 *  degenerate ~40-byte corner) — Go's decode no-op → the zero struct →
 *  the name gate. */
const F10_NULL = "QlpoOTFBWSZTWWjgk24AAJ77wsSQACBAAf+AIAhvdZ7AABJAAAAIIACSCUjUnkmRkDI00wTTzVAqkp5JpoD1ANAABsc7tGT9YlAfbREK68JqxaWadFpVKEGBj61RRY7sD54UylxF/C1EyVEs8ySUL6qJhRhA6KsXopVSg8U8w496SMAoQ3NQwzcSDGbae29SThIaQ0RTnM7Exn7uBAd/F3JFOFCQaOCTbg==";
/** depends carries a non-string element — the decode-error class. */
const F11_BAD_DEPENDS = "QlpoOTFBWSZTWbtZUfIAAK17g8KQACBQBf+QIAp/f9/aQAAABAAIMAC61hKmRQAaZAaGTQ0PSNNpPUEqjJkjTCaYjACMmmQZMElJPU9J6gNqGhoYjQDQG1KDlihkaRSAfKISIQcGfA0xsaODKMEgkP0g0eKOornlqs330rhnZyh7NWwJAoQCrNMMaCGRQ7HJDEtosSCluCElqBmYUJGR7gwILF8XBSgT0zsWZMCG60e8MTj5bZcjiAXPjHrT0jBSSWtC8bja5wzN3uiSkR9BcPvTRviQfxdyRThQkLtZUfI=";
/** numpy 1.26.0 again — build py3h_1, license_family PATENT (the
 *  second-file arm: same package + version, a NEW stored file). */
const F12_SECOND_BUILD = "QlpoOTFBWSZTWTEwJvQAAT7/gsyRACBQB//3PgFsCv/33+pAAAAIMAGbSttQalGmnpDRpk00xGjIMTIwTJphGmAymSYpmmppkyhkaNADIGhobUDIEkiammUxp6jQmCMmagNAaNGEBpx1LYUXokIKdwkmlABYLtMor5NfVD5YKuK4mAgIBuCAKdhQ1bQ6FOJvBq0bb4Oz0I9E2Ky/Cuv4+W/U4XNAfzJ6YYczm9nA6mpRZbGF2+d/n4d1p+Rt/3LiMk3XFPfF0HGPOVCtJZ+Ft4ltMPTUghBJyc4WJV3TX5G6ZgMB7ROcbQZ6B3YImY+OrzgX3ZgrBRmMWmSAXVJOCEkpdsxNc8Zq6ncKtlu3kKpMtPrHdIUb/LdIZrJtqpXyZYl5JLXyk695v0AB6PsTWgyE0IgkQ/jEVprOCk0+kDFmEQz3sFsLUVyDRA2MkIv07gZPYWYRaIrB33/VwDHWKPekeU/uAtg0mCMWdhgz2ZD0VpMrAxgpkZSFONVCO9lxhjxWH5cUqeu4wmIaLCrqVrErAlud7q2lXcIsn4kCCsjQCbXahPbV5XGr3TTQ9kYSxxVMhbs6FxTWrhCE2qJezORnKpeRID/F3JFOFCQMTAm9AA==";

// --- the `.conda` container fixtures (wall 2 ADOPTED) — REAL conda
// containers: python tarfile + zstandard(3) + zipfile at authoring time,
// embedded base64 (the stored-member and deflate-member zip shapes; the
// inner tar carries info/index.json + info/about.json exactly as the
// `.tar.bz2` fixtures do). numpy 1.26.0, build py3h_2 (build_number 2).
const F_CONDA_NUMPY = "UEsDBBQAAAAAAOt8YV1a79KcwQEAAMEBAAATAAAAaW5mby05ZjJjMWQudGFyLnpzdCi1L/1gACe9DQAmmU0iME31g4pyU1JCfQS6Y3Ueq+VByXrtwRK6tml7K6SBg4EWFEQARwBCAND0hvEwBCYmV1szxsIUn/ErlFiMrIrK64udBWXzRdF91Gb/Nh9N02il6UajWQIa5WCYpru7aRjd3YfPh2AT8HlMZuQxM7KNogoNCBUVZYueBf82KmHBLBQaEN6hi9Ri5GEBMIVbs1YYQ4AMMKbAgH1OtqLLgZ31zyGFbzGysLMqhOT1Z3kmpqKPijf2UjkduxhF6zC65zojhlKLcI0y1axD2Z7fiOFk+SNXDPIuWBqre/iWVuydUDsquqGws6hs9qGMdlHjg+5PXI+UrAErcfO5+RI5HYPuZKNE1ftIwJdIdbIkcZ5aO83prYMQ0OTnjZF/dTpYGXnJY7XPyEse/6GblXLVaj2oTcr7TPIYMiCAApFjxMADEAA8GMMv1UhbgIWmmpT7HkhMAGFYhs5gL98kg+Ho/QgyAP8tx+2iUW1B+7hcpsr0Gp70AyTYsKMY2VWZIcwqeGhjcFaMQILh2s8UrRqQ9VenZi8tJO8PL3s+dktxCbrFW+twi7KBrDnA48ONLMVxDJcRE1gCUEsDBBQAAAAAAOt8YV17J4PqWgAAAFoAAAASAAAAcGtnLTlmMmMxZC50YXIuenN0KLUv/WAAJ4UCAHQDbGliL2xpYmRlbW8uc28AMDAwMDY0NDAwMDE3NTAAMTQ1MjQ3NzA0MTA1MzYAIDB1c3RhcgAwMAgA3CbHAwAyICEgZrihLAVwrFyGTKAOUEsBAhQDFAAAAAAA63xhXVrv0pzBAQAAwQEAABMAAAAAAAAAAAAAAIABAAAAAGluZm8tOWYyYzFkLnRhci56c3RQSwECFAMUAAAAAADrfGFdeyeD6loAAABaAAAAEgAAAAAAAAAAAAAAgAHyAQAAcGtnLTlmMmMxZC50YXIuenN0UEsFBgAAAAACAAIAgQAAAHwCAAAAAA==";
// the deflate-member zip twin (method 8 members through DecompressionStream).
const F_CONDA_NUMPY_DEFLATED = "UEsDBBQAAAAIAOt8YV1a79KcxgEAAMEBAAATAAAAaW5mby1hYmMxMjMudGFyLnpzdAHBAT7+KLUv/WAAJ70NACaZTSIwTfWDinJTUkJ9BLpjdR6r5UHJeu3BErq2aXsrpIGDgRYURABHAEIA0PSG8TAEJiZXWzPGwhSf8SuUWIysisrri50FZfNF0X3UZv82H03TaKXpRqNZAhrlYJimu7tpGN3dh8+HYBPweUxm5DEzso2iCg0IFRVli54F/zYqYcEsFBoQ3qGL1GLkYQEwhVuzVhhDgAwwpsCAfU62osuBnfXPIYVvMbKwsyqE5PVneSamoo+KN/ZSOR27GEXrMLrnOiOGUotwjTLVrEPZnt+I4WT5I1cM8i5YGqt7+JZW7J1QOyq6obCzqGz2oYx2UeOD7k9cj5SsAStx87n5Ejkdg+5ko0TV+0jAl0h1siRxnlo7zemtgxDQ5OeNkX91OlgZecljtc/ISx7/oZuVctVqPahNyvtM8hgyIIACkWPEwAMQADwYwy/VSFuAhaaalPseSEwAYViGzmAv3ySD4ej9CDIA/y3H7aJRbUH7uFymyvQanvQDJNiwoxjZVZkhzCp4aGNwVoxAguHazxStGpD1V6dmLy0k7w8vez52S3EJusVb63CLsoGsOcDjw40sxXEMlxETWAJQSwMEFAAAAAgA63xhXXsng+pXAAAAWgAAABIAAABwa2ctYWJjMTIzLnRhci56c3TT2Kr/N4FBvZWJoYQ5JzNJH4hTUnPz9YrzGQyAwMzEBEgampsaMBiamBqZmJsbmBgamBqbMSgYlBaXJBYBVXEw3FE7zsxgpKCokLZjoQ5rwZqYNp8FfABQSwECFAMUAAAACADrfGFdWu/SnMYBAADBAQAAEwAAAAAAAAAAAAAAgAEAAAAAaW5mby1hYmMxMjMudGFyLnpzdFBLAQIUAxQAAAAIAOt8YV17J4PqVwAAAFoAAAASAAAAAAAAAAAAAACAAfcBAABwa2ctYWJjMTIzLnRhci56c3RQSwUGAAAAAAIAAgCBAAAAfgIAAAAA";
// a zip with NO `info-*.tar.zst` member — the invalid-structure sentinel.
const F_CONDA_NOINFO = "UEsDBBQAAAAAAOt8YV17J4PqWgAAAFoAAAAQAAAAcGtnLW9ubHkudGFyLnpzdCi1L/1gACeFAgB0A2xpYi9saWJkZW1vLnNvADAwMDA2NDQwMDAxNzUwADE0NTI0NzcwNDEwNTM2ACAwdXN0YXIAMDAIANwmxwMAMiAhIGa4oSwFcKxchkygDlBLAQIUAxQAAAAAAOt8YV17J4PqWgAAAFoAAAAQAAAAAAAAAAAAAACAAQAAAABwa2ctb25seS50YXIuenN0UEsFBgAAAAABAAEAPgAAAIgAAAAAAA==";
// a truncated zip — the corrupt-archive class.
const F_CONDA_CORRUPT = "UEsDBBQAAAAAAOt8YV1a79KcwQEAAMEBAAATAAAAaW5mby05ZjJjMWQudGFyLnpzdCi1L/1gACe9DQAmmU0iME31g4pyU1JCfQS6Y3Ueq+VByXrtwRK6tml7K6SBg4EWFEQARwBCAND0hvEwBCYmV1szxsIUn/ErlFiMrIrK64udBWXzRdF91Gb/Nh9N02il6UajWQIa5WCYpru7aRjd3YfPh2AT8HlMZuQxM7KNogoNCBUVZYueBf82KmHBLBQaEN6hi9Ri5GEBMIVbs1YYQ4AMMKbAgH1OtqLLgZ31zyGFbzGysLMqhOT1Z3kmpqKPijf2UjkduxhF6zC65zojhlKLcI0y1axD2Z7fiOFk+SNXDPIuWBqre/iWVuydUDsquqGws6hs9qGMdlHjg+5PXI+UrAErcfO5+RI5HYPuZKNE1ftIwJdIdbIkcZ5aO83prYMQ0OTnjZF/dTpYGXnJY7XPyEse/6GblXLVaj2oTcr7TPIYMiCAApFjxMADEAA8GMMv1UhbgIW";
// a valid zip whose `info-*.tar.zst` member holds garbage — the zip CRC
// is clean, the inner zstd stream is not (the broken-inner-zstd class).
const F_CONDA_BADZST = "UEsDBBQAAAAAAPd8YV2eKdZ/gAAAAIAAAAARAAAAaW5mby1iYWQxLnRhci56c3SZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM5kRIjOZESIzmREiM1BLAQIUAxQAAAAAAPd8YV2eKdZ/gAAAAIAAAAARAAAAAAAAAAAAAACAAQAAAABpbmZvLWJhZDEudGFyLnpzdFBLBQYAAAAAAQABAD8AAACvAAAAAAA=";
// the name gate through the container: index.json name "NumPy".
const F_CONDA_BADNAME = "UEsDBBQAAAAAAPd8YV3TU02ufAAAAHwAAAAUAAAAaW5mby1iYWRuYW1lLnRhci56c3QotS/9YAAnlQMAosUTGXBJdTAVqqFoTA6mYrh6l7WkbdoQhKpqsAwNdUGnmHUMvpVQcuiC0OJAiUBXU6sMO59CwGiSf7K5U/oJ3CS6bftHtp3r4KEoVmEZwBmWBQsA+gR4oDVYxL1pDTdHWQAyzAEeZrihLAVwrFxGTGAJUEsBAhQDFAAAAAAA93xhXdNTTa58AAAAfAAAABQAAAAAAAAAAAAAAIABAAAAAGluZm8tYmFkbmFtZS50YXIuenN0UEsFBgAAAAABAAEAQgAAAK4AAAAAAA==";
// numpy 1.26.0 build py3h_1 — the second-build arm through the container.
const F_CONDA_NUMPY2 = "UEsDBBQAAAAAAOt8YV3tQUGhwgEAAMIBAAATAAAAaW5mby1hYWExMTEudGFyLnpzdCi1L/1gACfFDQAm2U0jIG31YyrlZqWE+gh0x2pjIBqA+Y1X1ym06qb3BEklQQCBsAFEAEcAQgDQ9IbxMAQek6utGWPBFp/xK4xYnKyKyuuLnQVl8yXRjdRm/zYjTdPopelGo1kENAvCME13d9MwursRn//AHvB5VGbkMTOyjaIJDI6KirJFz4J/G4WgYBQJDI536CK1OHFYAGzh1qwXxhAkA4wpMGCfk63oamBn/XNI4VucLNhZFULy+rM8E1PRR8Ub9lI5HbsYReswuuc6I4ZSg3CNMtWsQ9me34jhZPkjVwvyKlgaq3v4Fr3YO6GGTHRjYWdR2exDGa2ixgfdf1yPlKwBS3HzufkUOR2D7mSjRNX7RMCnSHUyRXGeWjvN6a2DD9Dk542Tf3U6WDl5yWO1z8lLHv+hm5Vy1Wo9qE3K+0zyGDIggAKRY8TAAxAAPBjDL9VIW4CFppqU+x5ITABhWIbOYC/fJIPh6P0IMgD/LcftolFtQfu4XKbK9Bqe9AMk2LCjGNlVmSHMKnhoY3BWjECC4drPFK0akPVXp2YvLSTvDy97PnZLcQm6xVvrcIuygaw5wOPDjSzFcQyXERNYAlBLAQIUAxQAAAAAAOt8YV3tQUGhwgEAAMIBAAATAAAAAAAAAAAAAACAAQAAAABpbmZvLWFhYTExMS50YXIuenN0UEsFBgAAAAABAAEAQQAAAPMBAAAAAA==";

const fixtureBytes = (base64: string): Uint8Array => base64ToBytes(base64);

/** JSON.parse with the expected shape pinned at the call site. */
const parseJson = <T>(text: string): T => JSON.parse(text) as T;

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new Response(bytes.slice()).body as ReadableStream<Uint8Array>;

/** The service call with the standard owner/doer/quota wiring. */
function upload(
  owner: { id: number },
  doerId: number,
  overrides: Partial<UploadCondaPackageInput> & { content: ReadableStream<Uint8Array> },
): Promise<unknown> {
  return uploadCondaPackageFile({
    d1: env.DB,
    bucket: env.REPO_PACKS,
    owner: { id: owner.id, type: "user", visibility: "public" },
    doer: { id: doerId, isAdmin: false },
    channel: "",
    filename: "numpy-1.26.0-py3h_0.tar.bz2",
    declaredLength: undefined,
    quota: packagesQuotaFromEnv({}),
    ...overrides,
  });
}

let ownerRow: { id: number; username: string };

beforeEach(async () => {
  ownerRow = await seedUser("condaowner");
});

// ---------------------------------------------------------------------------
// The parse (metadata.go)
// ---------------------------------------------------------------------------

describe("parseCondaPackageTarBz2 (metadata.go:93-217)", () => {
  it("the full form: index + about fields land in both metadata halves", () => {
    const parsed = parseCondaPackageTarBz2(fixtureBytes(F1_FULL));
    expect(parsed.name).toBe("numpy");
    expect(parsed.version).toBe("1.26.0");
    expect(parsed.subdir).toBe("linux-64");
    expect(parsed.versionMetadata).toEqual({
      description: "NumPy is the fundamental package for scientific computing.",
      summary: "Array processing for numbers, strings, records, and objects.",
      project_url: "https://numpy.org/",
      repository_url: "https://github.com/numpy/numpy",
      documentation_url: "https://numpy.org/doc/",
      license: "BSD-3-Clause",
      license_family: "BSD",
    });
    expect(parsed.fileMetadata).toEqual({
      is_conda: false,
      architecture: "x86_64",
      noarch: "",
      build: "py3h_0",
      build_number: 3,
      dependencies: ["python >=3.9,<3.10.0a0", "numpy 1.*"],
      platform: "linux",
      timestamp: 1700000000000,
    });
  });

  it("the about-less minimal: zero-filled version metadata, zero build_number", () => {
    const parsed = parseCondaPackageTarBz2(fixtureBytes(F2_MINIMAL));
    expect(parsed.name).toBe("zlib");
    expect(parsed.version).toBe("1.2.13");
    expect(parsed.subdir).toBe("noarch");
    expect(parsed.versionMetadata).toEqual({
      description: "",
      summary: "",
      project_url: "",
      repository_url: "",
      documentation_url: "",
      license: "",
      license_family: "",
    });
    expect(parsed.fileMetadata.build_number).toBe(0);
    expect(parsed.fileMetadata.dependencies).toEqual([]);
  });

  it("the name gate: 'NumPy' is ErrInvalidName; the about-URL validation clears BOTH the relative home and the ftp:// dev_url (helpers.go:42-51's http/https gate)", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F3_BAD_NAME))).toThrow(CondaInvalidNameError);
    const parsed = parseCondaPackageTarBz2(fixtureBytes(F7_BAD_URLS));
    expect(parsed.name).toBe("curl");
    expect(parsed.versionMetadata.project_url).toBe("");
    expect(parsed.versionMetadata.repository_url).toBe("");
    expect(parsed.versionMetadata.documentation_url).toBe("");
  });

  it("the version gate: '1.0-rc1' is ErrInvalidVersion", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F4_BAD_VERSION))).toThrow(CondaInvalidVersionError);
  });

  it("a tar without info/index.json is ErrInvalidStructure", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F5_NO_INDEX))).toThrow(CondaInvalidStructureError);
  });

  it("a corrupt/truncated bzip2 stream is the plain-error class", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F6_CORRUPT))).toThrow(CondaArchiveError);
  });

  it("the decode-error class: a string build_number, an array document, a non-string depends element", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F8_TYPE_MISMATCH))).toThrow(CondaArchiveError);
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F9_ARRAY))).toThrow(CondaArchiveError);
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F11_BAD_DEPENDS))).toThrow(CondaArchiveError);
  });

  it("a JSON-null index decodes to the zero struct — the NAME gate answers (upstream's decode no-op nil-panics; the 400 gate is our sane arm)", () => {
    expect(() => parseCondaPackageTarBz2(fixtureBytes(F10_NULL))).toThrow(CondaInvalidNameError);
  });
});

describe("isValidCondaUrl (validation.IsValidURL, helpers.go:42-51)", () => {
  it("http/https with a host pass; every other scheme, relative forms and empty values fail", () => {
    for (const good of ["https://numpy.org/", "http://example.com:8080/a?b=c#d", "https://host"]) {
      expect(isValidCondaUrl(good)).toBe(true);
    }
    for (const bad of [
      "",
      "ftp://x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "gopher://old.example",
      "numpy.org",
      "//host/path",
      "/absolute/path",
      "http://", // no host
    ]) {
      expect(isValidCondaUrl(bad)).toBe(false);
    }
  });

  it("control bytes fail before parsing (Go's ParseRequestURI rejects what WHATWG would strip)", () => {
    expect(isValidCondaUrl("http:\t//evil.example")).toBe(false);
    expect(isValidCondaUrl("http://evil.example\r/x")).toBe(false);
    expect(isValidCondaUrl("http://evil.example\n")).toBe(false);
    expect(isValidCondaUrl("\u0000https://numpy.org/")).toBe(false);
  });

  it("an invalid port fails (the validPort(portOnly(u.Host)) arm — WHATWG throws on it)", () => {
    expect(isValidCondaUrl("http://host:99999/")).toBe(false);
    expect(isValidCondaUrl("http://host:0x20/")).toBe(false);
  });
});

describe("the conda-build name/version grammar (metadata.go:220-243)", () => {
  it("checkName: empty/uppercase/bad-char sets vs the good set", () => {
    for (const bad of ["", "NumPy", "a!b", "a=b", "a b", "a/b", "a:b"]) {
      expect(condaCheckName(bad)).toBe(false);
    }
    for (const good of ["numpy", "a-b", "a.b", "a_b", "python.abi3"]) {
      expect(condaCheckName(good)).toBe(true);
    }
  });

  it("checkVersion: empty/dash/bad-char sets vs the good set", () => {
    for (const bad of ["", "1.0-rc1", "1=2", "1 2", "v:1"]) {
      expect(condaCheckVersion(bad)).toBe(false);
    }
    for (const good of ["1.26.0", "1_0", "2022.10.0"]) {
      expect(condaCheckVersion(good)).toBe(true);
    }
  });

  it("isCondaPackageFileName: the two suffixes only", () => {
    expect(isCondaPackageFileName("a.tar.bz2")).toBe(true);
    expect(isCondaPackageFileName("a.conda")).toBe(true);
    expect(isCondaPackageFileName("a.zip")).toBe(false);
    expect(isCondaPackageFileName("repodata.json")).toBe(false);
    expect(isCondaPackageFileName("a.tar.gz")).toBe(false);
  });
});

describe("the metadata JSON renders (the Go tag order + omitempty)", () => {
  it("FileMetadata: is_conda always present, the zero fields dropped", () => {
    expect(buildCondaFileMetadataJson({ ...loadCondaFileMetadata("{}") })).toBe('{"is_conda":false}');
    const full = parseCondaPackageTarBz2(fixtureBytes(F1_FULL)).fileMetadata;
    expect(buildCondaFileMetadataJson(full)).toBe(
      '{"is_conda":false,"architecture":"x86_64","build":"py3h_0","build_number":3,"dependencies":["python >=3.9,<3.10.0a0","numpy 1.*"],"platform":"linux","timestamp":1700000000000}',
    );
  });

  it("VersionMetadata: everything empty renders {}", () => {
    expect(buildCondaVersionMetadataJson(parseCondaPackageTarBz2(fixtureBytes(F2_MINIMAL)).versionMetadata)).toBe("{}");
    expect(buildCondaVersionMetadataJson(parseCondaPackageTarBz2(fixtureBytes(F1_FULL)).versionMetadata)).toBe(
      '{"description":"NumPy is the fundamental package for scientific computing.","summary":"Array processing for numbers, strings, records, and objects.","project_url":"https://numpy.org/","repository_url":"https://github.com/numpy/numpy","documentation_url":"https://numpy.org/doc/","license":"BSD-3-Clause","license_family":"BSD"}',
    );
  });

  it("loadCondaFileMetadata round-trips the stored form and moves is_conda", () => {
    const stored = buildCondaFileMetadataJson({
      ...loadCondaFileMetadata("{}"),
      is_conda: true,
      noarch: "python",
    });
    const loaded = loadCondaFileMetadata(stored);
    expect(loaded.is_conda).toBe(true);
    expect(loaded.noarch).toBe("python");
    expect(() => loadCondaFileMetadata("{broken")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The upload + storage (conda.go:189-294)
// ---------------------------------------------------------------------------

describe("uploadCondaPackageFile (conda.go:189-294)", () => {
  it("the full store walk: rows, properties, stored name, byte parity, spool cleanup", async () => {
    const bytes = fixtureBytes(F1_FULL);
    const result = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(bytes),
      filename: "pkg.tar.bz2",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;

    expect(result.pkg.name).toBe("numpy"); // no channel → the bare name
    expect(result.version.version).toBe("1.26.0");
    expect(result.file.name).toBe("numpy-1.26.0-py3h_0.tar.bz2");
    expect(result.file.compositeKey).toBe("linux-64");
    expect(result.file.isLead).toBe(true);

    const pkgRow = (await db().select().from(packages).where(eq(packages.id, result.pkg.id)).get());
    expect(pkgRow?.semverCompatible).toBe(false);

    const props = await db().select().from(packageProperties).all();
    const byRef = (refType: number, refId: number, name: string): string | undefined =>
      props.find((p) => p.refType === refType && p.refId === refId && p.name === name)?.value;
    // The PACKAGE properties — the EMPTY-channel row included (the search
    // matches `value = channel` exactly).
    expect(byRef(PropertyType.Package, result.pkg.id, CONDA_PROPERTY_NAME)).toBe("numpy");
    expect(byRef(PropertyType.Package, result.pkg.id, CONDA_PROPERTY_CHANNEL)).toBe("");
    // The FILE properties.
    expect(byRef(PropertyType.File, result.file.id, CONDA_PROPERTY_SUBDIR)).toBe("linux-64");
    expect(byRef(PropertyType.File, result.file.id, CONDA_PROPERTY_METADATA)).toBe(buildCondaFileMetadataJson(result.parsed.fileMetadata));
    // The VERSION metadata at creation.
    const versionRow = (await db().select().from(packageVersions).where(eq(packageVersions.id, result.version.id)).get());
    expect(versionRow?.metadataJson).toBe(buildCondaVersionMetadataJson(result.parsed.versionMetadata));

    // The R2 content key carries the exact upload bytes; the spool is gone.
    const object = await env.REPO_PACKS.get(`packages/blobs/${spooledKey(result.blob.hashSha256)}`);
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    const spool = await env.REPO_PACKS.list({ prefix: "packages/tmp/" });
    expect(spool.objects).toHaveLength(0);
  });

  it("a channel upload names the package channel/name and stores the channel property", async () => {
    const result = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F1_FULL)),
      filename: "pkg.tar.bz2",
      channel: "mychannel",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;
    expect(result.pkg.name).toBe("mychannel/numpy");
    const props = await db()
      .select()
      .from(packageProperties)
      .where(and(eq(packageProperties.refType, PropertyType.Package), eq(packageProperties.refId, result.pkg.id)))
      .all();
    expect(props.find((p) => p.name === CONDA_PROPERTY_CHANNEL)?.value).toBe("mychannel");
    expect(props.find((p) => p.name === CONDA_PROPERTY_NAME)?.value).toBe("numpy");
  });

  it("a second build rides the SAME version as a new file; the version metadata is NOT rewritten; the duplicate stored name is the 409 class", async () => {
    const first = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F1_FULL)),
      filename: "a.tar.bz2",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;
    const second = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F12_SECOND_BUILD)),
      filename: "b.tar.bz2",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;

    expect(second.version.id).toBe(first.version.id);
    expect(second.file.name).toBe("numpy-1.26.0-py3h_1.tar.bz2");
    // The version row kept the FIRST upload's metadata (f12's license_family
    // differs — PATENT — proving the no-rewrite).
    const versionRow = (await db().select().from(packageVersions).where(eq(packageVersions.id, first.version.id)).get());
    expect(versionRow?.metadataJson).toBe(buildCondaVersionMetadataJson(first.parsed.versionMetadata));
    expect(versionRow?.metadataJson).not.toContain("PATENT");

    // A THIRD upload with the same stored name is ErrDuplicatePackageFile.
    await expect(
      upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "c.tar.bz2" }),
    ).rejects.toThrow(DuplicatePackageFileError);
  });

  it("the same bytes under two packages share ONE blob row (the content dedupe)", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" });
    await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F1_FULL)),
      filename: "a.tar.bz2",
      channel: "c2",
    });
    const fileRows = await db().select().from(packageFiles).all();
    expect(fileRows).toHaveLength(2); // two packages, one stored file each
    const blobs = await db().select().from(packageBlobs).all();
    expect(blobs).toHaveLength(1); // one content blob behind both
  });

  it("the `.conda` arm: the full store walk with is_conda=true and the `.conda` stored name", async () => {
    const bytes = fixtureBytes(F_CONDA_NUMPY);
    const result = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(bytes),
      filename: "numpy.conda",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;

    expect(result.pkg.name).toBe("numpy"); // no channel → the bare name
    expect(result.version.version).toBe("1.26.0");
    expect(result.file.name).toBe("numpy-1.26.0-py3h_2.conda"); // is_conda → `.conda`
    expect(result.file.compositeKey).toBe("linux-64");
    expect(result.file.isLead).toBe(true);
    expect(result.parsed.fileMetadata.is_conda).toBe(true);
    expect(result.parsed.fileMetadata.build).toBe("py3h_2");
    expect(result.parsed.fileMetadata.build_number).toBe(2);
    expect(result.parsed.versionMetadata.summary).toBe("Array processing for numbers, strings, records, and objects.");
    expect(result.parsed.versionMetadata.repository_url).toBe("https://github.com/numpy/numpy");

    // The FILE properties carry is_conda=true in the stored metadata JSON.
    const props = await db().select().from(packageProperties).all();
    const metadata = props.find((p) => p.refType === PropertyType.File && p.refId === result.file.id && p.name === CONDA_PROPERTY_METADATA)?.value;
    expect(metadata).toContain('"is_conda":true');

    // The R2 content key carries the exact upload bytes; the spool is gone.
    const object = await env.REPO_PACKS.get(`packages/blobs/${spooledKey(result.blob.hashSha256)}`);
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(bytes);
    const spool = await env.REPO_PACKS.list({ prefix: "packages/tmp/" });
    expect(spool.objects).toHaveLength(0);
  });

  it("the `.conda` arm: the repodata split rides is_conda (packages.conda)", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F_CONDA_NUMPY)), filename: "a.conda" });
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const body = parseJson<{ packages: Record<string, unknown>; "packages.conda": Record<string, { build: string }> }>(
      (await buildCondaRepodata(env.DB, owner, "", "linux-64")) as string,
    );
    expect(body.packages).toEqual({});
    expect(Object.keys(body["packages.conda"])).toEqual(["numpy-1.26.0-py3h_2.conda"]);
    expect(body["packages.conda"]["numpy-1.26.0-py3h_2.conda"]?.build).toBe("py3h_2");
  });

  it("the `.conda` arm: a duplicate stored name is the 409 class; the version metadata is NOT rewritten", async () => {
    const first = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F_CONDA_NUMPY)),
      filename: "a.conda",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;
    const second = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F_CONDA_NUMPY2)),
      filename: "b.conda",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;
    expect(second.version.id).toBe(first.version.id);
    expect(second.file.name).toBe("numpy-1.26.0-py3h_1.conda");
    // The bz2 twin of the SAME version still collides on the stored name.
    await expect(
      upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F_CONDA_NUMPY)), filename: "c.conda" }),
    ).rejects.toThrow(DuplicatePackageFileError);
  });

  it("the `.conda` arm: the deflate-member zip twin parses identically", async () => {
    const parsed = await parseCondaPackageConda(fixtureBytes(F_CONDA_NUMPY_DEFLATED));
    expect(parsed.name).toBe("numpy");
    expect(parsed.version).toBe("1.26.0");
    expect(parsed.fileMetadata.is_conda).toBe(true);
    expect(parsed.fileMetadata.build_number).toBe(2);
    expect(parsed.versionMetadata.description).toBe("NumPy is the fundamental package for scientific computing.");
  });

  it("the `.conda` arm: a zip with no info-*.tar.zst member is the invalid-structure sentinel", async () => {
    await expect(parseCondaPackageConda(fixtureBytes(F_CONDA_NOINFO))).rejects.toThrow(CondaInvalidStructureError);
    await expect(
      upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F_CONDA_NOINFO)), filename: "x.conda" }),
    ).rejects.toThrow(CondaInvalidStructureError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("the `.conda` arm: a corrupt zip and a broken inner zstd stream are the 500 class", async () => {
    await expect(parseCondaPackageConda(fixtureBytes(F_CONDA_CORRUPT))).rejects.toThrow(CondaArchiveError);
    await expect(parseCondaPackageConda(fixtureBytes(F_CONDA_BADZST))).rejects.toThrow(CondaArchiveError);
    await expect(
      upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F_CONDA_CORRUPT)), filename: "x.conda" }),
    ).rejects.toThrow(CondaArchiveError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("the `.conda` arm: the name gate rides the container (ErrInvalidName)", async () => {
    await expect(parseCondaPackageConda(fixtureBytes(F_CONDA_BADNAME))).rejects.toThrow(CondaInvalidNameError);
  });

  it("a corrupt archive is the 500 class and stores nothing", async () => {
    await expect(
      upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F6_CORRUPT)), filename: "a.tar.bz2" }),
    ).rejects.toThrow(CondaArchiveError);
    expect(await db().select().from(packages).all()).toHaveLength(0);
  });

  it("the count quota 403 class", async () => {
    await expect(
      upload(ownerRow, ownerRow.id, {
        content: streamOf(fixtureBytes(F1_FULL)),
        filename: "a.tar.bz2",
        quota: packagesQuotaFromEnv({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" }),
      }),
    ).resolves.toBeDefined();
    await expect(
      upload(ownerRow, ownerRow.id, {
        content: streamOf(fixtureBytes(F12_SECOND_BUILD)),
        filename: "b.tar.bz2",
        quota: packagesQuotaFromEnv({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "1" }),
      }),
    ).rejects.toThrow(QuotaTotalCountError);
  });
});

function spooledKey(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

// ---------------------------------------------------------------------------
// The repodata (conda.go:55-187)
// ---------------------------------------------------------------------------

describe("buildCondaRepodata (conda.go:55-187)", () => {
  it("the exact RepoData render: struct order, the Go map-key sort, the trailing newline", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" });
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F2_MINIMAL)), filename: "b.tar.bz2" });

    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const body = await buildCondaRepodata(env.DB, owner, "", "linux-64");
    expect(body).not.toBeNull();
    const info = parseJson<{
      info: { subdir: string };
      packages: Record<string, Record<string, unknown>>;
      "packages.conda": Record<string, unknown>;
      removed: Record<string, unknown>;
    }>(body as string);
    expect(Object.keys(info)).toEqual(["info", "packages", "packages.conda", "removed"]);
    expect(info.info).toEqual({ subdir: "linux-64" });
    expect(Object.keys(info.packages)).toEqual(["numpy-1.26.0-py3h_0.tar.bz2"]); // sorted + filtered by subdir
    expect(info.packages["packages.conda"]).toBeUndefined();
    expect(info["packages.conda"]).toEqual({});
    expect(info.removed).toEqual({});
    const pi = info.packages["numpy-1.26.0-py3h_0.tar.bz2"] ?? {};
    expect(Object.keys(pi)).toEqual([
      "name",
      "version",
      "noarch",
      "subdir",
      "timestamp",
      "build",
      "build_number",
      "depends",
      "license",
      "license_family",
      "md5",
      "sha256",
      "size",
    ]);
    expect(pi).toEqual({
      name: "numpy",
      version: "1.26.0",
      noarch: "",
      subdir: "linux-64",
      timestamp: 1700000000000,
      build: "py3h_0",
      build_number: 3,
      depends: ["python >=3.9,<3.10.0a0", "numpy 1.*"],
      license: "BSD-3-Clause",
      license_family: "BSD",
      md5: "", // no WebCrypto MD5 — the blob row's hash_md5 is null
      sha256: bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", fixtureBytes(F1_FULL) as unknown as BufferSource))),
      size: fixtureBytes(F1_FULL).byteLength,
    });
    expect((body as string).endsWith("\n")).toBe(true);
    // The byte-exact render (the json.Encoder newline included).
    const result = (await db().select().from(packageVersions).all()) as { version: string }[];
    expect(result).toHaveLength(2);
  });

  it("an empty subdir/channel answers null (the 404 arm)", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" });
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    expect(await buildCondaRepodata(env.DB, owner, "", "noarch")).toBeNull();
    expect(await buildCondaRepodata(env.DB, owner, "mychannel", "linux-64")).toBeNull();
  });

  it("the channel filter: a channel upload appears under its channel only", async () => {
    await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F1_FULL)),
      filename: "a.tar.bz2",
      channel: "mychannel",
    });
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    expect(await buildCondaRepodata(env.DB, owner, "", "linux-64")).toBeNull();
    const channeled = await buildCondaRepodata(env.DB, owner, "mychannel", "linux-64");
    expect(channeled).not.toBeNull();
    expect(parseJson<{ packages: Record<string, { name: string }> }>(channeled as string).packages["numpy-1.26.0-py3h_0.tar.bz2"]?.name).toBe("numpy");
  });

  it("the is_conda split: a file whose stored metadata says is_conda renders under packages.conda", async () => {
    const result = (await upload(ownerRow, ownerRow.id, {
      content: streamOf(fixtureBytes(F1_FULL)),
      filename: "a.tar.bz2",
    })) as Awaited<ReturnType<typeof uploadCondaPackageFile>>;
    await db()
      .update(packageProperties)
      .set({ value: JSON.stringify({ ...result.parsed.fileMetadata, is_conda: true, noarch: "python" }) })
      .where(and(eq(packageProperties.refType, PropertyType.File), eq(packageProperties.refId, result.file.id), eq(packageProperties.name, CONDA_PROPERTY_METADATA)))
      .run();
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const body = parseJson<{ packages: Record<string, unknown>; "packages.conda": Record<string, { noarch: string }> }>(
      (await buildCondaRepodata(env.DB, owner, "", "linux-64")) as string,
    );
    expect(body.packages).toEqual({});
    expect(Object.keys(body["packages.conda"])).toEqual(["numpy-1.26.0-py3h_0.tar.bz2"]);
    expect(body["packages.conda"]["numpy-1.26.0-py3h_0.tar.bz2"]?.noarch).toBe("python");
  });

  it("searchCondaFiles honors the filename gate (lower-cased)", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" });
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    expect((await searchCondaFiles(env.DB, owner.id, "", "linux-64", "NUMPY-1.26.0-PY3H_0.TAR.BZ2")).length).toBe(1);
    expect((await searchCondaFiles(env.DB, owner.id, "", "linux-64", "missing.tar.bz2")).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The repodata .bz2 variants (conda.go:44 + :170-183) — the wall-3 encoder
// ---------------------------------------------------------------------------

describe("the repodata .bz2 variants (conda.go:170-183)", () => {
  it("the name switch carries exactly the pin's four repodata names", () => {
    expect(CONDA_REPODATA_NAMES).toEqual([
      "repodata.json",
      "repodata.json.bz2",
      "current_repodata.json",
      "current_repodata.json.bz2",
    ]);
  });

  it("the content type follows conda.go:174-179's suffix branch", () => {
    expect(condaRepodataContentType("repodata.json")).toBe("application/json");
    expect(condaRepodataContentType("current_repodata.json")).toBe("application/json");
    expect(condaRepodataContentType("repodata.json.bz2")).toBe("application/x-bzip2");
    expect(condaRepodataContentType("current_repodata.json.bz2")).toBe("application/x-bzip2");
  });

  it("the .bz2 body is the SAME repodata JSON through the encoder; .json is verbatim UTF-8", async () => {
    await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" });
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    const body = (await buildCondaRepodata(env.DB, owner, "", "linux-64")) as string;

    const plain = encodeCondaRepodataBody(body, "repodata.json");
    expect(new TextDecoder().decode(plain)).toBe(body);

    const compressed = encodeCondaRepodataBody(body, "repodata.json.bz2");
    expect(Array.from(compressed)).not.toEqual(Array.from(plain)); // actually compressed
    const roundTrip = bzip2Decompress(compressed);
    expect(new TextDecoder().decode(roundTrip)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// The download (conda.go:296-322)
// ---------------------------------------------------------------------------

describe("openCondaFileForDownload (conda.go:296-322)", () => {
  it("the exactly-one gate, byte parity, and the GET-only counter bump", async () => {
    const bytes = fixtureBytes(F1_FULL);
    const result = (await upload(ownerRow, ownerRow.id, { content: streamOf(bytes), filename: "a.tar.bz2" })) as Awaited<
      ReturnType<typeof uploadCondaPackageFile>
    >;
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;

    const download = await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "", "linux-64", "numpy-1.26.0-py3h_0.tar.bz2", "GET");
    expect(download).not.toBeNull();
    expect(new Uint8Array(await new Response((download as { stream: ReadableStream }).stream).arrayBuffer())).toEqual(bytes);
    const bumped = (await db().select().from(packageVersions).where(eq(packageVersions.id, result.version.id)).get());
    expect(bumped?.downloadCount).toBe(1);

    const head = await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "", "linux-64", "numpy-1.26.0-py3h_0.tar.bz2", "HEAD");
    expect(head).not.toBeNull();
    expect((await db().select().from(packageVersions).where(eq(packageVersions.id, result.version.id)).get())?.downloadCount).toBe(1);

    // The wrong subdir / channel / filename arms are the 404 class.
    expect(await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "", "noarch", "numpy-1.26.0-py3h_0.tar.bz2", "GET")).toBeNull();
    expect(await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "chan", "linux-64", "numpy-1.26.0-py3h_0.tar.bz2", "GET")).toBeNull();
    expect(await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "", "linux-64", "missing.tar.bz2", "GET")).toBeNull();
  });

  it("a SAME-NAME pair in one channel+subdir is the 404 class (conda.go:308's len != 1)", async () => {
    const first = (await upload(ownerRow, ownerRow.id, { content: streamOf(fixtureBytes(F1_FULL)), filename: "a.tar.bz2" })) as Awaited<
      ReturnType<typeof uploadCondaPackageFile>
    >;
    // A second VERSION of the same package storing the same file name in
    // the same subdir — the ambiguity upstream's SearchFiles+len check
    // answers 404 on (the file UNIQUE is per-version, so the twin rides a
    // new version row).
    const twin = await getOrInsertVersion(env.DB, {
      packageId: first.pkg.id,
      creatorId: ownerRow.id,
      version: "1.27.0",
    });
    const twinFile = await tryInsertFile(env.DB, {
      versionId: twin.row.id,
      blobId: first.blob.id,
      name: first.file.name,
      isLead: true,
      compositeKey: "linux-64",
    });
    if (twinFile.outcome !== "created") throw new Error("twin file insert failed");
    await db().insert(packageProperties).values([
      { refType: PropertyType.File, refId: twinFile.row.id, name: CONDA_PROPERTY_SUBDIR, value: "linux-64" },
      { refType: PropertyType.File, refId: twinFile.row.id, name: CONDA_PROPERTY_METADATA, value: "{}" },
    ]);
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;
    expect(
      await openCondaFileForDownload(env.DB, env.REPO_PACKS, owner, "", "linux-64", first.file.name, "GET"),
    ).toBeNull();
    // The repodata still answers (the enumerate path has no len gate); the
    // same-key rows collapse to ONE map entry — Go's overwrite arm (the
    // later SearchFiles row wins; the survivor's version is undefined in
    // both implementations).
    const body = parseJson<{ packages: Record<string, unknown> }>(
      (await buildCondaRepodata(env.DB, owner, "", "linux-64")) as string,
    );
    expect(Object.keys(body.packages)).toEqual(["numpy-1.26.0-py3h_0.tar.bz2"]);
  });

  it("a failed counter write does NOT break the serving arm (packages.go:666-670 — upstream logs and returns the file)", async () => {
    const bytes = fixtureBytes(F1_FULL);
    const result = (await upload(ownerRow, ownerRow.id, { content: streamOf(bytes), filename: "b.tar.bz2" })) as Awaited<
      ReturnType<typeof uploadCondaPackageFile>
    >;
    const owner = { id: ownerRow.id, type: "user", visibility: "public" } as const;

    // A D1 that throws ONLY on the counter's UPDATE — the search/descriptor
    // reads go through untouched.
    const failing = new Proxy(env.DB, {
      get(target: D1Database, prop: string | symbol, receiver: unknown): unknown {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string): D1PreparedStatement => {
          // The counter's UPDATE carries download_count, but so does the
          // search's SELECT column list — gate on the statement kind.
          if (/^update/i.test(sql) && sql.includes("download_count")) throw new Error("counter write failed");
          return target.prepare(sql);
        };
      },
    });

    const download = await openCondaFileForDownload(failing, env.REPO_PACKS, owner, "", "linux-64", "numpy-1.26.0-py3h_0.tar.bz2", "GET");
    expect(download).not.toBeNull();
    expect(
      new Uint8Array(await new Response((download as { stream: ReadableStream }).stream).arrayBuffer()),
    ).toEqual(bytes);
    expect(
      (await db().select().from(packageVersions).where(eq(packageVersions.id, result.version.id)).get())?.downloadCount,
    ).toBe(0);
  });
});

