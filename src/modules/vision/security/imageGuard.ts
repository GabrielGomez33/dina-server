// File: src/modules/vision/security/imageGuard.ts
// ============================================================================
// IMAGE INPUT SECURITY GUARD
// ============================================================================
// The single choke point every image byte passes through before it can reach a
// model, the cache, or the database. It fails CLOSED: anything it cannot prove
// safe is rejected with a typed VisionError, never passed downstream.
//
// Threats handled here, each with an explicit test in the edge-case harness:
//   • Format spoofing        — trust MAGIC BYTES, not the caller's MIME/ext.
//   • Oversize payloads      — reject before allocating/decoding (byte cap).
//   • Decompression bombs    — reject on header-declared w*h / dimension caps,
//                              BEFORE any pixel decode is attempted.
//   • Malformed base64       — strict validation; reject garbage early.
//   • Data-URI smuggling     — parse/validate the data: envelope safely.
//   • Empty / truncated data — reject; never hand an empty buffer onward.
//   • Disallowed formats     — enforce the configured MIME allowlist.
// ============================================================================

import { createHash } from 'crypto';
import { getVisionConfig, VisionRuntimeConfig } from '../config/visionConfig';
import { probeImage, mimeForFormat } from '../ingestion/imageProbe';
import { NormalizedImage, VisionError } from '../types';

// A permissive-but-strict base64 shape check (standard + URL-safe alphabets,
// optional padding). We do a shape check first so obviously-bad input is
// rejected cheaply before Buffer.from silently coerces garbage.
const BASE64_RE = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** Strip a `data:<mime>;base64,` prefix if present; return the payload + declared mime. */
export function parseDataUri(input: string): { payload: string; declaredMime: string | null } {
  const trimmed = input.trim();
  const m = /^data:([a-z0-9.+/-]+)?(;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(trimmed);
  if (!m) return { payload: trimmed, declaredMime: null };
  const declaredMime = m[1] ? m[1].toLowerCase() : null;
  const isBase64 = !!m[3];
  const data = m[4] || '';
  if (!isBase64) {
    // A non-base64 data URI (percent-encoded / plain text) is not a real image
    // payload we accept — fail closed rather than guess.
    throw new VisionError('INVALID_DATA_URI', 'Only base64 data URIs are accepted for images', 400);
  }
  return { payload: data, declaredMime };
}

/**
 * Decode a caller-supplied base64/data-URI string into raw bytes, validating
 * shape and size along the way. Throws VisionError on any problem.
 */
export function decodeBase64Image(input: string, cfg: VisionRuntimeConfig = getVisionConfig()): Buffer {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new VisionError('EMPTY_IMAGE', 'Image payload is empty', 400);
  }

  const { payload } = parseDataUri(input);
  const cleaned = payload.replace(/\s+/g, ''); // tolerate wrapped/whitespace base64

  if (cleaned.length === 0) {
    throw new VisionError('EMPTY_IMAGE', 'Image payload is empty after decoding', 400);
  }
  if (!BASE64_RE.test(cleaned)) {
    throw new VisionError('INVALID_BASE64', 'Image payload is not valid base64', 400);
  }

  // Guard the ENCODED length first: base64 inflates bytes by ~4/3, so we can
  // reject an oversize payload without allocating the decoded buffer.
  const approxDecodedBytes = Math.floor((cleaned.length * 3) / 4);
  if (approxDecodedBytes > cfg.maxImageBytes) {
    throw new VisionError(
      'IMAGE_TOO_LARGE',
      `Image exceeds the ${cfg.maxImageBytes}-byte limit (~${approxDecodedBytes} bytes)`,
      413,
      { limit: cfg.maxImageBytes, approxBytes: approxDecodedBytes }
    );
  }

  // Normalize base64url (-_) to standard (+/) so URL-safe payloads decode
  // correctly rather than silently producing garbage. Standard base64 never
  // contains -/_ so this is a no-op for it.
  const standard = cleaned.replace(/-/g, '+').replace(/_/g, '/');

  const buf = Buffer.from(standard, 'base64');
  // Buffer.from is lenient; verify the round-trip length is plausible so we
  // don't accept a string that decoded to almost nothing.
  if (buf.length === 0) {
    throw new VisionError('INVALID_BASE64', 'Image payload decoded to zero bytes', 400);
  }
  return buf;
}

/**
 * Validate a raw image buffer and return the canonical NormalizedImage. This is
 * the function ingestion calls once it has bytes (from base64, a Buffer, or a
 * remote fetch). It performs magic-byte, allowlist, size, and bomb checks.
 */
export function validateImageBuffer(
  buf: Buffer,
  cfg: VisionRuntimeConfig = getVisionConfig()
): NormalizedImage {
  if (!buf || buf.length === 0) {
    throw new VisionError('EMPTY_IMAGE', 'Image buffer is empty', 400);
  }
  if (buf.length > cfg.maxImageBytes) {
    throw new VisionError(
      'IMAGE_TOO_LARGE',
      `Image exceeds the ${cfg.maxImageBytes}-byte limit (${buf.length} bytes)`,
      413,
      { limit: cfg.maxImageBytes, bytes: buf.length }
    );
  }

  // TRUST BYTES, NOT CLAIMS: derive the true format from the header.
  const probe = probeImage(buf);
  if (probe.format === 'unknown') {
    throw new VisionError(
      'UNSUPPORTED_FORMAT',
      'Image format not recognised from its content (expected JPEG/PNG/WebP/GIF/BMP)',
      415
    );
  }

  const mimeType = mimeForFormat(probe.format);
  if (!cfg.allowedImageMimeTypes.includes(mimeType)) {
    throw new VisionError(
      'FORMAT_NOT_ALLOWED',
      `Image format ${mimeType} is not in the allowed list`,
      415,
      { mimeType, allowed: cfg.allowedImageMimeTypes }
    );
  }

  // DECOMPRESSION-BOMB GUARD: reject on header-declared geometry BEFORE decode.
  // We can only enforce this when dimensions were probeable; formats where they
  // weren't still get the byte cap above.
  if (probe.width !== null && probe.height !== null) {
    if (probe.width <= 0 || probe.height <= 0) {
      throw new VisionError('INVALID_DIMENSIONS', 'Image reports non-positive dimensions', 400, {
        width: probe.width,
        height: probe.height,
      });
    }
    if (probe.width > cfg.maxImageDimension || probe.height > cfg.maxImageDimension) {
      throw new VisionError(
        'IMAGE_DIMENSION_EXCEEDED',
        `Image dimension ${probe.width}x${probe.height} exceeds the ${cfg.maxImageDimension}px limit`,
        413,
        { width: probe.width, height: probe.height, limit: cfg.maxImageDimension }
      );
    }
    const pixels = probe.width * probe.height;
    if (pixels > cfg.maxImagePixels) {
      throw new VisionError(
        'IMAGE_PIXELS_EXCEEDED',
        `Image area ${pixels}px exceeds the ${cfg.maxImagePixels}px limit (possible decompression bomb)`,
        413,
        { pixels, limit: cfg.maxImagePixels }
      );
    }
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');

  return {
    base64: buf.toString('base64'),
    mimeType,
    byteLength: buf.length,
    sha256,
    width: probe.width,
    height: probe.height,
  };
}
