/**
 * Bun Demoscene — a 75-second self-running music-synced demoscene production
 *
 * A flagship showcase for `@bun-win32/all`: pure TypeScript driving real Win32
 * APIs over `bun:ffi` to produce a borderless 1280x720 window with a procedurally
 * synthesized 2-bar looping 110 BPM track and five visual scenes crossfading on
 * the beat. No native addon. No Electron. No texture assets. Every pixel and
 * every sample is computed in JavaScript, every system call is a real Win32
 * import.
 *
 * Pipeline:
 *
 *   1. Ole32.CoInitialize                             — bootstrap the COM apartment
 *   2. Gdiplus.GdiplusStartup                         — bring up the GDI+ host
 *   3. User32.RegisterClassExW + CreateWindowExW      — borderless WS_POPUP window
 *   4. Dwmapi.DwmSetWindowAttribute                   — Mica backdrop + dark mode
 *   5. Xaudio2_9.XAudio2Create                        — engine + mastering voice
 *   6. IXAudio2::CreateSourceVoice + SubmitSourceBuffer — submit the synthesized track
 *   7. Synthesize ~75 s of stereo 16-bit PCM in JS    — kick, snare, FM lead, bass
 *   8. GDI+ render loop, 60 fps, all scenes:
 *        - Scene 1 TITLE      — beat-pulsing typography over sweeping gradient
 *        - Scene 2 TUNNEL     — perspective tunnel of rotating concentric rings
 *        - Scene 3 STARFIELD  — 1200 zooming 3D stars amplitude-modulated by RMS
 *        - Scene 4 METABALLS  — 5 moving 2D metaballs, isosurface shaded
 *        - Scene 5 CREDITS    — vertical scrolling typographic credit roll
 *   9. Each frame: IXAudio2SourceVoice::GetState      — drive time from the mixer
 *  10. GDI+ Graphics over a window HDC blits the bitmap                 each frame
 *  11. ESC / window close / SPACE skip / R restart input via WndProc
 *  12. DestroyVoice + Release + GdiplusShutdown                         cleanup
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / UnregisterClassW / CreateWindowExW / DestroyWindow
 *   - SetWindowLongPtrW (replace WndProc) / DefWindowProcW
 *   - PeekMessageW / TranslateMessage / DispatchMessageW / PostQuitMessage
 *   - ShowWindow / UpdateWindow / GetDC / ReleaseDC / GetClientRect
 *   - GetSystemMetrics                                                  (centering)
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute with DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW
 *   - DwmSetWindowAttribute with DWMWA_USE_IMMERSIVE_DARK_MODE
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateBitmapFromScan0 (32bppARGB owning its own pixel buffer)
 *   - GdipGetImageGraphicsContext (Graphics over the bitmap)
 *   - GdipCreateFromHDC (Graphics over the window HDC for blitting)
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - GdipGraphicsClear / GdipFillRectangleI / GdipFillEllipseI / GdipFillPath
 *   - GdipCreateSolidFill / GdipCreateLineBrushFromRectWithAngle / DeleteBrush
 *   - GdipCreatePath / GdipAddPathPolygon / GdipClosePathFigure / DeletePath
 *   - GdipCreatePen1 / GdipDrawLineI / GdipDeletePen
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipDrawString
 *   - GdipCreateStringFormat / GdipSetStringFormatAlign
 *   - GdipDrawImageRectI (blit the offscreen bitmap to the window)
 *   - GdipResetWorldTransform / GdipTranslateWorldTransform / GdipRotateWorldTransform
 *
 * APIs demonstrated (Xaudio2_9):
 *   - XAudio2Create (the flat export)
 *   - IXAudio2::CreateMasteringVoice / CreateSourceVoice                (COM vtable)
 *   - IXAudio2SourceVoice::SubmitSourceBuffer / Start / GetState        (COM vtable)
 *   - IXAudio2Voice::DestroyVoice                                       (COM vtable)
 *   - IUnknown::Release                                                 (COM vtable)
 *
 * APIs demonstrated (Ole32 / Kernel32):
 *   - Ole32.CoInitialize                                                (bootstrap COM)
 *   - Kernel32.GetModuleHandleW (HINSTANCE for the window class)
 *
 * Controls:
 *   - ESC                  close cleanly
 *   - SPACE                skip to next scene
 *   - R                    restart from the top
 *
 * Run: bun run example/demoscene.ts
 */

import { CFunction, FFIType, JSCallback, read, type Pointer } from 'bun:ffi';

import { Dwmapi, Gdiplus, Kernel32, Ole32, User32, Xaudio2_9 } from '../index';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FillMode, FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { ExtendedWindowStyles, PeekMessageRemoveFlag, ShowWindowCommand, SystemMetric, VirtualKey, WindowLongIndex, WindowStyles } from '@bun-win32/user32';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

// ── Window + render geometry ──────────────────────────────────────────────────

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 720;
const FRAME_BUDGET_MS = 16; // ~60 fps; the audio is the actual clock

// ── Audio + timeline configuration ────────────────────────────────────────────

const SAMPLE_RATE = 44_100;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = (CHANNELS * BITS_PER_SAMPLE) / 8;
const BEATS_PER_MINUTE = 110;
const BEAT_DURATION = 60 / BEATS_PER_MINUTE;
const BEATS_PER_BAR = 4;
const BAR_DURATION = BEATS_PER_BAR * BEAT_DURATION;
const TOTAL_BARS = 34; // ~74 seconds total
const TOTAL_DURATION = TOTAL_BARS * BAR_DURATION;
const TOTAL_SAMPLES = Math.ceil(TOTAL_DURATION * SAMPLE_RATE);

// Scene timing: five scenes, each holding for an equal slice of the timeline.
const SCENE_COUNT = 5;
const SCENE_DURATION = TOTAL_DURATION / SCENE_COUNT;
const CROSSFADE_DURATION = 1.25; // seconds of cross-fade at scene boundaries

// ── Win32 constants used by the message pump ──────────────────────────────────

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_QUIT = 0x0012;
const MSG_SIZE_BYTES = 48;

// IXAudio2 (IUnknown-derived) vtable slot order from xaudio2.h.
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;

