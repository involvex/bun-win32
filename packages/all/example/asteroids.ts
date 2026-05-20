/**
 * Asteroids — a fully playable arcade game in pure TypeScript through FFI
 *
 * Boots a borderless 1024x768 window with DWM immersive dark mode, an XAudio2
 * engine with three pre-rendered procedural sound effects, and a GDI+ vector
 * renderer that paints into an offscreen 32-bit ARGB bitmap. Input is polled
 * every frame from both a connected Xbox controller (Xinput1_4.XInputGetState)
 * and the keyboard (User32.GetAsyncKeyState). The game loop is driven by
 * SetTimer at ~60 fps; each tick simulates ship/asteroid/bullet physics with
 * screen-wrap, runs collision detection, advances waves when the field is
 * cleared, and blits the rendered bitmap to the window HDC via GdipDrawImage.
 *
 * Controls
 *   - Keyboard: Left/Right turn, Up thrust, Space fire, P pause, R restart, ESC quit
 *   - Xbox:     LX/LY stick turn, A/RT thrust, B fire, Start pause, Back quit
 *
 * Pipeline (every step is a real FFI call):
 *
 *   - Window:   User32.{RegisterClassExW,CreateWindowExW,ShowWindow,SetForegroundWindow,
 *               GetDC,ReleaseDC,SetTimer,GetMessageW,TranslateMessage,DispatchMessageW,
 *               DefWindowProcW,DestroyWindow,PostQuitMessage,GetAsyncKeyState,InvalidateRect}
 *   - DWM:      Dwmapi.DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE = 20)
 *   - Audio:    Xaudio2_9.XAudio2Create + IXAudio2::CreateMasteringVoice/CreateSourceVoice
 *               + IXAudio2SourceVoice::{Start,Stop,SubmitSourceBuffer,FlushSourceBuffers,
 *               GetState,DestroyVoice}
 *   - Input:    Xinput1_4.XInputGetState
 *   - Render:   Gdiplus.{GdiplusStartup,GdipCreateBitmapFromScan0,GdipGetImageGraphicsContext,
 *               GdipSetSmoothingMode,GdipGraphicsClear,GdipCreatePen1,GdipCreateSolidFill,
 *               GdipDrawLine,GdipCreatePath,GdipAddPathLine2,GdipClosePathFigure,GdipDrawPath,
 *               GdipFillEllipse,GdipDrawString,GdipCreateFromHDC,GdipDrawImageI,GdipFlush,
 *               GdipDeleteBrush,GdipDeletePen,GdipDeletePath,GdipDeleteGraphics,
 *               GdipDisposeImage,GdiplusShutdown}
 *
 * Run: bun run example/asteroids.ts
 */

import { CFunction, FFIType, JSCallback, read, type Pointer } from 'bun:ffi';

