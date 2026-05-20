/**
 * Conway's Desktop — Conway's Game of Life living on top of your real desktop.
 *
 * Creates a click-through, topmost, layered overlay sized to the primary
 * monitor. A Conway grid of ~14,400 12×12-pixel cells evolves in real time on
 * top of every other window on your screen — wallpaper, editor, browser, all
 * of it. Cells render as soft glowing dots painted directly into a 32-bit
 * premultiplied-ARGB DIB section and blitted to the screen each generation
 * through UpdateLayeredWindow. WS_EX_TRANSPARENT lets mouse clicks pass
 * straight through to whatever is beneath, so to still react we poll
 * GetAsyncKeyState(VK_LBUTTON) every tick and seed a glider at the cursor.
 * Sound is an XAudio2 source voice fed by a pre-synthesized 50 ms 880 Hz sine
 * chirp, retriggered on each glider seed and burst-spawn with a touch of
 * SetFrequencyRatio pitch variation.
 *
 * Every TypeScript developer on Windows can now plant a Game of Life on their
 * desktop in one file — no native addon, no Electron, no compiler. ESC quits.
 *
 * APIs:  User32      RegisterClassExW, CreateWindowExW (WS_POPUP + LAYERED |
 *                    TOPMOST | TRANSPARENT | TOOLWINDOW), UpdateLayeredWindow,
 *                    SetTimer/KillTimer, GetMessageW/TranslateMessage/
 *                    DispatchMessageW, DefWindowProcW + JSCallback,
 *                    GetAsyncKeyState, GetCursorPos, GetSystemMetrics,
 *                    GetDC/ReleaseDC, DestroyWindow, UnregisterClassW
 *        GDI32       CreateCompatibleDC, CreateDIBSection (top-down 32-bit
 *                    ARGB, raw pixel pointer written from JS), SelectObject,
 *                    DeleteObject, DeleteDC
 *        Xaudio2_9   XAudio2Create + IXAudio2::CreateMasteringVoice/
 *                    CreateSourceVoice + IXAudio2SourceVoice::Start/
 *                    SubmitSourceBuffer/FlushSourceBuffers/SetFrequencyRatio
 *                    + IXAudio2Voice::DestroyVoice + IUnknown::Release
 *        Kernel32    Sleep
 *
 * Run: bun run example/conway-desktop.ts
 */

import { CFunction, FFIType, JSCallback, type Pointer, toArrayBuffer } from 'bun:ffi';

import { GDI32, Kernel32, User32, Xaudio2_9 } from '../index';
import { ExtendedWindowStyles, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;
const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

const WM_DESTROY = 0x0002;
const WM_TIMER = 0x0113;
const WM_CLOSE = 0x0010;
const ULW_ALPHA = 0x02; // UpdateLayeredWindow: use BLENDFUNCTION
const BI_RGB = 0;
const DIB_RGB_COLORS = 0;

const TIMER_ID = 1n;
const TICK_INTERVAL_MS = 125; // ~8 Hz generation tick
const CELL_PIXELS = 12;
const DOT_PIXELS = 10; // Glowing dot inside each 12×12 cell (1 px gutter)
const INITIAL_ALIVE_PROBABILITY = 0.1;
const AUTO_SEED_EVERY_GENERATIONS = 120; // ≈ 15 s at 125 ms / tick
const AUTO_SEED_BURST_RADIUS = 6;

// IXAudio2 / IXAudio2Voice / IXAudio2SourceVoice vtable slots (xaudio2.h order).
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_FLUSHSOURCEBUFFERS = 22;
const IXAUDIO2SOURCEVOICE_SETFREQUENCYRATIO = 26;
const XAUDIO2_END_OF_STREAM = 0x0040;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const AudioCategory_GameEffects = 6;

const CHIRP_SAMPLE_RATE = 44_100;
const CHIRP_FREQ = 880;
const CHIRP_DURATION_S = 0.05;
const CHIRP_BITS = 16;
const CHIRP_BLOCK_ALIGN = 2; // 1 channel × 16 bits / 8

const vcallInvokers = new Map<string, ReturnType<typeof CFunction>>();

/** Invokes COM vtable slot `slot` on interface pointer `thisPtr`. Memoizes the bound CFunction per (method, signature). */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[], returns: FFIType = FFIType.i32): number {
  const vtablePtr = Number(thisPtr) as Pointer;
  const vtableBuf = new BigUint64Array(toArrayBuffer(vtablePtr, 0, 8));
  const vtable = Number(vtableBuf[0]!) as Pointer;
  const methodBuf = new BigUint64Array(toArrayBuffer(vtable, slot * 8, 8));
  const method = Number(methodBuf[0]!) as Pointer;
  const key = `${method}|${returns}|${argTypes.join(',')}`;
  let invoke = vcallInvokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: method, args: [FFIType.u64, ...argTypes], returns });
    vcallInvokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args);
}

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const gridCols = Math.floor(screenWidth / CELL_PIXELS);
const gridRows = Math.floor(screenHeight / CELL_PIXELS);
const cellCount = gridCols * gridRows;

