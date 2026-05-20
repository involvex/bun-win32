/**
 * Live Piano — hum a note, the piano plays it back.
 *
 * Captures the default microphone with `waveInOpen`, detects the dominant
 * pitch via autocorrelation, lights up the matching key on an on-screen
 * 5-octave piano, and re-synthesizes the note through XAudio2 as a soft
 * additive tone (fundamental + 2nd + 3rd harmonic + ADSR) — all painted with
 * GDI+ into a borderless Mica-backdrop window at ~60 fps. No native addon,
 * no Electron, no audio library: just FFI into the OS.
 *
 *   Mic ─ Winmm.waveInOpen (44.1 kHz mono 16-bit, polled WAVEHDR ring)
 *           → 8192-sample rolling history
 *           → autocorrelation over τ ∈ [40, 800]  →  MIDI 36-96
 *   Synth ─ XAudio2Create / IXAudio2 vtable
 *           → streaming source voice, mixer keeps the queue 4 buffers deep
 *   Paint ─ Gdiplus offscreen ARGB bitmap
 *           → GdipCreateFromHDC(window DC) → GdipDrawImageRectI → release
 *   Window ─ User32.CreateWindowExW + WndProc, Dwmapi system backdrop / dark
 *
 * APIs demonstrated:
 *   - Winmm:    waveInOpen / waveInPrepareHeader / waveInAddBuffer /
 *               waveInStart / waveInStop / waveInReset /
 *               waveInUnprepareHeader / waveInClose
 *   - Xaudio2_9: XAudio2Create + IXAudio2 / IXAudio2SourceVoice vtable
 *                (CreateMasteringVoice, CreateSourceVoice, Start, Stop,
 *                 SubmitSourceBuffer, GetState, DestroyVoice, Release)
 *   - Dwmapi:   DwmSetWindowAttribute (Mica backdrop + immersive dark mode)
 *   - Gdiplus:  GdiplusStartup/Shutdown, GdipCreateBitmapFromScan0,
 *               GdipGetImageGraphicsContext, GdipSetSmoothingMode,
 *               GdipSetTextRenderingHint, GdipCreateSolidFill, GdipCreatePen1,
 *               GdipFillRectangle, GdipDrawLines, GdipCreateFontFamilyFromName,
 *               GdipCreateFont, GdipCreateStringFormat, GdipDrawString,
 *               GdipCreateFromHDC, GdipDrawImageRectI
 *   - User32:   RegisterClassExW, CreateWindowExW, SetWindowPos, ShowWindow,
 *               UpdateWindow, SetTimer, KillTimer, GetMessageW,
 *               TranslateMessage, DispatchMessageW, DefWindowProcW,
 *               BeginPaint, EndPaint, GetClientRect, GetDC, ReleaseDC,
 *               DestroyWindow, PostQuitMessage, InvalidateRect,
 *               GetDesktopWindow
 *   - Kernel32: QueryPerformanceFrequency
 *
 * Run: bun run example/live-piano.ts        (Press ESC to quit.)
 */

import { CFunction, FFIType, JSCallback, type Pointer, read } from 'bun:ffi';

