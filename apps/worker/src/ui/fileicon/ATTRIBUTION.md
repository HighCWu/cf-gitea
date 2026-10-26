# Attribution — file icon assets

This directory vendors generated file-icon data originally produced from the
[Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
project (`material-icon-theme`, npm package, version 5.39.0 — the version
upstream Gitea pins in its `package.json` at this submodule commit). The
project is licensed under the MIT License, reproduced verbatim below as
required by that license.

## Provenance chain (byte-identical copies)

- `material-icon-rules.json`, `material-icon-svgs.json` — copied byte-identical
  (sha256-verified) from the pinned submodule's
  `gitea/options/fileicon/` files of the same names. Upstream generates them
  with `gitea/tools/generate-svg.ts` (`make svg`) from the npm package's
  `dist/material-icons.json` rules and `icons/*.svg` bodies (the SVGs
  svgo-optimized, attributes normalized, double quotes swapped for single
  quotes).
- `basic/*.svg` — copied byte-identical (sha256-verified) from the pinned
  submodule's `gitea/public/assets/img/svg/` store (the same processed form
  `make svg` commits): the six octicons the basic entry-icon layer renders
  (`octicon-file`, `octicon-file-symlink-file`,
  `octicon-file-directory-symlink`, `octicon-file-directory-open-fill`,
  `octicon-file-directory-fill`, `octicon-file-submodule`) plus
  `material-folder-symlink` (the symlink-to-directory icon,
  `gitea/modules/fileicon/material.go:90`). Octicons are GitHub's
  Octicons (@primer/octicons, MIT); `material-folder-symlink` is Gitea's own
  web asset derived from the same Material Icon Theme generation pass
  (`web_src/svg/material-folder-symlink.svg` upstream).

The pinned submodule carries no per-file license note for these assets
(upstream consumes them via the `material-icon-theme` npm devDependency and
its MIT license); this note is the attribution that decoupling the generated
JSONs from that dependency requires.

## MIT License (material-icon-theme — verbatim)

```
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
