/**
 * Splitscreen Pong — 4-player local multiplayer Pong on a single Windows
 * desktop, driven entirely by FFI through @bun-win32. Four paddles guard the
 * north, south, east, and west walls of a borderless 1400x900 court; each is
 * steered by a different Xbox controller polled via XInput1_4.XInputGetState.
 * The ball arcs around the court reflecting off paddles and bouncing tangential
 * english from paddle motion. Each side starts with three lives and loses one
 * when the ball escapes its wall — last player still alive wins.
 *
 * The renderer rasterises a 32-bit ARGB bitmap with the GDI+ flat APIs every
 * tick and blits it to the window via GdipDrawImageI. Sound effects are pure
 * procedural PCM rendered into i16 buffers in JavaScript and submitted to a
 * recycled pool of IXAudio2SourceVoice instances. The window is borderless,
 * gets immersive dark mode via DwmSetWindowAttribute, and the entire frame is
 * shaken with a translation offset for ~150 ms on each score/miss.
 *
 * If a controller slot returns ERROR_DEVICE_NOT_CONNECTED, that side switches
 * to a rate-limited AI that chases the ball — so the demo runs end-to-end with
 * zero controllers plugged in (four AI paddles bouncing forever).
 *
 * Controls
 *   - Paddle North / South: left thumbstick X-axis on controllers 0 / 1
 *   - Paddle West  / East : left thumbstick Y-axis on controllers 2 / 3
 *   - Pause: Start button on any controller, or Space
 *   - Restart: Back button on any controller after game over, or R
 *   - Quit: ESC
 *
 * Pipeline (every step is a real FFI call):
 *
 *   - Window:   User32.{RegisterClassExW, CreateWindowExW, ShowWindow,
 *               SetForegroundWindow, GetDC, ReleaseDC, SetTimer, GetMessageW,
 *               TranslateMessage, DispatchMessageW, DefWindowProcW,
 *               DestroyWindow, PostQuitMessage, GetAsyncKeyState,
 *               GetSystemMetrics}
 *   - DWM:      Dwmapi.DwmSetWindowAttribute(DWMWA_USE_IMMERSIVE_DARK_MODE)
 *   - Input:    Xinput1_4.XInputGetState (4 slots polled per frame)
 *   - Audio:    Xaudio2_9.XAudio2Create + IXAudio2::CreateMasteringVoice /
 *               CreateSourceVoice + IXAudio2SourceVoice::{Start, Stop,
 *               SubmitSourceBuffer, FlushSourceBuffers, DestroyVoice}
 *   - Render:   Gdiplus.{GdiplusStartup, GdipCreateBitmapFromScan0,
 *               GdipGetImageGraphicsContext, GdipSetSmoothingMode,
 *               GdipSetTextRenderingHint, GdipCreateSolidFill,
 *               GdipCreateFontFamilyFromName, GdipCreateFont,
 *               GdipCreateStringFormat, GdipSetStringFormatAlign,
 *               GdipGraphicsClear, GdipFillRectangle, GdipFillEllipse,
 *               GdipDrawString, GdipCreatePath, GdipAddPathLine2,
 *               GdipClosePathFigure, GdipFillPath, GdipFlush,
 *               GdipCreateFromHDC, GdipDrawImageI, GdipDeleteGraphics,
 *               GdipDisposeImage, GdiplusShutdown}
 *
 * Run: bun run example/splitscreen-pong.ts
 */

import { CFunction, FFIType, JSCallback, read, type Pointer } from 'bun:ffi';

