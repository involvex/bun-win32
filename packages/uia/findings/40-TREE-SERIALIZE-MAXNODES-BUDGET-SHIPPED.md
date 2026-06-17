# 40 — uia.tree / serialize / groundingTree / read_tree maxNodes budget — SHIPPED

## The holdout

Finding 39 budgeted `refmap.ts` `snapshot()` (the MCP `desktop_snapshot` path) and jab.ts caps Java trees at
`maxNodes=2000`. But `tree.ts` `serialize()` — i.e. `uia.tree`, `groundingTree`, and the `AGENT_TOOLS` `read_tree`
tool a NON-MCP computer-use agent calls — was the **lone unbounded holdout**. It still ran the exact
`BuildUpdatedCache(TreeScope_Subtree)` that finding 39 was written to kill, and only `maxDepth` bounded the walk —
which (per refmap.ts's own comment) canNOT bound a flat/wide tree because the cost is sibling navigation, not depth.
`agentProfile` pruning ran AFTER the full Subtree marshal already paid the multi-second cost, and on a dense LOB grid
of named controls every node survives the prune.

## Cost isolation (measured, identical 2000-Button WinForms form)

Broke `serialize()` into marshal vs walk:

- `BuildUpdatedCache(TreeScope_Subtree, None)` marshal: **3966 ms** — the whole wall, paid BEFORE any walk.
- enumerate the 2001 `cachedChildren` in-proc: **13 ms**.
- full `groundingTree`: **5860 ms, 2001 nodes, ~98747 tokens**.

So a budget threaded through `walk()` alone (the literal proposed fix) would cut TOKENS but NOT the ~4s marshal wall.
The real lever — proven by finding 39 — is the cache SCOPE: replace the whole-subtree marshal with a per-parent
`BuildCache` child/sibling walk that stops at `maxNodes`.

## The fix (shipped)

1. **`tree.ts`** — `SerializeOptions` gains `maxNodes?` (default **1500**, matching `SNAPSHOT_MAX_NODES`), `UiaNode`
   gains `truncated?`. `serialize()` now builds a `TreeScope_Element` + `AutomationElementMode.Full` cache and
   `walk()` navigates each parent via `Element.firstChildCached` / `nextSiblingCached` (the same cached control-view
   walker BuildCache slots finding 39 added), threading a `Budget = { remaining, truncated }`. When the budget hits 0
   with a parent's children still unwalked, it sets `node.truncated`, releases the remaining child, and stops. The
   `agentProfile` prune now keeps a `truncated` node even with 0 surviving children (the marker is meaningful).
   - **Full mode (not None) is required**: the control-view walker's `*BuildCache` navigation needs a LIVE reference
     to step from. A None-mode (cache-only) root returns `null` on `firstChildCached`, silently dropping the whole
     tree. Verified live: None-mode root → 0 children; Full-mode root → all 2000.
2. **`agent.ts`** — `groundingTree(window, maxNodes?)` threads the budget; the `read_tree` `input_schema` advertises
   the `maxNodes` lever the way `desktop_snapshot` does.
3. **`example/dense-tree-budget.integration.test.ts`** — extended with a `uia.tree` assertion block (regression
   gate): `uia.tree({agentProfile, maxNodes:400})` caps at ≤401 nodes / <30k tokens / <2500 ms with `truncated=true`,
   and an unbounded `uia.tree({maxNodes:100000})` recovers all 2000 buttons.

## Live proof (windows spawned + closed in finally)

- `dense-tree-budget.integration.test.ts` PASS — full output: `uia.tree maxNodes:400 → 401 nodes, ~19648 tokens in
  880 ms (truncated=true)`; unbounded `uia.tree → 2007 nodes (truncated=false)`. (Was **5254 ms / ~99k tokens**.)
- `groundingTree` default (maxNodes=1500): 1501 nodes, **~74k tokens**, truncated — down from 2001 / ~99k.
- Small-tree equivalence (Notepad): old Subtree walk = 46 nodes, new BuildCache walk = **46 nodes identical**; the
  budget never fires under the cap, so output is byte-equivalent on a normal app. Small-tree `serialize` build best of
  20 = **29.4 ms** (perf-gate ceiling 150 ms).

## Tradeoff (accepted — same as finding 39)

The UNBOUNDED walk is a touch slower on a dense window (per-parent BuildCache navigation does more round-trips than
the one-shot Subtree marshal: ~5.4 s vs the old ~5.9 s here — within noise, and tree.ts had no prior fast unbounded
path anyway). The agent path never pays it: it defaults to maxNodes=1500 and an agent can lower it for sub-second.
Small windows are unaffected (~29 ms). `tree.ts` is no longer the unbounded holdout — every tree path (snapshot, jab,
serialize) now carries the same maxNodes budget.
