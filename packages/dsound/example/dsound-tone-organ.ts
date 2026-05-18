/**
 * Tone Organ — a real synthesizer that actually plays sound, over pure FFI
 *
 * Boots a real `IDirectSound8` device on the default playback adapter through
 * the single `DirectSoundCreate8` flat export, hand-synthesizes a short musical
 * phrase (additive sine partials shaped by an ADSR envelope) straight into a
 * locked DirectSound secondary buffer, and presses Play. No native addon, no
 * Electron, no WAV file — the PCM is generated in JS and handed to the audio
 * hardware over the COM vtable. While the phrase is audible, the play cursor is
 * polled and the same samples are painted as a live 24-bit ANSI oscilloscope
 * with a peak-tracking VU meter, so the picture is frame-locked to the sound.
 *
 * Pipeline (every step after the export is a COM vtable call):
 *
 *   1. DirectSoundCreate8                  — the flat dsound.dll export
 *   2. IDirectSound8::SetCooperativeLevel  — bind to a window (the desktop)
 *   3. IDirectSound8::CreateSoundBuffer    — allocate a PCM secondary buffer
 *   4. IDirectSoundBuffer::Lock            — get the raw mix memory
 *   5. (write synthesized 16-bit PCM)      — additive synth + ADSR in JS
 *   6. IDirectSoundBuffer::Unlock          — commit the audio
 *   7. IDirectSoundBuffer::Play            — it makes sound
 *   8. IDirectSoundBuffer::GetCurrentPosition — drive the scope in lock-step
 *   9. Stop / Release                      — clean teardown
 *
 * APIs demonstrated (DSound):
 *   - DSound.DirectSoundCreate8            (bootstrap a real IDirectSound8)
 *   - IDirectSound8::SetCooperativeLevel / CreateSoundBuffer
 *   - IDirectSoundBuffer::Lock / Unlock / Play / Stop / GetCurrentPosition
 *   - IUnknown::Release                    (release every COM object)
 *
 * APIs demonstrated (User32, cross-package):
 *   - GetDesktopWindow                     (a valid HWND for cooperative level)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/dsound-tone-organ.ts
 */

import { CFunction, FFIType, type Pointer, read, toArrayBuffer } from 'bun:ffi';

import DSound, { DSBCAPS, DSBLOCK, DSBSTATUS, DSSCL, DS_OK } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';
import User32 from '@bun-win32/user32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';

// IDirectSound8 / IDirectSoundBuffer vtable slots (dsound.h declaration order).
const IUNKNOWN_RELEASE = 2;
const IDIRECTSOUND8_SETCOOPERATIVELEVEL = 6;
const IDIRECTSOUND8_CREATESOUNDBUFFER = 3;
const IDIRECTSOUNDBUFFER_LOCK = 11;
const IDIRECTSOUNDBUFFER_PLAY = 12;
const IDIRECTSOUNDBUFFER_STOP = 18;
const IDIRECTSOUNDBUFFER_UNLOCK = 19;
const IDIRECTSOUNDBUFFER_GETCURRENTPOSITION = 4;
const IDIRECTSOUNDBUFFER_GETSTATUS = 9;

const SAMPLE_RATE = 44_100;
const CHANNELS = 1;
const BITS = 16;
const BLOCK_ALIGN = (CHANNELS * BITS) / 8;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound CFunction is memoized per (method, signature)
 * so the GetCurrentPosition poll loop stays cheap. Every method used here
 * returns a 32-bit HRESULT (Release returns a ULONG refcount).
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

const liveObjects: bigint[] = [];

function releaseAll(): void {
  for (const obj of liveObjects.reverse()) vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  liveObjects.length = 0;
}

// Enable ANSI escape processing so colors render in Windows Terminal / VS Code.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr!)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

function restoreConsole(): void {
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
}

