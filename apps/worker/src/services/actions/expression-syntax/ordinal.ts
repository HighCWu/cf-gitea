// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/internal/syntax/ordinal.go — GitHub's
// OrdinalIgnoreCase comparison orders uppercased Unicode scalars
// (gitea.dev/actionslib v1.5.0, gitea/go.mod:11).
//
// Go's input is a UTF-8 byte string; this port's is a JS string. The walk
// that Go does over bytes this port does over UTF-16 code units — the two
// agree because every decision point is "is this scalar ASCII?" (unit < 0x80
// in both worlds) and the non-ASCII arm decodes full code points either way.
// Go's RuneError arm in upperUnits (an invalid byte becoming
// MaxRune+1+byte) has no input in JS-land — every unit is a scalar — so that
// arm is absent; the fixtures it served stay verdict-equal because an
// unmapped unit and its comparison partner still uppercase apart.
//
// simpleUpper reproduces Go's unicode.ToUpper, i.e. Unicode's SIMPLE
// uppercase mapping: String.prototype.toUpperCase applies the same table but
// also the multi-code-point SpecialCasing entries (ß→SS, ﬁ→FI); a
// multi-code-point result means no simple mapping exists, which Go answers
// with the identity. KELVIN/ANGSTROM are Lu, so both engines keep them as-is
// — that is what the ſ/ı/Å fixtures pin, via upperRune's ASCII guard.

/** upperRune uppercases one scalar, keeping a non-ASCII source that would
 * case-fold into ASCII (ordinal.go:14-20) — the rule that makes ſ and ı
 * never equal their ASCII lookalikes. */
export function upperRune(character: number): number {
  const upper = simpleUpper(character);
  if (character >= 0x80 && upper < 0x80) {
    return character;
  }
  return upper;
}

/** The simple uppercase of one scalar (Go unicode.ToUpper): the length check
 * rejects the multi-code-point SpecialCasing results (ß→SS), which have no
 * simple mapping — Go's table answers those with the identity. */
function simpleUpper(character: number): number {
  const upper = String.fromCodePoint(character).toUpperCase();
  if (upper.length === (character > 0xffff ? 2 : 1)) {
    return upper.codePointAt(0)!;
  }
  return character;
}

/** upperUnits decodes value's code points, uppercasing each (ordinal.go:22-34). */
export function upperUnits(value: string): number[] {
  const units: number[] = [];
  for (const ch of value) {
    units.push(upperRune(ch.codePointAt(0)!));
  }
  return units;
}

/** isASCII reports whether every unit is ASCII (ordinal.go:36-43). */
export function isASCII(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      return false;
    }
  }
  return true;
}

/** asciiUpperUnit case-folds one ASCII unit (ordinal.go:45-50). */
export function asciiUpperUnit(character: number): number {
  if (character >= 0x61 && character <= 0x7a) {
    return character - 0x20;
  }
  return character;
}

/** asciiEqualAt reports whether the units of want match s at offset, ignoring
 * case (ordinal.go:52-62). An ASCII want can only match ASCII units, since no
 * other scalar uppercases into that range (upperRune's guard). */
function asciiEqualAt(s: string, offset: number, want: string): boolean {
  for (let i = 0; i < want.length; i++) {
    const character = s.charCodeAt(offset + i);
    if (character >= 0x80 || asciiUpperUnit(character) !== asciiUpperUnit(want.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

/** slices.Compare over scalar arrays: element-wise, ties by length. */
function compareUnits(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  return Math.sign(a.length - b.length);
}

/**
 * OrdinalIgnoreCaseCompare returns a negative number, zero or a positive
 * number as a sorts before, equal to or after b, matching .NET's
 * String.Compare with StringComparison.OrdinalIgnoreCase (ordinal.go:67-78).
 */
export function OrdinalIgnoreCaseCompare(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca >= 0x80 || cb >= 0x80) {
      return compareUnits(upperUnits(a), upperUnits(b));
    }
    const left = asciiUpperUnit(ca);
    const right = asciiUpperUnit(cb);
    if (left !== right) {
      return left - right;
    }
  }
  // The shared prefix is ASCII, so whichever string continues past it sorts after.
  return a.length - b.length;
}

/** OrdinalIgnoreCaseEqual reports whether a and b are equal ignoring case (ordinal.go:81-83). */
export function OrdinalIgnoreCaseEqual(a: string, b: string): boolean {
  return OrdinalIgnoreCaseCompare(a, b) === 0;
}

/** OrdinalIgnoreCaseContains reports whether substr occurs within s, ignoring case (ordinal.go:86-96). */
export function OrdinalIgnoreCaseContains(s: string, substr: string): boolean {
  if (!isASCII(substr)) {
    return indexUnits(upperUnits(s), upperUnits(substr)) >= 0;
  }
  for (let offset = 0; offset + substr.length <= s.length; offset++) {
    if (asciiEqualAt(s, offset, substr)) {
      return true;
    }
  }
  return false;
}

/** OrdinalIgnoreCaseHasPrefix reports whether s begins with prefix, ignoring case (ordinal.go:99-105). */
export function OrdinalIgnoreCaseHasPrefix(s: string, prefix: string): boolean {
  if (!isASCII(prefix)) {
    const su = upperUnits(s);
    const pu = upperUnits(prefix);
    return su.length >= pu.length && compareUnits(su.slice(0, pu.length), pu) === 0;
  }
  return s.length >= prefix.length && asciiEqualAt(s, 0, prefix);
}

/** OrdinalIgnoreCaseHasSuffix reports whether s ends with suffix, ignoring case (ordinal.go:108-114). */
export function OrdinalIgnoreCaseHasSuffix(s: string, suffix: string): boolean {
  if (!isASCII(suffix)) {
    const su = upperUnits(s);
    const fu = upperUnits(suffix);
    return su.length >= fu.length && compareUnits(su.slice(su.length - fu.length), fu) === 0;
  }
  return s.length >= suffix.length && asciiEqualAt(s, s.length - suffix.length, suffix);
}

function indexUnits(s: number[], sub: number[]): number {
  if (sub.length === 0) {
    return 0;
  }
  for (let i = 0; i + sub.length <= s.length; i++) {
    let equal = true;
    for (let j = 0; j < sub.length; j++) {
      if (s[i + j] !== sub[j]) {
        equal = false;
        break;
      }
    }
    if (equal) {
      return i;
    }
  }
  return -1;
}
