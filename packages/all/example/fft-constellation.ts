/**
 * FFT Constellation — Your microphone becomes a 3D star field.
 *
 * Captures the default microphone via `waveInOpen` at 44.1 kHz mono 16-bit and
 * pumps every recorded WAVEHDR (~93 ms of audio, 4096 samples) into a Hann-
 * windowed Cooley-Tukey radix-2 FFT. The 2048 resulting magnitude bins are then
 * downsampled in groups of four to 512 stars whose 3D positions are computed
 * once at startup from a spiral mapping of bin index → spherical coordinates.
 * The whole constellation rotates on its own around the Y and X axes and pulses
 * with the loudest beats; each star's brightness encodes its bin's magnitude
 * and its colour comes from a viridis-ish palette by bin index. Software-only
 * perspective projection — no GPU, no shaders, no native addons.
 *
 * Pipeline:
 *   Microphone ─ Winmm.waveInOpen  (44.1 kHz mono 16-bit, CALLBACK_FUNCTION)
 *      │
 *      ├─ Two cycling 4096-sample WAVEHDRs (waveInPrepareHeader/waveInAddBuffer)
 *      ├─ JSCallback fires on MM_WIM_DATA (0x3C0); dwParam1 points at the
 *      │   filled WAVEHDR. We copy lpData into a shared Float32Array,
 *      │   then re-queue the buffer with waveInAddBuffer.
 *      └─ The latest 4096 samples form the FFT input window for the next paint.
 *
 *   FFT ─ Hann window + Cooley-Tukey radix-2 (pure JS, in-place)
 *      │     w[i] = 0.5 * (1 - cos(2π * i / (N-1)))
 *      │     bit-reversal index permutation + butterflies for ld(N)=12 stages
 *      └─ 2048 magnitude bins =  sqrt(re² + im²)  →  downsample 4-bin groups
 *         → 512 stars whose brightness = max(group) (renormalized to [0,1])
 *
 *   Constellation ─ 512 stars on a 3D sphere shell
 *      │     φ (azimuth)  = bin / 512 * 2π
 *      │     θ (polar)    = (sin(bin * 0.1) * 0.4 + 0.5) * π
 *      │     r (radius)   = 200 + bin * 0.5     →  shell from r=200 to r=456
 *      │     (x,y,z) = (r sinθ cosφ, r sinθ sinφ, r cosθ)
 *      │     Global rotation: yaw += dt * 0.2, pitch += dt * 0.05.
 *      │     Beat pulse: r *= 1 + 0.18 * lowBandEnergy  (sub-200 Hz only).
 *      └─ Perspective project to screen:
 *            scale = focal / (focal - z')
 *            sx = cx + x' * scale,   sy = cy + y' * scale
 *
 *   Rendering ─ Gdiplus offscreen ARGB bitmap @ ~60 fps
 *      │     GdipCreateBitmapFromScan0 (1280×800 PARGB)
 *      │     Per frame:
 *      │       1. Fill black with a 8 % alpha rectangle (motion trail).
 *      │       2. Sort star indices back-to-front by z (insertion sort,
 *      │          already mostly sorted across frames so ~O(n) amortized).
 *      │       3. GdipFillEllipse each star, size = 1+mag*5,
 *      │          alpha = 0.3+mag*0.7, viridis-like colour by bin index.
 *      │       4. HUD chip with dBFS RMS + ms-per-frame timing.
 *      └─ GdipCreateFromHDC(window DC) + GdipDrawImageRectI to blit.
 *
 *   Window ─ User32.RegisterClassExW / CreateWindowExW  (borderless WS_POPUP)
 *      │     Dwmapi.DwmSetWindowAttribute → DWMWA_SYSTEMBACKDROP_TYPE
 *      │                                  → DWMWA_USE_IMMERSIVE_DARK_MODE
 *      └─ SetTimer (~16 ms) drives FFT + projection + repaint. WndProc handles
 *         WM_PAINT (blit), WM_KEYDOWN (ESC), WM_CLOSE, WM_DESTROY.
 *
 * APIs demonstrated:
 *   - Winmm: waveInOpen, waveInPrepareHeader, waveInAddBuffer, waveInStart,
 *            waveInStop, waveInReset, waveInUnprepareHeader, waveInClose
 *   - Dwmapi: DwmSetWindowAttribute (Mica backdrop, immersive dark mode)
 *   - Gdiplus: GdiplusStartup/Shutdown, GdipCreateBitmapFromScan0,
 *              GdipGetImageGraphicsContext, GdipSetSmoothingMode,
 *              GdipSetTextRenderingHint, GdipCreateSolidFill,
 *              GdipFillRectangle, GdipFillEllipse,
 *              GdipCreateFontFamilyFromName, GdipCreateFont, GdipDrawString,
 *              GdipCreateFromHDC, GdipDrawImageRectI
 *   - User32: RegisterClassExW, CreateWindowExW, ShowWindow, UpdateWindow,
 *             SetTimer, KillTimer, GetMessageW, TranslateMessage,
 *             DispatchMessageW, DefWindowProcW, BeginPaint, EndPaint,
 *             GetDC, ReleaseDC, DestroyWindow, PostQuitMessage,
 *             InvalidateRect, UnregisterClassW
 *
 * Run: bun run example/fft-constellation.ts        (Press ESC to quit.)
 */