console.log();
console.log(`${BOLD}${MAGENTA}  ╔══════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${MAGENTA}  ║${RESET}   ${BOLD}Tone Organ${RESET} ${DIM}— a real synth playing through dsound.dll${RESET}${BOLD}${MAGENTA}      ║${RESET}`);
console.log(`${BOLD}${MAGENTA}  ╚══════════════════════════════════════════════════════════════╝${RESET}`);
console.log();

// 1. Create a real IDirectSound8 device on the default playback adapter.
const ppDS8 = Buffer.alloc(8);
const createHr = DSound.DirectSoundCreate8(null, ppDS8.ptr!, null);
if (createHr !== DS_OK) {
  console.log(`  ${YELLOW}ℹ${RESET} No DirectSound playback device available here (DirectSoundCreate8 → ${hex(createHr)}).`);
  console.log(`  ${DIM}The binding works; this host just has no audio endpoint to drive.${RESET}`);
  console.log();
  restoreConsole();
  process.exit(0);
}
const device = ppDS8.readBigUInt64LE(0);
liveObjects.push(device);
console.log(`  ${GREEN}✓${RESET} IDirectSound8 @ 0x${device.toString(16)}`);

// 2. Cooperative level. The desktop window is always a valid HWND, even under
//    ConPTY terminals where GetConsoleWindow() would return NULL.
const desktop = User32.GetDesktopWindow();
const coopHr = vcall(device, IDIRECTSOUND8_SETCOOPERATIVELEVEL, [FFIType.u64, FFIType.u32], [desktop, DSSCL.DSSCL_PRIORITY]);
console.log(`  ${coopHr === DS_OK ? `${GREEN}✓${RESET}` : `${YELLOW}•${RESET}`} SetCooperativeLevel(desktop, DSSCL_PRIORITY) ${DIM}${hex(coopHr)}${RESET}`);

// 3. Synthesize the phrase: a little arpeggio with additive partials + ADSR.
const notes = [
  { freq: 261.63, dur: 0.28 }, // C4
  { freq: 329.63, dur: 0.28 }, // E4
  { freq: 392.0, dur: 0.28 }, // G4
  { freq: 523.25, dur: 0.34 }, // C5
  { freq: 392.0, dur: 0.22 }, // G4
  { freq: 523.25, dur: 0.7 }, // C5 (held)
];
const totalSeconds = notes.reduce((s, n) => s + n.dur, 0) + 0.15;
const totalSamples = Math.ceil(totalSeconds * SAMPLE_RATE);
const pcm = new Int16Array(totalSamples);

const partials = [
  { mult: 1, gain: 1.0 },
  { mult: 2, gain: 0.32 },
  { mult: 3, gain: 0.14 },
  { mult: 4, gain: 0.06 },
];

let cursor = 0;
for (const note of notes) {
  const noteSamples = Math.floor(note.dur * SAMPLE_RATE);
  const attack = noteSamples * 0.04;
  const release = noteSamples * 0.35;
  for (let i = 0; i < noteSamples && cursor < totalSamples; i += 1, cursor += 1) {
    const t = i / SAMPLE_RATE;
    // ADSR-ish envelope: linear attack, gentle decay, exponential release.
    let env = 1;
    if (i < attack) env = i / attack;
    else if (i > noteSamples - release) env = Math.max(0, (noteSamples - i) / release) ** 1.5;
    else env = 0.85;
    let sample = 0;
    for (const p of partials) sample += p.gain * Math.sin(2 * Math.PI * note.freq * p.mult * t);
    sample = (sample / 1.52) * env * 0.6;
    pcm[cursor] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
}

const bufferBytes = totalSamples * BLOCK_ALIGN;

// WAVEFORMATEX (18 bytes; cbSize = 0 for PCM).
const wfx = Buffer.alloc(18);
wfx.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
wfx.writeUInt16LE(CHANNELS, 2);
wfx.writeUInt32LE(SAMPLE_RATE, 4);
wfx.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 8);
wfx.writeUInt16LE(BLOCK_ALIGN, 12);
wfx.writeUInt16LE(BITS, 14);
wfx.writeUInt16LE(0, 16);

