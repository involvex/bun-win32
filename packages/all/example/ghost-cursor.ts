/**
 * Ghost Cursor — twelve pastel comet-tail cursors chasing your real one with
 * spring physics, in a screen-sized click-through layered window.
 *
 * The illusion: a smear of soft colored dots dragging behind your real cursor
 * like a rainbow comet. Each ghost is a 2D point mass connected to its leader
 * by a Hooke's-law spring with velocity damping. Ghost 0 follows the real
 * cursor; ghost i (i > 0) follows ghost i-1 with a slightly softer spring and
 * marginally heavier damping, so the trail relaxes outward into a graceful arc
 * that snaps and overshoots when you flick the mouse.
 *
 * Every visible pixel is composed in TypeScript: a primary-monitor-sized
 * 32-bit premultiplied-ARGB DIB section is wrapped as a Uint32Array, cleared
 * each frame, and stamped with a radial quadratic falloff for each ghost.
 * UpdateLayeredWindow with BLENDFUNCTION { AC_SRC_OVER, 255, AC_SRC_ALPHA }
 * paints it on top of every other window. WS_EX_TRANSPARENT makes the overlay
 * click-through, so the trail never steals focus from whatever you're doing.
 *
 * Spring model (Euler integration at ~60 fps), per ghost:
 *   accel    = (target − position) * stiffness
 *   velocity = (velocity + accel) * damping
 *   position += velocity
 *   stiffness = 0.20 * 0.90^index    (each ghost ~10% softer than its leader)
 *   damping   = 0.78 + 0.012 * index (slightly more drag further down the chain)
 *
 * APIs demonstrated:
 *   User32   RegisterClassExW, CreateWindowExW (WS_POPUP + WS_EX_LAYERED |
 *              TOPMOST | TRANSPARENT | TOOLWINDOW | NOACTIVATE),
 *              UpdateLayeredWindow, SetTimer/KillTimer, GetCursorPos,
 *              GetAsyncKeyState, GetSystemMetrics, GetDC/ReleaseDC,
 *              DefWindowProcW + JSCallback, GetMessageW/TranslateMessage/
 *              DispatchMessageW, PostQuitMessage, DestroyWindow,
 *              UnregisterClassW, PostMessageW, IsWindow
 *   GDI32    CreateCompatibleDC, CreateDIBSection (top-down 32-bit ARGB,
 *              raw pixel pointer wrapped as Uint32Array), SelectObject,
 *              DeleteObject, DeleteDC
 *   Kernel32 SetConsoleCtrlHandler (Ctrl+C → graceful shutdown), Sleep
 *
 * Run: bun run example/ghost-cursor.ts
 */

import { JSCallback, type Pointer, toArrayBuffer } from 'bun:ffi';

