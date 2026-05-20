/**
 * Synth Studio - A live polyphonic FM synthesizer with oscilloscope + FFT,
 * playable from the computer keyboard, painted into a real Windows window.
 *
 * Boots XAudio2 (via the single flat `XAudio2Create` export), builds a mastering
 * voice and a streaming PCM source voice, then continuously generates polyphonic
 * 2-operator FM synthesis (up to 8 simultaneous voices, each with an ADSR
 * envelope) into a ring of PCM chunks that are submitted via
 * `IXAudio2SourceVoice::SubmitSourceBuffer`. Every render tick checks
 * `IXAudio2SourceVoice::GetState` and tops up the queue.
 *
 * The visual front end is a borderless 1280x600 window registered via
 * `RegisterClassExW`, with a DWM Mica backdrop applied through
 * `DwmSetWindowAttribute(DWMWA_SYSTEMBACKDROP_TYPE)` and immersive dark mode.
 * `WM_KEYDOWN` / `WM_KEYUP` route through a `JSCallback` WndProc to trigger
 * note-on / note-off events, and a `WM_TIMER` ticking at ~60 Hz invalidates
 * the client area so the scope + spectrum redraw in lock-step with the audio.
 *
 * Rendering is fully GDI-Plus: a 32-bit ARGB DIB section is shared with a GDI
 * memory DC, and `GdipCreateFromHDC` binds a `Graphics` to that memory DC so
 * GDI-Plus draws directly into the DIB's pixel buffer. Each frame composites:
 *
 *   - Top half:  a glowing oscilloscope of the most recently mixed PCM
 *   - Bottom half: a Hann-windowed Cooley-Tukey radix-2 FFT magnitude spectrum
 *     (1024-point, 512 bins) rendered as a vertical bar graph
 *   - Right side: a piano-keyboard graphic with currently-held keys lit, plus
 *     a HUD showing the current preset, octave, FM modulation index, and the
 *     live polyphonic voice count.
 *
 * Once a frame is composed in the DIB, `BitBlt` copies it to the window's HDC
 * via SRCCOPY in a single transfer.
 *
 * Keyboard layout (the QWERTY rows act as the two visible octaves):
 *
 *   Lower octave:  Z S X D C V G B H N J M  -> C through B
 *   Upper octave:  Q 2 W 3 E R 5 T 6 Y 7 U  -> C through B
 *   Arrow keys:    Left / Right shift the octave up or down by 12 semitones
 *   - / +:         decrease / increase the FM modulation index
 *   Space:         cycle preset (Bell -> Brass -> Bass -> Bell -> ...)
 *   Escape:        close the window
 *
 * APIs demonstrated:
 *   - Xaudio2_9.XAudio2Create
 *   - IXAudio2::CreateMasteringVoice / CreateSourceVoice (COM vtable)
 *   - IXAudio2SourceVoice::SubmitSourceBuffer / Start / GetState / DestroyVoice
 *   - User32: RegisterClassExW, CreateWindowExW, DefWindowProcW, GetMessageW,
 *             TranslateMessage, DispatchMessageW, ShowWindow, UpdateWindow,
 *             SetTimer, KillTimer, InvalidateRect, PostQuitMessage,
 *             DestroyWindow, UnregisterClassW, GetSystemMetrics, GetDC,
 *             ReleaseDC, GetClientRect
 *   - GDI32:  CreateCompatibleDC, CreateDIBSection, SelectObject, BitBlt,
 *             DeleteObject, DeleteDC
 *   - GDI+:   GdiplusStartup / Shutdown, GdipCreateFromHDC, GdipDeleteGraphics,
 *             GdipSetSmoothingMode, GdipSetTextRenderingHint,
 *             GdipGraphicsClear, GdipCreateSolidFill, GdipDeleteBrush,
 *             GdipCreatePen1, GdipDeletePen, GdipFillRectangleI,
 *             GdipDrawRectangleI, GdipFillEllipseI, GdipDrawLineI,
 *             GdipDrawLines, GdipCreateFontFamilyFromName, GdipCreateFont,
 *             GdipCreateStringFormat, GdipDrawString, GdipDeleteFont,
 *             GdipDeleteFontFamily, GdipDeleteStringFormat
 *   - Dwmapi: DwmSetWindowAttribute (Mica + dark mode + corner preference)
 *   - Kernel32: GetModuleHandleW
 *
 * Run: bun run example/synth-studio.ts
 */