const XAUDIO2_END_OF_STREAM = 0x0040;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const AudioCategory_GameEffects = 6;

// ── Small utilities ───────────────────────────────────────────────────────────

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// HSV → ARGB (alpha defaults to 0xff). h in [0,1], s/v in [0,1].
function hsvToArgb(h: number, s: number, v: number, alpha = 0xff): number {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return argb(alpha, Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

// ── COM vtable invoker (verbatim from the XAudio2 reference example) ─────────

const vtableInvokers = new Map<string, ReturnType<typeof CFunction>>();

function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = vtableInvokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    vtableInvokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

// ── Bootstrap COM, then the GDI+ host ─────────────────────────────────────────

console.log('Bun Demoscene — booting…');

const coHr = Ole32.CoInitialize(null);
if (coHr !== 0 && coHr !== 1 /* S_FALSE — already initialized */) {
  console.error(`CoInitialize failed: 0x${(coHr >>> 0).toString(16)}`);
  process.exit(1);
}

Gdiplus.Preload();
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
check(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// ── Procedural audio synthesis ────────────────────────────────────────────────

console.log(`Synthesizing ${TOTAL_DURATION.toFixed(1)} s of stereo 16-bit PCM at ${BEATS_PER_MINUTE} BPM…`);

const pcmBuffer = Buffer.alloc(TOTAL_SAMPLES * BLOCK_ALIGN);

// Pentatonic minor in A (Hz): A2, C3, D3, E3, G3, A3, C4, D4, E4, G4, A4, C5, D5, E5
const NOTE_TABLE = [110.0, 130.81, 146.83, 164.81, 196.0, 220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

// Two-bar arpeggio pattern (one note per sixteenth = 8 notes per bar).
const ARP_PATTERN = [10, 9, 8, 6, 8, 9, 10, 12, 10, 9, 8, 6, 8, 9, 10, 13];
const BASS_PATTERN = [0, 0, 0, 0, 3, 3, 3, 3, 1, 1, 1, 1, 4, 4, 4, 4];

// Kick: on beats 1 and 3 of every bar.
// Snare: on beats 2 and 4 of every bar.
// Hi-hat: every eighth note.

function kickDrum(time: number): number {
  // Exponentially-decaying low frequency sine with a pitch envelope.
  if (time < 0 || time > 0.4) return 0;
  const pitch = 110 * Math.exp(-time * 28) + 45;
  const phase = 2 * Math.PI * pitch * time;
  const envelope = Math.exp(-time * 9);
  return Math.sin(phase) * envelope * 0.95;
}

function snareDrum(time: number): number {
  // Filtered noise burst with a quick body tone.
  if (time < 0 || time > 0.25) return 0;
  const noise = (Math.random() * 2 - 1);
  const body = Math.sin(2 * Math.PI * 220 * time) * 0.3;
  const envelope = Math.exp(-time * 18);
  return (noise * 0.7 + body) * envelope * 0.55;
}

function hiHat(time: number): number {
  // High-frequency noise burst, very short.
  if (time < 0 || time > 0.08) return 0;
  const noise = (Math.random() * 2 - 1);
  const envelope = Math.exp(-time * 60);
  return noise * envelope * 0.25;
}

function fmLead(time: number, frequency: number, gateTime: number): number {
  // Two-operator FM with ADSR; brightens then mellows out as the carrier decays.
  if (time < 0 || time > gateTime + 0.5) return 0;
  const attackTime = 0.005;
  const releaseTime = 0.4;
  let envelope: number;
  if (time < attackTime) envelope = time / attackTime;
  else if (time > gateTime) envelope = Math.max(0, (gateTime + releaseTime - time) / releaseTime) ** 1.6;
  else envelope = 0.85;
  const modulatorEnv = Math.exp(-time * 2.5);
  const modulator = Math.sin(2 * Math.PI * frequency * 2 * time);
  return Math.sin(2 * Math.PI * frequency * time + 3.6 * modulatorEnv * modulator) * envelope * 0.40;
}

function bassNote(time: number, frequency: number, gateTime: number): number {
  // Plucked-square with low-pass behavior via a single-pole IIR isn't worth the
  // complexity here; instead, mix sine + lightly-saturated triangle.
  if (time < 0 || time > gateTime + 0.05) return 0;
  const envelope = Math.exp(-time * 4) * (time < gateTime ? 1 : Math.max(0, (gateTime + 0.05 - time) / 0.05));
  const sine = Math.sin(2 * Math.PI * frequency * time);
  const sawish = (2 / Math.PI) * Math.atan(Math.tan(Math.PI * frequency * time) * 0.6);
  return (sine * 0.6 + sawish * 0.3) * envelope * 0.55;
}

function pad(time: number, frequency: number, gateTime: number): number {
  // Slow, breathy sine-stack for the ambient bed.
  if (time < 0 || time > gateTime) return 0;
  const envelope = Math.min(1, time / 1.5) * Math.min(1, (gateTime - time) / 1.5);
  const tone = Math.sin(2 * Math.PI * frequency * time) * 0.45
    + Math.sin(2 * Math.PI * frequency * 2 * time) * 0.20
    + Math.sin(2 * Math.PI * frequency * 1.5 * time) * 0.15;
  return tone * envelope * 0.18;
}

const SIXTEENTH_DURATION = BEAT_DURATION / 4;

// Build a small event list, then rasterize it to PCM.
type Event = { startTime: number; render: (localTime: number) => number };
const events: Event[] = [];

for (let bar = 0; bar < TOTAL_BARS; bar++) {
  const barStart = bar * BAR_DURATION;

  // Drums: kick on 1 and 3, snare on 2 and 4, hat on every eighth.
  events.push({ startTime: barStart + 0 * BEAT_DURATION, render: kickDrum });
  events.push({ startTime: barStart + 2 * BEAT_DURATION, render: kickDrum });
  events.push({ startTime: barStart + 1 * BEAT_DURATION, render: snareDrum });
  events.push({ startTime: barStart + 3 * BEAT_DURATION, render: snareDrum });
  for (let eighth = 0; eighth < 8; eighth++) {
    events.push({ startTime: barStart + eighth * (BEAT_DURATION / 2), render: hiHat });
  }

  // Lead arpeggio: one note per sixteenth, after a brief intro silence.
  if (bar >= 2) {
    for (let sixteenth = 0; sixteenth < 16; sixteenth++) {
      const noteIndex = ARP_PATTERN[(bar * 16 + sixteenth) % ARP_PATTERN.length]!;
      const frequency = NOTE_TABLE[noteIndex]!;
      const gateTime = SIXTEENTH_DURATION * 0.9;
      const startTime = barStart + sixteenth * SIXTEENTH_DURATION;
      events.push({ startTime, render: (t) => fmLead(t, frequency, gateTime) });
    }
  }

  // Bass note: one per quarter, but only after bar 1.
  if (bar >= 1) {
    for (let quarter = 0; quarter < 4; quarter++) {
      const noteIndex = BASS_PATTERN[(bar * 4 + quarter) % BASS_PATTERN.length]!;
      const frequency = NOTE_TABLE[noteIndex]! * 0.5; // octave down
      const gateTime = BEAT_DURATION * 0.85;
      const startTime = barStart + quarter * BEAT_DURATION;
      events.push({ startTime, render: (t) => bassNote(t, frequency, gateTime) });
    }
  }

  // Pad: two-bar swells holding the tonic.
  if (bar % 2 === 0 && bar >= 4 && bar < TOTAL_BARS - 2) {
    const padFrequency = NOTE_TABLE[5]! * 0.5; // A2-ish
    events.push({ startTime: barStart, render: (t) => pad(t, padFrequency, BAR_DURATION * 2) });
  }
}

// Mix the event list into the PCM buffer. Scan events in time order so each
// sample only sums events whose footprint contains it.
events.sort((a, b) => a.startTime - b.startTime);

for (let i = 0; i < TOTAL_SAMPLES; i++) {
  const time = i / SAMPLE_RATE;
  let sample = 0;
  for (const event of events) {
    if (event.startTime > time) break;
    const localTime = time - event.startTime;
    if (localTime > 4) continue; // longest event tail
    sample += event.render(localTime);
  }
  // Stereo: widen pad and lead a touch by applying a tiny haas offset.
  const leftSample = sample;
  const rightSample = sample * 0.985 + Math.sin(time * 12) * sample * 0.015;
  const leftClamped = clamp(leftSample, -0.98, 0.98);
  const rightClamped = clamp(rightSample, -0.98, 0.98);
  pcmBuffer.writeInt16LE(Math.round(leftClamped * 32767), i * BLOCK_ALIGN);
  pcmBuffer.writeInt16LE(Math.round(rightClamped * 32767), i * BLOCK_ALIGN + 2);
}

console.log(`  ${(pcmBuffer.length / 1024 / 1024).toFixed(2)} MiB of PCM ready.`);

// ── XAudio2 boot ──────────────────────────────────────────────────────────────

const engineHandleBuffer = Buffer.alloc(8);
const createEngineHr = Xaudio2_9.XAudio2Create(engineHandleBuffer.ptr, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createEngineHr !== S_OK) {
  console.error(`XAudio2Create failed: 0x${(createEngineHr >>> 0).toString(16)}`);
  Gdiplus.GdiplusShutdown(gdiplusToken);
  process.exit(1);
}
const xaudio2Engine = engineHandleBuffer.readBigUInt64LE(0);

const masteringVoiceHandleBuffer = Buffer.alloc(8);
const masteringHr = vcall(
  xaudio2Engine,
  IXAUDIO2_CREATEMASTERINGVOICE,
  [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
  [masteringVoiceHandleBuffer.ptr, 0, 0, 0, null, null, AudioCategory_GameEffects],
);
let masteringVoice = 0n;
let sourceVoice = 0n;
const audioAvailable = masteringHr === S_OK;
if (audioAvailable) {
  masteringVoice = masteringVoiceHandleBuffer.readBigUInt64LE(0);

  // WAVEFORMATEX (18 bytes).
  const waveFormat = Buffer.alloc(18);
  waveFormat.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
  waveFormat.writeUInt16LE(CHANNELS, 2);
  waveFormat.writeUInt32LE(SAMPLE_RATE, 4);
  waveFormat.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 8); // nAvgBytesPerSec
  waveFormat.writeUInt16LE(BLOCK_ALIGN, 12);
  waveFormat.writeUInt16LE(BITS_PER_SAMPLE, 14);
  waveFormat.writeUInt16LE(0, 16);

  const sourceVoiceHandleBuffer = Buffer.alloc(8);
  const sourceHr = vcall(
    xaudio2Engine,
    IXAUDIO2_CREATESOURCEVOICE,
    [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    [sourceVoiceHandleBuffer.ptr, waveFormat.ptr, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null],
  );
  if (sourceHr === S_OK) {
    sourceVoice = sourceVoiceHandleBuffer.readBigUInt64LE(0);

    // XAUDIO2_BUFFER (48 bytes on x64).
    const xaudio2Buffer = Buffer.alloc(48);
    xaudio2Buffer.writeUInt32LE(XAUDIO2_END_OF_STREAM, 0);
    xaudio2Buffer.writeUInt32LE(pcmBuffer.length, 4);
    xaudio2Buffer.writeBigUInt64LE(BigInt(pcmBuffer.ptr), 8); // pAudioData — pcmBuffer must outlive playback
    vcall(sourceVoice, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [xaudio2Buffer.ptr, null]);
    vcall(sourceVoice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
  }
} else {
  console.log(`  (no audio endpoint — running visuals only; CreateMasteringVoice → 0x${(masteringHr >>> 0).toString(16)})`);
}

// ── Win32 window ──────────────────────────────────────────────────────────────

let shouldClose = false;
let skipSceneRequested = false;
let restartRequested = false;

const wndProcCallback = new JSCallback(
  (hWnd: bigint, msg: number, wParam: number | bigint, lParam: number | bigint): bigint => {
    if (msg === WM_KEYDOWN) {
      const virtualKey = Number(wParam);
      if (virtualKey === VirtualKey.VK_ESCAPE) {
        shouldClose = true;
        User32.PostQuitMessage(0);
        return 0n;
      }
      if (virtualKey === VirtualKey.VK_SPACE) {
        skipSceneRequested = true;
        return 0n;
      }
      if (virtualKey === 0x52 /* 'R' */) {
        restartRequested = true;
        return 0n;
      }
    }
    if (msg === WM_CLOSE) {
      shouldClose = true;
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_DESTROY) {
      User32.PostQuitMessage(0);
      return 0n;
    }
    return BigInt(User32.DefWindowProcW(hWnd, msg, BigInt(wParam), BigInt(lParam)));
  },
  { args: [FFIType.u64, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i64 },
);

const className = encodeWide('BunDemoscene');

// WNDCLASSEXW = 80 bytes on x64.
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProcCallback.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true); // cbClsExtra
wndClassView.setInt32(20, 0, true); // cbWndExtra
wndClassBuffer.writeBigUInt64LE(0n, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(0n, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground
wndClassBuffer.writeBigUInt64LE(0n, 56); // lpszMenuName
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
wndClassBuffer.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(wndClassBuffer.ptr);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const windowX = Math.floor((screenWidth - WINDOW_WIDTH) / 2);
const windowY = Math.floor((screenHeight - WINDOW_HEIGHT) / 2);

const moduleHandle = Kernel32.GetModuleHandleW(null!);

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  encodeWide('Bun Demoscene').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  0n,
  0n,
  moduleHandle,
  null,
);
if (!windowHandle) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// Apply Mica backdrop and dark mode through DWM.
const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);

// Bind our WndProc late (after the window is constructed) — see spirograph.
User32.SetWindowLongPtrW(windowHandle, WindowLongIndex.GWL_WNDPROC, BigInt(wndProcCallback.ptr!));

// ── Offscreen GDI+ bitmap + Graphics ──────────────────────────────────────────

const bitmapHandleBuffer = Buffer.alloc(8);
check(
  Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr),
  'GdipCreateBitmapFromScan0',
);
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const offscreenGraphicsHandleBuffer = Buffer.alloc(8);
check(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, offscreenGraphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = offscreenGraphicsHandleBuffer.readBigUInt64LE(0);

check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

// Pre-allocate the font family + the three sizes of font we use across scenes.
const fontFamilyHandleBuffer = Buffer.alloc(8);
const fontFamilyName = encodeWide('Segoe UI');
check(Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr, 0n, fontFamilyHandleBuffer.ptr), 'GdipCreateFontFamilyFromName');
const fontFamily = fontFamilyHandleBuffer.readBigUInt64LE(0);

function makeFont(sizePx: number, style: FontStyle): bigint {
  const buffer = Buffer.alloc(8);
  check(Gdiplus.GdipCreateFont(fontFamily, sizePx, style, Unit.UnitPixel, buffer.ptr), `GdipCreateFont(${sizePx})`);
  return buffer.readBigUInt64LE(0);
}

const titleFont = makeFont(108, FontStyle.FontStyleBold);
const subtitleFont = makeFont(28, FontStyle.FontStyleRegular);
const bodyFont = makeFont(34, FontStyle.FontStyleRegular);
const creditsHeaderFont = makeFont(64, FontStyle.FontStyleBold);

const centerStringFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, centerStringFormatBuffer.ptr), 'GdipCreateStringFormat');
const centerStringFormat = centerStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);
Gdiplus.GdipSetStringFormatLineAlign(centerStringFormat, StringAlignment.StringAlignmentCenter);

const leftStringFormatBuffer = Buffer.alloc(8);
check(Gdiplus.GdipCreateStringFormat(0, 0, leftStringFormatBuffer.ptr), 'GdipCreateStringFormat (left)');
const leftStringFormat = leftStringFormatBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(leftStringFormat, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(leftStringFormat, StringAlignment.StringAlignmentNear);

// Reusable buffers passed by reference to GDI+ on every frame. Allocating them
// once and rewriting them per call keeps GC out of the render loop.
const reusableRect = Buffer.alloc(16);
const reusablePolygonBuffer = Buffer.alloc(2048 * 4); // up to 1024 (x,y) float pairs
const voiceStateBuffer = Buffer.alloc(24); // XAUDIO2_VOICE_STATE

function writeRect(x: number, y: number, w: number, h: number): Pointer {
  reusableRect.writeFloatLE(x, 0);
  reusableRect.writeFloatLE(y, 4);
  reusableRect.writeFloatLE(w, 8);
  reusableRect.writeFloatLE(h, 12);
  return reusableRect.ptr;
}

// ── Quick brush/font draw helpers that own their handles for the call. ────────

function fillRectArgb(graphics: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangleI(graphics, brush, x, y, width, height);
  Gdiplus.GdipDeleteBrush(brush);
}

function fillEllipseArgb(graphics: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillEllipseI(graphics, brush, x, y, width, height);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawCenteredText(graphics: bigint, text: string, font: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  const wideText = encodeWide(text);
  const rectPtr = writeRect(x, y, width, height);
  Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, font, rectPtr, centerStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawLeftText(graphics: bigint, text: string, font: bigint, x: number, y: number, width: number, height: number, color: number): void {
  const brushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushBuffer.ptr);
  const brush = brushBuffer.readBigUInt64LE(0);
  const wideText = encodeWide(text);
  const rectPtr = writeRect(x, y, width, height);
  Gdiplus.GdipDrawString(graphics, wideText.ptr, -1, font, rectPtr, leftStringFormat, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

// ── Starfield pre-allocated state ─────────────────────────────────────────────

const STARFIELD_COUNT = 1200;
const starfield = new Float32Array(STARFIELD_COUNT * 4); // x, y, z, brightness

function resetStarfield(): void {
  for (let i = 0; i < STARFIELD_COUNT; i++) {
    starfield[i * 4 + 0] = (Math.random() - 0.5) * 2;
    starfield[i * 4 + 1] = (Math.random() - 0.5) * 2;
    starfield[i * 4 + 2] = Math.random();
    starfield[i * 4 + 3] = 0.5 + Math.random() * 0.5;
  }
}
resetStarfield();

// ── Scene renderers ───────────────────────────────────────────────────────────

function renderSceneTitle(graphics: bigint, sceneTime: number, _beatProgress: number, beatPulse: number, currentBar: number): void {
  // Sweeping background gradient: hue drifts with bar number.
  const baseHue = (currentBar * 0.05) % 1;
  const topColor = hsvToArgb(baseHue, 0.65, 0.18);
  const bottomColor = hsvToArgb((baseHue + 0.12) % 1, 0.50, 0.08);
  const gradientBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT), topColor, bottomColor, 90.0, 1, 0, gradientBrushBuffer.ptr);
  const gradientBrush = gradientBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, gradientBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(gradientBrush);

  // Diagonal accent stripes that travel with time.
  for (let stripe = 0; stripe < 18; stripe++) {
    const stripePhase = (sceneTime * 0.08 + stripe / 18) % 1;
    const alpha = Math.round(35 + 30 * Math.sin(stripePhase * Math.PI * 2));
    const stripeX = Math.floor((stripePhase - 0.1) * (WINDOW_WIDTH + 200));
    fillRectArgb(graphics, stripeX, 0, 90, WINDOW_HEIGHT, argb(alpha, 0xff, 0xff, 0xff));
  }

  // Big circle accent behind the title — beat-pulse.
  const ringRadius = 290 + beatPulse * 40;
  for (let ring = 0; ring < 6; ring++) {
    const ringAlpha = Math.round(40 - ring * 5);
    fillEllipseArgb(
      graphics,
      WINDOW_WIDTH / 2 - ringRadius - ring * 18,
      WINDOW_HEIGHT / 2 - ringRadius - ring * 18,
      (ringRadius + ring * 18) * 2,
      (ringRadius + ring * 18) * 2,
      argb(ringAlpha, 0xff, 0xc8, 0xa6),
    );
  }

  // Title with a soft scale pulse on the beat.
  const titleScale = 1 + beatPulse * 0.05;
  Gdiplus.GdipResetWorldTransform(graphics);
  Gdiplus.GdipTranslateWorldTransform(graphics, WINDOW_WIDTH / 2, WINDOW_HEIGHT / 2 - 30, 0);
  Gdiplus.GdipScaleWorldTransform(graphics, titleScale, titleScale, 0);
  Gdiplus.GdipTranslateWorldTransform(graphics, -WINDOW_WIDTH / 2, -(WINDOW_HEIGHT / 2 - 30), 0);
  // Drop shadow.
  drawCenteredText(graphics, 'bun demoscene', titleFont, 6, WINDOW_HEIGHT / 2 - 130 + 6, WINDOW_WIDTH, 200, argb(160, 0, 0, 0));
  drawCenteredText(graphics, 'bun demoscene', titleFont, 0, WINDOW_HEIGHT / 2 - 130, WINDOW_WIDTH, 200, argb(255, 0xff, 0xee, 0xd6));
  Gdiplus.GdipResetWorldTransform(graphics);

  // Subtitle.
  const subtitleAlpha = Math.round(160 + 60 * Math.sin(sceneTime * 1.5));
  drawCenteredText(
    graphics,
    'typescript  •  bun ffi  •  zero deps  •  every byte through bun:ffi',
    subtitleFont,
    0,
    WINDOW_HEIGHT / 2 + 80,
    WINDOW_WIDTH,
    80,
    argb(subtitleAlpha, 0xff, 0xff, 0xff),
  );

  // Footer hint.
  drawCenteredText(
    graphics,
    'esc  quit       space  next scene       r  restart',
    subtitleFont,
    0,
    WINDOW_HEIGHT - 90,
    WINDOW_WIDTH,
    40,
    argb(140, 0xff, 0xff, 0xff),
  );
}

function renderSceneTunnel(graphics: bigint, sceneTime: number, _beatProgress: number, beatPulse: number, currentBar: number): void {
  // Deep base.
  fillRectArgb(graphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(255, 6, 4, 14));

  const centerX = WINDOW_WIDTH / 2;
  const centerY = WINDOW_HEIGHT / 2;
  const RING_COUNT = 38;
  const cameraSpeed = sceneTime * 0.45;

  for (let i = RING_COUNT - 1; i >= 0; i--) {
    // Each ring's depth z modulates by camera speed and the original index.
    const depth = (i / RING_COUNT - cameraSpeed) % 1;
    const z = depth < 0 ? depth + 1 : depth;
    const radius = WINDOW_HEIGHT / (z * 1.8 + 0.05);
    if (radius < 4 || radius > WINDOW_WIDTH) continue;

    const hue = ((currentBar * 0.07) + i * 0.04 + sceneTime * 0.05) % 1;
    const brightness = Math.max(0.15, 1 - z) * (0.7 + beatPulse * 0.3);
    const alpha = Math.max(0, Math.min(255, Math.round(255 * (1 - z))));

    // Twist the ring with depth so the tunnel feels like it's rotating.
    const wobble = Math.sin(sceneTime * 2 + i * 0.2) * 30 * (1 - z);

    const ringColor = hsvToArgb(hue, 0.85, brightness, alpha);
    const innerColor = hsvToArgb((hue + 0.1) % 1, 0.7, brightness * 0.8, Math.max(0, alpha - 80));

    fillEllipseArgb(
      graphics,
      Math.round(centerX - radius + wobble),
      Math.round(centerY - radius),
      Math.round(radius * 2),
      Math.round(radius * 2),
      ringColor,
    );
    const innerRadius = radius * 0.78;
    fillEllipseArgb(
      graphics,
      Math.round(centerX - innerRadius + wobble * 0.9),
      Math.round(centerY - innerRadius),
      Math.round(innerRadius * 2),
      Math.round(innerRadius * 2),
      innerColor,
    );
  }

  // Vignette + scanline atmosphere bar.
  const vignetteBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(
    writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT),
    argb(180, 0, 0, 0),
    argb(0, 0, 0, 0),
    0.0,
    1,
    0,
    vignetteBrushBuffer.ptr,
  );
  const vignetteBrush = vignetteBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, vignetteBrush, 0, 0, WINDOW_WIDTH, 160);
  Gdiplus.GdipDeleteBrush(vignetteBrush);

  drawLeftText(graphics, '02 / tunnel', bodyFont, 40, 36, 400, 60, argb(220, 0xff, 0xff, 0xff));
}

function renderSceneStarfield(graphics: bigint, sceneTime: number, _beatProgress: number, beatPulse: number, audioRms: number): void {
  fillRectArgb(graphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(255, 4, 6, 12));

  const centerX = WINDOW_WIDTH / 2;
  const centerY = WINDOW_HEIGHT / 2;
  const baseSpeed = 0.018 + audioRms * 0.06;

  for (let i = 0; i < STARFIELD_COUNT; i++) {
    starfield[i * 4 + 2] -= baseSpeed;
    if (starfield[i * 4 + 2]! <= 0.01) {
      // Recycle: pick a new direction, full depth.
      starfield[i * 4 + 0] = (Math.random() - 0.5) * 2;
      starfield[i * 4 + 1] = (Math.random() - 0.5) * 2;
      starfield[i * 4 + 2] = 1;
      starfield[i * 4 + 3] = 0.5 + Math.random() * 0.5;
    }
  }

  for (let i = 0; i < STARFIELD_COUNT; i++) {
    const z = starfield[i * 4 + 2]!;
    const screenX = centerX + (starfield[i * 4 + 0]! / z) * (WINDOW_WIDTH / 2);
    const screenY = centerY + (starfield[i * 4 + 1]! / z) * (WINDOW_HEIGHT / 2);
    if (screenX < -16 || screenX > WINDOW_WIDTH + 16 || screenY < -16 || screenY > WINDOW_HEIGHT + 16) continue;

    const brightness = (1 - z) * starfield[i * 4 + 3]!;
    const size = clamp((1 - z) * 5 + beatPulse * 1.5, 1, 7);
    const hue = (sceneTime * 0.02 + i * 0.00005) % 1;
    const color = hsvToArgb(hue, 0.25, clamp(brightness * 1.5, 0, 1));
    fillEllipseArgb(
      graphics,
      Math.round(screenX - size / 2),
      Math.round(screenY - size / 2),
      Math.round(size),
      Math.round(size),
      color,
    );

    // Trailing streak for stars that are close to camera.
    if (z < 0.35) {
      const tailX = centerX + (starfield[i * 4 + 0]! / (z + 0.06)) * (WINDOW_WIDTH / 2);
      const tailY = centerY + (starfield[i * 4 + 1]! / (z + 0.06)) * (WINDOW_HEIGHT / 2);
      const penBuffer = Buffer.alloc(8);
      Gdiplus.GdipCreatePen1(argb(Math.round(brightness * 200), 0xff, 0xff, 0xff), 1.0 + (1 - z) * 1.5, Unit.UnitPixel, penBuffer.ptr);
      const pen = penBuffer.readBigUInt64LE(0);
      Gdiplus.GdipDrawLineI(graphics, pen, Math.round(screenX), Math.round(screenY), Math.round(tailX), Math.round(tailY));
      Gdiplus.GdipDeletePen(pen);
    }
  }

  drawLeftText(graphics, '03 / starfield', bodyFont, 40, 36, 400, 60, argb(220, 0xff, 0xff, 0xff));
}

function renderSceneMetaballs(graphics: bigint, sceneTime: number, _beatProgress: number, beatPulse: number, audioRms: number): void {
  fillRectArgb(graphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(255, 8, 10, 20));

  type Ball = { x: number; y: number; radius: number; hue: number };
  const ballCount = 5;
  const balls: Ball[] = [];
  for (let i = 0; i < ballCount; i++) {
    const phase = sceneTime * 0.6 + (i * Math.PI * 2) / ballCount;
    balls.push({
      x: WINDOW_WIDTH / 2 + Math.cos(phase) * (220 + 50 * Math.sin(sceneTime * 0.3 + i)),
      y: WINDOW_HEIGHT / 2 + Math.sin(phase * 1.3) * (170 + 40 * Math.cos(sceneTime * 0.4 + i)),
      radius: 110 + 25 * Math.sin(sceneTime * 1.7 + i) + audioRms * 80,
      hue: (i / ballCount + sceneTime * 0.05) % 1,
    });
  }

  // Pseudo-isosurface: sample on a coarse grid and render shaded cells.
  // 1280x720 / 16 = 80x45 grid (3600 cells). Each cell is a filled rectangle.
  const CELL = 14;
  const gridW = Math.ceil(WINDOW_WIDTH / CELL);
  const gridH = Math.ceil(WINDOW_HEIGHT / CELL);

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const cx = gx * CELL + CELL / 2;
      const cy = gy * CELL + CELL / 2;
      let field = 0;
      let hueAccum = 0;
      let weightedHueDenom = 0;
      for (const ball of balls) {
        const dx = cx - ball.x;
        const dy = cy - ball.y;
        const distSq = dx * dx + dy * dy + 1;
        const contribution = (ball.radius * ball.radius) / distSq;
        field += contribution;
        hueAccum += contribution * ball.hue;
        weightedHueDenom += contribution;
      }
      if (field < 0.55) continue;
      const intensity = clamp((field - 0.55) * 1.4, 0, 1);
      const hue = weightedHueDenom > 0 ? hueAccum / weightedHueDenom : 0;
      const inIso = field > 1.0;
      const valueLevel = inIso ? 0.55 + intensity * 0.40 : 0.18 + intensity * 0.20;
      const saturation = inIso ? 0.55 + beatPulse * 0.2 : 0.25;
      const color = hsvToArgb(hue, saturation, valueLevel);
      fillRectArgb(graphics, gx * CELL, gy * CELL, CELL, CELL, color);
    }
  }

  drawLeftText(graphics, '04 / metaballs', bodyFont, 40, 36, 400, 60, argb(220, 0xff, 0xff, 0xff));
}

