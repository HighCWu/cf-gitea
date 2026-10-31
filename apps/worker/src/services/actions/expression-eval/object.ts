// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of actionslib v1.5.0 pkg/exprparser/object.go — the orderedObject that
// matches GitHub's DictionaryContextData: case-insensitive updates keep the
// first key's spelling and order (gitea.dev/actionslib v1.5.0,
// gitea/go.mod:11, the submodule's pin).
//
// SPEC-0012 §D5 tier E: the evaluator core. A JS Map carries the insertion
// order Go models with pairs+index; the fold key is the uppercased-units
// string, which is an injective-enough encoding of OrdinalIgnoreCase equality
// (the 0xFF prefix that kept Go's encoded folds out of the ASCII keyspace has
// no work to do on a JS string map — the folded form of a non-ASCII key
// simply cannot equal an all-ASCII key's folded form, because upperRune keeps
// a non-ASCII source that would fold into ASCII).

import { isASCII, upperUnits } from "../expression-syntax/ordinal";

/** maxFoldedKey bounds the folded lookup key an ASCII key builds inline (object.go:32-34). */
const maxFoldedKey = 64;

/**
 * OrderedObject is GitHub's DictionaryContextData (object.go:16-29): property
 * updates fold case-insensitively, keeping the first spelling and position;
 * iteration yields insertion order.
 */
export class OrderedObject {
  private readonly pairs: { key: string; value: unknown }[] = [];
  private readonly index = new Map<string, number>();

  get length(): number {
    return this.pairs.length;
  }

  /** Get reads one property case-insensitively (object.go:31-38). */
  get(key: string): { found: true; value: unknown } | { found: false } {
    const position = this.lookup(key);
    if (position === undefined) {
      return { found: false };
    }
    return { found: true, value: this.pairs[position]!.value };
  }

  /** lookup folds the key exactly the way foldKey indexes it (object.go:40-56). */
  private lookup(key: string): number | undefined {
    if (key.length > maxFoldedKey) {
      return this.index.get(foldKey(key));
    }
    let folded = "";
    for (let i = 0; i < key.length; i++) {
      const unit = key.charCodeAt(i);
      if (unit >= 0x80) {
        return this.index.get(foldKey(key));
      }
      folded += String.fromCharCode(asciiUpperUnit(unit));
    }
    return this.index.get(folded);
  }

  /** Set writes one property, keeping the first spelling and position of an equal-fold key (object.go:58-70). */
  set(key: string, value: unknown): void {
    const position = this.lookup(key);
    if (position !== undefined) {
      this.pairs[position]!.value = value;
      return;
    }
    this.index.set(foldKey(key), this.pairs.length);
    this.pairs.push({ key, value });
  }

  /** All iterates the properties in insertion order (object.go:72-82). */
  all(): Iterable<[string, unknown]> {
    return this.pairs.map((pair) => [pair.key, pair.value] as [string, unknown]);
  }

  /** Values iterates the property values in insertion order — what a wildcard projects (object.go:85-92). */
  values(): Iterable<unknown> {
    return this.pairs.map((pair) => pair.value);
  }
}

/** asciiUpperUnit case-folds one ASCII unit (object.go's foldKey fast path). */
function asciiUpperUnit(unit: number): number {
  if (unit >= 0x61 && unit <= 0x7a) {
    return unit - 0x20;
  }
  return unit;
}

/**
 * foldKey encodes OrdinalIgnoreCaseEqual equality so the index can be a plain
 * map (object.go:99-115): an ASCII key folds byte-wise; a non-ASCII key folds
 * through the uppercased code points.
 */
function foldKey(key: string): string {
  if (isASCII(key)) {
    return key.toUpperCase(); // an ASCII string has no Unicode-only uppercase mapping
  }
  // upperRune keeps a non-ASCII source whose uppercase would be ASCII, so the
  // folded units of a non-ASCII key cannot spell an all-ASCII fold.
  return String.fromCodePoint(...upperUnits(key));
}

/** asOrderedObject keeps the reference — an OrderedObject's identity IS the object's identity (object.go:118-125). */
export function asOrderedObject(value: unknown): OrderedObject | undefined {
  return value instanceof OrderedObject ? value : undefined;
}

/** maxPlainValueDepth bounds plainValue's walk — maxJSONDepth (object.go:128-130, json.go's shared limit). */
export const maxJSONDepth = 100;

/**
 * plainValue converts ordered objects into plain JS values without modifying
 * caller-owned containers (object.go:128-166) — the shape Evaluate returns.
 */
export function plainValue(value: unknown): { value: unknown; converted: boolean } {
  return plainValueDepth(value, 0);
}

function plainValueDepth(value: unknown, depth: number): { value: unknown; converted: boolean } {
  if (value instanceof OrderedObject) {
    if (depth >= maxJSONDepth) {
      return { value, converted: false };
    }
    const plain: Record<string, unknown> = {};
    for (const [key, property] of value.all()) {
      plain[key] = plainValueDepth(property, depth + 1).value;
    }
    return { value: plain, converted: true };
  }
  if (Array.isArray(value)) {
    if (depth >= maxJSONDepth) {
      return { value, converted: false };
    }
    let convertedAny = false;
    const plain = value.map((item) => {
      const next = plainValueDepth(item, depth + 1);
      if (next.converted) {
        convertedAny = true;
      }
      return next.value;
    });
    if (!convertedAny) {
      return { value, converted: false };
    }
    return { value: plain, converted: true };
  }
  return { value, converted: false };
}