import { JSCallback } from 'bun:ffi';

import { Dwmapi, Gdiplus, Kernel32, User32, Winmm } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, WindowStyles } from '@bun-win32/user32';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { CallbackFlag, WAVE_MAPPER } from '@bun-win32/winmm';

// ── Constants ─────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44_100;
const BLOCK_ALIGN_BYTES = 2; // mono 16-bit
const FFT_SIZE = 4_096; // power of two; 12 butterfly stages
const FFT_LOG2 = 12;
const FFT_BINS = FFT_SIZE / 2; // 2048 useful magnitude bins
const STAR_COUNT = 512; // downsampled from FFT_BINS by groups of 4

const CAPTURE_BUFFER_COUNT = 2; // double-buffered WAVEHDR ring
const WAVEHDR_BYTES = 48; // sizeof(WAVEHDR) on x64

const WINDOW_WIDTH = 1_280;
const WINDOW_HEIGHT = 800;
const FRAME_INTERVAL_MS = 16; // ~60 fps

// Win32 message constants the user32 enums don't cover.
const WM_DESTROY = 0x0002;
const WM_PAINT = 0x000f;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_TIMER = 0x0113;
const MM_WIM_DATA = 0x03c0;
const VK_ESCAPE = 0x1b;
const TIMER_ID = 1n;

