/**
 * Bun OS — A tiny multi-window desktop environment running inside a single Bun process.
 *
 * This is the flagship showcase for the @bun-win32/all meta-package: it boots a
 * borderless Win32 window with a Desktop Window Manager mica backdrop, runs a
 * software desktop compositor on top of a 32-bit ARGB GDI+ bitmap that is
 * blitted to the window every frame via SetDIBitsToDevice, hosts three live
 * "applications" as draggable fake-windows entirely painted by the renderer,
 * and pipes a continuously looping procedurally-synthesized chiptune through
 * IXAudio2 over its COM vtable. No native addon, no Electron, no DirectComposition
 * tree — just FFI calls into User32, GDI32, Gdiplus, Dwmapi, Kernel32, Pdh,
 * Psapi and Xaudio2_9, orchestrated from one TypeScript file.
 *
 * The three apps mounted on the desktop are real (not screenshots):
 *
 *   - Task Monitor: live CPU% via PdhAddEnglishCounterW("\Processor(_Total)\
 *     % Processor Time"), RAM% via Kernel32.GlobalMemoryStatusEx, and the
 *     running process count via Psapi.EnumProcesses, each plotted as a
 *     scrolling history graph in the window body.
 *   - Music Player: shows the title of the currently-playing 16-second melody
 *     and the looping play head; the audio engine is a real IXAudio2 source
 *     voice queued with infinite-loop XAUDIO2_BUFFER over the COM vtable. Play
 *     and Pause buttons toggle the voice via IXAudio2SourceVoice::Start/Stop.
 *   - Clock: a giant antialiased analog clock with three hands plus a digital
 *     readout, sourced from Kernel32.GetLocalTime each frame.
 *
 * Mouse interaction is implemented entirely in the WndProc. WM_LBUTTONDOWN hit-
 * tests each fake-window's title bar, close button and content buttons; on a
 * header hit it captures the mouse with User32.SetCapture and tracks
 * WM_MOUSEMOVE deltas to reposition the fake-window; WM_LBUTTONUP releases the
 * capture. Clicking the close button minimises a window (hides it) — re-launch
 * from the taskbar's app pills. ESC closes Bun OS.
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / UnregisterClassW (custom WndProc + class atom lifecycle)
 *   - CreateWindowExW (borderless WS_POPUP main window)
 *   - SetWindowLongPtrW (install JSCallback WndProc on the STATIC class? no,
 *     we register our own class here so the JSCallback is the lpfnWndProc field)
 *   - SetTimer / KillTimer (the 30 fps frame tick)
 *   - GetMessageW / TranslateMessage / DispatchMessageW (main message pump)
 *   - DefWindowProcW (fallthrough for unhandled messages)
 *   - SetCapture / ReleaseCapture (drag tracking off the client area)
 *   - GetDC / ReleaseDC (per-frame device context for the blit)
 *   - GetClientRect, GetSystemMetrics (window sizing + screen centering)
 *   - ShowWindow / UpdateWindow / DestroyWindow / PostQuitMessage
 *
 * APIs demonstrated (GDI32):
 *   - SetDIBitsToDevice (blits the GDI+ framebuffer to the window every frame)
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown (engine lifecycle)
 *   - GdipCreateBitmapFromScan0 (32bpp ARGB bitmap over our owned Buffer)
 *   - GdipGetImageGraphicsContext (Graphics bound to that bitmap)
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint (anti-aliased rendering)
 *   - GdipCreateSolidFill / GdipCreateLineBrushFromRectWithAngle (fill brushes)
 *   - GdipCreatePen1 (stroked geometry)
 *   - GdipCreatePath / GdipAddPathLine / GdipAddPathEllipse / GdipClosePathFigure
 *   - GdipFillRectangle / GdipFillEllipse / GdipFillPie / GdipFillPath
 *   - GdipDrawLine / GdipDrawRectangle (frame strokes)
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipCreateStringFormat
 *   - GdipSetStringFormatAlign / GdipSetStringFormatLineAlign / GdipDrawString
 *   - GdipDeleteBrush / GdipDeletePen / GdipDeleteFont / GdipDeleteFontFamily
 *   - GdipDeleteStringFormat / GdipDeletePath / GdipDeleteGraphics / GdipDisposeImage
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute with DWMWA_USE_IMMERSIVE_DARK_MODE (dark window chrome)
 *   - DwmSetWindowAttribute with DWMWA_SYSTEMBACKDROP_TYPE (mica backdrop)
 *
 * APIs demonstrated (Kernel32):
 *   - GlobalMemoryStatusEx (RAM totals + load %)
 *   - GetLocalTime (the clock app's authoritative time source)
 *   - GetModuleHandleW (hInstance for window creation)
 *
 * APIs demonstrated (Pdh):
 *   - PdhOpenQueryW / PdhAddEnglishCounterW (locale-independent CPU counter)
 *   - PdhCollectQueryData / PdhGetFormattedCounterValue (sample + decode)
 *   - PdhRemoveCounter / PdhCloseQuery (cleanup)
 *
 * APIs demonstrated (Psapi):
 *   - EnumProcesses (live process count for the Task Monitor)
 *
 * APIs demonstrated (Xaudio2_9, all COM vtable calls except the bootstrap):
 *   - XAudio2Create (the flat xaudio2_9.dll export that yields IXAudio2)
 *   - IXAudio2::CreateMasteringVoice (default endpoint)
 *   - IXAudio2::CreateSourceVoice (16-bit mono PCM voice)
 *   - IXAudio2SourceVoice::SubmitSourceBuffer (queued with LoopCount=0xFFFFFFFF)
 *   - IXAudio2SourceVoice::Start / IXAudio2SourceVoice::Stop (play/pause)
 *   - IXAudio2SourceVoice::GetState (read SamplesPlayed for the playhead)
 *   - IXAudio2Voice::DestroyVoice / IUnknown::Release (engine teardown)
 *
 * Run: bun run example/bun-os.ts
 */

import { CFunction, FFIType, JSCallback, type Pointer, read } from 'bun:ffi';

import { Dwmapi, Gdiplus, GDI32, Kernel32, Pdh, Psapi, User32, Xaudio2_9 } from '../index';
import {
  ExtendedWindowStyles,
  ShowWindowCommand,
  SystemMetric,
  WindowStyles,
} from '@bun-win32/user32';
import {
  FillMode,
  FontStyle,
  PixelFormat32bppPARGB,
  SmoothingMode,
  Status,
  StringAlignment,
  TextRenderingHint,
  Unit,
} from '@bun-win32/gdiplus';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { PdhCounterFormat } from '@bun-win32/pdh';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

// ─────────────────────────────────────────────────────────────────────────────
// Win32 message + style constants we use below. Most are not exported as enums
// from the packages, so we declare them locally with their canonical values.
// ─────────────────────────────────────────────────────────────────────────────

const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_PAINT = 0x000f;
const WM_ERASEBKGND = 0x0014;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_MOUSEMOVE = 0x0200;
const VK_ESCAPE = 0x1b;

const FRAME_TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 33; // ~30 fps

const DESKTOP_WIDTH = 1100;
const DESKTOP_HEIGHT = 750;

const TASKBAR_HEIGHT = 56;

const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