// DSBUFFERDESC (40 bytes on x64: 4 DWORDs, an 8-byte aligned pointer, a GUID).
const dsbd = Buffer.alloc(40);
dsbd.writeUInt32LE(40, 0); // dwSize
dsbd.writeUInt32LE(DSBCAPS.DSBCAPS_GLOBALFOCUS | DSBCAPS.DSBCAPS_CTRLVOLUME | DSBCAPS.DSBCAPS_GETCURRENTPOSITION2, 4);
dsbd.writeUInt32LE(bufferBytes, 8); // dwBufferBytes
dsbd.writeUInt32LE(0, 12); // dwReserved
dsbd.writeBigUInt64LE(BigInt(wfx.ptr!), 16); // lpwfxFormat
// guid3DAlgorithm @24..40 stays GUID_NULL (zeroed).

// 4. Create the secondary buffer.
const ppBuffer = Buffer.alloc(8);
const cbHr = vcall(device, IDIRECTSOUND8_CREATESOUNDBUFFER, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [dsbd.ptr!, ppBuffer.ptr!, null]);
if (cbHr !== DS_OK) {
  console.log(`  ${RED}✗${RESET} CreateSoundBuffer ${hex(cbHr)}`);
  releaseAll();
  restoreConsole();
  process.exit(1);
}
const soundBuffer = ppBuffer.readBigUInt64LE(0);
liveObjects.push(soundBuffer);
console.log(`  ${GREEN}✓${RESET} IDirectSoundBuffer @ 0x${soundBuffer.toString(16)}  ${DIM}${(bufferBytes / 1024).toFixed(1)} KiB · ${totalSeconds.toFixed(2)} s @ ${SAMPLE_RATE} Hz${RESET}`);

// 5. Lock, write the PCM straight into the mix memory, unlock.
const audioPtr1 = Buffer.alloc(8);
const audioBytes1 = Buffer.alloc(4);
const lockHr = vcall(soundBuffer, IDIRECTSOUNDBUFFER_LOCK, [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], [0, 0, audioPtr1.ptr!, audioBytes1.ptr!, null, null, DSBLOCK.DSBLOCK_ENTIREBUFFER]);
if (lockHr !== DS_OK) {
  console.log(`  ${RED}✗${RESET} Lock ${hex(lockHr)}`);
  releaseAll();
  restoreConsole();
  process.exit(1);
}
const mixPtr = read.ptr(audioPtr1.ptr!) as Pointer;
const mixLen = audioBytes1.readUInt32LE(0);
const mix = new Int16Array(toArrayBuffer(mixPtr, 0, mixLen));
mix.set(pcm.subarray(0, mix.length));
vcall(soundBuffer, IDIRECTSOUNDBUFFER_UNLOCK, [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], [mixPtr, mixLen, null, 0]);
console.log(`  ${GREEN}✓${RESET} ${mixLen} bytes of synthesized PCM committed to the device`);
console.log();

// 6. Play (one-shot) and drive the scope from the real play cursor.
const SCOPE_WIDTH = 58;
const SCOPE_HALF = 7; // rows above/below the zero line
const playHr = vcall(soundBuffer, IDIRECTSOUNDBUFFER_PLAY, [FFIType.u32, FFIType.u32, FFIType.u32], [0, 0, 0]);
if (playHr !== DS_OK) {
  console.log(`  ${RED}✗${RESET} Play ${hex(playHr)}`);
  releaseAll();
  restoreConsole();
  process.exit(1);
}

console.log(`  ${CYAN}♪ now playing${RESET} ${DIM}— scope locked to the DirectSound play cursor${RESET}`);
console.log();
process.stdout.write('\x1b[?25l'); // hide cursor

