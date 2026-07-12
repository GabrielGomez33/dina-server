// File: src/modules/vision/ingestion/imageProbe.ts
// ============================================================================
// PURE-TS IMAGE FORMAT + DIMENSION PROBE
// ============================================================================
// Detects an image's true format from its MAGIC BYTES (never a caller's claim)
// and reads its pixel dimensions straight from the file header — WITHOUT any
// native dependency (no sharp/canvas/libvips). This matters for three reasons:
//
//   1. SECURITY — the declared MIME/extension is untrusted. A ".png" that is
//      really an HTML/SVG/script payload must be rejected. We trust bytes only.
//   2. DECOMPRESSION-BOMB DEFENCE — we learn w*h from the header (a few bytes)
//      BEFORE anything tries to decode the pixels, so a 10-byte header claiming
//      100000x100000 is rejected without ever allocating that buffer.
//   3. PORTABILITY — no native module means it runs anywhere the server runs,
//      including the hardened read-only container, with zero install risk.
//
// Supported: JPEG, PNG, GIF, WebP (VP8/VP8L/VP8X), BMP. Unknown/unsupported
// formats return { format: 'unknown' } and the guard rejects them.
// ============================================================================

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'unknown';

export interface ProbeResult {
  format: ImageFormat;
  mimeType: string;
  /** Pixel dimensions when the header could be parsed, else null. */
  width: number | null;
  height: number | null;
}

const FORMAT_MIME: Record<Exclude<ImageFormat, 'unknown'>, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** Map a detected format to its canonical MIME type ('' for unknown). */
export function mimeForFormat(format: ImageFormat): string {
  return format === 'unknown' ? '' : FORMAT_MIME[format];
}

/**
 * Probe a byte buffer for its true image format and dimensions.
 * Never throws — always returns a result (format 'unknown' when unrecognised).
 * Every multi-byte read is bounds-checked so a truncated/hostile buffer can
 * only ever yield null dimensions, never an out-of-range read.
 */
export function probeImage(buf: Buffer): ProbeResult {
  if (!buf || buf.length < 2) return unknown();

  // ---- JPEG: FF D8 FF ----
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', mimeType: FORMAT_MIME.jpeg, ...readJpegSize(buf) };
  }

  // ---- PNG: 89 50 4E 47 0D 0A 1A 0A ----
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    // IHDR is the first chunk; width/height are big-endian at offsets 16/20.
    return { format: 'png', mimeType: FORMAT_MIME.png, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // ---- GIF: "GIF87a" / "GIF89a" ----
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    // Logical screen width/height are little-endian at offsets 6/8.
    return { format: 'gif', mimeType: FORMAT_MIME.gif, width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // ---- WebP: "RIFF"...."WEBP" ----
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { format: 'webp', mimeType: FORMAT_MIME.webp, ...readWebpSize(buf) };
  }

  // ---- BMP: "BM" ----
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    // BITMAPINFOHEADER width/height are signed little-endian at 18/22.
    const w = buf.readInt32LE(18);
    const h = buf.readInt32LE(22);
    return { format: 'bmp', mimeType: FORMAT_MIME.bmp, width: Math.abs(w) || null, height: Math.abs(h) || null };
  }

  return unknown();
}

function unknown(): ProbeResult {
  return { format: 'unknown', mimeType: '', width: null, height: null };
}

/**
 * Walk the JPEG marker segments to the Start-Of-Frame (SOF0..SOF15, excluding
 * the non-frame markers) and read height/width. Bounds-checked at every hop so
 * a malformed stream simply yields null rather than reading past the buffer.
 */
function readJpegSize(buf: Buffer): { width: number | null; height: number | null } {
  let offset = 2; // skip the SOI (FF D8)
  const len = buf.length;

  while (offset + 1 < len) {
    // Every marker starts with 0xFF; skip any fill bytes.
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    let marker = buf[offset + 1];
    // Skip padding 0xFF bytes between markers.
    while (marker === 0xff && offset + 1 < len) {
      offset++;
      marker = buf[offset + 1];
    }
    offset += 2;

    // Standalone markers with no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= len) break;
    const segLen = buf.readUInt16BE(offset);
    if (segLen < 2) break; // malformed segment length

    // SOF markers carry the frame dimensions. Exclude DHT(c4)/DAC(cc)/RSTn.
    const isSOF =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      // Layout: [len(2)][precision(1)][height(2)][width(2)]...
      if (offset + 7 <= len) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        return { width, height };
      }
      return { width: null, height: null };
    }
    offset += segLen; // jump past this segment's payload
  }
  return { width: null, height: null };
}

/**
 * Read WebP dimensions across the three sub-formats:
 *   VP8  (lossy)     — dimensions at chunk offset, 14-bit each
 *   VP8L (lossless)  — 14-bit width/height packed after the 0x2f signature
 *   VP8X (extended)  — 24-bit width/height minus one
 */
function readWebpSize(buf: Buffer): { width: number | null; height: number | null } {
  // The FourCC of the first chunk starts at byte 12.
  const fourCC = buf.toString('ascii', 12, 16);

  if (fourCC === 'VP8 ') {
    // Lossy: after 3-byte frame tag + 3-byte start code (9d 01 2a), w/h are
    // 16-bit little-endian at offsets 26/28, masked to 14 bits.
    if (buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
  } else if (fourCC === 'VP8L') {
    // Lossless: byte 20 must be the 0x2f signature; 4 bytes of packed bits follow.
    if (buf.length >= 25 && buf[20] === 0x2f) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
  } else if (fourCC === 'VP8X') {
    // Extended: 24-bit (width-1)/(height-1) little-endian at offsets 24/27.
    if (buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height };
    }
  }
  return { width: null, height: null };
}