import { GDI32, Kernel32, User32 } from '../index';
import { ExtendedWindowStyles, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;
const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

// Win32 constants that aren't re-exported by the binding packages.
const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const ULW_ALPHA = 0x02; // UpdateLayeredWindow: use the BLENDFUNCTION.
const BI_RGB = 0; // Uncompressed 32-bit ARGB.
const DIB_RGB_COLORS = 0; // CreateDIBSection usage flag.

// Animation + look-and-feel tuning.
const TIMER_ID = 1n;
const FRAME_INTERVAL_MS = 16; // ~60 fps.
const GHOST_COUNT = 12;
const GHOST_RADIUS_LEADER = 11; // Visible radius of ghost 0 (closest to cursor).
const GHOST_RADIUS_TAIL = 6; // Visible radius of the last ghost.
const STAMP_SIZE = 24; // Sprite stamp box: STAMP_SIZE × STAMP_SIZE pixels.
const SPRING_K_LEADER = 0.20;
const SPRING_K_FALLOFF = 0.90; // Each ghost: k *= falloff.
const DAMPING_LEADER = 0.78;
const DAMPING_STEP = 0.012; // Each ghost: damping += step (clamped < 1).

interface Color {
  red: number;
  green: number;
  blue: number;
}

/** Standard HSL→RGB. hue ∈ [0,1), saturation/lightness ∈ [0,1]. */
function hslToRgb(hue: number, saturation: number, lightness: number): Color {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sextant = hue * 6;
  const x = chroma * (1 - Math.abs((sextant % 2) - 1));
  let r1 = 0, g1 = 0, b1 = 0;
  if (sextant < 1) { r1 = chroma; g1 = x; }
  else if (sextant < 2) { r1 = x; g1 = chroma; }
  else if (sextant < 3) { g1 = chroma; b1 = x; }
  else if (sextant < 4) { g1 = x; b1 = chroma; }
  else if (sextant < 5) { r1 = x; b1 = chroma; }
  else { r1 = chroma; b1 = x; }
  const m = lightness - chroma / 2;
  return { red: Math.round((r1 + m) * 255), green: Math.round((g1 + m) * 255), blue: Math.round((b1 + m) * 255) };
}

/** Builds a premultiplied-ARGB radial stamp with quadratic falloff inside `radius`. */
function buildGhostStamp(radius: number, color: Color): Uint32Array {
  const stamp = new Uint32Array(STAMP_SIZE * STAMP_SIZE);
  const half = (STAMP_SIZE - 1) / 2;
  for (let dy = 0; dy < STAMP_SIZE; dy += 1) {
    for (let dx = 0; dx < STAMP_SIZE; dx += 1) {
      const intensity = Math.max(0, 1 - Math.hypot(dx - half, dy - half) / radius);
      const alpha = Math.round(intensity * intensity * 255);
      if (alpha === 0) continue;
      // Premultiplied ARGB: every channel scaled by (alpha / 255).
      const r = Math.round((color.red * alpha) / 255);
      const g = Math.round((color.green * alpha) / 255);
      const b = Math.round((color.blue * alpha) / 255);
      stamp[dy * STAMP_SIZE + dx] = (alpha << 24) | (r << 16) | (g << 8) | b;
    }
  }
  return stamp;
}

// Primary-monitor metrics — the overlay is sized to cover it edge-to-edge.
const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);

console.log('Ghost Cursor');
console.log(`  Screen   : ${screenWidth}×${screenHeight}`);
console.log(`  Ghosts   : ${GHOST_COUNT} pastel comet-tail cursors`);
console.log(`  Physics  : spring k=${SPRING_K_LEADER} × ${SPRING_K_FALLOFF}^i, damping=${DAMPING_LEADER} + ${DAMPING_STEP}·i`);
console.log(`  Tick     : every ${FRAME_INTERVAL_MS} ms (~${Math.round(1000 / FRAME_INTERVAL_MS)} fps)`);
console.log('');
console.log('  Move your mouse. ESC or Ctrl+C to quit.');
console.log('');

interface Ghost {
  positionX: number;
  positionY: number;
  velocityX: number;
  velocityY: number;
  springStiffness: number;
  damping: number;
  stamp: Uint32Array;
}

// Seed ghosts at the live cursor position so the first frame doesn't snap.
const cursorPosBuffer = new Int32Array(2);
User32.GetCursorPos(cursorPosBuffer.ptr!);
const initialCursorX = cursorPosBuffer[0]!;
const initialCursorY = cursorPosBuffer[1]!;

const ghosts: Ghost[] = [];
for (let i = 0; i < GHOST_COUNT; i += 1) {
  const t = i / (GHOST_COUNT - 1);
  const radius = GHOST_RADIUS_LEADER * (1 - t) + GHOST_RADIUS_TAIL * t;
  const color = hslToRgb(i / GHOST_COUNT, 0.85, 0.72); // Pastel rainbow.
  ghosts.push({
    positionX: initialCursorX,
    positionY: initialCursorY,
    velocityX: 0,
    velocityY: 0,
    springStiffness: SPRING_K_LEADER * Math.pow(SPRING_K_FALLOFF, i),
    damping: Math.min(0.95, DAMPING_LEADER + DAMPING_STEP * i),
    stamp: buildGhostStamp(radius, color),
  });
}

// ── Window class + click-through layered overlay ─────────────────────────────