import { CFunction, FFIType, JSCallback, type Pointer, read } from 'bun:ffi';
import { Dwmapi, Gdiplus, GDI32, Kernel32, Ole32, User32, Xaudio2_9 } from '../index';
import { ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute, WindowCornerPreference } from '@bun-win32/dwmapi';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';
import { FontStyle, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';

Gdiplus.Preload();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 600;

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BITS = 16;
const BLOCK_ALIGN = (CHANNELS * BITS) / 8;
const FRAMES_PER_CHUNK = 1024;          // 1024 stereo frames per submitted buffer (~23 ms)
const CHUNK_BYTES = FRAMES_PER_CHUNK * BLOCK_ALIGN;
const RING_SIZE = 8;                    // ring of pre-allocated PCM buffers
const TARGET_QUEUED = 4;                // keep ~4 chunks queued ahead (~92 ms latency)

const FFT_SIZE = 1024;                  // must be a power of two; we render 512 bins
const FFT_BINS = FFT_SIZE / 2;

const MAX_VOICES = 8;
const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 16;            // ~60 fps

// IXAudio2 (IUnknown-derived) vtable slots from xaudio2.h.
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
// IXAudio2Voice base methods (shared by source + mastering voices).
const IXAUDIO2VOICE_DESTROYVOICE = 18;
// IXAudio2SourceVoice methods after the shared block.
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;

const AudioCategory_GameEffects = 6;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;

// Window messages we care about.
const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_PAINT = 0x000f;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_TIMER = 0x0113;
const WM_ERASEBKGND = 0x0014;

const SRCCOPY = 0x00cc0020;

// ---------------------------------------------------------------------------
// Encoding helpers + COM vtable invoker (cast-free, memoized).
// ---------------------------------------------------------------------------

const encodeWide = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invoke COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound `CFunction` is memoized per (method,
 * signature) so the hot loop submitting buffers stays cheap.
 */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

// ---------------------------------------------------------------------------
// Voice + preset model.
// ---------------------------------------------------------------------------

interface SynthPreset {
  name: string;
  modRatio: number;       // modulator : carrier frequency ratio
  modIndex: number;       // FM depth (overridable live with -/+)
  modDecay: number;       // exponential decay constant applied to the modulator
  attack: number;         // seconds
  decay: number;          // seconds
  sustain: number;        // 0..1 sustain level
  release: number;        // seconds
  amp: number;            // overall scale
}

const PRESETS: readonly SynthPreset[] = [
  { name: 'Bell',  modRatio: 3.5, modIndex: 5.0, modDecay: 3.5, attack: 0.005, decay: 0.30, sustain: 0.15, release: 0.45, amp: 0.55 },
  { name: 'Brass', modRatio: 1.0, modIndex: 3.5, modDecay: 0.6, attack: 0.04,  decay: 0.10, sustain: 0.70, release: 0.20, amp: 0.40 },
  { name: 'Bass',  modRatio: 0.5, modIndex: 2.2, modDecay: 1.4, attack: 0.003, decay: 0.05, sustain: 0.85, release: 0.18, amp: 0.65 },
];

interface Voice {
  active: boolean;
  releasing: boolean;
  midi: number;           // MIDI-style note number (60 = middle C)
  freq: number;
  phaseC: number;         // carrier phase accumulator (radians)
  phaseM: number;         // modulator phase accumulator
  ageSamples: number;     // total samples since note-on (drives ADSR + modDecay)
  releaseStart: number;   // age at the moment WM_KEYUP fired
  envAtRelease: number;   // envelope value captured at release for clean tail
}

const voices: Voice[] = Array.from({ length: MAX_VOICES }, () => ({
  active: false, releasing: false, midi: 0, freq: 0,
  phaseC: 0, phaseM: 0, ageSamples: 0, releaseStart: 0, envAtRelease: 0,
}));

// Track currently-held keys (by virtual-key code) so we can highlight them.
const heldKeys = new Set<number>();

// ---------------------------------------------------------------------------
// Keyboard mapping.
// ---------------------------------------------------------------------------

/**
 * Map a Windows virtual-key code to a semitone offset from C of the current
 * octave. Lower row (Z..M with sharps on S D G H J) covers the lower octave;
 * upper row (Q..U with sharps on 2 3 5 6 7) covers the octave above.
 */
function vkToSemitone(vk: number): number | null {
  switch (vk) {
    // Lower octave (Z S X D C V G B H N J M)
    case 0x5A: return 0;   // Z -> C
    case 0x53: return 1;   // S -> C#
    case 0x58: return 2;   // X -> D
    case 0x44: return 3;   // D -> D#
    case 0x43: return 4;   // C -> E
    case 0x56: return 5;   // V -> F
    case 0x47: return 6;   // G -> F#
    case 0x42: return 7;   // B -> G
    case 0x48: return 8;   // H -> G#
    case 0x4E: return 9;   // N -> A
    case 0x4A: return 10;  // J -> A#
    case 0x4D: return 11;  // M -> B
    // Upper octave (Q 2 W 3 E R 5 T 6 Y 7 U)
    case 0x51: return 12;  // Q -> C
    case 0x32: return 13;  // 2 -> C#
    case 0x57: return 14;  // W -> D
    case 0x33: return 15;  // 3 -> D#
    case 0x45: return 16;  // E -> E
    case 0x52: return 17;  // R -> F
    case 0x35: return 18;  // 5 -> F#
    case 0x54: return 19;  // T -> G
    case 0x36: return 20;  // 6 -> G#
    case 0x59: return 21;  // Y -> A
    case 0x37: return 22;  // 7 -> A#
    case 0x55: return 23;  // U -> B
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Synth engine state.
// ---------------------------------------------------------------------------

let currentPreset = 0;
let octave = 4;                  // middle octave; C4 = MIDI 60
let modIndexBias = 0;            // live offset from preset.modIndex applied via -/+

/** Convert MIDI note number -> Hz (A4 = 440). */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noteOn(midi: number): void {
  // If this note is already alive (held + retriggered without release in between),
  // reuse its slot so we don't double-stack the same pitch.
  let slot = voices.findIndex((v) => v.active && v.midi === midi && !v.releasing);
  if (slot === -1) {
    slot = voices.findIndex((v) => !v.active);
  }
  if (slot === -1) {
    // Steal the oldest releasing voice, or oldest active if none releasing.
    let bestAge = -1;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i]!;
      if (v.releasing && v.ageSamples > bestAge) {
        bestAge = v.ageSamples;
        slot = i;
      }
    }
    if (slot === -1) {
      bestAge = -1;
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i]!;
        if (v.ageSamples > bestAge) {
          bestAge = v.ageSamples;
          slot = i;
        }
      }
    }
  }
  const v = voices[slot]!;
  v.active = true;
  v.releasing = false;
  v.midi = midi;
  v.freq = midiToFreq(midi);
  v.phaseC = 0;
  v.phaseM = 0;
  v.ageSamples = 0;
  v.releaseStart = 0;
  v.envAtRelease = 0;
}

