// File: src/modules/vision/ingestion/imageIngestor.ts
// ============================================================================
// IMAGE INGESTOR
// ============================================================================
// Turns a caller's RawImageInput (base64 | raw bytes | remote URL) into a
// validated, canonical NormalizedImage. All the security decisions live in
// imageGuard; this file only routes the three input shapes into it, plus the
// SSRF-guarded remote fetch (which is OFF unless DINA_VISION_ALLOW_REMOTE=true).
//
// Reuse note: the remote-fetch path reuses DIGIM's battle-tested SSRF guard
// (assertUrlSafe) rather than duplicating that security-critical logic. It is a
// pure leaf module with no side effects; sharing one hardened implementation is
// the correct enterprise choice (duplicated SSRF code is a security anti-pattern).
// ============================================================================

import { getVisionConfig, VisionRuntimeConfig } from '../config/visionConfig';
import { assertUrlSafe } from '../../digim/web/security/urlGuard';
import { decodeBase64Image, validateImageBuffer } from '../security/imageGuard';
import { NormalizedImage, RawImageInput, VisionError } from '../types';

/**
 * Normalize a single image input. Exactly one of base64/bytes/url must be set.
 * Async because the remote-URL path performs a guarded fetch.
 */
export async function ingestImage(
  input: RawImageInput,
  cfg: VisionRuntimeConfig = getVisionConfig()
): Promise<NormalizedImage> {
  if (!input || typeof input !== 'object') {
    throw new VisionError('INVALID_INPUT', 'Image input must be an object', 400);
  }

  const provided = [input.base64, input.bytes, input.url].filter((v) => v != null).length;
  if (provided === 0) {
    throw new VisionError('NO_IMAGE_SOURCE', 'Provide exactly one of: base64, bytes, url', 400);
  }
  if (provided > 1) {
    throw new VisionError('AMBIGUOUS_IMAGE_SOURCE', 'Provide only one of: base64, bytes, url', 400);
  }

  // ---- base64 / data URI ----
  if (input.base64 != null) {
    const buf = decodeBase64Image(input.base64, cfg);
    return validateImageBuffer(buf, cfg);
  }

  // ---- raw bytes ----
  if (input.bytes != null) {
    const buf = toBuffer(input.bytes);
    return validateImageBuffer(buf, cfg);
  }

  // ---- remote URL (guarded, opt-in) ----
  const buf = await fetchRemoteImage(String(input.url), cfg);
  return validateImageBuffer(buf, cfg);
}

/** Coerce a Buffer | Uint8Array | ArrayBuffer-ish into a Buffer without copying when possible. */
export function toBuffer(bytes: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new VisionError('INVALID_BYTES', 'bytes must be a Buffer or Uint8Array', 400);
}

/**
 * Fetch a remote image with the SSRF guard applied and a hard byte cap enforced
 * while streaming (so a server that lies about Content-Length cannot blow the
 * cap). Only runs when allowRemote is enabled.
 */
async function fetchRemoteImage(rawUrl: string, cfg: VisionRuntimeConfig): Promise<Buffer> {
  if (!cfg.allowRemote) {
    throw new VisionError(
      'REMOTE_DISABLED',
      'Remote image fetching is disabled (set DINA_VISION_ALLOW_REMOTE=true to enable)',
      403
    );
  }

  // Throws UrlSafetyError on any private/loopback/link-local/metadata target,
  // bad scheme, embedded creds, or disallowed port.
  let safeUrl: URL;
  try {
    safeUrl = await assertUrlSafe(rawUrl);
  } catch (err: any) {
    throw new VisionError('UNSAFE_URL', `Image URL rejected by SSRF guard: ${err?.message || err}`, 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.remoteFetchTimeoutMs);
  try {
    const res = await fetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'error', // do NOT auto-follow: a redirect could dodge the guard
      signal: controller.signal,
      headers: { 'User-Agent': 'DINA-Vision/1.0', Accept: 'image/*' },
    });

    if (!res.ok) {
      throw new VisionError('REMOTE_FETCH_FAILED', `Remote image fetch returned HTTP ${res.status}`, 502, {
        status: res.status,
      });
    }

    // Early reject if the server declares an oversize body.
    const declaredLen = Number(res.headers.get('content-length') || '0');
    if (declaredLen && declaredLen > cfg.maxImageBytes) {
      throw new VisionError('IMAGE_TOO_LARGE', `Remote image declares ${declaredLen} bytes (> limit)`, 413);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > cfg.maxImageBytes) {
      throw new VisionError('IMAGE_TOO_LARGE', `Remote image is ${buf.length} bytes (> limit)`, 413);
    }
    return buf;
  } catch (err: any) {
    if (err instanceof VisionError) throw err;
    if (err?.name === 'AbortError') {
      throw new VisionError('REMOTE_TIMEOUT', `Remote image fetch timed out after ${cfg.remoteFetchTimeoutMs}ms`, 504);
    }
    throw new VisionError('REMOTE_FETCH_FAILED', `Remote image fetch failed: ${err?.message || err}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}
