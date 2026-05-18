/**
 * Native Windows Toast Notification — through pure Bun FFI
 *
 * Sends a real Windows 10/11 toast notification that appears in the Action
 * Center, driven entirely by the Windows Runtime activation core in
 * combase.dll. No native addon, no Electron, no PowerShell shell-out.
 *
 * The pipeline is the canonical WinRT activation sequence, hand-walked over
 * COM vtables:
 *
 *   1. RoInitialize                         — enter the Windows Runtime
 *   2. WindowsCreateString                  — JS string → HSTRING
 *   3. RoActivateInstance("…XmlDocument")   — make an XmlDocument
 *   4. QueryInterface → IXmlDocumentIO      — LoadXml(toast payload)
 *   5. RoGetActivationFactory("…Manager")   — IToastNotificationManagerStatics
 *   6. CreateToastNotifierWithId(AUMID)     — IToastNotifier
 *   7. RoGetActivationFactory("…Toast")     — IToastNotificationFactory
 *   8. CreateToastNotification(xml)         — IToastNotification
 *   9. IToastNotifier::Show(toast)          — it pops on screen
 *  10. Release / WindowsDeleteString / RoUninitialize — clean teardown
 *
 * The AUMID is the always-present Windows PowerShell shortcut identity, so
 * the toast renders from an unpackaged process without app registration.
 *
 * APIs demonstrated (Combase):
 *   - RoInitialize / RoUninitialize       (Windows Runtime per-thread lifetime)
 *   - WindowsCreateString / WindowsDeleteString  (HSTRING lifetime)
 *   - RoActivateInstance                  (activate Windows.Data.Xml.Dom.XmlDocument)
 *   - RoGetActivationFactory              (statics + factory for the toast classes)
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode  (enable ANSI VT output)
 *
 * Run: bun run example/toast-notification.ts
 */

import { CFunction, FFIType, type Pointer, read } from 'bun:ffi';

import Combase, { RO_INIT_TYPE } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[96m';
const GREEN = '\x1b[92m';
const RED = '\x1b[91m';
const YELLOW = '\x1b[93m';
const MAGENTA = '\x1b[95m';

const S_OK = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = 0x8001_0106;

// IInspectable-derived vtable slots. Every WinRT interface starts with the
// three IUnknown slots (QueryInterface, AddRef, Release) followed by the three
// IInspectable slots, so the first runtime-class method lives at slot 6.
const QUERY_INTERFACE = 0;
const RELEASE = 2;
const IXMLDOCUMENTIO_LOADXML = 6;
const ITOASTMANAGER_CREATENOTIFIERWITHID = 7;
const ITOASTFACTORY_CREATENOTIFICATION = 6;
const ITOASTNOTIFIER_SHOW = 6;

// Canonical interface IDs (Windows SDK windows.*.idl uuid() attributes).
const IID_IXmlDocumentIO = '6CD0E74E-EE65-4489-9EBF-CA43E87BA637';
const IID_IXmlDocument = 'F7F3A506-1E87-42D6-BCFB-B8C809FA5494';
const IID_IToastNotificationManagerStatics = '50AC103F-D235-4598-BBEF-98FE4D1A3AD4';
const IID_IToastNotificationFactory = '04124B20-82C6-4229-B109-FD9ED4662B53';
const IID_IToastNotifier = '75927B93-03F3-41EC-91D3-6E5BAC1B38E7';

// Always-registered Start-menu identity for Windows PowerShell. Using it lets
// an unpackaged process raise toasts without registering its own AUMID.
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const TOAST_XML =
  '<toast activationType="foreground"><visual><binding template="ToastGeneric">' +
  '<text>@bun-win32/combase</text>' +
  '<text>Native WinRT toast — sent through pure Bun FFI. No native build, no Electron.</text>' +
  '<text placement="attribution">combase.dll · RoActivateInstance</text>' +
  '</binding></visual></toast>';

Combase.Preload(['RoInitialize', 'RoUninitialize', 'WindowsCreateString', 'WindowsDeleteString', 'RoActivateInstance', 'RoGetActivationFactory']);

// Enable ANSI escape processing so colors render in Windows Terminal / VS Code.
const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr!)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const createdStrings: bigint[] = [];
const liveObjects: bigint[] = [];