function noteOff(midi: number): void {
  for (const v of voices) {
    if (v.active && !v.releasing && v.midi === midi) {
      v.releasing = true;
      v.releaseStart = v.ageSamples;
      // Capture the current envelope value so release tails away from it.
      v.envAtRelease = computeEnvelopeAt(v, v.ageSamples / SAMPLE_RATE);
    }
  }
}

/** Pre-release ADS curve (attack -> decay -> sustain), as a function of seconds since note-on. */
function computeEnvelopeAt(_v: Voice, ageSeconds: number): number {
  const p = PRESETS[currentPreset]!;
  if (ageSeconds < p.attack) return ageSeconds / p.attack;
  if (ageSeconds < p.attack + p.decay) {
    const t = (ageSeconds - p.attack) / p.decay;
    return 1 - (1 - p.sustain) * t;
  }
  return p.sustain;
}

// ---------------------------------------------------------------------------
// XAudio2 bootstrap.
// ---------------------------------------------------------------------------

// XAudio2 is a COM-backed engine; initialize the apartment first.
Ole32.CoInitialize(null);

const ppXAudio2 = Buffer.alloc(8);
const createHr = Xaudio2_9.XAudio2Create(ppXAudio2.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createHr !== S_OK) {
  console.error(`XAudio2Create failed: 0x${(createHr >>> 0).toString(16)}`);
  process.exit(1);
}
const engine = ppXAudio2.readBigUInt64LE(0);

const ppMaster = Buffer.alloc(8);
const masterHr = vcall(
  engine,
  IXAUDIO2_CREATEMASTERINGVOICE,
  [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
  [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects],
);
if (masterHr !== S_OK) {
  console.error(`CreateMasteringVoice failed: 0x${(masterHr >>> 0).toString(16)}`);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  process.exit(1);
}
const master = ppMaster.readBigUInt64LE(0);

// WAVEFORMATEX (18 bytes; cbSize = 0 for PCM).
const wfx = Buffer.alloc(18);
wfx.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
wfx.writeUInt16LE(CHANNELS, 2);
wfx.writeUInt32LE(SAMPLE_RATE, 4);
wfx.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 8);
wfx.writeUInt16LE(BLOCK_ALIGN, 12);
wfx.writeUInt16LE(BITS, 14);
wfx.writeUInt16LE(0, 16);

const ppSource = Buffer.alloc(8);
const srcHr = vcall(
  engine,
  IXAUDIO2_CREATESOURCEVOICE,
  [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  [ppSource.ptr!, wfx.ptr!, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null],
);
if (srcHr !== S_OK) {
  console.error(`CreateSourceVoice failed: 0x${(srcHr >>> 0).toString(16)}`);
  vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  process.exit(1);
}
const source = ppSource.readBigUInt64LE(0);

// Pre-allocate a ring of PCM chunk buffers plus the XAUDIO2_BUFFER descriptors.
// Each XAUDIO2_BUFFER references its chunk via a stable pointer that lives for
// the entire run, so the source voice can DMA from any of them at any time.
const chunkBuffers: Buffer[] = Array.from({ length: RING_SIZE }, () => Buffer.alloc(CHUNK_BYTES));
const xaudioBufferDescriptors: Buffer[] = chunkBuffers.map((pcm) => {
  const desc = Buffer.alloc(48); // XAUDIO2_BUFFER on x64
  desc.writeUInt32LE(0, 0);                       // Flags = 0 (no end-of-stream; we're streaming forever)
  desc.writeUInt32LE(pcm.length, 4);              // AudioBytes
  desc.writeBigUInt64LE(BigInt(pcm.ptr!), 8);     // pAudioData (stable lifetime)
  // PlayBegin/Length/LoopBegin/Length/LoopCount/pContext are zero.
  return desc;
});
let nextChunkIndex = 0;

// Voice-state probe buffer reused every frame.
const voiceState = Buffer.alloc(24); // XAUDIO2_VOICE_STATE: pContext@0, BuffersQueued@8, SamplesPlayed@16

// ---------------------------------------------------------------------------
// Audio render: mix all active voices into the next ring chunk and submit it.
// ---------------------------------------------------------------------------

/** Hold the latest mixed stereo float frames so the GUI can scope+FFT them. */
const scopeBuffer = new Float32Array(FFT_SIZE);
let scopeWritePos = 0;
/** Atomic-ish counter increased every time a new chunk is generated. */
let chunksGenerated = 0;

function renderAudioChunk(): void {
  const idx = nextChunkIndex;
  nextChunkIndex = (nextChunkIndex + 1) % RING_SIZE;
  const pcm = chunkBuffers[idx]!;
  const desc = xaudioBufferDescriptors[idx]!;

  const p = PRESETS[currentPreset]!;
  const dt = 1 / SAMPLE_RATE;
  const TWO_PI = Math.PI * 2;

  for (let frame = 0; frame < FRAMES_PER_CHUNK; frame++) {
    let sample = 0;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i]!;
      if (!v.active) continue;

      const ageSec = v.ageSamples / SAMPLE_RATE;
      // ADSR: attack, decay -> sustain pre-release; release subtracts from envAtRelease post-release.
      let env: number;
      if (v.releasing) {
        const t = (v.ageSamples - v.releaseStart) / SAMPLE_RATE;
        env = v.envAtRelease * Math.max(0, 1 - t / p.release);
        if (env <= 0) {
          v.active = false;
          v.releasing = false;
          v.ageSamples += 1;
          continue;
        }
      } else {
        env = computeEnvelopeAt(v, ageSec);
      }

      // 2-operator FM: phaseC accumulates carrier, phaseM accumulates modulator.
      // The modulation index itself decays over time so timbres brighten then mellow.
      const modEnv = Math.exp(-p.modDecay * ageSec);
      const modAmp = Math.max(0, p.modIndex + modIndexBias);
      v.phaseM += TWO_PI * v.freq * p.modRatio * dt;
      if (v.phaseM > TWO_PI) v.phaseM -= TWO_PI;
      const mod = Math.sin(v.phaseM) * modAmp * modEnv;
      v.phaseC += TWO_PI * v.freq * dt;
      if (v.phaseC > TWO_PI) v.phaseC -= TWO_PI;

      sample += Math.sin(v.phaseC + mod) * env * p.amp;
      v.ageSamples += 1;
    }

    // Soft tanh saturation so multi-voice stacks don't clip ugly.
    const mixed = Math.tanh(sample * 0.6) * 0.95;
    const intSample = Math.max(-32768, Math.min(32767, Math.round(mixed * 32767)));

    // Stereo: same sample to both channels (could pan per-voice later).
    pcm.writeInt16LE(intSample, frame * BLOCK_ALIGN);
    pcm.writeInt16LE(intSample, frame * BLOCK_ALIGN + 2);

    // Feed the visualization ring (mono).
    scopeBuffer[scopeWritePos] = mixed;
    scopeWritePos = (scopeWritePos + 1) % FFT_SIZE;
  }

  vcall(source, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [desc.ptr!, null]);
  chunksGenerated += 1;
}

