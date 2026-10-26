/**
 * The identicon generator behind upstream's random-avatar fallback — a strict
 * port of gitea/modules/avatar/identicon (itself copied from
 * github.com/issue9/identicon, MIT): sha256-driven block selection over a 3x3
 * grid, integer polygon rasterization (nonzero winding rule) and a
 * left-right mirror pass, rendered as a two-color indexed PNG.
 *
 * Ports, cite by cite:
 *
 *   - Make(sum selection)          identicon.go:38-52 — b1/b2/c block indexes,
 *     both rotation angles and the foreground color all derive from
 *     sha256(seed) bytes; the generation is FULLY DETERMINISTIC per seed
 *     (no math/rand), so pixel output is reproducible on Workers.
 *   - drawBlocks 3x3 layout + mirror pass  identicon.go:60-114 — padding =
 *     (size%3)/2, blockSize = size/3, blocks drawn at areas 5/1/2/8/7/4 with
 *     the angles advancing between areas, then the left-right mirror that
 *     "gets rid of something like swastika" (Go's Paletted.SetColorIndex
 *     clips out-of-bounds writes; x=0's mirror column `size` is clipped too).
 *   - drawBlock + rotate + pointInPolygon  block.go:26-40, polygon.go —
 *     rotation by (size/2, size/2) for angle!=0, per-pixel nonzero-winding
 *     containment test (winding == ±2).
 *   - b0..b27 block drawers        block.go — all 28 blocks (the blocks array
 *     order is load-bearing: it is the sha256 index space), with the
 *     center-only set [b0 b1 b2 b3 b19 b26 b27] (block.go:11-14).
 *   - DarkColors                   colors.go — web-safe colors without a 0xff
 *     component, minus pure black: 124 entries (verified by count), expressed
 *     below as {00,33,66,99,cc}^3 minus {000000} in the same r/g/b-nested
 *     order as the generated listing.
 *   - RandomImageWithSize          modules/avatar/avatar.go:32-36 — white
 *     background, DarkColors foreground; New() clamps size to [16, 2048]
 *     (identicon.go minImageSize/maxImageSize).
 *
 * PNG encoding: upstream emits Go's png.Encode output (optimized palette
 * compression). There is no image pipeline on Workers, so this module writes
 * the same PIXELS with a minimal indexed-PNG encoder (color type 3, bit depth
 * 8, filter-0 rows, zlib via the Web-standard CompressionStream). The byte
 * stream differs from Go's (different deflate implementation); the decoded
 * image is the ported contract. 96px callers: routers/web/base.go:41 (the
 * storage-handler fallback); 512px callers: the GenerateRandomAvatar port
 * (services/avatars.ts — DefaultAvatarSize 256 x RenderedSizeFactor 2,
 * modules/avatar/avatar.go:28,40-42).
 */

/** Web-safe palette colors with no 0xff component, minus pure black —
 * colors.go's DarkColors (124 entries, same r/g/b-nested order). */
export const IDENTICON_DARK_COLORS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const steps = [0x00, 0x33, 0x66, 0x99, 0xcc];
  const colors: Array<readonly [number, number, number]> = [];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        if (r === 0x00 && g === 0x00 && b === 0x00) continue; // colors.go starts at {0,0,0x33}
        colors.push([r, g, b]);
      }
    }
  }
  return colors;
})();

const IDENTICON_MIN_SIZE = 16; // identicon.go minImageSize
const IDENTICON_MAX_SIZE = 2048; // identicon.go maxImageSize

/** The center-only block set (block.go:11-14) — indexes into BLOCKS. */
const CENTER_BLOCKS = [0, 1, 2, 3, 19, 26, 27] as const;

/** block.go's blockFunc, over a flat Uint8 index buffer (0 = background). */
type BlockDrawer = (img: IdenticonImage, x: number, y: number, size: number, angle: number) => void;

/** The Paletted stand-in: SetColorIndex clips like Go's Paletted.Set. */
class IdenticonImage {
  readonly size: number;
  readonly pixels: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.pixels = new Uint8Array(size * size);
  }

  setColorIndex(x: number, y: number, index: number): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return; // Go's Set bounds check
    this.pixels[y * this.size + x] = index;
  }

  colorIndexAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return 0;
    return this.pixels[y * this.size + x]!; // in-bounds by the guard above
  }
}

