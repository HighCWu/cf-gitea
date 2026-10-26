/**
 * The fileicon lookup-layer tests — the ported contracts of
 * gitea/modules/fileicon/ (asset + lookup layer only; the tree-view page is
 * the follow-up wave). Upstream cites in the module header of fileicon.ts.
 *
 * The ground-truth icon names below were computed against the VENDORED
 * assets themselves (the same tables upstream's material_test.go runs
 * against), so the assertions pin both the port and the byte-identity of
 * the asset copy: any drift in either shows up here. The sha256
 * byte-identity of the nine vendored files is additionally verified at copy
 * time (shell gate, recorded in the landing report) — workerd tests cannot
 * read the submodule to re-verify it, so the structural proxies here are
 * the exact entry counts and spot entries of both JSONs.
 */

import { describe, expect, it } from "vitest";

import attributionRaw from "./ATTRIBUTION.md?raw";
import {
  basicEntryIconHtml,
  basicEntryIconName,
  entryInfo,
  entryInfoFolder,
  entryInfoFolderOpen,
  findIconName,
  materialEntryIconHtml,
  materialIcons,
  newRenderedIconPool,
  renderEntryIconHtml,
  renderIconPoolHtml,
} from "./fileicon";

// --- the lookup order (material.go:131-162 FindIconName) -----------------------

describe("findIconName (material.go FindIconName port)", () => {
  it("resolves the mission-representative names", () => {
    expect(findIconName(entryInfo("README.md", "blob"))).toBe("readme"); // fileNames arm
    expect(findIconName(entryInfo("main.go", "blob"))).toBe("go"); // fileExtensions arm via languageIds
    expect(findIconName(entryInfo(".gitignore", "blob"))).toBe("git"); // leading-dot fileName
    expect(findIconName(entryInfo("unknownxyz", "blob"))).toBe("file"); // the fallback
  });

  it("reproduces upstream's own material_test.go cases", () => {
    expect(findIconName(entryInfo("foo.php", "blob"))).toBe("php");
    expect(findIconName(entryInfo("foo.PHP", "blob"))).toBe("php"); // lowercased name
    expect(findIconName(entryInfo("foo.js", "blob"))).toBe("javascript");
    expect(findIconName(entryInfo("foo.vba", "blob"))).toBe("visualstudio");
  });

  it("tries extensions longest-suffix-first (the end-of-string dot scan)", () => {
    expect(findIconName(entryInfo("archive.tar.gz", "blob"))).toBe("zip"); // gz wins before tar.gz
  });

  it("resolves directories through folderNames with the folder fallback", () => {
    expect(findIconName(entryInfo("src", "tree"))).toBe("folder-src");
    expect(findIconName(entryInfo("testfolder", "tree"))).toBe("folder");
    expect(findIconName(entryInfo("testfolder", "tree", null, true))).toBe("folder-open");
    expect(findIconName(entryInfoFolder())).toBe("folder");
    expect(findIconName(entryInfoFolderOpen())).toBe("folder-open");
  });

  it("answers folder-git for submodules before any name lookup", () => {
    expect(findIconName(entryInfo("vim-plug", "commit"))).toBe("folder-git");
  });
});

// --- the material markup + pool (material.go:64-117) ---------------------------

describe("materialEntryIconHtml (material.go EntryIconHTML port)", () => {
  it("renders the use-reference markup and pools the full svg once per name", () => {
    const pool = newRenderedIconPool();
    const html = materialEntryIconHtml(pool, entryInfo("main.go", "blob"));
    expect(html).toBe(
      `<svg class="svg git-entry-icon octicon-file" width="16" height="16" aria-hidden="true"><use href="#svg-mfi-go"></use></svg>`,
    );
    const pooled = pool.iconSvgs.get("svg-mfi-go");
    expect(pooled).toBeDefined();
    expect(pooled?.startsWith(`<svg id="svg-mfi-go" class="svg git-entry-icon octicon-file" width="16" height="16" aria-hidden="true"`)).toBe(true);
    // The raw material body (single-quoted attributes) rides through verbatim.
    expect(pooled).toContain(`viewBox='0 0 32 32'`);
    // Second entry resolving to the same icon reuses the pool (first write wins).
    materialEntryIconHtml(pool, entryInfo("other.go", "blob"));
    expect(pool.iconSvgs.size).toBe(1);
  });

  it("keeps the legacy octicon classes for directories and submodules", () => {
    const pool = newRenderedIconPool();
    const dirHtml = materialEntryIconHtml(pool, entryInfo("src", "tree"));
    expect(dirHtml).toContain(`class="svg git-entry-icon octicon-file-directory-fill"`);
    expect(dirHtml).toContain(`href="#svg-mfi-folder-src"`);
    const openHtml = materialEntryIconHtml(pool, entryInfo("src", "tree", null, true));
    expect(openHtml).toContain(`href="#svg-mfi-folder-src"`);
    expect(openHtml).toContain(`class="svg git-entry-icon octicon-file-directory-open-fill"`);
    const subHtml = materialEntryIconHtml(pool, entryInfo("vim-plug", "commit"));
    expect(subHtml).toContain(`href="#svg-mfi-folder-git"`);
    expect(subHtml).toContain(`class="svg git-entry-icon octicon-file-submodule"`);
  });

  it("renders the symlink arms from the basic store, unpooled", () => {
    const pool = newRenderedIconPool();
    const toDir = materialEntryIconHtml(pool, entryInfo("link", "symlink", "tree"));
    expect(toDir).toContain(`class="octicon-file-directory-symlink svg material-folder-symlink"`);
    expect(toDir).not.toContain(`<use`);
    const plain = materialEntryIconHtml(pool, entryInfo("link", "symlink"));
    expect(plain).toContain(`class="svg octicon-file-symlink-file"`);
    expect(pool.iconSvgs.size).toBe(0);
  });

  it("renders without a pool as the full inline svg (material.go:73-75)", () => {
    const html = materialEntryIconHtml(null, entryInfo("main.go", "blob"));
    expect(html.startsWith(`<svg id="svg-mfi-go" class="svg git-entry-icon octicon-file"`)).toBe(true);
    expect(html).not.toContain(`<use`);
  });
});