/** Top up the queue until at least TARGET_QUEUED buffers are pending. */
function pumpAudio(): void {
  vcall(source, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [voiceState.ptr!, 0], FFIType.void);
  let queued = voiceState.readUInt32LE(8);
  while (queued < TARGET_QUEUED) {
    renderAudioChunk();
    queued += 1;
  }
}

// Prime the queue with TARGET_QUEUED chunks of silence/initial mix and start playback.
for (let i = 0; i < TARGET_QUEUED; i++) renderAudioChunk();
vcall(source, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);

// ---------------------------------------------------------------------------
// FFT (Cooley-Tukey radix-2, in-place, no recursion).
// ---------------------------------------------------------------------------

const fftReal = new Float64Array(FFT_SIZE);
const fftImag = new Float64Array(FFT_SIZE);
const fftMag = new Float32Array(FFT_BINS);
const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

function fftRadix2(): void {
  // Pull the most recent FFT_SIZE samples from scopeBuffer in order.
  for (let i = 0; i < FFT_SIZE; i++) {
    const idx = (scopeWritePos + i) % FFT_SIZE;
    fftReal[i] = scopeBuffer[idx]! * hannWindow[i]!;
    fftImag[i] = 0;
  }
  // Bit-reverse permutation.
  const n = FFT_SIZE;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [fftReal[i], fftReal[j]] = [fftReal[j]!, fftReal[i]!];
      [fftImag[i], fftImag[j]] = [fftImag[j]!, fftImag[i]!];
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const angleStep = (-2 * Math.PI) / len;
    const halfLen = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < halfLen; k++) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const ar = fftReal[i + k]!;
        const ai = fftImag[i + k]!;
        const br = fftReal[i + k + halfLen]!;
        const bi = fftImag[i + k + halfLen]!;
        const tr = wr * br - wi * bi;
        const ti = wr * bi + wi * br;
        fftReal[i + k] = ar + tr;
        fftImag[i + k] = ai + ti;
        fftReal[i + k + halfLen] = ar - tr;
        fftImag[i + k + halfLen] = ai - ti;
      }
    }
  }
  // Magnitudes, normalized into a perceptual log scale for nicer bars.
  const norm = 2 / FFT_SIZE;
  for (let i = 0; i < FFT_BINS; i++) {
    const mag = Math.sqrt(fftReal[i]! * fftReal[i]! + fftImag[i]! * fftImag[i]!) * norm;
    fftMag[i] = Math.min(1, Math.log10(1 + mag * 12) * 0.65);
  }
}

// ---------------------------------------------------------------------------
// Window + DIB section + GDI+ rendering.
// ---------------------------------------------------------------------------

const hInstance = Kernel32.GetModuleHandleW(null!);
const className = encodeWide('BunWin32SynthStudio');
const titleBar = encodeWide('Synth Studio - @bun-win32/all');

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER) {
      pumpAudio();
      User32.InvalidateRect(hWnd, null!, 0);
      return 0n;
    }
    if (msg === WM_PAINT) {
      paint(hWnd);
      return 0n;
    }
    if (msg === WM_ERASEBKGND) {
      // We paint the whole client area each frame; skip the default erase
      // to avoid flicker.
      return 1n;
    }
    if (msg === WM_KEYDOWN) {
      handleKeyDown(Number(wParam));
      return 0n;
    }
    if (msg === WM_KEYUP) {
      handleKeyUp(Number(wParam));
      return 0n;
    }
    if (msg === WM_CLOSE) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_DESTROY) {
      User32.PostQuitMessage(0);
      return 0n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

// Register a custom WNDCLASSEXW so we own the WndProc and the class is
// guaranteed to redraw via our painter (no system background brush, no flicker).
const wndClass = Buffer.alloc(80);
const wndClassView = new DataView(wndClass.buffer);
wndClassView.setUint32(0, 80, true);                    // cbSize
wndClassView.setUint32(4, 0x0002 | 0x0001, true);       // style = CS_HREDRAW | CS_VREDRAW
wndClass.writeBigUInt64LE(BigInt(wndProc.ptr!), 8);     // lpfnWndProc
wndClassView.setInt32(16, 0, true);                     // cbClsExtra
wndClassView.setInt32(20, 0, true);                     // cbWndExtra
wndClass.writeBigUInt64LE(BigInt(hInstance), 24);       // hInstance
wndClass.writeBigUInt64LE(0n, 32);                      // hIcon
wndClass.writeBigUInt64LE(0n, 40);                      // hCursor (default arrow is fine via NULL)
wndClass.writeBigUInt64LE(0n, 48);                      // hbrBackground -- NULL so WM_ERASEBKGND is ours
wndClass.writeBigUInt64LE(0n, 56);                      // lpszMenuName
wndClass.writeBigUInt64LE(BigInt(className.ptr!), 64);  // lpszClassName
wndClass.writeBigUInt64LE(0n, 72);                      // hIconSm

const classAtom = User32.RegisterClassExW(wndClass.ptr!);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

// Centre on the primary monitor.
const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const winX = Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2));
const winY = Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2));