console.log(`Conway's Desktop  ${screenWidth}×${screenHeight}  ${gridCols}×${gridRows} (${cellCount.toLocaleString()} cells, ${CELL_PIXELS}px) tick=${TICK_INTERVAL_MS}ms`);
console.log("  Left-click to seed a glider. ESC to quit.\n");

let currentGrid = new Uint8Array(cellCount);
let nextGrid = new Uint8Array(cellCount);
for (let i = 0; i < cellCount; i += 1) currentGrid[i] = Math.random() < INITIAL_ALIVE_PROBABILITY ? 1 : 0;
let generation = 0;

/** Plants a south-east glider — smallest non-trivial Life spaceship — at cell (gx, gy). */
function plantGlider(gx: number, gy: number): void {
  const shape: Array<readonly [number, number]> = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  for (const [dx, dy] of shape) {
    const x = gx + dx;
    const y = gy + dy;
    if (x >= 0 && x < gridCols && y >= 0 && y < gridRows) currentGrid[y * gridCols + x] = 1;
  }
}

/** Sprays a small random patch of life at (cx, cy) to prevent extinction. */
function autoSeedBurst(cx: number, cy: number): void {
  for (let dy = -AUTO_SEED_BURST_RADIUS; dy <= AUTO_SEED_BURST_RADIUS; dy += 1) {
    for (let dx = -AUTO_SEED_BURST_RADIUS; dx <= AUTO_SEED_BURST_RADIUS; dx += 1) {
      if (Math.random() >= 0.35) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < gridCols && y >= 0 && y < gridRows) currentGrid[y * gridCols + x] = 1;
    }
  }
}

/** Advances one Conway generation under B3/S23 rules with toroidal wrap-around at screen edges. */
function stepGeneration(): void {
  for (let y = 0; y < gridRows; y += 1) {
    const yUp = y === 0 ? gridRows - 1 : y - 1;
    const yDown = y === gridRows - 1 ? 0 : y + 1;
    const rowOffset = y * gridCols;
    const rowUpOffset = yUp * gridCols;
    const rowDownOffset = yDown * gridCols;
    for (let x = 0; x < gridCols; x += 1) {
      const xLeft = x === 0 ? gridCols - 1 : x - 1;
      const xRight = x === gridCols - 1 ? 0 : x + 1;
      const neighbors =
        currentGrid[rowUpOffset + xLeft]! +
        currentGrid[rowUpOffset + x]! +
        currentGrid[rowUpOffset + xRight]! +
        currentGrid[rowOffset + xLeft]! +
        currentGrid[rowOffset + xRight]! +
        currentGrid[rowDownOffset + xLeft]! +
        currentGrid[rowDownOffset + x]! +
        currentGrid[rowDownOffset + xRight]!;
      const alive = currentGrid[rowOffset + x]!;
      nextGrid[rowOffset + x] = alive ? (neighbors === 2 || neighbors === 3 ? 1 : 0) : neighbors === 3 ? 1 : 0;
    }
  }
  const swap = currentGrid;
  currentGrid = nextGrid;
  nextGrid = swap;
  generation += 1;
}

const className = encode('ConwayDesktopOverlay');