const hex = (hr: number): string => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

function step(label: string, hr: number): boolean {
  const ok = hr === S_OK || hr === S_FALSE;
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const code = ok ? `${DIM}${hex(hr)}${RESET}` : `${RED}${hex(hr)}${RESET}`;
  console.log(`  ${mark} ${label.padEnd(46)} ${code}`);
  return ok;
}

/** Builds the 16-byte little-endian GUID layout COM expects from a REFIID. */
function guid(text: string): Buffer {
  const hexDigits = text.replace(/[{}-]/g, '');
  const buffer = Buffer.alloc(16);
  buffer.writeUInt32LE(parseInt(hexDigits.slice(0, 8), 16), 0);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(8, 12), 16), 4);
  buffer.writeUInt16LE(parseInt(hexDigits.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1) buffer[8 + i] = parseInt(hexDigits.slice(16 + i * 2, 18 + i * 2), 16);
  return buffer;
}

/** Creates an HSTRING from a JS string and tracks it for teardown. */
function hstring(text: string): bigint {
  const out = Buffer.alloc(8);
  const source = text.length === 0 ? null : Buffer.from(text, 'utf16le').ptr!;
  const hr = Combase.WindowsCreateString(source, text.length, out.ptr!);
  if (hr !== S_OK) throw new Error(`WindowsCreateString failed (${hex(hr)})`);
  const handle = out.readBigUInt64LE(0);
  createdStrings.push(handle);
  return handle;
}

/**
 * Invokes COM vtable slot `slot` on the interface pointer `thisPtr`. The
 * implicit `this` is prepended, every method here returns HRESULT (WinRT ABI),
 * so the return is read as a signed 32-bit value.
 */
function vcall(thisPtr: bigint, slot: number, argTypes: readonly FFIType[], args: readonly unknown[]): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const invoke = CFunction({ ptr: Number(method) as Pointer, args: [FFIType.u64, ...argTypes], returns: FFIType.i32 });
  return invoke(thisPtr, ...args) as number;
}

/** QueryInterface helper: returns the requested interface pointer, or 0n. */
function queryInterface(unknown: bigint, iid: string): bigint {
  const out = Buffer.alloc(8);
  const hr = vcall(unknown, QUERY_INTERFACE, [FFIType.ptr, FFIType.ptr], [guid(iid).ptr!, out.ptr!]);
  if (hr !== S_OK) return 0n;
  const ptr = out.readBigUInt64LE(0);
  if (ptr !== 0n) liveObjects.push(ptr);
  return ptr;
}

/** RoGetActivationFactory wrapper: runtime class string → interface pointer. */
function activationFactory(runtimeClass: string, iid: string): bigint {
  const out = Buffer.alloc(8);
  const hr = Combase.RoGetActivationFactory(hstring(runtimeClass), guid(iid).ptr!, out.ptr!);
  if (!step(`RoGetActivationFactory(${runtimeClass.split('.').pop()})`, hr)) throw new Error('activation factory unavailable');
  const ptr = out.readBigUInt64LE(0);
  liveObjects.push(ptr);
  return ptr;
}