const hwnd = User32.CreateWindowExW(
  0,
  className.ptr!,
  titleBar.ptr!,
  WindowStyles.WS_OVERLAPPEDWINDOW | WindowStyles.WS_CLIPCHILDREN | WindowStyles.WS_CLIPSIBLINGS,
  winX,
  winY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  0n,
  0n,
  hInstance,
  null,
);
if (!hwnd) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// DWM Mica + immersive dark mode + rounded corners. Each attribute is a single
// BOOL/UINT, so we pass a 4-byte buffer containing the desired value.
const dwmIntBuffer = Buffer.alloc(4);
dwmIntBuffer.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmIntBuffer.ptr!, 4);
dwmIntBuffer.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0); // Mica
Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, dwmIntBuffer.ptr!, 4);
dwmIntBuffer.writeInt32LE(WindowCornerPreference.DWMWCP_ROUND, 0);
Dwmapi.DwmSetWindowAttribute(hwnd, WindowAttribute.DWMWA_WINDOW_CORNER_PREFERENCE, dwmIntBuffer.ptr!, 4);

// -- DIB section + memory DC + GDI+ Graphics that draws into the DIB pixels --

const screenDC = User32.GetDC(0n);
const memoryDC = GDI32.CreateCompatibleDC(screenDC);
User32.ReleaseDC(0n, screenDC);

// BITMAPINFOHEADER for a 32-bit top-down ARGB DIB.
const bmi = Buffer.alloc(40);
bmi.writeUInt32LE(40, 0);                       // biSize
bmi.writeInt32LE(WINDOW_WIDTH, 4);              // biWidth
bmi.writeInt32LE(-WINDOW_HEIGHT, 8);            // biHeight negative -> top-down
bmi.writeUInt16LE(1, 12);                       // biPlanes
bmi.writeUInt16LE(32, 14);                      // biBitCount
bmi.writeUInt32LE(0, 16);                       // biCompression = BI_RGB
// biSizeImage..biClrImportant remain zero.

const bitsPtrBuffer = Buffer.alloc(8);
const dibBitmap = GDI32.CreateDIBSection(memoryDC, bmi.ptr!, 0, bitsPtrBuffer.ptr!, 0n, 0);
if (!dibBitmap) {
  console.error('CreateDIBSection failed');
  process.exit(1);
}
const oldBitmap = GDI32.SelectObject(memoryDC, dibBitmap);

// Bind GDI+ to the memory DC so GdipFillRectangle etc. write into the DIB.
const tokenBuffer = Buffer.alloc(8);
const startupInput = Buffer.alloc(16);
startupInput.writeUInt32LE(1, 0); // GdiplusVersion
const startupHr = Gdiplus.GdiplusStartup(tokenBuffer.ptr!, startupInput.ptr!, null);
if (startupHr !== Status.Ok) {
  console.error(`GdiplusStartup failed: ${startupHr}`);
  process.exit(1);
}
const gdipToken = tokenBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
const fromHdcHr = Gdiplus.GdipCreateFromHDC(memoryDC, graphicsHandleBuffer.ptr!);
if (fromHdcHr !== Status.Ok) {
  console.error(`GdipCreateFromHDC failed: ${fromHdcHr}`);
  process.exit(1);
}
const graphics = graphicsHandleBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias);
Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

// Cache the font family + a few fonts at different sizes.
const fontFamilyHandle = Buffer.alloc(8);
const fontNameBuffer = encodeWide('Segoe UI');
Gdiplus.GdipCreateFontFamilyFromName(fontNameBuffer.ptr!, 0n, fontFamilyHandle.ptr!);
const fontFamily = fontFamilyHandle.readBigUInt64LE(0);

function makeFont(size: number, style: number): bigint {
  const h = Buffer.alloc(8);
  Gdiplus.GdipCreateFont(fontFamily, size, style, Unit.UnitPixel, h.ptr!);
  return h.readBigUInt64LE(0);
}
const fontTitle = makeFont(22, FontStyle.FontStyleBold);
const fontLabel = makeFont(14, FontStyle.FontStyleRegular);
const fontKey = makeFont(11, FontStyle.FontStyleRegular);
const fontBig = makeFont(34, FontStyle.FontStyleBold);

