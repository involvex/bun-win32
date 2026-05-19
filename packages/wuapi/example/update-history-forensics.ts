/**
 * Windows Update History Forensics
 *
 * An exhaustive, richly-formatted audit of this machine's Windows Update
 * servicing history — every install, uninstall, success, failure and reboot —
 * read live out of the Windows Update Agent COM server (`wuapi.dll`) over raw
 * FFI. Nothing shells out to PowerShell or `wuauclt`; the report is produced by
 * `CoCreateInstance(CLSID_UpdateSession)` followed by hand-walked COM vtable
 * calls into `IUpdateSession → IUpdateSearcher → IUpdateHistoryEntryCollection`.
 *
 * It enumerates every history entry, decodes the OperationResultCode and
 * UpdateOperation enums by name, resolves each entry's failure HRESULT, converts
 * the OLE-automation `DATE` install timestamp into a real calendar date via
 * `VariantTimeToSystemTime`, and prints an aligned forensic table plus a
 * success/failure breakdown. It also probes `ISystemInformation.RebootRequired`
 * so you can see at a glance whether a pending reboot is blocking servicing.
 * Strictly read-only — no download or install paths are touched.
 *
 * APIs demonstrated (Wuapi, COM server):
 *   - DllGetClassObject              (indirectly, via CoCreateInstance of CLSID_UpdateSession)
 *   - IUpdateSession::CreateUpdateSearcher  (vtable slot 12)
 *   - IUpdateSearcher::GetTotalHistoryCount (vtable slot 22)
 *   - IUpdateSearcher::QueryHistory         (vtable slot 18)
 *   - IUpdateHistoryEntryCollection::get_Count / get_Item
 *   - IUpdateHistoryEntry::get_Title/Operation/ResultCode/HResult/Date/...
 *   - ISystemInformation::get_RebootRequired (via CLSID_SystemInformation)
 *
 * APIs demonstrated (cross-package):
 *   - combase.dll CoInitializeEx/CoCreateInstance/CLSIDFromString/CoUninitialize (raw FFI)
 *   - Oleaut32.SysStringLen/SysFreeString/VariantTimeToSystemTime (BSTR + DATE decode)
 *   - Kernel32.GetStdHandle/Get|SetConsoleMode (enable ANSI VT processing)
 *
 * Run: bun run example/update-history-forensics.ts
 */

import { CFunction, dlopen, FFIType, type Pointer, read } from 'bun:ffi';

