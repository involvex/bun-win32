// Java Access Bridge engine — read the accessibility tree of a Java Swing/AWT/JavaFX window, which exposes NOTHING
// to UIA or MSAA (only its top-level frame). The JVM speaks a separate protocol over WindowsAccessBridge-64.dll
// (a flat C-export system DLL, present wherever a JAB-enabled JDK/JRE is). The bridge registers running JVMs via a
// window-message handshake, so after Windows_run() the client MUST pump its message queue once for the JVM to be
// discovered; thereafter the read calls round-trip synchronously (SendMessage), no per-call pump needed. JOBJECT64 =
// jlong (i64) on the 64-bit bridge; vmID = Windows long (i32); HWND = u64; BOOL/jint = i32. Detection-only/read-only.
//
// NOTE: bound via raw dlopen (the same in-package precedent as wgc.ts's d3d11 interop), not a @bun-win32 package — an
// internal alternate read-engine; only the ~6 read exports are used. WindowsAccessBridge-64.dll is ABSENT on machines
// without a JAB-enabled JDK/JRE, so the dlopen is LAZY + fault-tolerant (see ensureStarted): a missing bridge degrades to
// isJavaWindow()=false / javaTree()=null, never a throw at import (a top-level dlopen would brick the whole package on a
// Java-less box). A native cursor-free ACT path (doAccessibleActions + getAccessibleActions — flat exports of this same
// DLL) and a full @bun-win32/windowsaccessbridge package are verified-feasible future extractions.

import { dlopen, FFIType } from 'bun:ffi';

import User32 from '@bun-win32/user32';

import type { Rect } from './reads';

