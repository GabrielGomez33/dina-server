// File: test/vision/visionEdgeCases.ts
// ============================================================================
// DINA VISION — EDGE-CASE TEST HARNESS
// ============================================================================
// A dependency-light, hermetic harness for the PURE logic of the vision
// subsystem. It imports only leaf modules (no DB, Redis, Ollama, or network),
// so it runs fast and deterministically:
//
//   run:  npx ts-node test/vision/visionEdgeCases.ts   (or: npm run test:vision)
//
// Coverage focus — the security-critical + parsing logic that must never regress:
//   • imageProbe        — magic-byte format detection + header dimension reads
//   • imageGuard        — base64/data-URI decode, size caps, format allowlist,
//                         decompression-bomb (dimension/pixel) rejection
//   • sampleFrameIndices— uniform frame sampling math (video timeline coverage)
//   • structuredParser  — JSON extraction + ImageAnalysis coercion + fallbacks
//   • visionConfig      — disabled-by-default + clamping
//
// Model inference, DB persistence, and remote fetch are integration concerns
// covered by the manual runbook in vision/EDGE_CASES.md, not here.
// ============================================================================

import { probeImage, mimeForFormat } from '../../src/modules/vision/ingestion/imageProbe';
import {
  parseDataUri,
  decodeBase64Image,
  validateImageBuffer,
} from '../../src/modules/vision/security/imageGuard';
import { sampleFrameIndices, clampFrames } from '../../src/modules/vision/ingestion/videoIngestor';
import { detectMediaKind } from '../../src/modules/vision/ingestion/mediaKind';
import {
  unionStrings,
  aggregateOcr,
  meanConfidence,
} from '../../src/modules/vision/analysis/videoAggregation';
import {
  extractJsonObject,
  parseFullAnalysis,
  parseSingleTask,
} from '../../src/modules/vision/analysis/structuredParser';
import {
  __rebuildVisionConfigForTests,
  VisionRuntimeConfig,
} from '../../src/modules/vision/config/visionConfig';
import { VisionError, isVisionTask, isMediaKind } from '../../src/modules/vision/types';

// ----------------------------------------------------------------------------
// Tiny assertion framework (matches test/digim/webEdgeCases.ts conventions)
// ----------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`  ❌ ${name}`);
  }
}

function eq(actual: unknown, expected: unknown, name: string): void {
  ok(actual === expected, `${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

/** Assert that `fn` throws a VisionError with the given code. */
function throwsCode(fn: () => void, code: string, name: string): void {
  try {
    fn();
    ok(false, `${name} (expected throw ${code}, got none)`);
  } catch (err: any) {
    if (err instanceof VisionError && err.code === code) ok(true, name);
    else ok(false, `${name} (expected ${code}, got ${err?.code || err?.message})`);
  }
}

async function section(title: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▶ ${title}`);
  await fn();
}

// ----------------------------------------------------------------------------
// Minimal valid image byte buffers (crafted headers — enough for probing)
// ----------------------------------------------------------------------------

/** PNG with IHDR declaring width x height. */
function makePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  // signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length + type (not parsed for dims, but keep it well-formed)
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** JPEG with a single SOF0 frame declaring height x width. */
function makeJpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(11);
  buf.set([0xff, 0xd8], 0); // SOI
  buf.set([0xff, 0xc0], 2); // SOF0
  buf.writeUInt16BE(17, 4); // segment length
  buf.writeUInt8(8, 6); // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

/** GIF89a with logical screen width x height (little-endian). */
function makeGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** WebP (VP8X extended) declaring width x height (24-bit, minus one, LE). */
function makeWebpVP8X(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4); // file size (approx)
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16); // chunk size
  buf.writeUInt8(0, 20); // flags
  // reserved 24-bit + width-1 (24-bit LE at 24), height-1 (24-bit LE at 27)
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