// cos/sin of 0/90/180/270 degrees (polygon.go:8-13)
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];

/** polygon.go rotate — mutates the flat x,y point list around (cx, cy). */
function rotatePoints(points: number[], cx: number, cy: number, angle: number): void {
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i]! - cx;
    const py = points[i + 1]! - cy;
    points[i] = px * COS[angle]! - py * SIN[angle]! + cx;
    points[i + 1] = px * SIN[angle]! + py * COS[angle]! + cy;
  }
}

/** polygon.go pointInPolygon — the nonzero winding rule over flat points. */
function pointInPolygon(x: number, y: number, points: number[]): boolean {
  if (points.length < 8) return false; // a valid polygon must have >2 points
  let winding = 0;
  let prevX = points[0]!;
  let prevY = points[1]!;
  let prev = prevY > y || (prevX > x && prevY === y);
  for (let i = 2; i < points.length; i += 2) {
    const currX = points[i]!;
    const currY = points[i + 1]!;
    const curr = currY > y || (currX > x && currY === y);
    if (curr === prev) {
      prevX = currX;
      prevY = currY;
      continue;
    }
    const mul = (prevX - x) * (currY - y) - (currX - x) * (prevY - y);
    if (mul >= 0) {
      winding++;
    } else {
      winding--;
    }
    prevX = currX;
    prevY = currY;
    prev = curr;
  }
  return winding === 2 || winding === -2;
}

