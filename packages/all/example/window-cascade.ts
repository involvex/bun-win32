/**
 * Window Cascade — every visible window on your desktop dances to a beat.
 *
 * Enumerates every visible top-level window on the desktop with `EnumWindows`,
 * boots a real `IXAudio2_9` engine with a 16-second 90 BPM loop synthesized in
 * JS (kick + snare + hi-hat into a 16-bit PCM buffer, submitted once with
 * `LoopCount = XAUDIO2_LOOP_INFINITE`), then on every frame uses the playback
 * cursor reported by `IXAudio2SourceVoice::GetState` to compute a beat phase
 * and nudges each tracked window by `±8 px` in a Lissajous figure with a
 * per-window phase delay so the whole desktop cascades like a rolling wave.
 *
 * A small Mica-backed status overlay (DWM acrylic + immersive dark mode, GDI+
 * paint) renders the BPM, the dancing-window count, the first eight titles,
 * and a pulsing beat indicator that flashes on every kick. Pressing ESC,
 * right-clicking the overlay, or Ctrl+C in the terminal all funnel through a
 * single `cleanup()` path that:
 *
 *   1. Restores every tracked window to its captured pre-dance rectangle via
 *      one final `SetWindowPos` per window (this is CRITICAL: we must not
 *      leave the user's apps misaligned).
 *   2. Stops + destroys the XAudio2 source / mastering voices and releases the
 *      `IXAudio2` engine cleanly.
 *   3. Tears down the overlay window, GDI+, and the WCT/SetConsoleCtrlHandler
 *      JSCallbacks.
 *
 * Pipeline:
 *
 *   1. User32.EnumWindows                       — collect candidate HWNDs
 *      └ filter: IsWindowVisible · GetWindowTextLengthW>0 · class not in
 *               {Progman, WorkerW, Shell_TrayWnd, NotifyIconOverflowWindow}
 *      └ snapshot: GetWindowRect → originalRect
 *   2. Xaudio2_9.XAudio2Create                  — bootstrap real engine
 *   3. IXAudio2::CreateMasteringVoice           — default endpoint
 *   4. (synthesize 4-bar 90 BPM kick/snare/hat) — 16 s @ 44.1 kHz mono i16
 *   5. IXAudio2::CreateSourceVoice              — 16-bit PCM voice
 *   6. IXAudio2SourceVoice::SubmitSourceBuffer  — LoopCount = INFINITE
 *   7. IXAudio2SourceVoice::Start               — begin playback
 *   8. SetTimer ~60 fps tick → GetState → beat phase → SetWindowPos cascade
 *      and Mica overlay repaint via GDI+ + BitBlt.
 *   9. ESC / Ctrl+C / WM_CLOSE → restore every window + teardown audio.
 *
 * Safety:
 *   - Maximum nudge is ±8 px on x and ±4 px on y (a wiggle, not a relocation).
 *   - Original positions are captured once at startup and replayed on exit.
 *   - SetWindowPos uses SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS
 *     so we never resize, reorder z, steal focus, or block on slow apps.
 *
 * APIs demonstrated (User32):
 *   - EnumWindows · IsWindowVisible · GetWindowTextLengthW · GetWindowTextW
 *   - GetClassNameW · GetWindowRect · GetWindowThreadProcessId · GetForegroundWindow
 *   - RegisterClassExW · CreateWindowExW · DestroyWindow · UnregisterClassW
 *   - SetWindowPos (with SWP_ASYNCWINDOWPOS) · SetLayeredWindowAttributes
 *   - SetTimer · KillTimer · GetMessageW · TranslateMessage · DispatchMessageW
 *   - DefWindowProcW · PostMessageW · PostQuitMessage · ShowWindow · UpdateWindow
 *   - GetDC · ReleaseDC · GetSystemMetrics
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute (DWMWA_SYSTEMBACKDROP_TYPE / DWMWA_USE_IMMERSIVE_DARK_MODE)
 *   - DwmExtendFrameIntoClientArea
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateFromHDC · GdipSetSmoothingMode · GdipSetTextRenderingHint
 *   - GdipCreateSolidFill · GdipCreatePen1 · GdipCreateFontFamilyFromName
 *   - GdipCreateFont · GdipCreateStringFormat · GdipSetStringFormatAlign
 *   - GdipSetStringFormatLineAlign · GdipDrawString · GdipFillRectangle
 *   - GdipFillEllipse · GdipDrawLine · GdipGraphicsClear · GdipDeleteBrush
 *   - GdipDeletePen · GdipDeleteFont · GdipDeleteFontFamily
 *   - GdipDeleteStringFormat · GdipDeleteGraphics
 *
 * APIs demonstrated (GDI32):
 *   - CreateCompatibleDC · CreateDIBSection · SelectObject · DeleteObject
 *   - DeleteDC · BitBlt
 *
 * APIs demonstrated (Xaudio2_9):
 *   - XAudio2Create + IXAudio2 / IXAudio2SourceVoice COM vtable
 *     (CreateMasteringVoice, CreateSourceVoice, SubmitSourceBuffer, Start,
 *      Stop, GetState, DestroyVoice, Release)
 *
 * APIs demonstrated (Kernel32):
 *   - SetConsoleCtrlHandler (via JSCallback) for graceful ^C teardown
 *
 * Run: bun run example/window-cascade.ts        (Press ESC to stop the dance.)
 */

import { CFunction, FFIType, JSCallback, type Pointer, read } from 'bun:ffi';

