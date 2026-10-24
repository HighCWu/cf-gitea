import type { ObjType } from "../git/objects";

export interface ObjRec {
  type: ObjType;
  data: Uint8Array;
}

/**
 * Byte-budgeted LRU cache of inflated objects (delta-chain bases, hot
 * commits/trees). Relocated here from git/packstore.ts (SPEC-0001a §3 Step 2):
 * it is pure machinery with no DO state, and both of its consumers — the
 * Worker-side receive resolver and the DO's serve path (GitStore.cache) —
 * share it unchanged.
 */
export class ObjCache {
  private map = new Map<string, ObjRec>();
  private bytes = 0;

  constructor(private budget: number) {}

  get(oid: string): ObjRec | undefined {
    const hit = this.map.get(oid);
    if (hit) {
      this.map.delete(oid);
      this.map.set(oid, hit);
    }
    return hit;
  }

  put(oid: string, obj: ObjRec): void {
    if (obj.data.length > this.budget / 4) return;
    if (this.map.has(oid)) return;
    this.map.set(oid, obj);
    this.bytes += obj.data.length;
    while (this.bytes > this.budget) {
      const oldest = this.map.keys().next().value as string;
      this.bytes -= this.map.get(oldest)!.data.length;
      this.map.delete(oldest);
    }
  }
}
