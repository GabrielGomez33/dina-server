// File: src/modules/vision/analysis/structuredParser.ts
// ============================================================================
// STRUCTURED OUTPUT PARSER
// ============================================================================
// Vision-language models are asked for JSON but, being probabilistic, sometimes
// wrap it in prose, fence it in ```json, add a trailing comment, or drift the
// shape. This module turns messy model text into a well-typed ImageAnalysis
// with LAYERED FALLBACKS so a single sloppy generation never crashes a request:
//
//   1. Try to locate + JSON.parse a balanced {...} object.
//   2. Coerce every field to its expected type, dropping anything malformed.
//   3. If no JSON is found at all, fall back to treating the whole text as the
//      caption for single-purpose tasks — never throw on model output.
//
// It is pure (no I/O) and therefore unit-tested directly.
// ============================================================================

import { DetectedColor, ImageAnalysis, VisionTask } from '../types';

/** Extract the first balanced top-level JSON object substring, or null. */
export function extractJsonObject(text: string): string | null {
  if (!text) return null;
  // Prefer a fenced ```json block if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fence ? fence[1] : text;

  const start = haystack.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }
  return null; // unbalanced
}

function toStringArray(value: any, cap = 15): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''))
      .filter((v) => v.length > 0)
      .slice(0, cap);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    // Tolerate a comma/newline-delimited string in place of an array.
    return value
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, cap);
  }
  return [];
}

function toColors(value: any, cap = 15): DetectedColor[] {
  if (!Array.isArray(value)) return [];
  const out: DetectedColor[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ name: item.trim() });
    } else if (item && typeof item === 'object' && typeof item.name === 'string') {
      const c: DetectedColor = { name: item.name.trim() };
      if (typeof item.approxHex === 'string' && /^#?[0-9a-f]{3,8}$/i.test(item.approxHex.trim())) {
        const hex = item.approxHex.trim();
        c.approxHex = hex.startsWith('#') ? hex : `#${hex}`;
      }
      if (c.name) out.push(c);
    }
    if (out.length >= cap) break;
  }
  return out;
}

function toSafety(value: any): 'safe' | 'sensitive' | 'unknown' {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (v === 'safe' || v === 'sensitive') return v;
  return 'unknown';
}

/**
 * Heuristic confidence: a well-formed JSON with a substantive caption is high;
 * a bare fallback caption is lower. We never fabricate a precise-looking score.
 */
function estimateConfidence(parsedJson: boolean, caption: string): number {
  let c = parsedJson ? 0.75 : 0.5;
  if (caption && caption.length > 40) c += 0.1;
  if (!caption) c -= 0.3;
  return Math.max(0.1, Math.min(0.95, Number(c.toFixed(2))));
}

/**
 * Parse a model's raw text for the 'full' task into an ImageAnalysis.
 * Never throws — always returns a usable object.
 */
export function parseFullAnalysis(raw: string, task: VisionTask = 'full'): ImageAnalysis {
  const jsonStr = extractJsonObject(raw);
  let obj: any = null;
  if (jsonStr) {
    try {
      obj = JSON.parse(jsonStr);
    } catch {
      obj = null;
    }
  }

  if (obj && typeof obj === 'object') {
    const caption = typeof obj.caption === 'string' ? obj.caption.trim() : '';
    return {
      task,
      caption,
      objects: toStringArray(obj.objects),
      tags: toStringArray(obj.tags),
      text: typeof obj.text === 'string' ? obj.text.trim() : '',
      colors: toColors(obj.colors),
      safety: toSafety(obj.safety),
      confidence: estimateConfidence(true, caption),
      raw,
    };
  }

  // No parseable JSON — treat the whole response as a caption so the caller
  // still gets something usable instead of an error.
  const caption = (raw || '').trim().slice(0, 2000);
  return {
    task,
    caption,
    objects: [],
    tags: [],
    text: '',
    colors: [],
    safety: 'unknown',
    confidence: estimateConfidence(false, caption),
    raw,
  };
}

/** Build an ImageAnalysis for the single-purpose tasks from plain model text. */
export function parseSingleTask(task: VisionTask, raw: string, question?: string): ImageAnalysis {
  const text = (raw || '').trim();
  const base: ImageAnalysis = {
    task,
    caption: '',
    objects: [],
    tags: [],
    text: '',
    colors: [],
    safety: 'unknown',
    confidence: estimateConfidence(false, text),
    raw,
  };

  switch (task) {
    case 'caption':
    case 'describe':
      base.caption = text;
      break;
    case 'objects':
      base.objects = toStringArray(text, 30);
      base.caption = text.split('\n')[0]?.trim() || '';
      break;
    case 'tags':
      base.tags = toStringArray(text, 30);
      break;
    case 'ocr':
      base.text = /^\s*NO_TEXT\s*$/i.test(text) ? '' : text;
      base.caption = base.text ? 'Text detected in image.' : 'No legible text detected.';
      break;
    case 'vqa':
      base.caption = question ? `Q: ${question}` : '';
      base.answer = text;
      base.confidence = estimateConfidence(false, text);
      break;
    default:
      base.caption = text;
  }
  return base;
}
