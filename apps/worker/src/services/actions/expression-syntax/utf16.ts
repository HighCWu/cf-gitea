// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/utf16.go — UTF-16 unit
// counting (the runner counts expression positions and the length limit in
// UTF-16 units; gitea.dev/actionslib v1.5.0, gitea/go.mod:11).
//
// The Go original walks UTF-8 BYTES with a word-at-a-time fast path
// (highBits/wordUnits/byteUnits) because its input is a byte string. This
// port's input is a JS string — already UTF-16 code units — so the count is a
// code-point walk: 1 unit below U+10000, 2 at or above. Behavior-equal on
// well-formed strings (everything real callers supply); lone surrogates
// (impossible in Go's decoded runes, possible in a JS string) count 2, which
// matches Go's utf16.RuneLen for the surrogate range.

/**
 * utf16Len returns the number of UTF-16 code units required to encode value
 * (utf16.go:13-39). For a well-formed JS string this is value.length; the
 * walk exists to keep the astral/surrogate accounting explicit and total.
 */
export function utf16Len(value: string): number {
  let units = 0;
  for (const character of value) {
    units += character.codePointAt(0)! >= 0x10000 ? 2 : 1;
  }
  return units;
}
