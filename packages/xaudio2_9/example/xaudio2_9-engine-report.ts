/**
 * XAudio2 Engine Report — an exhaustive audio-engine diagnostic, pure FFI
 *
 * Boots a real `IXAudio2` engine and a mastering voice through the flat
 * `XAudio2Create` export + the COM vtable, then produces a fully-formatted
 * report covering four areas with no audio ever played:
 *
 *   1. Engine & mastering voice — interface/vtable pointers, voice details
 *      (creation/active flags, channels, sample rate) and the decoded output
 *      channel mask from IXAudio2MasteringVoice::GetChannelMask.
 *   2. Performance — every field of XAUDIO2_PERFORMANCE_DATA: audio vs total
 *      CPU cycles, per-quantum min/max, heap usage, latency (samples → ms),
 *      glitches, and the live voice/resampler/matrix-mix census.
 *   3. X3DAudio positional solve — X3DAudioInitialize for a stereo bed, then
 *      X3DAudioCalculate for a moving mono emitter past a listener: the
 *      resulting L/R matrix gains, per-channel delays, LPF coefficient,
 *      Doppler factor, distance, and emitter-to-listener angle.
 *   4. Built-in XAPO effects — instantiate every in-box effect over its real
 *      COM interface: CreateAudioVolumeMeter, CreateAudioReverb, and CreateFX
 *      for FXEQ / FXMasteringLimiter / FXReverb / FXEcho.
 *
 * APIs demonstrated (Xaudio2_9):
 *   - Xaudio2_9.XAudio2Create              (real IXAudio2 engine)
 *   - Xaudio2_9.X3DAudioInitialize         (speaker bed for positional audio)
 *   - Xaudio2_9.X3DAudioCalculate          (3D matrix / Doppler / LPF solve)
 *   - Xaudio2_9.CreateAudioVolumeMeter     (built-in volume-meter XAPO)
 *   - Xaudio2_9.CreateAudioReverb          (built-in reverb XAPO)
 *   - Xaudio2_9.CreateFX                   (FXEQ / FXMasteringLimiter / FXReverb / FXEcho)
 *   - IXAudio2::CreateMasteringVoice / GetPerformanceData / Release
 *   - IXAudio2MasteringVoice::GetVoiceDetails / GetChannelMask / DestroyVoice
 *   - IUnknown::Release                    (release every XAPO + the engine)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/xaudio2_9-engine-report.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Xaudio2_9, { CLSID_FXEcho, CLSID_FXEQ, CLSID_FXMasteringLimiter, CLSID_FXReverb, S_OK, SPEAKER, X3DAUDIO_CALCULATE, X3DAUDIO_HANDLE_BYTESIZE, X3DAUDIO_SPEED_OF_SOUND, XAUDIO2_USE_DEFAULT_PROCESSOR } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';

const IUNKNOWN_RELEASE = 2;
const IXAUDIO2_CREATEMASTERINGVOICE = 7;
const IXAUDIO2_GETPERFORMANCEDATA = 11;
const IXAUDIO2VOICE_GETVOICEDETAILS = 0;
const IXAUDIO2VOICE_DESTROYVOICE = 18;
const IXAUDIO2MASTERINGVOICE_GETCHANNELMASK = 19;

const AudioCategory_GameEffects = 6;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const invokers = new Map<string, ReturnType<typeof CFunction>>();

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

// Standard WAVEFORMATEXTENSIBLE channel-mask bits, for decoding GetChannelMask.
const SPEAKER_BITS: [number, string][] = [
  [0x1, 'FL'],
  [0x2, 'FR'],
  [0x4, 'FC'],
  [0x8, 'LFE'],
  [0x10, 'BL'],
  [0x20, 'BR'],
  [0x40, 'FLC'],
  [0x80, 'FRC'],
  [0x100, 'BC'],
  [0x200, 'SL'],
  [0x400, 'SR'],
];

function decodeSpeakers(mask: number): string {
  const names = SPEAKER_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join(' · ') : '(none)';
}

/** Parse a registry-format GUID string into its 16-byte binary layout. */
function guidBuffer(guid: string): Buffer {
  const clean = guid.replace(/[{}-]/g, '');
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(clean.slice(0, 8), 16), 0); // Data1 (LE)
  bytes.writeUInt16LE(parseInt(clean.slice(8, 12), 16), 4); // Data2 (LE)
  bytes.writeUInt16LE(parseInt(clean.slice(12, 16), 16), 6); // Data3 (LE)
  for (let i = 0; i < 8; i += 1) bytes[8 + i] = parseInt(clean.slice(16 + i * 2, 18 + i * 2), 16); // Data4 (BE)
  return bytes;
}

const pad = (label: string, width = 30): string => (label + ' ').padEnd(width, '·');
const f3 = (n: number): string => n.toFixed(3);

