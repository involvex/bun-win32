/**
 * FM Synth — a real two-operator FM synthesizer playing through XAudio2, pure FFI
 *
 * Boots a real `IXAudio2` engine through the single `XAudio2Create` flat export,
 * builds a mastering voice and a PCM source voice over the COM vtable, hand-
 * synthesizes a short melody with two-operator frequency modulation + an ADSR
 * envelope straight into a 16-bit buffer, submits it with `SubmitSourceBuffer`,
 * and presses Start. No native addon, no Electron, no WAV file — the audio is
 * generated in JS and handed to the XAudio2 mixer over the vtable. While the
 * melody is audible, `IXAudio2SourceVoice::GetState` is polled and the same
 * samples are painted as a live 24-bit ANSI oscilloscope with a peak VU meter,
 * frame-locked to `SamplesPlayed`.
 *
 * Pipeline (every step after the export is a COM vtable call):
 *
 *   1. XAudio2Create                          — the flat xaudio2_9.dll export
 *   2. IXAudio2::CreateMasteringVoice         — open the default endpoint
 *   3. IXAudio2::CreateSourceVoice            — a 16-bit mono PCM voice
 *   4. (synthesize 2-op FM + ADSR in JS)      — additive FM synth
 *   5. IXAudio2SourceVoice::SubmitSourceBuffer — queue the audio
 *   6. IXAudio2SourceVoice::Start             — it makes sound
 *   7. IXAudio2SourceVoice::GetState          — drive the scope in lock-step
 *   8. DestroyVoice / Release                 — clean teardown
 *
 * APIs demonstrated (Xaudio2_9):
 *   - Xaudio2_9.XAudio2Create                 (bootstrap a real IXAudio2 engine)
 *   - IXAudio2::CreateMasteringVoice / CreateSourceVoice
 *   - IXAudio2SourceVoice::SubmitSourceBuffer / Start / GetState / DestroyVoice
 *   - IXAudio2MasteringVoice::DestroyVoice
 *   - IUnknown::Release                       (release the engine)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/xaudio2_9-fm-synth.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Xaudio2_9, { S_OK, XAUDIO2_USE_DEFAULT_PROCESSOR } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';

// IXAudio2 (IUnknown-derived) vtable slots, xaudio2.h declaration order.
const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATESOURCEVOICE = 5;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;

// IXAudio2Voice base slots (shared by source + mastering voices).
const IXAUDIO2VOICE_DESTROYVOICE = 18;

// IXAudio2SourceVoice slots: 19 base methods, then the source-specific block.
const IXAUDIO2SOURCEVOICE_START = 19;
const IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER = 21;
const IXAUDIO2SOURCEVOICE_GETSTATE = 25;

const XAUDIO2_END_OF_STREAM = 0x0040;
const XAUDIO2_DEFAULT_FREQ_RATIO = 2.0;
const AudioCategory_GameEffects = 6; // AUDIO_STREAM_CATEGORY

const SAMPLE_RATE = 44_100;
const CHANNELS = 1;
const BITS = 16;
const BLOCK_ALIGN = (CHANNELS * BITS) / 8;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound CFunction is memoized per (method, signature)
 * so the GetState poll loop stays cheap.
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
console.log(`${BOLD}${MAGENTA}  ║${RESET}   ${BOLD}FM Synth${RESET} ${DIM}— a real synth playing through xaudio2_9.dll${RESET}${BOLD}${MAGENTA}    ║${RESET}`);
console.log(`${BOLD}${MAGENTA}  ╚══════════════════════════════════════════════════════════════╝${RESET}`);
console.log();

// 1. Create a real IXAudio2 engine.
const ppXAudio2 = Buffer.alloc(8);
const createHr = Xaudio2_9.XAudio2Create(ppXAudio2.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createHr !== S_OK) {
  console.log(`  ${RED}✗${RESET} XAudio2Create → ${hex(createHr)}`);
  restoreConsole();
  process.exit(1);
}
const engine = ppXAudio2.readBigUInt64LE(0);
console.log(`  ${GREEN}✓${RESET} IXAudio2 @ 0x${engine.toString(16)}`);

// 2. Mastering voice on the default endpoint (NULL device id).
const ppMaster = Buffer.alloc(8);
const masterHr = vcall(engine, IXAUDIO2_CREATEMASTERINGVOICE, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32], [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects]);
if (masterHr !== S_OK) {
  console.log(`  ${YELLOW}ℹ${RESET} No audio endpoint here (CreateMasteringVoice → ${hex(masterHr)}).`);
  console.log(`  ${DIM}The binding works; this host just has no playback device.${RESET}`);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  restoreConsole();
  process.exit(0);
}
const master = ppMaster.readBigUInt64LE(0);
console.log(`  ${GREEN}✓${RESET} IXAudio2MasteringVoice @ 0x${master.toString(16)}`);

// 3. Synthesize the melody: two-operator FM (carrier modulated by a sine) with
//    an ADSR envelope. A pentatonic riff that resolves on the root.
const notes = [
  { freq: 293.66, dur: 0.26 }, // D4
  { freq: 349.23, dur: 0.26 }, // F4
  { freq: 392.0, dur: 0.26 }, // G4
  { freq: 440.0, dur: 0.3 }, // A4
  { freq: 523.25, dur: 0.34 }, // C5
  { freq: 440.0, dur: 0.24 }, // A4
  { freq: 392.0, dur: 0.7 }, // G4 (held)
];
const totalSeconds = notes.reduce((sum, n) => sum + n.dur, 0) + 0.2;
const totalSamples = Math.ceil(totalSeconds * SAMPLE_RATE);
const pcm = Buffer.alloc(totalSamples * BLOCK_ALIGN);

const MOD_RATIO = 2.0; // modulator : carrier frequency ratio (bell-ish)
const MOD_INDEX = 4.5; // FM depth — higher = brighter / more sidebands

let cursor = 0;
for (const note of notes) {
  const noteSamples = Math.floor(note.dur * SAMPLE_RATE);
  const attack = noteSamples * 0.02;
  const release = noteSamples * 0.4;
  for (let i = 0; i < noteSamples && cursor < totalSamples; i += 1, cursor += 1) {
    const t = i / SAMPLE_RATE;
    // ADSR-ish envelope: fast attack, sustain, exponential release.
    let env: number;
    if (i < attack) env = i / attack;
    else if (i > noteSamples - release) env = Math.max(0, (noteSamples - i) / release) ** 1.8;
    else env = 0.8;
    // The modulation index itself decays, so the timbre brightens then mellows.
    const modEnv = Math.exp(-3 * t);
    const modulator = Math.sin(2 * Math.PI * note.freq * MOD_RATIO * t);
    const sample = Math.sin(2 * Math.PI * note.freq * t + MOD_INDEX * modEnv * modulator) * env * 0.55;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), cursor * BLOCK_ALIGN);
  }
}

// WAVEFORMATEX (18 bytes; cbSize = 0 for PCM).
const wfx = Buffer.alloc(18);
wfx.writeUInt16LE(1, 0); // WAVE_FORMAT_PCM
wfx.writeUInt16LE(CHANNELS, 2);
wfx.writeUInt32LE(SAMPLE_RATE, 4);
wfx.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 8); // nAvgBytesPerSec
wfx.writeUInt16LE(BLOCK_ALIGN, 12);
wfx.writeUInt16LE(BITS, 14);
wfx.writeUInt16LE(0, 16);

// 4. Source voice (NULL callback / sends / effects).
const ppSource = Buffer.alloc(8);
const srcHr = vcall(engine, IXAUDIO2_CREATESOURCEVOICE, [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.f32, FFIType.ptr, FFIType.ptr, FFIType.ptr], [ppSource.ptr!, wfx.ptr!, 0, XAUDIO2_DEFAULT_FREQ_RATIO, null, null, null]);
if (srcHr !== S_OK) {
  console.log(`  ${RED}✗${RESET} CreateSourceVoice → ${hex(srcHr)}`);
  vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  restoreConsole();
  process.exit(1);
}
const source = ppSource.readBigUInt64LE(0);
console.log(`  ${GREEN}✓${RESET} IXAudio2SourceVoice @ 0x${source.toString(16)}  ${DIM}${(pcm.length / 1024).toFixed(1)} KiB · ${totalSeconds.toFixed(2)} s @ ${SAMPLE_RATE} Hz${RESET}`);

// 5. XAUDIO2_BUFFER (48 bytes on x64): Flags, AudioBytes, pAudioData @8, then
//    PlayBegin/Length, LoopBegin/Length, LoopCount, and pContext @40.
const xbuf = Buffer.alloc(48);
xbuf.writeUInt32LE(XAUDIO2_END_OF_STREAM, 0);
xbuf.writeUInt32LE(pcm.length, 4);
xbuf.writeBigUInt64LE(BigInt(pcm.ptr!), 8); // pAudioData — pcm must outlive playback
const submitHr = vcall(source, IXAUDIO2SOURCEVOICE_SUBMITSOURCEBUFFER, [FFIType.ptr, FFIType.ptr], [xbuf.ptr!, null]);
if (submitHr !== S_OK) {
  console.log(`  ${RED}✗${RESET} SubmitSourceBuffer → ${hex(submitHr)}`);
  vcall(source, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
  vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  restoreConsole();
  process.exit(1);
}

// 6. Start playback.
const startHr = vcall(source, IXAUDIO2SOURCEVOICE_START, [FFIType.u32, FFIType.u32], [0, 0]);
console.log(`  ${startHr === S_OK ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} Start ${DIM}${hex(startHr)}${RESET}`);
console.log();
console.log(`  ${CYAN}♪ now playing${RESET} ${DIM}— scope locked to IXAudio2SourceVoice::GetState${RESET}`);
console.log();
process.stdout.write('\x1b[?25l'); // hide cursor

const SCOPE_WIDTH = 58;
const SCOPE_HALF = 7;
const voiceState = Buffer.alloc(24); // XAUDIO2_VOICE_STATE: ctx@0, BuffersQueued@8, SamplesPlayed@16
let printedRows = 0;

function colorFor(amp: number): string {
  if (amp > 0.66) return RED;
  if (amp > 0.33) return YELLOW;
  return GREEN;
}

while (true) {
  vcall(source, IXAUDIO2SOURCEVOICE_GETSTATE, [FFIType.ptr, FFIType.u32], [voiceState.ptr!, 0], FFIType.void);
  const buffersQueued = voiceState.readUInt32LE(8);
  const samplesPlayed = Number(voiceState.readBigUInt64LE(16));
  const sampleCursor = Math.min(totalSamples - 1, samplesPlayed);

  // Render a window of samples ahead of the play head as a vertical scope.
  const cols: number[] = [];
  let rms = 0;
  for (let x = 0; x < SCOPE_WIDTH; x += 1) {
    const idx = Math.min(totalSamples - 1, sampleCursor + x * 24);
    const v = pcm.readInt16LE(idx * BLOCK_ALIGN) / 32768;
    cols.push(v);
    rms += v * v;
  }
  rms = Math.sqrt(rms / SCOPE_WIDTH);

  const rows: string[] = [];
  for (let r = SCOPE_HALF; r >= -SCOPE_HALF; r -= 1) {
    let line = '';
    for (let x = 0; x < SCOPE_WIDTH; x += 1) {
      const cell = Math.round(cols[x] * SCOPE_HALF);
      if (r === 0) line += cols[x] === 0 ? `${DIM}·${RESET}` : `${colorFor(Math.abs(cols[x]))}─${RESET}`;
      else if ((r > 0 && cell >= r) || (r < 0 && cell <= r)) line += `${colorFor(Math.abs(cols[x]))}█${RESET}`;
      else line += ' ';
    }
    rows.push(`  ${DIM}│${RESET}${line}${DIM}│${RESET}`);
  }

  const elapsed = (samplesPlayed / SAMPLE_RATE).toFixed(2);
  const vuFill = Math.min(28, Math.round(rms * 5 * 28));
  const vu = `${colorFor(rms * 3)}${'▇'.repeat(vuFill)}${RESET}${DIM}${'·'.repeat(28 - vuFill)}${RESET}`;
  rows.push(`  ${DIM}└${'─'.repeat(SCOPE_WIDTH)}┘${RESET}`);
  rows.push(`  ${CYAN}t${RESET} ${elapsed}s ${DIM}/ ${totalSeconds.toFixed(2)}s${RESET}   ${CYAN}VU${RESET} [${vu}]`);

  if (printedRows > 0) process.stdout.write(`\x1b[${printedRows}A`);
  process.stdout.write(rows.map((l) => `${l}\x1b[K`).join('\n') + '\n');
  printedRows = rows.length;

  // The END_OF_STREAM buffer leaves the queue when the last sample is mixed.
  if (buffersQueued === 0 || samplesPlayed >= totalSamples) break;
  Bun.sleepSync(30);
}

process.stdout.write('\x1b[?25h'); // show cursor
console.log();
console.log(`  ${GREEN}${BOLD}Done.${RESET} ${DIM}Synthesized in JS, mixed by xaudio2_9.dll, released cleanly.${RESET}`);
console.log();

// 7. Teardown — voices use DestroyVoice (not IUnknown); the engine uses Release.
vcall(source, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);
restoreConsole();
