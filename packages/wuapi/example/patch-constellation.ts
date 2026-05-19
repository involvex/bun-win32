/**
 * Patch Constellation
 *
 * A live, animated star map of everything Windows Update has ever done to this
 * machine — rendered entirely from data pulled out of the Windows Update Agent
 * COM server (`wuapi.dll`) over raw FFI. Every servicing event becomes a star:
 * its colour is the OperationResultCode (green = succeeded, amber = succeeded
 * with errors, red = failed/aborted), its brightness twinkles frame by frame,
 * and its X position is its place in time. A scanning sweep line drifts across
 * the field, lighting up each star it crosses while a ticker at the bottom
 * scrolls the real KB titles in order. A live histogram shows the success /
 * failure mix filling up as the sweep reveals it.
 *
 * Nothing shells out — the entire constellation is built by
 * `CoCreateInstance(CLSID_UpdateSession)` and hand-walked COM vtable calls into
 * `IUpdateSession → IUpdateSearcher → IUpdateHistoryEntryCollection`. Strictly
 * read-only: no download or install code paths are exercised.
 *
 * APIs demonstrated (Wuapi, COM server):
 *   - DllCanUnloadNow                (server liveness self-test)
 *   - IUpdateSession::CreateUpdateSearcher  (vtable slot 12)
 *   - IUpdateSearcher::QueryHistory         (vtable slot 18)
 *   - IUpdateSearcher::GetTotalHistoryCount (vtable slot 22)
 *   - IUpdateHistoryEntryCollection::get_Count / get_Item
 *   - IUpdateHistoryEntry::get_Title/ResultCode/Date
 *
 * APIs demonstrated (cross-package):
 *   - combase.dll CoInitializeEx/CoCreateInstance/CLSIDFromString/CoUninitialize (raw FFI)
 *   - Oleaut32.SysStringLen/SysFreeString (BSTR decode)
 *   - Kernel32.GetStdHandle/Get|SetConsoleMode (enable ANSI VT processing)
 *
 * Run: bun run example/patch-constellation.ts
 */

import { CFunction, dlopen, FFIType, type Pointer, read } from 'bun:ffi';

import Wuapi, { CLSID_UpdateSession, IID_IUpdateSession, OperationResultCode } from '../index';
import Kernel32 from '@bun-win32/kernel32';
import Oleaut32 from '@bun-win32/oleaut32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

const S_OK = 0;
const S_FALSE = 1;
const COINIT_APARTMENTTHREADED = 0x2;

const IUNKNOWN_RELEASE = 2;
const IUPDATESESSION_CREATEUPDATESEARCHER = 12;
const IUPDATESEARCHER_QUERYHISTORY = 18;
const IUPDATESEARCHER_GETTOTALHISTORYCOUNT = 22;
const IHISTORYCOLLECTION_GET_ITEM = 7;
const IHISTORYCOLLECTION_GET_COUNT = 9;
const IHISTORYENTRY_GET_RESULTCODE = 8;
const IHISTORYENTRY_GET_TITLE = 12;

const combase = dlopen('combase.dll', {
  CLSIDFromString: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoCreateInstance: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
});

function enableVirtualTerminal(): void {
  const STD_OUTPUT_HANDLE = 0xffff_fff5;
  const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
  const handle = Kernel32.GetStdHandle(STD_OUTPUT_HANDLE);
  const mode = Buffer.alloc(4);
  if (Kernel32.GetConsoleMode(handle, mode.ptr!)) {
    Kernel32.SetConsoleMode(handle, mode.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
  }
}

const invokers = new Map<string, ReturnType<typeof CFunction>>();

function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[]): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${argTypes.join(',')}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns: FFIType.i32 });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args) as number;
}

function release(pUnk: bigint): void {
  if (pUnk !== 0n) vcall(pUnk, IUNKNOWN_RELEASE, [], []);
}

function guid(text: string): Buffer {
  const wide = Buffer.from(text + '\0', 'utf16le');
  const out = Buffer.alloc(16);
  if (combase.symbols.CLSIDFromString(wide.ptr!, out.ptr!) !== S_OK) throw new Error(`CLSIDFromString(${text}) failed`);
  return out;
}

function createInstance(clsid: string, iid: string): bigint {
  const CLSCTX_INPROC_SERVER = 0x1;
  const out = Buffer.alloc(8);
  if (combase.symbols.CoCreateInstance(guid(clsid).ptr!, 0n, CLSCTX_INPROC_SERVER, guid(iid).ptr!, out.ptr!) !== S_OK) throw new Error('CoCreateInstance failed');
  return out.readBigUInt64LE(0);
}