import { Dwmapi, Gdiplus, User32, Xaudio2_9, Xinput1_4 } from '../index';
import { ExtendedWindowStyles, ShowWindowCommand, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { FillMode, FlushIntention, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit, FontStyle } from '@bun-win32/gdiplus';
import { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '@bun-win32/xaudio2_9';
import { XInputGamepadButtons, XUSER_MAX_COUNT } from '@bun-win32/xinput1_4';

// ──────────────────────────────────────────────────────────────────────────────
// Constants

const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 900;

const TICK_INTERVAL_MS = 16; // ~62 fps; SetTimer is the limiting clock here
const SECONDS_PER_TICK = TICK_INTERVAL_MS / 1000;

const WALL_INSET = 40; // distance from window edge to the playable rectangle
const PADDLE_THICKNESS = 14;
const PADDLE_LENGTH = 130;
const PADDLE_LENGTH_HALF = PADDLE_LENGTH / 2;
const PADDLE_MAX_SPEED = 720; // pixels/second when stick is fully deflected
const PADDLE_AI_SPEED = 460;
const PADDLE_AI_RESPONSE = 0.65; // 0..1 — how aggressively AI tracks the ball

const BALL_RADIUS = 11;
const BALL_INITIAL_SPEED = 480; // pixels/second
const BALL_SPEEDUP_PER_HIT = 14; // grows the ball faster on every paddle hit
const BALL_MAX_SPEED = 1100;
const BALL_TRAIL_LENGTH = 14;

const STARTING_LIVES = 3;

const XINPUT_STICK_DEADZONE = 8000;

const SHAKE_DURATION_TICKS = 9; // ~150 ms at 62 fps
const SHAKE_MAGNITUDE = 6;

const PLAYER_COUNT = 4;
const PLAYER_NORTH = 0;
const PLAYER_SOUTH = 1;
const PLAYER_WEST = 2;
const PLAYER_EAST = 3;

const PLAYER_NAMES = ['NORTH', 'SOUTH', 'WEST', 'EAST'] as const;
const PLAYER_COLORS = [0xff_ff_4a_4a, 0xff_4a_a8_ff, 0xff_4a_e0_5a, 0xff_ff_d8_3a] as const; // red, blue, green, yellow

const WHITE_ARGB = 0xff_ff_ff_ff;
const DIM_ARGB = 0xff_60_60_60;
const VERY_DIM_ARGB = 0xff_28_28_28;
const COURT_BG_ARGB = 0xff_08_0a_12;
const COURT_WALL_ARGB = 0xff_1a_1d_2c;
const BALL_ARGB = 0xff_ff_ff_ff;

const NULL = 0n;
const NULL_PTR = null as unknown as Pointer;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_TIMER = 0x0113;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;

const TIMER_ID = 1n;
const ERROR_SUCCESS = 0;
const ERROR_DEVICE_NOT_CONNECTED = 0x048f;

const XAUDIO2_END_OF_STREAM = 0x0040;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const AUDIO_CATEGORY_GAME_EFFECTS = 6;

// IXAudio2 / IXAudio2SourceVoice vtable slots (xaudio2.h declaration order).
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
// COM vtable helper — memoized CFunction binders for each (method, signature).

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
// Court geometry — the playable rectangle inside the window.

const COURT_LEFT = WALL_INSET;
const COURT_TOP = WALL_INSET;
const COURT_RIGHT = WINDOW_WIDTH - WALL_INSET;
const COURT_BOTTOM = WINDOW_HEIGHT - WALL_INSET;
const COURT_HEIGHT = COURT_BOTTOM - COURT_TOP;
const COURT_CENTER_X = WINDOW_WIDTH / 2;
const COURT_CENTER_Y = WINDOW_HEIGHT / 2;

// ──────────────────────────────────────────────────────────────────────────────
// Game state

interface Paddle {
  position: number; // along its axis: x for N/S, y for E/W
  velocity: number; // pixels/second along the same axis (signed)
  lives: number;
  alive: boolean;
}

interface BallTrailSample {
  x: number;
  y: number;
}

const paddles: Paddle[] = [
  { position: COURT_CENTER_X, velocity: 0, lives: STARTING_LIVES, alive: true }, // NORTH
  { position: COURT_CENTER_X, velocity: 0, lives: STARTING_LIVES, alive: true }, // SOUTH
  { position: COURT_CENTER_Y, velocity: 0, lives: STARTING_LIVES, alive: true }, // WEST
  { position: COURT_CENTER_Y, velocity: 0, lives: STARTING_LIVES, alive: true }, // EAST
];

const controllerConnected: boolean[] = [false, false, false, false];

let ballX = COURT_CENTER_X;
let ballY = COURT_CENTER_Y;
let ballVX = 0;
let ballVY = 0;
let ballSpeed = BALL_INITIAL_SPEED;
const ballTrail: BallTrailSample[] = [];

let paused = false;
let gameOver = false;
let winnerIndex = -1;
let tickCount = 0;
let shakeTicksRemaining = 0;
let requestedQuit = false;
let restartRequested = false;
let pauseRequested = false;

const prevPauseDown: boolean[] = [false, false, false, false];
const prevRestartDown: boolean[] = [false, false, false, false];
let prevKeyboardPauseDown = false;
let prevKeyboardRestartDown = false;

function resetBall(serveDirection: number = -1): void {
  ballX = COURT_CENTER_X;
  ballY = COURT_CENTER_Y;
  ballSpeed = BALL_INITIAL_SPEED;
  // Aim toward whichever side has the most lives left so the game keeps a pulse.
  const aliveSides = paddles.map((p, i) => ({ index: i, lives: p.lives })).filter((p) => paddles[p.index]!.alive);
  let target = aliveSides.length > 0 ? aliveSides[Math.floor(Math.random() * aliveSides.length)]!.index : PLAYER_NORTH;
  const targetAngles: Record<number, number> = {
    [PLAYER_NORTH]: -Math.PI / 2,
    [PLAYER_SOUTH]: Math.PI / 2,
    [PLAYER_WEST]: Math.PI,
    [PLAYER_EAST]: 0,
  };
  const baseAngle = targetAngles[target]!;
  const angle = baseAngle + (Math.random() - 0.5) * 0.7;
  ballVX = Math.cos(angle) * ballSpeed * serveDirection;
  ballVY = Math.sin(angle) * ballSpeed * serveDirection;
  ballTrail.length = 0;
}

function resetMatch(): void {
  for (const paddle of paddles) {
    paddle.position = paddle === paddles[PLAYER_NORTH] || paddle === paddles[PLAYER_SOUTH] ? COURT_CENTER_X : COURT_CENTER_Y;
    paddle.velocity = 0;
    paddle.lives = STARTING_LIVES;
    paddle.alive = true;
  }
  gameOver = false;
  winnerIndex = -1;
  tickCount = 0;
  shakeTicksRemaining = 0;
  resetBall(1);
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

/** Pure-tone "blip" — short sine with snappy decay. */
function renderBlip(frequencyHz: number, durationSeconds: number, amplitude: number): Buffer {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = i / sampleCount;
    const envelope = Math.max(0, 1 - progress) ** 1.8;
    const sample = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude * envelope;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * AUDIO_BLOCK_ALIGN);
  }
  return pcm;
}

/** Two-stack sine "bing" — used for scoring chimes. */
function renderChime(durationSeconds: number, baseHz: number, amplitude: number): Buffer {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / SAMPLE_RATE;
    const progress = i / sampleCount;
    const envelope = Math.exp(-progress * 4);
    const fundamental = Math.sin(2 * Math.PI * baseHz * t);
    const overtone = Math.sin(2 * Math.PI * baseHz * 1.5 * t) * 0.45;
    const sample = (fundamental + overtone) * amplitude * envelope;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * AUDIO_BLOCK_ALIGN);
  }
  return pcm;
}