let overlayHwnd = NULL;
let shouldExit = false;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER) return 0n; // Real tick work happens in the main loop after DispatchMessageW.
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
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// WNDCLASSEXW is 80 bytes on x64; only cbSize, lpfnWndProc, lpszClassName matter for us.
const wndClassBuf = Buffer.alloc(80);
wndClassBuf.writeUInt32LE(80, 0); // cbSize
wndClassBuf.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassBuf.writeBigUInt64LE(BigInt(className.ptr!), 64); // lpszClassName

const classAtom = User32.RegisterClassExW(wndClassBuf.ptr!);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

overlayHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_LAYERED | ExtendedWindowStyles.WS_EX_TRANSPARENT | ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_NOACTIVATE,
  className.ptr!,
  encode('Conway\'s Desktop').ptr!,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  0,
  0,
  screenWidth,
  screenHeight,
  NULL,
  NULL,
  NULL,
  NULL_PTR,
);

if (!overlayHwnd) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

const screenDC = User32.GetDC(NULL);
const memoryDC = GDI32.CreateCompatibleDC(screenDC);

// BITMAPINFOHEADER (40 bytes). biHeight is negated for a top-down DIB so row
// 0 is at the top of the buffer — matches how we iterate the Conway grid.
const bmi = Buffer.alloc(40);
bmi.writeUInt32LE(40, 0); // biSize
bmi.writeInt32LE(screenWidth, 4); // biWidth
bmi.writeInt32LE(-screenHeight, 8); // biHeight (negative = top-down)
bmi.writeUInt16LE(1, 12); // biPlanes
bmi.writeUInt16LE(32, 14); // biBitCount
bmi.writeUInt32LE(BI_RGB, 16); // biCompression

// CreateDIBSection writes a pointer to the raw pixel memory into ppvBits.
const ppvBits = Buffer.alloc(8);
const dibBitmap = GDI32.CreateDIBSection(memoryDC, bmi.ptr!, DIB_RGB_COLORS, ppvBits.ptr!, NULL, 0);
if (!dibBitmap) {
  console.error('CreateDIBSection failed');
  process.exit(1);
}
GDI32.SelectObject(memoryDC, dibBitmap);

const pixelByteCount = screenWidth * screenHeight * 4;
const pixelAddress = Number(ppvBits.readBigUInt64LE(0)) as Pointer;
const pixelView = new Uint32Array(toArrayBuffer(pixelAddress, 0, pixelByteCount));

// 10×10 glowing-dot stamp, premultiplied ARGB (UpdateLayeredWindow w/ AC_SRC_ALPHA).
// Soft radial falloff (opaque core, glowing halo) in warm green/cyan (80, 255, 180).
const dotStamp = new Uint32Array(DOT_PIXELS * DOT_PIXELS);
{
  const half = (DOT_PIXELS - 1) / 2;
  for (let dy = 0; dy < DOT_PIXELS; dy += 1) {
    for (let dx = 0; dx < DOT_PIXELS; dx += 1) {
      const intensity = Math.max(0, 1 - Math.hypot(dx - half, dy - half) / (DOT_PIXELS / 2));
      const alpha = Math.round(intensity * intensity * 255);
      const r = Math.round((80 * alpha) / 255);
      const g = alpha;
      const b = Math.round((180 * alpha) / 255);
      dotStamp[dy * DOT_PIXELS + dx] = (alpha << 24) | (r << 16) | (g << 8) | b;
    }
  }
}

/** Repaints the DIB from currentGrid: clear to transparent, stamp the glowing dot at every live cell. */
function renderFrame(): void {
  pixelView.fill(0);
  for (let y = 0; y < gridRows; y += 1) {
    const cellTop = y * CELL_PIXELS + 1;
    const rowOffset = y * gridCols;
    for (let x = 0; x < gridCols; x += 1) {
      if (currentGrid[rowOffset + x] !== 1) continue;
      const cellLeft = x * CELL_PIXELS + 1;
      for (let dy = 0; dy < DOT_PIXELS; dy += 1) {
        const pixelRow = (cellTop + dy) * screenWidth + cellLeft;
        const stampRow = dy * DOT_PIXELS;
        for (let dx = 0; dx < DOT_PIXELS; dx += 1) {
          pixelView[pixelRow + dx] = dotStamp[stampRow + dx]!;
        }
      }
    }
  }
}

