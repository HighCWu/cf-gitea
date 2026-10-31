// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Conformance port of actionslib v1.5.0 pkg/internal/syntax/ordinal_test.go
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11) — actionslib's OWN fixtures.
//
// The Go fixtures written as byte strings ("\xff", "\xed\xa0\x80", …) model
// here as the JS strings carrying the same leading code unit: a JS string has
// no invalid-UTF-8 representation, and the fixtures' VERDICTS are
// unit-identical under that mapping (each pair still uppercases apart, or
// folds together, exactly as Go's RuneError-decoded units decide).

import { describe, expect, it } from "vitest";

import {
  OrdinalIgnoreCaseCompare,
  OrdinalIgnoreCaseContains,
  OrdinalIgnoreCaseEqual,
  OrdinalIgnoreCaseHasPrefix,
  OrdinalIgnoreCaseHasSuffix,
} from "./ordinal";

describe("OrdinalIgnoreCaseEqual (ordinal_test.go:10-36)", () => {
  it.each([
    ["asdf", "ASDF", true],
    ["ς", "Σ", true],
    ["ς", "σ", true],
    ["ſ", "S", false],
    ["ı", "I", false],
    ["i", "İ", false],
    ["ß", "ss", false],
    ["ß", "ẞ", false],
    ["K", "\u212A", false],
    ["\u00C5", "\u212B", false],
    ["\u03B8", "\u03F4", false],
    ["\u03C9", "\u2126", false],
    ["\u00E9", "e\u0301", false],
    ["\u{10428}", "\u{10400}", true],
    ["\u00ff", "\u00fe", false], // "\xff" vs "\xfe"
    ["\u00ff", "\uFFFD", false], // "\xff" vs "\ufffd"
    ["\u00ff\u00fe", "\u00fe\u00ff", false], // "\xff\xfe" vs "\xfe\xff"
    ["\u00c0\u0080", "\u0000", false], // "\xc0\x80" vs "\x00"
    ["\uD800", "\uDC00", false], // "\xed\xa0\x80" vs "\xed\xb0\x80"
    ["\uD800", "\uD801", false], // "\xf0\x90\x80" vs "\xf0\x90\x81"
    ["\u00ff", "\u{100ff}", false], // "\xff" vs "\U000100ff"
    ["a\u00ffς", "A\u00ffΣ", true], // "a\xffς" vs "A\xffΣ"
  ] as Array<[string, string, boolean]>)("%j vs %j → %j", (a, b, want) => {
    expect(OrdinalIgnoreCaseEqual(a, b)).toBe(want);
  });
});

describe("OrdinalIgnoreCaseCompare (ordinal_test.go:38-45)", () => {
  it("orders the fixture pairs", () => {
    expect(OrdinalIgnoreCaseCompare("\u{10000}", "\uE000")).toBeGreaterThan(0);
    expect(OrdinalIgnoreCaseCompare("\u{10000}", "\uFFFD")).toBeGreaterThan(0);
    expect(OrdinalIgnoreCaseCompare("a\u{10000}", "a\uE000")).toBeGreaterThan(0);
    expect(OrdinalIgnoreCaseCompare("a", "b")).toBeLessThan(0);
    expect(OrdinalIgnoreCaseCompare("10", "2")).toBeLessThan(0);
    expect(OrdinalIgnoreCaseCompare("aBc", "AbC")).toBe(0);
    expect(OrdinalIgnoreCaseCompare("b", "A")).toBeGreaterThan(0);
  });
});

describe("OrdinalIgnoreCase affixes (ordinal_test.go:47-57)", () => {
  it("matches the fixture affixes", () => {
    expect(OrdinalIgnoreCaseHasPrefix("asdf_Σ", "ASDF")).toBe(true);
    expect(OrdinalIgnoreCaseHasSuffix("asdf_ς", "Σ")).toBe(true);
    expect(OrdinalIgnoreCaseContains("xxΣxx", "ς")).toBe(true);
    expect(OrdinalIgnoreCaseHasPrefix("anything", "")).toBe(true);
    expect(OrdinalIgnoreCaseHasPrefix("", "x")).toBe(false);
    expect(OrdinalIgnoreCaseContains("abc", "ß")).toBe(false);
    expect(OrdinalIgnoreCaseContains("Σ\u00ffx", "ς\u00ff")).toBe(true); // "Σ\xffx" vs "ς\xff"
    expect(OrdinalIgnoreCaseContains("a\u00ffb", "\u00fe")).toBe(false); // "a\xffb" vs "\xfe"
    expect(OrdinalIgnoreCaseHasPrefix("\uFFFDx", "\u00ff")).toBe(false); // "\ufffdx" vs "\xff"
    expect(OrdinalIgnoreCaseHasSuffix("\u{10080}", "\u0080")).toBe(false); // "\U00010080" vs "\x80"
  });
});