const CREDITS_LINES: string[] = [
  '',
  '',
  '',
  '',
  '',
  '',
  'bun demoscene',
  '',
  'a demo of @bun-win32',
  '',
  '',
  '— rendered with —',
  '',
  'User32     window + message pump',
  'Dwmapi     mica backdrop + dark mode',
  'Gdiplus    bitmap + graphics + fonts',
  'Xaudio2_9  realtime audio mix',
  'Kernel32   module handle',
  'Ole32      com apartment',
  '',
  '',
  '— made of —',
  '',
  'one TypeScript file',
  'zero native modules',
  'zero texture assets',
  'every sample synthesized in js',
  'every pixel drawn through bun:ffi',
  '',
  '',
  '— credits —',
  '',
  'bun:ffi',
  'win32 platform',
  'GDI+ and DWM',
  'XAudio2',
  '',
  '',
  '',
  'built on bun on windows',
  '',
  '',
  '',
  'thanks for watching',
  '',
  '',
  '',
  '',
  '',
];

function renderSceneCredits(graphics: bigint, sceneTime: number, _beatProgress: number, _beatPulse: number, _audioRms: number): void {
  // Gradient backdrop (deep blue → black) for the credit roll.
  const gradientBrushBuffer = Buffer.alloc(8);
  Gdiplus.GdipCreateLineBrushFromRectWithAngle(
    writeRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT),
    argb(255, 12, 14, 28),
    argb(255, 4, 4, 12),
    90.0,
    1,
    0,
    gradientBrushBuffer.ptr,
  );
  const gradientBrush = gradientBrushBuffer.readBigUInt64LE(0);
  Gdiplus.GdipFillRectangle(graphics, gradientBrush, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  Gdiplus.GdipDeleteBrush(gradientBrush);

  // The roll: lines move upward at a steady speed; total scroll distance is sized
  // so the whole list passes through over the duration of the scene.
  const lineHeight = 48;
  const totalRollHeight = CREDITS_LINES.length * lineHeight;
  const scroll = sceneTime * 78; // pixels per second
  for (let i = 0; i < CREDITS_LINES.length; i++) {
    const y = WINDOW_HEIGHT - scroll + i * lineHeight;
    if (y < -lineHeight || y > WINDOW_HEIGHT + lineHeight) continue;
    const isHeader = CREDITS_LINES[i]!.startsWith('—') || CREDITS_LINES[i] === 'bun demoscene' || CREDITS_LINES[i] === 'a demo of @bun-win32';
    const isBigHeader = CREDITS_LINES[i] === 'bun demoscene';

    // Smooth fade as lines approach edges of the screen.
    const distanceFromCenter = Math.abs(y - WINDOW_HEIGHT / 2) / (WINDOW_HEIGHT / 2);
    const alpha = Math.round(255 * smoothstep(1.0, 0.6, distanceFromCenter));
    if (alpha <= 0) continue;

    if (isBigHeader) {
      drawCenteredText(graphics, CREDITS_LINES[i]!, creditsHeaderFont, 0, y - 24, WINDOW_WIDTH, 80, argb(alpha, 0xff, 0xee, 0xd6));
    } else if (isHeader) {
      drawCenteredText(graphics, CREDITS_LINES[i]!, bodyFont, 0, y, WINDOW_WIDTH, 60, argb(alpha, 0xff, 0xb8, 0x7a));
    } else {
      drawCenteredText(graphics, CREDITS_LINES[i]!, bodyFont, 0, y, WINDOW_WIDTH, 60, argb(alpha, 0xff, 0xff, 0xff));
    }
  }

  drawLeftText(graphics, '05 / credits', bodyFont, 40, 36, 400, 60, argb(180, 0xff, 0xff, 0xff));

  void totalRollHeight; // referenced for clarity; the scroll wraps via the smoothstep fade.
}