const argb = (a: number, r: number, g: number, b: number): number => (((a & 0xff) << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) >>> 0;

const encodeUtf16Z = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');

function checkGdip(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} → Gdiplus status ${status}`);
}

// ── FFT (in-place Cooley-Tukey, radix-2, real input) ──────────────────────────

const hannWindow = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i += 1) {
  hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
}

// Bit-reversal permutation table — precomputed once for FFT_SIZE samples.
const bitReversalIndex = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i += 1) {
  let reversed = 0;
  let value = i;
  for (let bit = 0; bit < FFT_LOG2; bit += 1) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  bitReversalIndex[i] = reversed;
}

// Twiddle factors for each stage. For stage s we need exp(-2πi k / 2^(s+1))
// for k ∈ [0, 2^s). We precompute cosines/sines once.
const twiddleCos: Float32Array[] = [];
const twiddleSin: Float32Array[] = [];
for (let stage = 0; stage < FFT_LOG2; stage += 1) {
  const half = 1 << stage;
  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let k = 0; k < half; k += 1) {
    const theta = (-Math.PI * k) / half;
    cos[k] = Math.cos(theta);
    sin[k] = Math.sin(theta);
  }
  twiddleCos.push(cos);
  twiddleSin.push(sin);
}

// Persistent FFT scratch buffers (reused every frame to keep GC quiet).
const fftReal = new Float32Array(FFT_SIZE);
const fftImag = new Float32Array(FFT_SIZE);
const magnitudes = new Float32Array(FFT_BINS);

/**
 * Run an in-place Cooley-Tukey FFT on `(fftReal, fftImag)`. Input is assumed to
 * have been written to `fftReal` (Hann-windowed time-domain samples) with
 * `fftImag` zeroed. After the call, `fftReal[k] + i*fftImag[k]` is the k-th
 * complex bin, and `magnitudes[k] = sqrt(re² + im²)` is populated.
 */
function runFftInPlace(): void {
  // 1) Bit-reversal permutation (out-of-place into scratch, then copy back).
  //    We do it with a swap-in-place pass: for each i < j with i = rev(j),
  //    swap (real[i], real[j]) and (imag[i], imag[j]).
  for (let i = 0; i < FFT_SIZE; i += 1) {
    const j = bitReversalIndex[i]!;
    if (j > i) {
      const tmpRe = fftReal[i]!;
      fftReal[i] = fftReal[j]!;
      fftReal[j] = tmpRe;
      // imag[i] / imag[j] are zero on entry, so no swap needed — but the second
      // and later iterations may touch already-swapped slots, so be safe:
      const tmpIm = fftImag[i]!;
      fftImag[i] = fftImag[j]!;
      fftImag[j] = tmpIm;
    }
  }

  // 2) Butterflies. For each stage s, blockSize = 2^(s+1), half = 2^s. We walk
  //    `start` across the array in blockSize steps, then iterate k across the
  //    "lower" half of each block to combine pairs (start+k, start+k+half).
  for (let stage = 0; stage < FFT_LOG2; stage += 1) {
    const half = 1 << stage;
    const blockSize = half << 1;
    const cosTable = twiddleCos[stage]!;
    const sinTable = twiddleSin[stage]!;
    for (let start = 0; start < FFT_SIZE; start += blockSize) {
      for (let k = 0; k < half; k += 1) {
        const evenIndex = start + k;
        const oddIndex = evenIndex + half;
        const evenRe = fftReal[evenIndex]!;
        const evenIm = fftImag[evenIndex]!;
        const oddRe = fftReal[oddIndex]!;
        const oddIm = fftImag[oddIndex]!;
        const wCos = cosTable[k]!;
        const wSin = sinTable[k]!;
        // t = w * odd  (complex multiply)
        const tRe = wCos * oddRe - wSin * oddIm;
        const tIm = wCos * oddIm + wSin * oddRe;
        fftReal[evenIndex] = evenRe + tRe;
        fftImag[evenIndex] = evenIm + tIm;
        fftReal[oddIndex] = evenRe - tRe;
        fftImag[oddIndex] = evenIm - tIm;
      }
    }
  }

  // 3) Magnitude bins. We normalize by FFT_SIZE/2 to bring values into a
  //    perceptually reasonable range without the windowed energy spike at DC.
  const norm = 1 / (FFT_SIZE * 0.5);
  for (let k = 0; k < FFT_BINS; k += 1) {
    const re = fftReal[k]!;
    const im = fftImag[k]!;
    magnitudes[k] = Math.sqrt(re * re + im * im) * norm;
  }
}

// ── Microphone capture (Winmm waveIn, CALLBACK_FUNCTION) ──────────────────────

// Shared 4096-sample rolling input window — overwritten on each MM_WIM_DATA.
// The paint loop reads from this; the callback writes to it. JS is single-
// threaded for the callback because Bun marshals JSCallback invocations through
// the main thread's event loop, so no atomicity work needed here.
const latestSamples = new Float32Array(FFT_SIZE);
let totalSampleFramesReceived = 0;

// One Buffer-backed PCM slot per WAVEHDR. The driver writes straight into the
// owned memory; we recycle the headers between the JSCallback and the queue.
const capturePcmBuffers: Buffer[] = [];
const captureHeaderBuffers: Buffer[] = [];
for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
  capturePcmBuffers.push(Buffer.alloc(FFT_SIZE * BLOCK_ALIGN_BYTES));
  captureHeaderBuffers.push(Buffer.alloc(WAVEHDR_BYTES));
}

let captureDeviceHandle: bigint = 0n;
let capturePreparedHeaderCount = 0;

/** Build a WAVEFORMATEX describing our 44.1 kHz mono 16-bit PCM capture. */
function buildCaptureFormatBuffer(): Buffer {
  const waveFormat = Buffer.alloc(18);
  waveFormat.writeUInt16LE(1, 0); // wFormatTag = WAVE_FORMAT_PCM
  waveFormat.writeUInt16LE(1, 2); // nChannels = 1 (mono)
  waveFormat.writeUInt32LE(SAMPLE_RATE, 4); // nSamplesPerSec
  waveFormat.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN_BYTES, 8); // nAvgBytesPerSec
  waveFormat.writeUInt16LE(BLOCK_ALIGN_BYTES, 12); // nBlockAlign
  waveFormat.writeUInt16LE(16, 14); // wBitsPerSample
  waveFormat.writeUInt16LE(0, 16); // cbSize
  return waveFormat;
}

/** Initialize WAVEHDR `index` to point at `capturePcmBuffers[index]`. */
function initializeCaptureHeader(index: number): void {
  const header = captureHeaderBuffers[index]!;
  const samples = capturePcmBuffers[index]!;
  header.writeBigUInt64LE(BigInt(samples.ptr!), 0); // lpData
  header.writeUInt32LE(samples.byteLength, 8); // dwBufferLength
  header.writeUInt32LE(0, 12); // dwBytesRecorded
  header.writeBigUInt64LE(0n, 16); // dwUser
  header.writeUInt32LE(0, 24); // dwFlags
  header.writeUInt32LE(0, 28); // dwLoops
  header.writeBigUInt64LE(0n, 32); // lpNext
  header.writeBigUInt64LE(0n, 40); // reserved
}

/**
 * The waveInProc that the audio driver invokes for every captured WAVEHDR.
 * Windows enforces strict timing — we must NOT call back into waveIn* from
 * inside this callback. We do the absolute minimum: copy samples out, re-queue
 * the header via waveInAddBuffer (allowed, despite the warning in MSDN, because
 * waveInAddBuffer is explicitly listed as the one safe re-entry point).
 *
 * Signature: void CALLBACK waveInProc(
 *   HWAVEIN hwi, UINT uMsg, DWORD_PTR dwInstance,
 *   DWORD_PTR dwParam1, DWORD_PTR dwParam2)
 */
const waveInCallback = new JSCallback(
  (_hWaveIn: bigint, uMsg: number, _dwInstance: bigint, dwParam1: bigint, _dwParam2: bigint): void => {
    if (uMsg !== MM_WIM_DATA) return;
    if (dwParam1 === 0n) return;

    // Figure out which of our two headers fired by matching the pointer.
    let matchedSlot = -1;
    for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
      if (BigInt(captureHeaderBuffers[i]!.ptr!) === dwParam1) {
        matchedSlot = i;
        break;
      }
    }
    if (matchedSlot < 0) return;

    const header = captureHeaderBuffers[matchedSlot]!;
    const pcm = capturePcmBuffers[matchedSlot]!;
    const bytesRecorded = header.readUInt32LE(12);
    const sampleCount = Math.min(FFT_SIZE, Math.floor(bytesRecorded / BLOCK_ALIGN_BYTES));

    // Decode i16 → f32 [-1,1] straight into the rolling input window. We
    // overwrite all FFT_SIZE slots: if the driver gave us fewer samples than
    // expected (it shouldn't — bufferLength == FFT_SIZE * 2), zero-pad the tail.
    for (let i = 0; i < sampleCount; i += 1) {
      latestSamples[i] = pcm.readInt16LE(i * 2) / 32_768;
    }
    for (let i = sampleCount; i < FFT_SIZE; i += 1) latestSamples[i] = 0;
    totalSampleFramesReceived += sampleCount;

    // Clear dwBytesRecorded + dwFlags for the next capture cycle and re-queue.
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(0, 24);
    if (captureDeviceHandle !== 0n) {
      Winmm.waveInAddBuffer(captureDeviceHandle, header.ptr!, header.byteLength);
    }
  },
  { args: ['u64', 'u32', 'u64', 'u64', 'u64'], returns: 'void' },
);

/** Open the default mic, prepare + enqueue both WAVEHDRs, start recording. */
function startMicrophoneCapture(): boolean {
  const handleOut = Buffer.alloc(8);
  const formatBuffer = buildCaptureFormatBuffer();
  const openStatus = Winmm.waveInOpen(handleOut.ptr!, WAVE_MAPPER, formatBuffer.ptr!, BigInt(waveInCallback.ptr!), 0n, CallbackFlag.CALLBACK_FUNCTION);
  if (openStatus !== 0) {
    console.error(`waveInOpen failed (status ${openStatus}). Microphone capture unavailable.`);
    return false;
  }
  captureDeviceHandle = handleOut.readBigUInt64LE(0);

  for (let i = 0; i < CAPTURE_BUFFER_COUNT; i += 1) {
    initializeCaptureHeader(i);
    const header = captureHeaderBuffers[i]!;
    const prepareStatus = Winmm.waveInPrepareHeader(captureDeviceHandle, header.ptr!, header.byteLength);
    if (prepareStatus !== 0) {
      console.error(`waveInPrepareHeader[${i}] failed (status ${prepareStatus}).`);
      return false;
    }
    capturePreparedHeaderCount += 1;
    const addStatus = Winmm.waveInAddBuffer(captureDeviceHandle, header.ptr!, header.byteLength);
    if (addStatus !== 0) {
      console.error(`waveInAddBuffer[${i}] failed (status ${addStatus}).`);
      return false;
    }
  }

  const startStatus = Winmm.waveInStart(captureDeviceHandle);
  if (startStatus !== 0) {
    console.error(`waveInStart failed (status ${startStatus}).`);
    return false;
  }
  return true;
}

/** Stop, reset, unprepare every WAVEHDR, and close the input device. */
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

// ── Constellation (3D star positions + colour palette + projection) ───────────

// Each star has: x, y, z (fixed), and per-frame: smoothed magnitude.
const starX = new Float32Array(STAR_COUNT);
const starY = new Float32Array(STAR_COUNT);
const starZ = new Float32Array(STAR_COUNT);
const starColor = new Uint32Array(STAR_COUNT); // (r,g,b) base colour packed
const starMagnitudeSmoothed = new Float32Array(STAR_COUNT);

// Precomputed viridis-ish palette: deep blue → teal → green → yellow.
// (Linear interpolation across 5 anchor colours by normalized bin index.)
const VIRIDIS_ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [0x33, 0x0a, 0x55], // dark violet
  [0x32, 0x3c, 0x90], // royal blue
  [0x1f, 0x80, 0xa6], // teal
  [0x55, 0xd0, 0x76], // green
  [0xf4, 0xe3, 0x4a], // soft yellow
];

function sampleViridis(t: number): readonly [number, number, number] {
  const tClamped = Math.max(0, Math.min(0.9999, t));
  const segmentCount = VIRIDIS_ANCHORS.length - 1;
  const scaled = tClamped * segmentCount;
  const idx = Math.floor(scaled);
  const frac = scaled - idx;
  const left = VIRIDIS_ANCHORS[idx]!;
  const right = VIRIDIS_ANCHORS[idx + 1]!;
  return [Math.round(left[0] + (right[0] - left[0]) * frac), Math.round(left[1] + (right[1] - left[1]) * frac), Math.round(left[2] + (right[2] - left[2]) * frac)];
}

(function initializeConstellation(): void {
  for (let s = 0; s < STAR_COUNT; s += 1) {
    const phi = (s / STAR_COUNT) * 2 * Math.PI; // azimuth
    const theta = (Math.sin(s * 0.1) * 0.4 + 0.5) * Math.PI; // polar
    const r = 200 + s * 0.5; // shell radius 200…456
    starX[s] = r * Math.sin(theta) * Math.cos(phi);
    starY[s] = r * Math.sin(theta) * Math.sin(phi);
    starZ[s] = r * Math.cos(theta);
    const [r8, g8, b8] = sampleViridis(s / STAR_COUNT);
    starColor[s] = ((r8 & 0xff) << 16) | ((g8 & 0xff) << 8) | (b8 & 0xff);
  }
})();

// Star indices sorted back-to-front each frame. Insertion sort over a mostly
// already-sorted array → roughly O(n) amortized across frames.
const starOrder = new Int32Array(STAR_COUNT);
for (let i = 0; i < STAR_COUNT; i += 1) starOrder[i] = i;
// Pre-projected screen-space coords + apparent size + alpha + tinted colour.
const projectedScreenX = new Float32Array(STAR_COUNT);
const projectedScreenY = new Float32Array(STAR_COUNT);
const projectedDepth = new Float32Array(STAR_COUNT);
const projectedSize = new Float32Array(STAR_COUNT);
const projectedAlpha = new Float32Array(STAR_COUNT);

let yawAngle = 0;
let pitchAngle = 0;
let beatPulse = 0; // 0…1, decays each frame, spikes on low-band energy

// ── Visual state shared with the WM_PAINT handler ─────────────────────────────

interface VisualState {
  framesRendered: number;
  lastFrameMs: number;
  rmsDb: number;
  loudestBin: number;
  loudestFrequencyHz: number;
}

const visualState: VisualState = {
  framesRendered: 0,
  lastFrameMs: 0,
  rmsDb: -120,
  loudestBin: 0,
  loudestFrequencyHz: 0,
};

// ── Gdiplus rendering ─────────────────────────────────────────────────────────

let gdiplusToken = 0n;
let offscreenBitmapPtr = 0n;
let offscreenGraphicsPtr = 0n;
let titleFontFamilyPtr = 0n;
let titleFontPtr = 0n;
let labelFontPtr = 0n;
let centeredStringFormatPtr = 0n;
let leftStringFormatPtr = 0n;

function startGdiplus(): void {
  Gdiplus.Preload();
  const tokenOut = Buffer.alloc(8);
  const startupInput = Buffer.alloc(16);
  startupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
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
  checkGdip(Gdiplus.GdipCreateFont(titleFontFamilyPtr, 28, FontStyle.FontStyleBold, Unit.UnitPixel, titleFontOut.ptr!), 'GdipCreateFont (title)');
  titleFontPtr = titleFontOut.readBigUInt64LE(0);

  const labelFontOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateFont(titleFontFamilyPtr, 12, FontStyle.FontStyleRegular, Unit.UnitPixel, labelFontOut.ptr!), 'GdipCreateFont (label)');
  labelFontPtr = labelFontOut.readBigUInt64LE(0);

  const centeredFormatOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateStringFormat(0, 0, centeredFormatOut.ptr!), 'GdipCreateStringFormat (centered)');
  centeredStringFormatPtr = centeredFormatOut.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(centeredStringFormatPtr, StringAlignment.StringAlignmentCenter);
  Gdiplus.GdipSetStringFormatLineAlign(centeredStringFormatPtr, StringAlignment.StringAlignmentCenter);

  const leftFormatOut = Buffer.alloc(8);
  checkGdip(Gdiplus.GdipCreateStringFormat(0, 0, leftFormatOut.ptr!), 'GdipCreateStringFormat (left)');
  leftStringFormatPtr = leftFormatOut.readBigUInt64LE(0);
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

/** Take an ARGB brush from `color`, run `paint`, then dispose of it. */
function withSolidBrush(color: number, paint: (brush: bigint) => void): void {
  const brushOut = Buffer.alloc(8);
  Gdiplus.GdipCreateSolidFill(color, brushOut.ptr!);
  const brush = brushOut.readBigUInt64LE(0);
  try {
    paint(brush);
  } finally {
    Gdiplus.GdipDeleteBrush(brush);
  }
}

function drawStringLeft(text: string, font: bigint, brush: bigint, x: number, y: number, w: number, h: number): void {
  const layoutRect = Buffer.alloc(16);
  layoutRect.writeFloatLE(x, 0);
  layoutRect.writeFloatLE(y, 4);
  layoutRect.writeFloatLE(w, 8);
  layoutRect.writeFloatLE(h, 12);
  const text16 = encodeUtf16Z(text);
  Gdiplus.GdipDrawString(offscreenGraphicsPtr, text16.ptr!, -1, font, layoutRect.ptr!, leftStringFormatPtr, brush);
}

// ── Per-frame: FFT → project stars → render → blit ────────────────────────────

let previousFrameTimestampMs = 0;

/**
 * Run the FFT on the latest mic input, project + sort + draw all stars into
 * the offscreen Gdiplus bitmap, and update the HUD. Called from WM_TIMER.
 */
function renderFrame(nowMs: number): void {
  const dtSeconds = previousFrameTimestampMs === 0 ? 1 / 60 : Math.min(0.1, (nowMs - previousFrameTimestampMs) / 1000);
  previousFrameTimestampMs = nowMs;
  const frameStartMs = performance.now();

  // 1) Run the FFT on the latest mic input window.
  for (let i = 0; i < FFT_SIZE; i += 1) {
    fftReal[i] = latestSamples[i]! * hannWindow[i]!;
    fftImag[i] = 0;
  }
  runFftInPlace();

  // 2) Compute RMS and locate the loudest mid-band bin for the HUD.
  let sumOfSquares = 0;
  for (let i = 0; i < FFT_SIZE; i += 1) sumOfSquares += latestSamples[i]! * latestSamples[i]!;
  const rms = Math.sqrt(sumOfSquares / FFT_SIZE);
  visualState.rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -120;

  let loudestBin = 0;
  let loudestMag = 0;
  // Skip DC + very-low bins (room rumble) — start at bin 4.
  for (let k = 4; k < FFT_BINS; k += 1) {
    const m = magnitudes[k]!;
    if (m > loudestMag) {
      loudestMag = m;
      loudestBin = k;
    }
  }
  visualState.loudestBin = loudestBin;
  visualState.loudestFrequencyHz = (loudestBin * SAMPLE_RATE) / FFT_SIZE;

  // 3) Downsample 2048 bins → 512 stars (max-pool 4-bin groups), smooth.
  let lowBandEnergy = 0;
  const lowBandBinCount = Math.floor((200 * FFT_SIZE) / SAMPLE_RATE); // ~18 bins for 0-200 Hz
  for (let i = 0; i < lowBandBinCount; i += 1) lowBandEnergy += magnitudes[i]!;
  lowBandEnergy /= Math.max(1, lowBandBinCount);

  for (let s = 0; s < STAR_COUNT; s += 1) {
    const groupStart = s * 4;
    let groupMax = 0;
    for (let g = 0; g < 4; g += 1) {
      const m = magnitudes[groupStart + g]!;
      if (m > groupMax) groupMax = m;
    }
    // Magnitudes from FFT range roughly [0, 1]; clamp + gentle attack/release.
    const target = Math.min(1, groupMax * 14); // amplify for visibility
    const previous = starMagnitudeSmoothed[s]!;
    const blend = target > previous ? 0.6 : 0.12; // fast attack, slow release
    starMagnitudeSmoothed[s] = previous + (target - previous) * blend;
  }

  // 4) Beat pulse on the bass band (sub-200 Hz).
  const beatTarget = Math.min(1, lowBandEnergy * 22);
  beatPulse += (beatTarget - beatPulse) * (beatTarget > beatPulse ? 0.45 : 0.06);

  // 5) Advance global rotation.
  yawAngle += dtSeconds * 0.2;
  pitchAngle += dtSeconds * 0.05;

  // 6) Rotate + perspective-project every star.
  const sinYaw = Math.sin(yawAngle);
  const cosYaw = Math.cos(yawAngle);
  const sinPitch = Math.sin(pitchAngle);
  const cosPitch = Math.cos(pitchAngle);
  const cx = WINDOW_WIDTH / 2;
  const cy = WINDOW_HEIGHT / 2;
  const focalLength = 720;
  const pulseScale = 1 + 0.18 * beatPulse;

  for (let s = 0; s < STAR_COUNT; s += 1) {
    const ox = starX[s]! * pulseScale;
    const oy = starY[s]! * pulseScale;
    const oz = starZ[s]! * pulseScale;
    // Rotate around Y (yaw): (x,z) → (x cos - z sin, x sin + z cos).
    const x1 = ox * cosYaw - oz * sinYaw;
    const z1 = ox * sinYaw + oz * cosYaw;
    const y1 = oy;
    // Rotate around X (pitch): (y,z) → (y cos - z sin, y sin + z cos).
    const y2 = y1 * cosPitch - z1 * sinPitch;
    const z2 = y1 * sinPitch + z1 * cosPitch;
    const x2 = x1;
    projectedDepth[s] = z2;
    // Push back so stars sit in front of camera, then perspective divide.
    const cameraZ = z2 + 900;
    const scale = focalLength / Math.max(1, cameraZ);
    projectedScreenX[s] = cx + x2 * scale;
    projectedScreenY[s] = cy + y2 * scale;
    const mag = starMagnitudeSmoothed[s]!;
    projectedSize[s] = (1 + mag * 5) * Math.max(0.4, scale);
    projectedAlpha[s] = 0.3 + mag * 0.7;
  }

  // 7) Insertion-sort starOrder by depth (back-to-front: z descending).
  for (let i = 1; i < STAR_COUNT; i += 1) {
    const target = starOrder[i]!;
    const targetDepth = projectedDepth[target]!;
    let j = i - 1;
    while (j >= 0 && projectedDepth[starOrder[j]!]! < targetDepth) {
      starOrder[j + 1] = starOrder[j]!;
      j -= 1;
    }
    starOrder[j + 1] = target;
  }

  // 8) Paint. Motion trail: cover the canvas with a low-alpha black rectangle.
  withSolidBrush(argb(48, 0x05, 0x06, 0x10), (trail) => {
    Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, trail, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  });

  // Subtle radial vignette glow when the beat hits.
  if (beatPulse > 0.05) {
    const glowAlpha = Math.round(beatPulse * 40);
    withSolidBrush(argb(glowAlpha, 0x4a, 0x6e, 0xff), (glow) => {
      Gdiplus.GdipFillEllipse(offscreenGraphicsPtr, glow, cx - 460, cy - 460, 920, 920);
    });
  }

  // 9) Draw the stars back-to-front. Each fillEllipse owns/disposes its brush.
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const s = starOrder[i]!;
    const size = projectedSize[s]!;
    if (size < 0.4) continue;
    const screenX = projectedScreenX[s]!;
    const screenY = projectedScreenY[s]!;
    if (screenX < -size || screenX > WINDOW_WIDTH + size) continue;
    if (screenY < -size || screenY > WINDOW_HEIGHT + size) continue;
    const baseColor = starColor[s]!;
    const r8 = (baseColor >>> 16) & 0xff;
    const g8 = (baseColor >>> 8) & 0xff;
    const b8 = baseColor & 0xff;
    // Tint brighter on louder bins (additive feel without true additive blit).
    const mag = starMagnitudeSmoothed[s]!;
    const lift = Math.round(mag * 70);
    const tintedR = Math.min(255, r8 + lift);
    const tintedG = Math.min(255, g8 + lift);
    const tintedB = Math.min(255, b8 + lift);
    const alphaByte = Math.round(projectedAlpha[s]! * 255);
    const color = argb(alphaByte, tintedR, tintedG, tintedB);
    const half = size * 0.5;
    withSolidBrush(color, (brush) => {
      Gdiplus.GdipFillEllipse(offscreenGraphicsPtr, brush, screenX - half, screenY - half, size, size);
    });
    // Halo for bright stars: a larger, fainter ellipse underneath.
    if (mag > 0.5) {
      const haloHalf = size * 1.6;
      const haloAlpha = Math.round(mag * 70);
      const haloColor = argb(haloAlpha, tintedR, tintedG, tintedB);
      withSolidBrush(haloColor, (haloBrush) => {
        Gdiplus.GdipFillEllipse(offscreenGraphicsPtr, haloBrush, screenX - haloHalf, screenY - haloHalf, haloHalf * 2, haloHalf * 2);
      });
    }
  }

  // 10) HUD chip across the bottom.
  const hudTop = WINDOW_HEIGHT - 80;
  withSolidBrush(argb(150, 0x08, 0x0b, 0x1c), (hud) => {
    Gdiplus.GdipFillRectangle(offscreenGraphicsPtr, hud, 0, hudTop, WINDOW_WIDTH, 80);
  });
  withSolidBrush(argb(255, 0xff, 0xff, 0xff), (white) => {
    drawStringLeft('FFT Constellation', titleFontPtr, white, 24, hudTop + 6, 480, 36);
  });
  withSolidBrush(argb(220, 0xa8, 0xc0, 0xff), (subtle) => {
    const samplesText = `samples ${totalSampleFramesReceived.toLocaleString()}`;
    const rmsText = visualState.rmsDb > -119 ? `${visualState.rmsDb.toFixed(1)} dBFS` : 'silent';
    const peakText = `peak ${visualState.loudestFrequencyHz.toFixed(0)} Hz (bin ${visualState.loudestBin})`;
    const fpsText = `${visualState.lastFrameMs.toFixed(1)} ms/frame`;
    const beatText = `beat ${(beatPulse * 100).toFixed(0)}%`;
    const lineOne = `mic  •  ${rmsText}  •  ${peakText}  •  ${beatText}`;
    const lineTwo = `${samplesText}  •  ${FFT_SIZE}-sample Hann FFT  •  ${STAR_COUNT} stars  •  ${fpsText}  •  ESC to quit`;
    drawStringLeft(lineOne, labelFontPtr, subtle, 24, hudTop + 38, WINDOW_WIDTH - 48, 18);
    drawStringLeft(lineTwo, labelFontPtr, subtle, 24, hudTop + 58, WINDOW_WIDTH - 48, 18);
  });

  visualState.lastFrameMs = performance.now() - frameStartMs;
  visualState.framesRendered += 1;
}

/** Blit the offscreen GDI+ bitmap to the window's client area. */
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
      renderFrame(performance.now());
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
  const className = encodeUtf16Z('BunWin32FftConstellation');
  const windowClass = Buffer.alloc(80);
  const view = new DataView(windowClass.buffer);
  view.setUint32(0, 80, true); // cbSize
  view.setUint32(4, 0x0002 | 0x0001, true); // CS_HREDRAW | CS_VREDRAW
  windowClass.writeBigUInt64LE(BigInt(wndProc.ptr!), 8);
  view.setInt32(16, 0, true);
  view.setInt32(20, 0, true);
  windowClass.writeBigUInt64LE(0n, 24);
  windowClass.writeBigUInt64LE(0n, 32);
  windowClass.writeBigUInt64LE(0n, 40);
  windowClass.writeBigUInt64LE(0n, 48); // hbrBackground = NULL (we paint everything)
  windowClass.writeBigUInt64LE(0n, 56);
  windowClass.writeBigUInt64LE(BigInt(className.ptr!), 64);
  windowClass.writeBigUInt64LE(0n, 72);
  if (User32.RegisterClassExW(windowClass.ptr!) === 0) {
    console.error('RegisterClassExW failed.');
    return false;
  }

  const titleText = encodeUtf16Z('FFT Constellation');
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
  if (windowHandle === 0n) {
    console.error('CreateWindowExW failed.');
    return false;
  }

  // Center the window on the primary monitor.
  const desktopRect = Buffer.alloc(16);
  User32.GetClientRect(User32.GetDesktopWindow(), desktopRect.ptr!);
  const screenWidth = desktopRect.readInt32LE(8);
  const screenHeight = desktopRect.readInt32LE(12);
  User32.SetWindowPos(windowHandle, 0n, Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2)), Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2)), WINDOW_WIDTH, WINDOW_HEIGHT, 0x0040 /* SWP_SHOWWINDOW */);

  // Windows 11 Mica backdrop + dark immersive frame (no-ops on older builds).
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

console.log('FFT Constellation — your microphone becomes a 3D star field.');
console.log('  • capture: Winmm.waveInOpen  (44.1 kHz mono 16-bit, CALLBACK_FUNCTION)');
console.log('  • FFT    : Hann-windowed Cooley-Tukey radix-2, N=4096 → 2048 bins');
console.log(`  • stars  : ${STAR_COUNT}, spherical-shell layout, perspective-projected`);
console.log('  • paint  : Gdiplus offscreen ARGB bitmap @ ~60 fps');
console.log('  Press ESC in the window to quit.');

const qpfBuffer = Buffer.alloc(8);
Kernel32.QueryPerformanceFrequency(qpfBuffer.ptr!);
const performanceFrequency = qpfBuffer.readBigUInt64LE(0);
void performanceFrequency;

let exitCode = 0;
try {
  startGdiplus();
  if (!createWindow()) throw new Error('Window creation failed.');
  if (!startMicrophoneCapture()) {
    console.warn('Microphone capture unavailable — the visualization will still run (silent).');
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
  if (windowHandle !== 0n) {
    User32.KillTimer(windowHandle, TIMER_ID);
  }
  stopMicrophoneCapture();
  stopGdiplus();
  waveInCallback.close();
  wndProc.close();
  process.exit(exitCode);
}