const playPos = Buffer.alloc(4);
const writePos = Buffer.alloc(4);
const statusBuf = Buffer.alloc(4);
let printedRows = 0;

function colorFor(amp: number): string {
  if (amp > 0.66) return RED;
  if (amp > 0.33) return YELLOW;
  return GREEN;
}

const startedAt = performance.now();
while (true) {
  const wallSeconds = (performance.now() - startedAt) / 1000;

  // The hardware play cursor drives the scope position; wall-clock time
  // (which the audio also plays in) is the authoritative end condition,
  // since a one-shot buffer's cursor snaps back to 0 once it finishes.
  const posHr = vcall(soundBuffer, IDIRECTSOUNDBUFFER_GETCURRENTPOSITION, [FFIType.ptr, FFIType.ptr], [playPos.ptr!, writePos.ptr!]);
  if (posHr !== DS_OK) break;
  const byteCursor = playPos.readUInt32LE(0);
  const sampleCursor = Math.floor(byteCursor / BLOCK_ALIGN);

  const statusHr = vcall(soundBuffer, IDIRECTSOUNDBUFFER_GETSTATUS, [FFIType.ptr], [statusBuf.ptr!]);
  const playing = statusHr === DS_OK && (statusBuf.readUInt32LE(0) & DSBSTATUS.DSBSTATUS_PLAYING) !== 0;

  // Render a window of samples around the cursor as a vertical scope.
  const window = SCOPE_WIDTH;
  const cols: number[] = [];
  let rms = 0;
  for (let x = 0; x < window; x += 1) {
    const idx = Math.min(totalSamples - 1, sampleCursor + Math.floor((x / window) * window * 24));
    const v = pcm[idx] / 32768;
    cols.push(v);
    rms += v * v;
  }
  rms = Math.sqrt(rms / window);

  const rows: string[] = [];
  for (let r = SCOPE_HALF; r >= -SCOPE_HALF; r -= 1) {
    let line = '';
    for (let x = 0; x < window; x += 1) {
      const cell = Math.round(cols[x] * SCOPE_HALF);
      if (r === 0) line += cols[x] === 0 ? `${DIM}·${RESET}` : `${colorFor(Math.abs(cols[x]))}─${RESET}`;
      else if ((r > 0 && cell >= r) || (r < 0 && cell <= r)) line += `${colorFor(Math.abs(cols[x]))}█${RESET}`;
      else line += ' ';
    }
    rows.push(`  ${DIM}│${RESET}${line}${DIM}│${RESET}`);
  }

  const elapsed = Math.min(wallSeconds, totalSeconds).toFixed(2);
  const vuFill = Math.min(28, Math.round(rms * 5 * 28));
  const vu = `${colorFor(rms * 3)}${'▇'.repeat(vuFill)}${RESET}${DIM}${'·'.repeat(28 - vuFill)}${RESET}`;
  rows.push(`  ${DIM}└${'─'.repeat(window)}┘${RESET}`);
  rows.push(`  ${CYAN}t${RESET} ${elapsed}s ${DIM}/ ${totalSeconds.toFixed(2)}s${RESET}   ${CYAN}VU${RESET} [${vu}]`);

  if (printedRows > 0) process.stdout.write(`\x1b[${printedRows}A`);
  process.stdout.write(rows.map((l) => `${l}\x1b[K`).join('\n') + '\n');
  printedRows = rows.length;

  if (wallSeconds >= totalSeconds) break;
  if (wallSeconds > 0.3 && !playing) break;
  Bun.sleepSync(30);
}

vcall(soundBuffer, IDIRECTSOUNDBUFFER_STOP, [], []);
process.stdout.write('\x1b[?25h'); // show cursor
console.log();
console.log(`  ${GREEN}${BOLD}Done.${RESET} ${DIM}Synthesized in JS, mixed by dsound.dll, released cleanly.${RESET}`);
console.log();

releaseAll();
restoreConsole();