import { Dwmapi, Gdiplus, User32, Xaudio2_9, Xinput1_4 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { FillMode, FlushIntention, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit, FontStyle } from '@bun-win32/gdiplus';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';
import { XInputGamepadButtons } from '@bun-win32/xinput1_4';

// ──────────────────────────────────────────────────────────────────────────────
// Constants

const WINDOW_WIDTH = 1024;
const WINDOW_HEIGHT = 768;

const TICK_INTERVAL_MS = 16;
const SECONDS_PER_TICK = TICK_INTERVAL_MS / 1000;

const SHIP_TURN_SPEED = 4.8; // radians/second
const SHIP_THRUST_ACCEL = 240; // pixels/second^2
const SHIP_MAX_SPEED = 360;
const SHIP_FRICTION = 0.992; // velocity multiplier per tick
const SHIP_RADIUS = 12;
const SHIP_RESPAWN_INVINCIBLE_TICKS = 120;
const SHIP_BULLET_COOLDOWN_TICKS = 10;
const SHIP_LIVES_START = 3;

const BULLET_SPEED = 520; // pixels/second
const BULLET_TTL_TICKS = 95; // ~1.5 s

const ASTEROID_BASE_SPEED = 60; // pixels/second
const ASTEROID_SPEED_PER_WAVE = 14;
const ASTEROID_SIZE_LARGE = 0;
const ASTEROID_SIZE_MEDIUM = 1;
const ASTEROID_SIZE_SMALL = 2;
const ASTEROID_RADII = [42, 24, 12];

const XINPUT_STICK_DEADZONE = 9000;
const XINPUT_TRIGGER_THRESHOLD = 40;

const WHITE_ARGB = 0xff_ff_ff_ff;
const DIM_WHITE_ARGB = 0xff_88_88_88;
const ACCENT_ARGB = 0xff_5a_e0_ff;
const SHIP_FLAME_ARGB = 0xff_ff_a8_3a;
const BULLET_ARGB = 0xff_ff_ff_ff;
const BLACK_ARGB = 0xff_00_00_00;

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const TIMER_ID = 1n;

const ERROR_SUCCESS = 0;

const XAUDIO2_END_OF_STREAM = 0x0040;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const AUDIO_CATEGORY_GAME_EFFECTS = 6;

// IXAudio2 (IUnknown-derived) vtable slots, xaudio2.h declaration order.
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_STOP = 20;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_FLUSHSOURCEBUFFERS = 22;

const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;

const SAMPLE_RATE = 44_100;
const AUDIO_CHANNELS = 1;
const AUDIO_BITS = 16;
const AUDIO_BLOCK_ALIGN = (AUDIO_CHANNELS * AUDIO_BITS) / 8;

const encode = (str: string): Buffer => Buffer.from(`${str}\0`, 'utf16le');

// ──────────────────────────────────────────────────────────────────────────────
// COM vtable helper — same pattern as the FM synth example.

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

function checkStatus(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Game state

interface Vector2 {
  x: number;
  y: number;
}

interface Ship {
  position: Vector2;
  velocity: Vector2;
  heading: number;
  thrusting: boolean;
  invincibleTicks: number;
  cooldownTicks: number;
  alive: boolean;
}

interface Bullet {
  position: Vector2;
  velocity: Vector2;
  ttlTicks: number;
}

interface Asteroid {
  position: Vector2;
  velocity: Vector2;
  size: 0 | 1 | 2;
  rotation: number;
  rotationSpeed: number;
  vertices: number[]; // flat (x0,y0,x1,y1,...) in object space
}

const ship: Ship = {
  position: { x: WINDOW_WIDTH / 2, y: WINDOW_HEIGHT / 2 },
  velocity: { x: 0, y: 0 },
  heading: -Math.PI / 2,
  thrusting: false,
  invincibleTicks: SHIP_RESPAWN_INVINCIBLE_TICKS,
  cooldownTicks: 0,
  alive: true,
};

const bullets: Bullet[] = [];
const asteroids: Asteroid[] = [];

let score = 0;
let lives = SHIP_LIVES_START;
let waveNumber = 1;
let paused = false;
let gameOver = false;

let prevFireKey = false;
let prevPauseKey = false;
let prevRestartKey = false;
let prevPadFireDown = false;
let prevPadPauseDown = false;
let prevPadBackDown = false;
let requestedQuit = false;

// ──────────────────────────────────────────────────────────────────────────────
// Asteroid factory — irregular closed polygons that look like rocks.

function makeAsteroidVertices(size: 0 | 1 | 2): number[] {
  const radius = ASTEROID_RADII[size]!;
  const count = 10 + Math.floor(Math.random() * 4);
  const vertices: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const jitter = 0.65 + Math.random() * 0.55;
    vertices.push(Math.cos(angle) * radius * jitter, Math.sin(angle) * radius * jitter);
  }
  return vertices;
}

function spawnAsteroidAtEdge(size: 0 | 1 | 2 = 0): Asteroid {
  // Place it just off-screen and aim it roughly toward the play field.
  const edge = Math.floor(Math.random() * 4);
  let x = 0;
  let y = 0;
  if (edge === 0) {
    x = Math.random() * WINDOW_WIDTH;
    y = -40;
  } else if (edge === 1) {
    x = WINDOW_WIDTH + 40;
    y = Math.random() * WINDOW_HEIGHT;
  } else if (edge === 2) {
    x = Math.random() * WINDOW_WIDTH;
    y = WINDOW_HEIGHT + 40;
  } else {
    x = -40;
    y = Math.random() * WINDOW_HEIGHT;
  }
  const speed = ASTEROID_BASE_SPEED + waveNumber * ASTEROID_SPEED_PER_WAVE;
  const direction = Math.random() * Math.PI * 2;
  return {
    position: { x, y },
    velocity: { x: Math.cos(direction) * speed, y: Math.sin(direction) * speed },
    size,
    rotation: Math.random() * Math.PI * 2,
    rotationSpeed: (Math.random() - 0.5) * 1.6,
    vertices: makeAsteroidVertices(size),
  };
}

function spawnWave(): void {
  asteroids.length = 0;
  const count = 3 + waveNumber;
  for (let i = 0; i < count; i += 1) asteroids.push(spawnAsteroidAtEdge(ASTEROID_SIZE_LARGE as 0));
}

function resetGame(): void {
  score = 0;
  lives = SHIP_LIVES_START;
  waveNumber = 1;
  bullets.length = 0;
  ship.position.x = WINDOW_WIDTH / 2;
  ship.position.y = WINDOW_HEIGHT / 2;
  ship.velocity.x = 0;
  ship.velocity.y = 0;
  ship.heading = -Math.PI / 2;
  ship.thrusting = false;
  ship.invincibleTicks = SHIP_RESPAWN_INVINCIBLE_TICKS;
  ship.cooldownTicks = 0;
  ship.alive = true;
  gameOver = false;
  spawnWave();
}

// ──────────────────────────────────────────────────────────────────────────────
// XAudio2 setup + procedural sound effects.

interface SoundEffect {
  pcm: Buffer;
  bufferDescriptor: Buffer;
  voicePool: bigint[];
  voiceCursor: number;
}

const xaudioVoicePoolSize = 4;

function makeWaveFormatEx(): Buffer {
  const wfx = Buffer.alloc(18);
  wfx.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
  wfx.writeUInt16LE(AUDIO_CHANNELS, 2);
  wfx.writeUInt32LE(SAMPLE_RATE, 4);
  wfx.writeUInt32LE(SAMPLE_RATE * AUDIO_BLOCK_ALIGN, 8);
  wfx.writeUInt16LE(AUDIO_BLOCK_ALIGN, 12);
  wfx.writeUInt16LE(AUDIO_BITS, 14);
  wfx.writeUInt16LE(0, 16);
  return wfx;
}

function renderSquareSweep(durationSeconds: number, startHz: number, endHz: number, amplitude: number): Buffer {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  let phase = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const progress = i / sampleCount;
    const frequency = startHz + (endHz - startHz) * progress;
    phase += (frequency / SAMPLE_RATE) * Math.PI * 2;
    const square = Math.sin(phase) >= 0 ? 1 : -1;
    const envelope = Math.max(0, 1 - progress) ** 1.5;
    const sample = square * amplitude * envelope;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * AUDIO_BLOCK_ALIGN);
  }
  return pcm;
}

