/**
 * Windows Sort, Visualized
 *
 * Live, animated proof that you can drive Explorer's own file-name ordering
 * straight from FFI. A deck of mixed filenames and numbers is wrapped in
 * VT_LPWSTR PROPVARIANTs and sorted on screen with an animated insertion sort
 * whose ONLY comparison primitive is propsys' PropVariantCompareEx — the exact
 * comparator the Windows shell uses to order items.
 *
 * The same deck is sorted three times, once per comparison mode, so you can
 * watch the bars settle into three *different* staircases:
 *
 *   • Natural   (PVCF_DEFAULT, StrCmpLogical)  — "img2" < "img10"
 *   • Ordinal   (PVCF_USESTRCMP, StrCmp)        — code-unit order, "img10" < "img2"
 *   • Numbers   (PVCF_DIGITSASNUMBERS…)         — digit runs compared as numbers
 *
 * Bar length encodes each token's final rank under the active comparator, so a
 * fully-sorted deck forms a clean ascending staircase. Pure ANSI rendering.
 *
 * APIs demonstrated (Propsys):
 *   - PropVariantCompareEx         (the sole sort comparator; 3 flag modes)
 *   - PROPVAR_COMPARE_FLAGS        (PVCF_DEFAULT / PVCF_USESTRCMP / digits)
 *   - PROPVAR_COMPARE_UNIT         (PVCU_DEFAULT)
 *
 * APIs demonstrated (cross-package):
 *   - Kernel32.GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT)
 *
 * Run: bun run example/windows-sort-visualizer.ts
 */