/** block.go drawBlock — rasterize one polygon (rotated by angle) as index 1. */
function drawBlock(img: IdenticonImage, x: number, y: number, size: number, angle: number, sourcePoints: number[]): void {
  const points = [...sourcePoints]; // Go mutates its caller's slice; blocks share literal lists
  if (angle !== 0) {
    const m = Math.floor(size / 2);
    rotatePoints(points, m, m, angle);
  }
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if (pointInPolygon(i, j, points)) {
        img.setColorIndex(x + i, y + j, 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The 28 block drawers (block.go b0..b27), in the blocks-array order the
// sha256 selection indexes into.
// ---------------------------------------------------------------------------

const BLOCKS: BlockDrawer[] = [
  // b0 — blank
  () => {},
  // b1 — full-filled
  (img, x, y, size) => {
    for (let i = x; i < x + size; i++) {
      for (let j = y; j < y + size; j++) {
        img.setColorIndex(i, j, 1);
      }
    }
  },
  // b2 — a small block
  (img, x, y, size) => {
    const l = Math.floor(size / 4);
    const bx = x + l;
    const by = y + l;
    for (let i = bx; i < bx + 2 * l; i++) {
      for (let j = by; j < by + 2 * l; j++) {
        img.setColorIndex(i, j, 1);
      }
    }
  },
  // b3 — diamond
  (img, x, y, size) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, 0, [m, 0, size, m, m, size, 0, m, m, 0]);
  },
  // b4 — right triangle
  (img, x, y, size, angle) => {
    drawBlock(img, x, y, size, angle, [0, 0, size, 0, 0, size, 0, 0]);
  },
  // b5 — quadrant triangle
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [m, 0, size, size, 0, size, m, 0]);
  },
  // b6 — half block
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, m, size, 0, size, 0, 0]);
  },
  // b7 — italic cone
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, size, m, size, size, m, size, 0, 0]);
  },
  // b8 — three small triangles
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const mm = Math.floor(m / 2);
    drawBlock(img, x, y, size, angle, [m, 0, 3 * mm, m, mm, m, m, 0]);
    drawBlock(img, x, y, size, angle, [mm, m, m, size, 0, size, mm, m]);
    drawBlock(img, x, y, size, angle, [3 * mm, m, size, size, m, size, 3 * mm, m]);
  },
  // b9 — italic triangle
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, size, m, m, size, 0, 0]);
  },
  // b10 — corner wedges
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [m, 0, size, 0, m, m, m, 0]);
    drawBlock(img, x, y, size, angle, [0, m, m, m, 0, size, 0, m]);
  },
  // b11 — corner square
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, m, m, 0, m, 0, 0]);
  },
  // b12 — triangle pointing down
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, m, size, m, m, size, 0, m]);
  },
  // b13 — triangle pointing up
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [m, m, size, size, 0, size, m, m]);
  },
  // b14 — small corner triangle
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [m, 0, m, m, 0, m, m, 0]);
  },
  // b15 — small corner wedge
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, 0, m, 0, 0]);
  },
  // b16 — two stacked triangles
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [m, 0, size, m, 0, m, m, 0]);
    drawBlock(img, x, y, size, angle, [m, m, size, size, 0, size, m, m]);
  },
  // b17 — wedge + corner square
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, 0, m, 0, 0]);
    const quarter = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [
      size - quarter,
      size - quarter,
      size,
      size - quarter,
      size,
      size,
      size - quarter,
      size,
      size - quarter,
      size - quarter,
    ]);
  },
  // b18 — left half triangle
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, 0, size, 0, 0]);
  },
  // b19 — ring of four wedges
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    drawBlock(img, x, y, size, angle, [0, 0, m, 0, 0, m, 0, 0]);
    drawBlock(img, x, y, size, angle, [m, 0, size, 0, size, m, m, 0]);
    drawBlock(img, x, y, size, angle, [size, m, size, size, m, size, size, m]);
    drawBlock(img, x, y, size, angle, [0, m, m, size, 0, size, 0, m]);
  },
  // b20 — slanted wedge
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [q, 0, 0, size, 0, m, q, 0]);
  },
  // b21 — slanted wedge + small wedge
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [q, 0, 0, size, 0, m, q, 0]);
    drawBlock(img, x, y, size, angle, [q, 0, size, q, size, m, q, 0]);
  },
  // b22 — slanted wedge + long wedge
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [q, 0, 0, size, 0, m, q, 0]);
    drawBlock(img, x, y, size, angle, [q, 0, size, q, size, size, q, 0]);
  },
  // b23 — slanted wedge + top wedge
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [q, 0, 0, size, 0, m, q, 0]);
    drawBlock(img, x, y, size, angle, [q, 0, size, 0, size, q, q, 0]);
  },
  // b24 — slanted wedge + right half block
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [q, 0, 0, size, 0, m, q, 0]);
    drawBlock(img, x, y, size, angle, [m, 0, size, 0, m, size, m, 0]);
  },
  // b25 — left bar + diagonal
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [0, 0, 0, size, q, size, 0, 0]);
    drawBlock(img, x, y, size, angle, [0, m, size, 0, q, size, 0, m]);
  },
  // b26 — four corner arcs
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [0, 0, m, q, q, m, 0, 0]);
    drawBlock(img, x, y, size, angle, [size, 0, m + q, m, m, q, size, 0]);
    drawBlock(img, x, y, size, angle, [size, size, m, m + q, q + m, m, size, size]);
    drawBlock(img, x, y, size, angle, [0, size, q, m, m, q + m, 0, size]);
  },
  // b27 — ring of four bars
  (img, x, y, size, angle) => {
    const m = Math.floor(size / 2);
    const q = Math.floor(size / 4);
    drawBlock(img, x, y, size, angle, [0, 0, size, 0, 0, q, 0, 0]);
    drawBlock(img, x, y, size, angle, [q + m, 0, size, 0, size, size, q + m, 0]);
    drawBlock(img, x, y, size, angle, [size, q + m, size, size, 0, size, size, q + m]);
    drawBlock(img, x, y, size, angle, [0, size, 0, 0, q, size, 0, size]);
  },
];