function renderNoiseBurst(durationSeconds: number, amplitude: number, decay: number): Buffer {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  // Light low-pass to give the noise some weight instead of pure hiss.
  let smoothedPrev = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const progress = i / sampleCount;
    const envelope = Math.exp(-progress * decay);
    const raw = Math.random() * 2 - 1;
    const smoothed = smoothedPrev * 0.55 + raw * 0.45;
    smoothedPrev = smoothed;
    const sample = smoothed * amplitude * envelope;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * AUDIO_BLOCK_ALIGN);
  }
  return pcm;
}

function renderShipDeath(): Buffer {
  const durationSeconds = 0.5;
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  let phase = 0;
  let smoothedPrev = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const progress = i / sampleCount;
    const frequency = 240 - 200 * progress;
    phase += (frequency / SAMPLE_RATE);
    const saw = 2 * (phase - Math.floor(phase + 0.5));
    const raw = Math.random() * 2 - 1;
    const smoothed = smoothedPrev * 0.7 + raw * 0.3;
    smoothedPrev = smoothed;
    const envelope = Math.max(0, 1 - progress) ** 1.3;
    const mix = saw * 0.65 + smoothed * 0.35;
    const sample = mix * 0.55 * envelope;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * AUDIO_BLOCK_ALIGN);
  }
  return pcm;
}

function makeBufferDescriptor(pcm: Buffer): Buffer {
  // XAUDIO2_BUFFER (48 bytes on x64): Flags @0, AudioBytes @4, pAudioData @8.
  const xbuf = Buffer.alloc(48);
  xbuf.writeUInt32LE(XAUDIO2_END_OF_STREAM, 0);
  xbuf.writeUInt32LE(pcm.length, 4);
  xbuf.writeBigUInt64LE(BigInt(pcm.ptr), 8);
  return xbuf;
}

function createSoundEffect(engine: bigint, pcm: Buffer, waveFormatPtr: Pointer): SoundEffect {
  const bufferDescriptor = makeBufferDescriptor(pcm);
  const voicePool: bigint[] = [];
  for (let i = 0; i < xaudioVoicePoolSize; i += 1) {
    const ppVoice = Buffer.alloc(8);
    const hr = vcall(
      engine,
      IXAUDIO2_CREATESOURCEVOICE,
      [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      [ppVoice.ptr, waveFormatPtr, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null],
    );
    if (hr !== S_OK) throw new Error(`CreateSourceVoice failed: 0x${(hr >>> 0).toString(16)}`);
    voicePool.push(ppVoice.readBigUInt64LE(0));
  }
  return { pcm, bufferDescriptor, voicePool, voiceCursor: 0 };
}

function playSoundEffect(effect: SoundEffect): void {
  const voice = effect.voicePool[effect.voiceCursor]!;
  effect.voiceCursor = (effect.voiceCursor + 1) % effect.voicePool.length;
  // Stop + flush the recycled voice so we can submit a fresh buffer cleanly.
  vcall(voice, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
  vcall(voice, IXAUDIO2SOURCEVOICE_FLUSHSOURCEBUFFERS, [], []);
  vcall(voice, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [effect.bufferDescriptor.ptr, null]);
  vcall(voice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
}

// Boot XAudio2.
const ppEngine = Buffer.alloc(8);
const xaudioCreateHr = Xaudio2_9.XAudio2Create(ppEngine.ptr, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
let xaudioEngine = 0n;
let xaudioMaster = 0n;
let audioReady = false;
let shootSfx: SoundEffect | null = null;
let hitSfx: SoundEffect | null = null;
let deathSfx: SoundEffect | null = null;

if (xaudioCreateHr === S_OK) {
  xaudioEngine = ppEngine.readBigUInt64LE(0);
  const ppMaster = Buffer.alloc(8);
  const masterHr = vcall(
    xaudioEngine,
    IXAUDIO2_CREATEMASTERINGVOICE,
    [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32],
    [ppMaster.ptr, 0, 0, 0, null, null, AUDIO_CATEGORY_GAME_EFFECTS],
  );
  if (masterHr === S_OK) {
    xaudioMaster = ppMaster.readBigUInt64LE(0);
    const wfx = makeWaveFormatEx();
    const shootPcm = renderSquareSweep(0.08, 800, 200, 0.5);
    const hitPcm = renderNoiseBurst(0.2, 0.5, 9);
    const deathPcm = renderShipDeath();
    shootSfx = createSoundEffect(xaudioEngine, shootPcm, wfx.ptr);
    hitSfx = createSoundEffect(xaudioEngine, hitPcm, wfx.ptr);
    deathSfx = createSoundEffect(xaudioEngine, deathPcm, wfx.ptr);
    audioReady = true;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// GDI+ setup — one offscreen 32-bit ARGB bitmap that we redraw every tick.

Gdiplus.Preload();

const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
checkStatus(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

const bitmapHandleBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, bitmapHandleBuffer.ptr), 'GdipCreateBitmapFromScan0');
const offscreenBitmap = bitmapHandleBuffer.readBigUInt64LE(0);

const graphicsHandleBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, graphicsHandleBuffer.ptr), 'GdipGetImageGraphicsContext');
const offscreenGraphics = graphicsHandleBuffer.readBigUInt64LE(0);

checkStatus(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
checkStatus(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

// One reusable pen + brushes for HUD text + ship flame.
function makePen(argb: number, width: number): bigint {
  const pen = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreatePen1(argb, width, Unit.UnitPixel, pen.ptr), 'GdipCreatePen1');
  return pen.readBigUInt64LE(0);
}

function makeBrush(argb: number): bigint {
  const brush = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreateSolidFill(argb, brush.ptr), 'GdipCreateSolidFill');
  return brush.readBigUInt64LE(0);
}

const whitePen = makePen(WHITE_ARGB, 1.8);
const dimWhitePen = makePen(DIM_WHITE_ARGB, 1.5);
const flamePen = makePen(SHIP_FLAME_ARGB, 1.6);
const bulletBrush = makeBrush(BULLET_ARGB);
const whiteBrush = makeBrush(WHITE_ARGB);
const accentBrush = makeBrush(ACCENT_ARGB);

// Font for HUD text.
const fontFamilyBuffer = Buffer.alloc(8);
const fontName = encode('Consolas');
checkStatus(Gdiplus.GdipCreateFontFamilyFromName(fontName.ptr, 0n, fontFamilyBuffer.ptr), 'GdipCreateFontFamilyFromName Consolas');
const fontFamily = fontFamilyBuffer.readBigUInt64LE(0);

const hudFontBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateFont(fontFamily, 22.0, FontStyle.FontStyleBold, Unit.UnitPixel, hudFontBuffer.ptr), 'GdipCreateFont hud');
const hudFont = hudFontBuffer.readBigUInt64LE(0);

const titleFontBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateFont(fontFamily, 64.0, FontStyle.FontStyleBold, Unit.UnitPixel, titleFontBuffer.ptr), 'GdipCreateFont title');
const titleFont = titleFontBuffer.readBigUInt64LE(0);

const subtitleFontBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateFont(fontFamily, 28.0, FontStyle.FontStyleRegular, Unit.UnitPixel, subtitleFontBuffer.ptr), 'GdipCreateFont subtitle');
const subtitleFont = subtitleFontBuffer.readBigUInt64LE(0);

const stringFormatLeftBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, stringFormatLeftBuffer.ptr), 'GdipCreateStringFormat left');
const stringFormatLeft = stringFormatLeftBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(stringFormatLeft, StringAlignment.StringAlignmentNear);

const stringFormatCenterBuffer = Buffer.alloc(8);
checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, stringFormatCenterBuffer.ptr), 'GdipCreateStringFormat center');
const stringFormatCenter = stringFormatCenterBuffer.readBigUInt64LE(0);
Gdiplus.GdipSetStringFormatAlign(stringFormatCenter, StringAlignment.StringAlignmentCenter);

// Scratch buffer for asteroid path point arrays — large enough for any polygon.
const pathPointsScratch = Buffer.alloc(64 * 8); // up to 64 points * (2 floats * 4 bytes)

// Reusable layout RECTs for DrawString calls.
const hudLeftRect = Buffer.alloc(16);
const hudCenterRect = Buffer.alloc(16);
const titleRect = Buffer.alloc(16);
const subtitleRect = Buffer.alloc(16);

function writeRectF(buffer: Buffer, x: number, y: number, w: number, h: number): void {
  buffer.writeFloatLE(x, 0);
  buffer.writeFloatLE(y, 4);
  buffer.writeFloatLE(w, 8);
  buffer.writeFloatLE(h, 12);
}

writeRectF(hudLeftRect, 24, 18, 400, 32);
writeRectF(hudCenterRect, 0, 18, WINDOW_WIDTH, 32);
writeRectF(titleRect, 0, WINDOW_HEIGHT * 0.34, WINDOW_WIDTH, 96);
writeRectF(subtitleRect, 0, WINDOW_HEIGHT * 0.5, WINDOW_WIDTH, 64);

// ──────────────────────────────────────────────────────────────────────────────
// Input polling buffers.

const xinputStateBuffer = Buffer.alloc(16);

interface InputSnapshot {
  turn: number; // -1..+1
  thrust: boolean;
  fire: boolean;
  pause: boolean;
  restart: boolean;
  quit: boolean;
}