const encodeUtf16 = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');
const argb = (a: number, r: number, g: number, b: number): number =>
  (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

// ─────────────────────────────────────────────────────────────────────────────
// Gdiplus engine + framebuffer
// ─────────────────────────────────────────────────────────────────────────────

Gdiplus.Preload();
Pdh.Preload([
  'PdhOpenQueryW',
  'PdhAddEnglishCounterW',
  'PdhCollectQueryData',
  'PdhGetFormattedCounterValue',
  'PdhRemoveCounter',
  'PdhCloseQuery',
]);
Psapi.Preload(['EnumProcesses']);

const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1

if (Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null) !== Status.Ok) {
  throw new Error('GdiplusStartup failed');
}
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

// Allocate a 32-bit ARGB framebuffer that we OWN. GDI+ paints into it; we then
// hand the same memory directly to GDI's SetDIBitsToDevice each frame.
const stride = DESKTOP_WIDTH * 4;
const framebuffer = Buffer.alloc(stride * DESKTOP_HEIGHT);

const bitmapHandleBuf = Buffer.alloc(8);
if (
  Gdiplus.GdipCreateBitmapFromScan0(
    DESKTOP_WIDTH,
    DESKTOP_HEIGHT,
    stride,
    PixelFormat32bppPARGB,
    framebuffer.ptr,
    bitmapHandleBuf.ptr,
  ) !== Status.Ok
) {
  throw new Error('GdipCreateBitmapFromScan0 failed');
}
const framebufferBitmap = bitmapHandleBuf.readBigUInt64LE(0);

const graphicsHandleBuf = Buffer.alloc(8);
if (Gdiplus.GdipGetImageGraphicsContext(framebufferBitmap, graphicsHandleBuf.ptr) !== Status.Ok) {
  throw new Error('GdipGetImageGraphicsContext failed');
}
const graphics = graphicsHandleBuf.readBigUInt64LE(0);
Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias);
Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit);

// BITMAPINFOHEADER for the blit. Negative biHeight → top-down DIB so our buffer
// rows match the GDI+ coordinate system.
const bitmapInfo = Buffer.alloc(40);
bitmapInfo.writeUInt32LE(40, 0); // biSize
bitmapInfo.writeInt32LE(DESKTOP_WIDTH, 4); // biWidth
bitmapInfo.writeInt32LE(-DESKTOP_HEIGHT, 8); // biHeight (negative = top-down)
bitmapInfo.writeUInt16LE(1, 12); // biPlanes
bitmapInfo.writeUInt16LE(32, 14); // biBitCount
bitmapInfo.writeUInt32LE(BI_RGB, 16); // biCompression
bitmapInfo.writeUInt32LE(0, 20); // biSizeImage (BI_RGB → 0 OK)

// ─────────────────────────────────────────────────────────────────────────────
// A small toolkit of cached GDI+ resources. We build brushes, pens, fonts and
// string formats once at startup and reuse them across every frame.
// ─────────────────────────────────────────────────────────────────────────────

function makeSolidBrush(color: number): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, out.ptr);
  return out.readBigUInt64LE(0);
}

function makePen(color: number, width: number): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeFont(family: bigint, size: number, style: FontStyle): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateFont(family, size, style, Unit.UnitPixel, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeFontFamily(name: string): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateFontFamilyFromName(encodeUtf16(name).ptr, 0n, out.ptr);
  return out.readBigUInt64LE(0);
}

function makeStringFormat(horizontal: StringAlignment, vertical: StringAlignment): bigint {
  const out = Buffer.alloc(8);
  Gdiplus.GdipCreateStringFormat(0, 0, out.ptr);
  const fmt = out.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(fmt, horizontal);
  Gdiplus.GdipSetStringFormatLineAlign(fmt, vertical);
  return fmt;
}

const fontFamilyUi = makeFontFamily('Segoe UI');
const fontFamilyMono = makeFontFamily('Consolas');

const fontTitle = makeFont(fontFamilyUi, 13, FontStyle.FontStyleBold);
const fontBody = makeFont(fontFamilyUi, 12, FontStyle.FontStyleRegular);
const fontTaskbar = makeFont(fontFamilyUi, 12, FontStyle.FontStyleBold);
const fontGiantClock = makeFont(fontFamilyMono, 36, FontStyle.FontStyleBold);
const fontMetric = makeFont(fontFamilyMono, 18, FontStyle.FontStyleBold);
const fontSmall = makeFont(fontFamilyUi, 10, FontStyle.FontStyleRegular);

const formatNearNear = makeStringFormat(StringAlignment.StringAlignmentNear, StringAlignment.StringAlignmentNear);
const formatCenterCenter = makeStringFormat(StringAlignment.StringAlignmentCenter, StringAlignment.StringAlignmentCenter);
const formatCenterNear = makeStringFormat(StringAlignment.StringAlignmentCenter, StringAlignment.StringAlignmentNear);
const formatNearCenter = makeStringFormat(StringAlignment.StringAlignmentNear, StringAlignment.StringAlignmentCenter);
const formatFarNear = makeStringFormat(StringAlignment.StringAlignmentFar, StringAlignment.StringAlignmentNear);

const brushWindowBody = makeSolidBrush(argb(244, 0x1c, 0x1e, 0x2c));
const brushTitleBar = makeSolidBrush(argb(255, 0x29, 0x2b, 0x3e));
const brushTaskbar = makeSolidBrush(argb(220, 0x18, 0x18, 0x22));
const brushStart = makeSolidBrush(argb(255, 0xff, 0x6e, 0x40));
const brushPillInactive = makeSolidBrush(argb(220, 0x2c, 0x2e, 0x44));
const brushPillActive = makeSolidBrush(argb(255, 0x55, 0x6e, 0xff));
const brushPillHidden = makeSolidBrush(argb(255, 0x6c, 0x6c, 0x80));
const brushClose = makeSolidBrush(argb(255, 0xff, 0x5b, 0x6e));
const brushText = makeSolidBrush(argb(255, 0xee, 0xee, 0xff));
const brushTextDim = makeSolidBrush(argb(180, 0xc0, 0xc0, 0xd6));
const brushClockFace = makeSolidBrush(argb(245, 0xee, 0xf2, 0xff));
const brushClockHour = makeSolidBrush(argb(255, 0x1f, 0x21, 0x33));
const brushClockMin = makeSolidBrush(argb(255, 0x39, 0x3d, 0x5c));
const brushClockSec = makeSolidBrush(argb(255, 0xff, 0x4f, 0x4f));
const brushGraphCpu = makeSolidBrush(argb(70, 0x6e, 0xff, 0xa6));
const brushGraphRam = makeSolidBrush(argb(70, 0xff, 0xc6, 0x6e));
const brushGraphProc = makeSolidBrush(argb(70, 0x9c, 0x6e, 0xff));
const brushTaskbarLine = makeSolidBrush(argb(120, 0xff, 0xff, 0xff));
const brushButton = makeSolidBrush(argb(255, 0x42, 0x47, 0x66));
const brushButtonHot = makeSolidBrush(argb(255, 0x6f, 0x80, 0xff));

const penWindowBorder = makePen(argb(255, 0x55, 0x5b, 0x82), 1);
const penWindowBorderActive = makePen(argb(255, 0x9b, 0xa6, 0xff), 2);
const penGraphCpu = makePen(argb(255, 0x6e, 0xff, 0xa6), 2);
const penGraphRam = makePen(argb(255, 0xff, 0xc6, 0x6e), 2);
const penGraphProc = makePen(argb(255, 0x9c, 0x6e, 0xff), 2);
const penClockTick = makePen(argb(180, 0x1f, 0x21, 0x33), 2);
const penClockTickMinor = makePen(argb(110, 0x1f, 0x21, 0x33), 1);