/** Falling square sweep "buzz" — miss / death. */
function renderBuzz(durationSeconds: number, startHz: number, endHz: number, amplitude: number): Buffer {
  const sampleCount = Math.floor(durationSeconds * SAMPLE_RATE);
  const pcm = Buffer.alloc(sampleCount * AUDIO_BLOCK_ALIGN);
  let phase = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const progress = i / sampleCount;
    const frequency = startHz + (endHz - startHz) * progress;
    phase += (frequency / SAMPLE_RATE) * Math.PI * 2;
    const square = Math.sin(phase) >= 0 ? 1 : -1;
    const envelope = Math.max(0, 1 - progress) ** 1.4;
    const sample = square * amplitude * envelope;
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

function playSoundEffect(effect: SoundEffect | null): void {
  if (effect === null) return;
  const voice = effect.voicePool[effect.voiceCursor]!;
  effect.voiceCursor = (effect.voiceCursor + 1) % effect.voicePool.length;
  vcall(voice, IXAUDIO2SOURCEVOICE_STOP, [FFIType.u32, FFIType.u32], [0, 0]);
  vcall(voice, IXAUDIO2SOURCEVOICE_FLUSHSOURCEBUFFERS, [], []);
  vcall(voice, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [effect.bufferDescriptor.ptr, null]);
  vcall(voice, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
}

const ppEngine = Buffer.alloc(8);
const xaudioCreateHr = Xaudio2_9.XAudio2Create(ppEngine.ptr, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
let xaudioEngine = 0n;
let xaudioMaster = 0n;
let audioReady = false;
let blipSfx: SoundEffect | null = null;
let blopSfx: SoundEffect | null = null;
let buzzSfx: SoundEffect | null = null;
let bingSfx: SoundEffect | null = null;

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
    blipSfx = createSoundEffect(xaudioEngine, renderBlip(820, 0.05, 0.55), wfx.ptr); // paddle hit
    blopSfx = createSoundEffect(xaudioEngine, renderBlip(440, 0.08, 0.45), wfx.ptr); // wall bounce
    buzzSfx = createSoundEffect(xaudioEngine, renderBuzz(0.22, 280, 60, 0.5), wfx.ptr); // miss
    bingSfx = createSoundEffect(xaudioEngine, renderChime(0.4, 760, 0.5), wfx.ptr); // score / round end
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

function makeBrush(argb: number): bigint {
  const brush = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreateSolidFill(argb, brush.ptr), 'GdipCreateSolidFill');
  return brush.readBigUInt64LE(0);
}

const playerBrushes = PLAYER_COLORS.map((c) => makeBrush(c));
const wallBrush = makeBrush(COURT_WALL_ARGB);
const ballBrush = makeBrush(BALL_ARGB);
const whiteBrush = makeBrush(WHITE_ARGB);
const dimBrush = makeBrush(DIM_ARGB);
const veryDimBrush = makeBrush(VERY_DIM_ARGB);

// Font + string format objects for all the HUD typography.
const fontFamilyBuffer = Buffer.alloc(8);
const fontName = encode('Consolas');
checkStatus(Gdiplus.GdipCreateFontFamilyFromName(fontName.ptr, 0n, fontFamilyBuffer.ptr), 'GdipCreateFontFamilyFromName Consolas');
const fontFamily = fontFamilyBuffer.readBigUInt64LE(0);

function makeFont(sizePx: number, style: number): bigint {
  const fontBuffer = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreateFont(fontFamily, sizePx, style, Unit.UnitPixel, fontBuffer.ptr), `GdipCreateFont (${sizePx})`);
  return fontBuffer.readBigUInt64LE(0);
}

const scoreFont = makeFont(72, FontStyle.FontStyleBold);
const titleFont = makeFont(96, FontStyle.FontStyleBold);
const subtitleFont = makeFont(34, FontStyle.FontStyleRegular);
const hudFont = makeFont(20, FontStyle.FontStyleBold);

function makeStringFormat(align: StringAlignment, lineAlign: StringAlignment): bigint {
  const buffer = Buffer.alloc(8);
  checkStatus(Gdiplus.GdipCreateStringFormat(0, 0, buffer.ptr), 'GdipCreateStringFormat');
  const sf = buffer.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(sf, align);
  Gdiplus.GdipSetStringFormatLineAlign(sf, lineAlign);
  return sf;
}

const stringFormatCenter = makeStringFormat(StringAlignment.StringAlignmentCenter, StringAlignment.StringAlignmentCenter);
const stringFormatLeft = makeStringFormat(StringAlignment.StringAlignmentNear, StringAlignment.StringAlignmentNear);
const stringFormatRight = makeStringFormat(StringAlignment.StringAlignmentFar, StringAlignment.StringAlignmentNear);

// Scratch RECTs for DrawString calls.
function writeRectF(buffer: Buffer, x: number, y: number, w: number, h: number): void {
  buffer.writeFloatLE(x, 0);
  buffer.writeFloatLE(y, 4);
  buffer.writeFloatLE(w, 8);
  buffer.writeFloatLE(h, 12);
}

const titleRect = Buffer.alloc(16);
const subtitleRect = Buffer.alloc(16);
const scoreRect = Buffer.alloc(16);
const hudRect = Buffer.alloc(16);
writeRectF(titleRect, 0, COURT_CENTER_Y - 80, WINDOW_WIDTH, 120);
writeRectF(subtitleRect, 0, COURT_CENTER_Y + 40, WINDOW_WIDTH, 60);

// ──────────────────────────────────────────────────────────────────────────────
// Input — poll all four XInput slots + the keyboard for global pause/restart/quit.

const xinputStateBuffers = Array.from({ length: XUSER_MAX_COUNT }, () => Buffer.alloc(16));

interface PaddleInput {
  axis: number; // -1..+1; sign convention matches paddle.position axis
  startPressed: boolean;
  backPressed: boolean;
}

function pollPaddleInput(playerIndex: number): PaddleInput {
  const buffer = xinputStateBuffers[playerIndex]!;
  const result = Xinput1_4.XInputGetState(playerIndex, buffer.ptr);
  if (result === ERROR_SUCCESS) {
    controllerConnected[playerIndex] = true;
    const buttons = buffer.readUInt16LE(4);
    const lx = buffer.readInt16LE(8);
    const ly = buffer.readInt16LE(10);
    // For N/S paddles use LX (horizontal). For E/W use LY but invert because
    // XInput Y is positive when stick is pushed UP, while our screen-space y axis
    // grows downward.
    const horizontal = playerIndex === PLAYER_NORTH || playerIndex === PLAYER_SOUTH;
    const raw = horizontal ? lx : -ly;
    let axis = 0;
    if (Math.abs(raw) > XINPUT_STICK_DEADZONE) {
      const sign = Math.sign(raw);
      const magnitude = (Math.abs(raw) - XINPUT_STICK_DEADZONE) / (32767 - XINPUT_STICK_DEADZONE);
      axis = sign * Math.min(1, magnitude);
    }
    return {
      axis,
      startPressed: (buttons & XInputGamepadButtons.XINPUT_GAMEPAD_START) !== 0,
      backPressed: (buttons & XInputGamepadButtons.XINPUT_GAMEPAD_BACK) !== 0,
    };
  }
  if (result === ERROR_DEVICE_NOT_CONNECTED) controllerConnected[playerIndex] = false;
  return { axis: 0, startPressed: false, backPressed: false };
}

function pollKeyboard(): void {
  const escDown = (User32.GetAsyncKeyState(VirtualKey.VK_ESCAPE) & 0x8000) !== 0;
  if (escDown) requestedQuit = true;
  const spaceDown = (User32.GetAsyncKeyState(VirtualKey.VK_SPACE) & 0x8000) !== 0;
  if (spaceDown && !prevKeyboardPauseDown) pauseRequested = true;
  prevKeyboardPauseDown = spaceDown;
  const rDown = (User32.GetAsyncKeyState(0x52) & 0x8000) !== 0; // 'R'
  if (rDown && !prevKeyboardRestartDown) restartRequested = true;
  prevKeyboardRestartDown = rDown;
}

// ──────────────────────────────────────────────────────────────────────────────
// Game logic.

function clampPaddlePosition(playerIndex: number, position: number): number {
  // North/South paddles move horizontally between COURT_LEFT and COURT_RIGHT.
  // West/East paddles move vertically between COURT_TOP and COURT_BOTTOM.
  const horizontal = playerIndex === PLAYER_NORTH || playerIndex === PLAYER_SOUTH;
  const min = horizontal ? COURT_LEFT + PADDLE_LENGTH_HALF : COURT_TOP + PADDLE_LENGTH_HALF;
  const max = horizontal ? COURT_RIGHT - PADDLE_LENGTH_HALF : COURT_BOTTOM - PADDLE_LENGTH_HALF;
  return Math.max(min, Math.min(max, position));
}

function aiAxisForPaddle(playerIndex: number): number {
  // The AI is a rate-limited tracker that aims its paddle center at the ball.
  const paddle = paddles[playerIndex]!;
  const horizontal = playerIndex === PLAYER_NORTH || playerIndex === PLAYER_SOUTH;
  const ballAlong = horizontal ? ballX : ballY;
  const delta = ballAlong - paddle.position;
  const sign = Math.sign(delta);
  const magnitude = Math.min(1, Math.abs(delta) / 220) * PADDLE_AI_RESPONSE;
  return sign * magnitude;
}

function updatePaddle(playerIndex: number, axis: number): void {
  const paddle = paddles[playerIndex]!;
  if (!paddle.alive) {
    paddle.velocity = 0;
    return;
  }
  const speed = controllerConnected[playerIndex] ? PADDLE_MAX_SPEED : PADDLE_AI_SPEED;
  const requestedVelocity = axis * speed;
  const previousPosition = paddle.position;
  const nextPosition = clampPaddlePosition(playerIndex, paddle.position + requestedVelocity * SECONDS_PER_TICK);
  paddle.velocity = (nextPosition - previousPosition) / SECONDS_PER_TICK;
  paddle.position = nextPosition;
}

interface PaddleBounds {
  axis: 'x' | 'y'; // axis the paddle slides along
  centerAlong: number; // paddle center on the sliding axis
  fixedCoord: number; // the wall-perpendicular face position of the paddle
}

function paddleBounds(playerIndex: number): PaddleBounds {
  const paddle = paddles[playerIndex]!;
  if (playerIndex === PLAYER_NORTH) return { axis: 'x', centerAlong: paddle.position, fixedCoord: COURT_TOP + PADDLE_THICKNESS / 2 };
  if (playerIndex === PLAYER_SOUTH) return { axis: 'x', centerAlong: paddle.position, fixedCoord: COURT_BOTTOM - PADDLE_THICKNESS / 2 };
  if (playerIndex === PLAYER_WEST) return { axis: 'y', centerAlong: paddle.position, fixedCoord: COURT_LEFT + PADDLE_THICKNESS / 2 };
  return { axis: 'y', centerAlong: paddle.position, fixedCoord: COURT_RIGHT - PADDLE_THICKNESS / 2 };
}

function speedUpBall(): void {
  ballSpeed = Math.min(BALL_MAX_SPEED, ballSpeed + BALL_SPEEDUP_PER_HIT);
  const currentSpeed = Math.hypot(ballVX, ballVY);
  if (currentSpeed > 0) {
    const scale = ballSpeed / currentSpeed;
    ballVX *= scale;
    ballVY *= scale;
  }
}

function reflectOffPaddle(playerIndex: number): void {
  const paddle = paddles[playerIndex]!;
  // Paddle normal points inward toward the court; tangent is along the slide axis.
  if (playerIndex === PLAYER_NORTH || playerIndex === PLAYER_SOUTH) {
    // Wall is horizontal — invert vy. Push ball away from the wall so it can't tunnel.
    ballVY = -ballVY;
    if (playerIndex === PLAYER_NORTH) ballY = COURT_TOP + PADDLE_THICKNESS + BALL_RADIUS;
    else ballY = COURT_BOTTOM - PADDLE_THICKNESS - BALL_RADIUS;
    // Add english from paddle motion to vx (tangent).
    ballVX += paddle.velocity * 0.25;
  } else {
    ballVX = -ballVX;
    if (playerIndex === PLAYER_WEST) ballX = COURT_LEFT + PADDLE_THICKNESS + BALL_RADIUS;
    else ballX = COURT_RIGHT - PADDLE_THICKNESS - BALL_RADIUS;
    ballVY += paddle.velocity * 0.25;
  }
  speedUpBall();
  playSoundEffect(blipSfx);
}

function loseLife(playerIndex: number): void {
  const paddle = paddles[playerIndex]!;
  paddle.lives -= 1;
  if (paddle.lives <= 0) {
    paddle.alive = false;
    paddle.lives = 0;
    playSoundEffect(buzzSfx);
  } else {
    playSoundEffect(buzzSfx);
  }
  shakeTicksRemaining = SHAKE_DURATION_TICKS;
  const survivors = paddles.filter((p) => p.alive);
  if (survivors.length === 1) {
    gameOver = true;
    winnerIndex = paddles.indexOf(survivors[0]!);
    playSoundEffect(bingSfx);
    return;
  }
  if (survivors.length === 0) {
    gameOver = true;
    winnerIndex = -1;
    return;
  }
  // Re-serve the ball aimed at one of the surviving sides.
  resetBall(1);
}

function bounceOffDeadWall(playerIndex: number): void {
  // If a side is out of lives, the ball harmlessly bounces off that wall.
  if (playerIndex === PLAYER_NORTH) {
    ballVY = Math.abs(ballVY);
    ballY = COURT_TOP + BALL_RADIUS;
  } else if (playerIndex === PLAYER_SOUTH) {
    ballVY = -Math.abs(ballVY);
    ballY = COURT_BOTTOM - BALL_RADIUS;
  } else if (playerIndex === PLAYER_WEST) {
    ballVX = Math.abs(ballVX);
    ballX = COURT_LEFT + BALL_RADIUS;
  } else {
    ballVX = -Math.abs(ballVX);
    ballX = COURT_RIGHT - BALL_RADIUS;
  }
  playSoundEffect(blopSfx);
}

function updateBall(): void {
  ballX += ballVX * SECONDS_PER_TICK;
  ballY += ballVY * SECONDS_PER_TICK;

  // Record a trail sample every tick — bounded ring buffer.
  ballTrail.push({ x: ballX, y: ballY });
  if (ballTrail.length > BALL_TRAIL_LENGTH) ballTrail.shift();

  // Paddle collisions / wall passes. We handle one axis at a time.
  // North paddle / wall.
  if (ballY - BALL_RADIUS <= COURT_TOP + PADDLE_THICKNESS && ballVY < 0) {
    const paddle = paddles[PLAYER_NORTH]!;
    if (paddle.alive && Math.abs(ballX - paddle.position) <= PADDLE_LENGTH_HALF + BALL_RADIUS) {
      reflectOffPaddle(PLAYER_NORTH);
    } else if (!paddle.alive) {
      bounceOffDeadWall(PLAYER_NORTH);
    } else if (ballY - BALL_RADIUS <= COURT_TOP) {
      loseLife(PLAYER_NORTH);
      return;
    }
  }
  if (ballY + BALL_RADIUS >= COURT_BOTTOM - PADDLE_THICKNESS && ballVY > 0) {
    const paddle = paddles[PLAYER_SOUTH]!;
    if (paddle.alive && Math.abs(ballX - paddle.position) <= PADDLE_LENGTH_HALF + BALL_RADIUS) {
      reflectOffPaddle(PLAYER_SOUTH);
    } else if (!paddle.alive) {
      bounceOffDeadWall(PLAYER_SOUTH);
    } else if (ballY + BALL_RADIUS >= COURT_BOTTOM) {
      loseLife(PLAYER_SOUTH);
      return;
    }
  }
  if (ballX - BALL_RADIUS <= COURT_LEFT + PADDLE_THICKNESS && ballVX < 0) {
    const paddle = paddles[PLAYER_WEST]!;
    if (paddle.alive && Math.abs(ballY - paddle.position) <= PADDLE_LENGTH_HALF + BALL_RADIUS) {
      reflectOffPaddle(PLAYER_WEST);
    } else if (!paddle.alive) {
      bounceOffDeadWall(PLAYER_WEST);
    } else if (ballX - BALL_RADIUS <= COURT_LEFT) {
      loseLife(PLAYER_WEST);
      return;
    }
  }
  if (ballX + BALL_RADIUS >= COURT_RIGHT - PADDLE_THICKNESS && ballVX > 0) {
    const paddle = paddles[PLAYER_EAST]!;
    if (paddle.alive && Math.abs(ballY - paddle.position) <= PADDLE_LENGTH_HALF + BALL_RADIUS) {
      reflectOffPaddle(PLAYER_EAST);
    } else if (!paddle.alive) {
      bounceOffDeadWall(PLAYER_EAST);
    } else if (ballX + BALL_RADIUS >= COURT_RIGHT) {
      loseLife(PLAYER_EAST);
      return;
    }
  }
}

function step(): void {
  pollKeyboard();

  // Aggregate paddle inputs and per-controller pause/restart edges.
  let anyPauseEdge = pauseRequested;
  let anyRestartEdge = restartRequested;
  pauseRequested = false;
  restartRequested = false;

  for (let i = 0; i < PLAYER_COUNT; i += 1) {
    const input = pollPaddleInput(i);
    if (input.startPressed && !prevPauseDown[i]) anyPauseEdge = true;
    prevPauseDown[i] = input.startPressed;
    if (input.backPressed && !prevRestartDown[i] && gameOver) anyRestartEdge = true;
    prevRestartDown[i] = input.backPressed;
    const axis = controllerConnected[i] ? input.axis : aiAxisForPaddle(i);
    updatePaddle(i, axis);
  }

  if (anyPauseEdge && !gameOver) paused = !paused;
  if (anyRestartEdge && gameOver) resetMatch();
  if (paused || gameOver) {
    if (shakeTicksRemaining > 0) shakeTicksRemaining -= 1;
    return;
  }

  tickCount += 1;
  updateBall();
  if (shakeTicksRemaining > 0) shakeTicksRemaining -= 1;
}

// ──────────────────────────────────────────────────────────────────────────────
// Rendering.

function fillRoundedRect(brush: bigint, x: number, y: number, w: number, h: number, radius: number): void {
  // Rounded-rect by union of two cross rects + four corner ellipses, painted as
  // a filled path. Cheap, looks great with antialiasing.
  const pathBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreatePath(FillMode.FillModeAlternate, pathBuffer.ptr) !== Status.Ok) return;
  const path = pathBuffer.readBigUInt64LE(0);
  const d = radius * 2;
  Gdiplus.GdipAddPathArc(path, x, y, d, d, 180, 90);
  Gdiplus.GdipAddPathArc(path, x + w - d, y, d, d, 270, 90);
  Gdiplus.GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
  Gdiplus.GdipAddPathArc(path, x, y + h - d, d, d, 90, 90);
  Gdiplus.GdipClosePathFigure(path);
  Gdiplus.GdipFillPath(offscreenGraphics, brush, path);
  Gdiplus.GdipDeletePath(path);
}