import Propsys, { PROPVAR_COMPARE_FLAGS, PROPVAR_COMPARE_UNIT } from '../index';
import Kernel32, { ConsoleMode, STD_HANDLE } from '@bun-win32/kernel32';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[3J';
const HOME = '\x1b[H';

const VT_LPWSTR = 31;
const PROPVARIANT_SIZE = 24;

const deck = ['img10.png', 'img2.png', 'IMG1.PNG', 'photo (10).jpg', 'photo (2).jpg', 'photo (1).jpg', 'track 12', 'track 3', 'Track 02', '2.5', '2.05', '10', '9', 'file-100'];

const stdoutHandle = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const savedModeBuffer = Buffer.alloc(4);
let restoreConsoleMode = false;
if (Kernel32.GetConsoleMode(stdoutHandle, savedModeBuffer.ptr)) {
  restoreConsoleMode = true;
  Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0) | ConsoleMode.ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

function restoreConsole(): void {
  process.stdout.write(SHOW_CURSOR + RESET);
  if (restoreConsoleMode) Kernel32.SetConsoleMode(stdoutHandle, savedModeBuffer.readUInt32LE(0));
}
process.on('SIGINT', () => {
  restoreConsole();
  process.exit(130);
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Each token becomes a VT_LPWSTR PROPVARIANT. The backing UTF-16 buffers are
// retained in `stringBuffers` so their addresses stay valid for every compare.
const stringBuffers: Buffer[] = [];
const propVariants: Buffer[] = deck.map((token) => {
  const text = Buffer.from(`${token}\0`, 'utf16le');
  stringBuffers.push(text);
  const propVariant = Buffer.alloc(PROPVARIANT_SIZE);
  propVariant.writeUInt16LE(VT_LPWSTR, 0);
  propVariant.writeBigUInt64LE(BigInt(text.ptr), 8);
  return propVariant;
});

/** Sign of PropVariantCompareEx(deck[a], deck[b]) under `flags`. */
function compare(a: number, b: number, flags: number): number {
  const result = Propsys.PropVariantCompareEx(propVariants[a]!.ptr, propVariants[b]!.ptr, PROPVAR_COMPARE_UNIT.PVCU_DEFAULT, flags);
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

const modes: { title: string; subtitle: string; flags: number; color: string }[] = [
  { title: 'NATURAL', subtitle: 'PVCF_DEFAULT · StrCmpLogical (Explorer default)', flags: PROPVAR_COMPARE_FLAGS.PVCF_DEFAULT, color: '\x1b[92m' },
  { title: 'ORDINAL', subtitle: 'PVCF_USESTRCMP · StrCmp (code-unit order)', flags: PROPVAR_COMPARE_FLAGS.PVCF_USESTRCMP, color: '\x1b[95m' },
  { title: 'DIGITS-AS-NUMBERS', subtitle: 'PVCF_DIGITSASNUMBERS_CASESENSITIVE', flags: PROPVAR_COMPARE_FLAGS.PVCF_DIGITSASNUMBERS_CASESENSITIVE, color: '\x1b[96m' },
];

const longestToken = Math.max(...deck.map((token) => token.length));

function render(mode: (typeof modes)[number], order: number[], rankOf: number[], sortedUpTo: number, activeSlot: number): string {
  const lines: string[] = [];
  lines.push(`${BOLD}${mode.color}  WINDOWS SORT, VISUALIZED${RESET}   sorted only by ${BOLD}PropVariantCompareEx${RESET}`);
  lines.push(`${DIM}  Mode: ${mode.color}${mode.title}${RESET}${DIM} — ${mode.subtitle}${RESET}`);
  lines.push('');
  for (let slot = 0; slot < order.length; slot += 1) {
    const tokenIndex = order[slot]!;
    const rank = rankOf[tokenIndex]!;
    const barLength = 2 + rank * 3;
    const settled = slot === rank;
    const isActive = slot === activeSlot;
    const inSortedPrefix = slot < sortedUpTo;
    let barColor = DIM;
    if (isActive) barColor = '\x1b[93m';
    else if (settled) barColor = mode.color;
    else if (inSortedPrefix) barColor = '\x1b[94m';
    const bar = `${barColor}${'█'.repeat(barLength)}${RESET}`;
    const marker = isActive ? `${BOLD}\x1b[93m▶${RESET}` : settled ? `${mode.color}✓${RESET}` : ' ';
    const label = deck[tokenIndex]!.padEnd(longestToken);
    lines.push(`  ${marker} ${barColor}${label}${RESET} ${bar}`);
  }
  lines.push('');
  lines.push(`${DIM}  Same deck, three comparators — three different orders. Ctrl+C to stop.${RESET}`);
  return lines.join('\n');
}

function frame(text: string): void {
  process.stdout.write(HOME + text + '\x1b[0J');
}

async function animateMode(mode: (typeof modes)[number]): Promise<number[]> {
  // Final order under this comparator → each token's rank (its target slot).
  const sortedIndices = deck.map((_, index) => index).sort((a, b) => compare(a, b, mode.flags));
  const rankOf = new Array<number>(deck.length);
  sortedIndices.forEach((tokenIndex, slot) => (rankOf[tokenIndex] = slot));

  // Animated insertion sort over a fixed starting permutation.
  const order = deck.map((_, index) => index);
  frame(render(mode, order, rankOf, 0, -1));
  await sleep(650);

  for (let i = 1; i < order.length; i += 1) {
    const key = order[i]!;
    let j = i - 1;
    while (j >= 0 && compare(order[j]!, key, mode.flags) > 0) {
      order[j + 1] = order[j]!;
      order[j] = key;
      j -= 1;
      frame(render(mode, order, rankOf, i + 1, j + 1));
      await sleep(34);
    }
    frame(render(mode, order, rankOf, i + 1, i));
    await sleep(34);
  }
  frame(render(mode, order, rankOf, order.length, -1));
  await sleep(900);
  return order;
}

async function main(): Promise<void> {
  process.stdout.write(HIDE_CURSOR + CLEAR);
  const finalOrders: { mode: string; color: string; tokens: string[] }[] = [];
  for (const mode of modes) {
    const order = await animateMode(mode);
    finalOrders.push({ mode: mode.title, color: mode.color, tokens: order.map((index) => deck[index]!) });
  }

  process.stdout.write(HOME + CLEAR);
  console.log(`\n${BOLD}  Final orderings — produced entirely by propsys' PropVariantCompareEx${RESET}\n`);
  const header = finalOrders.map((column) => `${BOLD}${column.color}${column.mode.padEnd(18)}${RESET}`).join('  ');
  console.log(`  ${header}`);
  console.log(`  ${finalOrders.map(() => '─'.repeat(18)).join('  ')}`);
  for (let row = 0; row < deck.length; row += 1) {
    const cells = finalOrders.map((column) => `${column.color}${column.tokens[row]!.padEnd(18)}${RESET}`).join('  ');
    console.log(`  ${cells}`);
  }
  console.log('');
  restoreConsole();
}

main().then(
  () => process.exit(0),
  (error) => {
    restoreConsole();
    console.error(error);
    process.exit(1);
  },
);