/** BMP with BITMAPINFOHEADER width x height (signed 32-bit LE). */
function makeBmp(width: number, height: number): Buffer {
  const buf = Buffer.alloc(26);
  buf.write('BM', 0, 'ascii');
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** Build a guard config with the given overrides on top of an ENABLED base. */
function testConfig(overrides: Record<string, string> = {}): VisionRuntimeConfig {
  const env: Record<string, string> = { DINA_VISION_ENABLED: 'true', ...overrides };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  const cfg = __rebuildVisionConfigForTests();
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return cfg;
}

// ----------------------------------------------------------------------------
// TESTS
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== DINA Vision Edge-Case Harness ===');

  await section('imageProbe — format detection from magic bytes', () => {
    eq(probeImage(makePng(2, 3)).format, 'png', 'PNG detected');
    eq(probeImage(makeJpeg(2, 3)).format, 'jpeg', 'JPEG detected');
    eq(probeImage(makeGif(2, 3)).format, 'gif', 'GIF detected');
    eq(probeImage(makeWebpVP8X(2, 3)).format, 'webp', 'WebP detected');
    eq(probeImage(makeBmp(2, 3)).format, 'bmp', 'BMP detected');
    eq(probeImage(Buffer.from('<html>not an image</html>')).format, 'unknown', 'HTML → unknown');
    eq(probeImage(Buffer.from([0x00])).format, 'unknown', 'single byte → unknown');
    eq(probeImage(Buffer.alloc(0)).format, 'unknown', 'empty → unknown');
  });

  await section('imageProbe — dimension extraction', () => {
    const png = probeImage(makePng(640, 480));
    eq(png.width, 640, 'PNG width');
    eq(png.height, 480, 'PNG height');
    const jpg = probeImage(makeJpeg(1920, 1080));
    eq(jpg.width, 1920, 'JPEG width');
    eq(jpg.height, 1080, 'JPEG height');
    const gif = probeImage(makeGif(320, 240));
    eq(gif.width, 320, 'GIF width');
    eq(gif.height, 240, 'GIF height');
    const webp = probeImage(makeWebpVP8X(800, 600));
    eq(webp.width, 800, 'WebP VP8X width');
    eq(webp.height, 600, 'WebP VP8X height');
    const bmp = probeImage(makeBmp(100, 50));
    eq(bmp.width, 100, 'BMP width');
    eq(bmp.height, 50, 'BMP height');
  });

  await section('mimeForFormat', () => {
    eq(mimeForFormat('png'), 'image/png', 'png mime');
    eq(mimeForFormat('jpeg'), 'image/jpeg', 'jpeg mime');
    eq(mimeForFormat('unknown'), '', 'unknown → empty mime');
  });

  await section('imageGuard — parseDataUri', () => {
    const a = parseDataUri('data:image/png;base64,AAAA');
    eq(a.payload, 'AAAA', 'data URI payload extracted');
    eq(a.declaredMime, 'image/png', 'data URI mime extracted');
    const b = parseDataUri('QUJD');
    eq(b.payload, 'QUJD', 'bare base64 passes through');
    eq(b.declaredMime, null, 'bare base64 has no declared mime');
    throwsCode(() => parseDataUri('data:text/plain,hello'), 'INVALID_DATA_URI', 'non-base64 data URI rejected');
  });

  const cfg = testConfig();

  await section('imageGuard — decodeBase64Image', () => {
    const png64 = makePng(2, 2).toString('base64');
    ok(decodeBase64Image(png64, cfg).length > 0, 'valid base64 decodes');
    ok(decodeBase64Image('data:image/png;base64,' + png64, cfg).length > 0, 'data-URI base64 decodes');
    throwsCode(() => decodeBase64Image('', cfg), 'EMPTY_IMAGE', 'empty string rejected');
    throwsCode(() => decodeBase64Image('   ', cfg), 'EMPTY_IMAGE', 'whitespace rejected');
    throwsCode(() => decodeBase64Image('!!!not base64!!!', cfg), 'INVALID_BASE64', 'garbage rejected');
  });

  await section('imageGuard — size cap (pre-decode)', () => {
    const tiny = testConfig({ DINA_VISION_MAX_IMAGE_BYTES: '1024' });
    // ~2KB of base64 → ~1.5KB decoded → over the 1KB cap, rejected pre-decode.
    const big = 'A'.repeat(3000);
    throwsCode(() => decodeBase64Image(big, tiny), 'IMAGE_TOO_LARGE', 'oversize base64 rejected before decode');
  });

  await section('imageGuard — validateImageBuffer format enforcement', () => {
    ok(validateImageBuffer(makePng(4, 4), cfg).mimeType === 'image/png', 'valid PNG passes');
    throwsCode(() => validateImageBuffer(Buffer.from('<svg></svg>'), cfg), 'UNSUPPORTED_FORMAT', 'SVG/text rejected (not raster)');
    throwsCode(() => validateImageBuffer(Buffer.alloc(0), cfg), 'EMPTY_IMAGE', 'empty buffer rejected');
    const noBmp = testConfig({ DINA_VISION_ALLOWED_MIME: 'image/png,image/jpeg' });
    throwsCode(() => validateImageBuffer(makeBmp(4, 4), noBmp), 'FORMAT_NOT_ALLOWED', 'disallowed format rejected');
  });

  await section('imageGuard — decompression-bomb defence', () => {
    const capped = testConfig({
      DINA_VISION_MAX_IMAGE_DIMENSION: '1000',
      DINA_VISION_MAX_IMAGE_PIXELS: '500000',
    });
    // 5000x10 → dimension over 1000 → rejected on header alone (no decode).
    throwsCode(() => validateImageBuffer(makePng(5000, 10), capped), 'IMAGE_DIMENSION_EXCEEDED', 'oversize dimension rejected');
    // 900x900 = 810000 px > 500000 pixel cap, though each dim < 1000.
    throwsCode(() => validateImageBuffer(makePng(900, 900), capped), 'IMAGE_PIXELS_EXCEEDED', 'pixel-area bomb rejected');
    // Within both caps → OK.
    ok(!!validateImageBuffer(makePng(400, 400), capped), '400x400 within caps passes');
    // Non-positive dims.
    throwsCode(() => validateImageBuffer(makePng(0, 100), capped), 'INVALID_DIMENSIONS', 'zero dimension rejected');
  });

  await section('imageGuard — sha256 dedup key is stable + content-addressed', () => {
    const a = validateImageBuffer(makePng(8, 8), cfg);
    const b = validateImageBuffer(makePng(8, 8), cfg);
    const c = validateImageBuffer(makePng(9, 9), cfg);
    eq(a.sha256, b.sha256, 'identical bytes → identical hash');
    ok(a.sha256 !== c.sha256, 'different bytes → different hash');
    eq(a.sha256.length, 64, 'sha256 is 64 hex chars');
  });

  await section('sampleFrameIndices — uniform timeline coverage', () => {
    eq(JSON.stringify(sampleFrameIndices(10, 4)), JSON.stringify([0, 3, 6, 9]), '10→4 evenly spaced incl. ends');
    eq(JSON.stringify(sampleFrameIndices(3, 5)), JSON.stringify([0, 1, 2]), 'fewer items than cap → all');
    eq(JSON.stringify(sampleFrameIndices(1, 4)), JSON.stringify([0]), 'single item');
    eq(JSON.stringify(sampleFrameIndices(0, 4)), JSON.stringify([]), 'zero items → empty');
    eq(JSON.stringify(sampleFrameIndices(100, 1)), JSON.stringify([0]), 'cap 1 → first only');
    eq(JSON.stringify(sampleFrameIndices(5, 0)), JSON.stringify([]), 'cap 0 → empty');
    const big = sampleFrameIndices(1000, 12);
    eq(big.length, 12, '1000→12 yields 12 picks');
    eq(big[0], 0, 'first pick is 0');
    eq(big[big.length - 1], 999, 'last pick is final frame');
    // strictly increasing
    let inc = true;
    for (let i = 1; i < big.length; i++) if (big[i] <= big[i - 1]) inc = false;
    ok(inc, 'picks strictly increasing');
  });

  await section('structuredParser — extractJsonObject', () => {
    eq(extractJsonObject('{"a":1}'), '{"a":1}', 'bare object');
    eq(extractJsonObject('prose before {"a":1} prose after'), '{"a":1}', 'object embedded in prose');
    eq(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}', 'fenced json block');
    eq(extractJsonObject('{"a":{"b":2}}'), '{"a":{"b":2}}', 'nested object balanced');
    eq(extractJsonObject('{"s":"a}b"}'), '{"s":"a}b"}', 'brace inside string not miscounted');
    eq(extractJsonObject('no json here'), null, 'no object → null');
    eq(extractJsonObject('{"unbalanced": '), null, 'unbalanced → null');
  });

  await section('structuredParser — parseFullAnalysis', () => {
    const good = parseFullAnalysis(JSON.stringify({
      caption: 'A red bicycle leaning on a brick wall.',
      objects: ['bicycle', 'wall'],
      tags: ['outdoor', 'urban'],
      text: '',
      colors: [{ name: 'red', approxHex: 'ff0000' }],
      safety: 'safe',
    }));
    eq(good.caption, 'A red bicycle leaning on a brick wall.', 'caption parsed');
    eq(good.objects.length, 2, 'objects parsed');
    eq(good.colors[0].approxHex, '#ff0000', 'hex normalised with #');
    eq(good.safety, 'safe', 'safety parsed');
    ok(good.confidence > 0.5, 'confidence high for clean JSON');

    const messy = parseFullAnalysis('Sure! Here is the JSON:\n```json\n{"caption":"a cat","objects":"cat, sofa","tags":[],"safety":"weird"}\n```');
    eq(messy.caption, 'a cat', 'caption parsed from fenced+prose');
    eq(JSON.stringify(messy.objects), JSON.stringify(['cat', 'sofa']), 'string coerced to array');
    eq(messy.safety, 'unknown', 'invalid safety → unknown');

    const fallback = parseFullAnalysis('The image shows a mountain at sunset. No JSON at all here.');
    ok(fallback.caption.length > 0, 'non-JSON → whole text as caption');
    ok(fallback.confidence <= 0.6, 'fallback confidence lower');

    const empty = parseFullAnalysis('');
    eq(empty.caption, '', 'empty model text → empty caption (no throw)');
  });

  await section('structuredParser — parseSingleTask', () => {
    eq(parseSingleTask('caption', 'A dog runs.').caption, 'A dog runs.', 'caption task');
    const ocr = parseSingleTask('ocr', 'NO_TEXT');
    eq(ocr.text, '', 'OCR NO_TEXT → empty text');
    const ocr2 = parseSingleTask('ocr', 'STOP\nYIELD');
    eq(ocr2.text, 'STOP\nYIELD', 'OCR text preserved');
    const tags = parseSingleTask('tags', 'sky, tree, road');
    eq(tags.tags.length, 3, 'tags split');
    const vqa = parseSingleTask('vqa', 'Two people.', 'How many people?');
    eq(vqa.answer, 'Two people.', 'VQA answer captured');
    const objs = parseSingleTask('objects', 'car\ntree\nsign');
    eq(objs.objects.length, 3, 'objects split by lines');
  });

  await section('visionConfig — safe defaults + clamping', () => {
    // Fully unset env → disabled by default (the "no disruption" guarantee).
    const saved = process.env.DINA_VISION_ENABLED;
    delete process.env.DINA_VISION_ENABLED;
    const def = __rebuildVisionConfigForTests();
    eq(def.enabled, false, 'disabled by default');
    if (saved === undefined) delete process.env.DINA_VISION_ENABLED;
    else process.env.DINA_VISION_ENABLED = saved;

    const clamped = testConfig({ DINA_VISION_MAX_VIDEO_FRAMES: '99999', DINA_VISION_TEMPERATURE: '9.9' });
    ok(clamped.maxVideoFrames <= 120, 'maxVideoFrames clamped to ceiling');
    ok(clamped.temperature <= 2, 'temperature clamped to ceiling');

    const garbage = testConfig({ DINA_VISION_MAX_IMAGE_BYTES: 'not-a-number' });
    ok(garbage.maxImageBytes > 0, 'garbage int env → falls back to a sane default');
  });

  await section('task/kind guards — isVisionTask / isMediaKind', () => {
    for (const t of ['describe', 'caption', 'objects', 'ocr', 'tags', 'vqa', 'full']) {
      ok(isVisionTask(t), `valid task ${t}`);
    }
    ok(!isVisionTask('summarize'), 'unknown task rejected');
    ok(!isVisionTask(''), 'empty task rejected');
    ok(!isVisionTask(42), 'non-string task rejected');
    ok(isMediaKind('image') && isMediaKind('video') && isMediaKind('auto'), 'valid kinds accepted');
    ok(!isMediaKind('audio'), 'unknown kind rejected');
  });

  await section('detectMediaKind — explicit wins, else infer', () => {
    eq(detectMediaKind({ base64: 'x' }, 'video'), 'video', 'explicit video honoured even with image payload');
    eq(detectMediaKind({ frames: [{}] }, 'image'), 'image', 'explicit image honoured even with frames');
    eq(detectMediaKind({ base64: 'x' }, 'auto'), 'image', 'auto: base64 only → image');
    eq(detectMediaKind({ frames: [{ base64: 'a' }] }, 'auto'), 'video', 'auto: frames → video');
    eq(detectMediaKind({ frames: [] }, 'auto'), 'image', 'auto: empty frames → image');
    eq(detectMediaKind({ mimeType: 'video/mp4' }, 'auto'), 'video', 'auto: video mime → video');
    eq(detectMediaKind({ mimeType: 'image/png' }, 'auto'), 'image', 'auto: image mime → image');
    eq(detectMediaKind({ durationSec: 12 }, 'auto'), 'video', 'auto: duration → video');
    eq(detectMediaKind({}, 'auto'), 'image', 'auto: nothing → image (default)');
  });

  await section('clampFrames — per-call budget bounded by ceiling', () => {
    eq(clampFrames(5, 12), 5, 'within range kept');
    eq(clampFrames(100, 12), 12, 'above ceiling clamped down');
    eq(clampFrames(0, 12), 1, 'zero floored to 1');
    eq(clampFrames(-3, 12), 1, 'negative floored to 1');
    eq(clampFrames(undefined, 12), 12, 'unset → ceiling');
    eq(clampFrames(NaN, 12), 12, 'NaN → ceiling');
    eq(clampFrames(3.9, 12), 3, 'fractional floored');
  });

  await section('unionStrings — dedupe, order, cap', () => {
    eq(JSON.stringify(unionStrings(['a', 'b', 'a', 'B'])), JSON.stringify(['a', 'b']), 'case-insensitive dedupe, order-preserving');
    eq(JSON.stringify(unionStrings([' x ', 'x'])), JSON.stringify(['x']), 'trims + dedupes');
    eq(unionStrings(Array.from({ length: 100 }, (_, i) => `t${i}`), 5).length, 5, 'cap respected');
    eq(JSON.stringify(unionStrings([])), JSON.stringify([]), 'empty → empty');
  });

  await section('aggregateOcr — de-dupe text across frames + timeline', () => {
    const res = aggregateOcr([
      { timestampSec: 0, text: 'STOP' },
      { timestampSec: 1, text: '' },
      { timestampSec: 2, text: 'STOP\nYIELD' },
      { timestampSec: 3, text: 'yield' },
    ]);
    // "STOP" and "YIELD" each appear once despite repetition/case.
    eq(res.text, 'STOP\nYIELD', 'combined transcript de-duplicated case-insensitively');
    eq(res.timeline.length, 3, 'timeline has only the 3 frames with text');
    eq(res.timeline[0].timestampSec, 0, 'timeline keeps timestamps');
    const empty = aggregateOcr([{ timestampSec: 0, text: '' }, { timestampSec: 1, text: '   ' }]);
    eq(empty.text, '', 'no text → empty transcript');
    eq(empty.timeline.length, 0, 'no text → empty timeline');
  });

  await section('meanConfidence', () => {
    eq(meanConfidence([1, 0.5, 0]), 0.5, 'mean computed');
    eq(meanConfidence([]), 0, 'empty → 0');
    eq(meanConfidence([0.8, NaN, 0.6]), 0.7, 'non-finite ignored');
  });

  // --------------------------------------------------------------------------
  console.log(`\n${'='.repeat(44)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  • ${f}`);
    process.exit(1);
  }
  console.log('✅ All vision edge-case tests passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(1);
});
