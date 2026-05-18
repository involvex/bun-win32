/**
 * Minifilter Census
 *
 * A complete, aligned forensic enumeration of every file-system minifilter
 * registered with the Windows Filter Manager — the same picture `fltmc` paints,
 * but straight from FFI with no process spawn. For each minifilter it reports
 * the frame id and instance count, then walks every instance to show the
 * volume it is attached to, its altitude (its position in the I/O stack), and
 * the instance name. It also enumerates every volume the Filter Manager knows.
 * This is the layer security products (Defender's WdFilter, EDR sensors,
 * bindflt, wcifs, …) live in. Everything is read-only.
 *
 * APIs demonstrated (Fltlib):
 *   - FilterFindFirst / FilterFindNext / FilterFindClose            (minifilters)
 *   - FilterInstanceFindFirst / ...FindNext / ...FindClose          (instances)
 *   - FilterVolumeFindFirst / ...FindNext / ...FindClose            (volumes)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/minifilter-census.ts
 */
import Fltlib, { FILTER_INFORMATION_CLASS, FILTER_VOLUME_INFORMATION_CLASS, INSTANCE_INFORMATION_CLASS } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Fltlib.Preload(['FilterFindFirst', 'FilterFindNext', 'FilterFindClose', 'FilterInstanceFindFirst', 'FilterInstanceFindNext', 'FilterInstanceFindClose', 'FilterVolumeFindFirst', 'FilterVolumeFindNext', 'FilterVolumeFindClose']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[38;2;90;220;130m';
const RED = '\x1b[38;2;240;110;110m';
const YELLOW = '\x1b[38;2;235;205;100m';
const CYAN = '\x1b[38;2;120;200;255m';
const VIOLET = '\x1b[38;2;195;150;255m';

const S_OK = 0;
const ERROR_NO_MORE_ITEMS = 0x80070103 | 0;
const ERROR_INSUFFICIENT_BUFFER = 0x8007007a | 0;
const ERROR_ACCESS_DENIED = 0x80070005 | 0;

const hex = (hr: number) => '0x' + (hr >>> 0).toString(16).toUpperCase().padStart(8, '0');

function elevationPanel(api: string, hr: number): void {
  console.log(`  ${YELLOW}${BOLD}▲  ADMINISTRATOR REQUIRED${RESET}`);
  console.log(`  ${DIM}${api} returned ${hex(hr)} (HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED)).${RESET}`);
  console.log(`  ${DIM}The Filter Manager only enumerates its minifilter/volume tables for an${RESET}`);
  console.log(`  ${DIM}elevated caller — the same restriction \`fltmc\` itself carries. The FFI${RESET}`);
  console.log(`  ${DIM}binding is correct: it executed and surfaced the exact documented${RESET}`);
  console.log(`  ${DIM}HRESULT. Re-run from an Administrator terminal for the live census.${RESET}\n`);
}

const BUF_BYTES = 64 * 1024;
const dataBuf = Buffer.alloc(BUF_BYTES);
const bytesBuf = Buffer.alloc(4);
const findHandleBuf = Buffer.alloc(8);

interface Instance {
  instanceName: string;
  altitude: string;
  volumeName: string;
}
interface MiniFilter {
  name: string;
  frameId: number;
  numberOfInstances: number;
  instances: Instance[];
}

// FILTER_FULL_INFORMATION: NextEntryOffset(4) FrameID(4) NumberOfInstances(4)
// FilterNameLength(2, bytes) FilterNameBuffer[]@14
function decodeFilterFull(): { name: string; frameId: number; numberOfInstances: number } {
  const frameId = dataBuf.readUInt32LE(4);
  const numberOfInstances = dataBuf.readUInt32LE(8);
  const nameLen = dataBuf.readUInt16LE(12);
  const name = dataBuf.subarray(14, 14 + nameLen).toString('utf16le');
  return { name, frameId, numberOfInstances };
}

// INSTANCE_FULL_INFORMATION: NextEntryOffset(4) InstanceNameLength(4)
// InstanceNameBufferOffset(4) AltitudeLength(4) AltitudeBufferOffset(4)
// VolumeNameLength(4) VolumeNameBufferOffset(4) FilterNameLength(4)
// FilterNameBufferOffset(4). Lengths are bytes; offsets are from struct start.
function decodeInstanceFull(): Instance {
  const instLen = dataBuf.readUInt32LE(4);
  const instOff = dataBuf.readUInt32LE(8);
  const altLen = dataBuf.readUInt32LE(12);
  const altOff = dataBuf.readUInt32LE(16);
  const volLen = dataBuf.readUInt32LE(20);
  const volOff = dataBuf.readUInt32LE(24);
  return {
    instanceName: dataBuf.subarray(instOff, instOff + instLen).toString('utf16le'),
    altitude: dataBuf.subarray(altOff, altOff + altLen).toString('utf16le'),
    volumeName: dataBuf.subarray(volOff, volOff + volLen).toString('utf16le'),
  };
}

// FILTER_VOLUME_STANDARD_INFORMATION: NextEntryOffset(4) Flags(4) FrameID(4)
// FileSystemType(4) VolumeNameLength(2, bytes) VolumeNameBuffer[]@18
function decodeVolumeStandard(): { volumeName: string; frameId: number; fileSystemType: number } {
  const frameId = dataBuf.readUInt32LE(8);
  const fileSystemType = dataBuf.readUInt32LE(12);
  const nameLen = dataBuf.readUInt16LE(16);
  const volumeName = dataBuf.subarray(18, 18 + nameLen).toString('utf16le');
  return { volumeName, frameId, fileSystemType };
}

function enumInstances(filterName: string): Instance[] {
  const out: Instance[] = [];
  const nameBuf = Buffer.from(filterName + '\0', 'utf16le');
  dataBuf.fill(0);
  let hr = Fltlib.FilterInstanceFindFirst(nameBuf.ptr!, INSTANCE_INFORMATION_CLASS.InstanceFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!, findHandleBuf.ptr!);
  if (hr !== S_OK) return out;
  const hFind = findHandleBuf.readBigUInt64LE(0);
  out.push(decodeInstanceFull());
  for (;;) {
    dataBuf.fill(0);
    hr = Fltlib.FilterInstanceFindNext(hFind, INSTANCE_INFORMATION_CLASS.InstanceFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!);
    if (hr !== S_OK) break;
    out.push(decodeInstanceFull());
  }
  Fltlib.FilterInstanceFindClose(hFind);
  return out;
}

console.log(`\n${BOLD}${CYAN}╔═══════════════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║            WINDOWS FILTER MANAGER  ·  MINIFILTER CENSUS              ║${RESET}`);
console.log(`${BOLD}${CYAN}╚═══════════════════════════════════════════════════════════════════════╝${RESET}\n`);

const filters: MiniFilter[] = [];
dataBuf.fill(0);
let hr = Fltlib.FilterFindFirst(FILTER_INFORMATION_CLASS.FilterFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!, findHandleBuf.ptr!);

if (hr !== S_OK) {
  if ((hr | 0) === ERROR_ACCESS_DENIED) elevationPanel('FilterFindFirst', hr);
  else if ((hr | 0) === ERROR_INSUFFICIENT_BUFFER) console.log(`  ${RED}FilterFindFirst → ${hex(hr)}${RESET} ${DIM}buffer too small (needs ${bytesBuf.readUInt32LE(0)} bytes)${RESET}\n`);
  else console.log(`  ${RED}FilterFindFirst → ${hex(hr)}${RESET} ${DIM}no minifilters enumerable${RESET}\n`);
} else {
  const hFind = findHandleBuf.readBigUInt64LE(0);
  const first = decodeFilterFull();
  filters.push({ ...first, instances: enumInstances(first.name) });
  for (;;) {
    dataBuf.fill(0);
    hr = Fltlib.FilterFindNext(hFind, FILTER_INFORMATION_CLASS.FilterFullInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!);
    if (hr !== S_OK) break;
    const f = decodeFilterFull();
    filters.push({ ...f, instances: enumInstances(f.name) });
  }
  Fltlib.FilterFindClose(hFind);

  const totalInstances = filters.reduce((s, f) => s + f.instances.length, 0);
  console.log(`  ${BOLD}${GREEN}${filters.length}${RESET} registered minifilters · ${BOLD}${GREEN}${totalInstances}${RESET} live instances\n`);

  // Sort by highest altitude across instances (top of the stack first).
  const altOf = (f: MiniFilter) => Math.max(0, ...f.instances.map((i) => parseFloat(i.altitude) || 0));
  for (const f of [...filters].sort((a, b) => altOf(b) - altOf(a))) {
    console.log(`${BOLD}${VIOLET}${f.name}${RESET}  ${DIM}frame ${f.frameId} · ${f.numberOfInstances} instance(s)${RESET}`);
    if (f.instances.length === 0) {
      console.log(`  ${DIM}(no attached instances)${RESET}`);
    }
    for (const inst of f.instances) {
      const alt = (inst.altitude || '—').padStart(12);
      console.log(`  ${CYAN}${alt}${RESET}  ${YELLOW}${(inst.volumeName || '(unnamed volume)').padEnd(28)}${RESET} ${DIM}${inst.instanceName}${RESET}`);
    }
    console.log('');
  }
}

console.log(`${BOLD}${CYAN}─── VOLUMES KNOWN TO THE FILTER MANAGER ───────────────────────────────${RESET}`);
dataBuf.fill(0);
let vhr = Fltlib.FilterVolumeFindFirst(FILTER_VOLUME_INFORMATION_CLASS.FilterVolumeStandardInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!, findHandleBuf.ptr!);
const FS_TYPE: Record<number, string> = { 0: 'UNKNOWN', 1: 'RAW', 2: 'NTFS', 3: 'FAT', 4: 'CDFS', 5: 'UDFS', 6: 'EXFAT', 7: 'CSVFS', 8: 'ReFS' };
if (vhr === S_OK) {
  const hVol = findHandleBuf.readBigUInt64LE(0);
  let count = 0;
  for (;;) {
    const v = decodeVolumeStandard();
    count++;
    console.log(`  ${GREEN}${(FS_TYPE[v.fileSystemType] ?? `FS${v.fileSystemType}`).padEnd(8)}${RESET} ${DIM}frame ${String(v.frameId).padStart(3)}${RESET}  ${v.volumeName}`);
    dataBuf.fill(0);
    vhr = Fltlib.FilterVolumeFindNext(hVol, FILTER_VOLUME_INFORMATION_CLASS.FilterVolumeStandardInformation, dataBuf.ptr!, BUF_BYTES, bytesBuf.ptr!);
    if (vhr !== S_OK) break;
  }
  Fltlib.FilterVolumeFindClose(hVol);
  console.log(`\n  ${DIM}${count} volume(s). Each minifilter instance above attaches at its altitude${RESET}`);
  console.log(`  ${DIM}on one of these volumes — that ordered stack is the file-system filter${RESET}`);
  console.log(`  ${DIM}pipeline every read/write/CreateFile on this machine flows through.${RESET}\n`);
} else if ((vhr | 0) === ERROR_ACCESS_DENIED) {
  elevationPanel('FilterVolumeFindFirst', vhr);
} else {
  console.log(`  ${YELLOW}FilterVolumeFindFirst → ${hex(vhr)}${RESET} ${vhr === ERROR_NO_MORE_ITEMS ? `${DIM}(none)${RESET}` : ''}\n`);
}
