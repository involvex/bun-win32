/**
 * Window X-Ray HUD - A live glass overlay that interrogates whatever window is
 * under the mouse cursor and renders the kernel's view of it as a floating
 * dashboard. Spy++ on steroids - but as a hovering HUD, painted with GDI+, and
 * driven entirely from TypeScript over `bun:ffi`.
 *
 * The HUD is a borderless, click-through, always-on-top, layered toolwindow
 * sized 460x420. A DWM `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_TRANSIENTWINDOW`
 * call asks the compositor for an acrylic backdrop, and `DWMWA_USE_IMMERSIVE_
 * DARK_MODE` flips the system caption-area to dark; combined with
 * `SetLayeredWindowAttributes(LWA_ALPHA)` this gives the whole HUD a frosted
 * dark-glass look behind the painted content. A `WS_EX_TRANSPARENT` extended
 * style passes every mouse event through to the window beneath, so the overlay
 * never steals input from the thing it is inspecting. A `SetTimer` callback
 * fires at ~50 Hz; each tick:
 *
 *   1.  `GetCursorPos` reads the screen-space cursor position.
 *   2.  `WindowFromPoint` resolves the top-most HWND under the pointer.
 *   3.  `GetAncestor(GA_ROOT)` walks to the owning root window so child
 *       controls do not flicker the readout.
 *   4.  `GetClassNameW`, `GetWindowTextW`, `GetWindowThreadProcessId`,
 *       `GetWindowRect`, `GetClientRect`, `GetWindowLongW(GWL_STYLE/EXSTYLE)`,
 *       and `IsWindowVisible` collect the window-side data.
 *   5.  `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ)`
 *       opens the owning process; `QueryFullProcessImageNameW` reads the
 *       full image path, `Psapi.GetModuleBaseNameW` gets the exe filename,
 *       and `Psapi.GetProcessMemoryInfo` fills a `PROCESS_MEMORY_COUNTERS`
 *       struct for working-set / peak-working-set readouts.
 *   6.  `Dwmapi.DwmGetWindowAttribute` reads `DWMWA_EXTENDED_FRAME_BOUNDS`
 *       (the bounds the compositor actually paints, minus drop shadow) and
 *       `DWMWA_CLOAKED` (whether the window is invisible-but-alive, e.g. on
 *       another virtual desktop).
 *   7.  `Wer.OpenThreadWaitChainSession` + `Wer.GetThreadWaitChain` walks
 *       the owning thread's wait chain so the HUD can report whether that
 *       UI thread is `Running` or `Blocked` on a lock the kernel knows about.
 *   8.  GDI+ paints the result into a 32-bpp ARGB DIB section: a rounded
 *       dark background, a "X-RAY" header with a crosshair glyph, a stack
 *       of label/value rows with thin separators, a bar chart of working-set
 *       memory, and decoded bitfields for window style / extended style.
 *       The DIB is `BitBlt`'d into the layered window's own DC and the window
 *       is repositioned next to the cursor with `SetWindowPos`.
 *
 * `ESC`, right-click on the overlay, and `Ctrl+C` in the terminal all trigger
 * a single `cleanup()` path that releases the GDI/GDI+/process handles and
 * destroys the window. `SetConsoleCtrlHandler` is installed via a real
 * `JSCallback` so a console close still tears the HUD down.
 *
 * APIs demonstrated (User32):
 *   - RegisterClassExW / CreateWindowExW / DestroyWindow / UnregisterClassW
 *   - SetLayeredWindowAttributes (LWA_ALPHA)
 *   - SetTimer / KillTimer / SetWindowPos / ShowWindow / UpdateWindow
 *   - GetMessageW / TranslateMessage / DispatchMessageW / DefWindowProcW
 *   - GetCursorPos / WindowFromPoint / GetAncestor (GA_ROOT)
 *   - GetClassNameW / GetWindowTextW / GetWindowThreadProcessId
 *   - GetWindowRect / GetClientRect / GetWindowLongW / IsWindowVisible
 *   - GetDC / ReleaseDC / GetSystemMetrics
 *
 * APIs demonstrated (Dwmapi):
 *   - DwmSetWindowAttribute (DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE)
 *   - DwmGetWindowAttribute (DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_CLOAKED)
 *
 * APIs demonstrated (Gdiplus):
 *   - GdiplusStartup / GdiplusShutdown
 *   - GdipCreateFromHDC / GdipDeleteGraphics
 *   - GdipSetSmoothingMode / GdipSetTextRenderingHint
 *   - GdipCreateSolidFill / GdipCreatePen1 / GdipDeleteBrush / GdipDeletePen
 *   - GdipFillRectangle / GdipFillEllipse / GdipDrawLine
 *   - GdipCreateFontFamilyFromName / GdipCreateFont / GdipDeleteFont / GdipDeleteFontFamily
 *   - GdipCreateStringFormat / GdipSetStringFormatAlign / GdipSetStringFormatLineAlign / GdipDeleteStringFormat
 *   - GdipDrawString / GdipGraphicsClear
 *
 * APIs demonstrated (GDI32):
 *   - CreateCompatibleDC / DeleteDC / CreateDIBSection / DeleteObject
 *   - SelectObject / BitBlt
 *
 * APIs demonstrated (Kernel32):
 *   - OpenProcess / CloseHandle / QueryFullProcessImageNameW
 *   - SetConsoleCtrlHandler (via JSCallback)
 *
 * APIs demonstrated (Psapi):
 *   - GetModuleBaseNameW / GetProcessMemoryInfo
 *
 * APIs demonstrated (Wer):
 *   - OpenThreadWaitChainSession / GetThreadWaitChain / CloseThreadWaitChainSession
 *
 * Run: bun run example/window-xray.ts
 */

import { JSCallback } from 'bun:ffi';

