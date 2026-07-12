// File: src/modules/vision/analysis/promptTemplates.ts
// ============================================================================
// VISION PROMPT TEMPLATES
// ============================================================================
// Task-specific prompts that steer a vision-language model toward STRUCTURED,
// auditable output. The 'full' task asks for a strict JSON object so we get
// caption + objects + tags + text + colours in one inference; the others are
// lighter single-purpose prompts. All prompts explicitly instruct the model to
// ground statements in what is visible and to say so when unsure — reducing
// confident hallucination, which is the main failure mode of VLMs.
// ============================================================================

import { VisionTask } from '../types';

export const VISION_SYSTEM_PROMPT =
  'You are DINA\'s visual perception system. You describe ONLY what is actually ' +
  'visible in the provided image. You never invent details that are not present. ' +
  'When something is ambiguous or unreadable, you say so plainly rather than ' +
  'guessing. You are concise, factual, and neutral.';

/** The strict-JSON schema we request for the 'full' task. */
const FULL_JSON_INSTRUCTION = `Analyse the image and respond with ONLY a JSON object (no prose, no markdown fences) of exactly this shape:
{
  "caption": "one or two factual sentences describing the scene",
  "objects": ["salient object or entity", "..."],
  "tags": ["short keyword", "..."],
  "text": "any text visible in the image, verbatim; empty string if none",
  "colors": [{"name": "colour name", "approxHex": "#rrggbb"}],
  "safety": "safe | sensitive | unknown"
}
Rules: keep arrays under 15 items; use [] when nothing applies; use "" for empty text; do not add keys.`;

export function buildPrompt(task: VisionTask, question?: string): string {
  switch (task) {
    case 'caption':
      return 'In one short, factual sentence, describe what this image shows.';
    case 'describe':
      return 'Describe this image in rich but factual detail: the setting, the main subjects, notable actions, and mood. Only state what is visible.';
    case 'objects':
      return 'List the salient objects, people, and entities visible in this image, one per line. Do not invent anything not visible.';
    case 'ocr':
      return 'Read and transcribe ALL text visible in this image, verbatim, preserving line breaks. If there is no legible text, reply exactly: NO_TEXT.';
    case 'tags':
      return 'Provide up to 15 short keyword tags that categorise this image, comma-separated. No sentences.';
    case 'vqa':
      return `Answer this question about the image factually and concisely, based only on what is visible. If the image does not contain enough information to answer, say so.\n\nQuestion: ${(question || '').trim()}`;
    case 'full':
    default:
      return FULL_JSON_INSTRUCTION;
  }
}

/** Prompt used to synthesise per-frame analyses of a video into one narrative. */
export function buildVideoSynthesisPrompt(frameDescriptions: string[]): string {
  const numbered = frameDescriptions.map((d, i) => `Frame ${i + 1}: ${d}`).join('\n');
  return (
    'These are ordered descriptions of frames sampled from a single video, ' +
    'earliest first. Write a concise narrative of what happens across the video ' +
    'as a whole: the setting, what changes between frames, and any notable events ' +
    'or motion. Then, on a new line starting with "TIMELINE:", give a short ' +
    'bulleted sequence of key moments. Base everything ONLY on the frame ' +
    'descriptions; do not invent details.\n\n' +
    numbered
  );
}

/**
 * Prompt used to synthesise per-frame answers to a question into ONE answer for
 * the whole video. Each frame was asked the same question independently; this
 * reconciles them across time.
 */
export function buildVideoAnswerPrompt(question: string, perFrameAnswers: string[]): string {
  const numbered = perFrameAnswers.map((a, i) => `Frame ${i + 1}: ${a}`).join('\n');
  return (
    `A question was asked about a video. Below are the answers derived from each ` +
    `sampled frame independently, earliest first. Reconcile them into ONE concise, ` +
    `factual answer for the whole video. If frames disagree, note what changes over ` +
    `time. Base the answer ONLY on the frame answers; do not invent details.\n\n` +
    `Question: ${question.trim()}\n\n${numbered}`
  );
}