// A wallpaper gradient brush, rebuilt only once.
const wallpaperRect = Buffer.alloc(16);
wallpaperRect.writeFloatLE(0, 0);
wallpaperRect.writeFloatLE(0, 4);
wallpaperRect.writeFloatLE(DESKTOP_WIDTH, 8);
wallpaperRect.writeFloatLE(DESKTOP_HEIGHT, 12);
const wallpaperBrushBuf = Buffer.alloc(8);
Gdiplus.GdipCreateLineBrushFromRectWithAngle(wallpaperRect.ptr, argb(255, 0x0c, 0x0f, 0x24), argb(255, 0x21, 0x18, 0x4a), 120.0, 1, 0, wallpaperBrushBuf.ptr);
const wallpaperBrush = wallpaperBrushBuf.readBigUInt64LE(0);

// ─────────────────────────────────────────────────────────────────────────────
// XAudio2 chiptune. We synthesize a 16-second loop of a simple 4-bar melody
// with a square-wave lead + triangle-wave bass once at startup, queue it with
// LoopCount = 0xFF (XAUDIO2_LOOP_INFINITE), and drive Start/Stop on the source
// voice when the user clicks Play/Pause in the Music Player app.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44_100;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;
const AUDIO_BLOCK_ALIGN = (AUDIO_CHANNELS * AUDIO_BITS) / 8;

const xaudioInvokers = new Map<string, ReturnType<typeof CFunction>>();

function vcall(
  thisPtr: bigint,
  slot: number,
  argTypes: readonly FFIType[],
  args: readonly unknown[],
  returns: FFIType = FFIType.i32,
): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = xaudioInvokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns });
    xaudioInvokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_STOP = 20;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;
const AudioCategory_GameMedia = 5;
const XAUDIO2_LOOP_INFINITE = 0xff;

// Synth the loop. Notes are MIDI-style indices into a chromatic scale starting
// at A2 = 110 Hz. Melody is a syncopated descending arpeggio in C major.
const NOTES_PER_BAR = 8;
const SECONDS_PER_BAR = 4;
const TOTAL_BARS = 4;
const TOTAL_LOOP_SECONDS = SECONDS_PER_BAR * TOTAL_BARS;
const TOTAL_LOOP_SAMPLES = TOTAL_LOOP_SECONDS * SAMPLE_RATE;
const SAMPLES_PER_NOTE = (SECONDS_PER_BAR / NOTES_PER_BAR) * SAMPLE_RATE;

function noteToFrequency(semitoneFromA2: number): number {
  return 110 * Math.pow(2, semitoneFromA2 / 12);
}

// A bouncy pentatonic-ish lead and a 1-and-3 bass.
const LEAD_PATTERN = [12, 16, 19, 24, 19, 16, 12, 7, 12, 16, 19, 16, 12, 9, 7, 5, 12, 19, 24, 19, 16, 12, 7, 12, 16, 12, 9, 12, 7, 5, 0, 12];
const BASS_PATTERN = [0, -5, 0, -5, 7, 2, 7, 2];

const audioPcmBuffer = Buffer.alloc(TOTAL_LOOP_SAMPLES * AUDIO_BLOCK_ALIGN);

for (let sample = 0; sample < TOTAL_LOOP_SAMPLES; sample++) {
  const noteIndex = Math.floor(sample / SAMPLES_PER_NOTE);
  const leadSemitone = LEAD_PATTERN[noteIndex % LEAD_PATTERN.length]!;
  const bassSemitone = BASS_PATTERN[Math.floor(noteIndex / 2) % BASS_PATTERN.length]! - 12;

  const time = sample / SAMPLE_RATE;
  const phaseInNote = (sample % SAMPLES_PER_NOTE) / SAMPLES_PER_NOTE;
  // Snappy decay envelope per note.
  const noteEnvelope = Math.max(0, 1 - phaseInNote) ** 1.4;

  // Square-ish lead (limited odd harmonics).
  const leadFreq = noteToFrequency(leadSemitone);
  const leadPhase = 2 * Math.PI * leadFreq * time;
  const leadValue = (Math.sin(leadPhase) + Math.sin(leadPhase * 3) / 3 + Math.sin(leadPhase * 5) / 5) * 0.32;

  // Triangle bass.
  const bassFreq = noteToFrequency(bassSemitone);
  const bassWave = Math.asin(Math.sin(2 * Math.PI * bassFreq * time)) * (2 / Math.PI);
  const bassValue = bassWave * 0.22;

  const mix = (leadValue * noteEnvelope + bassValue) * 0.85;
  const clipped = Math.max(-1, Math.min(1, mix));
  audioPcmBuffer.writeInt16LE(Math.round(clipped * 32_000), sample * AUDIO_BLOCK_ALIGN);
}

// Boot IXAudio2.
const ppXAudio2 = Buffer.alloc(8);
let xaudioEngine = 0n;
let xaudioMaster = 0n;
let xaudioSource = 0n;
let xaudioAvailable = false;

