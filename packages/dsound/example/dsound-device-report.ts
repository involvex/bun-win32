/**
 * DirectSound Device Report — a full audio-endpoint diagnostic over pure FFI
 *
 * Enumerates every DirectSound playback driver and every DirectSound capture
 * driver on the machine through the flat `DirectSoundEnumerateW` /
 * `DirectSoundCaptureEnumerateW` exports (driven by a Bun `JSCallback` that
 * receives the real `DSEnumCallback` arguments), resolves the four well-known
 * default-device GUIDs with `GetDeviceID`, then opens a real `IDirectSound8`
 * on the default playback adapter and walks its COM vtable to pull the full
 * `DSCAPS` hardware-capability block and the current speaker configuration.
 * Everything is rendered as an aligned, color-coded report — device tables,
 * decoded capability flags, sample-rate ranges, hardware-mixing and hardware-
 * memory counters, and the speaker layout/geometry.
 *
 * APIs demonstrated (DSound):
 *   - DSound.DirectSoundEnumerateW         (enumerate playback drivers)
 *   - DSound.DirectSoundCaptureEnumerateW  (enumerate capture drivers)
 *   - DSound.GetDeviceID                   (resolve default-device GUIDs)
 *   - DSound.DirectSoundCreate8            (open the default playback device)
 *   - IDirectSound8::GetCaps               (DSCAPS hardware capability block)
 *   - IDirectSound8::GetSpeakerConfig      (speaker layout + geometry)
 *   - IUnknown::Release                    (release the COM object)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/dsound-device-report.ts
 */

import { CFunction, FFIType, JSCallback, type Pointer, read, toArrayBuffer } from 'bun:ffi';

import DSound, { DSCAPS, DSSPEAKER, DSDEVID_DefaultCapture, DSDEVID_DefaultPlayback, DSDEVID_DefaultVoiceCapture, DSDEVID_DefaultVoicePlayback, DS_OK } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';
const WHITE = '\x1b[97m';

const IUNKNOWN_RELEASE = 2;
const IDIRECTSOUND8_GETCAPS = 4;
const IDIRECTSOUND8_GETSPEAKERCONFIG = 8;

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const invokers = new Map<string, ReturnType<typeof CFunction>>();

/** Invokes COM vtable slot `slot` on `thisPtr` (implicit `this` prepended). */
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

/** Builds the 16-byte little-endian GUID layout from a canonical GUID string. */
function guidBuffer(text: string): Buffer {
  const h = text.replace(/[{}-]/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1) b[8 + i] = parseInt(h.slice(16 + i * 2, 18 + i * 2), 16);
  return b;
}

