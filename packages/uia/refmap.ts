// A Snapshot: one cached round-trip over a window's subtree that assigns per-snapshot ref ids
// ('e1', 'e2', …) to the interactable elements and KEEPS each live Element, so an agent can act on
// "ref e12" without re-finding it — the desktop analog of Playwright-MCP's [ref=eN] grounding. Refs
// are valid until dispose(); re-snapshot after any action that changes the tree. Every Element
// materialized by the walk is owned and released on dispose (the source window is NOT touched).

import { AutomationElementMode, createCacheRequest } from './cache';
import { ControlType, TreeScope } from './constants';
import { Element } from './element';
import type { Rect } from './reads';

const INTERACTIVE = new Set<number>([
  ControlType.Button,
  ControlType.CheckBox,
  ControlType.ComboBox,
  ControlType.DataItem,
  ControlType.Document,
  ControlType.Edit,
  ControlType.Header,
  ControlType.HeaderItem,
  ControlType.Hyperlink,
  ControlType.ListItem,
  ControlType.MenuItem,
  ControlType.RadioButton,
  ControlType.Slider,
  ControlType.Spinner,
  ControlType.SplitButton,
  ControlType.Tab,
  ControlType.TabItem,
  ControlType.TreeItem,
]);

/** Whether a control should get an actionable [ref] — the interactive set plus a named Custom (WPF/WinUI
 *  custom-draw invokables surface as Custom; gate on a name + bounds so non-interactive Customs stay unlabeled). */
function isActionable(controlType: number, name: string, hasBounds: boolean): boolean {
  if (!hasBounds) return false;
  return INTERACTIVE.has(controlType) || (controlType === ControlType.Custom && name.trim().length > 0);
}

export interface Mark {
  ref: string;
  role: string;
  name: string;
  bounds: Rect;
}

export interface RefNode {
  /** Present only on interactable nodes — the handle an agent acts on. */
  ref?: string;
  role: string;
  name: string;
  automationId?: string;
  bounds?: Rect;
  enabled?: boolean;
  children: RefNode[];
}

function walk(element: Element, depth: number, maxDepth: number, counter: { value: number }, byRef: Map<string, Element>, owned: Element[], marks: Mark[]): RefNode {
  owned.push(element);
  const controlType = element.cachedControlType;
  const name = element.cachedName;
  const bounds = element.cachedBoundingRectangle;
  const node: RefNode = { role: ControlType[controlType] ?? `Type(${controlType})`, name, children: [] };
  const automationId = element.cachedAutomationId;
  if (automationId.length > 0) node.automationId = automationId;
  const hasBounds = bounds.width !== 0 || bounds.height !== 0;
  if (hasBounds) node.bounds = bounds;
  node.enabled = element.cachedIsEnabled;
  if (isActionable(controlType, name, hasBounds)) {
    const ref = `e${counter.value}`;
    counter.value += 1;
    node.ref = ref;
    byRef.set(ref, element);
    marks.push({ ref, role: node.role, name, bounds });
  }
  if (depth < maxDepth) {
    for (const child of element.cachedChildren) node.children.push(walk(child, depth + 1, maxDepth, counter, byRef, owned, marks));
  }
  return node;
}

export class Snapshot {
  readonly tree: RefNode;
  readonly marks: readonly Mark[];
  readonly #byRef: Map<string, Element>;
  readonly #owned: readonly Element[];
  #disposed = false;

  constructor(tree: RefNode, marks: Mark[], byRef: Map<string, Element>, owned: Element[]) {
    this.tree = tree;
    this.marks = marks;
    this.#byRef = byRef;
    this.#owned = owned;
  }

  /** The live Element for a ref id from this snapshot, or null if the ref is unknown/stale. */
  resolve(ref: string): Element | null {
    return this.#byRef.get(ref) ?? null;
  }

