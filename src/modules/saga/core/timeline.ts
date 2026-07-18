// File: src/modules/saga/core/timeline.ts
// ============================================================================
// DINA SAGA — TIMELINE / SEQUENCE MODEL (pure structure + validation)
// ============================================================================
// The editor's spine. A Sequence is a non-linear edit (an EDL): ordered Clips on
// typed Tracks — one or more VIDEO tracks plus parallel AUDIO tracks (music,
// dialogue, sfx, ambience). Clips reference a *source* (a generation for video,
// an audio asset for sound) and carry timeline placement + trim, per-clip
// cinematography, transitions, and a per-segment sync mode (beat-synced vs free).
//
// This module is PURE: it holds the structure, VALIDATES it against every way it
// could be malformed (the "double-check detrimental states" layer), and RESOLVES
// a valid timeline into an ordered export render-plan. It renders nothing and
// touches no I/O — the export engine consumes the plan. Proven in
// tests/timelineTest.ts.
//
// Design stance: proxy editing. The timeline is built/edited with cheap draft
// clips; the expensive passes (upscale/detailer/filters) run only at export, and
// only on the clips that survive — this model is what makes that possible.
// ============================================================================

import { ShotDirection } from './cinematography';

export type TrackKind = 'video' | 'music' | 'dialogue' | 'sfx' | 'ambience';
export type SyncMode = 'beat-synced' | 'free';
export type TransitionKind = 'cut' | 'dissolve' | 'fade';

export interface Transition {
  kind: TransitionKind;
  durationS: number; // crossfade/fade length consumed at the boundary
}

/** A placed clip. `duration = out - in`; it occupies [start, start+duration) on the track. */
export interface Clip {
  id: string;
  sourceId: string; // generation id (video) or audio asset id
  sourceDurationS: number; // known length of the underlying source
  start: number; // timeline position (seconds)
  in: number; // trim in-point within the source (seconds)
  out: number; // trim out-point within the source (seconds)
  // video-only:
  cinematography?: ShotDirection;
  transition?: Transition; // transition INTO this clip (from the previous on the track)
  syncMode?: SyncMode;
  // audio-only:
  gain?: number; // linear, 1 = unity
}

export interface Track {
  id: string;
  kind: TrackKind;
  name?: string;
  clips: Clip[];
}

export interface Sequence {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
}

export class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

const VIDEO_KINDS: TrackKind[] = ['video'];
const AUDIO_KINDS: TrackKind[] = ['music', 'dialogue', 'sfx', 'ambience'];
const FPS_MIN = 8, FPS_MAX = 60;
const RES_MIN = 64, RES_MAX = 8192;
const GAIN_MAX = 4;
const EPS = 1e-6;

export function isVideoKind(k: TrackKind): boolean { return VIDEO_KINDS.includes(k); }
export function isAudioKind(k: TrackKind): boolean { return AUDIO_KINDS.includes(k); }

export function clipDuration(c: Clip): number { return c.out - c.in; }
export function clipEnd(c: Clip): number { return c.start + clipDuration(c); }

function finite(n: unknown): n is number { return typeof n === 'number' && Number.isFinite(n); }

/** Validate a single clip against its track kind; `prev` is the previous clip on
 *  the same track (for transition bounds). Throws TimelineError; pushes warnings. */
function validateClip(c: Clip, kind: TrackKind, prev: Clip | undefined, warnings: string[]): void {
  const where = `clip "${c.id}"`;
  if (!c.id) throw new TimelineError('a clip is missing an id');
  if (!c.sourceId) throw new TimelineError(`${where}: missing sourceId`);
  for (const [name, v] of [['start', c.start], ['in', c.in], ['out', c.out], ['sourceDurationS', c.sourceDurationS]] as const) {
    if (!finite(v)) throw new TimelineError(`${where}: ${name} must be a finite number`);
  }
  if (c.start < 0) throw new TimelineError(`${where}: start (${c.start}) is negative`);
  if (c.in < 0) throw new TimelineError(`${where}: in (${c.in}) is negative`);
  if (c.out <= c.in + EPS) throw new TimelineError(`${where}: out (${c.out}) must be greater than in (${c.in}) — zero/negative duration`);
  if (c.out > c.sourceDurationS + EPS) throw new TimelineError(`${where}: out (${c.out}) trims past the source length (${c.sourceDurationS})`);

  // Track-kind field enforcement — no smuggling the wrong fields onto a clip.
  if (isAudioKind(kind)) {
    if (c.cinematography) throw new TimelineError(`${where}: cinematography is not valid on an audio clip`);
    if (c.transition) throw new TimelineError(`${where}: transition is not valid on an audio clip`);
    if (c.syncMode) throw new TimelineError(`${where}: syncMode is not valid on an audio clip`);
    if (c.gain !== undefined && (!finite(c.gain) || c.gain < 0 || c.gain > GAIN_MAX)) {
      throw new TimelineError(`${where}: gain must be in [0, ${GAIN_MAX}]`);
    }
  } else {
    if (c.gain !== undefined) throw new TimelineError(`${where}: gain is not valid on a video clip`);
    if (c.transition) {
      const t = c.transition;
      if (!finite(t.durationS) || t.durationS < 0) throw new TimelineError(`${where}: transition.durationS must be >= 0`);
      if (t.durationS > clipDuration(c) + EPS) throw new TimelineError(`${where}: transition (${t.durationS}s) longer than the clip (${clipDuration(c)}s)`);
      if (!prev) warnings.push(`${where}: has a transition but is the first clip on its track — nothing to transition from (ignored)`);
      else if (t.durationS > clipDuration(prev) + EPS) throw new TimelineError(`${where}: transition (${t.durationS}s) longer than the previous clip (${clipDuration(prev)}s)`);
    }
  }
}