// Enable ANSI escape processing.
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

function header(title: string): void {
  console.log();
  console.log(`${BOLD}${BLUE}  ┌─ ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}┐${RESET}`);
}

console.log();
console.log(`${BOLD}${MAGENTA}  ╔══════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${MAGENTA}  ║${RESET}   ${BOLD}XAudio2 Engine Report${RESET} ${DIM}— full diagnostic over pure FFI${RESET}${BOLD}${MAGENTA}      ║${RESET}`);
console.log(`${BOLD}${MAGENTA}  ╚══════════════════════════════════════════════════════════════╝${RESET}`);

// ── 1. Engine & mastering voice ────────────────────────────────────────────
header('Engine & Mastering Voice');
const ppXAudio2 = Buffer.alloc(8);
const createHr = Xaudio2_9.XAudio2Create(ppXAudio2.ptr!, 0, XAUDIO2_USE_DEFAULT_PROCESSOR);
if (createHr !== S_OK) {
  console.log(`  ${RED}✗${RESET} XAudio2Create → ${hex(createHr)}`);
  restoreConsole();
  process.exit(1);
}
const engine = ppXAudio2.readBigUInt64LE(0);
const engineVtable = read.u64(Number(engine) as Pointer, 0);
console.log(`  ${GREEN}✓${RESET} ${pad('IXAudio2')} 0x${engine.toString(16)}`);
console.log(`  ${GREEN}✓${RESET} ${pad('  └ vtable')} 0x${BigInt(engineVtable).toString(16)}`);

const ppMaster = Buffer.alloc(8);
const masterHr = vcall(engine, IXAUDIO2_CREATEMASTERINGVOICE, [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.i32], [ppMaster.ptr!, 0, 0, 0, null, null, AudioCategory_GameEffects]);
let master = 0n;
if (masterHr !== S_OK) {
  console.log(`  ${YELLOW}ℹ${RESET} CreateMasteringVoice → ${hex(masterHr)} ${DIM}(no playback endpoint; engine still valid)${RESET}`);
} else {
  master = ppMaster.readBigUInt64LE(0);
  console.log(`  ${GREEN}✓${RESET} ${pad('IXAudio2MasteringVoice')} 0x${master.toString(16)}`);

  const details = Buffer.alloc(16); // XAUDIO2_VOICE_DETAILS
  vcall(master, IXAUDIO2VOICE_GETVOICEDETAILS, [FFIType.ptr], [details.ptr!], FFIType.void);
  console.log(`  ${DIM}·${RESET} ${pad('  CreationFlags')} ${hex(details.readUInt32LE(0))}`);
  console.log(`  ${DIM}·${RESET} ${pad('  ActiveFlags')} ${hex(details.readUInt32LE(4))}`);
  console.log(`  ${DIM}·${RESET} ${pad('  InputChannels')} ${details.readUInt32LE(8)}`);
  console.log(`  ${DIM}·${RESET} ${pad('  InputSampleRate')} ${details.readUInt32LE(12).toLocaleString()} Hz`);

  const maskBuf = Buffer.alloc(4);
  const maskHr = vcall(master, IXAUDIO2MASTERINGVOICE_GETCHANNELMASK, [FFIType.ptr], [maskBuf.ptr!]);
  if (maskHr === S_OK) {
    const mask = maskBuf.readUInt32LE(0);
    console.log(`  ${DIM}·${RESET} ${pad('  ChannelMask')} ${hex(mask)}  ${CYAN}${decodeSpeakers(mask)}${RESET}`);
  }
}