import { Dwmapi, GDI32, Gdiplus, Kernel32, Psapi, User32, Wer } from '../index';
import { CloakedReason, SystemBackdropType, WindowAttribute } from '@bun-win32/dwmapi';
import { FontStyle, SmoothingMode, Status, StringAlignment, TextRenderingHint, Unit } from '@bun-win32/gdiplus';
import { ProcessAccessRights } from '@bun-win32/kernel32';
import { ExtendedWindowStyles, packPOINT, SetWindowPosFlags, ShowWindowCommand, VirtualKey, WindowLongIndex, WindowStyles } from '@bun-win32/user32';
import { WCT_MAX_NODE_COUNT, WCT_OBJECT_STATUS, WCT_OBJECT_TYPE, WCT_OUT_OF_PROC_COM_FLAG, WCT_OUT_OF_PROC_CS_FLAG, WCT_OUT_OF_PROC_FLAG } from '@bun-win32/wer';

// ── Constants ────────────────────────────────────────────────────────────────

const NULL = 0n;
const encode = (text: string) => Buffer.from(`${text}\0`, 'utf16le');

const WM_DESTROY = 0x0002;
const WM_TIMER = 0x0113;
const WM_CLOSE = 0x0010;
const WM_RBUTTONDOWN = 0x0204;
const WM_KEYDOWN = 0x0100;
const WM_NCHITTEST = 0x0084;
const HTTRANSPARENT = -1;

const TIMER_ID = 1n;
const UPDATE_INTERVAL_MS = 50;

const HUD_WIDTH = 460;
const HUD_HEIGHT = 420;

const LWA_ALPHA = 0x02;
const OVERLAY_ALPHA = 235;

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

const HWND_TOPMOST = 0xffffffff_fffffffen; // (HWND)-1 as unsigned bigint

const argb = (alpha: number, red: number, green: number, blue: number): number => (((alpha & 0xff) << 24) | ((red & 0xff) << 16) | ((green & 0xff) << 8) | (blue & 0xff)) >>> 0;

const COLOR_BACKGROUND = argb(255, 0x10, 0x12, 0x1c);
const COLOR_BORDER = argb(255, 0x32, 0x6b, 0xff);
const COLOR_HEADER_BG = argb(255, 0x22, 0x32, 0x5a);
const COLOR_HEADER_TEXT = argb(255, 0x88, 0xc4, 0xff);
const COLOR_LABEL = argb(255, 0x7a, 0x80, 0x96);
const COLOR_VALUE = argb(255, 0xea, 0xee, 0xf6);
const COLOR_ACCENT = argb(255, 0x66, 0xff, 0xb2);
const COLOR_WARN = argb(255, 0xff, 0xc8, 0x66);
const COLOR_SEPARATOR = argb(160, 0x32, 0x6b, 0xff);
const COLOR_BAR_BG = argb(255, 0x22, 0x26, 0x36);
const COLOR_BAR_FILL = argb(255, 0x88, 0xc4, 0xff);
const COLOR_CROSSHAIR = argb(255, 0xff, 0x66, 0x88);

// ── Helpers ──────────────────────────────────────────────────────────────────

function gdiplusCheck(status: number, where: string): void {
  if (status !== Status.Ok) throw new Error(`${where} failed: ${Status[status] ?? '?'} (${status})`);
}