/** Formats 16 GUID bytes at `offset` as the canonical 8-4-4-4-12 string. */
function guidToString(buf: Buffer, offset = 0): string {
  const d1 = buf.readUInt32LE(offset).toString(16).padStart(8, '0');
  const d2 = buf
    .readUInt16LE(offset + 4)
    .toString(16)
    .padStart(4, '0');
  const d3 = buf
    .readUInt16LE(offset + 6)
    .toString(16)
    .padStart(4, '0');
  const d4 = [...buf.subarray(offset + 8, offset + 10)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const d5 = [...buf.subarray(offset + 10, offset + 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}

/** Reads a NUL-terminated UTF-16LE string from a raw native pointer. */
function readWide(ptr: Pointer | null): string {
  if (ptr === null || (ptr as number) === 0) return '';
  return Buffer.from(toArrayBuffer(ptr, 0, 1024))
    .toString('utf16le')
    .replace(/\0.*$/, '');
}

interface AudioDevice {
  description: string;
  guid: string | null;
  module: string;
}

function enumerate(fn: (cb: Pointer, ctx: null) => number, label: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const callback = new JSCallback(
    (guidPtr: Pointer | null, descPtr: Pointer | null, modPtr: Pointer | null): number => {
      const isPrimary = guidPtr === null || (guidPtr as number) === 0;
      const guid = isPrimary ? null : guidToString(Buffer.from(toArrayBuffer(guidPtr, 0, 16)));
      devices.push({ description: readWide(descPtr), guid, module: readWide(modPtr) });
      return 1; // TRUE → keep enumerating
    },
    { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  );
  const hr = fn(callback.ptr!, null);
  callback.close();
  if (hr !== DS_OK) console.log(`  ${RED}✗${RESET} ${label} ${hex(hr)}`);
  return devices;
}

/** Resolves a well-known DSDEVID_* alias to the concrete device GUID. */
function resolveDefault(alias: string): string | null {
  const dest = Buffer.alloc(16);
  const hr = DSound.GetDeviceID(guidBuffer(alias).ptr!, dest.ptr!);
  return hr === DS_OK ? guidToString(dest) : null;
}

// Enable ANSI escape processing so colors render in Windows Terminal / VS Code.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr!)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

function rule(width = 64): string {
  return `${DIM}${'─'.repeat(width)}${RESET}`;
}

console.log();
console.log(`${BOLD}${MAGENTA}  DirectSound Device Report${RESET}  ${DIM}— enumerated & probed through pure Bun FFI${RESET}`);
console.log(`  ${rule()}`);

const playback = enumerate((cb, ctx) => DSound.DirectSoundEnumerateW(cb, ctx), 'DirectSoundEnumerateW');
const capture = enumerate((cb, ctx) => DSound.DirectSoundCaptureEnumerateW(cb, ctx), 'DirectSoundCaptureEnumerateW');

const defaults = {
  Playback: resolveDefault(DSDEVID_DefaultPlayback),
  Capture: resolveDefault(DSDEVID_DefaultCapture),
  'Voice playback': resolveDefault(DSDEVID_DefaultVoicePlayback),
  'Voice capture': resolveDefault(DSDEVID_DefaultVoiceCapture),
};

function printDevices(title: string, list: AudioDevice[], defaultGuid: string | null): void {
  console.log();
  console.log(`  ${BOLD}${CYAN}${title}${RESET} ${DIM}(${list.length})${RESET}`);
  if (list.length === 0) {
    console.log(`    ${DIM}none${RESET}`);
    return;
  }
  for (const d of list) {
    const isDefault = d.guid !== null && defaultGuid !== null && d.guid.toLowerCase() === defaultGuid.toLowerCase();
    const tag = d.guid === null ? `${YELLOW}★ primary${RESET}` : isDefault ? `${GREEN}● default${RESET}` : `${DIM}  device ${RESET}`;
    console.log(`    ${tag}  ${WHITE}${d.description}${RESET}`);
    console.log(`              ${DIM}guid  ${RESET}${d.guid ?? `${DIM}(null — system default)${RESET}`}`);
    if (d.module.length > 0) console.log(`              ${DIM}drv   ${RESET}${DIM}${d.module}${RESET}`);
  }
}

printDevices('Playback drivers', playback, defaults.Playback);
printDevices('Capture drivers', capture, defaults.Capture);

console.log();
console.log(`  ${BOLD}${CYAN}Default endpoints${RESET} ${DIM}(GetDeviceID)${RESET}`);
for (const [name, guid] of Object.entries(defaults)) {
  console.log(`    ${name.padEnd(16)} ${guid === null ? `${RED}unavailable${RESET}` : `${WHITE}${guid}${RESET}`}`);
}

// Open the default playback device and x-ray its DSCAPS over the vtable.
console.log();
console.log(`  ${BOLD}${CYAN}Default playback capabilities${RESET} ${DIM}(IDirectSound8::GetCaps)${RESET}`);
const ppDS8 = Buffer.alloc(8);
const createHr = DSound.DirectSoundCreate8(null, ppDS8.ptr!, null);
if (createHr !== DS_OK) {
  console.log(`    ${YELLOW}ℹ${RESET} No openable playback device (DirectSoundCreate8 → ${hex(createHr)}).`);
} else {
  const device = ppDS8.readBigUInt64LE(0);

  const caps = Buffer.alloc(96);
  caps.writeUInt32LE(96, 0); // DSCAPS.dwSize
  const capsHr = vcall(device, IDIRECTSOUND8_GETCAPS, [FFIType.ptr], [caps.ptr!]);
  if (capsHr === DS_OK) {
    const flags = caps.readUInt32LE(4);
    const flagNames = Object.entries(DSCAPS)
      .filter(([k, v]) => typeof v === 'number' && (flags & (v as number)) !== 0 && k.startsWith('DSCAPS_'))
      .map(([k]) => k.replace('DSCAPS_', ''));
    const field = (label: string, value: string): string => `    ${label.padEnd(34)} ${WHITE}${value}${RESET}`;
    console.log(field('Driver type', flags & DSCAPS.DSCAPS_EMULDRIVER ? `${YELLOW}emulated (WDM/no hardware)${RESET}` : `${GREEN}certified/native${RESET}`));
    console.log(field('Capability flags', flagNames.length > 0 ? flagNames.join(' · ') : '(none)'));
    console.log(field('Secondary sample rate', `${caps.readUInt32LE(8).toLocaleString()} – ${caps.readUInt32LE(12).toLocaleString()} Hz`));
    console.log(field('Primary buffers', String(caps.readUInt32LE(16))));
    console.log(field('HW mixing buffers (all/static/strm)', `${caps.readUInt32LE(20)} / ${caps.readUInt32LE(24)} / ${caps.readUInt32LE(28)}`));
    console.log(field('HW mixing free (all/static/strm)', `${caps.readUInt32LE(32)} / ${caps.readUInt32LE(36)} / ${caps.readUInt32LE(40)}`));
    console.log(field('HW 3D buffers (all/static/strm)', `${caps.readUInt32LE(44)} / ${caps.readUInt32LE(48)} / ${caps.readUInt32LE(52)}`));
    console.log(field('HW memory total / free', `${(caps.readUInt32LE(68) / 1024).toFixed(0)} KiB / ${(caps.readUInt32LE(72) / 1024).toFixed(0)} KiB`));
    console.log(field('Unlock transfer rate', `${caps.readUInt32LE(80).toLocaleString()} KB/s`));
    console.log(field('SW buffer play CPU overhead', `${caps.readUInt32LE(84)} %`));
  } else {
    console.log(`    ${RED}✗${RESET} GetCaps ${hex(capsHr)}`);
  }

  const speakerCfg = Buffer.alloc(4);
  const spkHr = vcall(device, IDIRECTSOUND8_GETSPEAKERCONFIG, [FFIType.ptr], [speakerCfg.ptr!]);
  if (spkHr === DS_OK) {
    const combined = speakerCfg.readUInt32LE(0);
    const config = combined & 0xff;
    const geometry = (combined >> 16) & 0xff;
    const cfgName = DSSPEAKER[config] ?? `0x${config.toString(16)}`;
    console.log(`    ${'Speaker configuration'.padEnd(34)} ${WHITE}${cfgName.replace('DSSPEAKER_', '')}${RESET}${geometry ? `${DIM} · geometry ${geometry}°${RESET}` : ''}`);
  }

  vcall(device, IUNKNOWN_RELEASE, [], [], FFIType.u32);
  console.log(`    ${DIM}IDirectSound8 @ 0x${device.toString(16)} — released cleanly.${RESET}`);
}

console.log();
console.log(`  ${rule()}`);
console.log(`  ${GREEN}${BOLD}${playback.length + capture.length}${RESET} ${DIM}audio drivers enumerated · zero native build · zero dependencies${RESET}`);
console.log();

if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