/**
 * Validate a whole sequence. Throws TimelineError on any hard violation; returns
 * non-fatal warnings (gaps/dead-air, beat-sync without music, empty sequence).
 */
export function validateSequence(seq: Sequence): string[] {
  const warnings: string[] = [];
  if (!seq.id || !seq.name) throw new TimelineError('sequence needs an id and a name');
  if (!finite(seq.fps) || seq.fps < FPS_MIN || seq.fps > FPS_MAX) throw new TimelineError(`fps must be in [${FPS_MIN}, ${FPS_MAX}]`);
  if (!finite(seq.width) || seq.width < RES_MIN || seq.width > RES_MAX) throw new TimelineError(`width out of range`);
  if (!finite(seq.height) || seq.height < RES_MIN || seq.height > RES_MAX) throw new TimelineError(`height out of range`);

  const seenClipIds = new Set<string>();
  const seenTrackIds = new Set<string>();
  let hasBeatSync = false;
  let hasMusicClips = false;
  let totalClips = 0;

  for (const track of seq.tracks) {
    if (!track.id) throw new TimelineError('a track is missing an id');
    if (seenTrackIds.has(track.id)) throw new TimelineError(`duplicate track id "${track.id}"`);
    seenTrackIds.add(track.id);
    if (![...VIDEO_KINDS, ...AUDIO_KINDS].includes(track.kind)) throw new TimelineError(`track "${track.id}": unknown kind "${track.kind}"`);

    // Clips must be time-ordered and non-overlapping WITHIN a track.
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    let prev: Clip | undefined;
    for (const c of sorted) {
      if (seenClipIds.has(c.id)) throw new TimelineError(`duplicate clip id "${c.id}"`);
      seenClipIds.add(c.id);
      validateClip(c, track.kind, prev, warnings);
      if (prev) {
        const gap = c.start - clipEnd(prev);
        if (gap < -EPS) throw new TimelineError(`track "${track.id}": clip "${c.id}" overlaps "${prev.id}" (starts ${(-gap).toFixed(3)}s before the previous ends)`);
        if (gap > EPS && isVideoKind(track.kind)) warnings.push(`track "${track.id}": ${gap.toFixed(2)}s gap (dead air / black) before clip "${c.id}"`);
      }
      if (c.syncMode === 'beat-synced') hasBeatSync = true;
      if (track.kind === 'music') hasMusicClips = true;
      prev = c;
      totalClips++;
    }
  }

  if (hasBeatSync && !hasMusicClips) warnings.push('a segment is beat-synced but there is no music track with clips to sync to');
  if (totalClips === 0) warnings.push('sequence has no clips');
  return warnings;
}

export function sequenceDuration(seq: Sequence): number {
  let max = 0;
  for (const t of seq.tracks) for (const c of t.clips) max = Math.max(max, clipEnd(c));
  return Math.round(max * 1000) / 1000;
}

// ---- export plan (the EDL the render engine walks) ---------------------------

export interface ExportVideoStep {
  clipId: string;
  sourceId: string;
  trackIndex: number;
  startOnTimeline: number;
  in: number;
  out: number;
  durationS: number;
  cinematography?: ShotDirection;
  transition?: Transition;
  syncMode: SyncMode; // resolved (defaults to 'free')
}

export interface ExportAudioClip {
  clipId: string;
  sourceId: string;
  start: number;
  in: number;
  out: number;
  durationS: number;
  gain: number; // resolved (defaults to 1)
}

export interface ExportAudioTrack {
  kind: TrackKind;
  trackIndex: number;
  clips: ExportAudioClip[];
}

export interface ExportPlan {
  sequenceId: string;
  fps: number;
  width: number;
  height: number;
  durationS: number;
  video: ExportVideoStep[]; // ordered by (trackIndex, start)
  audio: ExportAudioTrack[]; // one per audio track that has clips
  warnings: string[];
}

/**
 * Validate then resolve a sequence into an ordered export plan. Defaults are
 * materialized here (syncMode → 'free', gain → 1) so the render engine consumes
 * a fully-explicit plan and never has to guess.
 */
export function resolveExportPlan(seq: Sequence): ExportPlan {
  const warnings = validateSequence(seq);
  const video: ExportVideoStep[] = [];
  const audio: ExportAudioTrack[] = [];

  seq.tracks.forEach((track, trackIndex) => {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    if (isVideoKind(track.kind)) {
      for (const c of sorted) {
        video.push({
          clipId: c.id, sourceId: c.sourceId, trackIndex, startOnTimeline: c.start,
          in: c.in, out: c.out, durationS: clipDuration(c),
          cinematography: c.cinematography, transition: c.transition,
          syncMode: c.syncMode ?? 'free',
        });
      }
    } else if (sorted.length > 0) {
      audio.push({
        kind: track.kind, trackIndex,
        clips: sorted.map((c) => ({
          clipId: c.id, sourceId: c.sourceId, start: c.start, in: c.in, out: c.out,
          durationS: clipDuration(c), gain: c.gain ?? 1,
        })),
      });
    }
  });

  video.sort((a, b) => a.trackIndex - b.trackIndex || a.startOnTimeline - b.startOnTimeline);
  return { sequenceId: seq.id, fps: seq.fps, width: seq.width, height: seq.height, durationS: sequenceDuration(seq), video, audio, warnings };
}