function readWideZ(buffer: Buffer, byteOffset: number, maxChars: number): string {
  let end = byteOffset;
  const limit = Math.min(buffer.length - 1, byteOffset + maxChars * 2);
  while (end < limit && buffer.readUInt16LE(end) !== 0) end += 2;
  return buffer.subarray(byteOffset, end).toString('utf16le');
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function decodeStyleFlags(style: number, table: Record<string, number>): string {
  const out: string[] = [];
  for (const [name, mask] of Object.entries(table)) {
    if (mask !== 0 && (style & mask) === mask) out.push(name);
  }
  return out.length === 0 ? '(none)' : out.join(' | ');
}

const STYLE_FLAGS: Record<string, number> = {
  WS_POPUP: WindowStyles.WS_POPUP >>> 0,
  WS_CHILD: WindowStyles.WS_CHILD,
  WS_VISIBLE: WindowStyles.WS_VISIBLE,
  WS_CAPTION: WindowStyles.WS_CAPTION,
  WS_BORDER: WindowStyles.WS_BORDER,
  WS_DLGFRAME: WindowStyles.WS_DLGFRAME,
  WS_THICKFRAME: WindowStyles.WS_THICKFRAME,
  WS_SYSMENU: WindowStyles.WS_SYSMENU,
  WS_MINIMIZEBOX: WindowStyles.WS_MINIMIZEBOX,
  WS_MAXIMIZEBOX: WindowStyles.WS_MAXIMIZEBOX,
  WS_DISABLED: WindowStyles.WS_DISABLED,
  WS_CLIPSIBLINGS: WindowStyles.WS_CLIPSIBLINGS,
  WS_CLIPCHILDREN: WindowStyles.WS_CLIPCHILDREN,
};

const EXSTYLE_FLAGS: Record<string, number> = {
  WS_EX_TOPMOST: ExtendedWindowStyles.WS_EX_TOPMOST,
  WS_EX_TOOLWINDOW: ExtendedWindowStyles.WS_EX_TOOLWINDOW,
  WS_EX_LAYERED: ExtendedWindowStyles.WS_EX_LAYERED,
  WS_EX_TRANSPARENT: ExtendedWindowStyles.WS_EX_TRANSPARENT,
  WS_EX_NOACTIVATE: ExtendedWindowStyles.WS_EX_NOACTIVATE,
  WS_EX_APPWINDOW: ExtendedWindowStyles.WS_EX_APPWINDOW,
  WS_EX_CLIENTEDGE: ExtendedWindowStyles.WS_EX_CLIENTEDGE,
  WS_EX_DLGMODALFRAME: ExtendedWindowStyles.WS_EX_DLGMODALFRAME,
  WS_EX_COMPOSITED: ExtendedWindowStyles.WS_EX_COMPOSITED,
  WS_EX_ACCEPTFILES: ExtendedWindowStyles.WS_EX_ACCEPTFILES,
};

// ── Per-frame sample captured by the timer tick ─────────────────────────────

interface Snapshot {
  cursorX: number;
  cursorY: number;
  targetHwnd: bigint;
  className: string;
  windowTitle: string;
  processId: number;
  threadId: number;
  windowRect: { left: number; top: number; right: number; bottom: number };
  clientRect: { width: number; height: number };
  style: number;
  exStyle: number;
  visible: boolean;
  imagePath: string;
  imageName: string;
  workingSet: number;
  peakWorkingSet: number;
  frameBoundsOk: boolean;
  frameBounds: { left: number; top: number; right: number; bottom: number };
  cloakedOk: boolean;
  cloaked: number;
  waitStatus: string;
  waitDetail: string;
}

const EMPTY_SNAPSHOT: Snapshot = {
  cursorX: 0,
  cursorY: 0,
  targetHwnd: 0n,
  className: '',
  windowTitle: '',
  processId: 0,
  threadId: 0,
  windowRect: { left: 0, top: 0, right: 0, bottom: 0 },
  clientRect: { width: 0, height: 0 },
  style: 0,
  exStyle: 0,
  visible: false,
  imagePath: '',
  imageName: '',
  workingSet: 0,
  peakWorkingSet: 0,
  frameBoundsOk: false,
  frameBounds: { left: 0, top: 0, right: 0, bottom: 0 },
  cloakedOk: false,
  cloaked: 0,
  waitStatus: 'unknown',
  waitDetail: '',
};

// Reusable scratch buffers (alloc-once for the 20 Hz tick).
const pointBuffer = Buffer.alloc(8);
const rectBuffer = Buffer.alloc(16);
const clientRectBuffer = Buffer.alloc(16);
const frameBoundsBuffer = Buffer.alloc(16);
const cloakedBuffer = Buffer.alloc(4);
const pidBuffer = Buffer.alloc(4);
const classNameBuffer = Buffer.alloc(512);
const windowTitleBuffer = Buffer.alloc(1024);
const imagePathBuffer = Buffer.alloc(1040);
const imagePathSize = Buffer.alloc(4);
const moduleBaseBuffer = Buffer.alloc(520);

const MEM_COUNTERS_SIZE = 72;
const memCountersBuffer = Buffer.alloc(MEM_COUNTERS_SIZE);

const WAIT_NODE_STRIDE = 280;
const waitChainBuffer = Buffer.alloc(WAIT_NODE_STRIDE * WCT_MAX_NODE_COUNT);
const waitChainCountBuffer = Buffer.alloc(4);
const waitChainCycleBuffer = Buffer.alloc(4);

// ── Wait Chain Traversal session, opened once, closed at teardown ───────────

let wctSession: bigint = NULL;

function openWctSession(): void {
  wctSession = Wer.OpenThreadWaitChainSession(0, null);
}

function probeWaitState(threadId: number): { status: string; detail: string } {
  if (wctSession === NULL || threadId === 0) return { status: 'unknown', detail: '' };

  waitChainBuffer.fill(0);
  waitChainCountBuffer.writeUInt32LE(WCT_MAX_NODE_COUNT, 0);
  waitChainCycleBuffer.writeUInt32LE(0, 0);

  const flags = WCT_OUT_OF_PROC_FLAG | WCT_OUT_OF_PROC_CS_FLAG | WCT_OUT_OF_PROC_COM_FLAG;
  const ok = Wer.GetThreadWaitChain(wctSession, NULL, flags, threadId, waitChainCountBuffer.ptr!, waitChainBuffer.ptr!, waitChainCycleBuffer.ptr!);
  if (ok === 0) return { status: 'unknown', detail: '(GetThreadWaitChain denied)' };

  const count = Math.min(waitChainCountBuffer.readUInt32LE(0), WCT_MAX_NODE_COUNT);
  if (count === 0) return { status: 'unknown', detail: '(no nodes)' };

  // The first node is the thread itself; subsequent nodes describe what it
  // owns or is waiting on. Walk every node and surface the most interesting
  // status the kernel reports for that thread.
  let anyBlocked = false;
  let firstLockName = '';
  for (let index = 0; index < count; index++) {
    const base = index * WAIT_NODE_STRIDE;
    const type = waitChainBuffer.readInt32LE(base);
    const status = waitChainBuffer.readInt32LE(base + 4);
    if (status === WCT_OBJECT_STATUS.WctStatusBlocked) anyBlocked = true;
    if (type !== WCT_OBJECT_TYPE.WctThreadType && firstLockName.length === 0) {
      firstLockName = readWideZ(waitChainBuffer, base + 8, 128);
    }
  }

  if (waitChainCycleBuffer.readUInt32LE(0) !== 0) return { status: 'DEADLOCK', detail: firstLockName ? `cycle on "${firstLockName}"` : 'cycle detected' };
  if (anyBlocked) return { status: 'BLOCKED', detail: firstLockName ? `waiting on "${firstLockName}"` : 'kernel-blocked' };
  return { status: 'Running', detail: `${count} node${count === 1 ? '' : 's'}` };
}

// ── Snapshot collection ──────────────────────────────────────────────────────

function captureSnapshot(overlayHwnd: bigint): Snapshot {
  const snapshot: Snapshot = { ...EMPTY_SNAPSHOT };

  User32.GetCursorPos(pointBuffer.ptr!);
  snapshot.cursorX = pointBuffer.readInt32LE(0);
  snapshot.cursorY = pointBuffer.readInt32LE(4);

  let target = User32.WindowFromPoint(packPOINT(snapshot.cursorX, snapshot.cursorY));
  // Walk to the owning root so we describe the top-level window, not the
  // individual child control / button text label.
  if (target !== NULL) {
    const root = User32.GetAncestor(target, /* GA_ROOT */ 2);
    if (root !== NULL) target = root;
  }
  // Never describe our own HUD - that would be a recursive mirror.
  if (target === overlayHwnd) return snapshot;
  snapshot.targetHwnd = target;
  if (target === NULL) return snapshot;

  // Class + title.
  const classLength = User32.GetClassNameW(target, classNameBuffer.ptr!, 256);
  snapshot.className = classLength > 0 ? classNameBuffer.subarray(0, classLength * 2).toString('utf16le') : '(unknown class)';

  const titleLength = User32.GetWindowTextW(target, windowTitleBuffer.ptr!, 512);
  snapshot.windowTitle = titleLength > 0 ? windowTitleBuffer.subarray(0, titleLength * 2).toString('utf16le') : '(untitled)';

  // Geometry.
  if (User32.GetWindowRect(target, rectBuffer.ptr!)) {
    snapshot.windowRect = {
      left: rectBuffer.readInt32LE(0),
      top: rectBuffer.readInt32LE(4),
      right: rectBuffer.readInt32LE(8),
      bottom: rectBuffer.readInt32LE(12),
    };
  }
  if (User32.GetClientRect(target, clientRectBuffer.ptr!)) {
    snapshot.clientRect = {
      width: clientRectBuffer.readInt32LE(8) - clientRectBuffer.readInt32LE(0),
      height: clientRectBuffer.readInt32LE(12) - clientRectBuffer.readInt32LE(4),
    };
  }

  // Style + visibility.
  snapshot.style = User32.GetWindowLongW(target, WindowLongIndex.GWL_STYLE) >>> 0;
  snapshot.exStyle = User32.GetWindowLongW(target, WindowLongIndex.GWL_EXSTYLE) >>> 0;
  snapshot.visible = User32.IsWindowVisible(target) !== 0;

  // PID + TID.
  pidBuffer.writeUInt32LE(0, 0);
  snapshot.threadId = User32.GetWindowThreadProcessId(target, pidBuffer.ptr!);
  snapshot.processId = pidBuffer.readUInt32LE(0);

  // Process image path + memory counters.
  if (snapshot.processId !== 0) {
    const processHandle = Kernel32.OpenProcess(ProcessAccessRights.PROCESS_QUERY_LIMITED_INFORMATION | ProcessAccessRights.PROCESS_VM_READ, 0, snapshot.processId);
    if (processHandle !== NULL) {
      try {
        imagePathSize.writeUInt32LE(520, 0);
        if (Kernel32.QueryFullProcessImageNameW(processHandle, 0, imagePathBuffer.ptr!, imagePathSize.ptr!)) {
          const wideLength = imagePathSize.readUInt32LE(0);
          snapshot.imagePath = imagePathBuffer.subarray(0, wideLength * 2).toString('utf16le');
        }

        const baseLength = Psapi.GetModuleBaseNameW(processHandle, NULL, moduleBaseBuffer.ptr!, 256);
        if (baseLength > 0) snapshot.imageName = moduleBaseBuffer.subarray(0, baseLength * 2).toString('utf16le');
        else if (snapshot.imagePath.length > 0) {
          const parts = snapshot.imagePath.split('\\');
          snapshot.imageName = parts[parts.length - 1] ?? '';
        }

        memCountersBuffer.fill(0);
        memCountersBuffer.writeUInt32LE(MEM_COUNTERS_SIZE, 0);
        if (Psapi.GetProcessMemoryInfo(processHandle, memCountersBuffer.ptr!, MEM_COUNTERS_SIZE)) {
          snapshot.peakWorkingSet = Number(memCountersBuffer.readBigUInt64LE(0x08));
          snapshot.workingSet = Number(memCountersBuffer.readBigUInt64LE(0x10));
        }
      } finally {
        Kernel32.CloseHandle(processHandle);
      }
    }
  }

  // DWM: extended frame bounds (compositor-painted rect) + cloaked state.
  if (Dwmapi.DwmGetWindowAttribute(target, WindowAttribute.DWMWA_EXTENDED_FRAME_BOUNDS, frameBoundsBuffer.ptr!, 16) === 0) {
    snapshot.frameBoundsOk = true;
    snapshot.frameBounds = {
      left: frameBoundsBuffer.readInt32LE(0),
      top: frameBoundsBuffer.readInt32LE(4),
      right: frameBoundsBuffer.readInt32LE(8),
      bottom: frameBoundsBuffer.readInt32LE(12),
    };
  }
  if (Dwmapi.DwmGetWindowAttribute(target, WindowAttribute.DWMWA_CLOAKED, cloakedBuffer.ptr!, 4) === 0) {
    snapshot.cloakedOk = true;
    snapshot.cloaked = cloakedBuffer.readUInt32LE(0);
  }

  // Wait Chain Traversal on the UI thread.
  const wait = probeWaitState(snapshot.threadId);
  snapshot.waitStatus = wait.status;
  snapshot.waitDetail = wait.detail;

  return snapshot;
}

// ── GDI+ rendering pipeline ──────────────────────────────────────────────────

interface Renderer {
  paint(snapshot: Snapshot): void;
  blitTo(destinationDeviceContext: bigint): void;
  dispose(): void;
}

function createSolidFill(color: number): bigint {
  const out = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreateSolidFill(color, out.ptr!), 'GdipCreateSolidFill');
  return out.readBigUInt64LE(0);
}