// ── 2. Performance data ────────────────────────────────────────────────────
header('Performance (XAUDIO2_PERFORMANCE_DATA)');
const perf = Buffer.alloc(64);
vcall(engine, IXAUDIO2_GETPERFORMANCEDATA, [FFIType.ptr], [perf.ptr!], FFIType.void);
const audioCycles = perf.readBigUInt64LE(0);
const totalCycles = perf.readBigUInt64LE(8);
const cpuPct = totalCycles > 0n ? (Number(audioCycles) / Number(totalCycles)) * 100 : 0;
const latencySamples = perf.readUInt32LE(28);
console.log(`  ${DIM}·${RESET} ${pad('AudioCyclesSinceLastQuery')} ${audioCycles.toLocaleString()}`);
console.log(`  ${DIM}·${RESET} ${pad('TotalCyclesSinceLastQuery')} ${totalCycles.toLocaleString()}`);
console.log(`  ${DIM}·${RESET} ${pad('  → audio CPU share')} ${cpuPct.toFixed(3)} %`);
console.log(`  ${DIM}·${RESET} ${pad('MinimumCyclesPerQuantum')} ${perf.readUInt32LE(16).toLocaleString()}`);
console.log(`  ${DIM}·${RESET} ${pad('MaximumCyclesPerQuantum')} ${perf.readUInt32LE(20).toLocaleString()}`);
console.log(`  ${DIM}·${RESET} ${pad('MemoryUsageInBytes')} ${(perf.readUInt32LE(24) / 1024).toFixed(1)} KiB`);
console.log(`  ${DIM}·${RESET} ${pad('CurrentLatencyInSamples')} ${latencySamples} ${DIM}(≈ ${((latencySamples / 48000) * 1000).toFixed(2)} ms @ 48 kHz)${RESET}`);
console.log(`  ${DIM}·${RESET} ${pad('GlitchesSinceEngineStarted')} ${perf.readUInt32LE(32)}`);
console.log(`  ${DIM}·${RESET} ${pad('ActiveSourceVoiceCount')} ${perf.readUInt32LE(36)}`);
console.log(`  ${DIM}·${RESET} ${pad('TotalSourceVoiceCount')} ${perf.readUInt32LE(40)}`);
console.log(`  ${DIM}·${RESET} ${pad('ActiveSubmixVoiceCount')} ${perf.readUInt32LE(44)}`);
console.log(`  ${DIM}·${RESET} ${pad('ActiveResamplerCount')} ${perf.readUInt32LE(48)}`);
console.log(`  ${DIM}·${RESET} ${pad('ActiveMatrixMixCount')} ${perf.readUInt32LE(52)}`);

// ── 3. X3DAudio positional solve ───────────────────────────────────────────
header('X3DAudio Positional Solve (1 → 2 ch)');
const x3dHandle = Buffer.alloc(X3DAUDIO_HANDLE_BYTESIZE);
const x3dHr = Xaudio2_9.X3DAudioInitialize(SPEAKER.SPEAKER_STEREO, X3DAUDIO_SPEED_OF_SOUND, x3dHandle.ptr!);
console.log(`  ${x3dHr === S_OK ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} X3DAudioInitialize(SPEAKER_STEREO, ${X3DAUDIO_SPEED_OF_SOUND} m/s) ${DIM}${hex(x3dHr)}${RESET}`);

// X3DAUDIO_LISTENER (56 bytes, #pragma pack(1)): at the origin, facing +Z, still.
const listener = Buffer.alloc(56);
listener.writeFloatLE(0, 0); // OrientFront = (0,0,1)
listener.writeFloatLE(0, 4);
listener.writeFloatLE(1, 8);
listener.writeFloatLE(0, 12); // OrientTop = (0,1,0)
listener.writeFloatLE(1, 16);
listener.writeFloatLE(0, 20);
// Position (24) + Velocity (36) stay (0,0,0); pCone (48) stays NULL.

// X3DAUDIO_EMITTER (128 bytes, #pragma pack(1)): a mono source 3 m to the
// right and 5 m ahead, rushing toward the listener at 8 m/s (Doppler).
const emitter = Buffer.alloc(128);
// pCone @0 = NULL
emitter.writeFloatLE(0, 8); // OrientFront = (0,0,1)
emitter.writeFloatLE(0, 12);
emitter.writeFloatLE(1, 16);
emitter.writeFloatLE(0, 20); // OrientTop = (0,1,0)
emitter.writeFloatLE(1, 24);
emitter.writeFloatLE(0, 28);
emitter.writeFloatLE(3, 32); // Position = (3, 0, 5)
emitter.writeFloatLE(0, 36);
emitter.writeFloatLE(5, 40);
emitter.writeFloatLE(0, 44); // Velocity = (0, 0, -8)  → approaching
emitter.writeFloatLE(0, 48);
emitter.writeFloatLE(-8, 52);
// InnerRadius @56 = 0, InnerRadiusAngle @60 = 0
emitter.writeUInt32LE(1, 64); // ChannelCount = 1 (mono)
// ChannelRadius @68 = 0, pChannelAzimuths @72 = NULL, all curve ptrs NULL
emitter.writeFloatLE(1, 120); // CurveDistanceScaler = 1.0
emitter.writeFloatLE(1, 124); // DopplerScaler = 1.0

const matrix = Buffer.alloc(2 * 4); // SrcChannelCount(1) * DstChannelCount(2)
const delays = Buffer.alloc(2 * 4); // DstChannelCount(2) delay times (ms)

// X3DAUDIO_DSP_SETTINGS (56 bytes, #pragma pack(1)).
const dsp = Buffer.alloc(56);
dsp.writeBigUInt64LE(BigInt(matrix.ptr!), 0); // pMatrixCoefficients
dsp.writeBigUInt64LE(BigInt(delays.ptr!), 8); // pDelayTimes
dsp.writeUInt32LE(1, 16); // SrcChannelCount
dsp.writeUInt32LE(2, 20); // DstChannelCount