function pollInput(): InputSnapshot {
  let turn = 0;
  let thrust = false;
  let fire = false;
  let pause = false;
  let restart = false;
  let quit = false;

  // Keyboard via GetAsyncKeyState. High bit (0x8000) = currently down.
  const leftDown = (User32.GetAsyncKeyState(VirtualKey.VK_LEFT) & 0x8000) !== 0;
  const rightDown = (User32.GetAsyncKeyState(VirtualKey.VK_RIGHT) & 0x8000) !== 0;
  if (leftDown) turn -= 1;
  if (rightDown) turn += 1;
  if ((User32.GetAsyncKeyState(VirtualKey.VK_UP) & 0x8000) !== 0) thrust = true;
  const spaceDown = (User32.GetAsyncKeyState(VirtualKey.VK_SPACE) & 0x8000) !== 0;
  fire = spaceDown && !prevFireKey;
  prevFireKey = spaceDown;
  const pauseDown = (User32.GetAsyncKeyState(0x50) & 0x8000) !== 0; // 'P'
  pause = pauseDown && !prevPauseKey;
  prevPauseKey = pauseDown;
  const restartDown = (User32.GetAsyncKeyState(0x52) & 0x8000) !== 0; // 'R'
  restart = restartDown && !prevRestartKey;
  prevRestartKey = restartDown;
  if ((User32.GetAsyncKeyState(VirtualKey.VK_ESCAPE) & 0x8000) !== 0) quit = true;

  // Xbox controller 0 — additive over keyboard so either works.
  const xinputResult = Xinput1_4.XInputGetState(0, xinputStateBuffer.ptr);
  if (xinputResult === ERROR_SUCCESS) {
    const buttons = xinputStateBuffer.readUInt16LE(4);
    const leftTrigger = xinputStateBuffer.readUInt8(6);
    const rightTrigger = xinputStateBuffer.readUInt8(7);
    const thumbLX = xinputStateBuffer.readInt16LE(8);
    const thumbLY = xinputStateBuffer.readInt16LE(10);

    if (Math.abs(thumbLX) > XINPUT_STICK_DEADZONE) {
      turn += thumbLX / 32768;
    }
    // Allow nose-up via thumbstick Y as a fallback for thrust intent if held forward.
    if (thumbLY > XINPUT_STICK_DEADZONE * 2) thrust = true;
    if (rightTrigger > XINPUT_TRIGGER_THRESHOLD) thrust = true;
    if ((buttons & XInputGamepadButtons.XINPUT_GAMEPAD_A) !== 0) thrust = true;

    const padFireDown = (buttons & XInputGamepadButtons.XINPUT_GAMEPAD_B) !== 0 || leftTrigger > XINPUT_TRIGGER_THRESHOLD;
    if (padFireDown && !prevPadFireDown) fire = true;
    prevPadFireDown = padFireDown;

    const padPauseDown = (buttons & XInputGamepadButtons.XINPUT_GAMEPAD_START) !== 0;
    if (padPauseDown && !prevPadPauseDown) pause = true;
    prevPadPauseDown = padPauseDown;

    const padBackDown = (buttons & XInputGamepadButtons.XINPUT_GAMEPAD_BACK) !== 0;
    if (padBackDown && !prevPadBackDown && gameOver) restart = true;
    if (padBackDown && !gameOver) quit = true;
    prevPadBackDown = padBackDown;
  }

  // Clamp turn to [-1, +1].
  if (turn > 1) turn = 1;
  if (turn < -1) turn = -1;

  return { turn, thrust, fire, pause, restart, quit };
}

// ──────────────────────────────────────────────────────────────────────────────
// Game logic.

function wrapPosition(p: Vector2): void {
  if (p.x < -20) p.x += WINDOW_WIDTH + 40;
  else if (p.x > WINDOW_WIDTH + 20) p.x -= WINDOW_WIDTH + 40;
  if (p.y < -20) p.y += WINDOW_HEIGHT + 40;
  else if (p.y > WINDOW_HEIGHT + 20) p.y -= WINDOW_HEIGHT + 40;
}

