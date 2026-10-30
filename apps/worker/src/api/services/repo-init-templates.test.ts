/**
 * The repo-create auto-init template catalogs (services/repo-init-templates
 * .ts) — the build-time inlined `gitea/options/` families and their render
 * ports. Pins at submodule pin fc4936884584:
 *   - the catalog COUNTS are the directory listings upstream serves as
 *     `repo_module.Gitignores` / `repo_module.Licenses` (270 gitignore
 *     files, 27 license files at this pin);
 *   - the `.gitignore` join shape (services/repository/create.go:108-124 —
 *     `# ---> <name>` header + body + trailing newline per comma-split
 *     entry) and the unknown-name init failure (:113-114);
 *   - the license placeholder fill (modules/repository/license.go:31-92):
 *     the universal table (owner/email/repo/year), substitution order, the
 *     always-trailing-newline scanner shape, and the 0BSD line-gated
 *     special (:78-87 — its second "AUTHOR" must survive).
 */

import { describe, expect, it } from "vitest";

import {
  gitignoreCatalog,
  licenseCatalog,
  renderGitignoreCsv,
  renderLicenseTemplate,
} from "./repo-init-templates";

const VALUES = { owner: "Alice", email: "alice@example.org", repo: "proj", year: "2026" };

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("repo-init template catalogs (gitea/options/*, vendored verbatim)", () => {
  it("carries the pin's directory listings verbatim", () => {
    // `repo_module.Gitignores` / `repo_module.Licenses` are the options/
    // directory listings; the pin (fc493688) ships 270 and 27 files.
    expect(gitignoreCatalog().size).toBe(270);
    expect(licenseCatalog().size).toBe(27);
    // A sample of the catalog names (the exact file names, case-sensitive).
    for (const name of ["Go", "Node", "Python", "Rust", "Windows", "macOS"]) {
      expect(gitignoreCatalog().has(name), `gitignore template ${name}`).toBe(true);
    }
    for (const name of ["0BSD", "AGPL-3.0", "Apache-2.0", "GPL-2.0", "MIT", "MPL-2.0", "Unlicense"]) {
      expect(licenseCatalog().has(name), `license template ${name}`).toBe(true);
    }
  });
});

describe("renderGitignoreCsv (create.go:108-124)", () => {
  it("joins each comma-split entry as `# ---> <name>` + body + newline", () => {
    const body = decode(renderGitignoreCsv("Go"));
    const expected = `# ---> Go\n${gitignoreCatalog().get("Go")}\n`;
    expect(body).toBe(expected);
  });

  it("concatenates multiple names into one .gitignore in option order", () => {
    const body = decode(renderGitignoreCsv("Go,Node"));
    expect(body).toBe(
      `# ---> Go\n${gitignoreCatalog().get("Go")}\n# ---> Node\n${gitignoreCatalog().get("Node")}\n`,
    );
  });

  it("throws the init failure on an unknown name (create.go:113-114)", () => {
    expect(() => renderGitignoreCsv("Not-A-Template")).toThrowError(
      "GetRepoInitFile[Not-A-Template]: gitignore template does not exist",
    );
  });

  it("an empty segment (trailing comma) throws like upstream's Gitignore(\"\") miss", () => {
    expect(() => renderGitignoreCsv("Go,")).toThrowError(
      'GetRepoInitFile[]: gitignore template does not exist',
    );
  });
});

describe("renderLicenseTemplate (modules/repository/license.go)", () => {
  it("fills the MIT placeholders (year + owner) into the copyright line", () => {
    // options/license/MIT: `Copyright (c) <year> <copyright holders>` —
    // `<year>` from the Year pool, `<copyright holders>` from the Owner pool.
    const body = decode(renderLicenseTemplate("MIT", VALUES));
    expect(body).toContain("Copyright (c) 2026 Alice");
    expect(body).not.toContain("<year>");
    expect(body).not.toContain("<copyright holders>");
    // The always-trailing-newline scanner shape (license.go:52 —
    // `WriteString(line + "\n")` per line).
    expect(body.endsWith("\n")).toBe(true);
    expect(body.endsWith("\n\n")).toBe(false);
  });

  it("fills Apache-2.0's `[yyyy] [name of copyright owner]` appendix line", () => {
    const body = decode(renderLicenseTemplate("Apache-2.0", VALUES));
    expect(body).toContain("Copyright 2026 Alice");
    expect(body).not.toContain("[yyyy]");
  });

  it("substitutes the Repo pool (`<program>`) and the Year/Owner pools in GPL-3.0's boilerplate", () => {
    // GPL-3.0's "How to Apply" tail carries `<program>`, `<year>` and
    // `<name of author>` (the literal FSF copyright line stays — it holds
    // no placeholder tokens). The two-space gap between the placeholders is
    // the template's own.
    const gpl = decode(renderLicenseTemplate("GPL-3.0", VALUES));
    expect(gpl).toContain("Copyright (C) 2026  Alice");
    expect(gpl).toContain(`${VALUES.repo}  Copyright (C) 2026  Alice`);
    expect(gpl).not.toContain("<program>");
    expect(gpl).not.toContain("<year>");
    expect(gpl).not.toContain("<name of author>");
  });

  it("0BSD substitutes only the matched copyright line (license.go:78-87)", () => {
    // The template's first line is `Copyright (C) YEAR by AUTHOR EMAIL`; the
    // MatchLine regex gates substitution to that line, so the later
    // "THE AUTHOR DISCLAIMS" sentence keeps its literal AUTHOR.
    const body = decode(renderLicenseTemplate("0BSD", VALUES));
    expect(body.startsWith("Copyright (C) 2026 by Alice alice@example.org\n")).toBe(true);
    expect(body).toContain("THE AUTHOR DISCLAIMS");
  });

  it("throws the init failure on an unknown name (create.go:131-135)", () => {
    expect(() => renderLicenseTemplate("Not-A-License", VALUES)).toThrowError(
      "getLicense[Not-A-License]: license template does not exist",
    );
  });
});