// Persistent UpdateLayeredWindow argument structures.
const dstPoint = Buffer.alloc(8); // POINT { 0, 0 } — already zeroed by alloc
const srcPoint = Buffer.alloc(8); // POINT { 0, 0 } — already zeroed by alloc
const sizeBuf = Buffer.alloc(8); // SIZE { screenWidth, screenHeight }
sizeBuf.writeInt32LE(screenWidth, 0);
sizeBuf.writeInt32LE(screenHeight, 4);
// BLENDFUNCTION: AC_SRC_OVER, 0, SourceConstantAlpha=255, AC_SRC_ALPHA=1.
const blendFunction = Buffer.from([0, 0, 255, 1]);

function presentFrame(): void {
  User32.UpdateLayeredWindow(overlayHwnd, screenDC, dstPoint.ptr!, sizeBuf.ptr!, memoryDC, srcPoint.ptr!, 0, blendFunction.ptr!, ULW_ALPHA);
}

let audioReady = false;
let engine = 0n;
let masterVoice = 0n;
let sourceVoice = 0n;
const chirpBuffer = Buffer.alloc(48); // XAUDIO2_BUFFER

// Pre-render the chirp PCM once and keep it alive for the entire program.
const chirpSampleCount = Math.floor(CHIRP_DURATION_S * CHIRP_SAMPLE_RATE);
const chirpPcm = Buffer.alloc(chirpSampleCount * CHIRP_BLOCK_ALIGN);
{
  const attackSamples = Math.max(1, Math.floor(chirpSampleCount * 0.08));
  const releaseSamples = Math.max(1, Math.floor(chirpSampleCount * 0.6));
  for (let i = 0; i < chirpSampleCount; i += 1) {
    const envelope = i < attackSamples ? i / attackSamples : i > chirpSampleCount - releaseSamples ? Math.max(0, (chirpSampleCount - i) / releaseSamples) ** 1.6 : 0.85;
    const sample = Math.sin(2 * Math.PI * CHIRP_FREQ * (i / CHIRP_SAMPLE_RATE)) * envelope * 0.3;
    chirpPcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * CHIRP_BLOCK_ALIGN);
  }
}