function drawPaddle(playerIndex: number): void {
  const paddle = paddles[playerIndex]!;
  const brush = paddle.alive ? playerBrushes[playerIndex]! : veryDimBrush;
  const bounds = paddleBounds(playerIndex);
  if (bounds.axis === 'x') {
    const x = bounds.centerAlong - PADDLE_LENGTH_HALF;
    const y = bounds.fixedCoord - PADDLE_THICKNESS / 2;
    fillRoundedRect(brush, x, y, PADDLE_LENGTH, PADDLE_THICKNESS, 6);
  } else {
    const x = bounds.fixedCoord - PADDLE_THICKNESS / 2;
    const y = bounds.centerAlong - PADDLE_LENGTH_HALF;
    fillRoundedRect(brush, x, y, PADDLE_THICKNESS, PADDLE_LENGTH, 6);
  }
}

function drawBallTrail(): void {
  // Earlier samples are dimmer + smaller. Skip the most recent so the head pops.
  for (let i = 0; i < ballTrail.length - 1; i += 1) {
    const sample = ballTrail[i]!;
    const fade = (i + 1) / ballTrail.length;
    const radius = BALL_RADIUS * (0.35 + 0.5 * fade);
    const alpha = Math.round(220 * fade ** 2);
    const trailBrushBuffer = Buffer.alloc(8);
    if (Gdiplus.GdipCreateSolidFill(((alpha & 0xff) << 24) | 0x00_ff_ff_ff, trailBrushBuffer.ptr) === Status.Ok) {
      const trailBrush = trailBrushBuffer.readBigUInt64LE(0);
      Gdiplus.GdipFillEllipse(offscreenGraphics, trailBrush, sample.x - radius, sample.y - radius, radius * 2, radius * 2);
      Gdiplus.GdipDeleteBrush(trailBrush);
    }
  }
}