// ── Frame composition ─────────────────────────────────────────────────────────

// A render-pass dispatch table indexed by the scene number.
const sceneRenderers = [
  renderSceneTitle,
  renderSceneTunnel,
  renderSceneStarfield,
  renderSceneMetaballs,
  renderSceneCredits,
];

function renderFrame(currentTime: number, samplesPlayed: number, audioRms: number): void {
  // Clear the offscreen bitmap to the dark base color (the DWM Mica backdrop
  // shows through transparent areas, but with WS_POPUP without WS_EX_LAYERED
  // we paint the whole client area each frame anyway).
  Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 8, 8, 16));

  const sceneIndex = Math.min(SCENE_COUNT - 1, Math.floor(currentTime / SCENE_DURATION));
  const sceneStartTime = sceneIndex * SCENE_DURATION;
  const sceneTime = currentTime - sceneStartTime;
  const nextSceneIndex = Math.min(SCENE_COUNT - 1, sceneIndex + 1);

  // Beat-derived intensity (1.0 immediately after the beat, decays exponentially).
  const beatPhase = (currentTime % BEAT_DURATION) / BEAT_DURATION;
  const beatPulse = Math.exp(-beatPhase * 5);
  const beatProgress = beatPhase;
  const currentBar = Math.floor(currentTime / BAR_DURATION);

  // Render the current scene. At scene boundaries, veil with a translucent
  // black layer whose alpha decays over CROSSFADE_DURATION so the new scene
  // fades in from black. Likewise, the last CROSSFADE_DURATION of every scene
  // fades back to black, giving the visual rhythm of a tape-cut between scenes.
  sceneRenderers[sceneIndex]!(offscreenGraphics, sceneTime, beatProgress, beatPulse, audioRms);
  void nextSceneIndex;

  if (sceneIndex > 0 && sceneTime < CROSSFADE_DURATION) {
    const fadeAlpha = Math.round((1 - sceneTime / CROSSFADE_DURATION) * 255);
    fillRectArgb(offscreenGraphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(fadeAlpha, 0, 0, 0));
  }
  const timeLeftInScene = SCENE_DURATION - sceneTime;
  if (sceneIndex < SCENE_COUNT - 1 && timeLeftInScene < CROSSFADE_DURATION) {
    const fadeAlpha = Math.round((1 - timeLeftInScene / CROSSFADE_DURATION) * 255);
    fillRectArgb(offscreenGraphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(fadeAlpha, 0, 0, 0));
  }

  // Tiny HUD: t, scene, samples played.
  const elapsedSeconds = currentTime;
  const remaining = TOTAL_DURATION - elapsedSeconds;
  const hud = `t ${elapsedSeconds.toFixed(2)}s   bar ${currentBar.toString().padStart(2, ' ')}/${TOTAL_BARS}   samples ${samplesPlayed}   remaining ${remaining.toFixed(1)}s`;
  drawLeftText(offscreenGraphics, hud, subtitleFont, 32, WINDOW_HEIGHT - 56, WINDOW_WIDTH - 64, 40, argb(120, 0xff, 0xff, 0xff));

  // Final fade-to-black during the last second of the timeline.
  if (remaining < 1.5) {
    const fade = clamp((1.5 - remaining) / 1.5, 0, 1);
    fillRectArgb(offscreenGraphics, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, argb(Math.round(fade * 255), 0, 0, 0));
  }

  blitToWindow();
}