function banner(): void {
  console.log();
  console.log(`${BOLD}${MAGENTA}  ╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${MAGENTA}  ║${RESET}   ${BOLD}Native Windows Toast — pure Bun FFI via combase.dll${RESET}${BOLD}${MAGENTA}      ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}  ╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log();
}

function main(): void {
  banner();

  const initHr = Combase.RoInitialize(RO_INIT_TYPE.RO_INIT_MULTITHREADED);
  if (initHr !== S_OK && initHr !== S_FALSE && initHr >>> 0 !== RPC_E_CHANGED_MODE) {
    step('RoInitialize', initHr);
    console.log(`\n${RED}  Could not initialize the Windows Runtime.${RESET}\n`);
    return;
  }
  step('RoInitialize(RO_INIT_MULTITHREADED)', initHr === RPC_E_CHANGED_MODE ? S_FALSE : initHr);

  // 1. Build the toast payload as a WinRT XmlDocument.
  const xmlOut = Buffer.alloc(8);
  const activateHr = Combase.RoActivateInstance(hstring('Windows.Data.Xml.Dom.XmlDocument'), xmlOut.ptr!);
  if (!step('RoActivateInstance(XmlDocument)', activateHr)) return cleanup();
  const xmlInspectable = xmlOut.readBigUInt64LE(0);
  liveObjects.push(xmlInspectable);

  const xmlDocumentIo = queryInterface(xmlInspectable, IID_IXmlDocumentIO);
  if (xmlDocumentIo === 0n) {
    console.log(`${RED}  QueryInterface(IXmlDocumentIO) failed${RESET}`);
    return cleanup();
  }
  const loadHr = vcall(xmlDocumentIo, IXMLDOCUMENTIO_LOADXML, [FFIType.u64], [hstring(TOAST_XML)]);
  if (!step('IXmlDocumentIO::LoadXml(payload)', loadHr)) return cleanup();

  const xmlDocument = queryInterface(xmlInspectable, IID_IXmlDocument);
  if (xmlDocument === 0n) {
    console.log(`${RED}  QueryInterface(IXmlDocument) failed${RESET}`);
    return cleanup();
  }

  // 2. ToastNotificationManager statics → an IToastNotifier bound to the AUMID.
  const managerStatics = activationFactory('Windows.UI.Notifications.ToastNotificationManager', IID_IToastNotificationManagerStatics);
  const notifierOut = Buffer.alloc(8);
  const notifierHr = vcall(managerStatics, ITOASTMANAGER_CREATENOTIFIERWITHID, [FFIType.u64, FFIType.ptr], [hstring(AUMID), notifierOut.ptr!]);
  if (!step('CreateToastNotifierWithId(AUMID)', notifierHr)) return cleanup();
  const notifier = notifierOut.readBigUInt64LE(0);
  liveObjects.push(notifier);

  // 3. ToastNotification factory → an IToastNotification wrapping the XML.
  const toastFactory = activationFactory('Windows.UI.Notifications.ToastNotification', IID_IToastNotificationFactory);
  const toastOut = Buffer.alloc(8);
  const toastHr = vcall(toastFactory, ITOASTFACTORY_CREATENOTIFICATION, [FFIType.u64, FFIType.ptr], [xmlDocument, toastOut.ptr!]);
  if (!step('CreateToastNotification(xml)', toastHr)) return cleanup();
  const toast = toastOut.readBigUInt64LE(0);
  liveObjects.push(toast);

  // 4. Show it. This is the moment it slides in from the corner.
  const showHr = vcall(notifier, ITOASTNOTIFIER_SHOW, [FFIType.u64], [toast]);
  const shown = step('IToastNotifier::Show(toast)', showHr);

  console.log();
  if (shown) {
    console.log(`  ${GREEN}${BOLD}Toast dispatched.${RESET} Check the bottom-right corner and the Action Center.`);
    console.log(`  ${DIM}If notifications are disabled in Settings it is delivered silently to the Action Center.${RESET}`);
  } else {
    console.log(`  ${YELLOW}The pipeline ran end to end but Show() reported ${hex(showHr)}.${RESET}`);
  }
  console.log();
  console.log(`  ${CYAN}Payload${RESET} ${DIM}(IXmlDocument backing the notification)${RESET}`);
  for (const line of TOAST_XML.replace(/></g, '>\n<').split('\n')) console.log(`    ${DIM}${line}${RESET}`);
  console.log();

  cleanup();
}

function cleanup(): void {
  for (const obj of liveObjects.reverse()) vcall(obj, RELEASE, [], []);
  for (const handle of createdStrings) Combase.WindowsDeleteString(handle);
  Combase.RoUninitialize();
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
}

main();