function openBridge() {
  return dlopen('WindowsAccessBridge-64.dll', {
    Windows_run: { args: [], returns: FFIType.void },
    isJavaWindow: { args: [FFIType.u64], returns: FFIType.i32 },
    getAccessibleContextFromHWND: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getAccessibleContextInfo: { args: [FFIType.i32, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    getAccessibleChildFromContext: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
    releaseJavaObject: { args: [FFIType.i32, FFIType.i64], returns: FFIType.void },
  }).symbols;
}

type Bridge = ReturnType<typeof openBridge>;

let jab: Bridge | null = null;

export interface JavaNode {
  role: string;
  name: string;
  states: string;
  description: string;
  bounds: Rect;
  children: JavaNode[];
  truncated?: boolean; // set on the root when maxDepth/maxNodes cut the traversal short
}

// AccessibleContextInfo field byte offsets (wchar_t=2B; MAX_STRING_SIZE=1024, SHORT_STRING_SIZE=256 — verified vs
// AccessBridgePackages.h): name[1024]@0, description[1024]@2048, role[256]@4096, role_en_US@4608, states@5120,
// states_en_US@5632, then jint indexInParent@6144, childrenCount@6148, x@6152, y@6156, width@6160, height@6164.
const INFO_SIZE = 6400; // > 6188 actual; padded headroom

const PM_REMOVE = 0x0001;
const MSG = Buffer.allocUnsafe(48); // x64 MSG is 48 bytes; reused — its .ptr is read inline at each PeekMessage call
let started = false;

/** Drain the thread's Win32 message queue for `rounds` × ~30ms — lets the JAB↔JVM registration handshake messages
 *  flow. A freshly-started or late-launched JVM is only discovered once these are pumped. */
function pump(rounds: number): void {
  for (let round = 0; round < rounds; round += 1) {
    while (User32.PeekMessageW(MSG.ptr!, 0n, 0, 0, PM_REMOVE) !== 0) {
      User32.TranslateMessage(MSG.ptr!);
      User32.DispatchMessageW(MSG.ptr!);
    }
    Bun.sleepSync(30);
  }
}

/** Open the bridge once and complete the initial JVM-discovery handshake. Idempotent. If WindowsAccessBridge-64.dll is
 *  absent (no JAB-enabled JVM on this machine), `jab` stays null and every public call degrades to its empty contract —
 *  the dlopen must NOT throw at import time (index.ts/mcp.ts import this module unconditionally). */
function ensureStarted(): void {
  if (started) return;
  started = true;
  try {
    jab = openBridge();
    jab.Windows_run();
    pump(40); // ~1.2s — generous for the JVM to post its registration
  } catch {
    jab = null; // bridge DLL not present — no Java introspection on this box
  }
}

function readWChar(buffer: Buffer, byteOffset: number, maxChars: number): string {
  const end = byteOffset + maxChars * 2;
  let text = '';
  for (let offset = byteOffset; offset < end; offset += 2) {
    const code = buffer.readUInt16LE(offset);
    if (code === 0) break;
    text += String.fromCharCode(code);
  }
  return text;
}

/** Whether the JAB recognizes this window as a Java window (Swing/AWT/JavaFX with the Access Bridge loaded). */
export function isJavaWindow(hWnd: bigint): boolean {
  ensureStarted();
  const bridge = jab;
  if (bridge === null) return false;
  pump(2); // catch a JVM that launched after our handshake
  return bridge.isJavaWindow(hWnd) !== 0;
}

function walk(bridge: Bridge, vmID: number, context: bigint, depth: number, maxDepth: number, budget: { remaining: number; truncated: boolean }): JavaNode | null {
  const info = Buffer.allocUnsafe(INFO_SIZE);
  if (bridge.getAccessibleContextInfo(vmID, context, info.ptr!) === 0) return null;
  const node: JavaNode = {
    role: readWChar(info, 4608, 256) || readWChar(info, 4096, 256), // role_en_US (stable), fall back to localized role
    name: readWChar(info, 0, 1024),
    states: readWChar(info, 5632, 256), // states_en_US (stable, comma-separated)
    description: readWChar(info, 2048, 1024),
    bounds: { x: info.readInt32LE(6152), y: info.readInt32LE(6156), width: info.readInt32LE(6160), height: info.readInt32LE(6164) },
    children: [],
  };
  const childrenCount = info.readInt32LE(6148);
  if (depth < maxDepth) {
    for (let index = 0; index < childrenCount; index += 1) {
      if (budget.remaining <= 0) {
        budget.truncated = true; // node-budget exhausted with siblings still unread
        break;
      }
      const child = bridge.getAccessibleChildFromContext(vmID, context, index);
      if (child === 0n) continue;
      budget.remaining -= 1;
      const childNode = walk(bridge, vmID, child, depth + 1, maxDepth, budget);
      bridge.releaseJavaObject(vmID, child); // release every context the bridge handed us (JVM-side ref)
      if (childNode !== null) node.children.push(childNode);
    }
  } else if (childrenCount > 0) {
    budget.truncated = true; // depth cap hit with children left unread
  }
  return node;
}

/** Read a Java window's accessibility tree via the Access Bridge, or null if it is not a (bridge-visible) Java window.
 *  `maxDepth` bounds depth, `maxNodes` bounds total nodes (a deep Swing tree can be large). Read-only, cursor-free. */
export function javaTree(hWnd: bigint, options: { maxDepth?: number; maxNodes?: number } = {}): JavaNode | null {
  ensureStarted();
  const bridge = jab;
  if (bridge === null) return null;
  pump(2);
  if (bridge.isJavaWindow(hWnd) === 0) return null;
  const vmidBuffer = Buffer.allocUnsafe(4);
  const contextBuffer = Buffer.allocUnsafe(8);
  if (bridge.getAccessibleContextFromHWND(hWnd, vmidBuffer.ptr!, contextBuffer.ptr!) === 0) return null;
  const vmID = vmidBuffer.readInt32LE(0);
  const root = contextBuffer.readBigUInt64LE(0);
  if (root === 0n) return null;
  const budget = { remaining: options.maxNodes ?? 2000, truncated: false };
  try {
    const tree = walk(bridge, vmID, root, 0, options.maxDepth ?? 24, budget);
    if (tree !== null && budget.truncated) tree.truncated = true;
    return tree;
  } finally {
    bridge.releaseJavaObject(vmID, root);
  }
}

/** Render a JavaNode tree as indented text (Spy++/msaa_tree style) for an LLM. */
export function renderJavaTree(node: JavaNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const name = node.name.length > 0 ? ` "${node.name}"` : '';
  const states = node.states.length > 0 ? ` [${node.states}]` : '';
  const description = node.description.length > 0 ? ` (${node.description})` : '';
  const bounds = node.bounds.width > 0 || node.bounds.height > 0 ? ` @${node.bounds.x},${node.bounds.y} ${node.bounds.width}x${node.bounds.height}` : '';
  let out = `${indent}- ${node.role}${name}${states}${description}${bounds}`;
  for (const child of node.children) out += `\n${renderJavaTree(child, depth + 1)}`;
  if (depth === 0 && node.truncated) out += '\n  (… tree truncated — raise maxDepth/maxNodes to read more)';
  return out;
}