function drawString(text: string, font: bigint, format: bigint, brush: bigint, rect: Buffer): void {
  const buffer = encode(text);
  Gdiplus.GdipDrawString(offscreenGraphics, buffer.ptr, -1, font, rect.ptr, format, brush);
}

function drawScoreCorners(): void {
  // Each corner gets a player label, a lives row, and a controller marker.
  // Positions are biased inward from the court boundary, matching the paddle owners.
  const cornerInset = 26;
  const cornerSize = 220;
  const corners: { x: number; y: number; align: bigint; player: number }[] = [
    { x: cornerInset, y: cornerInset, align: stringFormatLeft, player: PLAYER_WEST }, // top-left → west
    { x: WINDOW_WIDTH - cornerInset - cornerSize, y: cornerInset, align: stringFormatRight, player: PLAYER_NORTH }, // top-right → north
    { x: cornerInset, y: WINDOW_HEIGHT - cornerInset - 80, align: stringFormatLeft, player: PLAYER_SOUTH }, // bottom-left → south
    { x: WINDOW_WIDTH - cornerInset - cornerSize, y: WINDOW_HEIGHT - cornerInset - 80, align: stringFormatRight, player: PLAYER_EAST }, // bottom-right → east
  ];
  for (const corner of corners) {
    const paddle = paddles[corner.player]!;
    const label = `${PLAYER_NAMES[corner.player]}  ${'O'.repeat(paddle.lives)}${'.'.repeat(STARTING_LIVES - paddle.lives)}`;
    writeRectF(hudRect, corner.x, corner.y, cornerSize, 28);
    drawString(label, hudFont, corner.align, paddle.alive ? playerBrushes[corner.player]! : dimBrush, hudRect);
    const controllerLabel = controllerConnected[corner.player] ? `pad ${corner.player + 1}` : 'AI';
    writeRectF(hudRect, corner.x, corner.y + 24, cornerSize, 24);
    drawString(controllerLabel, hudFont, corner.align, dimBrush, hudRect);
  }
}

