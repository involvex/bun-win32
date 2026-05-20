/**
 * OS Tomography — Live thread wait-chain visualization across every running process.
 *
 * A real-time x-ray of what every thread in every accessible process is waiting
 * on right now. Built on the Wait Chain Traversal (WCT) API from `wer.dll`. Each
 * accessible process is a card; each thread is a coloured dot inside it; each
 * dot's colour is the live kernel wait reason. The card border is the process's
 * overall posture: green if most threads are running, orange if many are blocked
 * on locks, teal if owning/waiting on dispatcher objects. Resampled twice a
 * second; rerendered at ~10 fps into a borderless 1400×900 DWM Mica window.
 *
 * Pipeline (per ~500 ms sample):
 *
 *   1. Psapi.EnumProcesses                                  list every PID
 *   2. For each: Kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION
 *      | PROCESS_VM_READ); Psapi.GetModuleBaseNameW + GetProcessMemoryInfo.
 *   3. Sort by working set; keep the top 30; close discarded handles.
 *   4. Kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD), Thread32First /
 *      Thread32Next: enumerate threads, filter to each kept PID.
 *   5. Wer.OpenThreadWaitChainSession + GetThreadWaitChain per thread: read the
 *      ObjectStatus of node 0 (the thread itself) — that's the wait reason.
 *   6. CloseThreadWaitChainSession + CloseHandle for every process.
 *
 * Each render (~100 ms): GdipGraphicsClear → fill cards + dots + labels → blit
 * via GdipCreateFromHDC + GdipDrawImageRectI to the window's DC.
 *
 * APIs touched: Wer (Open/Get/CloseThreadWaitChainSession), Psapi (EnumProcesses,
 * GetModuleBaseNameW, GetProcessMemoryInfo), Kernel32 (OpenProcess, CloseHandle,
 * CreateToolhelp32Snapshot, Thread32First/Next, GetCurrentProcessId,
 * GetModuleHandleW, SetConsoleCtrlHandler), User32 (window class + message loop
 * + timers + GetDC), Dwmapi (Mica backdrop + dark mode), Gdiplus (the entire
 * offscreen-bitmap-and-blit GDI+ flat pipeline).
 *
 * Controls: ESC or Ctrl+C to quit. Run: bun run example/os-tomography.ts
 */

import { JSCallback, type Pointer } from 'bun:ffi';