const stringFormatHandle = Buffer.alloc(8);
Gdiplus.GdipCreateStringFormat(0, 0, stringFormatHandle.ptr!);
const stringFormat = stringFormatHandle.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(stringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(stringFormat, StringAlignment.StringAlignmentNear);

// Helper to make+dispose brushes inline.
function withSolidBrush<T>(color: number, fn: (brush: bigint) => T): T {
  const h = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, h.ptr!);
  const brush = h.readBigUInt64LE(0);
  try {
    return fn(brush);
  } finally {
    Gdiplus.GdipDeleteBrush(brush);
  }
}

function withPen<T>(color: number, width: number, fn: (pen: bigint) => T): T {
  const h = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, h.ptr!);
  const pen = h.readBigUInt64LE(0);
  try {
    return fn(pen);
  } finally {
    Gdiplus.GdipDeletePen(pen);
  }
}

function drawText(text: string, x: number, y: number, font: bigint, color: number): void {
  const buf = encodeWide(text);
  const rect = Buffer.alloc(16);
  rect.writeFloatLE(x, 0);
  rect.writeFloatLE(y, 4);
  rect.writeFloatLE(WINDOW_WIDTH, 8);
  rect.writeFloatLE(60, 12);
  withSolidBrush(color, (brush) => {
    Gdiplus.GdipDrawString(graphics, buf.ptr!, -1, font, rect.ptr!, stringFormat, brush);
  });
}

// ---------------------------------------------------------------------------
// Paint a single frame.
// ---------------------------------------------------------------------------

// Layout: oscilloscope on the left top half, FFT on the left bottom half,
// keyboard graphic + HUD on the right column.
const RIGHT_PANEL_X = 880;
const RIGHT_PANEL_W = WINDOW_WIDTH - RIGHT_PANEL_X - 16;
const SCOPE_X = 16;
const SCOPE_Y = 16;
const SCOPE_W = RIGHT_PANEL_X - SCOPE_X - 16;
const SCOPE_H = 240;
const FFT_X = SCOPE_X;
const FFT_Y = SCOPE_Y + SCOPE_H + 16;
const FFT_W = SCOPE_W;
const FFT_H = WINDOW_HEIGHT - FFT_Y - 16;

function paintFrame(): void {
  // The Mica backdrop shows through when we leave the DIB transparent. Since
  // GDI+ DrawString and friends don't compose into an HDC-backed Graphics with
  // pre-multiplied alpha, we fill with a dark semi-translucent panel colour and
  // accept an opaque panel over the Mica.
  Gdiplus.GdipGraphicsClear(graphics, argb(255, 18, 18, 28));

  // ---------- Title bar strip ----------
  withSolidBrush(argb(255, 28, 28, 44), (brush) => {
    Gdiplus.GdipFillRectangleI(graphics, brush, 0, 0, WINDOW_WIDTH, 8);
  });

  // ---------- Oscilloscope ----------
  withSolidBrush(argb(255, 12, 14, 22), (brush) => {
    Gdiplus.GdipFillRectangleI(graphics, brush, SCOPE_X, SCOPE_Y, SCOPE_W, SCOPE_H);
  });
  withPen(argb(255, 64, 80, 120), 1, (pen) => {
    Gdiplus.GdipDrawRectangleI(graphics, pen, SCOPE_X, SCOPE_Y, SCOPE_W - 1, SCOPE_H - 1);
    // Zero-line.
    const midY = SCOPE_Y + (SCOPE_H >> 1);
    Gdiplus.GdipDrawLineI(graphics, pen, SCOPE_X + 1, midY, SCOPE_X + SCOPE_W - 2, midY);
  });

  // Trace -- compute scope-window sample for each X column.
  const scopePts: number[] = [];
  for (let x = 0; x < SCOPE_W; x++) {
    const sIdx = Math.floor((x / SCOPE_W) * FFT_SIZE);
    const ringIdx = (scopeWritePos + sIdx) % FFT_SIZE;
    const v = scopeBuffer[ringIdx]!;
    const py = SCOPE_Y + SCOPE_H / 2 - v * (SCOPE_H / 2 - 6);
    scopePts.push(SCOPE_X + x, py);
  }
  drawPolyline(scopePts, argb(255, 80, 230, 160), 2);
  // Glow halo: draw the line again at lower alpha + wider stroke for cheap bloom.
  drawPolyline(scopePts, argb(70, 80, 230, 160), 5);

  drawText('Oscilloscope', SCOPE_X + 8, SCOPE_Y + 6, fontLabel, argb(255, 180, 200, 240));

  // ---------- FFT spectrum ----------
  withSolidBrush(argb(255, 12, 14, 22), (brush) => {
    Gdiplus.GdipFillRectangleI(graphics, brush, FFT_X, FFT_Y, FFT_W, FFT_H);
  });
  withPen(argb(255, 64, 80, 120), 1, (pen) => {
    Gdiplus.GdipDrawRectangleI(graphics, pen, FFT_X, FFT_Y, FFT_W - 1, FFT_H - 1);
  });

  fftRadix2();
  // Draw bars across the first ~half of bins (above that is mostly noise for
  // a typical 44.1k sample rate at musical frequencies anyway).
  const visibleBins = Math.min(FFT_BINS, 360);
  const barW = (FFT_W - 4) / visibleBins;
  for (let i = 0; i < visibleBins; i++) {
    const h = Math.max(0, Math.min(1, fftMag[i]!)) * (FFT_H - 24);
    const px = FFT_X + 2 + i * barW;
    const py = FFT_Y + FFT_H - 4 - h;
    // Gradient-ish: shift hue from cyan toward magenta as bins climb.
    const r = 80 + (i / visibleBins) * 175;
    const g = 200 - (i / visibleBins) * 100;
    const b = 240 - (i / visibleBins) * 90;
    withSolidBrush(argb(255, r | 0, g | 0, b | 0), (brush) => {
      Gdiplus.GdipFillRectangleI(graphics, brush, px | 0, py | 0, Math.max(1, barW | 0), h | 0);
    });
  }
  drawText('FFT Spectrum', FFT_X + 8, FFT_Y + 6, fontLabel, argb(255, 180, 200, 240));

  // ---------- Right panel: HUD + piano ----------
  withSolidBrush(argb(255, 18, 22, 36), (brush) => {
    Gdiplus.GdipFillRectangleI(graphics, brush, RIGHT_PANEL_X, SCOPE_Y, RIGHT_PANEL_W, WINDOW_HEIGHT - 2 * SCOPE_Y);
  });
  withPen(argb(255, 64, 80, 120), 1, (pen) => {
    Gdiplus.GdipDrawRectangleI(graphics, pen, RIGHT_PANEL_X, SCOPE_Y, RIGHT_PANEL_W - 1, WINDOW_HEIGHT - 2 * SCOPE_Y - 1);
  });

  drawText('SYNTH STUDIO', RIGHT_PANEL_X + 16, SCOPE_Y + 12, fontTitle, argb(255, 235, 240, 255));

  const preset = PRESETS[currentPreset]!;
  const voiceCount = voices.reduce((n, v) => n + (v.active ? 1 : 0), 0);

  // HUD lines
  drawText(`Preset      ${preset.name}`, RIGHT_PANEL_X + 16, SCOPE_Y + 52, fontLabel, argb(255, 180, 220, 255));
  drawText(`Octave      ${octave}`, RIGHT_PANEL_X + 16, SCOPE_Y + 72, fontLabel, argb(255, 180, 220, 255));
  drawText(`Mod Index   ${(preset.modIndex + modIndexBias).toFixed(2)}`, RIGHT_PANEL_X + 16, SCOPE_Y + 92, fontLabel, argb(255, 180, 220, 255));
  drawText(`Voices      ${voiceCount}/${MAX_VOICES}`, RIGHT_PANEL_X + 16, SCOPE_Y + 112, fontLabel, argb(255, 180, 220, 255));

  drawText(`${voiceCount}`, RIGHT_PANEL_X + 16, SCOPE_Y + 140, fontBig, argb(255, 120, 240, 200));
  drawText('voices', RIGHT_PANEL_X + 60, SCOPE_Y + 160, fontLabel, argb(255, 140, 180, 220));

  // -- Piano keyboard graphic: two octaves laid out below the HUD. --
  drawPiano(RIGHT_PANEL_X + 16, SCOPE_Y + 220, RIGHT_PANEL_W - 32, 130);

  // Help line.
  drawText('Z S X D C V G B H N J M  |  Q 2 W 3 E R 5 T 6 Y 7 U', RIGHT_PANEL_X + 16, WINDOW_HEIGHT - 70, fontKey, argb(255, 130, 170, 220));
  drawText('Arrows: octave   - / + : FM index   Space: preset   Esc: quit', RIGHT_PANEL_X + 16, WINDOW_HEIGHT - 50, fontKey, argb(255, 130, 170, 220));
}

