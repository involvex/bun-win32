/**
 * WIM Inspector
 *
 * A thorough Windows Imaging (.wim) diagnostic.
 *
 *   • Pass a .wim path  -> it is opened read-only and fully dissected: the
 *     decoded WIM_INFO header (stored path, GUID, compression mode, part /
 *     boot indices, attribute flags), the image count, and every image's
 *     WIM-allocated XML manifest (name, file/dir counts, byte totals).
 *   • No argument        -> it synthesizes a compressible directory tree and
 *     captures it into a fresh LZX .wim, then dissects that. (Capture needs
 *     SeBackupPrivilege — run elevated; unelevated it explains and skips.)
 *   • Always             -> the live system-wide mounted-image table is
 *     decoded from WIM_MOUNT_INFO_LEVEL1 structures (no privilege required).
 *
 * Every field is labelled and aligned; sizes are human-readable.
 *
 * APIs demonstrated (Wimgapi):
 *   - WIMCreateFile               (create a new .wim / open one read-only)
 *   - WIMSetTemporaryPath         (scratch directory for the imaging engine)
 *   - WIMCaptureImage             (capture a directory tree into the .wim)
 *   - WIMGetAttributes            (decode the WIM_INFO header struct)
 *   - WIMGetImageCount            (number of images in the .wim)
 *   - WIMLoadImage                (obtain a per-image volume handle)
 *   - WIMGetImageInformation      (WIM-allocated UTF-16 XML manifest)
 *   - WIMGetMountedImages         (documented NULL sizing call)
 *   - WIMGetMountedImageInfo      (decode WIM_MOUNT_INFO_LEVEL1 entries)
 *   - WIMCloseHandle              (release image and .wim handles)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *   - GetLastError                (decode imaging failures)
 *   - LocalFree                   (free the WIM-allocated XML buffer)
 *
 * Run: bun run example/wim-inspector.ts [path\to\image.wim]
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { read, toArrayBuffer, type Pointer } from 'bun:ffi';

import Wimgapi, { MOUNTED_IMAGE_INFO_LEVELS, WIMCompressionType, WIMCreationDisposition, WIMDesiredAccess } from '../index';
import Kernel32 from '@bun-win32/kernel32';

Wimgapi.Preload(['WIMCreateFile', 'WIMSetTemporaryPath', 'WIMCaptureImage', 'WIMGetAttributes', 'WIMGetImageCount', 'WIMLoadImage', 'WIMGetImageInformation', 'WIMGetMountedImages', 'WIMGetMountedImageInfo', 'WIMCloseHandle']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetLastError', 'LocalFree']);

const STD_OUTPUT_HANDLE = -11;
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
const modeBuffer = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuffer.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuffer.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[38;2;120;205;255m';
const GREEN = '\x1b[38;2;130;230;160m';
const AMBER = '\x1b[38;2;245;200;110m';
const VIOLET = '\x1b[38;2;190;160;255m';
const RED = '\x1b[38;2;255;120;120m';

const wide = (text: string): Buffer => Buffer.from(text + '\0', 'utf16le');

function humanBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

const rule = (label: string): string => `\n${VIOLET}${BOLD}${label}${RESET}\n${DIM}${'─'.repeat(64)}${RESET}`;
const field = (name: string, value: string, color = CYAN): string => `  ${name.padEnd(22)}${color}${value}${RESET}`;

// WIM_INFO: WCHAR WimPath[MAX_PATH=260] (520B) · GUID Guid (16B) · DWORD
// ImageCount · CompressionType · USHORT PartNumber · TotalParts · DWORD
// BootIndex · WimAttributes · WimFlagsAndAttr. Total 560 bytes.
const WIM_INFO_SIZE = 560;
// WIM_MOUNT_INFO_LEVEL1: WCHAR WimPath[260] · WCHAR MountPath[260] · DWORD
// ImageIndex · DWORD MountFlags. 520 + 520 + 4 + 4 = 1048 bytes.
const WIM_MOUNT_INFO_LEVEL1_SIZE = 1048;

const COMPRESSION_NAMES: Record<number, string> = {
  [WIMCompressionType.WIM_COMPRESS_NONE]: 'NONE',
  [WIMCompressionType.WIM_COMPRESS_XPRESS]: 'XPRESS',
  [WIMCompressionType.WIM_COMPRESS_LZX]: 'LZX',
  [WIMCompressionType.WIM_COMPRESS_LZMS]: 'LZMS',
};

function formatGuid(buffer: Buffer, offset: number): string {
  const hex = (start: number, length: number, le: boolean): string => {
    const slice = buffer.subarray(offset + start, offset + start + length);
    const bytes = le ? Array.from(slice).reverse() : Array.from(slice);
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  return `{${hex(0, 4, true)}-${hex(4, 2, true)}-${hex(6, 2, true)}-${hex(8, 2, false)}-${hex(10, 6, false)}}`.toUpperCase();
}

const WIM_INFO_ATTR_FLAGS: [number, string][] = [
  [0x0000_0001, 'RESOURCE_ONLY'],
  [0x0000_0002, 'METADATA_ONLY'],
  [0x0000_0004, 'VERIFY_DATA'],
  [0x0000_0008, 'RP_FIX'],
  [0x0000_0010, 'SPANNED'],
  [0x0000_0020, 'READONLY'],
];

function decodeAttributes(value: number): string {
  if (value === 0) return 'NORMAL';
  const names = WIM_INFO_ATTR_FLAGS.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
  return names.length ? names.join(' | ') : `0x${value.toString(16)}`;
}

const readWide = (buffer: Buffer, start: number, byteLength: number): string =>
  buffer
    .subarray(start, start + byteLength)
    .toString('utf16le')
    .replace(/\0.*$/, '');

const argument = process.argv[2];
const scratchDirectory = join(tmpdir(), `wim-inspector-${process.pid}`);
const sourceDirectory = join(scratchDirectory, 'payload');
const wimPath = argument ?? join(scratchDirectory, 'inspector.wim');

console.log(`${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${CYAN}║                 W I M   I N S P E C T O R                    ║${RESET}`);
console.log(`${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${RESET}`);

try {
  mkdirSync(scratchDirectory, { recursive: true });

  if (!argument) {
    // Synthesize a compressible directory tree, then capture it into a .wim.
    mkdirSync(sourceDirectory, { recursive: true });
    let syntheticBytes = 0;
    for (let directoryIndex = 0; directoryIndex < 6; directoryIndex++) {
      const subDirectory = join(sourceDirectory, `module-${directoryIndex}`);
      mkdirSync(subDirectory, { recursive: true });
      for (let fileIndex = 0; fileIndex < 40; fileIndex++) {
        const body = `// module ${directoryIndex} unit ${fileIndex}\n` + `export const data = "${'lorem-ipsum-dolor-sit-amet-'.repeat(48)}";\n`.repeat(6);
        writeFileSync(join(subDirectory, `unit-${fileIndex}.ts`), body);
        syntheticBytes += Buffer.byteLength(body);
      }
    }
    console.log(field('Synthesized payload', `${humanBytes(syntheticBytes)} · 240 files · 6 directories`, GREEN));

    const writeResult = Buffer.alloc(4);
    const hWrite = Wimgapi.WIMCreateFile(wide(wimPath).ptr!, WIMDesiredAccess.WIM_GENERIC_WRITE, WIMCreationDisposition.WIM_CREATE_ALWAYS, 0, WIMCompressionType.WIM_COMPRESS_LZX, writeResult.ptr!);
    if (hWrite === 0n) throw new Error(`WIMCreateFile(write) failed — GetLastError=${Kernel32.GetLastError()}`);

    if (!Wimgapi.WIMSetTemporaryPath(hWrite, wide(scratchDirectory).ptr!)) {
      throw new Error(`WIMSetTemporaryPath failed — GetLastError=${Kernel32.GetLastError()}`);
    }

    const captureStart = performance.now();
    const hCaptured = Wimgapi.WIMCaptureImage(hWrite, wide(sourceDirectory).ptr!, 0);
    if (hCaptured === 0n) {
      const lastError = Kernel32.GetLastError();
      console.log(field('WIMCaptureImage', `skipped — GetLastError=${lastError}${lastError === 1314 ? ' (ERROR_PRIVILEGE_NOT_HELD; run elevated to capture)' : ''}`, AMBER));
    } else {
      console.log(field('Captured', `image #1 in ${((performance.now() - captureStart) / 1000).toFixed(2)} s`, GREEN));
      Wimgapi.WIMCloseHandle(hCaptured);
    }
    Wimgapi.WIMCloseHandle(hWrite);
  }

  if (existsSync(wimPath)) {
    // Re-open the archive read-only and dissect it.
    const openResult = Buffer.alloc(4);
    const hWim = Wimgapi.WIMCreateFile(wide(wimPath).ptr!, WIMDesiredAccess.WIM_GENERIC_READ, WIMCreationDisposition.WIM_OPEN_EXISTING, 0, 0, openResult.ptr!);
    if (hWim === 0n) throw new Error(`WIMCreateFile(read) failed — GetLastError=${Kernel32.GetLastError()}`);

    console.log(rule(`WIM_INFO header — ${wimPath}`));
    const wimInfo = Buffer.alloc(WIM_INFO_SIZE);
    if (Wimgapi.WIMGetAttributes(hWim, wimInfo.ptr!, WIM_INFO_SIZE)) {
      console.log(field('Stored path', readWide(wimInfo, 0, 520) || '(none)'));
      console.log(field('GUID', formatGuid(wimInfo, 520), AMBER));
      console.log(field('Images', String(wimInfo.readUInt32LE(536)), GREEN));
      console.log(field('Compression', COMPRESSION_NAMES[wimInfo.readUInt32LE(540)] ?? `0x${wimInfo.readUInt32LE(540).toString(16)}`, GREEN));
      console.log(field('Part', `${wimInfo.readUInt16LE(544)} of ${wimInfo.readUInt16LE(546)}`));
      console.log(field('Boot index', wimInfo.readUInt32LE(548) === 0 ? 'none' : String(wimInfo.readUInt32LE(548))));
      console.log(field('Attributes', decodeAttributes(wimInfo.readUInt32LE(552)), AMBER));
    } else {
      console.log(`  ${RED}WIMGetAttributes failed — GetLastError=${Kernel32.GetLastError()}${RESET}`);
    }

    const totalImages = Wimgapi.WIMGetImageCount(hWim);
    console.log(rule(`Images (${totalImages})`));

    // WIMGetImageInformation returns the full UTF-16 XML manifest in a
    // WIM-allocated buffer the caller must release with Kernel32.LocalFree.
    const xmlPointerOut = Buffer.alloc(8);
    const xmlSizeOut = Buffer.alloc(4);
    if (Wimgapi.WIMGetImageInformation(hWim, xmlPointerOut.ptr!, xmlSizeOut.ptr!)) {
      // WIM wrote a PVOID (pointer to its own UTF-16 buffer) into our cell.
      // `read.ptr` returns that raw address; bridge it to a `Pointer`.
      const xmlAddress = read.ptr(xmlPointerOut.ptr!, 0);
      const xmlByteLength = xmlSizeOut.readUInt32LE(0);
      if (xmlAddress && xmlByteLength > 0) {
        const xml = Buffer.from(toArrayBuffer(xmlAddress as Pointer, 0, xmlByteLength))
          .toString('utf16le')
          .replace(/^﻿/, '');
        for (const block of xml.match(/<IMAGE[\s\S]*?<\/IMAGE>/g) ?? []) {
          const index = block.match(/INDEX="(\d+)"/)?.[1] ?? '?';
          const name = block.match(/<NAME>([\s\S]*?)<\/NAME>/)?.[1] ?? '(unnamed)';
          const fileCount = Number(block.match(/<FILECOUNT>(\d+)<\/FILECOUNT>/)?.[1] ?? 0);
          const dirCount = Number(block.match(/<DIRCOUNT>(\d+)<\/DIRCOUNT>/)?.[1] ?? 0);
          const totalBytes = Number(block.match(/<TOTALBYTES>(\d+)<\/TOTALBYTES>/)?.[1] ?? 0);
          console.log(`  ${BOLD}${GREEN}#${index}${RESET} ${CYAN}${name}${RESET}`);
          console.log(`     ${DIM}files${RESET} ${fileCount}   ${DIM}dirs${RESET} ${dirCount}   ${DIM}size${RESET} ${humanBytes(totalBytes)}`);
        }
        console.log(`  ${DIM}manifest XML ${humanBytes(xmlByteLength)} — WIM-allocated, freed via Kernel32.LocalFree${RESET}`);
        Kernel32.LocalFree(BigInt(xmlAddress));
      }
    } else {
      console.log(`  ${RED}WIMGetImageInformation failed — GetLastError=${Kernel32.GetLastError()}${RESET}`);
    }

    if (totalImages >= 1) {
      const hImage = Wimgapi.WIMLoadImage(hWim, 1);
      console.log(field('WIMLoadImage(#1)', hImage === 0n ? `failed (GetLastError=${Kernel32.GetLastError()})` : `volume handle 0x${hImage.toString(16)}`, hImage === 0n ? RED : GREEN));
      if (hImage !== 0n) Wimgapi.WIMCloseHandle(hImage);
    }

    Wimgapi.WIMCloseHandle(hWim);
  } else {
    console.log(rule('No .wim to dissect'));
    console.log(`  ${AMBER}Capture requires elevation. For the full read-only dissection,${RESET}`);
    console.log(`  ${AMBER}re-run elevated, or pass an existing image:${RESET}`);
    console.log(`  ${DIM}bun run example/wim-inspector.ts C:\\path\\to\\install.wim${RESET}`);
  }

  // System-wide mounted-image table — needs no privilege. WIMGetMountedImages
  // with a NULL list is the documented sizing call; WIMGetMountedImageInfo
  // decodes the live WIM_MOUNT_INFO_LEVEL1 records.
  console.log(rule('Mounted images (system-wide)'));
  const sizingBuffer = Buffer.alloc(4);
  Wimgapi.WIMGetMountedImages(null, sizingBuffer.ptr!);
  console.log(field('NULL sizing call', `WIMGetMountedImages reports ${sizingBuffer.readUInt32LE(0)} bytes of records`, DIM));

  const mountCount = Buffer.alloc(4);
  const returnLength = Buffer.alloc(4);
  Wimgapi.WIMGetMountedImageInfo(MOUNTED_IMAGE_INFO_LEVELS.MountedImageInfoLevel1, mountCount.ptr!, null, 0, returnLength.ptr!);
  const mounted = mountCount.readUInt32LE(0);
  if (mounted === 0) {
    console.log(field('Mounted right now', 'none', DIM));
  } else {
    const mountInfo = Buffer.alloc(returnLength.readUInt32LE(0));
    if (Wimgapi.WIMGetMountedImageInfo(MOUNTED_IMAGE_INFO_LEVELS.MountedImageInfoLevel1, mountCount.ptr!, mountInfo.ptr!, mountInfo.byteLength, returnLength.ptr!)) {
      for (let i = 0; i < mounted; i++) {
        const base = i * WIM_MOUNT_INFO_LEVEL1_SIZE;
        const wimFile = readWide(mountInfo, base, 520);
        const mountPath = readWide(mountInfo, base + 520, 520);
        const imageIndex = mountInfo.readUInt32LE(base + 1040);
        const mountFlags = mountInfo.readUInt32LE(base + 1044);
        console.log(`  ${BOLD}${GREEN}${mountPath}${RESET}`);
        console.log(`     ${DIM}image #${imageIndex} of${RESET} ${wimFile}  ${DIM}flags${RESET} 0x${mountFlags.toString(16).padStart(8, '0')}`);
      }
    }
  }

  console.log(`\n${GREEN}${BOLD}✓ Inspection complete.${RESET}`);
} catch (error) {
  console.log(`\n${RED}${BOLD}✗ ${(error as Error).message}${RESET}`);
  process.exitCode = 1;
} finally {
  if (!argument) {
    try {
      rmSync(scratchDirectory, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