import { Dwmapi, Gdiplus, Kernel32, Psapi, User32, Wer } from '../index';
import { SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, PixelFormat32bppARGB, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { ProcessAccessRights } from '@bun-win32/kernel32';
import { ExtendedWindowStyles, PeekMessageRemoveFlag, ShowWindowCommand, SystemMetric, VirtualKey, WindowStyles } from '@bun-win32/user32';
import { WCT_OBJECT_STATUS, WCT_OUT_OF_PROC_COM_FLAG, WCT_OUT_OF_PROC_CS_FLAG, WCT_OUT_OF_PROC_FLAG } from '@bun-win32/wer';

// Window geometry + grid layout: 6 cols × 5 rows = 30 cards.
const WINDOW_WIDTH = 1400;
const WINDOW_HEIGHT = 900;
const FRAME_INTERVAL_MS = 100;
const SAMPLE_INTERVAL_MS = 500;
const TOP_PROCESS_COUNT = 30;
const GRID_COLUMNS = 6;
const GRID_ROWS = 5;
const GRID_OUTER_LEFT = 24;
const GRID_OUTER_TOP = 90;
const GRID_OUTER_RIGHT = 24;
const GRID_OUTER_BOTTOM = 88;
const CARD_GAP = 10;
const CARD_AREA_WIDTH = WINDOW_WIDTH - GRID_OUTER_LEFT - GRID_OUTER_RIGHT;
const CARD_AREA_HEIGHT = WINDOW_HEIGHT - GRID_OUTER_TOP - GRID_OUTER_BOTTOM;
const CARD_WIDTH = Math.floor((CARD_AREA_WIDTH - CARD_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
const CARD_HEIGHT = Math.floor((CARD_AREA_HEIGHT - CARD_GAP * (GRID_ROWS - 1)) / GRID_ROWS);

// Win32 message-pump constants + native struct sizes used below.
const WM_CLOSE = 0x0010;
const WM_DESTROY = 0x0002;
const WM_KEYDOWN = 0x0100;
const WM_QUIT = 0x0012;
const WM_TIMER = 0x0113;
const MSG_SIZE_BYTES = 48;
const TIMER_ID_SAMPLE = 1n;
const TIMER_ID_RENDER = 2n;
const TH32CS_SNAPTHREAD = 0x0000_0004;
// THREADENTRY32 (28B): dwSize+cntUsage+th32ThreadID@8+th32OwnerProcessID@12+...
const THREADENTRY32_SIZE = 28;
const THREADENTRY32_TID_OFFSET = 8;
const THREADENTRY32_OWNERPID_OFFSET = 12;
// PROCESS_MEMORY_COUNTERS (72B on x64): WorkingSetSize at +0x10.
const PROCESS_MEMORY_COUNTERS_SIZE = 72;
const PROCESS_MEMORY_COUNTERS_WORKINGSET_OFFSET = 0x10;
// WAITCHAIN_NODE_INFO (280B on x64): ObjectType@0, ObjectStatus@4, union @8.
const WAITCHAIN_NODE_SIZE = 280;
const WCT_MAX_NODES = 16;

const encodeWide = (text: string): Buffer => Buffer.from(`${text}\0`, 'utf16le');
const argb = (alpha: number, red: number, green: number, blue: number): number =>
  (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;
function check(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status]} (${status})`);
}
function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// Wait-reason colour table. Dot colours per thread + aggregate card border.
const STATUS_COLOURS: Record<number, number> = {
  [WCT_OBJECT_STATUS.WctStatusNoAccess]: argb(255, 0x55, 0x55, 0x66),
  [WCT_OBJECT_STATUS.WctStatusRunning]: argb(255, 0x6a, 0xd2, 0x7d),
  [WCT_OBJECT_STATUS.WctStatusBlocked]: argb(255, 0xff, 0xa5, 0x4b),
  [WCT_OBJECT_STATUS.WctStatusPidOnly]: argb(255, 0x8a, 0xc6, 0xff),
  [WCT_OBJECT_STATUS.WctStatusPidOnlyRpcss]: argb(255, 0x6e, 0xb6, 0xf2),
  [WCT_OBJECT_STATUS.WctStatusOwned]: argb(255, 0xc7, 0x9b, 0xff),
  [WCT_OBJECT_STATUS.WctStatusNotOwned]: argb(255, 0x7c, 0xe0, 0xd6),
  [WCT_OBJECT_STATUS.WctStatusAbandoned]: argb(255, 0xff, 0x6b, 0x6b),
  [WCT_OBJECT_STATUS.WctStatusUnknown]: argb(255, 0x99, 0x99, 0xaa),
  [WCT_OBJECT_STATUS.WctStatusError]: argb(255, 0xff, 0x33, 0x33),
};
const STATUS_LABELS: Record<number, string> = {
  [WCT_OBJECT_STATUS.WctStatusNoAccess]: 'NoAccess',
  [WCT_OBJECT_STATUS.WctStatusRunning]: 'Running',
  [WCT_OBJECT_STATUS.WctStatusBlocked]: 'Blocked',
  [WCT_OBJECT_STATUS.WctStatusPidOnly]: 'PidOnly',
  [WCT_OBJECT_STATUS.WctStatusPidOnlyRpcss]: 'PidOnlyRpcss',
  [WCT_OBJECT_STATUS.WctStatusOwned]: 'Owned',
  [WCT_OBJECT_STATUS.WctStatusNotOwned]: 'NotOwned',
  [WCT_OBJECT_STATUS.WctStatusAbandoned]: 'Abandoned',
  [WCT_OBJECT_STATUS.WctStatusUnknown]: 'Unknown',
  [WCT_OBJECT_STATUS.WctStatusError]: 'Error',
};
const STATUS_RENDER_ORDER = [
  WCT_OBJECT_STATUS.WctStatusRunning, WCT_OBJECT_STATUS.WctStatusBlocked,
  WCT_OBJECT_STATUS.WctStatusOwned, WCT_OBJECT_STATUS.WctStatusNotOwned,
  WCT_OBJECT_STATUS.WctStatusPidOnly, WCT_OBJECT_STATUS.WctStatusPidOnlyRpcss,
  WCT_OBJECT_STATUS.WctStatusAbandoned, WCT_OBJECT_STATUS.WctStatusError,
  WCT_OBJECT_STATUS.WctStatusUnknown, WCT_OBJECT_STATUS.WctStatusNoAccess,
];

const COLOUR_BACKDROP = argb(220, 0x10, 0x12, 0x1a);
const COLOUR_CARD_FILL = argb(180, 0x1e, 0x21, 0x2e);
const COLOUR_CARD_BORDER_DEFAULT = argb(220, 0x3a, 0x40, 0x55);
const COLOUR_HEADING = argb(255, 0xff, 0xff, 0xff);
const COLOUR_SUBTLE = argb(180, 0xa0, 0xa8, 0xc0);
const COLOUR_DIM = argb(160, 0x88, 0x90, 0xa8);
const COLOUR_ACCENT = argb(255, 0x8a, 0xc6, 0xff);
const COLOUR_MEMORY_BAR = argb(255, 0x6e, 0xb6, 0xf2);

// ── Process / thread sampler ──────────────────────────────────────────────────

interface ThreadSample {
  threadId: number;
  status: number;
}

interface ProcessSample {
  pid: number;
  name: string;
  workingSetBytes: number;
  threads: ThreadSample[];
  // Quick counts for the card border colour.
  runningCount: number;
  blockedCount: number;
  ownershipCount: number;
  noAccessCount: number;
}

interface Snapshot {
  processes: ProcessSample[];
  totalPids: number;
  accessibleProcesses: number;
  totalThreads: number;
  totalRunning: number;
  totalBlocked: number;
  totalNoAccess: number;
  sampledAtMs: number;
  sampleDurationMs: number;
}

const pidBuffer = Buffer.alloc(65_536); // room for ~16,000 PIDs
const pidSizeNeededBuffer = Buffer.alloc(4);
const moduleBaseNameBuffer = Buffer.alloc(520);
const memoryCountersBuffer = Buffer.alloc(PROCESS_MEMORY_COUNTERS_SIZE);
const threadEntryBuffer = Buffer.alloc(THREADENTRY32_SIZE);
const waitChainNodeBuffer = Buffer.alloc(WAITCHAIN_NODE_SIZE * WCT_MAX_NODES);
const waitChainNodeCountBuffer = Buffer.alloc(4);
const waitChainIsCycleBuffer = Buffer.alloc(4);

const selfPid = Kernel32.GetCurrentProcessId();

function getProcessThreads(targetPid: number): number[] {
  // CreateToolhelp32Snapshot with TH32CS_SNAPTHREAD takes a snapshot of every
  // thread on the system; we filter to threads owned by `targetPid`.
  const snapshot = Kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot === 0n || snapshot === 0xffff_ffff_ffff_ffffn) return [];

  const threads: number[] = [];
  try {
    threadEntryBuffer.fill(0);
    threadEntryBuffer.writeUInt32LE(THREADENTRY32_SIZE, 0); // dwSize
    let more = Kernel32.Thread32First(snapshot, threadEntryBuffer.ptr);
    while (more) {
      const ownerPid = threadEntryBuffer.readUInt32LE(THREADENTRY32_OWNERPID_OFFSET);
      if (ownerPid === targetPid) {
        threads.push(threadEntryBuffer.readUInt32LE(THREADENTRY32_TID_OFFSET));
      }
      more = Kernel32.Thread32Next(snapshot, threadEntryBuffer.ptr);
    }
  } finally {
    Kernel32.CloseHandle(snapshot);
  }
  return threads;
}

function sampleWaitStatus(wctSession: bigint, threadId: number): number {
  waitChainNodeBuffer.fill(0);
  waitChainNodeCountBuffer.writeUInt32LE(WCT_MAX_NODES, 0);
  waitChainIsCycleBuffer.writeUInt32LE(0, 0);

  // Synchronous session → Context is unused (0n). Ask WCT to follow the chain
  // across thread/process boundaries and to read cross-thread critical-section
  // and COM ownership.
  const flags = WCT_OUT_OF_PROC_FLAG | WCT_OUT_OF_PROC_CS_FLAG | WCT_OUT_OF_PROC_COM_FLAG;
  const ok = Wer.GetThreadWaitChain(
    wctSession,
    0n,
    flags,
    threadId,
    waitChainNodeCountBuffer.ptr,
    waitChainNodeBuffer.ptr,
    waitChainIsCycleBuffer.ptr,
  );
  if (!ok) return WCT_OBJECT_STATUS.WctStatusNoAccess;

  const count = waitChainNodeCountBuffer.readUInt32LE(0);
  if (count === 0) return WCT_OBJECT_STATUS.WctStatusUnknown;

  // Node 0 represents the queried thread itself; its ObjectStatus is the wait
  // reason we want to colour-code.
  return waitChainNodeBuffer.readInt32LE(4);
}

function takeSnapshot(): Snapshot {
  const startedAtMs = Date.now();

  // 1. Enumerate every PID on the system.
  pidSizeNeededBuffer.writeUInt32LE(0, 0);
  if (!Psapi.EnumProcesses(pidBuffer.ptr, pidBuffer.byteLength, pidSizeNeededBuffer.ptr)) {
    return {
      processes: [],
      totalPids: 0,
      accessibleProcesses: 0,
      totalThreads: 0,
      totalRunning: 0,
      totalBlocked: 0,
      totalNoAccess: 0,
      sampledAtMs: startedAtMs,
      sampleDurationMs: 0,
    };
  }
  const pidByteCount = pidSizeNeededBuffer.readUInt32LE(0);
  const totalPids = Math.floor(pidByteCount / 4);

  // 2. Walk every PID, retain accessible ones with their working-set bytes.
  interface PreliminaryProcess {
    pid: number;
    name: string;
    handle: bigint;
    workingSetBytes: number;
  }
  const accessible: PreliminaryProcess[] = [];

  for (let i = 0; i < totalPids; i++) {
    const pid = pidBuffer.readUInt32LE(i * 4);
    if (pid === 0) continue; // System Idle Process
    if (pid === selfPid) continue; // skip self (a tiny bit cleaner; we still see all others)

    const handle = Kernel32.OpenProcess(
      ProcessAccessRights.PROCESS_QUERY_LIMITED_INFORMATION | ProcessAccessRights.PROCESS_VM_READ,
      0,
      pid,
    );
    if (!handle || handle === 0n) continue;

    let workingSetBytes = 0;
    memoryCountersBuffer.fill(0);
    memoryCountersBuffer.writeUInt32LE(PROCESS_MEMORY_COUNTERS_SIZE, 0); // cb
    if (Psapi.GetProcessMemoryInfo(handle, memoryCountersBuffer.ptr, PROCESS_MEMORY_COUNTERS_SIZE)) {
      workingSetBytes = Number(memoryCountersBuffer.readBigUInt64LE(PROCESS_MEMORY_COUNTERS_WORKINGSET_OFFSET));
    }

    // Read the executable's base name (e.g. "explorer.exe") via the loaded
    // image of the process (hModule = 0n means "the .exe itself").
    moduleBaseNameBuffer.fill(0);
    const nameLen = Psapi.GetModuleBaseNameW(handle, 0n, moduleBaseNameBuffer.ptr, 260);
    const name = nameLen > 0 ? moduleBaseNameBuffer.subarray(0, nameLen * 2).toString('utf16le') : `pid${pid}`;

    accessible.push({ pid, name, handle, workingSetBytes });
  }

  // 3. Keep the top N by working set; close the handles of the discarded ones.
  accessible.sort((a, b) => b.workingSetBytes - a.workingSetBytes);
  const kept = accessible.slice(0, TOP_PROCESS_COUNT);
  for (let i = TOP_PROCESS_COUNT; i < accessible.length; i++) {
    Kernel32.CloseHandle(accessible[i]!.handle);
  }

  // 4. Open one WCT session and sample every thread of every kept process.
  const processes: ProcessSample[] = [];
  let totalThreads = 0;
  let totalRunning = 0;
  let totalBlocked = 0;
  let totalNoAccess = 0;

  const wctSession = Wer.OpenThreadWaitChainSession(0, null);
  try {
    for (const proc of kept) {
      const tids = getProcessThreads(proc.pid);
      const threads: ThreadSample[] = [];
      let runningCount = 0;
      let blockedCount = 0;
      let ownershipCount = 0;
      let noAccessCount = 0;

      // If the WCT session failed to open, fall back to a NoAccess marker for
      // every thread — the snapshot stays well-defined.
      if (wctSession === 0n) {
        for (const tid of tids) {
          threads.push({ threadId: tid, status: WCT_OBJECT_STATUS.WctStatusNoAccess });
          noAccessCount++;
        }
      } else {
        for (const tid of tids) {
          const status = sampleWaitStatus(wctSession, tid);
          threads.push({ threadId: tid, status });
          if (status === WCT_OBJECT_STATUS.WctStatusRunning) runningCount++;
          else if (status === WCT_OBJECT_STATUS.WctStatusBlocked) blockedCount++;
          else if (status === WCT_OBJECT_STATUS.WctStatusOwned || status === WCT_OBJECT_STATUS.WctStatusNotOwned) ownershipCount++;
          else if (status === WCT_OBJECT_STATUS.WctStatusNoAccess) noAccessCount++;
        }
      }

      processes.push({
        pid: proc.pid,
        name: proc.name,
        workingSetBytes: proc.workingSetBytes,
        threads,
        runningCount,
        blockedCount,
        ownershipCount,
        noAccessCount,
      });

      totalThreads += threads.length;
      totalRunning += runningCount;
      totalBlocked += blockedCount;
      totalNoAccess += noAccessCount;
    }
  } finally {
    if (wctSession !== 0n) Wer.CloseThreadWaitChainSession(wctSession);
    for (const proc of kept) Kernel32.CloseHandle(proc.handle);
  }

  return {
    processes,
    totalPids,
    accessibleProcesses: accessible.length,
    totalThreads,
    totalRunning,
    totalBlocked,
    totalNoAccess,
    sampledAtMs: startedAtMs,
    sampleDurationMs: Date.now() - startedAtMs,
  };
}

// ── Win32 window: WndProc + WNDCLASSEXW + CreateWindowExW + DWM polish. ──
let shouldClose = false;
const wndProcCallback = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_KEYDOWN && Number(wParam) === VirtualKey.VK_ESCAPE) {
      shouldClose = true;
      User32.PostQuitMessage(0);
      return 0n;
    }
    if (msg === WM_CLOSE) { shouldClose = true; User32.DestroyWindow(hWnd); return 0n; }
    if (msg === WM_DESTROY) { User32.PostQuitMessage(0); return 0n; }
    return User32.DefWindowProcW(hWnd, msg, wParam, lParam);
  },
  { args: ['u64', 'u32', 'u64', 'i64'], returns: 'i64' },
);

const className = encodeWide('BunOsTomography');
// WNDCLASSEXW (80B on x64). Pinned offsets are documented in MSDN.
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassBuffer.writeBigUInt64LE(BigInt(wndProcCallback.ptr!), 8); // lpfnWndProc
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr), 64); // lpszClassName
if (!User32.RegisterClassExW(wndClassBuffer.ptr)) {
  console.error('RegisterClassExW failed'); process.exit(1);
}

const screenWidth = User32.GetSystemMetrics(SystemMetric.SM_CXSCREEN);
const screenHeight = User32.GetSystemMetrics(SystemMetric.SM_CYSCREEN);
const windowX = Math.max(0, Math.floor((screenWidth - WINDOW_WIDTH) / 2));
const windowY = Math.max(0, Math.floor((screenHeight - WINDOW_HEIGHT) / 2));
const moduleHandle = Kernel32.GetModuleHandleW(null!);

const windowHandle = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_APPWINDOW,
  className.ptr,
  encodeWide('OS Tomography — Live Wait-Chain X-Ray').ptr,
  WindowStyles.WS_POPUP | WindowStyles.WS_VISIBLE,
  windowX, windowY, WINDOW_WIDTH, WINDOW_HEIGHT,
  0n, 0n, moduleHandle, null,
);
if (!windowHandle) { console.error('CreateWindowExW failed'); process.exit(1); }

// DWM polish: Mica system backdrop + dark-mode non-client region.
const backdropAttribute = Buffer.alloc(4);
backdropAttribute.writeInt32LE(SystemBackdropType.DWMSBT_MAINWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropAttribute.ptr, 4);
const darkModeAttribute = Buffer.alloc(4);
darkModeAttribute.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(windowHandle, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeAttribute.ptr, 4);

User32.ShowWindow(windowHandle, ShowWindowCommand.SW_SHOW);
User32.UpdateWindow(windowHandle);

// ── GDI+ setup: startup token, offscreen ARGB bitmap, Graphics context, fonts. ──
Gdiplus.Preload();
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion = 1
check(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr, gdiplusStartupInput.ptr, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

function gdipNew(call: (ptr: Pointer) => number, where: string): bigint {
  const buffer = Buffer.alloc(8);
  check(call(buffer.ptr), where);
  return buffer.readBigUInt64LE(0);
}

const offscreenBitmap = gdipNew(
  (p) => Gdiplus.GdipCreateBitmapFromScan0(WINDOW_WIDTH, WINDOW_HEIGHT, 0, PixelFormat32bppARGB, null, p),
  'GdipCreateBitmapFromScan0',
);
const offscreenGraphics = gdipNew((p) => Gdiplus.GdipGetImageGraphicsContext(offscreenBitmap, p), 'GdipGetImageGraphicsContext');
check(Gdiplus.GdipSetSmoothingMode(offscreenGraphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
check(Gdiplus.GdipSetTextRenderingHint(offscreenGraphics, TextRenderingHint.TextRenderingHintAntiAliasGridFit), 'GdipSetTextRenderingHint');

const fontFamilyName = encodeWide('Segoe UI');
const fontFamily = gdipNew((p) => Gdiplus.GdipCreateFontFamilyFromName(fontFamilyName.ptr, 0n, p), 'GdipCreateFontFamilyFromName');
const makeFont = (sizePx: number, style: FontStyle): bigint =>
  gdipNew((p) => Gdiplus.GdipCreateFont(fontFamily, sizePx, style, Unit.UnitPixel, p), `GdipCreateFont(${sizePx})`);
const fontTitle = makeFont(22, FontStyle.FontStyleBold);
const fontSubtitle = makeFont(13, FontStyle.FontStyleRegular);
const fontCardName = makeFont(13, FontStyle.FontStyleBold);
const fontCardMeta = makeFont(11, FontStyle.FontStyleRegular);
const fontLegend = makeFont(12, FontStyle.FontStyleRegular);

const stringFormatLeft = gdipNew((p) => Gdiplus.GdipCreateStringFormat(0, 0, p), 'GdipCreateStringFormat (left)');
Gdiplus.GdipSetStringFormatAlign(stringFormatLeft, StringAlignment.StringAlignmentNear);
Gdiplus.GdipSetStringFormatLineAlign(stringFormatLeft, StringAlignment.StringAlignmentNear);
const stringFormatRight = gdipNew((p) => Gdiplus.GdipCreateStringFormat(0, 0, p), 'GdipCreateStringFormat (right)');
Gdiplus.GdipSetStringFormatAlign(stringFormatRight, StringAlignment.StringAlignmentFar);
Gdiplus.GdipSetStringFormatLineAlign(stringFormatRight, StringAlignment.StringAlignmentNear);

// Reusable layout rect — passed by-pointer to GDI+ every draw call.
const reusableRect = Buffer.alloc(16);
function writeRect(x: number, y: number, w: number, h: number): Pointer {
  reusableRect.writeFloatLE(x, 0); reusableRect.writeFloatLE(y, 4);
  reusableRect.writeFloatLE(w, 8); reusableRect.writeFloatLE(h, 12);
  return reusableRect.ptr;
}

// ── GDI+ draw helpers (each owns its brush/pen for the call). ──
function fillRect(x: number, y: number, w: number, h: number, color: number): void {
  const brush = gdipNew((p) => Gdiplus.GdipCreateSolidFill(color, p), 'GdipCreateSolidFill');
  Gdiplus.GdipFillRectangle(offscreenGraphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}
function drawRect(x: number, y: number, w: number, h: number, color: number, thickness: number): void {
  const pen = gdipNew((p) => Gdiplus.GdipCreatePen1(color, thickness, Unit.UnitPixel, p), 'GdipCreatePen1');
  Gdiplus.GdipDrawRectangleI(offscreenGraphics, pen, x, y, w, h);
  Gdiplus.GdipDeletePen(pen);
}
function fillEllipse(x: number, y: number, w: number, h: number, color: number): void {
  const brush = gdipNew((p) => Gdiplus.GdipCreateSolidFill(color, p), 'GdipCreateSolidFill');
  Gdiplus.GdipFillEllipseI(offscreenGraphics, brush, x, y, w, h);
  Gdiplus.GdipDeleteBrush(brush);
}

function drawText(text: string, font: bigint, x: number, y: number, w: number, h: number, color: number, alignRight = false): void {
  const brush = gdipNew((p) => Gdiplus.GdipCreateSolidFill(color, p), 'GdipCreateSolidFill');
  const wideText = encodeWide(text);
  const format = alignRight ? stringFormatRight : stringFormatLeft;
  Gdiplus.GdipDrawString(offscreenGraphics, wideText.ptr, -1, font, writeRect(x, y, w, h), format, brush);
  Gdiplus.GdipDeleteBrush(brush);
}

const truncate = (text: string, n: number): string =>
  text.length <= n ? text : text.slice(0, Math.max(1, n - 1)) + '…';

// Card-border colour = the process's overall thread posture.
function cardBorderColour(proc: ProcessSample): number {
  const total = proc.threads.length;
  if (total === 0) return COLOUR_CARD_BORDER_DEFAULT;
  if (proc.noAccessCount / total > 0.6) return argb(220, 0x44, 0x4a, 0x60);
  if (proc.blockedCount / total > 0.4) return STATUS_COLOURS[WCT_OBJECT_STATUS.WctStatusBlocked]!;
  if (proc.ownershipCount / total > 0.35) return STATUS_COLOURS[WCT_OBJECT_STATUS.WctStatusNotOwned]!;
  if (proc.runningCount / total > 0.25) return STATUS_COLOURS[WCT_OBJECT_STATUS.WctStatusRunning]!;
  return STATUS_COLOURS[WCT_OBJECT_STATUS.WctStatusPidOnly]!;
}

// ── Renderer ──
let latestSnapshot: Snapshot | null = null;
let snapshotCount = 0;

function renderFrame(): void {
  Gdiplus.GdipGraphicsClear(offscreenGraphics, COLOUR_BACKDROP);

  // Title + subtitle + HUD strip + refresh tag (right-aligned).
  drawText('OS Tomography', fontTitle, 24, 16, 600, 36, COLOUR_HEADING);
  drawText('live wait-chain x-ray of every accessible process · powered by @bun-win32/wer',
    fontSubtitle, 24, 50, 900, 22, COLOUR_SUBTLE);
  const hud = latestSnapshot
    ? `${latestSnapshot.processes.length} cards · ${latestSnapshot.accessibleProcesses}/${latestSnapshot.totalPids} accessible · ${latestSnapshot.totalThreads} threads · ${latestSnapshot.totalRunning} running · ${latestSnapshot.totalBlocked} blocked · sampled in ${latestSnapshot.sampleDurationMs}ms`
    : 'collecting first sample…';
  drawText(hud, fontSubtitle, 24, 70, WINDOW_WIDTH - 48, 18, COLOUR_DIM);
  const refreshTag = `#${snapshotCount.toString().padStart(4, '0')}  ESC = quit`;
  drawText(refreshTag, fontSubtitle, 0, 16, WINDOW_WIDTH - 24, 22, COLOUR_ACCENT, true);

  // Process cards.
  if (latestSnapshot && latestSnapshot.processes.length > 0) {
    const procs = latestSnapshot.processes;
    const maxWorkingSet = procs.reduce((m, p) => (p.workingSetBytes > m ? p.workingSetBytes : m), 1);
    for (let i = 0; i < procs.length; i++) {
      const col = i % GRID_COLUMNS;
      const row = Math.floor(i / GRID_COLUMNS);
      if (row >= GRID_ROWS) break;
      renderCard(procs[i]!,
        GRID_OUTER_LEFT + col * (CARD_WIDTH + CARD_GAP),
        GRID_OUTER_TOP + row * (CARD_HEIGHT + CARD_GAP),
        maxWorkingSet);
    }
  }

  renderLegend(GRID_OUTER_LEFT, WINDOW_HEIGHT - GRID_OUTER_BOTTOM + 16);
  blitToWindow();
}

function renderCard(proc: ProcessSample, x: number, y: number, maxWorkingSet: number): void {
  // Card background + coloured border.
  fillRect(x, y, CARD_WIDTH, CARD_HEIGHT, COLOUR_CARD_FILL);
  drawRect(x, y, CARD_WIDTH - 1, CARD_HEIGHT - 1, cardBorderColour(proc), 1.5);

  // Title row: name (truncated) + pid (right-aligned).
  const padding = 8;
  const headerY = y + 4;
  drawText(truncate(proc.name, 22), fontCardName, x + padding, headerY, CARD_WIDTH - padding * 2 - 50, 18, COLOUR_HEADING);
  drawText(`pid ${proc.pid}`, fontCardMeta, x + padding, headerY + 2, CARD_WIDTH - padding * 2, 18, COLOUR_SUBTLE, /* alignRight */ true);

  // Memory bar.
  const barTop = y + 26;
  const barLeft = x + padding;
  const barWidth = CARD_WIDTH - padding * 2;
  const barHeight = 6;
  fillRect(barLeft, barTop, barWidth, barHeight, argb(120, 0x2a, 0x30, 0x42));
  const fillPx = Math.round(barWidth * Math.min(1, proc.workingSetBytes / maxWorkingSet));
  if (fillPx > 0) fillRect(barLeft, barTop, fillPx, barHeight, COLOUR_MEMORY_BAR);

  // Memory label.
  drawText(formatBytes(proc.workingSetBytes), fontCardMeta, barLeft, barTop + barHeight + 2, barWidth, 14, COLOUR_DIM);
  drawText(`${proc.threads.length} thr`, fontCardMeta, barLeft, barTop + barHeight + 2, barWidth, 14, COLOUR_SUBTLE, /* alignRight */ true);

  // Per-thread dots. Lay them out in a compact grid inside the lower half of
  // the card; one dot per thread, coloured by wait reason.
  const dotsTop = barTop + barHeight + 22;
  const dotsBottom = y + CARD_HEIGHT - 6;
  const dotsHeight = dotsBottom - dotsTop;
  const dotsWidth = CARD_WIDTH - padding * 2;
  if (proc.threads.length > 0 && dotsHeight > 4 && dotsWidth > 4) {
    // Pick a dot size that lets all threads fit; clamp between 4 and 10 px.
    const totalThreads = proc.threads.length;
    const targetSpacing = Math.sqrt((dotsWidth * dotsHeight) / Math.max(1, totalThreads));
    const dotSize = clamp(Math.floor(targetSpacing * 0.6), 4, 10);
    const stride = dotSize + 2;
    const cols = Math.max(1, Math.floor(dotsWidth / stride));
    const dotsOriginX = barLeft;
    const dotsOriginY = dotsTop;
    for (let k = 0; k < totalThreads; k++) {
      const dx = (k % cols) * stride;
      const dy = Math.floor(k / cols) * stride;
      if (dy + dotSize > dotsHeight) break; // overflow: cap silently
      const status = proc.threads[k]!.status;
      const colour = STATUS_COLOURS[status] ?? STATUS_COLOURS[WCT_OBJECT_STATUS.WctStatusUnknown]!;
      fillEllipse(dotsOriginX + dx, dotsOriginY + dy, dotSize, dotSize, colour);
    }
  }
}

function renderLegend(originX: number, originY: number): void {
  drawText('LEGEND — WCT_OBJECT_STATUS (Wait Chain Traversal wait reason of each thread)',
    fontSubtitle, originX, originY - 18, WINDOW_WIDTH - originX * 2, 16, COLOUR_SUBTLE);

  const swatchSize = 12;
  const swatchSpacing = 6;
  let cursorX = originX;
  const cursorY = originY;

  for (const status of STATUS_RENDER_ORDER) {
    const colour = STATUS_COLOURS[status]!;
    const label = STATUS_LABELS[status]!;
    fillEllipse(cursorX, cursorY + 2, swatchSize, swatchSize, colour);
    cursorX += swatchSize + swatchSpacing;
    // Approximate text width to advance the cursor.
    const labelWidth = 8 + label.length * 7;
    drawText(label, fontLegend, cursorX, cursorY, labelWidth, 18, COLOUR_HEADING);
    cursorX += labelWidth + 18;
  }
}

function blitToWindow(): void {
  const windowDc = User32.GetDC(windowHandle);
  if (!windowDc) return;
  const windowGraphicsHandleBuffer = Buffer.alloc(8);
  if (Gdiplus.GdipCreateFromHDC(windowDc, windowGraphicsHandleBuffer.ptr) === Status.Ok) {
    const windowGraphics = windowGraphicsHandleBuffer.readBigUInt64LE(0);
    Gdiplus.GdipDrawImageRectI(windowGraphics, offscreenBitmap, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
    Gdiplus.GdipDeleteGraphics(windowGraphics);
  }
  User32.ReleaseDC(windowHandle, windowDc);
}

// ── Sampling + render timers ──────────────────────────────────────────────────

User32.SetTimer(windowHandle, TIMER_ID_SAMPLE, SAMPLE_INTERVAL_MS, null);
User32.SetTimer(windowHandle, TIMER_ID_RENDER, FRAME_INTERVAL_MS, null);

// Take an initial sample synchronously so the first frame has something to draw.
latestSnapshot = takeSnapshot();
snapshotCount = 1;
renderFrame();

// ── Ctrl+C teardown ───────────────────────────────────────────────────────────

const ctrlHandler = new JSCallback(
  (_dwCtrlType: number): number => {
    shouldClose = true;
    User32.PostQuitMessage(0);
    return 1; // TRUE — handled
  },
  { args: ['u32'], returns: 'i32' },
);
Kernel32.SetConsoleCtrlHandler(ctrlHandler.ptr!, 1);

// ── Main message + sample loop ────────────────────────────────────────────────

console.log('OS Tomography running. ESC (or Ctrl+C) to quit.');

const messageBuffer = Buffer.alloc(MSG_SIZE_BYTES);
const messageDataView = new DataView(messageBuffer.buffer);

while (!shouldClose) {
  // Drain pending messages. Timers come through here too.
  while (User32.PeekMessageW(messageBuffer.ptr, 0n, 0, 0, PeekMessageRemoveFlag.PM_REMOVE)) {
    const messageId = messageDataView.getUint32(8, true);
    if (messageId === WM_QUIT) {
      shouldClose = true;
      break;
    }
    if (messageId === WM_TIMER) {
      // wParam holds the timer id (8-byte value at offset 16 in MSG on x64).
      const timerId = messageDataView.getBigUint64(16, true);
      if (timerId === TIMER_ID_SAMPLE) {
        latestSnapshot = takeSnapshot();
        snapshotCount++;
      } else if (timerId === TIMER_ID_RENDER) {
        renderFrame();
      }
      // Don't dispatch; we handled it.
      continue;
    }
    User32.TranslateMessage(messageBuffer.ptr);
    User32.DispatchMessageW(messageBuffer.ptr);
  }
  if (shouldClose) break;
  // Yield ~5ms between PeekMessage drains to keep CPU low without harming responsiveness.
  Bun.sleepSync(5);
}

// ── Teardown ──────────────────────────────────────────────────────────────────

console.log('Cleaning up…');

User32.KillTimer(windowHandle, TIMER_ID_SAMPLE);
User32.KillTimer(windowHandle, TIMER_ID_RENDER);

Gdiplus.GdipDeleteFont(fontTitle);
Gdiplus.GdipDeleteFont(fontSubtitle);
Gdiplus.GdipDeleteFont(fontCardName);
Gdiplus.GdipDeleteFont(fontCardMeta);
Gdiplus.GdipDeleteFont(fontLegend);
Gdiplus.GdipDeleteFontFamily(fontFamily);
Gdiplus.GdipDeleteStringFormat(stringFormatLeft);
Gdiplus.GdipDeleteStringFormat(stringFormatRight);
Gdiplus.GdipDeleteGraphics(offscreenGraphics);
Gdiplus.GdipDisposeImage(offscreenBitmap);
Gdiplus.GdiplusShutdown(gdiplusToken);

if (windowHandle) User32.DestroyWindow(windowHandle);
User32.UnregisterClassW(className.ptr, 0n);
Kernel32.SetConsoleCtrlHandler(ctrlHandler.ptr!, 0);
ctrlHandler.close();
wndProcCallback.close();

console.log('Done.');