if (Xaudio2_9.XAudio2Create(ppXAudio2.ptr, 0, XAUDIO2_USE_DEFAULT_PROCESSOR) === S_OK) {
  xaudioEngine = ppXAudio2.readBigUInt64LE(0);

  const ppMaster = Buffer.alloc(8);
  const masterHr = vcall(
    xaudioEngine,
    IXAUDIO2_CREATEMASTERINGVOICE,
    [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
    [ppMaster.ptr, 0, 0, 0, null, null, AudioCategory_GameMedia],
  );
  if (masterHr === S_OK) {
    xaudioMaster = ppMaster.readBigUInt64LE(0);

    const waveFormat = Buffer.alloc(18);
    waveFormat.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
    waveFormat.writeUInt16LE(AUDIO_CHANNELS, 2);
    waveFormat.writeUInt32LE(SAMPLE_RATE, 4);
    waveFormat.writeUInt32LE(SAMPLE_RATE * AUDIO_BLOCK_ALIGN, 8);
    waveFormat.writeUInt16LE(AUDIO_BLOCK_ALIGN, 12);
    waveFormat.writeUInt16LE(AUDIO_BITS, 14);
    waveFormat.writeUInt16LE(0, 16);

    const ppSource = Buffer.alloc(8);
    const sourceHr = vcall(
      xaudioEngine,
      IXAUDIO2_CREATESOURCEVOICE,
      [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      [ppSource.ptr, waveFormat.ptr, 0, 2.0, null, null, null],
    );
    if (sourceHr === S_OK) {
      xaudioSource = ppSource.readBigUInt64LE(0);

      // XAUDIO2_BUFFER (48 bytes on x64): Flags, AudioBytes, pAudioData @8,
      // PlayBegin, PlayLength, LoopBegin, LoopLength, LoopCount, pContext @40.
      const xaudioBuffer = Buffer.alloc(48);
      xaudioBuffer.writeUInt32LE(0, 0); // Flags (no END_OF_STREAM — we loop forever)
      xaudioBuffer.writeUInt32LE(audioPcmBuffer.length, 4);
      xaudioBuffer.writeBigUInt64LE(BigInt(audioPcmBuffer.ptr!), 8);
      xaudioBuffer.writeUInt32LE(0, 16); // PlayBegin
      xaudioBuffer.writeUInt32LE(0, 20); // PlayLength
      xaudioBuffer.writeUInt32LE(0, 24); // LoopBegin
      xaudioBuffer.writeUInt32LE(0, 28); // LoopLength = 0 → loop the whole buffer
      xaudioBuffer.writeUInt32LE(XAUDIO2_LOOP_INFINITE, 32);
      xaudioBuffer.writeBigUInt64LE(0n, 40);

      if (
        vcall(
          xaudioSource,
          IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER,
          [FFIType.ptr, FFIType.ptr],
          [xaudioBuffer.ptr, null],
        ) === S_OK
      ) {
        xaudioAvailable = true;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDH CPU counter
// ─────────────────────────────────────────────────────────────────────────────

const pdhQueryBuf = Buffer.alloc(8);
let pdhQuery = 0n;
let pdhCpuCounter = 0n;
let pdhAvailable = false;

if (Pdh.PdhOpenQueryW(null, 0n, pdhQueryBuf.ptr) === 0) {
  pdhQuery = pdhQueryBuf.readBigUInt64LE(0);
  const counterPath = encodeUtf16('\\Processor(_Total)\\% Processor Time');
  const counterHandleBuf = Buffer.alloc(8);
  if (Pdh.PdhAddEnglishCounterW(pdhQuery, counterPath.ptr, 0n, counterHandleBuf.ptr) === 0) {
    pdhCpuCounter = counterHandleBuf.readBigUInt64LE(0);
    Pdh.PdhCollectQueryData(pdhQuery); // baseline; rate counters need two samples
    pdhAvailable = true;
  }
}

const pdhValueBuf = Buffer.alloc(24);

function readCpuPercent(): number {
  if (!pdhAvailable) return 0;
  if (Pdh.PdhCollectQueryData(pdhQuery) !== 0) return 0;
  if (Pdh.PdhGetFormattedCounterValue(pdhCpuCounter, PdhCounterFormat.PDH_FMT_DOUBLE, null, pdhValueBuf.ptr) !== 0) return 0;
  return pdhValueBuf.readDoubleLE(8);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kernel32 MEMORYSTATUSEX
// ─────────────────────────────────────────────────────────────────────────────

const memoryStatusBuffer = Buffer.alloc(64);
memoryStatusBuffer.writeUInt32LE(64, 0); // dwLength

function readMemoryUsagePercent(): { percent: number; usedGiB: number; totalGiB: number } {
  if (!Kernel32.GlobalMemoryStatusEx(memoryStatusBuffer.ptr)) return { percent: 0, usedGiB: 0, totalGiB: 0 };
  const memoryLoad = memoryStatusBuffer.readUInt32LE(4);
  const totalPhys = Number(memoryStatusBuffer.readBigUInt64LE(8));
  const availPhys = Number(memoryStatusBuffer.readBigUInt64LE(16));
  const usedPhys = totalPhys - availPhys;
  return { percent: memoryLoad, usedGiB: usedPhys / 1024 ** 3, totalGiB: totalPhys / 1024 ** 3 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Psapi process count
// ─────────────────────────────────────────────────────────────────────────────

const pidBuffer = Buffer.alloc(64 * 1024); // 16k PIDs max
const pidBytesReturned = Buffer.alloc(4);

function readProcessCount(): number {
  if (!Psapi.EnumProcesses(pidBuffer.ptr, pidBuffer.byteLength, pidBytesReturned.ptr)) return 0;
  return pidBytesReturned.readUInt32LE(0) / 4;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake-window model
// ─────────────────────────────────────────────────────────────────────────────

interface DesktopWindowDescriptor {
  id: 'task-monitor' | 'music-player' | 'clock';
  title: string;
  taskbarLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden: boolean;
  zOrder: number;
}

const TITLEBAR_HEIGHT = 32;
const CLOSE_BUTTON_RADIUS = 8;

const desktopWindows: DesktopWindowDescriptor[] = [
  { id: 'task-monitor', title: 'Task Monitor', taskbarLabel: 'Monitor', x: 70, y: 60, width: 460, height: 320, hidden: false, zOrder: 0 },
  { id: 'music-player', title: 'Music Player', taskbarLabel: 'Player', x: 560, y: 60, width: 430, height: 220, hidden: false, zOrder: 1 },
  { id: 'clock', title: 'Clock', taskbarLabel: 'Clock', x: 360, y: 380, width: 380, height: 290, hidden: false, zOrder: 2 },
];

let nextZ = desktopWindows.length;

function bringWindowToFront(target: DesktopWindowDescriptor): void {
  target.zOrder = nextZ++;
}

function sortedByZ(): DesktopWindowDescriptor[] {
  return [...desktopWindows].sort((leftWindow, rightWindow) => leftWindow.zOrder - rightWindow.zOrder);
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry histories for the Task Monitor graphs
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_LENGTH = 96;
const cpuHistory: number[] = new Array(HISTORY_LENGTH).fill(0);
const ramHistory: number[] = new Array(HISTORY_LENGTH).fill(0);
const processCountHistory: number[] = new Array(HISTORY_LENGTH).fill(0);

let currentCpu = 0;
let currentRamLoad = 0;
let currentRamUsedGiB = 0;
let currentRamTotalGiB = 0;
let currentProcessCount = 0;

let lastTelemetryTick = 0;

function tickTelemetry(): void {
  const now = Date.now();
  if (now - lastTelemetryTick < 950) return;
  lastTelemetryTick = now;

  currentCpu = readCpuPercent();
  const memory = readMemoryUsagePercent();
  currentRamLoad = memory.percent;
  currentRamUsedGiB = memory.usedGiB;
  currentRamTotalGiB = memory.totalGiB;
  currentProcessCount = readProcessCount();

  cpuHistory.shift();
  cpuHistory.push(currentCpu);
  ramHistory.shift();
  ramHistory.push(currentRamLoad);
  processCountHistory.shift();
  processCountHistory.push(currentProcessCount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Music player state
// ─────────────────────────────────────────────────────────────────────────────

let musicPlaying = false;

function setMusicPlaying(shouldPlay: boolean): void {
  if (!xaudioAvailable) return;
  if (shouldPlay === musicPlaying) return;
  if (shouldPlay) {
    vcall(xaudioSource, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
  } else {
    vcall(xaudioSource, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
  }
  musicPlaying = shouldPlay;
}

if (xaudioAvailable) setMusicPlaying(true);

const voiceStateBuffer = Buffer.alloc(24);

function readMusicProgress(): number {
  if (!xaudioAvailable) return 0;
  vcall(xaudioSource, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [voiceStateBuffer.ptr, 0], FFIType.void);
  const samplesPlayed = Number(voiceStateBuffer.readBigUInt64LE(16));
  return (samplesPlayed % TOTAL_LOOP_SAMPLES) / TOTAL_LOOP_SAMPLES;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag tracking + hit test
// ─────────────────────────────────────────────────────────────────────────────

let draggedWindow: DesktopWindowDescriptor | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

interface MusicButtonRegion {
  type: 'play-pause';
  windowId: 'music-player';
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TaskbarPillRegion {
  type: 'taskbar-pill';
  targetWindow: DesktopWindowDescriptor;
  x: number;
  y: number;
  width: number;
  height: number;
}

type HotRegion = MusicButtonRegion | TaskbarPillRegion;

const hotRegions: HotRegion[] = [];

let hotRegionHovered: HotRegion | null = null;

function pointInRect(pointX: number, pointY: number, rectX: number, rectY: number, rectWidth: number, rectHeight: number): boolean {
  return pointX >= rectX && pointX <= rectX + rectWidth && pointY >= rectY && pointY <= rectY + rectHeight;
}

function pointInCloseButton(localX: number, localY: number, windowWidth: number): boolean {
  const closeCenterX = windowWidth - 16;
  const closeCenterY = TITLEBAR_HEIGHT / 2;
  const dx = localX - closeCenterX;
  const dy = localY - closeCenterY;
  return dx * dx + dy * dy <= CLOSE_BUTTON_RADIUS * CLOSE_BUTTON_RADIUS + 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

const tempRectBuf = Buffer.alloc(16);

function drawString(text: string, font: bigint, brush: bigint, layoutX: number, layoutY: number, layoutWidth: number, layoutHeight: number, format: bigint): void {
  tempRectBuf.writeFloatLE(layoutX, 0);
  tempRectBuf.writeFloatLE(layoutY, 4);
  tempRectBuf.writeFloatLE(layoutWidth, 8);
  tempRectBuf.writeFloatLE(layoutHeight, 12);
  const encoded = encodeUtf16(text);
  Gdiplus.GdipDrawString(graphics, encoded.ptr, -1, font, tempRectBuf.ptr, format, brush);
}

function makeRoundRectPath(x: number, y: number, width: number, height: number, radius: number): bigint {
  const pathOut = Buffer.alloc(8);
  Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, pathOut.ptr);
  const path = pathOut.readBigUInt64LE(0);
  const r = Math.min(radius, width / 2, height / 2);
  Gdiplus.GdipAddPathArc(path, x, y, r * 2, r * 2, 180, 90);
  Gdiplus.GdipAddPathArc(path, x + width - r * 2, y, r * 2, r * 2, 270, 90);
  Gdiplus.GdipAddPathArc(path, x + width - r * 2, y + height - r * 2, r * 2, r * 2, 0, 90);
  Gdiplus.GdipAddPathArc(path, x + 0, y + height - r * 2, r * 2, r * 2, 90, 90);
  Gdiplus.GdipClosePathFigure(path);
  return path;
}

function fillRoundRect(brush: bigint, x: number, y: number, width: number, height: number, radius: number): void {
  const path = makeRoundRectPath(x, y, width, height, radius);
  Gdiplus.GdipFillPath(graphics, brush, path);
  Gdiplus.GdipDeletePath(path);
}

function strokeRoundRect(pen: bigint, x: number, y: number, width: number, height: number, radius: number): void {
  const path = makeRoundRectPath(x, y, width, height, radius);
  Gdiplus.GdipDrawPath(graphics, pen, path);
  Gdiplus.GdipDeletePath(path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-app renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderTaskMonitor(window: DesktopWindowDescriptor): void {
  const contentX = window.x + 14;
  const contentY = window.y + TITLEBAR_HEIGHT + 12;
  const contentWidth = window.width - 28;
  const contentHeight = window.height - TITLEBAR_HEIGHT - 24;

  const rowHeight = (contentHeight - 12) / 3;
  const labelWidth = 70;
  const valueWidth = 110;
  const graphLeft = contentX + labelWidth;
  const graphWidth = contentWidth - labelWidth - valueWidth - 8;

  const draws: Array<{
    label: string;
    valueText: string;
    history: number[];
    maxValue: number;
    fillBrush: bigint;
    linePen: bigint;
    rowY: number;
  }> = [
    {
      label: 'CPU',
      valueText: `${currentCpu.toFixed(1)}%`,
      history: cpuHistory,
      maxValue: 100,
      fillBrush: brushGraphCpu,
      linePen: penGraphCpu,
      rowY: contentY,
    },
    {
      label: 'RAM',
      valueText: `${currentRamLoad.toFixed(0)}% · ${currentRamUsedGiB.toFixed(1)}/${currentRamTotalGiB.toFixed(0)} GiB`,
      history: ramHistory,
      maxValue: 100,
      fillBrush: brushGraphRam,
      linePen: penGraphRam,
      rowY: contentY + rowHeight + 6,
    },
    {
      label: 'Procs',
      valueText: currentProcessCount.toString(),
      history: processCountHistory,
      maxValue: Math.max(500, ...processCountHistory) * 1.2,
      fillBrush: brushGraphProc,
      linePen: penGraphProc,
      rowY: contentY + 2 * (rowHeight + 6),
    },
  ];

  for (const row of draws) {
    drawString(row.label, fontTitle, brushTextDim, contentX, row.rowY, labelWidth, rowHeight, formatNearCenter);
    drawString(row.valueText, fontMetric, brushText, contentX + contentWidth - valueWidth, row.rowY, valueWidth, rowHeight, formatFarNear);

    // Graph background.
    Gdiplus.GdipFillRectangle(graphics, brushTitleBar, graphLeft, row.rowY + 4, graphWidth, rowHeight - 12);

    // Plot the history as a stacked area + line.
    if (row.history.length >= 2) {
      const stepX = graphWidth / (HISTORY_LENGTH - 1);
      const points: number[] = [];
      // 2 extra anchor points to close the polygon at the baseline.
      points.push(graphLeft, row.rowY + 4 + (rowHeight - 12));
      for (let historyIndex = 0; historyIndex < HISTORY_LENGTH; historyIndex++) {
        const sampleValue = row.history[historyIndex]!;
        const normalised = Math.max(0, Math.min(1, sampleValue / row.maxValue));
        points.push(graphLeft + historyIndex * stepX, row.rowY + 4 + (1 - normalised) * (rowHeight - 12));
      }
      points.push(graphLeft + (HISTORY_LENGTH - 1) * stepX, row.rowY + 4 + (rowHeight - 12));

      const polyBuf = Buffer.alloc(points.length * 4);
      for (let i = 0; i < points.length; i++) polyBuf.writeFloatLE(points[i]!, i * 4);
      Gdiplus.GdipFillPolygon(graphics, row.fillBrush, polyBuf.ptr, points.length / 2, FillMode.FillModeAlternate);

      // Outline (drop the closing baseline anchors).
      const linePoints = points.slice(2, points.length - 2);
      const linePointsBuf = Buffer.alloc(linePoints.length * 4);
      for (let i = 0; i < linePoints.length; i++) linePointsBuf.writeFloatLE(linePoints[i]!, i * 4);
      Gdiplus.GdipDrawLines(graphics, row.linePen, linePointsBuf.ptr, linePoints.length / 2);
    }
  }
}

function renderMusicPlayer(window: DesktopWindowDescriptor): void {
  const contentX = window.x + 14;
  const contentY = window.y + TITLEBAR_HEIGHT + 14;
  const contentWidth = window.width - 28;

  drawString('NOW PLAYING', fontSmall, brushTextDim, contentX, contentY, contentWidth, 18, formatNearNear);
  drawString('Bun OS — Hello, World Loop', fontTitle, brushText, contentX, contentY + 18, contentWidth, 24, formatNearNear);
  drawString(xaudioAvailable ? 'Procedural 4-bar chiptune · IXAudio2 source voice' : 'XAudio2 unavailable in this environment', fontSmall, brushTextDim, contentX, contentY + 46, contentWidth, 16, formatNearNear);

  // Progress bar
  const progressY = contentY + 78;
  const progressHeight = 8;
  Gdiplus.GdipFillRectangle(graphics, brushTitleBar, contentX, progressY, contentWidth, progressHeight);
  const progress = readMusicProgress();
  if (xaudioAvailable && progress > 0) {
    Gdiplus.GdipFillRectangle(graphics, brushButtonHot, contentX, progressY, contentWidth * progress, progressHeight);
  }
  drawString('00:00', fontSmall, brushTextDim, contentX, progressY + 14, 60, 16, formatNearNear);
  drawString(`${Math.floor(TOTAL_LOOP_SECONDS / 60).toString().padStart(2, '0')}:${(TOTAL_LOOP_SECONDS % 60).toString().padStart(2, '0')}`, fontSmall, brushTextDim, contentX + contentWidth - 60, progressY + 14, 60, 16, formatFarNear);

  // Play/Pause button
  const buttonSize = 40;
  const buttonX = window.x + (window.width - buttonSize) / 2;
  const buttonY = progressY + 36;
  const isHot = hotRegionHovered?.type === 'play-pause';
  fillRoundRect(isHot ? brushButtonHot : brushButton, buttonX, buttonY, buttonSize, buttonSize, 12);

  // Draw a play triangle or pause bars in the centre.
  if (musicPlaying) {
    const barWidth = 5;
    const barHeight = 16;
    const barY = buttonY + (buttonSize - barHeight) / 2;
    Gdiplus.GdipFillRectangle(graphics, brushText, buttonX + 12, barY, barWidth, barHeight);
    Gdiplus.GdipFillRectangle(graphics, brushText, buttonX + buttonSize - 12 - barWidth, barY, barWidth, barHeight);
  } else {
    // Equilateral triangle.
    const triangleSize = 16;
    const triangleX = buttonX + (buttonSize - triangleSize) / 2 + 3;
    const triangleY = buttonY + (buttonSize - triangleSize) / 2;
    const triPoints = [
      triangleX,
      triangleY,
      triangleX + triangleSize,
      triangleY + triangleSize / 2,
      triangleX,
      triangleY + triangleSize,
    ];
    const triBuf = Buffer.alloc(triPoints.length * 4);
    for (let i = 0; i < triPoints.length; i++) triBuf.writeFloatLE(triPoints[i]!, i * 4);
    Gdiplus.GdipFillPolygon(graphics, brushText, triBuf.ptr, triPoints.length / 2, FillMode.FillModeAlternate);
  }

  // Register the hot region for click handling.
  hotRegions.push({ type: 'play-pause', windowId: 'music-player', x: buttonX, y: buttonY, width: buttonSize, height: buttonSize });
}

function renderClock(window: DesktopWindowDescriptor): void {
  const time = Buffer.alloc(16);
  Kernel32.GetLocalTime(time.ptr);
  const hours = time.readUInt16LE(8);
  const minutes = time.readUInt16LE(10);
  const seconds = time.readUInt16LE(12);
  const millis = time.readUInt16LE(14);

  const contentX = window.x + 14;
  const contentY = window.y + TITLEBAR_HEIGHT + 14;
  const contentWidth = window.width - 28;
  const contentHeight = window.height - TITLEBAR_HEIGHT - 56;

  const radius = Math.min(contentWidth, contentHeight) / 2 - 6;
  const centerX = window.x + window.width / 2;
  const centerY = contentY + contentHeight / 2;

  // Face.
  Gdiplus.GdipFillEllipse(graphics, brushClockFace, centerX - radius, centerY - radius, radius * 2, radius * 2);

  // Ticks
  for (let tickIndex = 0; tickIndex < 60; tickIndex++) {
    const tickAngle = (tickIndex / 60) * Math.PI * 2 - Math.PI / 2;
    const outer = radius - 4;
    const inner = tickIndex % 5 === 0 ? radius - 18 : radius - 10;
    const fromX = centerX + Math.cos(tickAngle) * inner;
    const fromY = centerY + Math.sin(tickAngle) * inner;
    const toX = centerX + Math.cos(tickAngle) * outer;
    const toY = centerY + Math.sin(tickAngle) * outer;
    Gdiplus.GdipDrawLine(graphics, tickIndex % 5 === 0 ? penClockTick : penClockTickMinor, fromX, fromY, toX, toY);
  }

  // Hands. The second hand interpolates with ms for smoothness.
  const secondAngle = ((seconds + millis / 1000) / 60) * Math.PI * 2 - Math.PI / 2;
  const minuteAngle = ((minutes + seconds / 60) / 60) * Math.PI * 2 - Math.PI / 2;
  const hourAngle = (((hours % 12) + minutes / 60) / 12) * Math.PI * 2 - Math.PI / 2;

  function drawHand(angle: number, length: number, thickness: number, brush: bigint): void {
    // Build a rectangle perpendicular to the hand direction, then fill it via path.
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const perpX = -dirY;
    const perpY = dirX;
    const halfThickness = thickness / 2;
    const tailLength = length * 0.18;
    const tipX = centerX + dirX * length;
    const tipY = centerY + dirY * length;
    const baseX = centerX - dirX * tailLength;
    const baseY = centerY - dirY * tailLength;

    const points = [
      tipX + perpX * halfThickness,
      tipY + perpY * halfThickness,
      tipX - perpX * halfThickness,
      tipY - perpY * halfThickness,
      baseX - perpX * halfThickness,
      baseY - perpY * halfThickness,
      baseX + perpX * halfThickness,
      baseY + perpY * halfThickness,
    ];
    const buf = Buffer.alloc(points.length * 4);
    for (let i = 0; i < points.length; i++) buf.writeFloatLE(points[i]!, i * 4);
    Gdiplus.GdipFillPolygon(graphics, brush, buf.ptr, points.length / 2, FillMode.FillModeAlternate);
  }

  drawHand(hourAngle, radius * 0.55, 6, brushClockHour);
  drawHand(minuteAngle, radius * 0.78, 4, brushClockMin);
  drawHand(secondAngle, radius * 0.85, 2, brushClockSec);

  // Centre cap.
  Gdiplus.GdipFillEllipse(graphics, brushClockSec, centerX - 5, centerY - 5, 10, 10);

  // Digital readout under the dial.
  const digital = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  drawString(digital, fontGiantClock, brushText, contentX, window.y + window.height - 46, contentWidth, 36, formatCenterNear);
}

// ─────────────────────────────────────────────────────────────────────────────
// Window chrome + body renderer
// ─────────────────────────────────────────────────────────────────────────────

function renderDesktopWindow(window: DesktopWindowDescriptor, isActive: boolean): void {
  // Shadow
  const shadowBrush = makeSolidBrush(argb(70, 0, 0, 0));
  Gdiplus.GdipFillRectangle(graphics, shadowBrush, window.x + 6, window.y + 8, window.width, window.height);
  Gdiplus.GdipDeleteBrush(shadowBrush);

  // Body
  fillRoundRect(brushWindowBody, window.x, window.y, window.width, window.height, 10);
  // Title bar
  const titlePath = makeRoundRectPath(window.x, window.y, window.width, TITLEBAR_HEIGHT, 10);
  Gdiplus.GdipFillPath(graphics, brushTitleBar, titlePath);
  Gdiplus.GdipDeletePath(titlePath);
  // Connect titlebar to body underneath (the rounded path leaves a notch at the
  // bottom corners; cover it with a small rectangle).
  Gdiplus.GdipFillRectangle(graphics, brushTitleBar, window.x, window.y + TITLEBAR_HEIGHT - 10, window.width, 10);

  // Border
  strokeRoundRect(isActive ? penWindowBorderActive : penWindowBorder, window.x, window.y, window.width, window.height, 10);

  // Title text
  drawString(window.title, fontTitle, brushText, window.x + 14, window.y, window.width - 50, TITLEBAR_HEIGHT, formatNearCenter);

  // Close button (red dot)
  Gdiplus.GdipFillEllipse(
    graphics,
    brushClose,
    window.x + window.width - 16 - CLOSE_BUTTON_RADIUS,
    window.y + TITLEBAR_HEIGHT / 2 - CLOSE_BUTTON_RADIUS,
    CLOSE_BUTTON_RADIUS * 2,
    CLOSE_BUTTON_RADIUS * 2,
  );

  // Per-app body
  switch (window.id) {
    case 'task-monitor':
      renderTaskMonitor(window);
      break;
    case 'music-player':
      renderMusicPlayer(window);
      break;
    case 'clock':
      renderClock(window);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Taskbar
// ─────────────────────────────────────────────────────────────────────────────

function renderTaskbar(): void {
  const taskbarY = DESKTOP_HEIGHT - TASKBAR_HEIGHT;
  Gdiplus.GdipFillRectangle(graphics, brushTaskbar, 0, taskbarY, DESKTOP_WIDTH, TASKBAR_HEIGHT);
  Gdiplus.GdipFillRectangle(graphics, brushTaskbarLine, 0, taskbarY, DESKTOP_WIDTH, 1);

  // Start pill
  const startX = 16;
  const startY = taskbarY + 12;
  const startWidth = 100;
  const startHeight = TASKBAR_HEIGHT - 24;
  fillRoundRect(brushStart, startX, startY, startWidth, startHeight, 12);
  drawString('Bun OS', fontTaskbar, brushText, startX, startY, startWidth, startHeight, formatCenterCenter);

  // App pills
  let pillX = startX + startWidth + 20;
  const pillWidth = 130;
  const pillHeight = TASKBAR_HEIGHT - 24;
  const topWindow = sortedByZ()[desktopWindows.length - 1];

  for (const window of desktopWindows) {
    const isTop = !window.hidden && window === topWindow;
    const fillBrush = window.hidden ? brushPillHidden : isTop ? brushPillActive : brushPillInactive;
    fillRoundRect(fillBrush, pillX, startY, pillWidth, pillHeight, 12);

    // A small status dot on the left.
    Gdiplus.GdipFillEllipse(graphics, window.hidden ? brushTextDim : brushText, pillX + 12, startY + pillHeight / 2 - 4, 8, 8);
    drawString(window.taskbarLabel, fontTaskbar, brushText, pillX + 28, startY, pillWidth - 36, pillHeight, formatNearCenter);

    hotRegions.push({ type: 'taskbar-pill', targetWindow: window, x: pillX, y: startY, width: pillWidth, height: pillHeight });
    pillX += pillWidth + 10;
  }

  // Clock on the right side of the taskbar.
  const time = Buffer.alloc(16);
  Kernel32.GetLocalTime(time.ptr);
  const hh = time.readUInt16LE(8).toString().padStart(2, '0');
  const mm = time.readUInt16LE(10).toString().padStart(2, '0');
  drawString(`${hh}:${mm}`, fontTitle, brushText, DESKTOP_WIDTH - 90, taskbarY, 70, TASKBAR_HEIGHT, formatCenterCenter);

  // Hint
  drawString('ESC: quit  ·  drag titlebars  ·  click red dot to minimize', fontSmall, brushTextDim, 0, taskbarY - 22, DESKTOP_WIDTH - 16, 20, formatFarNear);
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame composer
// ─────────────────────────────────────────────────────────────────────────────

function renderFrame(): void {
  hotRegions.length = 0;
  tickTelemetry();

  // Wallpaper.
  Gdiplus.GdipFillRectangle(graphics, wallpaperBrush, 0, 0, DESKTOP_WIDTH, DESKTOP_HEIGHT);

  // Subtle stars.
  let prng = 12345;
  for (let starIndex = 0; starIndex < 80; starIndex++) {
    prng = (prng * 48271) & 0x7fff_ffff;
    const starX = (prng / 0x7fff_ffff) * DESKTOP_WIDTH;
    prng = (prng * 48271) & 0x7fff_ffff;
    const starY = (prng / 0x7fff_ffff) * (DESKTOP_HEIGHT - TASKBAR_HEIGHT);
    prng = (prng * 48271) & 0x7fff_ffff;
    const starSize = 1 + (prng & 0x3) * 0.5;
    Gdiplus.GdipFillEllipse(graphics, brushTextDim, starX, starY, starSize, starSize);
  }

  // Branding watermark.
  drawString('@bun-win32/all', fontBody, brushTextDim, 20, 20, 400, 24, formatNearNear);
  drawString('Tiny desktop · 1 process · 100% FFI', fontSmall, brushTextDim, 20, 42, 400, 18, formatNearNear);

  // Windows in z-order.
  const zSorted = sortedByZ();
  const topWindow = zSorted[zSorted.length - 1];
  for (const window of zSorted) {
    if (window.hidden) continue;
    renderDesktopWindow(window, window === topWindow);
  }

  // Taskbar last (always on top).
  renderTaskbar();
}

// ─────────────────────────────────────────────────────────────────────────────
// Window class + WndProc
// ─────────────────────────────────────────────────────────────────────────────

const className = encodeUtf16('BunOSDesktop');
const windowTitle = encodeUtf16('Bun OS');

let mainHwnd = 0n;
let frameCounter = 0;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    switch (msg) {
      case WM_ERASEBKGND:
        // Suppress flicker; we paint every pixel ourselves each frame.
        return 1n;

      case WM_TIMER:
        if (wParam === FRAME_TIMER_ID) {
          frameCounter++;
          renderFrame();

          const hdc = User32.GetDC(hWnd);
          if (hdc) {
            GDI32.SetDIBitsToDevice(
              hdc,
              0,
              0,
              DESKTOP_WIDTH,
              DESKTOP_HEIGHT,
              0,
              0,
              0,
              DESKTOP_HEIGHT,
              framebuffer.ptr,
              bitmapInfo.ptr,
              DIB_RGB_COLORS,
            );
            User32.ReleaseDC(hWnd, hdc);
          }
        }
        return 0n;

      case WM_PAINT: {
        // Just consume; the frame timer drives all rendering.
        const paintBuf = Buffer.alloc(80);
        const paintHdc = User32.BeginPaint(hWnd, paintBuf.ptr);
        if (paintHdc) {
          GDI32.SetDIBitsToDevice(
            paintHdc,
            0,
            0,
            DESKTOP_WIDTH,
            DESKTOP_HEIGHT,
            0,
            0,
            0,
            DESKTOP_HEIGHT,
            framebuffer.ptr,
            bitmapInfo.ptr,
            DIB_RGB_COLORS,
          );
        }
        User32.EndPaint(hWnd, paintBuf.ptr);
        return 0n;
      }

      case WM_LBUTTONDOWN: {
        const mouseX = Number(BigInt.asIntN(16, lParam));
        const mouseY = Number(BigInt.asIntN(16, lParam >> 16n));

        // Hot regions first (so taskbar pills + play/pause beat window-body drags).
        for (const region of hotRegions) {
          if (pointInRect(mouseX, mouseY, region.x, region.y, region.width, region.height)) {
            if (region.type === 'play-pause') {
              setMusicPlaying(!musicPlaying);
            } else if (region.type === 'taskbar-pill') {
              region.targetWindow.hidden = !region.targetWindow.hidden;
              if (!region.targetWindow.hidden) bringWindowToFront(region.targetWindow);
            }
            return 0n;
          }
        }

        // Window hit-test (front to back).
        const zSorted = sortedByZ().slice().reverse();
        for (const window of zSorted) {
          if (window.hidden) continue;
          if (!pointInRect(mouseX, mouseY, window.x, window.y, window.width, window.height)) continue;

          bringWindowToFront(window);
          const localX = mouseX - window.x;
          const localY = mouseY - window.y;

          if (localY < TITLEBAR_HEIGHT) {
            if (pointInCloseButton(localX, localY, window.width)) {
              window.hidden = true;
              return 0n;
            }
            draggedWindow = window;
            dragOffsetX = localX;
            dragOffsetY = localY;
            User32.SetCapture(hWnd);
          }
          return 0n;
        }
        return 0n;
      }

      case WM_MOUSEMOVE: {
        if (draggedWindow) {
          const mouseX = Number(BigInt.asIntN(16, lParam));
          const mouseY = Number(BigInt.asIntN(16, lParam >> 16n));
          draggedWindow.x = Math.max(-draggedWindow.width + 80, Math.min(DESKTOP_WIDTH - 80, mouseX - dragOffsetX));
          draggedWindow.y = Math.max(0, Math.min(DESKTOP_HEIGHT - TASKBAR_HEIGHT - TITLEBAR_HEIGHT, mouseY - dragOffsetY));
        }
        // Hover detection for the play/pause button so it can highlight.
        const mouseX = Number(BigInt.asIntN(16, lParam));
        const mouseY = Number(BigInt.asIntN(16, lParam >> 16n));
        hotRegionHovered = null;
        for (const region of hotRegions) {
          if (pointInRect(mouseX, mouseY, region.x, region.y, region.width, region.height)) {
            hotRegionHovered = region;
            break;
          }
        }
        return 0n;
      }

      case WM_LBUTTONUP:
        if (draggedWindow) {
          draggedWindow = null;
          User32.ReleaseCapture();
        }
        return 0n;

      case WM_KEYDOWN:
        if (wParam === BigInt(VK_ESCAPE)) {
          User32.DestroyWindow(hWnd);
          return 0n;
        }
        return 0n;

      case WM_CLOSE:
        User32.DestroyWindow(hWnd);
        return 0n;

      case WM_DESTROY:
        User32.PostQuitMessage(0);
        return 0n;
    }

    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  {
    args: ['u64', 'u32', 'u64', 'i64'],
    returns: 'i64',
  },
);

// WNDCLASSEXW = 80 bytes on x64.
const windowClassBuffer = Buffer.alloc(80);
const windowClassView = new DataView(windowClassBuffer.buffer);
windowClassView.setUint32(0, 80, true); // cbSize
windowClassView.setUint32(4, 0x0020 | 0x0002 | 0x0001, true); // CS_OWNDC | CS_VREDRAW | CS_HREDRAW
windowClassBuffer.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
windowClassView.setInt32(16, 0, true);
windowClassView.setInt32(20, 0, true);

const hInstance = Kernel32.GetModuleHandleW(null!);
windowClassBuffer.writeBigUInt64LE(BigInt(hInstance), 24); // hInstance
windowClassBuffer.writeBigUInt64LE(0n, 32); // hIcon
windowClassBuffer.writeBigUInt64LE(0n, 40); // hCursor (use IDC_ARROW via LoadCursorW(NULL,32512)? skipped)
windowClassBuffer.writeBigUInt64LE(0n, 48); // hbrBackground
windowClassBuffer.writeBigUInt64LE(0n, 56); // lpszMenuName
windowClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
windowClassBuffer.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(windowClassBuffer.ptr);
if (!classAtom) {
  throw new Error('RegisterClassExW failed');
}

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const windowX = Math.floor((screenWidth - DESKTOP_WIDTH) / 2);
const windowY = Math.floor((screenHeight - DESKTOP_HEIGHT) / 2);

mainHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  windowTitle.ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  DESKTOP_WIDTH,
  DESKTOP_HEIGHT,
  0n,
  0n,
  hInstance,
  NULL_PTR,
);
if (!mainHwnd) {
  throw new Error('CreateWindowExW failed');
}

// Dark chrome + mica backdrop.
const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(mainHwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(mainHwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);

User32.ShowWindow(mainHwnd, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(mainHwnd);

User32.SetTimer(mainHwnd, FRAME_TIMER_ID, FRAME_INTERVAL_MS, null);

console.log('=============================================');
console.log('             B U N   O S   v1.0              ');
console.log('=============================================');
console.log('');
console.log('  A tiny desktop running inside one Bun process.');
console.log('  Drag the title bars. Click red dots to minimize.');
console.log('  Re-open from the taskbar pills. ESC to quit.');
console.log('');
if (xaudioAvailable) {
  console.log('  Audio: IXAudio2 source voice (looping chiptune).');
} else {
  console.log('  Audio: XAudio2 unavailable in this environment.');
}
if (pdhAvailable) {
  console.log('  Telemetry: PDH \\Processor(_Total)\\% Processor Time.');
} else {
  console.log('  Telemetry: PDH unavailable; CPU graph will read zero.');
}
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup + message pump
// ─────────────────────────────────────────────────────────────────────────────

let teardownComplete = false;

function teardown(): void {
  if (teardownComplete) return;
  teardownComplete = true;

  if (xaudioAvailable) {
    vcall(xaudioSource, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
    vcall(xaudioSource, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  }
  if (xaudioMaster !== 0n) vcall(xaudioMaster, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  if (xaudioEngine !== 0n) vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);

  if (pdhAvailable) {
    if (pdhCpuCounter !== 0n) Pdh.PdhRemoveCounter(pdhCpuCounter);
    Pdh.PdhCloseQuery(pdhQuery);
  }

  Gdiplus.GdipDeleteBrush(wallpaperBrush);
  for (const brush of [brushWindowBody, brushTitleBar, brushTaskbar, brushStart, brushPillInactive, brushPillActive, brushPillHidden, brushClose, brushText, brushTextDim, brushClockFace, brushClockHour, brushClockMin, brushClockSec, brushGraphCpu, brushGraphRam, brushGraphProc, brushTaskbarLine, brushButton, brushButtonHot]) {
    Gdiplus.GdipDeleteBrush(brush);
  }
  for (const pen of [penWindowBorder, penWindowBorderActive, penGraphCpu, penGraphRam, penGraphProc, penClockTick, penClockTickMinor]) {
    Gdiplus.GdipDeletePen(pen);
  }
  for (const font of [fontTitle, fontBody, fontTaskbar, fontGiantClock, fontMetric, fontSmall]) {
    Gdiplus.GdipDeleteFont(font);
  }
  Gdiplus.GdipDeleteFontFamily(fontFamilyUi);
  Gdiplus.GdipDeleteFontFamily(fontFamilyMono);
  for (const format of [formatNearNear, formatCenterCenter, formatCenterNear, formatNearCenter, formatFarNear]) {
    Gdiplus.GdipDeleteStringFormat(format);
  }
  Gdiplus.GdipDeleteGraphics(graphics);
  Gdiplus.GdipDisposeImage(framebufferBitmap);
  Gdiplus.GdiplusShutdown(gdiplusToken);

  User32.UnregisterClassW(className.ptr, hInstance);
  wndProc.close();

  console.log(`  Bun OS shut down cleanly after ${frameCounter} frames.`);
}

process.on('SIGINT', () => {
  teardown();
  process.exit(0);
});

const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr, 0n, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr);
  User32.DispatchMessageW(messageBuffer.ptr);
}

teardown();