/**
 * Draw a 2-octave piano keyboard with white + black keys. Keys whose
 * corresponding virtual-key is currently in `heldKeys` light up.
 */
function drawPiano(x: number, y: number, w: number, h: number): void {
  // 14 white keys across two octaves.
  const whiteCount = 14;
  const whiteW = Math.floor(w / whiteCount);
  const totalW = whiteW * whiteCount;
  const startX = x + Math.floor((w - totalW) / 2);

  // Map (octave, semitoneInOctave) -> virtual-key code that triggers it.
  // Lower-row VKs cover semitones 0..11; upper-row VKs cover 12..23.
  const SEMI_TO_VK: readonly number[] = [
    0x5A, 0x53, 0x58, 0x44, 0x43, 0x56, 0x47, 0x42, 0x48, 0x4E, 0x4A, 0x4D,
    0x51, 0x32, 0x57, 0x33, 0x45, 0x52, 0x35, 0x54, 0x36, 0x59, 0x37, 0x55,
  ];
  // White-key semitone offsets within an octave (C D E F G A B).
  const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
  // Black-key semitone offsets within an octave (Db Eb _ Gb Ab Bb).
  const BLACK_OFFSETS: ReadonlyArray<{ semi: number; whiteIdx: number }> = [
    { semi: 1, whiteIdx: 0 },
    { semi: 3, whiteIdx: 1 },
    { semi: 6, whiteIdx: 3 },
    { semi: 8, whiteIdx: 4 },
    { semi: 10, whiteIdx: 5 },
  ];

  // White keys background
  for (let i = 0; i < whiteCount; i++) {
    const oct = i < 7 ? 0 : 1;
    const wOff = WHITE_OFFSETS[i % 7]!;
    const semi = oct * 12 + wOff;
    const vk = SEMI_TO_VK[semi]!;
    const lit = heldKeys.has(vk);
    const kx = startX + i * whiteW;
    const fill = lit ? argb(255, 90, 220, 160) : argb(255, 240, 240, 240);
    withSolidBrush(fill, (brush) => {
      Gdiplus.GdipFillRectangleI(graphics, brush, kx, y, whiteW - 1, h);
    });
    withPen(argb(255, 20, 20, 30), 1, (pen) => {
      Gdiplus.GdipDrawRectangleI(graphics, pen, kx, y, whiteW - 1, h);
    });
    // Letter label.
    drawText(vkToChar(vk), kx + Math.max(2, whiteW / 2 - 4), y + h - 18, fontKey, argb(255, 30, 30, 40));
  }
  // Black keys overlaid.
  const blackW = Math.max(8, Math.floor(whiteW * 0.6));
  const blackH = Math.floor(h * 0.62);
  for (let oct = 0; oct < 2; oct++) {
    for (const { semi, whiteIdx } of BLACK_OFFSETS) {
      const i = oct * 7 + whiteIdx;
      const kx = startX + i * whiteW + whiteW - Math.floor(blackW / 2);
      const totalSemi = oct * 12 + semi;
      const vk = SEMI_TO_VK[totalSemi]!;
      const lit = heldKeys.has(vk);
      const fill = lit ? argb(255, 60, 200, 140) : argb(255, 24, 24, 32);
      withSolidBrush(fill, (brush) => {
        Gdiplus.GdipFillRectangleI(graphics, brush, kx, y, blackW, blackH);
      });
      withPen(argb(255, 5, 5, 10), 1, (pen) => {
        Gdiplus.GdipDrawRectangleI(graphics, pen, kx, y, blackW, blackH);
      });
    }
  }
}