const className = encode('BunWin32GhostCursorOverlay');
let overlayHwnd = NULL;
let shouldExit = false;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER) return 0n; // Tick work happens after DispatchMessageW.
    if (msg === WM_CLOSE) { User32.DestroyWindow(hWnd); return 0n; }
    if (msg === WM_DESTROY) { User32.PostQuitMessage(0); return 0n; }
    return BigInt(User32.DefWindowProcW(hWnd, msg, wParam, lParam));
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

// WNDCLASSEXW is 80 bytes on x64.
const wndClassBuf = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuf.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassBuf.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassBuf.writeBigUInt64LE(BigInt(className.ptr!), 64); // lpszClassName

const classAtom = User32.RegisterClassExW(wndClassBuf.ptr!);
if (!classAtom) { console.error('RegisterClassExW failed'); process.exit(1); }

overlayHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST |
    ExtendedWindowStyles.WS_EX_LAYERED |
    ExtendedWindowStyles.WS_EX_TRANSPARENT |
    ExtendedWindowStyles.WS_EX_TOOLWINDOW |
    ExtendedWindowStyles.WS_EX_NOACTIVATE,
  className.ptr!,
  encode('Ghost Cursor').ptr!,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  0, 0, screenWidth, screenHeight,
  NULL, NULL, NULL, NULL_PTR,
);
if (!overlayHwnd) { console.error('CreateWindowExW failed'); process.exit(1); }

// ── 32-bit ARGB DIB section ──────────────────────────────────────────────────

const screenDC = User32.GetDC(NULL);
const memoryDC = GDI32.CreateCompatibleDC(screenDC);

// BITMAPINFOHEADER (40 bytes). Negative biHeight = top-down DIB (row 0 at top).
const bmi = Buffer.alloc(40);
bmi.writeUInt32LE(40, 0); // biSize
bmi.writeInt32LE(screenWidth, 4); // biWidth
bmi.writeInt32LE(-screenHeight, 8); // biHeight (negative = top-down)
bmi.writeUInt16LE(1, 12); // biPlanes
bmi.writeUInt16LE(32, 14); // biBitCount
bmi.writeUInt32LE(BI_RGB, 16); // biCompression

const ppvBits = Buffer.alloc(8);
const dibBitmap = GDI32.CreateDIBSection(memoryDC, bmi.ptr!, DIB_RGB_COLORS, ppvBits.ptr!, NULL, 0);
if (!dibBitmap) { console.error('CreateDIBSection failed'); process.exit(1); }
GDI32.SelectObject(memoryDC, dibBitmap);

const pixelByteCount = screenWidth * screenHeight * 4;
const pixelAddress = Number(ppvBits.readBigUInt64LE(0)) as Pointer;
const pixelView = new Uint32Array(toArrayBuffer(pixelAddress, 0, pixelByteCount));

// ── Persistent UpdateLayeredWindow parameter blocks ──────────────────────────

const dstPoint = Buffer.alloc(8);
const sizeBuf = Buffer.alloc(8);
sizeBuf.writeInt32LE(screenWidth, 0);
sizeBuf.writeInt32LE(screenHeight, 4);
const srcPoint = Buffer.alloc(8);

// BLENDFUNCTION (4 bytes): AC_SRC_OVER, 0, 255, AC_SRC_ALPHA.
const blendFunction = Buffer.alloc(4);
blendFunction.writeUInt8(0, 0); // BlendOp = AC_SRC_OVER
blendFunction.writeUInt8(0, 1); // BlendFlags
blendFunction.writeUInt8(255, 2); // SourceConstantAlpha
blendFunction.writeUInt8(1, 3); // AlphaFormat = AC_SRC_ALPHA

/** Stamps a premultiplied ARGB sprite into the DIB centered at (cx, cy). */
function stampSprite(centerX: number, centerY: number, sprite: Uint32Array): void {
  const half = (STAMP_SIZE - 1) / 2;
  const left = Math.floor(centerX - half);
  const top = Math.floor(centerY - half);
  const startX = Math.max(0, -left);
  const startY = Math.max(0, -top);
  const endX = Math.min(STAMP_SIZE, screenWidth - left);
  const endY = Math.min(STAMP_SIZE, screenHeight - top);
  if (startX >= endX || startY >= endY) return;
  for (let dy = startY; dy < endY; dy += 1) {
    const pixelRow = (top + dy) * screenWidth + left;
    const stampRow = dy * STAMP_SIZE;
    for (let dx = startX; dx < endX; dx += 1) {
      const argb = sprite[stampRow + dx]!;
      if (argb !== 0) pixelView[pixelRow + dx] = argb;
    }
  }
}