function distanceSquared(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function shipAlive(): boolean {
  return ship.alive && lives > 0;
}

function fireBullet(): void {
  if (!shipAlive() || ship.cooldownTicks > 0) return;
  const heading = ship.heading;
  bullets.push({
    position: { x: ship.position.x + Math.cos(heading) * SHIP_RADIUS, y: ship.position.y + Math.sin(heading) * SHIP_RADIUS },
    velocity: { x: Math.cos(heading) * BULLET_SPEED + ship.velocity.x * 0.4, y: Math.sin(heading) * BULLET_SPEED + ship.velocity.y * 0.4 },
    ttlTicks: BULLET_TTL_TICKS,
  });
  ship.cooldownTicks = SHIP_BULLET_COOLDOWN_TICKS;
  if (shootSfx) playSoundEffect(shootSfx);
}

function killShip(): void {
  if (ship.invincibleTicks > 0) return;
  ship.alive = false;
  lives -= 1;
  if (deathSfx) playSoundEffect(deathSfx);
  if (lives <= 0) {
    gameOver = true;
    return;
  }
  // Respawn at center after a short delay (handled by alive flag toggle below).
  ship.position.x = WINDOW_WIDTH / 2;
  ship.position.y = WINDOW_HEIGHT / 2;
  ship.velocity.x = 0;
  ship.velocity.y = 0;
  ship.heading = -Math.PI / 2;
  ship.invincibleTicks = SHIP_RESPAWN_INVINCIBLE_TICKS;
  ship.alive = true;
}

function splitAsteroid(asteroid: Asteroid): void {
  if (asteroid.size === ASTEROID_SIZE_SMALL) return;
  const nextSize: 0 | 1 | 2 = (asteroid.size + 1) as 1 | 2;
  const speed = ASTEROID_BASE_SPEED + waveNumber * ASTEROID_SPEED_PER_WAVE;
  for (let i = 0; i < 2; i += 1) {
    const direction = Math.random() * Math.PI * 2;
    asteroids.push({
      position: { x: asteroid.position.x, y: asteroid.position.y },
      velocity: { x: Math.cos(direction) * speed * 1.25, y: Math.sin(direction) * speed * 1.25 },
      size: nextSize,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 2.4,
      vertices: makeAsteroidVertices(nextSize),
    });
  }
}

function step(input: InputSnapshot): void {
  if (input.pause && !gameOver) paused = !paused;
  if (input.restart && gameOver) resetGame();
  if (input.quit) requestedQuit = true;
  if (paused || gameOver) return;

  // Ship simulation.
  if (shipAlive()) {
    ship.heading += input.turn * SHIP_TURN_SPEED * SECONDS_PER_TICK;
    ship.thrusting = input.thrust;
    if (input.thrust) {
      ship.velocity.x += Math.cos(ship.heading) * SHIP_THRUST_ACCEL * SECONDS_PER_TICK;
      ship.velocity.y += Math.sin(ship.heading) * SHIP_THRUST_ACCEL * SECONDS_PER_TICK;
      const speed = Math.hypot(ship.velocity.x, ship.velocity.y);
      if (speed > SHIP_MAX_SPEED) {
        const scale = SHIP_MAX_SPEED / speed;
        ship.velocity.x *= scale;
        ship.velocity.y *= scale;
      }
    }
    ship.velocity.x *= SHIP_FRICTION;
    ship.velocity.y *= SHIP_FRICTION;
    ship.position.x += ship.velocity.x * SECONDS_PER_TICK;
    ship.position.y += ship.velocity.y * SECONDS_PER_TICK;
    wrapPosition(ship.position);
    if (ship.cooldownTicks > 0) ship.cooldownTicks -= 1;
    if (ship.invincibleTicks > 0) ship.invincibleTicks -= 1;
    if (input.fire) fireBullet();
  }

  // Bullet simulation.
  for (let i = bullets.length - 1; i >= 0; i -= 1) {
    const bullet = bullets[i]!;
    bullet.position.x += bullet.velocity.x * SECONDS_PER_TICK;
    bullet.position.y += bullet.velocity.y * SECONDS_PER_TICK;
    wrapPosition(bullet.position);
    bullet.ttlTicks -= 1;
    if (bullet.ttlTicks <= 0) bullets.splice(i, 1);
  }

  // Asteroid simulation + collisions.
  const destroyedAsteroids: Asteroid[] = [];
  for (const asteroid of asteroids) {
    asteroid.position.x += asteroid.velocity.x * SECONDS_PER_TICK;
    asteroid.position.y += asteroid.velocity.y * SECONDS_PER_TICK;
    asteroid.rotation += asteroid.rotationSpeed * SECONDS_PER_TICK;
    wrapPosition(asteroid.position);
  }

  // Bullet vs asteroid.
  for (let bulletIndex = bullets.length - 1; bulletIndex >= 0; bulletIndex -= 1) {
    const bullet = bullets[bulletIndex]!;
    let hit = false;
    for (let asteroidIndex = asteroids.length - 1; asteroidIndex >= 0; asteroidIndex -= 1) {
      const asteroid = asteroids[asteroidIndex]!;
      const radius = ASTEROID_RADII[asteroid.size]!;
      if (distanceSquared(bullet.position, asteroid.position) <= radius * radius) {
        destroyedAsteroids.push(asteroid);
        asteroids.splice(asteroidIndex, 1);
        score += [20, 50, 100][asteroid.size]!;
        if (hitSfx) playSoundEffect(hitSfx);
        hit = true;
        break;
      }
    }
    if (hit) bullets.splice(bulletIndex, 1);
  }
  for (const asteroid of destroyedAsteroids) splitAsteroid(asteroid);

  // Ship vs asteroid.
  if (shipAlive() && ship.invincibleTicks <= 0) {
    for (const asteroid of asteroids) {
      const radius = ASTEROID_RADII[asteroid.size]!;
      const collisionRadius = radius + SHIP_RADIUS * 0.7;
      if (distanceSquared(ship.position, asteroid.position) <= collisionRadius * collisionRadius) {
        killShip();
        break;
      }
    }
  }

  // Wave clear.
  if (asteroids.length === 0) {
    waveNumber += 1;
    spawnWave();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Rendering.

function drawAsteroid(asteroid: Asteroid): void {
  const cosR = Math.cos(asteroid.rotation);
  const sinR = Math.sin(asteroid.rotation);
  const pointCount = asteroid.vertices.length / 2;
  for (let i = 0; i < pointCount; i += 1) {
    const vx = asteroid.vertices[i * 2]!;
    const vy = asteroid.vertices[i * 2 + 1]!;
    const x = asteroid.position.x + vx * cosR - vy * sinR;
    const y = asteroid.position.y + vx * sinR + vy * cosR;
    pathPointsScratch.writeFloatLE(x, i * 8);
    pathPointsScratch.writeFloatLE(y, i * 8 + 4);
  }
  // Use a fresh closed path each draw — cheaper than rebuilding for every frame
  // would be to keep a path per asteroid, but the polygon shape rotates so we
  // either need a matrix transform on the graphics or fresh world-space points.
  const pathBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, pathBuffer.ptr) !== Status.Ok) return;
  const path = pathBuffer.readBigUInt64LE(0);
  Gdiplus.GdipAddPathLine2(path, pathPointsScratch.ptr, pointCount);
  Gdiplus.GdipClosePathFigure(path);
  Gdiplus.GdipDrawPath(offscreenGraphics, whitePen, path);
  Gdiplus.GdipDeletePath(path);
}

function drawShipAt(x: number, y: number, heading: number, thrusting: boolean, dim: boolean, scale: number): void {
  // Ship triangle vertices in object space (nose at +x, tail at -x).
  const noseLength = SHIP_RADIUS * 1.25 * scale;
  const wingLength = SHIP_RADIUS * 0.85 * scale;
  const wingSpan = SHIP_RADIUS * 0.85 * scale;
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  const noseX = x + cosH * noseLength;
  const noseY = y + sinH * noseLength;
  const leftX = x + cosH * -wingLength + -sinH * -wingSpan;
  const leftY = y + sinH * -wingLength + cosH * -wingSpan;
  const rightX = x + cosH * -wingLength + -sinH * wingSpan;
  const rightY = y + sinH * -wingLength + cosH * wingSpan;
  const tailX = x + cosH * -wingLength * 0.4;
  const tailY = y + sinH * -wingLength * 0.4;

  const pen = dim ? dimWhitePen : whitePen;
  Gdiplus.GdipDrawLine(offscreenGraphics, pen, noseX, noseY, leftX, leftY);
  Gdiplus.GdipDrawLine(offscreenGraphics, pen, noseX, noseY, rightX, rightY);
  Gdiplus.GdipDrawLine(offscreenGraphics, pen, leftX, leftY, tailX, tailY);
  Gdiplus.GdipDrawLine(offscreenGraphics, pen, rightX, rightY, tailX, tailY);

  if (thrusting) {
    const flameLength = (SHIP_RADIUS * 1.05 + Math.random() * SHIP_RADIUS * 0.45) * scale;
    const flameTipX = x + cosH * -(wingLength * 0.6 + flameLength);
    const flameTipY = y + sinH * -(wingLength * 0.6 + flameLength);
    const flameLeftX = x + cosH * -wingLength * 0.65 + -sinH * -wingSpan * 0.4;
    const flameLeftY = y + sinH * -wingLength * 0.65 + cosH * -wingSpan * 0.4;
    const flameRightX = x + cosH * -wingLength * 0.65 + -sinH * wingSpan * 0.4;
    const flameRightY = y + sinH * -wingLength * 0.65 + cosH * wingSpan * 0.4;
    Gdiplus.GdipDrawLine(offscreenGraphics, flamePen, flameLeftX, flameLeftY, flameTipX, flameTipY);
    Gdiplus.GdipDrawLine(offscreenGraphics, flamePen, flameRightX, flameRightY, flameTipX, flameTipY);
  }
}

function drawHudText(text: string, rect: Buffer, format: bigint, font: bigint, brush: bigint): void {
  const buffer = encode(text);
  Gdiplus.GdipDrawString(offscreenGraphics, buffer.ptr, -1, font, rect.ptr, format, brush);
}

function render(): void {
  // Clear to black with full alpha.
  Gdiplus.GdipGraphicsClear(offscreenGraphics, BLACK_ARGB);

  // Asteroids first (lowest visual layer).
  for (const asteroid of asteroids) drawAsteroid(asteroid);

  // Bullets — small bright dots.
  for (const bullet of bullets) {
    Gdiplus.GdipFillEllipse(offscreenGraphics, bulletBrush, bullet.position.x - 2, bullet.position.y - 2, 4, 4);
  }

  // Ship — blink while invincible after respawn.
  if (shipAlive()) {
    const blinkPhase = ship.invincibleTicks > 0 && Math.floor(ship.invincibleTicks / 6) % 2 === 0;
    if (!blinkPhase) {
      drawShipAt(ship.position.x, ship.position.y, ship.heading, ship.thrusting, false, 1);
    }
  }

  // HUD.
  drawHudText(`SCORE  ${score.toString().padStart(6, '0')}`, hudLeftRect, stringFormatLeft, hudFont, whiteBrush);
  drawHudText(`WAVE  ${waveNumber}`, hudCenterRect, stringFormatCenter, hudFont, accentBrush);

  // Lives — small ships drawn from the right edge.
  for (let i = 0; i < lives; i += 1) {
    drawShipAt(WINDOW_WIDTH - 30 - i * 28, 32, -Math.PI / 2, false, false, 0.85);
  }

  if (paused) {
    drawHudText('PAUSED', titleRect, stringFormatCenter, titleFont, accentBrush);
    drawHudText('press P or Start to resume', subtitleRect, stringFormatCenter, subtitleFont, whiteBrush);
  } else if (gameOver) {
    drawHudText('GAME OVER', titleRect, stringFormatCenter, titleFont, whiteBrush);
    drawHudText(`final score ${score}    press R to restart`, subtitleRect, stringFormatCenter, subtitleFont, accentBrush);
  }

  // Flush the offscreen graphics so the bitmap pixels are committed before blit.
  Gdiplus.GdipFlush(offscreenGraphics, FlushIntention.FlushIntentionSync);
}

function blitToWindow(hwnd: bigint): void {
  const hdc = User32.GetDC(hwnd);
  if (hdc === 0n) return;
  const hdcGraphicsBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(hdc, hdcGraphicsBuffer.ptr) === Status.Ok) {
    const hdcGraphics = hdcGraphicsBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageI(hdcGraphics, offscreenBitmap, 0, 0);
    Gdiplus.GdipDeleteGraphics(hdcGraphics);
  }
  User32.ReleaseDC(hwnd, hdc);
}

