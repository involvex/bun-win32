// Element: a live IUIAutomationElement pointer with typed property reads and tree search.
// Property reads use hoisted, reused scratch buffers (no per-read allocation); BSTR names are
// bulk-copied in one operation BEFORE SysFreeString (never a per-character loop, never read-after-free).

import { FFIType, type Pointer, toArrayBuffer } from 'bun:ffi';

import Oleaut32 from '@bun-win32/oleaut32';

import { automation } from './automation';
import { comRelease, hresult, vcall } from './com';
import { compileCondition, type ElementProperties, matches, type Selector } from './condition';
import { ControlType, S_OK, SLOT, TreeScope } from './constants';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Reused scratch for out-parameters. Each value is read out immediately, so the buffers never alias
// across a live value. `.ptr` is read inline at each call (small Buffers relocate; never cache it).
const scratch8 = Buffer.alloc(8);
const scratch4 = Buffer.alloc(4);
const scratch16 = Buffer.alloc(16);

/** Read a `[propget] BSTR*` accessor, bulk-copying the UTF-16 region before freeing the BSTR. */
export function getBstr(ptr: bigint, slot: number): string {
  if (vcall(ptr, slot, [FFIType.ptr], [scratch8.ptr!]) !== S_OK) return '';
  const bstr = scratch8.readBigUInt64LE(0);
  if (bstr === 0n) return '';
  const pointer = Number(bstr) as Pointer;
  const length = Oleaut32.SysStringLen(pointer); // characters, not bytes
  const text = length === 0 ? '' : Buffer.from(toArrayBuffer(pointer, 0, length * 2)).toString('utf16le');
  Oleaut32.SysFreeString(pointer);
  return text;
}

/** Read a `[propget] LONG*` (or BOOL*) accessor. */
export function getLong(ptr: bigint, slot: number): number {
  if (vcall(ptr, slot, [FFIType.ptr], [scratch4.ptr!]) !== S_OK) return 0;
  return scratch4.readInt32LE(0);
}

/** Read a `[propget] UIA_HWND*` / handle accessor. */
export function getHandle(ptr: bigint, slot: number): bigint {
  if (vcall(ptr, slot, [FFIType.ptr], [scratch8.ptr!]) !== S_OK) return 0n;
  return scratch8.readBigUInt64LE(0);
}