function createPen(color: number, width: number): bigint {
  const out = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreatePen1(color, width, Unit.UnitPixel, out.ptr!), 'GdipCreatePen1');
  return out.readBigUInt64LE(0);
}

function createFontFamily(name: string): bigint {
  const out = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreateFontFamilyFromName(encode(name).ptr!, NULL, out.ptr!), `GdipCreateFontFamilyFromName (${name})`);
  return out.readBigUInt64LE(0);
}

function createFont(family: bigint, sizePixels: number, style: FontStyle): bigint {
  const out = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreateFont(family, sizePixels, style, Unit.UnitPixel, out.ptr!), 'GdipCreateFont');
  return out.readBigUInt64LE(0);
}

function createStringFormat(alignment: StringAlignment): bigint {
  const out = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreateStringFormat(0, 0, out.ptr!), 'GdipCreateStringFormat');
  const handle = out.readBigUInt64LE(0);
  Gdiplus.GdipSetStringFormatAlign(handle, alignment);
  Gdiplus.GdipSetStringFormatLineAlign(handle, StringAlignment.StringAlignmentCenter);
  return handle;
}

function createRenderer(referenceDc: bigint): Renderer {
  // 32-bpp top-down ARGB DIB so GDI+ paints into the same pixels GDI BitBlt's
  // to the screen. BITMAPINFOHEADER is 40 bytes + an unused RGBQUAD palette.
  const bitmapInfo = Buffer.alloc(40 + 16);
  bitmapInfo.writeUInt32LE(40, 0);
  bitmapInfo.writeInt32LE(HUD_WIDTH, 4);
  bitmapInfo.writeInt32LE(-HUD_HEIGHT, 8); // negative = top-down
  bitmapInfo.writeUInt16LE(1, 12); // biPlanes
  bitmapInfo.writeUInt16LE(32, 14); // biBitCount
  bitmapInfo.writeUInt32LE(BI_RGB, 16);

  const memoryDeviceContext = GDI32.CreateCompatibleDC(referenceDc);
  if (memoryDeviceContext === NULL) throw new Error('CreateCompatibleDC failed');

  const bitsPointer = Buffer.alloc(8);
  const dibBitmap = GDI32.CreateDIBSection(memoryDeviceContext, bitmapInfo.ptr!, DIB_RGB_COLORS, bitsPointer.ptr!, NULL, 0);
  if (dibBitmap === NULL) throw new Error('CreateDIBSection failed');

  const oldBitmap = GDI32.SelectObject(memoryDeviceContext, dibBitmap);

  const graphicsOut = Buffer.alloc(8);
  gdiplusCheck(Gdiplus.GdipCreateFromHDC(memoryDeviceContext, graphicsOut.ptr!), 'GdipCreateFromHDC');
  const graphics = graphicsOut.readBigUInt64LE(0);
  gdiplusCheck(Gdiplus.GdipSetSmoothingMode(graphics, SmoothingMode.SmoothingModeAntiAlias), 'GdipSetSmoothingMode');
  gdiplusCheck(Gdiplus.GdipSetTextRenderingHint(graphics, TextRenderingHint.TextRenderingHintClearTypeGridFit), 'GdipSetTextRenderingHint');

  // Segoe UI for labels, Consolas for hex/monospace fields.
  const sansFamily = createFontFamily('Segoe UI');
  const monoFamily = createFontFamily('Consolas');
  const fonts = {
    header: createFont(sansFamily, 14, FontStyle.FontStyleBold),
    label: createFont(sansFamily, 10.5, FontStyle.FontStyleRegular),
    value: createFont(sansFamily, 11.5, FontStyle.FontStyleRegular),
    mono: createFont(monoFamily, 10.5, FontStyle.FontStyleRegular),
  };

  const formats = {
    left: createStringFormat(StringAlignment.StringAlignmentNear),
    right: createStringFormat(StringAlignment.StringAlignmentFar),
    center: createStringFormat(StringAlignment.StringAlignmentCenter),
  };

  const brushes = {
    background: createSolidFill(COLOR_BACKGROUND),
    headerBg: createSolidFill(COLOR_HEADER_BG),
    headerText: createSolidFill(COLOR_HEADER_TEXT),
    label: createSolidFill(COLOR_LABEL),
    value: createSolidFill(COLOR_VALUE),
    accent: createSolidFill(COLOR_ACCENT),
    warn: createSolidFill(COLOR_WARN),
    barBg: createSolidFill(COLOR_BAR_BG),
    barFill: createSolidFill(COLOR_BAR_FILL),
    crosshair: createSolidFill(COLOR_CROSSHAIR),
  };
  const pens = {
    separator: createPen(COLOR_SEPARATOR, 1.0),
    border: createPen(COLOR_BORDER, 1.5),
    crosshair: createPen(COLOR_CROSSHAIR, 1.5),
  };

  const textBuffer = Buffer.alloc(2048);
  const layoutRect = Buffer.alloc(16);

  const drawText = (text: string, brush: bigint, font: bigint, x: number, y: number, width: number, height: number, format: bigint): void => {
    if (text.length === 0) return;
    const trimmed = text.length > 256 ? text.slice(0, 253) + '...' : text;
    const byteCount = Buffer.byteLength(trimmed, 'utf16le');
    if (byteCount + 2 > textBuffer.length) return;
    textBuffer.write(trimmed, 0, 'utf16le');
    textBuffer.writeUInt16LE(0, byteCount);
    layoutRect.writeFloatLE(x, 0);
    layoutRect.writeFloatLE(y, 4);
    layoutRect.writeFloatLE(width, 8);
    layoutRect.writeFloatLE(height, 12);
    Gdiplus.GdipDrawString(graphics, textBuffer.ptr!, trimmed.length, font, layoutRect.ptr!, format, brush);
  };

  const paint = (snapshot: Snapshot): void => {
    Gdiplus.GdipGraphicsClear(graphics, COLOR_BACKGROUND);
    Gdiplus.GdipFillRectangle(graphics, brushes.background, 0, 0, HUD_WIDTH, HUD_HEIGHT);
    Gdiplus.GdipDrawRectangle(graphics, pens.border, 0.5, 0.5, HUD_WIDTH - 1, HUD_HEIGHT - 1);

    // Header strip with crosshair glyph.
    Gdiplus.GdipFillRectangle(graphics, brushes.headerBg, 1, 1, HUD_WIDTH - 2, 36);
    const crossX = 20;
    const crossY = 19;
    Gdiplus.GdipDrawLine(graphics, pens.crosshair, crossX - 8, crossY, crossX + 8, crossY);
    Gdiplus.GdipDrawLine(graphics, pens.crosshair, crossX, crossY - 8, crossX, crossY + 8);
    Gdiplus.GdipFillEllipse(graphics, brushes.crosshair, crossX - 2, crossY - 2, 4, 4);
    drawText('WINDOW X-RAY', brushes.headerText, fonts.header, 36, 8, 200, 22, formats.left);
    drawText(`${snapshot.cursorX} , ${snapshot.cursorY}`, brushes.label, fonts.mono, HUD_WIDTH - 130, 10, 120, 18, formats.right);

    if (snapshot.targetHwnd === NULL) {
      drawText('(hover over a window to inspect it)', brushes.label, fonts.value, 0, 50, HUD_WIDTH, 24, formats.center);
      drawText('press ESC or right-click here to close', brushes.label, fonts.label, 0, HUD_HEIGHT - 22, HUD_WIDTH, 18, formats.center);
      return;
    }

    let rowY = 46;
    const drawRow = (label: string, value: string, valueBrush: bigint = brushes.value, valueFont: bigint = fonts.value): void => {
      drawText(label, brushes.label, fonts.label, 14, rowY, 90, 18, formats.left);
      drawText(value, valueBrush, valueFont, 108, rowY, HUD_WIDTH - 120, 18, formats.left);
      rowY += 18;
    };
    const drawSeparator = (): void => {
      Gdiplus.GdipDrawLine(graphics, pens.separator, 12, rowY + 2, HUD_WIDTH - 12, rowY + 2);
      rowY += 8;
    };

    drawRow('class', snapshot.className, brushes.accent, fonts.mono);
    drawRow('caption', snapshot.windowTitle.length > 0 ? snapshot.windowTitle : '(empty)');
    drawRow('hwnd', `0x${snapshot.targetHwnd.toString(16).toUpperCase()}`, brushes.value, fonts.mono);
    drawRow('visible', snapshot.visible ? 'yes' : 'NO', snapshot.visible ? brushes.accent : brushes.warn);
    drawSeparator();

    drawRow('process', snapshot.imageName.length > 0 ? snapshot.imageName : '(unknown)', brushes.accent, fonts.mono);
    drawRow('path', snapshot.imagePath, brushes.value, fonts.label);
    drawRow('pid / tid', `${snapshot.processId}  /  ${snapshot.threadId}`, brushes.value, fonts.mono);

    // Memory bar — working set out of peak working set.
    const barX = 108;
    const barW = HUD_WIDTH - 120;
    const barH = 8;
    const barY = rowY + 4;
    Gdiplus.GdipFillRectangle(graphics, brushes.barBg, barX, barY, barW, barH);
    const ratio = snapshot.peakWorkingSet > 0 ? Math.min(1, snapshot.workingSet / snapshot.peakWorkingSet) : 0;
    if (ratio > 0) Gdiplus.GdipFillRectangle(graphics, brushes.barFill, barX, barY, barW * ratio, barH);
    drawText('memory', brushes.label, fonts.label, 14, rowY, 90, 18, formats.left);
    drawText(`${formatBytes(snapshot.workingSet)}  /  peak ${formatBytes(snapshot.peakWorkingSet)}`, brushes.value, fonts.label, barX, rowY - 10, barW, 14, formats.left);
    rowY += 22;
    drawSeparator();

    const r = snapshot.windowRect;
    drawRow('rect', `${r.left} , ${r.top}  →  ${r.right} , ${r.bottom}`, brushes.value, fonts.mono);
    drawRow('size', `${r.right - r.left} × ${r.bottom - r.top}   client ${snapshot.clientRect.width} × ${snapshot.clientRect.height}`, brushes.value, fonts.mono);
    if (snapshot.frameBoundsOk) {
      const fb = snapshot.frameBounds;
      drawRow('frame', `${fb.right - fb.left} × ${fb.bottom - fb.top}   (DWM-painted)`, brushes.value, fonts.mono);
    } else {
      drawRow('frame', '(DWM declined to report bounds)', brushes.label, fonts.label);
    }
    drawSeparator();

    drawRow('style', `0x${snapshot.style.toString(16).padStart(8, '0').toUpperCase()}`, brushes.value, fonts.mono);
    drawText(decodeStyleFlags(snapshot.style, STYLE_FLAGS), brushes.accent, fonts.label, 14, rowY, HUD_WIDTH - 28, 16, formats.left);
    rowY += 18;
    drawRow('exstyle', `0x${snapshot.exStyle.toString(16).padStart(8, '0').toUpperCase()}`, brushes.value, fonts.mono);
    drawText(decodeStyleFlags(snapshot.exStyle, EXSTYLE_FLAGS), brushes.accent, fonts.label, 14, rowY, HUD_WIDTH - 28, 16, formats.left);
    rowY += 18;
    drawSeparator();

    let cloakedText = '(not cloaked)';
    let cloakedBrush = brushes.accent;
    if (snapshot.cloakedOk && snapshot.cloaked !== 0) {
      const reasons: string[] = [];
      if (snapshot.cloaked & CloakedReason.DWM_CLOAKED_APP) reasons.push('APP');
      if (snapshot.cloaked & CloakedReason.DWM_CLOAKED_SHELL) reasons.push('SHELL');
      if (snapshot.cloaked & CloakedReason.DWM_CLOAKED_INHERITED) reasons.push('INHERITED');
      cloakedText = `CLOAKED (${reasons.join(', ')})`;
      cloakedBrush = brushes.warn;
    } else if (!snapshot.cloakedOk) {
      cloakedText = '(DWM unavailable)';
      cloakedBrush = brushes.label;
    }
    drawRow('cloaked', cloakedText, cloakedBrush, fonts.label);

    const waitBrush = snapshot.waitStatus === 'Running' ? brushes.accent : snapshot.waitStatus === 'unknown' ? brushes.label : brushes.warn;
    const waitText = snapshot.waitDetail.length > 0 ? `${snapshot.waitStatus}  ·  ${snapshot.waitDetail}` : snapshot.waitStatus;
    drawRow('wait', waitText, waitBrush, fonts.label);

    drawText('powered by @bun-win32/all  ·  press ESC to close', brushes.label, fonts.label, 0, HUD_HEIGHT - 18, HUD_WIDTH, 14, formats.center);
  };

  const blitTo = (destinationDeviceContext: bigint): void => {
    GDI32.BitBlt(destinationDeviceContext, 0, 0, HUD_WIDTH, HUD_HEIGHT, memoryDeviceContext, 0, 0, SRCCOPY);
  };

  const dispose = (): void => {
    for (const brush of Object.values(brushes)) Gdiplus.GdipDeleteBrush(brush);
    for (const pen of Object.values(pens)) Gdiplus.GdipDeletePen(pen);
    for (const format of Object.values(formats)) Gdiplus.GdipDeleteStringFormat(format);
    for (const font of Object.values(fonts)) Gdiplus.GdipDeleteFont(font);
    Gdiplus.GdipDeleteFontFamily(monoFamily);
    Gdiplus.GdipDeleteFontFamily(sansFamily);
    Gdiplus.GdipDeleteGraphics(graphics);
    GDI32.SelectObject(memoryDeviceContext, oldBitmap);
    GDI32.DeleteObject(dibBitmap);
    GDI32.DeleteDC(memoryDeviceContext);
  };

  return { paint, blitTo, dispose };
}