/** Spring-step the chain, redraw the DIB, blit via UpdateLayeredWindow. */
function tickAndPresent(): void {
  if ((User32.GetAsyncKeyState(VirtualKey.VK_ESCAPE) & 0x8000) !== 0) {
    shouldExit = true;
    User32.DestroyWindow(overlayHwnd);
    return;
  }
  User32.GetCursorPos(cursorPosBuffer.ptr!);
  let targetX = cursorPosBuffer[0]!;
  let targetY = cursorPosBuffer[1]!;

  // Integrate the spring chain: ghost 0 chases the cursor, ghost i chases i-1.
  for (let i = 0; i < GHOST_COUNT; i += 1) {
    const ghost = ghosts[i]!;
    const accelX = (targetX - ghost.positionX) * ghost.springStiffness;
    const accelY = (targetY - ghost.positionY) * ghost.springStiffness;
    ghost.velocityX = (ghost.velocityX + accelX) * ghost.damping;
    ghost.velocityY = (ghost.velocityY + accelY) * ghost.damping;
    ghost.positionX += ghost.velocityX;
    ghost.positionY += ghost.velocityY;
    targetX = ghost.positionX;
    targetY = ghost.positionY;
  }

  // Clear → tail-first stamp (so the brighter leader sits atop the dimmer trail).
  pixelView.fill(0);
  for (let i = GHOST_COUNT - 1; i >= 0; i -= 1) {
    const ghost = ghosts[i]!;
    stampSprite(ghost.positionX, ghost.positionY, ghost.stamp);
  }

  User32.UpdateLayeredWindow(overlayHwnd, screenDC, dstPoint.ptr!, sizeBuf.ptr!, memoryDC, srcPoint.ptr!, 0, blendFunction.ptr!, ULW_ALPHA);
}

// Console Ctrl+C handler — flips the exit flag and wakes GetMessageW.
const ctrlHandler = new JSCallback(
  (_dwCtrlType: number): number => {
    shouldExit = true;
    User32.PostMessageW(overlayHwnd, WM_CLOSE, 0n, 0n);
    return 1; // TRUE — we handled it.
  },
  { args: ['u32'], returns: 'i32' },
);
Kernel32.SetConsoleCtrlHandler(ctrlHandler.ptr!, 1);

// ── First paint, timer start, message loop ───────────────────────────────────

tickAndPresent();

const timerHandle = User32.SetTimer(overlayHwnd, TIMER_ID, FRAME_INTERVAL_MS, NULL_PTR);
if (!timerHandle) { console.error('SetTimer failed'); process.exit(1); }

const msgBuffer = Buffer.alloc(48);
let lastTickAt = 0;
while (!shouldExit) {
  const result = User32.GetMessageW(msgBuffer.ptr!, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr!);
  User32.DispatchMessageW(msgBuffer.ptr!);
  const now = Date.now();
  if (now - lastTickAt >= FRAME_INTERVAL_MS - 2) {
    lastTickAt = now;
    tickAndPresent();
  }
}

// ── Teardown ─────────────────────────────────────────────────────────────────

User32.KillTimer(overlayHwnd, TIMER_ID);
Kernel32.SetConsoleCtrlHandler(NULL_PTR, 0);
GDI32.DeleteObject(dibBitmap);
GDI32.DeleteDC(memoryDC);
User32.ReleaseDC(NULL, screenDC);
if (User32.IsWindow(overlayHwnd)) User32.DestroyWindow(overlayHwnd);
User32.UnregisterClassW(className.ptr!, NULL);
wndProc.close();
ctrlHandler.close();

console.log('');
console.log('  The ghosts have faded.');
console.log('');

// Give the FFI cache a beat to release before forcing exit.
Kernel32.Sleep(50);
process.exit(0);