// ──────────────────────────────────────────────────────────────────────────────
// Window class + WndProc — drives the per-frame tick.

let mainWindow = NULL;

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER && wParam === TIMER_ID) {
      const input = pollInput();
      step(input);
      render();
      blitToWindow(hWnd);
      if (requestedQuit) {
        User32.DestroyWindow(hWnd);
      }
      return 0n;
    }
    if (msg === WM_KEYDOWN && wParam === BigInt(VirtualKey.VK_ESCAPE)) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_KEYUP || msg === WM_KEYDOWN) {
      // We do everything via GetAsyncKeyState; just absorb these so the default
      // proc does not produce a system beep on certain hosts.
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
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

const className = encode('BunWin32Asteroids');
const windowTitle = encode('Asteroids — bun-win32');

const wndClassBuf = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuf.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuf.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true);
wndClassView.setInt32(20, 0, true);
wndClassBuf.writeBigUInt64LE(0n, 24); // hInstance
wndClassBuf.writeBigUInt64LE(0n, 32); // hIcon
wndClassBuf.writeBigUInt64LE(0n, 40); // hCursor
wndClassBuf.writeBigUInt64LE(0n, 48); // hbrBackground
wndClassBuf.writeBigUInt64LE(0n, 56); // lpszMenuName
wndClassBuf.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
wndClassBuf.writeBigUInt64LE(0n, 72); // hIconSm