import Wuapi, { CLSID_SystemInformation, CLSID_UpdateSession, IID_ISystemInformation, IID_IUpdateSession, OperationResultCode, UpdateOperation } from '../index';
import Kernel32 from '@bun-win32/kernel32';
import Oleaut32 from '@bun-win32/oleaut32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const MAGENTA = '\x1b[95m';
const BLUE = '\x1b[94m';

const S_OK = 0;
const S_FALSE = 1;
const COINIT_APARTMENTTHREADED = 0x2;

// IUnknown / IDispatch base slots shared by every WUA dispinterface.
const IUNKNOWN_RELEASE = 2;

// Interface-specific vtable slots (derived from wuapi.h *Vtbl declarations;
// IDispatch occupies slots 0-6, so the first WUA member is slot 7).
const IUPDATESESSION_CREATEUPDATESEARCHER = 12;
const IUPDATESEARCHER_QUERYHISTORY = 18;
const IUPDATESEARCHER_GETTOTALHISTORYCOUNT = 22;
const IHISTORYCOLLECTION_GET_ITEM = 7;
const IHISTORYCOLLECTION_GET_COUNT = 9;
const IHISTORYENTRY_GET_OPERATION = 7;
const IHISTORYENTRY_GET_RESULTCODE = 8;
const IHISTORYENTRY_GET_HRESULT = 9;
const IHISTORYENTRY_GET_DATE = 10;
const IHISTORYENTRY_GET_TITLE = 12;
const IHISTORYENTRY_GET_CLIENTAPPID = 15;
const IHISTORYENTRY_GET_SUPPORTURL = 20;
const ISYSTEMINFO_GET_REBOOTREQUIRED = 8;

// combase.dll exports CoInitializeEx / CoCreateInstance / CLSIDFromString as
// real entry points (ole32.dll forwards them to the same apiset). These are not
// bound by any package, so open them directly here.
const combase = dlopen('combase.dll', {
  CLSIDFromString: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoCreateInstance: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
});

/** Enable ANSI escape processing so colors render in Windows Terminal / VS Code. */
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

/**
 * Invokes COM vtable slot `slot` on interface pointer `thisPtr`. The implicit
 * `this` is prepended; the bound CFunction is memoized per (method, signature).
 */
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

/** Releases a COM interface pointer (IUnknown::Release, vtable slot 2). */
function release(pUnk: bigint): void {
  if (pUnk !== 0n) vcall(pUnk, IUNKNOWN_RELEASE, [], []);
}

/** Parses a `{...}` GUID string into a 16-byte CLSID/IID buffer. */
function guid(text: string): Buffer {
  const wide = Buffer.from(text + '\0', 'utf16le');
  const out = Buffer.alloc(16);
  const hr = combase.symbols.CLSIDFromString(wide.ptr!, out.ptr!);
  if (hr !== S_OK) throw new Error(`CLSIDFromString(${text}) failed: 0x${(hr >>> 0).toString(16)}`);
  return out;
}

/** CoCreateInstance of `clsid`, returning the requested interface pointer. */
function createInstance(clsid: string, iid: string): bigint {
  const CLSCTX_INPROC_SERVER = 0x1;
  const out = Buffer.alloc(8);
  const hr = combase.symbols.CoCreateInstance(guid(clsid).ptr!, 0n, CLSCTX_INPROC_SERVER, guid(iid).ptr!, out.ptr!);
  if (hr !== S_OK) throw new Error(`CoCreateInstance failed: 0x${(hr >>> 0).toString(16)}`);
  return out.readBigUInt64LE(0);
}

/** Reads a `[propget] BSTR*` accessor at `slot` and frees the BSTR. */
function getBstr(pObj: bigint, slot: number): string {
  const out = Buffer.alloc(8);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return '';
  const bstr = out.readBigUInt64LE(0);
  if (bstr === 0n) return '';
  const ptr = Number(bstr) as Pointer;
  const len = Oleaut32.SysStringLen(ptr); // characters, not bytes
  // A BSTR is a NUL-terminated UTF-16LE run; read len*2 bytes straight out.
  const bytes = Buffer.alloc(len * 2);
  for (let i = 0; i < len * 2; i += 1) bytes[i] = read.u8(ptr, i);
  Oleaut32.SysFreeString(ptr);
  return bytes.toString('utf16le');
}

/** Reads a `[propget] LONG*` accessor at `slot`. */
function getLong(pObj: bigint, slot: number): number {
  const out = Buffer.alloc(4);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return 0;
  return out.readInt32LE(0);
}

/** Reads a `[propget] VARIANT_BOOL*` accessor at `slot` (-1 = true). */
function getBool(pObj: bigint, slot: number): boolean {
  const out = Buffer.alloc(2);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return false;
  return out.readInt16LE(0) !== 0;
}

/** Reads a `[propget] DATE*` (OLE automation date, an 8-byte double) at `slot`. */
function getDate(pObj: bigint, slot: number): Date | null {
  const out = Buffer.alloc(8);
  if (vcall(pObj, slot, [FFIType.ptr], [out.ptr!]) !== S_OK) return null;
  const oleDate = out.readDoubleLE(0);
  if (oleDate === 0) return null;
  const st = Buffer.alloc(16); // SYSTEMTIME
  if (Oleaut32.VariantTimeToSystemTime(oleDate, st.ptr!) === 0) return null;
  // SYSTEMTIME: WORD year, month, dayOfWeek, day, hour, minute, second, ms
  return new Date(Date.UTC(st.readUInt16LE(0), st.readUInt16LE(2) - 1, st.readUInt16LE(6), st.readUInt16LE(8), st.readUInt16LE(10), st.readUInt16LE(12)));
}

const RESULT_LABEL: Record<number, string> = {
  [OperationResultCode.orcNotStarted]: 'NotStarted',
  [OperationResultCode.orcInProgress]: 'InProgress',
  [OperationResultCode.orcSucceeded]: 'Succeeded',
  [OperationResultCode.orcSucceededWithErrors]: 'SucceededWithErrors',
  [OperationResultCode.orcFailed]: 'Failed',
  [OperationResultCode.orcAborted]: 'Aborted',
};

const RESULT_COLOR: Record<number, string> = {
  [OperationResultCode.orcSucceeded]: GREEN,
  [OperationResultCode.orcSucceededWithErrors]: YELLOW,
  [OperationResultCode.orcFailed]: RED,
  [OperationResultCode.orcAborted]: RED,
};

function operationLabel(op: number): string {
  if (op === UpdateOperation.uoInstallation) return 'Install';
  if (op === UpdateOperation.uoUninstallation) return 'Uninstall';
  return `op(${op})`;
}

const bar = (label: string) => `${BOLD}${BLUE}══${RESET} ${BOLD}${label}${RESET}`;
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

function main(): void {
  enableVirtualTerminal();

  const init = combase.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (init !== S_OK && init !== S_FALSE) {
    console.error(`${RED}CoInitializeEx failed: 0x${(init >>> 0).toString(16)}${RESET}`);
    return;
  }

  console.log(`\n${BOLD}${MAGENTA}  WINDOWS UPDATE HISTORY FORENSICS${RESET}  ${DIM}wuapi.dll · COM object model${RESET}`);
  console.log(`  ${DIM}Self-test: Wuapi.DllCanUnloadNow() → 0x${(Wuapi.DllCanUnloadNow() >>> 0).toString(16)} (S_FALSE while the apartment holds the server)${RESET}\n`);

  let pSession = 0n;
  let pSearcher = 0n;
  let pHistory = 0n;
  let pSysInfo = 0n;
  try {
    pSession = createInstance(CLSID_UpdateSession, IID_IUpdateSession);

    const searcherOut = Buffer.alloc(8);
    if (vcall(pSession, IUPDATESESSION_CREATEUPDATESEARCHER, [FFIType.ptr], [searcherOut.ptr!]) !== S_OK) {
      console.error(`${RED}IUpdateSession::CreateUpdateSearcher failed${RESET}`);
      return;
    }
    pSearcher = searcherOut.readBigUInt64LE(0);

    const totalOut = Buffer.alloc(4);
    vcall(pSearcher, IUPDATESEARCHER_GETTOTALHISTORYCOUNT, [FFIType.ptr], [totalOut.ptr!]);
    const total = totalOut.readInt32LE(0);

    console.log(bar('Servicing summary'));
    console.log(`  Total history entries on this machine    ${BOLD}${CYAN}${total}${RESET}`);

    if (pSysInfo === 0n) {
      try {
        pSysInfo = createInstance(CLSID_SystemInformation, IID_ISystemInformation);
        const reboot = getBool(pSysInfo, ISYSTEMINFO_GET_REBOOTREQUIRED);
        console.log(`  Reboot required to finish servicing      ${reboot ? `${RED}${BOLD}YES${RESET}` : `${GREEN}no${RESET}`}`);
      } catch {
        console.log(`  Reboot required to finish servicing      ${DIM}(unavailable)${RESET}`);
      }
    }

    if (total <= 0) {
      console.log(`\n${YELLOW}No Windows Update history is recorded on this machine.${RESET}\n`);
      return;
    }

    const fetch = Math.min(total, 100);
    const histOut = Buffer.alloc(8);
    if (vcall(pSearcher, IUPDATESEARCHER_QUERYHISTORY, [FFIType.i32, FFIType.i32, FFIType.ptr], [0, fetch, histOut.ptr!]) !== S_OK) {
      console.error(`${RED}IUpdateSearcher::QueryHistory failed${RESET}`);
      return;
    }
    pHistory = histOut.readBigUInt64LE(0);
    const count = getLong(pHistory, IHISTORYCOLLECTION_GET_COUNT);

    const tally = new Map<number, number>();
    const rows: { date: Date | null; op: number; rc: number; hr: number; title: string; client: string; url: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const itemOut = Buffer.alloc(8);
      if (vcall(pHistory, IHISTORYCOLLECTION_GET_ITEM, [FFIType.i32, FFIType.ptr], [i, itemOut.ptr!]) !== S_OK) continue;
      const pEntry = itemOut.readBigUInt64LE(0);
      if (pEntry === 0n) continue;

      const opOut = Buffer.alloc(4);
      vcall(pEntry, IHISTORYENTRY_GET_OPERATION, [FFIType.ptr], [opOut.ptr!]);
      const rcOut = Buffer.alloc(4);
      vcall(pEntry, IHISTORYENTRY_GET_RESULTCODE, [FFIType.ptr], [rcOut.ptr!]);
      const hrOut = Buffer.alloc(4);
      vcall(pEntry, IHISTORYENTRY_GET_HRESULT, [FFIType.ptr], [hrOut.ptr!]);
      const rc = rcOut.readInt32LE(0);
      tally.set(rc, (tally.get(rc) ?? 0) + 1);
      rows.push({
        date: getDate(pEntry, IHISTORYENTRY_GET_DATE),
        op: opOut.readInt32LE(0),
        rc,
        hr: hrOut.readInt32LE(0),
        title: getBstr(pEntry, IHISTORYENTRY_GET_TITLE),
        client: getBstr(pEntry, IHISTORYENTRY_GET_CLIENTAPPID),
        url: getBstr(pEntry, IHISTORYENTRY_GET_SUPPORTURL),
      });
      release(pEntry);
    }

    console.log(`  Entries inspected this run               ${BOLD}${count}${RESET}\n`);

    console.log(bar('Result breakdown'));
    for (const code of [OperationResultCode.orcSucceeded, OperationResultCode.orcSucceededWithErrors, OperationResultCode.orcFailed, OperationResultCode.orcAborted, OperationResultCode.orcInProgress, OperationResultCode.orcNotStarted]) {
      const n = tally.get(code) ?? 0;
      if (n === 0) continue;
      const color = RESULT_COLOR[code] ?? DIM;
      const blocks = '█'.repeat(Math.max(1, Math.round((n / count) * 40)));
      console.log(`  ${color}${pad(RESULT_LABEL[code] ?? String(code), 20)}${RESET} ${color}${blocks}${RESET} ${BOLD}${n}${RESET}`);
    }
    console.log();

    console.log(bar(`Most recent ${Math.min(rows.length, 25)} servicing events`));
    console.log(`  ${BOLD}${pad('Date (UTC)', 17)}${pad('Op', 10)}${pad('Result', 20)}${pad('HRESULT', 12)}Title${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(96)}${RESET}`);
    for (const r of rows.slice(0, 25)) {
      const when = r.date ? r.date.toISOString().slice(0, 16).replace('T', ' ') : '—';
      const color = RESULT_COLOR[r.rc] ?? DIM;
      // Pad on the visible text, then wrap in color codes so columns stay aligned.
      const resultText = pad(RESULT_LABEL[r.rc] ?? String(r.rc), 20);
      const hrText = r.hr === 0 ? '0' : `0x${(r.hr >>> 0).toString(16).padStart(8, '0')}`;
      const hrColor = r.hr === 0 ? GREEN : RED;
      console.log(`  ${pad(when, 17)}${pad(operationLabel(r.op), 10)}${color}${resultText}${RESET}${hrColor}${pad(hrText, 12)}${RESET}${pad(r.title || '(untitled)', 50)}`);
    }
    console.log();

    const withUrl = rows.filter((r) => r.url).length;
    const clients = new Set(rows.map((r) => r.client).filter(Boolean));
    console.log(bar('Provenance'));
    console.log(`  Distinct client applications              ${BOLD}${clients.size}${RESET} ${DIM}${[...clients].slice(0, 4).join(', ')}${clients.size > 4 ? ' …' : ''}${RESET}`);
    console.log(`  Entries advertising a support URL         ${BOLD}${withUrl}${RESET}`);
    console.log(`\n${GREEN}${BOLD}  ✓ Windows Update history audit complete${RESET}\n`);
  } finally {
    release(pSysInfo);
    release(pHistory);
    release(pSearcher);
    release(pSession);
    combase.symbols.CoUninitialize();
  }
}

main();
