// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The YAML-node plumbing the model port rides (SPEC-0012 §D5 tier E): the
// `yaml` package's node kinds stand in for go-yaml's, with the two decoding
// behaviors go-yaml's Decode-into-value applies and the alias expansion
// upstream's jobparser performs before any model read (jobparser/aliases.go).
//
//   - decodeYamlValue is go-yaml's Decode(&any): merge keys (`<<`) merge as
//     defaults, a merge-tagged scalar inside a sequence is dropped (the
//     matrix_test.go "names list decoded scalars in YAML order" fixture pins
//     both), aliases are followed, and mappings stay insertion-ordered
//     (plain records; integer-like keys never collide with the string keys
//     the model reads).
//   - resolveYamlAliases replaces every alias with a copy of the node its
//     anchor names (jobparser/aliases.go:53-60), optionally rejecting merge
//     keys (`rejectMergeKeys`, jobparser Parse's own gate — the model's own
//     readJob arm does not reject, which its fixtures ride).
//
// Deviation (documented): go-yaml tags `<<` as !!merge; the `yaml` package
// leaves it a plain scalar, so merge detection matches the VALUE "<<" where
// go-yaml matches the tag. Same inputs, same verdicts on every fixture.

import type { Document, Node as YamlNode, Pair, Scalar, YAMLMap } from "yaml";
import { isAlias, isMap, isScalar, isSeq, parseDocument, Pair as PairCtor, Scalar as ScalarCtor, YAMLMap as YamlMapCtor, YAMLSeq as YamlSeqCtor } from "yaml";

/** MatrixNode is a possibly-absent node slot (`Kind == 0` upstream). */
export interface MatrixNode {
  present: boolean;
  node: YamlNode;
}

/** resolveAlias answers the node itself: callers expand aliases at parse
 *  (resolveYamlAliases — jobparser/aliases.go), so a live Alias never
 *  reaches the model. The `yaml` package's Alias.source is the anchor NAME,
 *  resolved through its document — the expansion walk owns that. */
export function resolveAlias(node: YamlNode | undefined | null): YamlNode | undefined {
  if (node !== undefined && node !== null && isAlias(node)) {
    return undefined;
  }
  return node ?? undefined;
}

/** decodeScalarText reads a scalar the way go-yaml's Decode into string does
 *  (decode.go's scalar arm): a !!binary node decodes to its data, every
 *  other scalar to its literal text. */
export function decodeScalarText(node: YamlNode | undefined): string {
  if (node === undefined) return "";
  const resolved = resolveAlias(node) ?? node;
  if (!isScalar(resolved)) return "";
  const value: unknown = resolved.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  // the yaml package decodes !!binary into a {type:"Buffer",data:[...]} record
  if (typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return new TextDecoder().decode(Uint8Array.from((value as { data: number[] }).data));
  }
  return "";
}

/** isMergeKey reports whether a mapping key is the YAML merge key. */
export function isMergeKey(keyNode: YamlNode): boolean {
  const resolved = resolveAlias(keyNode) ?? keyNode;
  return isScalar(resolved) && resolved.value === "<<";
}

/**
 * decodeYamlValue decodes a node into the plain JS value go-yaml's
 * Decode(&any) produces: scalars as their resolved values (a merge-tagged
 * sequence item is DROPPED — the decoder's merge arm), mappings as
 * insertion-ordered records with merge keys applied as defaults (explicit
 * keys win), sequences as arrays.
 */
export function decodeYamlValue(node: YamlNode | undefined | null): unknown {
  if (node === undefined || node === null) return undefined;
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    if (isMergeKey(resolved)) return undefined; // dropped, like go-yaml's sequence decode
    const value: unknown = resolved.value;
    if (value instanceof Uint8Array) return new TextDecoder().decode(value);
    if (typeof value === "object" && value !== null && Array.isArray((value as { data?: unknown }).data)) {
      return new TextDecoder().decode(Uint8Array.from((value as { data: number[] }).data));
    }
    return value;
  }
  if (isMap(resolved)) {
    const out: Record<string, unknown> = {};
    const merged: Array<unknown> = [];
    for (const pair of resolved.items) {
      const keyNode = pair.key as YamlNode;
      const valueNode = (pair.value ?? new ScalarCtor(null)) as YamlNode;
      if (isMergeKey(keyNode)) {
        // `<<: *anchor` / `<<: [*a, *b]` — merged values never override explicit keys
        const value = decodeYamlValue(valueNode);
        if (Array.isArray(value)) merged.push(...(value as unknown[]));
        else merged.push(value);
        continue;
      }
      const key = decodeScalarText(keyNode);
      out[key] = decodeYamlValue(valueNode);
    }
    for (const entry of merged) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
          if (!(key in out)) out[key] = value;
        }
      }
    }
    return out;
  }
  if (isSeq(resolved)) {
    const out: unknown[] = [];
    for (const item of (resolved as { items: unknown[] }).items) {
      const value = decodeYamlValue((item ?? new ScalarCtor(null)) as YamlNode);
      if (isMergeKey(item as YamlNode)) continue; // the decoder drops merge scalars from sequences
      out.push(value);
    }
    return out;
  }
  return undefined;
}

/** yamlEntryPairs walks a mapping's entries as (key, value) node pairs. */
export function yamlEntryPairs(map: YAMLMap): Array<[YamlNode, YamlNode]> {
  return map.items.map((pair: Pair) => [pair.key as YamlNode, (pair.value ?? new ScalarCtor(null)) as YamlNode]);
}