// --- the theme dispatch with fixed defaults (render.go:36-47) ------------------

describe("renderEntryIconHtml (RenderEntryIconHTML, defaults fixed)", () => {
  it("renders files through the material theme and directories through basic octicons", () => {
    const pool = newRenderedIconPool();
    expect(renderEntryIconHtml(pool, entryInfo("test.js", "blob"))).toContain(`svg-mfi-`); // upstream render_test.go FileUsesMaterialTheme
    expect(renderEntryIconHtml(pool, entryInfo("testfolder", "tree"))).toContain(`octicon-file-directory-fill`); // FolderUsesBasicTheme
    expect(renderEntryIconHtml(pool, entryInfo("link", "symlink", "tree"))).toContain(`octicon-file-directory-symlink`); // SymlinkToFolderUsesBasicTheme
    // The pool only ever carries the material-side svgs.
    expect([...pool.iconSvgs.keys()].every((id) => id.startsWith("svg-mfi-"))).toBe(true);
  });

  it("gives a directory its open-state variant (the entryIconOpen arm)", () => {
    const pool = newRenderedIconPool();
    const closed = renderEntryIconHtml(pool, entryInfo("docs", "tree"));
    const open = renderEntryIconHtml(pool, entryInfo("docs", "tree", null, true));
    expect(closed).toContain(`octicon-file-directory-fill`);
    expect(open).toContain(`octicon-file-directory-open-fill`);
    expect(closed).not.toBe(open);
  });

  it("wraps pooled svgs in the hidden container (render.go:23-34)", () => {
    expect(renderIconPoolHtml(newRenderedIconPool())).toBe("");
    const pool = newRenderedIconPool();
    renderEntryIconHtml(pool, entryInfo("a.go", "blob"));
    renderEntryIconHtml(pool, entryInfo("b.js", "blob"));
    const html = renderIconPoolHtml(pool);
    expect(html.startsWith(`<div class="svg-icon-container">`)).toBe(true);
    expect(html.endsWith(`</div>`)).toBe(true);
    expect(html).toContain(`svg-mfi-go`);
    expect(html).toContain(`svg-mfi-javascript`);
  });
});

// --- the basic layer (basic.go + modules/svg Normalize/RenderHTML) -------------

describe("basicEntryIconName/Html (basic.go port)", () => {
  it("picks the six octicons by entry mode", () => {
    expect(basicEntryIconName(entryInfo("x", "blob"))).toBe("octicon-file");
    expect(basicEntryIconName(entryInfo("x", "tree"))).toBe("octicon-file-directory-fill");
    expect(basicEntryIconName(entryInfo("x", "tree", null, true))).toBe("octicon-file-directory-open-fill");
    expect(basicEntryIconName(entryInfo("x", "symlink"))).toBe("octicon-file-symlink-file");
    expect(basicEntryIconName(entryInfo("x", "symlink", "tree"))).toBe("octicon-file-directory-symlink");
    expect(basicEntryIconName(entryInfo("x", "commit"))).toBe("octicon-file-submodule");
  });

  it("renders the normalized markup (svg.Normalize + RenderHTML pipeline)", () => {
    const html = basicEntryIconHtml(entryInfo("x", "blob"));
    expect(html.startsWith(`<svg viewBox="0 0 16 16" class="svg octicon-file" aria-hidden="true" width="16" height="16">`)).toBe(true);
    expect(html.endsWith(`</svg>`)).toBe(true);
  });
});

// --- the vendored assets (structural byte-identity proxies) --------------------

describe("vendored assets", () => {
  it("carry the exact entry counts and spot entries of the submodule copies", () => {
    const { rules, svgs } = materialIcons();
    expect(Object.keys(rules.fileNames).length).toBe(2152);
    expect(Object.keys(rules.folderNames).length).toBe(4659);
    expect(Object.keys(rules.fileExtensions).length).toBe(1408);
    expect(rules.fileNames["readme.md"]).toBe("readme");
    expect(rules.fileNames[".gitignore"]).toBe("git");
    expect(rules.fileExtensions["go"]).toBe("go");
    expect(rules.folderNames["src"]).toBe("folder-src");
    expect(Object.keys(svgs).length).toBe(1251);
    // The fallback trio material.go:98-102 relies on.
    expect(svgs["file"]).toBeDefined();
    expect(svgs["folder"]).toBeDefined();
    expect(svgs["folder-open"]).toBeDefined();
    expect(svgs["go"]?.startsWith("<svg viewBox='0 0 32 32'>")).toBe(true);
  });

  it("carry the material-icon-theme attribution (MIT, verbatim)", () => {
    expect(attributionRaw).toContain("The MIT License (MIT)");
    expect(attributionRaw).toContain("Copyright (c) 2025 Material Extensions");
    expect(attributionRaw).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(attributionRaw).toContain("material-icon-rules.json");
    expect(attributionRaw).toContain("material-icon-svgs.json");
  });
});