import { Dwmapi, Gdiplus, Kernel32, User32, Winmm, Xaudio2_9 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { CallbackFlag, WAVE_MAPPER } from '@bun-win32/winmm';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

// ── Configuration ─────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44_100;
const BLOCK_ALIGN_BYTES = 2; // mono 16-bit
const CAPTURE_BUFFER_SAMPLES = 2_048; // ~46 ms per WAVEHDR
const CAPTURE_BUFFER_COUNT = 4;
const HISTORY_SAMPLES = 8_192;
const WAVEFORM_SAMPLES = 1_024;

const SYNTH_BUFFER_SAMPLES = 2_048;
const SYNTH_BUFFER_QUEUE_TARGET = 4;
const SYNTH_SUBMIT_SLOTS = 8;

const WINDOW_WIDTH = 1_200;
const WINDOW_HEIGHT = 400;
const FRAME_INTERVAL_MS = 16;

const MIDI_LOWEST = 36; // C2
const MIDI_HIGHEST = 96; // C7

const RMS_DETECTION_THRESHOLD = 0.012;
const PITCH_CONFIDENCE_THRESHOLD = 0.5;
const PITCH_STABILITY_FRAMES = 2;

// Win32 message + flag constants.
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const WHDR_DONE = 0x0000_0001;
const VK_ESCAPE = 0x1b;
const TIMER_ID = 1n;
const SWP_SHOWWINDOW = 0x0040;
const CS_HREDRAW = 0x0002;
const CS_VREDRAW = 0x0001;

// XAudio2 vtable slots (xaudio2.h declaration order).
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_STOP = 20;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ── Helpers ───────────────────────────────────────────────────────────────────

const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;
const encodeUtf16Z = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
const frequencyToMidi = (frequency: number): number => Math.round(69 + 12 * Math.log2(frequency / 440));
const midiToNoteName = (midi: number): string => `${NOTE_NAMES[midi % 12] ?? '?'}${Math.floor(midi / 12) - 1}`;
const isBlackKey = (midi: number): boolean => {
  const s = midi % 12;
  return s === 1 || s === 3 || s === 6 || s === 8 || s === 10;
};

const vtableInvokerCache = new Map<string, ReturnType<typeof CFunction>>();

/** Invoke a COM vtable slot — memoized per (method, signature). */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = vtableInvokerCache.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    vtableInvokerCache.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

function checkGdip(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} → Gdiplus status ${status}`);
}

// ── Microphone capture ────────────────────────────────────────────────────────

/** Rolling Float32 history of mic samples; `snapshot` returns them in order. */
class SampleHistory {
  private readonly storage = new Float32Array(HISTORY_SAMPLES);
  private writeIndex = 0;

  public ingestPcm16(buffer: Buffer, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.storage[this.writeIndex] = buffer.readInt16LE(i * 2) / 32_768;
      this.writeIndex = (this.writeIndex + 1) % HISTORY_SAMPLES;
    }
  }

  public snapshot(out: Float32Array): void {
    const n = Math.min(out.length, HISTORY_SAMPLES);
    for (let i = 0; i < n; i += 1) {
      out[i] = this.storage[(this.writeIndex + HISTORY_SAMPLES - n + i) % HISTORY_SAMPLES] ?? 0;
    }
  }
}

const sampleHistory = new SampleHistory();
const analysisBuffer = new Float32Array(HISTORY_SAMPLES);

const captureSampleBuffers: Buffer[] = [];
const captureHeaderBuffers: Buffer[] = [];
for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
  captureSampleBuffers.push(Buffer.alloc(CAPTURE_BUFFER_SAMPLES * BLOCK_ALIGN_BYTES));
  captureHeaderBuffers.push(Buffer.alloc(48));
}

let captureDeviceHandle: bigint = 0n;
let capturePreparedHeaderCount = 0;

/** WAVEHDR offsets (x64): lpData@0, dwBufferLength@8, dwBytesRecorded@12,
 *  dwUser@16, dwFlags@24, dwLoops@28, lpNext@32, reserved@40 = 48 bytes. */
function initializeCaptureHeader(index: number): void {
  const header = captureHeaderBuffers[index]!;
  const samples = captureSampleBuffers[index]!;
  header.writeBigUInt64LE(BigInt(samples.ptr!), 0);
  header.writeUInt32LE(samples.byteLength, 8);
  header.writeUInt32LE(0, 12);
  header.writeBigUInt64LE(0n, 16);
  header.writeUInt32LE(0, 24);
  header.writeUInt32LE(0, 28);
  header.writeBigUInt64LE(0n, 32);
  header.writeBigUInt64LE(0n, 40);
}

function startMicrophoneCapture(): boolean {
  const handleOut = Buffer.alloc(8);
  const waveFormat = Buffer.alloc(18); // WAVEFORMATEX
  waveFormat.writeUInt16LE(1, 0); // PCM
  waveFormat.writeUInt16LE(1, 2); // mono
  waveFormat.writeUInt32LE(SAMPLE_RATE, 4);
  waveFormat.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN_BYTES, 8);
  waveFormat.writeUInt16LE(BLOCK_ALIGN_BYTES, 12);
  waveFormat.writeUInt16LE(16, 14);
  waveFormat.writeUInt16LE(0, 16);

  const openStatus = Winmm.waveInOpen(handleOut.ptr!, WAVE_MAPPER, waveFormat.ptr!, 0n, 0n, CallbackFlag.CALLBACK_NULL);
  if (openStatus !== 0) {
    console.error(`waveInOpen failed (status ${openStatus}).`);
    return false;
  }
  captureDeviceHandle = handleOut.readBigUInt64LE(0);

  for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
    initializeCaptureHeader(i);
    const header = captureHeaderBuffers[i]!;
    if (Winmm.waveInPrepareHeader(captureDeviceHandle, header.ptr!, header.byteLength) !== 0) return false;
    capturePreparedHeaderCount += 1;
    if (Winmm.waveInAddBuffer(captureDeviceHandle, header.ptr!, header.byteLength) !== 0) return false;
  }
  return Winmm.waveInStart(captureDeviceHandle) === 0;
}

/** Drain any WAVEHDRs the driver has marked WHDR_DONE; recycle them. */
function pollMicrophoneCapture(): void {
  if (captureDeviceHandle === 0n) return;
  for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
    const header = captureHeaderBuffers[i]!;
    if ((header.readUInt32LE(24) & WHDR_DONE) === 0) continue;
    const sampleCount = Math.floor(header.readUInt32LE(12) / BLOCK_ALIGN_BYTES);
    if (sampleCount > 0) sampleHistory.ingestPcm16(captureSampleBuffers[i]!, sampleCount);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(0, 24);
    Winmm.waveInAddBuffer(captureDeviceHandle, header.ptr!, header.byteLength);
  }
}

function stopMicrophoneCapture(): void {
  if (captureDeviceHandle === 0n) return;
  Winmm.waveInStop(captureDeviceHandle);
  Winmm.waveInReset(captureDeviceHandle);
  for (let i = 0; i < capturePreparedHeaderCount; i += 1) {
    Winmm.waveInUnprepareHeader(captureDeviceHandle, captureHeaderBuffers[i]!.ptr!, captureHeaderBuffers[i]!.byteLength);
  }
  Winmm.waveInClose(captureDeviceHandle);
  captureDeviceHandle = 0n;
}

// ── Pitch detection (normalized autocorrelation) ──────────────────────────────

const MIN_LAG = Math.floor(SAMPLE_RATE / 1_100); // ~40
const MAX_LAG = Math.floor(SAMPLE_RATE / 55); // ~800

interface PitchEstimate {
  readonly frequencyHz: number;
  readonly midi: number;
  readonly rms: number;
  readonly confidence: number;
}

/**
 * Estimate the dominant fundamental over the last `windowSize` samples.
 * Returns `null` when silent (low RMS) or non-tonal (low autocorr peak).
 * Uses parabolic interpolation around the peak for sub-sample precision.
 */
function estimatePitch(signal: Float32Array, windowSize: number): PitchEstimate | null {
  const startIndex = signal.length - windowSize;
  if (startIndex < 0) return null;

  let energy = 0;
  for (let i = startIndex; i < signal.length; i += 1) {
    const v = signal[i] ?? 0;
    energy += v * v;
  }
  const rms = Math.sqrt(energy / windowSize);
  if (rms < RMS_DETECTION_THRESHOLD || energy === 0) return null;

  let bestLag = -1;
  let bestNormalized = -1;
  let lagMinusOneNormalized = 0;
  let lagPlusOneNormalized = 0;
  let previousNormalized = 0;

  for (let lag = MIN_LAG; lag <= MAX_LAG; lag += 1) {
    let correlation = 0;
    const stop = signal.length - lag;
    for (let i = startIndex; i < stop; i += 1) {
      correlation += (signal[i] ?? 0) * (signal[i + lag] ?? 0);
    }
    const normalized = correlation / energy;
    if (normalized > bestNormalized) {
      bestNormalized = normalized;
      bestLag = lag;
      lagMinusOneNormalized = previousNormalized;
      lagPlusOneNormalized = 0;
    } else if (lag === bestLag + 1) {
      lagPlusOneNormalized = normalized;
    }
    previousNormalized = normalized;
  }

  if (bestLag <= 0 || bestNormalized < PITCH_CONFIDENCE_THRESHOLD) return null;

  let refinedLag = bestLag;
  const denom = lagMinusOneNormalized - 2 * bestNormalized + lagPlusOneNormalized;
  if (denom !== 0) {
    const delta = (0.5 * (lagMinusOneNormalized - lagPlusOneNormalized)) / denom;
    if (delta > -1 && delta < 1) refinedLag = bestLag + delta;
  }

  const frequencyHz = SAMPLE_RATE / refinedLag;
  const midi = frequencyToMidi(frequencyHz);
  if (midi < MIDI_LOWEST || midi > MIDI_HIGHEST) return null;

  return { frequencyHz, midi, rms, confidence: bestNormalized };
}

// ── Shared visualization + synth state ────────────────────────────────────────

const visualState = {
  detectedMidi: null as number | null,
  detectedFrequencyHz: 0,
  detectedConfidence: 0,
  detectedRms: 0,
  framesSinceDetection: 0,
};

let pitchCandidateMidi: number | null = null;
let pitchCandidateStreak = 0;

// ── Synth playback (XAudio2 streaming source voice) ───────────────────────────

let xaudio2EnginePtr: bigint = 0n;
let xaudio2MasterPtr: bigint = 0n;
let xaudio2SourcePtr: bigint = 0n;
let xaudio2Started = false;

const synthPcmSlots: Buffer[] = [];
const synthXaudioBufferStructs: Buffer[] = [];
for (let i = 0; i < SYNTH_SUBMIT_SLOTS; i += 1) {
  synthPcmSlots.push(Buffer.alloc(SYNTH_BUFFER_SAMPLES * 2));
  synthXaudioBufferStructs.push(Buffer.alloc(48));
}
let synthSubmitCursor = 0;
const synthVoiceStateBuffer = Buffer.alloc(24); // XAUDIO2_VOICE_STATE

const synthVoice = {
  midi: 0,
  frequencyHz: 0,
  phaseRadians: 0,
  envelopeLevel: 0,
  envelopeTarget: 0,
  releasing: true,
};

const SYNTH_ATTACK_PER_SAMPLE = 1 / (0.012 * SAMPLE_RATE);
const SYNTH_RELEASE_PER_SAMPLE = 1 / (0.18 * SAMPLE_RATE);
const SYNTH_AMPLITUDE = 0.42;

function setSynthActiveNote(midi: number | null): void {
  if (midi === null) {
    synthVoice.envelopeTarget = 0;
    synthVoice.releasing = true;
    return;
  }
  if (midi !== synthVoice.midi) {
    synthVoice.midi = midi;
    synthVoice.frequencyHz = midiToFrequency(midi);
    synthVoice.phaseRadians = 0;
    synthVoice.envelopeLevel = 0;
  }
  synthVoice.envelopeTarget = 1;
  synthVoice.releasing = false;
}

/** Fill `pcm` with SYNTH_BUFFER_SAMPLES of additive piano-ish synthesis. */
function renderSynthBuffer(pcm: Buffer): void {
  const omega = (2 * Math.PI * synthVoice.frequencyHz) / SAMPLE_RATE;
  for (let i = 0; i < SYNTH_BUFFER_SAMPLES; i += 1) {
    if (synthVoice.releasing) {
      synthVoice.envelopeLevel = Math.max(0, synthVoice.envelopeLevel - SYNTH_RELEASE_PER_SAMPLE);
    } else {
      synthVoice.envelopeLevel = Math.min(synthVoice.envelopeTarget, synthVoice.envelopeLevel + SYNTH_ATTACK_PER_SAMPLE);
    }
    const phase = synthVoice.phaseRadians;
    const sample = (Math.sin(phase) + Math.sin(phase * 2) * 0.42 + Math.sin(phase * 3) * 0.18) * synthVoice.envelopeLevel * SYNTH_AMPLITUDE;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm.writeInt16LE(Math.round(clamped * 32_767), i * 2);
    synthVoice.phaseRadians = phase + omega;
    if (synthVoice.phaseRadians > Math.PI * 2_048) synthVoice.phaseRadians -= Math.PI * 2_048;
  }
}

/** Keep the source voice queue at SYNTH_BUFFER_QUEUE_TARGET deep. */
function pumpSynthMixer(): void {
  if (xaudio2SourcePtr === 0n) return;
  vcall(xaudio2SourcePtr, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [synthVoiceStateBuffer.ptr!, 0], FFIType.void);
  let buffersQueued = synthVoiceStateBuffer.readUInt32LE(8);
  while (buffersQueued < SYNTH_BUFFER_QUEUE_TARGET) {
    const slotIndex = synthSubmitCursor;
    synthSubmitCursor = (synthSubmitCursor + 1) % SYNTH_SUBMIT_SLOTS;
    const pcm = synthPcmSlots[slotIndex]!;
    const xbuf = synthXaudioBufferStructs[slotIndex]!;
    renderSynthBuffer(pcm);
    xbuf.writeUInt32LE(0, 0);
    xbuf.writeUInt32LE(pcm.byteLength, 4);
    xbuf.writeBigUInt64LE(BigInt(pcm.ptr!), 8);
    xbuf.writeUInt32LE(0, 16);
    xbuf.writeUInt32LE(0, 20);
    xbuf.writeUInt32LE(0, 24);
    xbuf.writeUInt32LE(0, 28);
    xbuf.writeUInt32LE(0, 32);
    xbuf.writeBigUInt64LE(0n, 40);
    vcall(xaudio2SourcePtr, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [xbuf.ptr!, null]);
    buffersQueued += 1;
  }
}

function startSynth(): boolean {
  const enginePtrOut = Buffer.alloc(8);
  if (Xaudio2_9.XAudio2Create(enginePtrOut.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR) !== S_OK) return false;
  xaudio2EnginePtr = enginePtrOut.readBigUInt64LE(0);

  const masterPtrOut = Buffer.alloc(8);
  const masterStatus = vcall(xaudio2EnginePtr, IXAUDIO2_CREATEMASTERINGVOICE, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32], [masterPtrOut.ptr!, 0, 0, 0, null, null, 6]);
  if (masterStatus !== S_OK) return false;
  xaudio2MasterPtr = masterPtrOut.readBigUInt64LE(0);

  const sourceFormat = Buffer.alloc(18);
  sourceFormat.writeUInt16LE(1, 0);
  sourceFormat.writeUInt16LE(1, 2);
  sourceFormat.writeUInt32LE(SAMPLE_RATE, 4);
  sourceFormat.writeUInt32LE(SAMPLE_RATE * 2, 8);
  sourceFormat.writeUInt16LE(2, 12);
  sourceFormat.writeUInt16LE(16, 14);
  sourceFormat.writeUInt16LE(0, 16);

  const sourcePtrOut = Buffer.alloc(8);
  const sourceStatus = vcall(xaudio2EnginePtr, IXAUDIO2_CREATESOURCEVOICE, [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [sourcePtrOut.ptr!, sourceFormat.ptr!, 0, 2.0, null, null, null]);
  if (sourceStatus !== S_OK) return false;
  xaudio2SourcePtr = sourcePtrOut.readBigUInt64LE(0);

  pumpSynthMixer();
  if (vcall(xaudio2SourcePtr, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]) !== S_OK) return false;
  xaudio2Started = true;
  return true;
}

function stopSynth(): void {
  if (xaudio2SourcePtr !== 0n) {
    if (xaudio2Started) vcall(xaudio2SourcePtr, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
    vcall(xaudio2SourcePtr, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    xaudio2SourcePtr = 0n;
  }
  if (xaudio2MasterPtr !== 0n) {
    vcall(xaudio2MasterPtr, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    xaudio2MasterPtr = 0n;
  }
  if (xaudio2EnginePtr !== 0n) {
    vcall(xaudio2EnginePtr, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    xaudio2EnginePtr = 0n;
  }
}

// ── GDI+ rendering ────────────────────────────────────────────────────────────

let gdiplusToken = 0n;
let offscreenBitmapPtr = 0n;
let offscreenGraphicsPtr = 0n;
let titleFontFamilyPtr = 0n;
let titleFontPtr = 0n;
let labelFontPtr = 0n;
let centeredStringFormatPtr = 0n;
let leftStringFormatPtr = 0n;
const waveformPointsBuffer = Buffer.alloc(WAVEFORM_SAMPLES * 2 * 4);

function createBrush(color: number): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, out.ptr!);
  return out.readBigUInt64LE(0);
}

function createPen(color: number, widthPixels: number): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(color, widthPixels, Unit.UnitPixel, out.ptr!);
  return out.readBigUInt64LE(0);
}

function startGdiplus(): void {
  Gdiplus.Preload();
  const tokenOut = Buffer.alloc(8);
  const startupInput = Buffer.alloc(16);
  startupInput.writeUInt32LE(1, 0);
  checkGdip(Gdiplus.GdiplusStartup(tokenOut.ptr!, startupInput.ptr!, null), 'GdiplusStartup');
  gdiplusToken = tokenOut.readBigUInt64LE(0);

  const bitmapOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapOut.ptr!), 'GdipCreateBitmapFromScan0');
  offscreenBitmapPtr = bitmapOut.readBigUInt64LE(0);

  const graphicsOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmapPtr, graphicsOut.ptr!), 'GdipGetImageGraphicsContext');
  offscreenGraphicsPtr = graphicsOut.readBigUInt64LE(0);
  Gdiplus.GdipSetSmoothingMode(offscreenGraphicsPtr, SmoothingMode.SmoothingModeAntiAlias);
  Gdiplus.GdipSetTextRenderingHint(offscreenGraphicsPtr, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

  const fontFamilyOut = Buffer.alloc(8);
  const fontFamilyName = encodeUtf16Z('Segoe UI');
  checkGdip(Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr!, 0n, fontFamilyOut.ptr!), 'GdipCreateFontFamilyFromName');
  titleFontFamilyPtr = fontFamilyOut.readBigUInt64LE(0);

  const titleFontOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateFont(titleFontFamilyPtr, 26, FontStyle.FontStyleBold, Unit.UnitPixel, titleFontOut.ptr!), 'GdipCreateFont (title)');
  titleFontPtr = titleFontOut.readBigUInt64LE(0);

  const labelFontOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateFont(titleFontFamilyPtr, 12, FontStyle.FontStyleRegular, Unit.UnitPixel, labelFontOut.ptr!), 'GdipCreateFont (label)');
  labelFontPtr = labelFontOut.readBigUInt64LE(0);

  const centeredOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateStringFormat(0, 0, centeredOut.ptr!), 'GdipCreateStringFormat (centered)');
  centeredStringFormatPtr = centeredOut.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(centeredStringFormatPtr, StringAlignment.StringAlignmentCenter);
  Gdiplus.GdipSetStringFormatLineAlign(centeredStringFormatPtr, StringAlignment.StringAlignmentCenter);

  const leftOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateStringFormat(0, 0, leftOut.ptr!), 'GdipCreateStringFormat (left)');
  leftStringFormatPtr = leftOut.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(leftStringFormatPtr, StringAlignment.StringAlignmentNear);
  Gdiplus.GdipSetStringFormatLineAlign(leftStringFormatPtr, StringAlignment.StringAlignmentCenter);
}

function stopGdiplus(): void {
  if (centeredStringFormatPtr !== 0n) Gdiplus.GdipDeleteStringFormat(centeredStringFormatPtr);
  if (leftStringFormatPtr !== 0n) Gdiplus.GdipDeleteStringFormat(leftStringFormatPtr);
  if (titleFontPtr !== 0n) Gdiplus.GdipDeleteFont(titleFontPtr);
  if (labelFontPtr !== 0n) Gdiplus.GdipDeleteFont(labelFontPtr);
  if (titleFontFamilyPtr !== 0n) Gdiplus.GdipDeleteFontFamily(titleFontFamilyPtr);
  if (offscreenGraphicsPtr !== 0n) Gdiplus.GdipDeleteGraphics(offscreenGraphicsPtr);
  if (offscreenBitmapPtr !== 0n) Gdiplus.GdipDisposeImage(offscreenBitmapPtr);
  if (gdiplusToken !== 0n) Gdiplus.GdiplusShutdown(gdiplusToken);
}

const tempLayoutRect = Buffer.alloc(16);

function drawString(text: string, font: bigint, brush: bigint, format: bigint, x: number, y: number, w: number, h: number): void {
  tempLayoutRect.writeFloatLE(x, 0);
  tempLayoutRect.writeFloatLE(y, 4);
  tempLayoutRect.writeFloatLE(w, 8);
  tempLayoutRect.writeFloatLE(h, 12);
  const text16 = encodeUtf16Z(text);
  Gdiplus.GdipDrawString(offscreenGraphicsPtr, text16.ptr!, -1, font, tempLayoutRect.ptr!, format, brush);
}

// Piano layout: white keys laid out edge-to-edge, black keys overlap on top.
let totalWhiteKeys = 0;
for (let m = MIDI_LOWEST; m <= MIDI_HIGHEST; m += 1) if (!isBlackKey(m)) totalWhiteKeys += 1;

interface KeyLayout {
  readonly x: number;
  readonly width: number;
}

function getKeyLayout(midi: number, keyboardLeft: number, whiteKeyWidth: number): KeyLayout {
  let whiteIndex = 0;
  for (let m = MIDI_LOWEST; m < midi; m += 1) if (!isBlackKey(m)) whiteIndex += 1;
  if (!isBlackKey(midi)) {
    return { x: keyboardLeft + whiteIndex * whiteKeyWidth, width: whiteKeyWidth };
  }
  const blackWidth = whiteKeyWidth * 0.62;
  return { x: keyboardLeft + whiteIndex * whiteKeyWidth - blackWidth / 2, width: blackWidth };
}

/** Render one frame into the offscreen GDI+ bitmap. */
function renderFrame(): void {
  // ── Background ──
  const backgroundBrush = createBrush(argb(255, 0x0e, 0x10, 0x22));
  Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, backgroundBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(backgroundBrush);

  const sheenBrush = createBrush(argb(40, 0x4a, 0x6e, 0xff));
  Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, sheenBrush, 0, 0, WINDOW_WIDTH, 80);
  Gdiplus.GdipDeleteBrush(sheenBrush);

  // ── Title + subtitle ──
  const titleBrush = createBrush(argb(255, 0xff, 0xff, 0xff));
  drawString('Live Piano', titleFontPtr, titleBrush, leftStringFormatPtr, 24, 6, 360, 48);
  Gdiplus.GdipDeleteBrush(titleBrush);

  const subtitleBrush = createBrush(argb(180, 0xa8, 0xc0, 0xff));
  drawString('Hum into your microphone — your laptop plays piano along with you.', labelFontPtr, subtitleBrush, leftStringFormatPtr, 24, 42, 900, 24);
  Gdiplus.GdipDeleteBrush(subtitleBrush);

  // ── Scope: latest WAVEFORM_SAMPLES samples ──
  const scopeLeft = 24;
  const scopeTop = 76;
  const scopeWidth = WINDOW_WIDTH - 48;
  const scopeHeight = 88;
  const scopePanelBrush = createBrush(argb(220, 0x16, 0x1c, 0x36));
  Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, scopePanelBrush, scopeLeft, scopeTop, scopeWidth, scopeHeight);
  Gdiplus.GdipDeleteBrush(scopePanelBrush);

  sampleHistory.snapshot(analysisBuffer);
  const scopeMidY = scopeTop + scopeHeight / 2;
  for (let i = 0; i < WAVEFORM_SAMPLES; i += 1) {
    const sample = analysisBuffer[analysisBuffer.length - WAVEFORM_SAMPLES + i] ?? 0;
    const x = scopeLeft + (i / (WAVEFORM_SAMPLES - 1)) * scopeWidth;
    const y = scopeMidY - sample * (scopeHeight / 2 - 6);
    waveformPointsBuffer.writeFloatLE(x, i * 8);
    waveformPointsBuffer.writeFloatLE(y, i * 8 + 4);
  }
  const scopePen = createPen(visualState.detectedMidi !== null ? argb(255, 0x7a, 0xff, 0xae) : argb(220, 0x68, 0x82, 0xff), 1.4);
  Gdiplus.GdipDrawLines(offscreenGraphicsPtr, scopePen, waveformPointsBuffer.ptr!, WAVEFORM_SAMPLES);
  Gdiplus.GdipDeletePen(scopePen);

  // ── Keyboard ──
  const keyboardLeft = 24;
  const keyboardTop = 180;
  const keyboardWidth = WINDOW_WIDTH - 48;
  const keyboardHeight = 168;
  const whiteKeyWidth = keyboardWidth / totalWhiteKeys;
  const blackKeyHeight = keyboardHeight * 0.62;

  const keyboardFrameBrush = createBrush(argb(255, 0x2a, 0x2f, 0x4e));
  Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, keyboardFrameBrush, keyboardLeft - 6, keyboardTop - 6, keyboardWidth + 12, keyboardHeight + 12);
  Gdiplus.GdipDeleteBrush(keyboardFrameBrush);

  const activeMidi = visualState.detectedMidi;
  const activeBrush = createBrush(argb(255, 0x7a, 0xff, 0xae));
  const whiteBrush = createBrush(argb(255, 0xf4, 0xf6, 0xff));
  const blackBrush = createBrush(argb(255, 0x11, 0x14, 0x26));
  const whiteHaloBrush = createBrush(argb(80, 0x7a, 0xff, 0xae));
  const blackHaloBrush = createBrush(argb(120, 0x7a, 0xff, 0xae));
  const octaveLabelBrush = createBrush(argb(160, 0x10, 0x18, 0x30));

  for (let m = MIDI_LOWEST; m <= MIDI_HIGHEST; m += 1) {
    if (isBlackKey(m)) continue;
    const layout = getKeyLayout(m, keyboardLeft, whiteKeyWidth);
    const isActive = activeMidi === m;
    Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, isActive ? activeBrush : whiteBrush, layout.x + 1, keyboardTop, layout.width - 2, keyboardHeight);
    if (isActive) {
      Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, whiteHaloBrush, layout.x - 4, keyboardTop - 6, layout.width + 8, 12);
    }
    if (m % 12 === 0) {
      drawString(midiToNoteName(m), labelFontPtr, octaveLabelBrush, centeredStringFormatPtr, layout.x, keyboardTop + keyboardHeight - 22, layout.width, 18);
    }
  }
  for (let m = MIDI_LOWEST; m <= MIDI_HIGHEST; m += 1) {
    if (!isBlackKey(m)) continue;
    const layout = getKeyLayout(m, keyboardLeft, whiteKeyWidth);
    const isActive = activeMidi === m;
    Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, isActive ? activeBrush : blackBrush, layout.x, keyboardTop, layout.width, blackKeyHeight);
    if (isActive) {
      Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, blackHaloBrush, layout.x - 3, keyboardTop - 4, layout.width + 6, 8);
    }
  }

  Gdiplus.GdipDeleteBrush(activeBrush);
  Gdiplus.GdipDeleteBrush(whiteBrush);
  Gdiplus.GdipDeleteBrush(blackBrush);
  Gdiplus.GdipDeleteBrush(whiteHaloBrush);
  Gdiplus.GdipDeleteBrush(blackHaloBrush);
  Gdiplus.GdipDeleteBrush(octaveLabelBrush);

  // ── HUD chip ──
  const hudTop = WINDOW_HEIGHT - 36;
  const hudBackgroundBrush = createBrush(argb(180, 0x14, 0x18, 0x2e));
  Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, hudBackgroundBrush, 0, hudTop, WINDOW_WIDTH, 36);
  Gdiplus.GdipDeleteBrush(hudBackgroundBrush);

  let hudLine: string;
  if (activeMidi !== null) {
    const noteName = midiToNoteName(activeMidi);
    const targetHz = midiToFrequency(activeMidi);
    hudLine = `${noteName.padEnd(3)}  •  ${visualState.detectedFrequencyHz.toFixed(1)} Hz  →  ${targetHz.toFixed(1)} Hz  •  RMS ${(visualState.detectedRms * 100).toFixed(1)}%  •  confidence ${(visualState.detectedConfidence * 100).toFixed(0)}%`;
  } else {
    hudLine = `listening  •  44.1 kHz mono 16-bit  •  ${CAPTURE_BUFFER_SAMPLES}-sample frames  •  RMS ${(visualState.detectedRms * 100).toFixed(2)}%   (Press ESC to quit.)`;
  }
  const hudTextBrush = createBrush(argb(255, 0xd4, 0xe0, 0xff));
  drawString(hudLine, labelFontPtr, hudTextBrush, leftStringFormatPtr, 24, hudTop, WINDOW_WIDTH - 48, 36);
  Gdiplus.GdipDeleteBrush(hudTextBrush);
}

/** Blit the offscreen bitmap to the window's client area. */
function presentFrame(hwnd: bigint): void {
  const hdc = User32.GetDC(hwnd);
  if (!hdc) return;
  const screenGraphicsOut = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(hdc, screenGraphicsOut.ptr!) === Status.Ok) {
    const screenGraphics = screenGraphicsOut.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(screenGraphics, offscreenBitmapPtr, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(screenGraphics);
  }
  User32.ReleaseDC(hwnd, hdc);
}

// ── Window + WndProc ──────────────────────────────────────────────────────────

let windowHandle: bigint = 0n;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER) {
      pollMicrophoneCapture();
      sampleHistory.snapshot(analysisBuffer);
      const estimate = estimatePitch(analysisBuffer, Math.min(HISTORY_SAMPLES, 4_096));
      if (estimate !== null) {
        if (pitchCandidateMidi === estimate.midi) pitchCandidateStreak += 1;
        else {
          pitchCandidateMidi = estimate.midi;
          pitchCandidateStreak = 1;
        }
        if (pitchCandidateStreak >= PITCH_STABILITY_FRAMES) {
          visualState.detectedMidi = estimate.midi;
          visualState.detectedFrequencyHz = estimate.frequencyHz;
          visualState.detectedConfidence = estimate.confidence;
          visualState.framesSinceDetection = 0;
        }
        visualState.detectedRms = estimate.rms;
      } else {
        pitchCandidateMidi = null;
        pitchCandidateStreak = 0;
        visualState.framesSinceDetection += 1;
        if (visualState.framesSinceDetection > 6) visualState.detectedMidi = null;
      }
      setSynthActiveNote(visualState.detectedMidi);
      pumpSynthMixer();
      renderFrame();
      User32.InvalidateRect(hWnd, null, 0);
      return 0n;
    }
    if (msg === WM_PAINT) {
      const paintStruct = Buffer.alloc(72);
      User32.BeginPaint(hWnd, paintStruct.ptr!);
      presentFrame(hWnd);
      User32.EndPaint(hWnd, paintStruct.ptr!);
      return 0n;
    }
    if (msg === WM_KEYDOWN && Number(wParam) === VK_ESCAPE) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_CLOSE) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_DESTROY) {
      User32.KillTimer(hWnd, TIMER_ID);
      User32.PostQuitMessage(0);
      return 0n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

function createWindow(): boolean {
  const className = encodeUtf16Z('BunWin32LivePiano');
  const wc = Buffer.alloc(80); // WNDCLASSEXW
  const view = new DataView(wc.buffer);
  view.setUint32(0, 80, true);
  view.setUint32(4, CS_HREDRAW | CS_VREDRAW, true);
  wc.writeBigUInt64LE(BigInt(wndProc.ptr!), 8);
  view.setInt32(16, 0, true);
  view.setInt32(20, 0, true);
  wc.writeBigUInt64LE(0n, 24);
  wc.writeBigUInt64LE(0n, 32);
  wc.writeBigUInt64LE(0n, 40);
  wc.writeBigUInt64LE(0n, 48);
  wc.writeBigUInt64LE(0n, 56);
  wc.writeBigUInt64LE(BigInt(className.ptr!), 64);
  wc.writeBigUInt64LE(0n, 72);
  if (User32.RegisterClassExW(wc.ptr!) === 0) return false;

  const titleText = encodeUtf16Z('Live Piano');
  windowHandle = User32.CreateWindowExW(
    ExtendedWindowStyles.WS_EX_APPWINDOW,
    className.ptr!,
    titleText.ptr!,
    WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
    -1,
    -1,
    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    0n,
    0n,
    0n,
    null,
  );
  if (windowHandle === 0n) return false;

  // Center on the primary monitor.
  const rect = Buffer.alloc(16);
  User32.GetClientRect(User32.GetDesktopWindow(), rect.ptr!);
  const screenWidth = rect.readInt32LE(8);
  const screenHeight = rect.readInt32LE(12);
  User32.SetWindowPos(windowHandle, 0n, Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2)), Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2)), WINDOW_WIDTH, WINDOW_HEIGHT, SWP_SHOWWINDOW);

  // Windows 11: Mica backdrop + immersive dark frame, where supported.
  const backdrop = Buffer.alloc(4);
  backdrop.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
  Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdrop.ptr!, 4);
  const darkMode = Buffer.alloc(4);
  darkMode.writeInt32LE(1, 0);
  Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkMode.ptr!, 4);

  User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
  User32.UpdateWindow(windowHandle);
  return true;
}

// ── Boot, run, tear down ──────────────────────────────────────────────────────

console.log('Live Piano — hum a note and the piano plays it back.');
console.log('  • capture: Winmm.waveInOpen        (44.1 kHz mono 16-bit)');
console.log('  • detect : autocorrelation         (τ ∈ [40, 800])');
console.log('  • synth  : Xaudio2_9.XAudio2Create (fundamental + 2nd + 3rd harmonic)');
console.log('  • paint  : Gdiplus offscreen ARGB  (~60 fps)');
console.log('  Press ESC in the window to quit.');

// (QPF probe demonstrates Kernel32 access; its value is currently unused.)
const qpfBuffer = Buffer.alloc(8);
Kernel32.QueryPerformanceFrequency(qpfBuffer.ptr!);

let exitCode = 0;
try {
  startGdiplus();
  if (!createWindow()) throw new Error('Window creation failed.');
  if (!startSynth()) throw new Error('XAudio2 startup failed.');
  if (!startMicrophoneCapture()) {
    console.warn('Microphone capture unavailable — the visualization will still run.');
  }
  User32.SetTimer(windowHandle, TIMER_ID, FRAME_INTERVAL_MS, null);

  const msgBuffer = Buffer.alloc(48);
  while (true) {
    const result = User32.GetMessageW(msgBuffer.ptr!, 0n, 0, 0);
    if (result <= 0) break;
    User32.TranslateMessage(msgBuffer.ptr!);
    User32.DispatchMessageW(msgBuffer.ptr!);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  if (windowHandle !== 0n) User32.KillTimer(windowHandle, TIMER_ID);
  stopMicrophoneCapture();
  stopSynth();
  stopGdiplus();
  wndProc.close();
  process.exit(exitCode);
}