/** cloneNode deep-copies a node subtree (workflow.go's CloneYamlNode). */
export function cloneNode(node: YamlNode): YamlNode {
  const resolved = resolveAlias(node) ?? node;
  if (isScalar(resolved)) {
    const scalar = new ScalarCtor(resolved.value);
    if (resolved.type !== undefined) scalar.type = resolved.type;
    if (resolved.tag !== undefined) scalar.tag = resolved.tag;
    if (resolved.comment) scalar.comment = resolved.comment;
    return scalar;
  }
  if (isMap(resolved)) {
    const map = new YamlMapCtor();
    for (const [key, value] of yamlEntryPairs(resolved)) {
      map.items.push(new PairCtor(cloneNode(key), cloneNode(value)));
    }
    if (resolved.comment) map.comment = resolved.comment;
    return map;
  }
  if (isSeq(resolved)) {
    const seq = new YamlSeqCtor();
    for (const item of (resolved).items) {
      seq.items.push(cloneNode((item ?? new ScalarCtor(null)) as YamlNode));
    }
    if (resolved.comment) seq.comment = resolved.comment;
    return seq;
  }
  return node;
}

/** rejectMergeKeys (jobparser/aliases.go:63-73) refuses `<<: *anchor`, same as GitHub does. */
export function rejectMergeKeys(node: YamlNode | undefined): Error | null {
  if (node === undefined) return null;
  const resolved = resolveAlias(node) ?? node;
  if (isMap(resolved)) {
    for (const pair of resolved.items) {
      if (isMergeKey(pair.key as YamlNode)) {
        return new Error("merge keys (`<<`) are not supported, alias the whole value instead");
      }
    }
  }
  for (const child of collectionChildren(resolved)) {
    const problem = rejectMergeKeys(child);
    if (problem !== null) return problem;
  }
  return null;
}

/** collectionChildren walks a collection node's child nodes. */
function collectionChildren(node: YamlNode): YamlNode[] {
  if (isMap(node)) {
    const out: YamlNode[] = [];
    for (const pair of node.items) {
      out.push(pair.key as YamlNode);
      if (pair.value !== undefined && pair.value !== null) out.push(pair.value as YamlNode);
    }
    return out;
  }
  if (isSeq(node)) return (node).items as YamlNode[];
  return [];
}

/**
 * resolveYamlAliases parses content and replaces every alias with a copy of
 * the node its anchor names (jobparser/aliases.go:53-60, over go-yaml's
 * alias graph). The last anchor instance before the alias wins, matching
 * the yaml package's own resolution order.
 */
export function resolveYamlAliases(content: string): { doc: Document; error: Error | null } {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    return { doc, error: new Error(first.message) };
  }
  if (doc.contents === undefined || doc.contents === null) {
    return { doc, error: null };
  }
  expandAliases(doc.contents, new Map<string, YamlNode>());
  return { doc, error: null };
}

/** expandAliases replaces aliases in place with clones of their anchored nodes. */
function expandAliases(node: YamlNode, anchors: Map<string, YamlNode>): void {
  const resolved = resolveAlias(node) ?? node;
  const anchor = (resolved as { anchor?: string }).anchor;
  if (typeof anchor === "string" && anchor !== "") {
    anchors.set(anchor, resolved);
  }
  if (isMap(resolved)) {
    for (const pair of resolved.items) {
      if (pair.key !== undefined && pair.key !== null) {
        const key = pair.key as YamlNode;
        const replacement = replaceAlias(key, anchors);
        if (replacement !== key) pair.key = replacement;
        expandAliases((pair.key ?? new ScalarCtor(null)) as YamlNode, anchors);
      }
      if (pair.value !== undefined && pair.value !== null) {
        const value = pair.value as YamlNode;
        const replacement = replaceAlias(value, anchors);
        if (replacement !== value) pair.value = replacement;
        expandAliases((pair.value ?? new ScalarCtor(null)) as YamlNode, anchors);
      }
    }
    return;
  }
  if (isSeq(resolved)) {
    const items = (resolved).items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as YamlNode | undefined;
      if (item === undefined || item === null) continue;
      const replacement = replaceAlias(item, anchors);
      if (replacement !== item) items[i] = replacement;
      expandAliases((items[i] ?? new ScalarCtor(null)) as YamlNode, anchors);
    }
  }
}

/** replaceAlias clones the anchored node for one alias occurrence. */
function replaceAlias(node: YamlNode, anchors: Map<string, YamlNode>): YamlNode {
  if (!isAlias(node)) return node;
  const found = anchors.get((node as unknown as { source: string }).source);
  if (found === undefined) {
    throw new Error(`unknown anchor '${(node as unknown as { source: string }).source}' referenced`);
  }
  return cloneNode(found);
}

/** parseWorkflowDocument parses a workflow with aliases expanded, for the
 *  model tests' readJob helper (workflow_test.go's readWorkflow arm over a
 *  job body) and the jobparser layer (which adds the merge-key rejection). */
export function parseWorkflowDocument(content: string, opts: { rejectMerges?: boolean } = {}): { doc: Document; error: Error | null } {
  const { doc, error } = resolveYamlAliases(content);
  if (error !== null) return { doc, error };
  if (opts.rejectMerges === true) {
    const problem = rejectMergeKeys(doc.contents as YamlNode | undefined);
    if (problem !== null) return { doc, error: problem };
  }
  return { doc, error: null };
}

/** textScalar builds a plain string scalar node. */
export function textScalar(value: string): Scalar {
  const scalar = new ScalarCtor(value);
  scalar.type = "PLAIN";
  return scalar;
}

/** textSeq builds a plain sequence of string scalars. */
export function textSeq(labels: string[]): YamlNode {
  const seq = new YamlSeqCtor();
  for (const label of labels) seq.items.push(textScalar(label));
  return seq;
}
