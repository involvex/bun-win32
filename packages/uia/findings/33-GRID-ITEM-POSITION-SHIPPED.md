# 32 — Reverse grid-cell positioning (GridItemPattern Row/Column) — SHIPPED

## Gap
`PatternId.GridItem` (10007) was DEFINED but consumed by zero methods. The only grid direction implemented
was top-down `cell(row,col)` (GridPattern.GetItem). An agent that located a cell by Name had no way to learn
its (row, column) to read the rest of that record — the natural "find customer X's row, read its Status column"
workflow FlaUI/WinAppDriver expose via `gridItem.Row` / `gridItem.Column` / `gridItem.ContainingGrid`.

## Fix (cursor-free, header-verified slots — no segfault risk)
- `constants.ts`: added `// IUIAutomationGridItemPattern` SLOT group — `get_CurrentContainingGrid:3`,
  `get_CurrentRow:4`, `get_CurrentColumn:5`, `get_CurrentRowSpan:6`, `get_CurrentColumnSpan:7`. Verified vs
  UIAutomationClient.h (10.0.22000.0) IUIAutomationGridItemPatternVtbl AND by the slot-gate test (96 verified,
  0 mismatched — up from 91; the 5 new names parse straight out of the header, no AMBIGUOUS_OWNER needed).
  Also added `PropertyId.IsGridItemPatternAvailable = 30029`.
- `patterns.ts`: `gridItemPosition(ptr): { row, column, rowSpan, columnSpan } | null` — getPattern(GridItem),
  null if 0n, reads the four LONGs via getLong (slots 4-7), releases the pattern. Mirrors readTable/views.
- `element.ts`: `gridPosition()` one-liner next to `cell()`.
- `index.ts`: exports `gridItemPosition`.
- `mcp.ts`: `inspect_element` appends `gridCell: (row R, col C)[ span RxC]` when IsGridItemPatternAvailable,
  and the `can:` builder reads it — the agent sees a cell's coordinates with no extra round-trip.

## Live proof
`example/grid-item-position.integration.test.ts` — opens Explorer details view, asserts
`cell(r,c).gridPosition() === {row:r, column:c}` for (0,0)/(0,1)/(1,0)/(2,1), the container itself reports
null (not a cell), spans are >=1, closeWindow()s in finally. All assertions PASS.

## Not done (lower priority, deferred)
TableItemPattern GetRowHeaderItems/GetColumnHeaderItems (TableItem=10013, PatternId already defined) for FlaUI
tableItem header-item parity — symmetric but a separate slice; GridItem Row/Column is the high-value workflow.