function drawCenterScore(): void {
  // A big translucent live counter in the dead center.
  writeRectF(scoreRect, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  drawString(`${paddles.map((p) => p.lives).join('  ·  ')}`, scoreFont, stringFormatCenter, veryDimBrush, scoreRect);
}

function drawCourt(): void {
  Gdiplus.GdipGraphicsClear(offscreenGraphics, COURT_BG_ARGB);

  // Subtle wall guides — a darker rectangle around the playable court.
  Gdiplus.GdipFillRectangle(offscreenGraphics, wallBrush, 0, 0, WINDOW_WIDTH, COURT_TOP);
  Gdiplus.GdipFillRectangle(offscreenGraphics, wallBrush, 0, COURT_BOTTOM, WINDOW_WIDTH, WINDOW_HEIGHT - COURT_BOTTOM);
  Gdiplus.GdipFillRectangle(offscreenGraphics, wallBrush, 0, COURT_TOP, COURT_LEFT, COURT_HEIGHT);
  Gdiplus.GdipFillRectangle(offscreenGraphics, wallBrush, COURT_RIGHT, COURT_TOP, WINDOW_WIDTH - COURT_RIGHT, COURT_HEIGHT);

  // Faint cross-hair guides through the center, dashed by hand with rectangles.
  const dashLength = 14;
  const gapLength = 18;
  const stride = dashLength + gapLength;
  for (let x = COURT_LEFT; x < COURT_RIGHT; x += stride) {
    Gdiplus.GdipFillRectangle(offscreenGraphics, veryDimBrush, x, COURT_CENTER_Y - 1, dashLength, 2);
  }
  for (let y = COURT_TOP; y < COURT_BOTTOM; y += stride) {
    Gdiplus.GdipFillRectangle(offscreenGraphics, veryDimBrush, COURT_CENTER_X - 1, y, 2, dashLength);
  }

  drawCenterScore();
}

function render(): void {
  drawCourt();

  // Paddles first, then ball trail, then ball on top.
  for (let i = 0; i < PLAYER_COUNT; i += 1) drawPaddle(i);
  drawBallTrail();

  if (!gameOver) {
    Gdiplus.GdipFillEllipse(offscreenGraphics, ballBrush, ballX - BALL_RADIUS, ballY - BALL_RADIUS, BALL_RADIUS * 2, BALL_RADIUS * 2);
  }

  drawScoreCorners();

  // HUD overlays — pause / game over.
  if (paused) {
    drawString('PAUSED', titleFont, stringFormatCenter, whiteBrush, titleRect);
    drawString('press Start or Space to resume', subtitleFont, stringFormatCenter, dimBrush, subtitleRect);
  } else if (gameOver) {
    if (winnerIndex >= 0) {
      drawString(`${PLAYER_NAMES[winnerIndex]} WINS`, titleFont, stringFormatCenter, playerBrushes[winnerIndex]!, titleRect);
    } else {
      drawString('NO WINNER', titleFont, stringFormatCenter, whiteBrush, titleRect);
    }
    drawString('press Back or R to play again', subtitleFont, stringFormatCenter, dimBrush, subtitleRect);
  } else if (tickCount === 0) {
    drawString('SPLITSCREEN PONG', titleFont, stringFormatCenter, whiteBrush, titleRect);
    drawString('plug in up to 4 controllers · empty slots are AI', subtitleFont, stringFormatCenter, dimBrush, subtitleRect);
  }

  Gdiplus.GdipFlush(offscreenGraphics, FlushIntention.FlushIntentionSync);
}

function blitToWindow(hwnd: bigint): void {
  const hdc = User32.GetDC(hwnd);
  if (hdc === 0n) return;
  const hdcGraphicsBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(hdc, hdcGraphicsBuffer.ptr) === Status.Ok) {
    const hdcGraphics = hdcGraphicsBuffer.readBigUInt64LE(0);
    let offsetX = 0;
    let offsetY = 0;
    if (shakeTicksRemaining > 0) {
      const intensity = shakeTicksRemaining / SHAKE_DURATION_TICKS;
      offsetX = Math.round((Math.random() * 2 - 1) * SHAKE_MAGNITUDE * intensity);
      offsetY = Math.round((Math.random() * 2 - 1) * SHAKE_MAGNITUDE * intensity);
    }
    Gdiplus.GdipDrawImageI(hdcGraphics, offscreenBitmap, offsetX, offsetY);
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
      step();
      render();
      blitToWindow(hWnd);
      if (requestedQuit) User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_KEYDOWN && wParam === BigInt(VirtualKey.VK_ESCAPE)) {
      User32.DestroyWindow(hWnd);
      return 0n;
    }
    if (msg === WM_KEYUP || msg === WM_KEYDOWN) return 0n;
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

const className = encode('BunWin32SplitscreenPong');
const windowTitle = encode('Splitscreen Pong — bun-win32');

const wndClassBuf = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuf.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuf.writeBigUInt64LE(BigInt(wndProc.ptr!), 8);
wndClassView.setInt32(16, 0, true);
wndClassView.setInt32(20, 0, true);
wndClassBuf.writeBigUInt64LE(0n, 24);
wndClassBuf.writeBigUInt64LE(0n, 32);
wndClassBuf.writeBigUInt64LE(0n, 40);
wndClassBuf.writeBigUInt64LE(0n, 48);
wndClassBuf.writeBigUInt64LE(0n, 56);
wndClassBuf.writeBigUInt64LE(BigInt(className.ptr), 64);
wndClassBuf.writeBigUInt64LE(0n, 72);

const classAtom = User32.RegisterClassExW(wndClassBuf.ptr);
if (!classAtom) {
  console.error('Failed to register window class');
  process.exit(1);
}

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

const darkModeFlag = Buffer.alloc(4);
darkModeFlag.writeUInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(mainWindow, DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeFlag.ptr, 4);

User32.ShowWindow(mainWindow, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(mainWindow);
User32.SetForegroundWindow(mainWindow);
User32.SetFocus(mainWindow);

// Probe controllers once up front so the intro frame already reports who is in.
for (let i = 0; i < PLAYER_COUNT; i += 1) {
  const probe = Xinput1_4.XInputGetState(i, xinputStateBuffers[i]!.ptr);
  controllerConnected[i] = probe === ERROR_SUCCESS;
}

resetMatch();

console.log();
console.log('  SPLITSCREEN PONG — bun-win32');
console.log('  ─────────────────────────────────────────');
console.log('  Plug in up to 4 Xbox controllers. Empty slots are computer-controlled.');
console.log(`  Detected controllers: ${controllerConnected.map((c, i) => (c ? `pad${i + 1}` : '·')).join(' ')}`);
console.log('  N/S paddles → LX stick.  W/E paddles → LY stick.');
console.log('  Start to pause · Back to restart after game over · ESC to quit.');
console.log(audioReady ? '  Audio:    XAudio2 mastering voice ready (procedural SFX)' : '  Audio:    no audio endpoint — game runs silent');
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

for (const brush of playerBrushes) Gdiplus.GdipDeleteBrush(brush);
Gdiplus.GdipDeleteBrush(wallBrush);
Gdiplus.GdipDeleteBrush(ballBrush);
Gdiplus.GdipDeleteBrush(whiteBrush);
Gdiplus.GdipDeleteBrush(dimBrush);
Gdiplus.GdipDeleteBrush(veryDimBrush);
Gdiplus.GdipDeleteFont(scoreFont);
Gdiplus.GdipDeleteFont(titleFont);
Gdiplus.GdipDeleteFont(subtitleFont);
Gdiplus.GdipDeleteFont(hudFont);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteStringFormat(stringFormatCenter);
Gdiplus.GdipDeleteStringFormat(stringFormatLeft);
Gdiplus.GdipDeleteStringFormat(stringFormatRight);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (audioReady) {
  for (const sfx of [blipSfx, blopSfx, buzzSfx, bingSfx]) {
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

console.log('  Thanks for playing.');
if (gameOver && winnerIndex >= 0) console.log(`  Winner: ${PLAYER_NAMES[winnerIndex]}`);