// ── Main: window setup, message loop, teardown ──────────────────────────────

console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('   WINDOW X-RAY HUD  -  live FFI inspector  ');
console.log('=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=~=');
console.log('');
console.log('A floating dashboard follows your cursor and');
console.log('reveals everything the kernel knows about the');
console.log('window beneath it - class, process, geometry,');
console.log('DWM compositing state, and UI-thread wait state.');
console.log('');
console.log('Move the mouse over any window to see it light up.');
console.log('Press ESC, right-click the HUD, or Ctrl+C to close.');
console.log('');

// GDI+ must be initialized before any Gdip* call.
const gdiplusTokenBuffer = Buffer.alloc(8);
const gdiplusStartupInput = Buffer.alloc(16);
gdiplusStartupInput.writeUInt32LE(1, 0); // GdiplusVersion
gdiplusCheck(Gdiplus.GdiplusStartup(gdiplusTokenBuffer.ptr!, gdiplusStartupInput.ptr!, null), 'GdiplusStartup');
const gdiplusToken = gdiplusTokenBuffer.readBigUInt64LE(0);

openWctSession();

let overlayHwnd: bigint = NULL;
let renderer: Renderer | null = null;
let teardownDone = false;

const className = encode('BunWin32WindowXRay');

const wndProc = new JSCallback(
  (hWnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint => {
    if (msg === WM_TIMER && wParam === TIMER_ID) {
      const snapshot = captureSnapshot(hWnd);
      renderer?.paint(snapshot);

      const overlayDc = User32.GetDC(hWnd);
      if (overlayDc !== NULL) {
        renderer?.blitTo(overlayDc);
        User32.ReleaseDC(hWnd, overlayDc);
      }

      // Reposition the HUD next to the cursor; flip to the left/up side when
      // the default offset would push it off the primary monitor edge.
      const screenWidth = User32.GetSystemMetrics(/* SM_CXSCREEN */ 0) || 1920;
      const screenHeight = User32.GetSystemMetrics(/* SM_CYSCREEN */ 1) || 1080;
      let overlayX = snapshot.cursorX + 24;
      let overlayY = snapshot.cursorY + 24;
      if (overlayX + HUD_WIDTH > screenWidth) overlayX = snapshot.cursorX - HUD_WIDTH - 24;
      if (overlayY + HUD_HEIGHT > screenHeight) overlayY = snapshot.cursorY - HUD_HEIGHT - 24;
      if (overlayX < 0) overlayX = 0;
      if (overlayY < 0) overlayY = 0;
      User32.SetWindowPos(hWnd, NULL, overlayX, overlayY, 0, 0, SetWindowPosFlags.SWP_NOSIZE | SetWindowPosFlags.SWP_NOZORDER | SetWindowPosFlags.SWP_NOACTIVATE);

      return 0n;
    }

    if (msg === WM_NCHITTEST) {
      // Always claim to be transparent so the window underneath gets every
      // hit-test - the HUD never grabs focus or input.
      return BigInt(HTTRANSPARENT);
    }

    if (msg === WM_KEYDOWN && Number(wParam) === VirtualKey.VK_ESCAPE) {
      User32.PostMessageW(hWnd, WM_CLOSE, NULL, 0n);
      return 0n;
    }

    if (msg === WM_RBUTTONDOWN) {
      User32.PostMessageW(hWnd, WM_CLOSE, NULL, 0n);
      return 0n;
    }

    if (msg === WM_CLOSE) {
      User32.KillTimer(hWnd, TIMER_ID);
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

// Register window class.
const wndClassBuffer = Buffer.alloc(80);
const wndClassView = new DataView(wndClassBuffer.buffer);
wndClassView.setUint32(0, 80, true); // cbSize
wndClassView.setUint32(4, 0, true); // style
wndClassBuffer.writeBigUInt64LE(BigInt(wndProc.ptr!), 8); // lpfnWndProc
wndClassView.setInt32(16, 0, true);
wndClassView.setInt32(20, 0, true);
wndClassBuffer.writeBigUInt64LE(NULL, 24); // hInstance
wndClassBuffer.writeBigUInt64LE(NULL, 32); // hIcon
wndClassBuffer.writeBigUInt64LE(NULL, 40); // hCursor
wndClassBuffer.writeBigUInt64LE(NULL, 48); // hbrBackground - we paint everything
wndClassBuffer.writeBigUInt64LE(NULL, 56); // lpszMenuName
wndClassBuffer.writeBigUInt64LE(BigInt(className.ptr!), 64); // lpszClassName
wndClassBuffer.writeBigUInt64LE(NULL, 72); // hIconSm

const classAtom = User32.RegisterClassExW(wndClassBuffer.ptr!);
if (!classAtom) {
  console.error('RegisterClassExW failed');
  process.exit(1);
}

overlayHwnd = User32.CreateWindowExW(
  ExtendedWindowStyles.WS_EX_TOPMOST | ExtendedWindowStyles.WS_EX_TOOLWINDOW | ExtendedWindowStyles.WS_EX_LAYERED | ExtendedWindowStyles.WS_EX_TRANSPARENT | ExtendedWindowStyles.WS_EX_NOACTIVATE,
  className.ptr!,
  encode('Bun Win32 - Window X-Ray').ptr!,
  WindowStyles.WS_POPUP,
  120,
  120,
  HUD_WIDTH,
  HUD_HEIGHT,
  NULL,
  NULL,
  NULL,
  null,
);
if (overlayHwnd === NULL) {
  console.error('CreateWindowExW failed');
  process.exit(1);
}

// Ask DWM for an acrylic backdrop + dark caption. Both calls are best-effort:
// older Windows builds return E_INVALIDARG and we just keep the flat fill.
const backdropTypeBuffer = Buffer.alloc(4);
backdropTypeBuffer.writeInt32LE(SystemBackdropType.DWMSBT_TRANSIENTWINDOW, 0);
Dwmapi.DwmSetWindowAttribute(overlayHwnd, WindowAttribute.DWMWA_SYSTEMBACKDROP_TYPE, backdropTypeBuffer.ptr!, 4);

const darkModeBuffer = Buffer.alloc(4);
darkModeBuffer.writeInt32LE(1, 0);
Dwmapi.DwmSetWindowAttribute(overlayHwnd, WindowAttribute.DWMWA_USE_IMMERSIVE_DARK_MODE, darkModeBuffer.ptr!, 4);

// Whole-window alpha. WS_EX_LAYERED is required for this to take effect.
User32.SetLayeredWindowAttributes(overlayHwnd, 0, OVERLAY_ALPHA, LWA_ALPHA);

// Build the renderer now that we have an HWND to source a compatible DC from.
const referenceDc = User32.GetDC(overlayHwnd);
if (referenceDc === NULL) {
  console.error('GetDC failed for overlay window');
  process.exit(1);
}
renderer = createRenderer(referenceDc);
User32.ReleaseDC(overlayHwnd, referenceDc);

User32.ShowWindow(overlayHwnd, ShowWindowCommand.SW_SHOWNOACTIVATE);
// Force the WS_EX_TOPMOST z-order ordering even if some other topmost claimed it first.
User32.SetWindowPos(overlayHwnd, HWND_TOPMOST, 0, 0, 0, 0, SetWindowPosFlags.SWP_NOMOVE | SetWindowPosFlags.SWP_NOSIZE | SetWindowPosFlags.SWP_NOACTIVATE);
User32.UpdateWindow(overlayHwnd);

const timerHandle = User32.SetTimer(overlayHwnd, TIMER_ID, UPDATE_INTERVAL_MS, null);
if (!timerHandle) {
  console.error('SetTimer failed');
  User32.DestroyWindow(overlayHwnd);
  process.exit(1);
}

console.log(`HUD ready  ·  hwnd=0x${overlayHwnd.toString(16)}  ·  tick=${UPDATE_INTERVAL_MS}ms`);
console.log('');

// ── Teardown wiring ─────────────────────────────────────────────────────────

function cleanup(): void {
  if (teardownDone) return;
  teardownDone = true;

  if (overlayHwnd !== NULL) {
    User32.KillTimer(overlayHwnd, TIMER_ID);
    User32.DestroyWindow(overlayHwnd);
    overlayHwnd = NULL;
  }
  renderer?.dispose();
  renderer = null;

  User32.UnregisterClassW(className.ptr!, NULL);

  if (wctSession !== NULL) {
    Wer.CloseThreadWaitChainSession(wctSession);
    wctSession = NULL;
  }

  Gdiplus.GdiplusShutdown(gdiplusToken);

  // Pull the JSCallbacks out of the GC's reach last.
  wndProc.close();
  consoleCtrlHandler.close();
}

const consoleCtrlHandler = new JSCallback(
  (_ctrlType: number): number => {
    // Posting WM_CLOSE keeps cleanup on the UI thread.
    if (overlayHwnd !== NULL) User32.PostMessageW(overlayHwnd, WM_CLOSE, NULL, 0n);
    return 1; // TRUE = handled
  },
  { args: ['u32'], returns: 'i32' },
);
Kernel32.SetConsoleCtrlHandler(consoleCtrlHandler.ptr!, 1);
process.on('SIGINT', () => {
  if (overlayHwnd !== NULL) User32.PostMessageW(overlayHwnd, WM_CLOSE, NULL, 0n);
});

// ── Message pump ────────────────────────────────────────────────────────────

const messageBuffer = Buffer.alloc(48);
while (true) {
  const result = User32.GetMessageW(messageBuffer.ptr!, NULL, 0, 0);
  if (result <= 0) break;
  User32.TranslateMessage(messageBuffer.ptr!);
  User32.DispatchMessageW(messageBuffer.ptr!);
}

cleanup();
console.log('X-Ray HUD closed.');
process.exit(0);
