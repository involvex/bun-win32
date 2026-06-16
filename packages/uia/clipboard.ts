// Clipboard read/write (Unicode text) — the reliable large-text path that sidesteps per-keystroke
// SendInput corruption (set the clipboard, then paste), plus the nut.js/robotjs clipboard parity and
// a creative "read selected text from any app" (copy → read) that works even where there's no a11y
// tree. CF_UNICODETEXT via OpenClipboard + the Global* heap; zero new bindings.

import { type Pointer, toArrayBuffer } from 'bun:ffi';

import Kernel32 from '@bun-win32/kernel32';
import User32 from '@bun-win32/user32';

import { sendKeys } from './input';

const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;

/** The clipboard's change counter (User32.GetClipboardSequenceNumber) — bumps on every clipboard write. Compare it
 *  before/after a posted WM_COPY/WM_CUT to tell whether the control actually copied (the counter changed) or the
 *  clipboard is STALE (empty selection / a control that ignored the message), so a stale value is never returned. */
export function clipboardSequence(): number {
  return User32.GetClipboardSequenceNumber();
}

/** Read the clipboard's Unicode text, or '' if it is empty or not text. */
export function readClipboard(): string {
  if (User32.OpenClipboard(0n) === 0) return '';
  try {
    if (User32.IsClipboardFormatAvailable(CF_UNICODETEXT) === 0) return '';
    const handle = User32.GetClipboardData(CF_UNICODETEXT);
    if (handle === 0n) return '';
    const pointer = Kernel32.GlobalLock(handle);
    if (pointer === null) return '';
    try {
      const size = Number(Kernel32.GlobalSize(handle));
      const text = Buffer.from(toArrayBuffer(pointer as Pointer, 0, size)).toString('utf16le');
      const terminator = text.indexOf('\0');
      return terminator === -1 ? text : text.slice(0, terminator);
    } finally {
      Kernel32.GlobalUnlock(handle);
    }
  } finally {
    User32.CloseClipboard();
  }
}

/** Set the clipboard's Unicode text. Returns true on success. */
export function writeClipboard(text: string): boolean {
  const bytes = Buffer.from(`${text}\0`, 'utf16le');
  const handle = Kernel32.GlobalAlloc(GMEM_MOVEABLE, BigInt(bytes.length));
  if (handle === 0n) return false;
  const pointer = Kernel32.GlobalLock(handle);
  if (pointer === null) {
    Kernel32.GlobalFree(handle);
    return false;
  }
  new Uint8Array(toArrayBuffer(pointer as Pointer, 0, bytes.length)).set(bytes);
  Kernel32.GlobalUnlock(handle);
  if (User32.OpenClipboard(0n) === 0) {
    Kernel32.GlobalFree(handle);
    return false;
  }
  try {
    User32.EmptyClipboard();
    if (User32.SetClipboardData(CF_UNICODETEXT, handle) === 0n) {
      Kernel32.GlobalFree(handle); // ownership not transferred on failure
      return false;
    }
    return true; // on success the system owns `handle` — do not free it
  } finally {
    User32.CloseClipboard();
  }
}

/** Set the clipboard to `text` and paste it (Ctrl+V) into the focused control — the reliable, fast
 *  large-text path (no per-character keystrokes). Needs an unlocked, foregrounded desktop. */
export function paste(text: string): void {
  writeClipboard(text);
  sendKeys('Control+V');
}

/** Copy the current selection (Ctrl+C) and read it back — read text from any app, even with no a11y tree. */
export async function copy(): Promise<string> {
  sendKeys('Control+C');
  await Bun.sleep(80);
  return readClipboard();
}