/** Read a `[propget] RECT*` accessor (4× LONG) into an {x,y,width,height} rectangle. */
export function getRect(ptr: bigint, slot: number): Rect {
  if (vcall(ptr, slot, [FFIType.ptr], [scratch16.ptr!]) !== S_OK) return { x: 0, y: 0, width: 0, height: 0 };
  const left = scratch16.readInt32LE(0);
  const top = scratch16.readInt32LE(4);
  const right = scratch16.readInt32LE(8);
  const bottom = scratch16.readInt32LE(12);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Read the four properties the client-side matcher needs, in one pass. */
function readProperties(ptr: bigint): ElementProperties {
  return {
    automationId: getBstr(ptr, SLOT.get_CurrentAutomationId),
    className: getBstr(ptr, SLOT.get_CurrentClassName),
    controlType: getLong(ptr, SLOT.get_CurrentControlType),
    name: getBstr(ptr, SLOT.get_CurrentName),
  };
}

function findFirstPointer(scopeElement: bigint, scope: number, condition: bigint): bigint {
  if (vcall(scopeElement, SLOT.FindFirst, [FFIType.i32, FFIType.u64, FFIType.ptr], [scope, condition, scratch8.ptr!]) !== S_OK) return 0n;
  return scratch8.readBigUInt64LE(0);
}

function findAllPointers(scopeElement: bigint, scope: number, condition: bigint): bigint[] {
  if (vcall(scopeElement, SLOT.FindAll, [FFIType.i32, FFIType.u64, FFIType.ptr], [scope, condition, scratch8.ptr!]) !== S_OK) return [];
  const pArray = scratch8.readBigUInt64LE(0);
  if (pArray === 0n) return [];
  try {
    if (vcall(pArray, SLOT.get_Length, [FFIType.ptr], [scratch4.ptr!]) !== S_OK) return [];
    const length = scratch4.readInt32LE(0);
    const pointers: bigint[] = new Array(length);
    let count = 0;
    for (let index = 0; index < length; index += 1) {
      if (vcall(pArray, SLOT.GetElement, [FFIType.i32, FFIType.ptr], [index, scratch8.ptr!]) !== S_OK) continue;
      const pointer = scratch8.readBigUInt64LE(0);
      if (pointer !== 0n) {
        pointers[count] = pointer;
        count += 1;
      }
    }
    pointers.length = count;
    return pointers;
  } finally {
    comRelease(pArray);
  }
}

export class Element {
  readonly ptr: bigint;

  constructor(ptr: bigint) {
    this.ptr = ptr;
  }

  get automationId(): string {
    return getBstr(this.ptr, SLOT.get_CurrentAutomationId);
  }

  get boundingRectangle(): Rect {
    return getRect(this.ptr, SLOT.get_CurrentBoundingRectangle);
  }

  get className(): string {
    return getBstr(this.ptr, SLOT.get_CurrentClassName);
  }

  get controlType(): number {
    return getLong(this.ptr, SLOT.get_CurrentControlType);
  }

  get controlTypeName(): string {
    const id = this.controlType;
    return ControlType[id] ?? `Type(${id})`;
  }

  get isEnabled(): boolean {
    return getLong(this.ptr, SLOT.get_CurrentIsEnabled) !== 0;
  }

  get name(): string {
    return getBstr(this.ptr, SLOT.get_CurrentName);
  }

  get nativeWindowHandle(): bigint {
    return getHandle(this.ptr, SLOT.get_CurrentNativeWindowHandle);
  }

  /** Immediate children (control view) as Elements. The caller owns and should release them. */
  get children(): Element[] {
    return this.findAll({}, TreeScope.TreeScope_Children);
  }

  /** The control-view parent, or null at a root. The caller owns the returned Element. */
  get parent(): Element | null {
    if (vcall(automation(), SLOT.get_ControlViewWalker, [FFIType.ptr], [scratch8.ptr!]) !== S_OK) return null;
    const walker = scratch8.readBigUInt64LE(0);
    if (walker === 0n) return null;
    try {
      if (vcall(walker, SLOT.GetParentElement, [FFIType.u64, FFIType.ptr], [this.ptr, scratch8.ptr!]) !== S_OK) return null;
      const pointer = scratch8.readBigUInt64LE(0);
      return pointer === 0n ? null : new Element(pointer);
    } finally {
      comRelease(walker);
    }
  }

  /** The first descendant (by default) matching the selector, or null. Releases the non-matches. */
  find(selector: Selector, scope: number = TreeScope.TreeScope_Descendants): Element | null {
    const pAutomation = automation();
    const { condition, needsClientFilter } = compileCondition(pAutomation, selector);
    try {
      if (!needsClientFilter) {
        const pointer = findFirstPointer(this.ptr, scope, condition);
        return pointer === 0n ? null : new Element(pointer);
      }
      const pointers = findAllPointers(this.ptr, scope, condition);
      for (let index = 0; index < pointers.length; index += 1) {
        const pointer = pointers[index]!;
        if (matches(readProperties(pointer), selector)) {
          for (let rest = index + 1; rest < pointers.length; rest += 1) comRelease(pointers[rest]!);
          return new Element(pointer);
        }
        comRelease(pointer);
      }
      return null;
    } finally {
      comRelease(condition);
    }
  }

  /** Every descendant (by default) matching the selector. The caller owns and should release them. */
  findAll(selector: Selector, scope: number = TreeScope.TreeScope_Descendants): Element[] {
    const pAutomation = automation();
    const { condition, needsClientFilter } = compileCondition(pAutomation, selector);
    try {
      const pointers = findAllPointers(this.ptr, scope, condition);
      if (!needsClientFilter) return pointers.map((pointer) => new Element(pointer));
      const result: Element[] = [];
      for (const pointer of pointers) {
        if (matches(readProperties(pointer), selector)) result.push(new Element(pointer));
        else comRelease(pointer);
      }
      return result;
    } finally {
      comRelease(condition);
    }
  }

  /** Release the underlying COM pointer. */
  release(): void {
    comRelease(this.ptr);
  }
}

/** Attach an Element to a window handle (ElementFromHandle, slot 6 — NativeWindowHandle round-trips). */
export function fromHandle(hWnd: bigint): Element {
  const hr = vcall(automation(), SLOT.ElementFromHandle, [FFIType.u64, FFIType.ptr], [hWnd, scratch8.ptr!]);
  const pointer = scratch8.readBigUInt64LE(0);
  if (hr !== S_OK || pointer === 0n) throw new Error(`ElementFromHandle(0x${hWnd.toString(16)}) failed: ${hresult(hr)}`);
  return new Element(pointer);
}

/** The element with keyboard focus. */
export function focused(): Element {
  const hr = vcall(automation(), SLOT.GetFocusedElement, [FFIType.ptr], [scratch8.ptr!]);
  const pointer = scratch8.readBigUInt64LE(0);
  if (hr !== S_OK || pointer === 0n) throw new Error(`GetFocusedElement failed: ${hresult(hr)}`);
  return new Element(pointer);
}

/** The element at a screen point (POINT packed by value: x in the low dword, y in the high dword). */
export function fromPoint(x: number, y: number): Element {
  const point = (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
  const hr = vcall(automation(), SLOT.ElementFromPoint, [FFIType.u64, FFIType.ptr], [point, scratch8.ptr!]);
  const pointer = scratch8.readBigUInt64LE(0);
  if (hr !== S_OK || pointer === 0n) throw new Error(`ElementFromPoint(${x},${y}) failed: ${hresult(hr)}`);
  return new Element(pointer);
}

/** The desktop root element. Never FindAll(Descendants) from here — scope to a window. */
export function root(): Element {
  const hr = vcall(automation(), SLOT.GetRootElement, [FFIType.ptr], [scratch8.ptr!]);
  const pointer = scratch8.readBigUInt64LE(0);
  if (hr !== S_OK || pointer === 0n) throw new Error(`GetRootElement failed: ${hresult(hr)}`);
  return new Element(pointer);
}