/** identicon.go drawBlocks — the 3x3 layout plus the left-right mirror pass. */
function drawBlocks(
  img: IdenticonImage,
  size: number,
  center: BlockDrawer,
  b1: BlockDrawer,
  b2: BlockDrawer,
  b1Angle: number,
  b2Angle: number,
): void {
  const nextAngle = (a: number): number => (a + 1) % 4;
  const padding = Math.floor((size % 3) / 2); // align 3 blocks into odd sizes
  const blockSize = Math.floor(size / 3);
  const twoBlockSize = 2 * blockSize;

  // center (area 5)
  center(img, blockSize + padding, blockSize + padding, blockSize, 0);
  // left top (1)
  b1(img, 0 + padding, 0 + padding, blockSize, b1Angle);
  // center top (2)
  b2(img, blockSize + padding, 0 + padding, blockSize, b2Angle);

  b1Angle = nextAngle(b1Angle);
  b2Angle = nextAngle(b2Angle);
  // (areas 3/6/9 are not drawn — the mirror below recreates them)
  // center bottom (8)
  b2(img, blockSize + padding, twoBlockSize + padding, blockSize, b2Angle);

  b1Angle = nextAngle(b1Angle);
  b2Angle = nextAngle(b2Angle);
  // left bottom (7)
  b1(img, 0 + padding, twoBlockSize + padding, blockSize, b1Angle);
  // left middle (4)
  b2(img, 0 + padding, blockSize + padding, blockSize, b2Angle);

  // left-right mirror (identicon.go:106-110); x=0's target column `size` is
  // clipped by setColorIndex like Go's Paletted.Set.
  for (let x = 0; x < Math.floor(size / 2); x++) {
    for (let y = 0; y < size; y++) {
      img.setColorIndex(size - x, y, img.colorIndexAt(x, y));
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal indexed-PNG encoder (see the module header for the divergence cite)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The workers-types env declares no BlobPart — enqueue the bytes directly. */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function zlibDeflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = bytesStream(raw).pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface IdenticonPng {
  /** The complete PNG byte stream (color type 3, bit depth 8). */
  readonly bytes: Uint8Array;
  /** Pixel width/height (after the [16, 2048] clamp). */
  readonly size: number;
}

/**
 * RandomImageWithSize (modules/avatar/avatar.go:32-36) + Go's png.Encode:
 * render the sha256-seeded two-color identicon and encode it as an indexed
 * PNG. Palette: white background + DarkColors[pick] (identicon.go New,
 * render); pixels per the ported block/mirror algorithm above.
 */
export async function renderIdenticonPng(size: number, seed: Uint8Array): Promise<IdenticonPng> {
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-256", seed));
  const clamped = Math.min(Math.max(size, IDENTICON_MIN_SIZE), IDENTICON_MAX_SIZE);
  const b1 = (sum[0]! + sum[1]! + sum[2]!) % BLOCKS.length;
  const b2 = (sum[3]! + sum[4]! + sum[5]!) % BLOCKS.length;
  const center = (sum[6]! + sum[7]! + sum[8]!) % CENTER_BLOCKS.length;
  const b1Angle = (sum[9]! + sum[10]!) % 4;
  const b2Angle = (sum[11]! + sum[12]!) % 4;
  const foreColor = (sum[11]! + sum[12]! + sum[15]!) % IDENTICON_DARK_COLORS.length;

  const img = new IdenticonImage(clamped);
  drawBlocks(img, clamped, BLOCKS[CENTER_BLOCKS[center]!]!, BLOCKS[b1]!, BLOCKS[b2]!, b1Angle, b2Angle);

  // IHDR — width, height, bit depth 8, color type 3 (indexed), no interlace.
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, clamped);
  ihdrView.setUint32(4, clamped);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed
  // compression/filter/interlace stay 0

  // PLTE — white background + the picked dark foreground.
  const [fr, fg, fb] = IDENTICON_DARK_COLORS[foreColor]!;
  const plte = new Uint8Array([0xff, 0xff, 0xff, fr, fg, fb]);

  // IDAT — filter-0 rows over the index bytes, zlib-deflated.
  const raw = new Uint8Array(clamped * (clamped + 1));
  for (let y = 0; y < clamped; y++) {
    raw[y * (clamped + 1)] = 0; // filter type None
    raw.set(img.pixels.subarray(y * clamped, (y + 1) * clamped), y * (clamped + 1) + 1);
  }
  const idat = await zlibDeflate(raw);

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", plte),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return { bytes: out, size: clamped };
}