const classAtom = User32.RegisterClassExW(wndClassBuf.ptr);
if (!classAtom) {
  console.error('Failed to register window class');
  process.exit(1);
}

// Center the borderless window on the primary monitor.
const screenWidth = User32.GetSystemMetrics(0);
const screenHeight = User32.GetSystemMetrics(1);
const windowX = Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2));
const windowY = Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2));

mainWindow = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  windowTitle.ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX,
  windowY,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  NULL,
  NULL,
  NULL,
  NULL_PTR,
);
if (!mainWindow) {
  console.error('Failed to create main window');
  process.exit(1);
}

// Enable immersive dark mode so the (otherwise hidden) title bar/edges blend with black.
const darkModeFlag = Buffer.alloc(4);
darkModeFlag.writeUInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(mainWindow, DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeFlag.ptr, 4);

User32.ShowWindow(mainWindow, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(mainWindow);
User32.SetForegroundWindow(mainWindow);
User32.SetFocus(mainWindow);

resetGame();

// Console intro — printed before the message loop blocks.
console.log();
console.log('  ASTEROIDS — bun-win32');
console.log('  ────────────────────────────────────────');
console.log('  Keyboard:  Left/Right turn,  Up thrust,  Space fire,  P pause,  R restart,  ESC quit');
console.log('  Xbox:      LX stick turn,    A/RT thrust, B fire,     Start pause, Back quit');
console.log(audioReady ? '  Audio:     XAudio2 mastering voice ready (procedural SFX)' : '  Audio:     no audio endpoint — game runs silent');
console.log();

const timerHandle = User32.SetTimer(mainWindow, TIMER_ID, TICK_INTERVAL_MS, null);
if (!timerHandle) {
  console.error('Failed to start game timer');
  User32.DestroyWindow(mainWindow);
  process.exit(1);
}

// Message loop.
const msgBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(msgBuffer.ptr, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(msgBuffer.ptr);
  User32.DispatchMessageW(msgBuffer.ptr);
}

// ──────────────────────────────────────────────────────────────────────────────
// Teardown.

User32.KillTimer(mainWindow, TIMER_ID);
User32.UnregisterClassW(className.ptr, NULL);

Gdiplus.GdipDeleteBrush(bulletBrush);
Gdiplus.GdipDeleteBrush(whiteBrush);
Gdiplus.GdipDeleteBrush(accentBrush);
Gdiplus.GdipDeletePen(whitePen);
Gdiplus.GdipDeletePen(dimWhitePen);
Gdiplus.GdipDeletePen(flamePen);
Gdiplus.GdipDeleteFont(hudFont);
Gdiplus.GdipDeleteFont(titleFont);
Gdiplus.GdipDeleteFont(subtitleFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteStringFormat(stringFormatLeft);
Gdiplus.GdipDeleteStringFormat(stringFormatCenter);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (audioReady) {
  for (const sfx of [shootSfx, hitSfx, deathSfx]) {
    if (!sfx) continue;
    for (const voice of sfx.voicePool) {
      vcall(voice, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
      vcall(voice, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
    }
  }
  if (xaudioMaster !== 0n) vcall(xaudioMaster, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  if (xaudioEngine !== 0n) vcall(xaudioEngine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
}

wndProc.close();

console.log('  Thanks for playing. Final score:', score);
