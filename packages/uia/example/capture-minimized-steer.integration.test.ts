/**
 * capture-minimized-steer — the capture/OCR tools used to dead-end on a MINIMIZED window: ocr/click_text/capture_window
 * returned a bare error and screenshot fell through to a useless taskbar-button sliver, none telling the agent that a
 * cursor-free restore would unblock them. All four now detect the minimized window on the failure path and return the
 * established restore steer (manage_window {action:"restore"} — cursor-free, no foreground), bypassing the sliver.
 *
 * Proof: minimize a window cursor-free, then assert screenshot / capture_window / ocr / click_text each return the
 * MINIMIZED restore steer (not a sliver image or a bare error); restore it cursor-free and assert screenshot no longer
 * reports minimized. Also asserts the COLD-FRAME path: the FIRST capture_window of a freshly-visible window yields a
 * frame (the one-shot warm retry), not the misleading "protected/DRM, or WGC unavailable" error. Window closed in teardown.
 *
 * bun test is broken repo-wide — runnable harness (MCP subprocess + a spawned, UWP, Calculator):
 * Run: bun run example/capture-minimized-steer.integration.test.ts
 */
import { closeWindow, isMinimized, minimizeWindow, restoreWindow, uia } from '@bun-win32/uia';

type Rpc = { id?: number; result?: { isError?: boolean; content?: { type?: string; text?: string }[] } };
const proc = Bun.spawn(['bun', 'run', `${import.meta.dir}/../mcp.ts`], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...Bun.env, BUN_UIA_PROFILE: 'safe' } });
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = '';
const pending = new Map<number, (message: Rpc) => void>();
void (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (typeof message.id === 'number' && pending.has(message.id)) {
          pending.get(message.id)!(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  }
})();
let nextId = 1;
const call = (method: string, params: unknown): Promise<Rpc> => {
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  proc.stdin.flush();
  return new Promise((resolve) => pending.set(id, resolve));
};
const textOf = (m: Rpc): string => m.result?.content?.[0]?.text ?? '';
const isImage = (m: Rpc): boolean => m.result?.content?.[0]?.type === 'image';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

uia.initialize();
const priorCalc = new Set(uia.windows({ includeUntitled: true }).filter((window) => /Calcul/i.test(window.title)).map((window) => window.hWnd));
const calc = await uia.launch(['cmd', '/c', 'start', 'calc'], { title: 'Calculator' });
const hx = `0x${calc.hWnd.toString(16)}`;
try {
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'capture-min', version: '1' } });
  await Bun.sleep(800);
  await call('tools/call', { name: 'attach', arguments: { hWnd: hx } });

  // Cold-frame: the FIRST capture_window of the freshly-launched, still-visible window must NOT mis-report DRM/unavailable.
  // A cold Direct3D11CaptureFramePool routinely misses its first frame inside the 500ms default — without the one-shot
  // warm retry this returned null and the handler emitted the misleading "protected/DRM content, or WGC unavailable".
  if (!isMinimized(calc.hWnd)) {
    const cold = await call('tools/call', { name: 'capture_window', arguments: { hWnd: hx } });
    assert(isImage(cold) || !/protected\/DRM|unavailable/i.test(textOf(cold)), `first capture_window warms past a cold pool to a frame, not a misleading DRM/unavailable error: ${isImage(cold) ? 'image' : textOf(cold).slice(0, 40)}`);
  } else {
    console.log('  skip: window came up minimized — cold-frame check needs a visible window');
  }

  minimizeWindow(calc.hWnd);
  for (let waited = 0; !isMinimized(calc.hWnd) && waited < 2000; waited += 100) await Bun.sleep(100); // poll, not a fixed sleep — UWP Calc minimizes slowly
  const steers = (m: Rpc): boolean => m.result?.isError === true && /MINIMIZED/i.test(textOf(m)) && /restore/i.test(textOf(m));

  const shot = await call('tools/call', { name: 'screenshot', arguments: {} });
  assert(steers(shot) && !isImage(shot), `screenshot steers to restore (no taskbar sliver) — got: ${JSON.stringify(textOf(shot).slice(0, 60))}`);
  assert(steers(await call('tools/call', { name: 'capture_window', arguments: { hWnd: hx } })), 'capture_window steers to restore');
  assert(steers(await call('tools/call', { name: 'ocr', arguments: { hWnd: hx } })), 'ocr steers to restore');
  assert(steers(await call('tools/call', { name: 'click_text', arguments: { hWnd: hx, text: 'five' } })), 'click_text steers to restore');

  restoreWindow(calc.hWnd);
  await Bun.sleep(500);
  const after = await call('tools/call', { name: 'screenshot', arguments: {} });
  assert(!(/MINIMIZED/i.test(textOf(after))), 'after a cursor-free restore, screenshot no longer reports minimized (the steer unblocked it)');
} finally {
  proc.kill();
  closeWindow(calc.hWnd);
  calc.dispose();
  for (const window of uia.windows({ includeUntitled: true }).filter((w) => /Calcul/i.test(w.title) && !priorCalc.has(w.hWnd))) closeWindow(window.hWnd);
  uia.uninitialize();
}

console.log(failures === 0 ? '\nPASS — capture/OCR tools steer a minimized window to restore; the first capture of a fresh window warms past a cold frame.' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