/** Decorative label for a key on the piano graphic. */
function vkToChar(vk: number): string {
  if (vk >= 0x41 && vk <= 0x5A) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  return '?';
}

/** Draw a polyline as a sequence of GdipDrawLineI segments (no path needed). */
function drawPolyline(points: readonly number[], color: number, width: number): void {
  if (points.length < 4) return;
  withPen(color, width, (pen) => {
    for (let i = 2; i < points.length; i += 2) {
      Gdiplus.GdipDrawLineI(
        graphics,
        pen,
        points[i - 2]! | 0,
        points[i - 1]! | 0,
        points[i]! | 0,
        points[i + 1]! | 0,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Input handling.
// ---------------------------------------------------------------------------

function handleKeyDown(vk: number): void {
  // Filter auto-repeat by checking the held set (handleKey is also called for repeats).
  if (heldKeys.has(vk)) return;
  heldKeys.add(vk);

  if (vk === VirtualKey.VK_ESCAPE) {
    User32.PostQuitMessage(0);
    return;
  }
  if (vk === VirtualKey.VK_SPACE) {
    currentPreset = (currentPreset + 1) % PRESETS.length;
    return;
  }
  if (vk === VirtualKey.VK_LEFT) {
    octave = Math.max(0, octave - 1);
    return;
  }
  if (vk === VirtualKey.VK_RIGHT) {
    octave = Math.min(8, octave + 1);
    return;
  }
  // '-' and '+' / '=' tweak the FM modulation index.
  if (vk === 0xBD || vk === 0x6D) { // VK_OEM_MINUS, VK_SUBTRACT
    modIndexBias = Math.max(-5, modIndexBias - 0.25);
    return;
  }
  if (vk === 0xBB || vk === 0x6B) { // VK_OEM_PLUS, VK_ADD
    modIndexBias = Math.min(8, modIndexBias + 0.25);
    return;
  }
  const semi = vkToSemitone(vk);
  if (semi !== null) {
    const midi = octave * 12 + 12 + semi; // C4 = octave 4 * 12 + 12 = 60
    noteOn(midi);
  }
}

function handleKeyUp(vk: number): void {
  heldKeys.delete(vk);
  const semi = vkToSemitone(vk);
  if (semi !== null) {
    const midi = octave * 12 + 12 + semi;
    noteOff(midi);
  }
}

// ---------------------------------------------------------------------------
// Paint: build the frame into the DIB, then blit to the window.
// ---------------------------------------------------------------------------

const paintStruct = Buffer.alloc(72); // PAINTSTRUCT (x64) is 72 bytes; we just need a stable buffer.

function paint(hWnd: bigint): void {
  paintFrame();
  const hdc = User32.BeginPaint(hWnd, paintStruct.ptr!);
  if (hdc) {
    GDI32.BitBlt(hdc, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, memoryDC, 0, 0, SRCCOPY);
    User32.EndPaint(hWnd, paintStruct.ptr!);
  }
}

// ---------------------------------------------------------------------------
// Show window, install the 60 Hz timer, run the message pump.
// ---------------------------------------------------------------------------

User32.ShowWindow(hwnd, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(hwnd);
User32.SetTimer(hwnd, TIMER_ID, FRAME_INTERVAL_MS, null);

console.log('Synth Studio is live -- the window has focus, give it a play!');
console.log('  Lower octave:  Z S X D C V G B H N J M');
console.log('  Upper octave:  Q 2 W 3 E R 5 T 6 Y 7 U');
console.log('  Arrows shift octave; - / + tweak FM index; Space cycles preset; Esc exits.');

const msgBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(msgBuffer.ptr!, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr!);
  User32.DispatchMessageW(msgBuffer.ptr!);
}

// ---------------------------------------------------------------------------
// Teardown -- reverse-order cleanup of every resource we created.
// ---------------------------------------------------------------------------

User32.KillTimer(hwnd, TIMER_ID);

Gdiplus.GdipDeleteStringFormat(stringFormat);
Gdiplus.GdipDeleteFont(fontTitle);
Gdiplus.GdipDeleteFont(fontLabel);
Gdiplus.GdipDeleteFont(fontKey);
Gdiplus.GdipDeleteFont(fontBig);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteGraphics(graphics);
Gdiplus.GdiplusShutdown(gdipToken);

GDI32.SelectObject(memoryDC, oldBitmap);
GDI32.DeleteObject(dibBitmap);
GDI32.DeleteDC(memoryDC);

User32.DestroyWindow(hwnd);
User32.UnregisterClassW(className.ptr!, hInstance);
wndProc.close();

vcall(source, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);

console.log('Synth Studio closed cleanly.');
