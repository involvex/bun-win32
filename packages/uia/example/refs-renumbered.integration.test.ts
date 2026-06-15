/**
 * refs-renumbered — the delta-path guard that backs epoch-stamped refs.
 *
 * A snapshot delta only keeps the model's existing refs valid if NO ref id moved to a different control. The
 * appeared/disappeared churn check misses one case: a node flipping ref-eligibility (a Custom gaining/losing its
 * name — refmap.isActionable gates Custom refs on a name) shifts every later ref number, which diffTrees reports as
 * a pure RENAME. refsRenumbered catches it (keyed by path+role+automationId, name-independent) so withSnapshot forces
 * a full re-dump (new generation) instead of a delta that would silently mis-target.
 *
 * Pure function over RefNode trees — no FFI, no windows, fully deterministic.
 * Run: bun run example/refs-renumbered.integration.test.ts
 */
import { refsRenumbered, type RefNode } from '@bun-win32/uia';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

const node = (role: string, name: string, ref: string | undefined, children: RefNode[] = []): RefNode => ({ role, name, ...(ref !== undefined ? { ref } : {}), children });
const root = (...children: RefNode[]): RefNode => node('Pane', 'root', undefined, children);

// 1. The gap: a Custom node gains a name → becomes ref-bearing → the later Button's ref shifts e2→e3.
const beforeGap = root(node('Button', 'A', 'e1'), node('Custom', '', undefined), node('Button', 'B', 'e2'));
const afterGap = root(node('Button', 'A', 'e1'), node('Custom', 'Now Named', 'e2'), node('Button', 'B', 'e3'));
assert(refsRenumbered(beforeGap, afterGap), 'a Custom node gaining a name (and shifting later refs) is detected as renumbered');

// 2. Same ref COUNT but ids reassigned (e.g. order swap) — still renumbered.
const beforeSwap = root(node('Button', 'A', 'e1'), node('Button', 'B', 'e2'));
const afterSwap = root(node('Button', 'A', 'e2'), node('Button', 'B', 'e1'));
assert(refsRenumbered(beforeSwap, afterSwap), 'a ref id moving to a different control (same count) is detected as renumbered');

// 3. Pure value/name change on a ref-LESS node — refs unchanged, NOT renumbered (delta path must stay valid).
const beforeValue = root(node('Button', 'A', 'e1'), node('Text', 'Display is 5', undefined), node('Button', 'B', 'e2'));
const afterValue = root(node('Button', 'A', 'e1'), node('Text', 'Display is 55', undefined), node('Button', 'B', 'e2'));
assert(!refsRenumbered(beforeValue, afterValue), 'a pure value change on a ref-less node is NOT renumbered (no false positive — delta stays valid)');

// 4. A ref-bearing control renamed but keeping its ref — NOT renumbered (the common Δ-delta case).
const beforeRename = root(node('CheckBox', 'Wi-Fi', 'e1'), node('Button', 'B', 'e2'));
const afterRename = root(node('CheckBox', 'Wi-Fi (on)', 'e1'), node('Button', 'B', 'e2'));
assert(!refsRenumbered(beforeRename, afterRename), 'a ref-bearing node renamed but keeping its ref is NOT renumbered');

// 5. Identical trees — not renumbered.
assert(!refsRenumbered(beforeValue, beforeValue), 'identical trees are not renumbered');

console.log(failures === 0 ? '\nPASS — refsRenumbered detects ref-id shifts (incl. the Custom-rename gap) without false-positives on value/name changes.' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