  /** Release every Element this snapshot owns. The source window is unaffected. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const element of this.#owned) element.release();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Build a ref-keyed Snapshot of a window's subtree in one cached round-trip. The caller disposes it. */
export function snapshot(window: Element, options: { maxDepth?: number } = {}): Snapshot {
  const maxDepth = options.maxDepth ?? 40;
  const request = createCacheRequest(undefined, TreeScope.TreeScope_Subtree, AutomationElementMode.Full);
  const cached = window.buildUpdatedCache(request);
  const byRef = new Map<string, Element>();
  const owned: Element[] = [];
  const marks: Mark[] = [];
  try {
    if (cached.ptr === window.ptr) throw new Error('snapshot: BuildUpdatedCache failed (no cached clone)');
    const tree = walk(cached, 0, maxDepth, { value: 1 }, byRef, owned, marks);
    return new Snapshot(tree, marks, byRef, owned);
  } catch (error) {
    for (const element of owned) element.release();
    if (cached.ptr !== window.ptr) cached.release();
    throw error;
  } finally {
    request.release();
  }
}

/** Render a ref-keyed tree to compact, token-economical text (the Playwright-MCP snapshot analog). */
export function renderSnapshot(node: RefNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const label = node.name.trim().length > 0 ? ` ${JSON.stringify(node.name)}` : '';
  const ref = node.ref !== undefined ? ` [ref=${node.ref}]` : '';
  const id = node.automationId !== undefined ? ` id=${node.automationId}` : '';
  let out = `${indent}- ${node.role}${label}${ref}${id}`;
  for (const child of node.children) out += `\n${renderSnapshot(child, depth + 1)}`;
  return out;
}

// Interactive control roles (by name) — the keep-set for pruning, derived from the ref-assigning set so
// the two never drift. An interactive node is kept even when unnamed/ref-less (e.g. an icon-only Button).
const INTERACTIVE_ROLES = new Set<string>([...INTERACTIVE].map((controlType) => ControlType[controlType]).filter((role): role is string => role !== undefined));

/**
 * Prune ref-less structural noise from a snapshot tree before rendering — the single highest-leverage
 * token win, since the rendered tree is auto-appended after every MCP action. Bottom-up: drop a node
 * that has no ref, an empty name, no surviving children, and a non-interactive role; collapse an
 * unnamed ref-less single-child Pane/Group/Custom into that child. EVERY `[ref]` node and EVERY named
 * node is kept, so no actionable target is ever lost (the ref→Element map is untouched regardless).
 * Returns null when the whole node prunes away.
 */
export function pruneRefTree(node: RefNode): RefNode | null {
  const children: RefNode[] = [];
  for (const child of node.children) {
    const kept = pruneRefTree(child);
    if (kept !== null) children.push(kept);
  }
  const unlabeled = node.ref === undefined && node.name.trim().length === 0;
  if (unlabeled && children.length === 0 && !INTERACTIVE_ROLES.has(node.role)) return null;
  if (unlabeled && children.length === 1 && (node.role === 'Custom' || node.role === 'Group' || node.role === 'Pane')) return children[0]!;
  const pruned: RefNode = { role: node.role, name: node.name, children };
  if (node.ref !== undefined) pruned.ref = node.ref;
  if (node.automationId !== undefined) pruned.automationId = node.automationId;
  if (node.bounds !== undefined) pruned.bounds = node.bounds;
  if (node.enabled !== undefined) pruned.enabled = node.enabled;
  return pruned;
}

/** Cap a rendered snapshot to `maxChars` on line boundaries, appending a "…(K more nodes)" trailer — the
 *  hard size budget so a heavy window (IDE/browser/file-manager) cannot dump unbounded tokens per step. */
export function capSnapshot(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > maxChars) break;
    kept.push(line);
    length += line.length + 1;
  }
  return `${kept.join('\n')}\n…(${lines.length - kept.length} more nodes — narrow with desktop_snapshot {maxDepth} or a selector)`;
}