function blitToWindow(): void {
  const windowDc = User32.GetDC(windowHandle);
  if (!windowDc) return;
  const windowGraphicsHandleBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(windowDc, windowGraphicsHandleBuffer.ptr) === Status.Ok) {
    const windowGraphics = windowGraphicsHandleBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(windowGraphics, offscreenBitmap, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(windowGraphics);
  }
  User32.ReleaseDC(windowHandle, windowDc);
}

// ── Time control ──────────────────────────────────────────────────────────────

const startedAtMs = Date.now();
let sceneOffsetSeconds = 0; // accumulates when user presses SPACE to skip
let restartFlagAt: number | null = null;

function getCurrentTime(): { currentTime: number; samplesPlayed: number; audioRms: number } {
  // If audio is playing, get the time directly from the mixer. Otherwise, derive
  // it from the wall clock since startedAtMs.
  let samplesPlayed = 0;
  if (audioAvailable && sourceVoice) {
    vcall(sourceVoice, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [voiceStateBuffer.ptr, 0], FFIType.void);
    samplesPlayed = Number(voiceStateBuffer.readBigUInt64LE(16));
  } else {
    const wallClockSeconds = (Date.now() - startedAtMs) / 1000;
    samplesPlayed = Math.min(TOTAL_SAMPLES, Math.floor(wallClockSeconds * SAMPLE_RATE));
  }
  const baseTime = samplesPlayed / SAMPLE_RATE;
  const currentTime = clamp(baseTime + sceneOffsetSeconds, 0, TOTAL_DURATION);

  // Compute a fast RMS over the previous 1024 samples to drive amplitude-reactive
  // visuals.
  const sampleWindow = 1024;
  const startSample = Math.max(0, samplesPlayed - sampleWindow);
  let sumSquares = 0;
  let usedSamples = 0;
  for (let i = startSample; i < samplesPlayed && i < TOTAL_SAMPLES; i += 4) {
    const leftSample = pcmBuffer.readInt16LE(i * BLOCK_ALIGN) / 32768;
    sumSquares += leftSample * leftSample;
    usedSamples++;
  }
  const audioRms = usedSamples > 0 ? Math.sqrt(sumSquares / usedSamples) : 0;
  void restartFlagAt;
  return { currentTime, samplesPlayed, audioRms };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const messageBuffer = Buffer.alloc(MSG_SIZE_BYTES);
const messageDataView = new DataView(messageBuffer.buffer);

console.log('Demoscene running. ESC closes the window.');

let lastFrameMs = Date.now();

while (!shouldClose) {
  // Drain messages without blocking.
  while (User32.PeekMessageW(messageBuffer.ptr, 0n, 0, 0, PeekMessageRemoveFlag.PM_REMOVE)) {
    const messageId = messageDataView.getUint32(8, true);
    if (messageId === WM_QUIT) {
      shouldClose = true;
      break;
    }
    User32.TranslateMessage(messageBuffer.ptr);
    User32.DispatchMessageW(messageBuffer.ptr);
  }
  if (shouldClose) break;

  // Handle keyboard shortcuts (set asynchronously inside the WndProc callback).
  if (skipSceneRequested) {
    skipSceneRequested = false;
    const { currentTime } = getCurrentTime();
    const sceneIndex = Math.min(SCENE_COUNT - 1, Math.floor(currentTime / SCENE_DURATION));
    const nextSceneStart = (sceneIndex + 1) * SCENE_DURATION;
    // Skipping just shifts the time-display forward. Audio keeps playing in
    // place — visuals jump.
    sceneOffsetSeconds += nextSceneStart - currentTime + 0.05;
  }
  if (restartRequested) {
    restartRequested = false;
    sceneOffsetSeconds = -((Date.now() - startedAtMs) / 1000);
    resetStarfield();
  }

  // Pull current time + audio amplitude from the mixer.
  const { currentTime, samplesPlayed, audioRms } = getCurrentTime();

  // Stop once the timeline is exhausted; if no audio, also stop after duration.
  if (currentTime >= TOTAL_DURATION - 0.02) {
    // Render one final black frame, then exit.
    Gdiplus.GdipGraphicsClear(offscreenGraphics, argb(255, 0, 0, 0));
    drawCenteredText(offscreenGraphics, 'fin.', titleFont, 0, WINDOW_HEIGHT / 2 - 100, WINDOW_WIDTH, 200, argb(220, 0xff, 0xff, 0xff));
    blitToWindow();
    Bun.sleepSync(700);
    shouldClose = true;
    break;
  }

  renderFrame(currentTime, samplesPlayed, audioRms);

  // Frame pacing: aim for ~60 fps without burning the CPU.
  const elapsedMs = Date.now() - lastFrameMs;
  const sleepMs = FRAME_BUDGET_MS - elapsedMs;
  if (sleepMs > 1) Bun.sleepSync(sleepMs);
  lastFrameMs = Date.now();
}

// ── Teardown ──────────────────────────────────────────────────────────────────

console.log('Cleaning up…');

if (audioAvailable && sourceVoice) vcall(sourceVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
if (audioAvailable && masteringVoice) vcall(masteringVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
if (xaudio2Engine) vcall(xaudio2Engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);

Gdiplus.GdipDeleteStringFormat(centerStringFormat);
Gdiplus.GdipDeleteStringFormat(leftStringFormat);
Gdiplus.GdipDeleteFont(titleFont);
Gdiplus.GdipDeleteFont(subtitleFont);
Gdiplus.GdipDeleteFont(bodyFont);
Gdiplus.GdipDeleteFont(creditsHeaderFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (windowHandle) User32.DestroyWindow(windowHandle);
User32.UnregisterClassW(className.ptr, 0n);
wndProcCallback.close();

// Note: Ole32 in this workspace exposes CoInitialize but not CoUninitialize; the
// COM apartment cleans up on process exit. No leak — the process is dying.

console.log('Done.');