// Boot the engine — fall back silently if the host has no playback endpoint.
const ppEngine = Buffer.alloc(8);
const createHr = Xaudio2_9.XAudio2Create(ppEngine.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createHr === S_OK) {
  engine = ppEngine.readBigUInt64LE(0);
  const ppMaster = Buffer.alloc(8);
  const masterHr = vcall(engine, IXAUDIO2_CREATEMASTERINGVOICE, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32], [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects]);
  if (masterHr === S_OK) {
    masterVoice = ppMaster.readBigUInt64LE(0);

    // WAVEFORMATEX (18 bytes): WAVE_FORMAT_PCM mono 16-bit.
    const wfx = Buffer.alloc(18);
    wfx.writeUInt16LE(1, 0); // wFormatTag = WAVE_FORMAT_PCM
    wfx.writeUInt16LE(1, 2); // nChannels
    wfx.writeUInt32LE(CHIRP_SAMPLE_RATE, 4);
    wfx.writeUInt32LE(CHIRP_SAMPLE_RATE * CHIRP_BLOCK_ALIGN, 8); // nAvgBytesPerSec
    wfx.writeUInt16LE(CHIRP_BLOCK_ALIGN, 12);
    wfx.writeUInt16LE(CHIRP_BITS, 14);

    const ppSource = Buffer.alloc(8);
    const srcHr = vcall(engine, IXAUDIO2_CREATESOURCEVOICE, [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [ppSource.ptr!, wfx.ptr!, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null]);
    if (srcHr === S_OK) {
      sourceVoice = ppSource.readBigUInt64LE(0);
      vcall(sourceVoice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
      audioReady = true;
    }
  }
}

if (!audioReady) console.log('  (audio disabled — no XAudio2 endpoint)');

/** Submits the pre-rendered chirp PCM with a slightly varied pitch ratio. */
function chirp(pitchVariation: number): void {
  if (!audioReady) return;
  vcall(sourceVoice, IXAUDIO2SOURCEVOICE_FLUSHSOURCEBUFFERS, [], [], FFIType.i32);
  vcall(sourceVoice, IXAUDIO2SOURCEVOICE_SETFREQUENCYRATIO, [FFIType.f32, FFIType.u32], [pitchVariation, 0], FFIType.i32);
  chirpBuffer.writeUInt32LE(XAUDIO2_END_OF_STREAM, 0);
  chirpBuffer.writeUInt32LE(chirpPcm.length, 4);
  chirpBuffer.writeBigUInt64LE(BigInt(chirpPcm.ptr!), 8);
  vcall(sourceVoice, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [chirpBuffer.ptr!, null]);
}

const cursorPosBuffer = new Int32Array(2);
let lastMouseDown = false;

function pollInput(): void {
  if ((User32.GetAsyncKeyState(VirtualKey.VK_ESCAPE) & 0x8000) !== 0) shouldExit = true;
  // Left-click edge → plant a glider at the cursor. The click itself still
  // passes through to whatever window is beneath thanks to WS_EX_TRANSPARENT.
  const mouseDown = (User32.GetAsyncKeyState(VirtualKey.VK_LBUTTON) & 0x8000) !== 0;
  if (mouseDown && !lastMouseDown) {
    User32.GetCursorPos(cursorPosBuffer.ptr!);
    const cursorX = cursorPosBuffer[0]!;
    const cursorY = cursorPosBuffer[1]!;
    const gridX = Math.max(0, Math.min(gridCols - 1, Math.floor(cursorX / CELL_PIXELS)));
    const gridY = Math.max(0, Math.min(gridRows - 1, Math.floor(cursorY / CELL_PIXELS)));
    plantGlider(gridX, gridY);
    chirp(1.0 + (Math.random() - 0.5) * 0.4);
  }
  lastMouseDown = mouseDown;
}

function tickAndPresent(): void {
  pollInput();
  if (shouldExit) {
    User32.DestroyWindow(overlayHwnd);
    return;
  }
  stepGeneration();
  if (generation % AUTO_SEED_EVERY_GENERATIONS === 0) {
    const cx = Math.floor(Math.random() * gridCols);
    const cy = Math.floor(Math.random() * gridRows);
    autoSeedBurst(cx, cy);
    chirp(0.7 + Math.random() * 0.3);
  }
  renderFrame();
  presentFrame();
}

// First paint before the timer fires so the overlay isn't blank.
renderFrame();
presentFrame();

const timerHandle = User32.SetTimer(overlayHwnd, TIMER_ID, TICK_INTERVAL_MS, NULL_PTR);
if (!timerHandle) {
  console.error('SetTimer failed');
  process.exit(1);
}

// We drive ticks from the message loop (not the WndProc) so we can poll
// GetAsyncKeyState outside dispatcher reentrancy. WM_TIMER messages still
// wake us up promptly inside GetMessageW.
const msgBuffer = Buffer.alloc(48);
let lastTickAt = 0;
while (!shouldExit) {
  const result = User32.GetMessageW(msgBuffer.ptr!, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr!);
  User32.DispatchMessageW(msgBuffer.ptr!);
  const now = Date.now();
  if (now - lastTickAt >= TICK_INTERVAL_MS - 5) {
    lastTickAt = now;
    tickAndPresent();
  }
}

User32.KillTimer(overlayHwnd, TIMER_ID);
if (audioReady) {
  vcall(sourceVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(masterVoice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
}
GDI32.DeleteObject(dibBitmap);
GDI32.DeleteDC(memoryDC);
User32.ReleaseDC(NULL, screenDC);
if (User32.IsWindow(overlayHwnd)) User32.DestroyWindow(overlayHwnd);
User32.UnregisterClassW(className.ptr!, NULL);
wndProc.close();

console.log('');
console.log(`  Lived ${generation} generations across ${cellCount.toLocaleString()} cells.`);
console.log('');

// Ensure the process exits even if a stray ref is held by the FFI cache.
Kernel32.Sleep(50);
process.exit(0);