const calcFlags =
  X3DAUDIO_CALCULATE.X3DAUDIO_CALCULATE_MATRIX |
  X3DAUDIO_CALCULATE.X3DAUDIO_CALCULATE_DELAY |
  X3DAUDIO_CALCULATE.X3DAUDIO_CALCULATE_LPF_DIRECT |
  X3DAUDIO_CALCULATE.X3DAUDIO_CALCULATE_DOPPLER |
  X3DAUDIO_CALCULATE.X3DAUDIO_CALCULATE_EMITTER_ANGLE;
Xaudio2_9.X3DAudioCalculate(x3dHandle.ptr!, listener.ptr!, emitter.ptr!, calcFlags, dsp.ptr!);

console.log(`  ${DIM}·${RESET} ${pad('Matrix L / R gain')} ${f3(matrix.readFloatLE(0))}  /  ${f3(matrix.readFloatLE(4))}`);
console.log(`  ${DIM}·${RESET} ${pad('Delay L / R')} ${f3(delays.readFloatLE(0))} ms  /  ${f3(delays.readFloatLE(4))} ms`);
console.log(`  ${DIM}·${RESET} ${pad('LPFDirectCoefficient')} ${f3(dsp.readFloatLE(24))}`);
console.log(`  ${DIM}·${RESET} ${pad('ReverbLevel')} ${f3(dsp.readFloatLE(32))}`);
console.log(`  ${DIM}·${RESET} ${pad('DopplerFactor')} ${CYAN}${f3(dsp.readFloatLE(36))}${RESET} ${DIM}(>1 ⇒ pitched up, approaching)${RESET}`);
console.log(`  ${DIM}·${RESET} ${pad('EmitterToListenerAngle')} ${f3(dsp.readFloatLE(40))} rad`);
console.log(`  ${DIM}·${RESET} ${pad('EmitterToListenerDistance')} ${f3(dsp.readFloatLE(44))} units`);
console.log(`  ${DIM}·${RESET} ${pad('EmitterVelocityComponent')} ${f3(dsp.readFloatLE(48))} u/s`);

// ── 4. Built-in XAPO effects ───────────────────────────────────────────────
header('Built-in XAPO Effects');
type Apo = { name: string; make: () => number; pp: Buffer };
const ppMeter = Buffer.alloc(8);
const ppReverb = Buffer.alloc(8);
const ppEq = Buffer.alloc(8);
const ppLimiter = Buffer.alloc(8);
const ppFxReverb = Buffer.alloc(8);
const ppEcho = Buffer.alloc(8);
const apos: Apo[] = [
  { name: 'CreateAudioVolumeMeter', make: () => Xaudio2_9.CreateAudioVolumeMeter(ppMeter.ptr!), pp: ppMeter },
  { name: 'CreateAudioReverb', make: () => Xaudio2_9.CreateAudioReverb(ppReverb.ptr!), pp: ppReverb },
  { name: 'CreateFX · FXEQ', make: () => Xaudio2_9.CreateFX(guidBuffer(CLSID_FXEQ).ptr!, ppEq.ptr!, null, 0), pp: ppEq },
  { name: 'CreateFX · FXMasteringLimiter', make: () => Xaudio2_9.CreateFX(guidBuffer(CLSID_FXMasteringLimiter).ptr!, ppLimiter.ptr!, null, 0), pp: ppLimiter },
  { name: 'CreateFX · FXReverb', make: () => Xaudio2_9.CreateFX(guidBuffer(CLSID_FXReverb).ptr!, ppFxReverb.ptr!, null, 0), pp: ppFxReverb },
  { name: 'CreateFX · FXEcho', make: () => Xaudio2_9.CreateFX(guidBuffer(CLSID_FXEcho).ptr!, ppEcho.ptr!, null, 0), pp: ppEcho },
];
for (const apo of apos) {
  const hr = apo.make();
  if (hr === S_OK) {
    const obj = apo.pp.readBigUInt64LE(0);
    console.log(`  ${GREEN}✓${RESET} ${pad(apo.name, 32)} IUnknown @ 0x${obj.toString(16)}`);
    vcall(obj, IUNKNOWN_RELEASE, [], [], FFIType.u32); // release the XAPO immediately
  } else {
    console.log(`  ${RED}✗${RESET} ${pad(apo.name, 32)} ${hex(hr)}`);
  }
}

// ── Teardown ───────────────────────────────────────────────────────────────
if (master !== 0n) vcall(master, IXAUDIO2VOICE_DESTROYVOICE, [], [], FFIType.void);
vcall(engine, IUNKNOWN_RELEASE, [], [], FFIType.u32);

console.log();
console.log(`  ${GREEN}${BOLD}Report complete.${RESET} ${DIM}Engine, voices, X3DAudio, and every XAPO released cleanly.${RESET}`);
console.log();
restoreConsole();