import { Dwmapi, GDI32, Gdiplus, Kernel32, User32, Xaudio2_9 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

// ── Constants ────────────────────────────────────────────────────────────────

const NULL = 0n;
const NULL_POINTER = null as unknown as Pointer;
const encode = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_RBUTTONDOWN = 0x0204;
const WM_NCRBUTTONDOWN = 0x00a4;
const WM_NCHITTEST = 0x0084;
const HTCAPTION = 2n;

const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 16; // ~60 fps

const SWP_NOSIZE = 0x0001;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_ASYNCWINDOWPOS = 0x4000;
const NUDGE_FLAGS = SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;

const LWA_ALPHA = 0x02;
const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

const HWND_TOPMOST = 0xffffffff_fffffffen; // (HWND)-1 as unsigned bigint

// IXAudio2 COM vtable slots (xaudio2.h declaration order).
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_STOP = 20;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;
const XAUDIO2_LOOP_INFINITE = 0xff;
const AudioCategory_GameEffects = 6;

// Audio configuration.
const SAMPLE_RATE = 44_100;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = (CHANNELS * BITS_PER_SAMPLE) / 8;

const BEATS_PER_MINUTE = 90;
const BEATS_PER_BAR = 4;
const BARS_PER_LOOP = 4;
const SAMPLES_PER_BEAT = Math.round((SAMPLE_RATE * 60) / BEATS_PER_MINUTE);
const SAMPLES_PER_LOOP = SAMPLES_PER_BEAT * BEATS_PER_BAR * BARS_PER_LOOP;

// Overlay window.
const OVERLAY_WIDTH = 480;
const OVERLAY_HEIGHT = 320;
const OVERLAY_ALPHA = 245;
const OVERLAY_TITLE = 'Window Cascade';
const CLASS_NAME = 'BunWin32WindowCascade';

// Cascade motion bounds.
const MAX_OFFSET_X = 8;
const MAX_OFFSET_Y = 4;
const PHASE_DELAY_PER_WINDOW = 0.4; // radians, per-window offset for the cascade

// ── Helpers ──────────────────────────────────────────────────────────────────

const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

const COLOR_BACKGROUND = argb(255, 0x0a, 0x0c, 0x18);
const COLOR_HEADER = argb(255, 0xff, 0x88, 0xbb);
const COLOR_HEADER_DIM = argb(255, 0x66, 0x44, 0x66);
const COLOR_LABEL = argb(255, 0x77, 0x7a, 0x92);
const COLOR_VALUE = argb(255, 0xea, 0xee, 0xf6);
const COLOR_TITLE = argb(255, 0xa8, 0xc8, 0xff);
const COLOR_BEAT_OFF = argb(255, 0x22, 0x2a, 0x44);
const COLOR_BEAT_ON = argb(255, 0xff, 0x66, 0x88);
const COLOR_ACCENT = argb(255, 0x66, 0xff, 0xb2);

function gdiplusCheck(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed (Gdiplus status ${status})`);
}

const hex = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;

// ── COM vtable invoker (memoized per method) ────────────────────────────────

const vtableInvokerCache = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound CFunction is memoized per (method, signature)
 * so the per-frame GetState poll loop stays cheap.
 */
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

// ── Enumerate visible top-level windows + capture original rectangles ───────

interface TrackedWindow {
  hwnd: bigint;
  title: string;
  originalLeft: number;
  originalTop: number;
  width: number;
  height: number;
}

// Class names belonging to the shell / desktop / system tray that we must
// never move — touching them would jiggle the wallpaper or the taskbar.
const SHELL_CLASS_NAMES = new Set<string>([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'NotifyIconOverflowWindow',
  'Button', // the Start button's hidden host
  'DV2ControlHost',
  'MSCTFIME UI',
  'Default IME',
  'IME',
  'TaskListThumbnailWnd',
  'TaskListOverlayWnd',
  'XamlExplorerHostIslandWindow',
  'Windows.UI.Core.CoreWindow', // many UWP host windows we don't want to move
]);

// Scratch buffers reused inside the EnumWindows callback (allocated once).
const enumTitleBuffer = Buffer.alloc(1024);
const enumClassBuffer = Buffer.alloc(512);
const enumRectBuffer = Buffer.alloc(16); // RECT: 4 × i32

const trackedWindows: TrackedWindow[] = [];

const ourPidBuffer = Buffer.alloc(4);
let ourOverlayHwnd: bigint = NULL;

const enumCallback = new JSCallback(
  (hwnd: bigint, _lParam: bigint): number => {
    // Skip our own overlay if it already exists by the time another enum runs.
    if (hwnd === ourOverlayHwnd) return 1;

    if (!User32.IsWindowVisible(hwnd)) return 1;
    if (User32.GetWindowTextLengthW(hwnd) === 0) return 1;

    // Class name filter — never touch the shell, the IME, or hidden host windows.
    const classLength = User32.GetClassNameW(hwnd, enumClassBuffer.ptr!, 256);
    if (classLength <= 0) return 1;
    const className = enumClassBuffer.subarray(0, classLength * 2).toString('utf16le');
    if (SHELL_CLASS_NAMES.has(className)) return 1;

    // Pull the title for the on-screen list.
    const titleLength = User32.GetWindowTextW(hwnd, enumTitleBuffer.ptr!, 512);
    if (titleLength <= 0) return 1;
    const title = enumTitleBuffer.subarray(0, titleLength * 2).toString('utf16le');

    // Capture geometry. SetWindowPos round-trips the same coordinates, so
    // recording the values straight from GetWindowRect is what we replay on exit.
    if (!User32.GetWindowRect(hwnd, enumRectBuffer.ptr!)) return 1;
    const left = enumRectBuffer.readInt32LE(0);
    const top = enumRectBuffer.readInt32LE(4);
    const right = enumRectBuffer.readInt32LE(8);
    const bottom = enumRectBuffer.readInt32LE(12);
    const width = right - left;
    const height = bottom - top;

    // Zero-sized or wildly off-screen windows are skipped.
    if (width <= 0 || height <= 0) return 1;
    if (left < -32_000 || top < -32_000) return 1;

    trackedWindows.push({
      hwnd,
      title,
      originalLeft: left,
      originalTop: top,
      width,
      height,
    });
    return 1; // continue enumeration
  },
  { args: ['u64', 'i64'], returns: 'i32' },
);

User32.EnumWindows(enumCallback.ptr!, 0n);
// Close the callback eagerly — we will not enumerate again.
enumCallback.close();

if (trackedWindows.length === 0) {
  console.error('No dance-able top-level windows found. Open something (an editor, a browser…) and try again.');
  process.exit(1);
}

console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('   WINDOW CASCADE  -  the desktop dances    ');
console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('');
console.log(`Found ${trackedWindows.length} visible windows to choreograph at ${BEATS_PER_MINUTE} BPM.`);
console.log('Press ESC, right-click the status overlay, or Ctrl+C to stop.');
console.log('All original positions will be restored on exit.');
console.log('');

// ── XAudio2 bootstrap + drum loop synthesis ─────────────────────────────────

let audioReady = false;
let xaudioEngine: bigint = NULL;
let xaudioMasteringVoice: bigint = NULL;
let xaudioSourceVoice: bigint = NULL;
let drumPcmBuffer: Buffer | null = null;
let audioStartedAt = 0;

/**
 * Synthesizes a 90 BPM, 4-bar drum pattern (kick · snare · hi-hat · ghost
 * notes) straight into a 16-bit signed PCM buffer. Each percussion voice is a
 * tiny additive/noise synthesis kernel with an exponential envelope.
 */
function synthesizeDrumLoop(): Buffer {
  const samples = new Float32Array(SAMPLES_PER_LOOP);

  /** Adds an enveloped sine sweep — the kick: low frequency thump. */
  const addKick = (sampleOffset: number, gain = 0.95): void => {
    const lengthSamples = Math.round(SAMPLE_RATE * 0.18);
    for (let i = 0; i < lengthSamples; i += 1) {
      const idx = sampleOffset + i;
      if (idx >= SAMPLES_PER_LOOP) break;
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-26 * t);
      const freq = 110 * Math.exp(-32 * t) + 50; // 160 Hz → ~50 Hz sweep
      const sample = Math.sin(2 * Math.PI * freq * t) * env;
      samples[idx]! += sample * gain;
    }
  };

  /** Adds a band-passed noise burst on top of a low sine — the snare. */
  const addSnare = (sampleOffset: number, gain = 0.7): void => {
    const lengthSamples = Math.round(SAMPLE_RATE * 0.16);
    let prevNoise = 0;
    for (let i = 0; i < lengthSamples; i += 1) {
      const idx = sampleOffset + i;
      if (idx >= SAMPLES_PER_LOOP) break;
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-22 * t);
      const noise = Math.random() * 2 - 1;
      // Cheap one-pole HPF to give the noise some snap.
      const filtered = noise - prevNoise * 0.5;
      prevNoise = noise;
      const tone = Math.sin(2 * Math.PI * 190 * t) * 0.35;
      const sample = (filtered * 0.65 + tone) * env;
      samples[idx]! += sample * gain;
    }
  };

  /** Adds a short white-noise burst with steep envelope — the hi-hat. */
  const addHat = (sampleOffset: number, gain = 0.32): void => {
    const lengthSamples = Math.round(SAMPLE_RATE * 0.04);
    for (let i = 0; i < lengthSamples; i += 1) {
      const idx = sampleOffset + i;
      if (idx >= SAMPLES_PER_LOOP) break;
      const t = i / SAMPLE_RATE;
      const env = Math.exp(-90 * t);
      const sample = (Math.random() * 2 - 1) * env;
      samples[idx]! += sample * gain;
    }
  };

  // Lay down a 4-on-the-floor kick + backbeat snare + 8th-note hats for each bar.
  for (let bar = 0; bar < BEATS_PER_BAR * BARS_PER_LOOP; bar += 1) {
    const beatStart = bar * SAMPLES_PER_BEAT;
    addKick(beatStart);
    if (bar % 2 === 1) addSnare(beatStart);
    addHat(beatStart);
    addHat(beatStart + Math.round(SAMPLES_PER_BEAT / 2)); // off-beat hat
  }
  // Tiny ghost kick on the last "and of 4" for a touch of swagger.
  addKick(SAMPLES_PER_LOOP - Math.round(SAMPLES_PER_BEAT / 2), 0.35);

  // Quantize to int16, clamping to avoid overflow. Float gain is < 1.5 worst
  // case, so a single global scale of 0.75 leaves plenty of headroom.
  const pcm = Buffer.alloc(SAMPLES_PER_LOOP * BLOCK_ALIGN);
  for (let i = 0; i < SAMPLES_PER_LOOP; i += 1) {
    let s = samples[i]! * 0.75;
    if (s > 1) s = 1;
    if (s < -1) s = -1;
    pcm.writeInt16LE(Math.round(s * 32_767), i * BLOCK_ALIGN);
  }
  return pcm;
}

function bootAudio(): void {
  // 1. IXAudio2 engine via the flat export.
  const ppEngine = Buffer.alloc(8);
  const createHr = Xaudio2_9.XAudio2Create(ppEngine.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
  if (createHr !== S_OK) {
    console.log(`  (XAudio2Create failed with ${hex(createHr)} — dancing silently.)`);
    return;
  }
  xaudioEngine = ppEngine.readBigUInt64LE(0);

  // 2. Mastering voice on the default endpoint.
  const ppMaster = Buffer.alloc(8);
  const masterHr = vcall(
    xaudioEngine,
    IXAUDIO2_CREATEMASTERINGVOICE,
    [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
    [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects],
  );
  if (masterHr !== S_OK) {
    console.log(`  (CreateMasteringVoice failed with ${hex(masterHr)} — dancing silently.)`);
    vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    xaudioEngine = NULL;
    return;
  }
  xaudioMasteringVoice = ppMaster.readBigUInt64LE(0);

  // 3. Synthesize the drum loop. Keep the buffer alive at module scope so the
  //    pAudioData pointer the mixer reads from never gets GC'd.
  drumPcmBuffer = synthesizeDrumLoop();

  // WAVEFORMATEX (18 bytes; cbSize = 0 for plain PCM).
  const waveFormat = Buffer.alloc(18);
  waveFormat.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
  waveFormat.writeUInt16LE(CHANNELS, 2);
  waveFormat.writeUInt32LE(SAMPLE_RATE, 4);
  waveFormat.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 8);
  waveFormat.writeUInt16LE(BLOCK_ALIGN, 12);
  waveFormat.writeUInt16LE(BITS_PER_SAMPLE, 14);
  waveFormat.writeUInt16LE(0, 16);

  // 4. Source voice.
  const ppSource = Buffer.alloc(8);
  const sourceHr = vcall(
    xaudioEngine,
    IXAUDIO2_CREATESOURCEVOICE,
    [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    [ppSource.ptr!, waveFormat.ptr!, 0, 2.0, null, null, null],
  );
  if (sourceHr !== S_OK) {
    console.log(`  (CreateSourceVoice failed with ${hex(sourceHr)} — dancing silently.)`);
    vcall(xaudioMasteringVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    xaudioMasteringVoice = NULL;
    xaudioEngine = NULL;
    return;
  }
  xaudioSourceVoice = ppSource.readBigUInt64LE(0);

  // 5. XAUDIO2_BUFFER (48 bytes on x64): Flags, AudioBytes, pAudioData @8,
  //    PlayBegin, PlayLength, LoopBegin, LoopLength, LoopCount, pContext.
  const xaudioBuffer = Buffer.alloc(48);
  xaudioBuffer.writeUInt32LE(0, 0); // Flags = 0 (we loop forever)
  xaudioBuffer.writeUInt32LE(drumPcmBuffer.length, 4);
  xaudioBuffer.writeBigUInt64LE(BigInt(drumPcmBuffer.ptr!), 8);
  xaudioBuffer.writeUInt32LE(0, 16); // PlayBegin
  xaudioBuffer.writeUInt32LE(0, 20); // PlayLength = 0 → whole buffer
  xaudioBuffer.writeUInt32LE(0, 24); // LoopBegin
  xaudioBuffer.writeUInt32LE(0, 28); // LoopLength = 0 → loop entire buffer
  xaudioBuffer.writeUInt32LE(XAUDIO2_LOOP_INFINITE, 32);
  xaudioBuffer.writeBigUInt64LE(0n, 40);

  const submitHr = vcall(
    xaudioSourceVoice,
    IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER,
    [FFIType.ptr, FFIType.ptr],
    [xaudioBuffer.ptr!, null],
  );
  if (submitHr !== S_OK) {
    console.log(`  (SubmitSourceBuffer failed with ${hex(submitHr)} — dancing silently.)`);
    vcall(xaudioSourceVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    vcall(xaudioMasteringVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    xaudioSourceVoice = NULL;
    xaudioMasteringVoice = NULL;
    xaudioEngine = NULL;
    return;
  }

  // 6. Start the voice. We watch its SamplesPlayed counter to drive the cascade.
  vcall(xaudioSourceVoice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
  audioStartedAt = Date.now();
  audioReady = true;
}

bootAudio();

// ── Mica overlay (status HUD) ───────────────────────────────────────────────

let teardownDone = false;
let overlayHwnd: bigint = NULL;

// GDI+ token / handles for the status overlay.
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion
gdiplusCheck(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr!, gdiplusStartupInput.ptr!, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

/**
 * Caches every GDI+ handle (graphics, brushes, pens, fonts) and the DIB
 * section + memory DC used to paint the status overlay each frame. Disposing
 * the renderer releases everything in reverse-allocation order.
 */
class StatusRenderer {
  private readonly memoryDc: bigint;
  private readonly dibBitmap: bigint;
  private readonly oldBitmap: bigint;
  private readonly graphics: bigint;
  private readonly headerFont: bigint;
  private readonly bigFont: bigint;
  private readonly labelFont: bigint;
  private readonly titleFont: bigint;
  private readonly monoFont: bigint;
  private readonly fontFamilySans: bigint;
  private readonly fontFamilyMono: bigint;
  private readonly stringFormatLeft: bigint;
  private readonly stringFormatCenter: bigint;
  private readonly brushBackground: bigint;
  private readonly brushHeader: bigint;
  private readonly brushHeaderDim: bigint;
  private readonly brushLabel: bigint;
  private readonly brushValue: bigint;
  private readonly brushTitle: bigint;
  private readonly brushBeatOff: bigint;
  private readonly brushBeatOn: bigint;
  private readonly brushAccent: bigint;
  private readonly penAccent: bigint;
  private readonly textScratch: Buffer;

  constructor(referenceDc: bigint) {
    // 32-bpp top-down ARGB DIB.
    const bitmapInfo = Buffer.alloc(40 + 16);
    bitmapInfo.writeUInt32LE(40, 0);
    bitmapInfo.writeInt32LE(OVERLAY_WIDTH, 4);
    bitmapInfo.writeInt32LE(-OVERLAY_HEIGHT, 8); // negative = top-down
    bitmapInfo.writeUInt16LE(1, 12);
    bitmapInfo.writeUInt16LE(32, 14);
    bitmapInfo.writeUInt32LE(BI_RGB, 16);

    this.memoryDc = GDI32.CreateCompatibleDC(referenceDc);
    if (this.memoryDc === NULL) throw new Error('CreateCompatibleDC failed');

    const bitsPointer = Buffer.alloc(8);
    this.dibBitmap = GDI32.CreateDIBSection(this.memoryDc, bitmapInfo.ptr!, DIB_RGB_COLORS, bitsPointer.ptr!, NULL, 0);
    if (this.dibBitmap === NULL) throw new Error('CreateDIBSection failed');
    this.oldBitmap = GDI32.SelectObject(this.memoryDc, this.dibBitmap);

    const graphicsOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFromHDC(this.memoryDc, graphicsOut.ptr!), 'GdipCreateFromHDC');
    this.graphics = graphicsOut.readBigUInt64LE(0);
    gdiplusCheck(Gdiplus.GdipSetSmoothingMode(this.graphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
    gdiplusCheck(Gdiplus.GdipSetTextRenderingHint(this.graphics, TextRenderingHint.TextRenderingHintClearTypeGridFit), 'GdipSetTextRenderingHint');

    const sansFamilyOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFontFamilyFromName(encode('Segoe UI').ptr!, NULL, sansFamilyOut.ptr!), 'GdipCreateFontFamilyFromName (Segoe UI)');
    this.fontFamilySans = sansFamilyOut.readBigUInt64LE(0);

    const monoFamilyOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFontFamilyFromName(encode('Consolas').ptr!, NULL, monoFamilyOut.ptr!), 'GdipCreateFontFamilyFromName (Consolas)');
    this.fontFamilyMono = monoFamilyOut.readBigUInt64LE(0);

    const headerFontOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFont(this.fontFamilySans, 18.0, FontStyle.FontStyleBold, Unit.UnitPixel, headerFontOut.ptr!), 'GdipCreateFont header');
    this.headerFont = headerFontOut.readBigUInt64LE(0);

    const bigFontOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFont(this.fontFamilySans, 36.0, FontStyle.FontStyleBold, Unit.UnitPixel, bigFontOut.ptr!), 'GdipCreateFont big');
    this.bigFont = bigFontOut.readBigUInt64LE(0);

    const labelFontOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFont(this.fontFamilySans, 11.0, FontStyle.FontStyleRegular, Unit.UnitPixel, labelFontOut.ptr!), 'GdipCreateFont label');
    this.labelFont = labelFontOut.readBigUInt64LE(0);

    const titleFontOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFont(this.fontFamilySans, 12.0, FontStyle.FontStyleRegular, Unit.UnitPixel, titleFontOut.ptr!), 'GdipCreateFont title');
    this.titleFont = titleFontOut.readBigUInt64LE(0);

    const monoFontOut = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateFont(this.fontFamilyMono, 11.0, FontStyle.FontStyleRegular, Unit.UnitPixel, monoFontOut.ptr!), 'GdipCreateFont mono');
    this.monoFont = monoFontOut.readBigUInt64LE(0);

    this.stringFormatLeft = this.createStringFormat(StringAlignment.StringAlignmentNear);
    this.stringFormatCenter = this.createStringFormat(StringAlignment.StringAlignmentCenter);

    this.brushBackground = this.createSolidFill(COLOR_BACKGROUND);
    this.brushHeader = this.createSolidFill(COLOR_HEADER);
    this.brushHeaderDim = this.createSolidFill(COLOR_HEADER_DIM);
    this.brushLabel = this.createSolidFill(COLOR_LABEL);
    this.brushValue = this.createSolidFill(COLOR_VALUE);
    this.brushTitle = this.createSolidFill(COLOR_TITLE);
    this.brushBeatOff = this.createSolidFill(COLOR_BEAT_OFF);
    this.brushBeatOn = this.createSolidFill(COLOR_BEAT_ON);
    this.brushAccent = this.createSolidFill(COLOR_ACCENT);
    this.penAccent = this.createPen(COLOR_ACCENT, 1.5);

    this.textScratch = Buffer.alloc(1024);
  }

  private createStringFormat(alignment: StringAlignment): bigint {
    const out = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateStringFormat(0, 0, out.ptr!), 'GdipCreateStringFormat');
    const handle = out.readBigUInt64LE(0);
    Gdiplus.GdipSetStringFormatAlign(handle, alignment);
    Gdiplus.GdipSetStringFormatLineAlign(handle, StringAlignment.StringAlignmentCenter);
    return handle;
  }

  private createSolidFill(color: number): bigint {
    const out = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreateSolidFill(color, out.ptr!), 'GdipCreateSolidFill');
    return out.readBigUInt64LE(0);
  }

  private createPen(color: number, width: number): bigint {
    const out = Buffer.alloc(8);
    gdiplusCheck(Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, out.ptr!), 'GdipCreatePen1');
    return out.readBigUInt64LE(0);
  }

  private drawText(text: string, brush: bigint, font: bigint, x: number, y: number, width: number, height: number, format: bigint): void {
    if (text.length === 0) return;
    const trimmed = text.length > 256 ? text.slice(0, 253) + '...' : text;
    const byteCount = Buffer.byteLength(trimmed, 'utf16le');
    if (byteCount + 2 > this.textScratch.length) return;
    this.textScratch.write(trimmed, 0, 'utf16le');
    this.textScratch.writeUInt16LE(0, byteCount);

    const layoutRect = Buffer.alloc(16);
    layoutRect.writeFloatLE(x, 0);
    layoutRect.writeFloatLE(y, 4);
    layoutRect.writeFloatLE(width, 8);
    layoutRect.writeFloatLE(height, 12);
    Gdiplus.GdipDrawString(this.graphics, this.textScratch.ptr!, trimmed.length, font, layoutRect.ptr!, format, brush);
  }

  paint(state: { windowCount: number; beatPhase: number; beatIndex: number; titles: string[]; elapsedSeconds: number }): void {
    Gdiplus.GdipGraphicsClear(this.graphics, COLOR_BACKGROUND);
    Gdiplus.GdipFillRectangle(this.graphics, this.brushBackground, 0, 0, OVERLAY_WIDTH, OVERLAY_HEIGHT);

    // Header row.
    this.drawText('WINDOW CASCADE', this.brushHeader, this.headerFont, 18, 14, OVERLAY_WIDTH - 36, 24, this.stringFormatLeft);
    this.drawText(`@ ${BEATS_PER_MINUTE} BPM`, this.brushHeaderDim, this.labelFont, OVERLAY_WIDTH - 110, 18, 90, 18, this.stringFormatLeft);

    // The big "N WINDOWS DANCING" line.
    const big = `${state.windowCount}`;
    this.drawText(big, this.brushAccent, this.bigFont, 18, 46, 140, 50, this.stringFormatLeft);
    this.drawText('windows', this.brushLabel, this.labelFont, 20, 96, 120, 16, this.stringFormatLeft);
    this.drawText('dancing in unison', this.brushValue, this.titleFont, 20, 112, 280, 18, this.stringFormatLeft);

    // Beat indicators: four dots, one per beat. The current beat pulses with
    // 1.0 → 0.0 alpha over the beat duration so you can read the groove.
    const dotsBaseX = 200;
    const dotsBaseY = 56;
    const dotSize = 22;
    const dotGap = 12;
    for (let beat = 0; beat < BEATS_PER_BAR; beat += 1) {
      const isCurrentBeat = beat === state.beatIndex;
      const pulseAlpha = isCurrentBeat ? Math.max(0, 1 - state.beatPhase) : 0;
      const x = dotsBaseX + beat * (dotSize + dotGap);
      Gdiplus.GdipFillEllipse(this.graphics, this.brushBeatOff, x, dotsBaseY, dotSize, dotSize);
      if (pulseAlpha > 0) {
        // Cheap "alpha" approximation — repaint over the off-dot with the on
        // color, scaled by the pulse. We do this by drawing a smaller filled
        // ellipse centered on the dot.
        const inset = Math.round((1 - pulseAlpha) * (dotSize / 2));
        const innerSize = dotSize - inset * 2;
        if (innerSize > 0) {
          Gdiplus.GdipFillEllipse(this.graphics, this.brushBeatOn, x + inset, dotsBaseY + inset, innerSize, innerSize);
        }
      }
    }

    // Underline for the dots row.
    Gdiplus.GdipDrawLine(this.graphics, this.penAccent, 18, dotsBaseY + dotSize + 18, OVERLAY_WIDTH - 18, dotsBaseY + dotSize + 18);

    // Window list (first 8 titles).
    let y = dotsBaseY + dotSize + 28;
    this.drawText('on stage:', this.brushLabel, this.labelFont, 18, y, 200, 16, this.stringFormatLeft);
    y += 18;
    const maxTitles = Math.min(8, state.titles.length);
    for (let i = 0; i < maxTitles; i += 1) {
      const t = state.titles[i] ?? '';
      const display = t.length > 56 ? t.slice(0, 53) + '...' : t;
      const bullet = `• ${display}`;
      this.drawText(bullet, this.brushTitle, this.titleFont, 22, y, OVERLAY_WIDTH - 40, 16, this.stringFormatLeft);
      y += 16;
    }
    if (state.titles.length > maxTitles) {
      this.drawText(`… and ${state.titles.length - maxTitles} more`, this.brushLabel, this.labelFont, 22, y, OVERLAY_WIDTH - 40, 16, this.stringFormatLeft);
    }

    // Footer.
    const elapsed = `t = ${state.elapsedSeconds.toFixed(1)}s   ·   ESC to restore everything`;
    this.drawText(elapsed, this.brushLabel, this.monoFont, 18, OVERLAY_HEIGHT - 22, OVERLAY_WIDTH - 36, 16, this.stringFormatLeft);
  }

  blitTo(destinationDc: bigint): void {
    GDI32.BitBlt(destinationDc, 0, 0, OVERLAY_WIDTH, OVERLAY_HEIGHT, this.memoryDc, 0, 0, SRCCOPY);
  }

  dispose(): void {
    Gdiplus.GdipDeletePen(this.penAccent);
    Gdiplus.GdipDeleteBrush(this.brushAccent);
    Gdiplus.GdipDeleteBrush(this.brushBeatOn);
    Gdiplus.GdipDeleteBrush(this.brushBeatOff);
    Gdiplus.GdipDeleteBrush(this.brushTitle);
    Gdiplus.GdipDeleteBrush(this.brushValue);
    Gdiplus.GdipDeleteBrush(this.brushLabel);
    Gdiplus.GdipDeleteBrush(this.brushHeaderDim);
    Gdiplus.GdipDeleteBrush(this.brushHeader);
    Gdiplus.GdipDeleteBrush(this.brushBackground);
    Gdiplus.GdipDeleteStringFormat(this.stringFormatCenter);
    Gdiplus.GdipDeleteStringFormat(this.stringFormatLeft);
    Gdiplus.GdipDeleteFont(this.monoFont);
    Gdiplus.GdipDeleteFont(this.titleFont);
    Gdiplus.GdipDeleteFont(this.labelFont);
    Gdiplus.GdipDeleteFont(this.bigFont);
    Gdiplus.GdipDeleteFont(this.headerFont);
    Gdiplus.GdipDeleteFontFamily(this.fontFamilyMono);
    Gdiplus.GdipDeleteFontFamily(this.fontFamilySans);
    Gdiplus.GdipDeleteGraphics(this.graphics);
    GDI32.SelectObject(this.memoryDc, this.oldBitmap);
    GDI32.DeleteObject(this.dibBitmap);
    GDI32.DeleteDC(this.memoryDc);
  }
}

let renderer: StatusRenderer | null = null;
let lastBeatIndex = -1;

// ── Window procedure (timer-driven cascade + overlay paint) ─────────────────

function computeBeatPhaseAndIndex(): { phase: number; index: number; elapsedSeconds: number } {
  if (!audioReady || xaudioSourceVoice === NULL) {
    // Wall-clock fallback so the visuals still cascade if audio failed.
    const elapsed = (Date.now() - audioStartedAt) / 1000;
    const beatsElapsed = (elapsed * BEATS_PER_MINUTE) / 60;
    const phase = beatsElapsed - Math.floor(beatsElapsed);
    const index = Math.floor(beatsElapsed) % BEATS_PER_BAR;
    return { phase, index, elapsedSeconds: elapsed };
  }
  // Read SamplesPlayed straight from the mixer for sample-accurate timing.
  const voiceState = Buffer.alloc(24); // XAUDIO2_VOICE_STATE: ctx@0, BuffersQueued@8, SamplesPlayed@16
  vcall(xaudioSourceVoice, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [voiceState.ptr!, 0], FFIType.void);
  const samplesPlayed = Number(voiceState.readBigUInt64LE(16));
  const beatPosition = samplesPlayed / SAMPLES_PER_BEAT;
  const phase = beatPosition - Math.floor(beatPosition);
  const index = Math.floor(beatPosition) % BEATS_PER_BAR;
  const elapsedSeconds = samplesPlayed / SAMPLE_RATE;
  return { phase, index, elapsedSeconds };
}

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER && wParam === TIMER_ID) {
      const { phase, index, elapsedSeconds } = computeBeatPhaseAndIndex();

      // Nudge every tracked window. Each window has its own phase delay so
      // the cascade rolls across the desktop like a wave.
      const baseAngle = phase * 2 * Math.PI;
      for (let i = 0; i < trackedWindows.length; i += 1) {
        const w = trackedWindows[i]!;
        const angle = baseAngle + i * PHASE_DELAY_PER_WINDOW;
        const offsetX = Math.round(Math.sin(angle) * MAX_OFFSET_X);
        const offsetY = Math.round(Math.cos(angle) * MAX_OFFSET_Y);
        User32.SetWindowPos(
          w.hwnd,
          NULL,
          w.originalLeft + offsetX,
          w.originalTop + offsetY,
          0,
          0,
          NUDGE_FLAGS,
        );
      }

      // Repaint the overlay.
      if (renderer !== null) {
        renderer.paint({
          windowCount: trackedWindows.length,
          beatPhase: phase,
          beatIndex: index,
          titles: trackedWindows.map((w) => w.title),
          elapsedSeconds,
        });
        const overlayDc = User32.GetDC(hWnd);
        if (overlayDc !== NULL) {
          renderer.blitTo(overlayDc);
          User32.ReleaseDC(hWnd, overlayDc);
        }
      }

      // Console feedback on each new beat.
      if (index !== lastBeatIndex) {
        lastBeatIndex = index;
        const beatSymbol = index === 0 ? '*' : '.';
        process.stdout.write(beatSymbol);
      }
      return 0n;
    }

    if (msg === WM_KEYDOWN && Number(wParam) === VirtualKey.VK_ESCAPE) {
      User32.PostMessageW(hWnd, WM_CLOSE, NULL, 0n);
      return 0n;
    }

    if (msg === WM_RBUTTONDOWN || msg === WM_NCRBUTTONDOWN) {
      User32.PostMessageW(hWnd, WM_CLOSE, NULL, 0n);
      return 0n;
    }

    if (msg === WM_NCHITTEST) {
      // Make the whole client area draggable so users can move the overlay.
      return HTCAPTION;
    }

    if (msg === WM_CLOSE) {
      User32.KillTimer(hWnd, TIMER_ID);
      User32.DestroyWindow(hWnd);
      return 0n;
    }

    if (msg === WM_DESTROY) {
      User32.PostQuitMessage(0);
      return 0n;
    }

    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// ── Register class + create overlay window ──────────────────────────────────

const classNameBuffer = encode(CLASS_NAME);

const wndClassBuffer = Buffer.alloc(80); // WNDCLASSEXW on x64
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true);
wndClassView.setInt32(20, 0, true);
wndClassBuffer.writeBigUInt64LE(NULL, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(NULL, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(NULL, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(NULL, 48); // hbrBackground (we paint everything)
wndClassBuffer.writeBigUInt64LE(NULL, 56); // lpszMenuName
wndClassBuffer.writeBigUInt64LE(BigInt(classNameBuffer.ptr!), 64); // lpszClassName
wndClassBuffer.writeBigUInt64LE(NULL, 72); // hIconSm

if (!User32.RegisterClassExW(wndClassBuffer.ptr!)) {
  console.error('RegisterClassExW failed.');
  process.exit(1);
}

// Place the overlay in the top-right corner of the primary monitor.
const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const overlayX = Math.max(0, screenWidth - OVERLAY_WIDTH - 40);
const overlayY = 40;

overlayHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_LAYERED | ExtendedWindowStyles.WS_EX_NOACTIVATE,
  classNameBuffer.ptr!,
  encode(OVERLAY_TITLE).ptr!,
  WindowStyles.WS_POPUP,
  overlayX,
  overlayY,
  OVERLAY_WIDTH,
  OVERLAY_HEIGHT,
  NULL,
  NULL,
  NULL,
  NULL_POINTER,
);

if (overlayHwnd === NULL) {
  console.error('CreateWindowExW failed.');
  process.exit(1);
}
ourOverlayHwnd = overlayHwnd;

// DWM Mica + immersive dark mode. Both are best-effort: pre-Win11 builds
// return E_INVALIDARG and we just keep the flat dark fill.
const dwmAttributeBuffer = Buffer.alloc(4);
dwmAttributeBuffer.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(overlayHwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, dwmAttributeBuffer.ptr!, 4);

dwmAttributeBuffer.writeInt32LE(SystemBackdropType.DWMSBT_TRANSIENTWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(overlayHwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, dwmAttributeBuffer.ptr!, 4);

// MARGINS { -1, -1, -1, -1 } extends the DWM frame across the whole client.
const dwmMargins = Buffer.alloc(16);
dwmMargins.writeInt32LE(-1, 0);
dwmMargins.writeInt32LE(-1, 4);
dwmMargins.writeInt32LE(-1, 8);
dwmMargins.writeInt32LE(-1, 12);
Dwmapi.DwmExtendFrameIntoClientArea(overlayHwnd, dwmMargins.ptr!);

User32.SetLayeredWindowAttributes(overlayHwnd, 0, OVERLAY_ALPHA, LWA_ALPHA);

// Build the renderer now that we have a window to source a compatible DC from.
const referenceDc = User32.GetDC(overlayHwnd);
if (referenceDc === NULL) {
  console.error('GetDC failed.');
  User32.DestroyWindow(overlayHwnd);
  process.exit(1);
}
renderer = new StatusRenderer(referenceDc);
User32.ReleaseDC(overlayHwnd, referenceDc);

User32.ShowWindow(overlayHwnd, ShowWindowCommand.SW_SHOWNOACTIVATE);
User32.SetWindowPos(overlayHwnd, HWND_TOPMOST, 0, 0, 0, 0, 0x0002 /* SWP_NOMOVE */ | SWP_NOSIZE | SWP_NOACTIVATE);
User32.UpdateWindow(overlayHwnd);

if (!User32.SetTimer(overlayHwnd, TIMER_ID, FRAME_INTERVAL_MS, NULL_POINTER)) {
  console.error('SetTimer failed.');
  User32.DestroyWindow(overlayHwnd);
  process.exit(1);
}

// ── Teardown ────────────────────────────────────────────────────────────────

function restoreAllWindows(): void {
  // Replay the captured rectangle for every tracked window in one final pass.
  // SetWindowPos with SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE leaves
  // everything else (size, z-order, focus) untouched — only position is reset.
  for (const w of trackedWindows) {
    User32.SetWindowPos(
      w.hwnd,
      NULL,
      w.originalLeft,
      w.originalTop,
      0,
      0,
      SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );
  }
}

function stopAudio(): void {
  if (!audioReady) return;
  if (xaudioSourceVoice !== NULL) {
    vcall(xaudioSourceVoice, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
    vcall(xaudioSourceVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    xaudioSourceVoice = NULL;
  }
  if (xaudioMasteringVoice !== NULL) {
    vcall(xaudioMasteringVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    xaudioMasteringVoice = NULL;
  }
  if (xaudioEngine !== NULL) {
    vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
    xaudioEngine = NULL;
  }
  drumPcmBuffer = null;
  audioReady = false;
}

function cleanup(): void {
  if (teardownDone) return;
  teardownDone = true;

  // 1. Stop the music first so the GetState callback can't fire mid-teardown.
  stopAudio();

  // 2. Tear down the overlay window so no more WM_TIMER nudges are queued.
  if (overlayHwnd !== NULL) {
    User32.KillTimer(overlayHwnd, TIMER_ID);
    User32.DestroyWindow(overlayHwnd);
    overlayHwnd = NULL;
  }

  // 3. Restore every dancing window. CRITICAL — must run on a healthy state.
  restoreAllWindows();

  // 4. Release GDI+ + the wrapper.
  renderer?.dispose();
  renderer = null;
  User32.UnregisterClassW(classNameBuffer.ptr!, NULL);
  Gdiplus.GdiplusShutdown(gdiplusToken);

  // 5. JSCallbacks last — the message loop has exited and nothing else holds them.
  wndProc.close();
  consoleCtrlHandler.close();
}

// SetConsoleCtrlHandler so Ctrl+C in the terminal still restores positions.
const consoleCtrlHandler = new JSCallback(
  (_ctrlType: number): number => {
    if (overlayHwnd !== NULL) User32.PostMessageW(overlayHwnd, WM_CLOSE, NULL, 0n);
    return 1; // handled
  },
  { args: ['u32'], returns: 'i32' },
);
Kernel32.SetConsoleCtrlHandler(consoleCtrlHandler.ptr!, 1);

// Bun-side SIGINT belt-and-braces.
process.on('SIGINT', () => {
  if (overlayHwnd !== NULL) User32.PostMessageW(overlayHwnd, WM_CLOSE, NULL, 0n);
});

// Our own pid for any further filtering needs.
User32.GetWindowThreadProcessId(overlayHwnd, ourPidBuffer.ptr!);

console.log(`Overlay HWND 0x${overlayHwnd.toString(16)}  ·  ${audioReady ? 'audio ready' : 'audio offline (visual-only cascade)'}`);
console.log('');
console.log('Beat:');

// ── Message pump ────────────────────────────────────────────────────────────

const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr!, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr!);
  User32.DispatchMessageW(messageBuffer.ptr!);
}

cleanup();
console.log('');
console.log('Cascade stopped. All windows restored to their original positions.');