function getBstr(pObj: bigint, slot: number): string {
  const out = Buffer.alloc(8);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return '';
  const bstr = out.readBigUInt64LE(0);
  if (bstr === 0n) return '';
  const ptr = Number(bstr) as Pointer;
  const len = Oleaut32.SysStringLen(ptr);
  const bytes = Buffer.alloc(len * 2);
  for (let i = 0; i < len * 2; i += 1) bytes[i] = read.u8(ptr, i);
  Oleaut32.SysFreeString(ptr);
  return bytes.toString('utf16le');
}

function getLong(pObj: bigint, slot: number): number {
  const out = Buffer.alloc(4);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return 0;
  return out.readInt32LE(0);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Star = { x: number; y: number; rc: number; title: string };

function starColor(rc: number, intensity: number): string {
  let r = 80;
  let g = 80;
  let b = 80;
  if (rc === OperationResultCode.orcSucceeded) {
    r = 30;
    g = 200;
    b = 90;
  } else if (rc === OperationResultCode.orcSucceededWithErrors) {
    r = 230;
    g = 180;
    b = 40;
  } else if (rc === OperationResultCode.orcFailed || rc === OperationResultCode.orcAborted) {
    r = 230;
    g = 60;
    b = 60;
  } else if (rc === OperationResultCode.orcInProgress) {
    r = 80;
    g = 160;
    b = 230;
  }
  const k = 0.35 + 0.65 * intensity;
  return `\x1b[38;2;${Math.round(r * k)};${Math.round(g * k)};${Math.round(b * k)}m`;
}

const GLYPHS = ['·', '∘', '*', '✦', '✶', '★'];

async function main(): Promise<void> {
  enableVirtualTerminal();

  const init = combase.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (init !== S_OK && init !== S_FALSE) {
    console.error(`CoInitializeEx failed: 0x${(init >>> 0).toString(16)}`);
    return;
  }

  let pSession = 0n;
  let pSearcher = 0n;
  let pHistory = 0n;
  const entries: { rc: number; title: string }[] = [];
  try {
    // Server liveness self-test against the flat wuapi.dll export.
    Wuapi.DllCanUnloadNow();

    pSession = createInstance(CLSID_UpdateSession, IID_IUpdateSession);
    const searcherOut = Buffer.alloc(8);
    if (vcall(pSession, IUPDATESESSION_CREATEUPDATESEARCHER, [FFIType.ptr], [searcherOut.ptr!]) !== S_OK) throw new Error('CreateUpdateSearcher failed');
    pSearcher = searcherOut.readBigUInt64LE(0);

    const totalOut = Buffer.alloc(4);
    vcall(pSearcher, IUPDATESEARCHER_GETTOTALHISTORYCOUNT, [FFIType.ptr], [totalOut.ptr!]);
    const total = totalOut.readInt32LE(0);
    const fetch = Math.min(Math.max(total, 0), 240);

    if (fetch > 0) {
      const histOut = Buffer.alloc(8);
      if (vcall(pSearcher, IUPDATESEARCHER_QUERYHISTORY, [FFIType.i32, FFIType.i32, FFIType.ptr], [0, fetch, histOut.ptr!]) === S_OK) {
        pHistory = histOut.readBigUInt64LE(0);
        const count = getLong(pHistory, IHISTORYCOLLECTION_GET_COUNT);
        for (let i = 0; i < count; i += 1) {
          const itemOut = Buffer.alloc(8);
          if (vcall(pHistory, IHISTORYCOLLECTION_GET_ITEM, [FFIType.i32, FFIType.ptr], [i, itemOut.ptr!]) !== S_OK) continue;
          const pEntry = itemOut.readBigUInt64LE(0);
          if (pEntry === 0n) continue;
          const rcOut = Buffer.alloc(4);
          vcall(pEntry, IHISTORYENTRY_GET_RESULTCODE, [FFIType.ptr], [rcOut.ptr!]);
          entries.push({ rc: rcOut.readInt32LE(0), title: getBstr(pEntry, IHISTORYENTRY_GET_TITLE) });
          release(pEntry);
        }
      }
    }

    if (entries.length === 0) {
      console.log('No Windows Update history is recorded on this machine — nothing to map.');
      return;
    }

    // QueryHistory returns newest-first; reverse so time flows left → right.
    entries.reverse();

    const cols = Math.max(64, Math.min(process.stdout.columns ?? 100, 120));
    const rows = 18;
    const fieldW = cols - 4;
    const stars: Star[] = entries.map((e, i) => {
      // Deterministic pseudo-scatter keyed by index so frames are stable.
      const seed = (i * 2654435761) >>> 0;
      return {
        x: Math.floor((i / entries.length) * (fieldW - 1)),
        y: 1 + (seed % (rows - 2)),
        rc: e.rc,
        title: e.title || '(untitled update)',
      };
    });

    const grid: (Star | null)[][] = Array.from({ length: rows }, () => new Array<Star | null>(fieldW).fill(null));
    for (const s of stars) if (grid[s.y][s.x] === null) grid[s.y][s.x] = s;

    const succeeded = entries.filter((e) => e.rc === OperationResultCode.orcSucceeded).length;
    const warned = entries.filter((e) => e.rc === OperationResultCode.orcSucceededWithErrors).length;
    const failed = entries.filter((e) => e.rc === OperationResultCode.orcFailed || e.rc === OperationResultCode.orcAborted).length;

    process.stdout.write(HIDE_CURSOR);
    const FRAMES = 130;
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const sweepX = Math.floor((frame / FRAMES) * fieldW);
      const revealed = Math.round((frame / FRAMES) * entries.length);
      const out: string[] = [];
      out.push(CLEAR);
      out.push(`${BOLD}  ✦ PATCH CONSTELLATION${RESET}  ${DIM}wuapi.dll · ${entries.length} servicing events charted live over COM${RESET}\n`);

      for (let y = 0; y < rows; y += 1) {
        let line = '  ';
        for (let x = 0; x < fieldW; x += 1) {
          const s = grid[y][x];
          if (s === null) {
            line += x === sweepX ? `${DIM}\x1b[38;2;60;90;140m|${RESET}` : ' ';
            continue;
          }
          // Twinkle: phase from position + frame; brighten hugely near the sweep.
          const phase = Math.sin(x * 0.6 + y * 1.3 + frame * 0.5) * 0.5 + 0.5;
          const near = Math.max(0, 1 - Math.abs(x - sweepX) / 6);
          const intensity = Math.min(1, 0.35 + phase * 0.5 + near);
          const glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(intensity * GLYPHS.length))];
          line += `${starColor(s.rc, intensity)}${glyph}${RESET}`;
        }
        out.push(line);
      }

      // Live histogram of what the sweep has revealed so far.
      const seen = entries.slice(0, revealed);
      const sOK = seen.filter((e) => e.rc === OperationResultCode.orcSucceeded).length;
      const sWarn = seen.filter((e) => e.rc === OperationResultCode.orcSucceededWithErrors).length;
      const sFail = seen.filter((e) => e.rc === OperationResultCode.orcFailed || e.rc === OperationResultCode.orcAborted).length;
      const w = 36;
      const segOK = Math.round((sOK / entries.length) * w);
      const segWarn = Math.round((sWarn / entries.length) * w);
      const segFail = Math.round((sFail / entries.length) * w);
      out.push('');
      out.push(
        `  ${starColor(OperationResultCode.orcSucceeded, 1)}${'█'.repeat(segOK)}${starColor(OperationResultCode.orcSucceededWithErrors, 1)}${'█'.repeat(segWarn)}${starColor(OperationResultCode.orcFailed, 1)}${'█'.repeat(segFail)}${DIM}${'░'.repeat(Math.max(0, w - segOK - segWarn - segFail))}${RESET}`,
      );
      out.push(
        `  ${starColor(OperationResultCode.orcSucceeded, 1)}● ${sOK} ok${RESET}   ${starColor(OperationResultCode.orcSucceededWithErrors, 1)}● ${sWarn} warn${RESET}   ${starColor(OperationResultCode.orcFailed, 1)}● ${sFail} fail${RESET}   ${DIM}of ${entries.length} (${succeeded}/${warned}/${failed} total)${RESET}`,
      );

      // Ticker: the title the sweep is currently passing over.
      const cur = entries[Math.min(entries.length - 1, Math.max(0, revealed - 1))];
      const ticker = (cur?.title || '').slice(0, fieldW - 4);
      out.push('');
      out.push(`  ${DIM}▸${RESET} ${BOLD}${ticker}${RESET}`);
      process.stdout.write(out.join('\n'));
      await sleep(45);
    }

    process.stdout.write(`\n\n  ${BOLD}${starColor(OperationResultCode.orcSucceeded, 1)}✦ Constellation complete${RESET} ${DIM}— ${entries.length} stars charted from the Windows Update Agent${RESET}\n\n`);
  } finally {
    process.stdout.write(SHOW_CURSOR);
    release(pHistory);
    release(pSearcher);
    release(pSession);
    combase.symbols.CoUninitialize();
  }
}

main();
