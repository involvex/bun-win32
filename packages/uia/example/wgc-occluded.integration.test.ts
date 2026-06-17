/**
 * wgc-occluded — PROVE the README headline: `captureWindowLive` reads the LIVE pixels of a window even when it
 * is fully OCCLUDED in the background, with NO foregrounding — the "see a window even when it's not visible"
 * capability that Windows.Graphics.Capture exists to deliver and that finding/08 mandates be SEEN, not asserted.
 *
 * Target: the WinUI/XAML Calculator — a DirectComposition (GPU-composited) surface, the exact window class WGC
 * is for. The proof (finding/08-WGC-BACKGROUND-CAPTURE.md:55-61):
 *  1. capture it VISIBLE → WGC returns a non-uniform frame (baseline: the chain works at all);
 *  2. FULLY OCCLUDE it under a maximized Explorer WITHOUT foregrounding it — assert Calculator is NOT the
 *     foreground window and NOT minimized (so it is genuinely behind another window, not raised or iconified);
 *  3. capture it OCCLUDED → `captureWindowLive` MUST return non-null AND non-uniform (the live, background pixels);
 *  4. also grab `captureWindowRGB` (PrintWindow) for the side-by-side the README sells — written to disk to SEE.
 *
 * Honest scope (measured on Win 11 26200, not hand-waved): WGC seeing the OCCLUDED surface is the load-bearing,
 * differentiating claim and is asserted hard here. The companion "PrintWindow returns blank for this" half is
 * content- and OS-build-dependent (modern DWM re-renders many composition surfaces into PrintWindow's DC, so it
 * is NOT reliably blank for Calculator on this build) — it is captured for the eyeball side-by-side but NOT
 * asserted, so this test proves what is universally true rather than a fragile per-build pixel coincidence.
 * The first WGC frame on a cold pool can be empty within a short timeout — so the captures use a generous
 * first-frame timeout and a small retry, the same warm-up a caller wanting the occluded frame should use.
 *
 * Teardown (finally): the Explorer occluder is WM_CLOSE'd (never taskkilled — a file-Explorer window can share the
 * shell PID), and Calculator is force-killed by its OWNING process id (finding/31) — no leaked window, no Save prompt.
 *
 * bun test is broken repo-wide for FFI; runnable harness:
 * Run: bun run example/wgc-occluded.integration.test.ts
 */
import { captureWindowLive, captureWindowRGB, closeWindow, encodePNG, findWindow, foregroundWindow, isMinimized, maximizeWindow, uia, wgcAvailable, windowProcessId } from '@bun-win32/uia';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

/** True when an RGB grab is blank/flat (PrintWindow returns this on a locked or GPU-composited surface). The
 *  same near-uniform test the MCP `screenshot` tool uses to decide PrintWindow came back blank → fall back to WGC. */
function isNearUniform(rgb: Uint8Array): boolean {
  if (rgb.length < 12) return true;
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  const stride = Math.max(3, Math.floor(rgb.length / (3 * 4096)) * 3); // ~4096 samples
  for (let index = 0; index + 2 < rgb.length; index += stride) {
    const r = rgb[index]!;
    const g = rgb[index + 1]!;
    const b = rgb[index + 2]!;
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (g < minG) minG = g;
    if (g > maxG) maxG = g;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
  }
  return maxR - minR <= 8 && maxG - minG <= 8 && maxB - minB <= 8;
}

/** Capture with a generous first-frame timeout and a small retry — a cold WGC frame pool can return an empty
 *  first frame, so a caller wanting the occluded frame warms it exactly like this. Returns a non-uniform frame or null. */
async function captureLiveWarm(hWnd: bigint): Promise<{ rgb: Uint8Array; width: number; height: number } | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const shot = await captureWindowLive(hWnd, { timeoutMs: 1500 });
    if (shot !== null && !isNearUniform(shot.rgb)) return shot;
    await Bun.sleep(300);
  }
  return null;
}

const scratch = import.meta.dir.replace(/[/\\]example$/, '/.scratch');

uia.initialize();
if (!wgcAvailable()) {
  // A locked / disconnected-RDP / secure-desktop or pre-1809 box: DWM is not compositing, so WGC cannot deliver
  // a frame BY DESIGN (finding/08 hard-limit #2). Skip cleanly rather than fail the differentiating capability.
  console.log('SKIP — Windows.Graphics.Capture unavailable (locked / headless / secure desktop); cannot prove background capture here.');
  uia.uninitialize();
  process.exit(0);
}

// Cold-start from a CLEAN slate: a leftover/zombie CalculatorApp.exe (or a half-dead instance from a prior
// force-kill) makes WGC's occluded poll race on a surface DWM is no longer compositing — the source of the flake.
// Force-kill every Calculator process + its launcher stub, then launch one fresh. Calculator is throwaway here.
Bun.spawnSync(['taskkill', '/F', '/IM', 'CalculatorApp.exe']);
Bun.spawnSync(['taskkill', '/F', '/IM', 'calc.exe']);
Bun.sleepSync(1000);
Bun.spawn(['cmd', '/c', 'start', 'calc'], { stdout: 'ignore', stderr: 'ignore' });
let calcHwnd = 0n;
for (let attempt = 0; attempt < 50 && calcHwnd === 0n; attempt += 1) {
  Bun.sleepSync(300);
  calcHwnd = findWindow({ title: 'Calculator' });
}

let occluderHwnd = 0n;
try {
  assert(calcHwnd !== 0n, 'launched the WinUI Calculator (GPU/DirectComposition target)');
  if (calcHwnd === 0n) throw new Error('Calculator did not appear');
  Bun.sleepSync(900); // let the XAML surface compose its first frames before WGC drains the pool

  // 1. baseline — WGC sees the window while it is visible (the chain works end-to-end).
  const visible = await captureLiveWarm(calcHwnd);
  assert(visible !== null, 'captureWindowLive returns a non-blank frame while Calculator is VISIBLE (the WGC chain works)');
  if (visible !== null) await Bun.write(`${scratch}/wgc-visible.png`, encodePNG(visible.rgb, visible.width, visible.height));

  // 2. fully occlude — maximize a fresh Explorer "This PC" window over Calculator WITHOUT touching/raising it.
  // shell:MyComputerFolder forces a real CabinetWClass top-level (a bare `explorer.exe` may just toggle an existing one).
  const priorExplorers = new Set(
    uia
      .windows()
      .filter((w) => w.className === 'CabinetWClass')
      .map((w) => w.hWnd),
  );
  Bun.spawn(['explorer.exe', 'shell:MyComputerFolder'], { stdout: 'ignore', stderr: 'ignore' });
  for (let attempt = 0; attempt < 30 && occluderHwnd === 0n; attempt += 1) {
    Bun.sleepSync(300);
    occluderHwnd = uia.windows().find((w) => w.className === 'CabinetWClass' && !priorExplorers.has(w.hWnd))?.hWnd ?? 0n;
  }
  assert(occluderHwnd !== 0n, 'opened an Explorer window to occlude with');
  if (occluderHwnd !== 0n) {
    maximizeWindow(occluderHwnd);
    Bun.sleepSync(1800); // let the occluder paint full-screen on top and DWM settle the now-hidden surface
  }
  // Calculator must be genuinely behind: not the foreground window, and not minimized (occluded, not iconified).
  assert(foregroundWindow() !== calcHwnd, 'Calculator is NOT the foreground window (it was never raised — capture is background)');
  assert(!isMinimized(calcHwnd), 'Calculator is NOT minimized (it has a live composed surface, just hidden behind the occluder)');

  // 3. THE HEADLINE — WGC reads the live, occluded, background pixels with content.
  const occluded = await captureLiveWarm(calcHwnd);
  assert(occluded !== null, 'captureWindowLive returns a non-blank LIVE frame of the FULLY-OCCLUDED background window (the README headline)');
  if (occluded !== null) {
    await Bun.write(`${scratch}/wgc-occluded-live.png`, encodePNG(occluded.rgb, occluded.width, occluded.height));
    console.log(`  → SEE it: ${scratch}/wgc-occluded-live.png (${occluded.width}x${occluded.height}, occluded behind a maximized Explorer)`);
  }

  // 4. side-by-side companion: what PrintWindow returns for the same occluded window (NOT asserted — content/OS
  //    dependent; written so the maintainer can eyeball the gap the feature closes where it IS blank).
  const printed = captureWindowRGB(calcHwnd);
  if (printed !== null) {
    await Bun.write(`${scratch}/wgc-occluded-printwindow.png`, encodePNG(printed.rgb, printed.width, printed.height));
    console.log(`  (companion) PrintWindow of the same occluded window: nearUniform=${isNearUniform(printed.rgb)} → ${scratch}/wgc-occluded-printwindow.png`);
  }
} finally {
  // The occluder is an Explorer window — close it with WM_CLOSE, NEVER taskkill: a file-Explorer window can share
  // the shell `explorer.exe` PID with the desktop/taskbar, so a /F /PID kill could take down the user's whole shell.
  if (occluderHwnd !== 0n) closeWindow(occluderHwnd);
  // Calculator is its own CalculatorApp.exe process — force-kill it by the window's owning PID (finding/31): a
  // closeWindow can leave a UWP stub, and there is no Save dialog to strand. The image-name backstop reaps the
  // `calc.exe`/CalculatorApp.exe launcher stub too, so back-to-back runs start clean (no accumulating debris).
  const calcPid = windowProcessId(calcHwnd);
  if (calcPid) Bun.spawnSync(['taskkill', '/F', '/PID', String(calcPid)]);
  else if (calcHwnd !== 0n) closeWindow(calcHwnd);
  Bun.spawnSync(['taskkill', '/F', '/IM', 'CalculatorApp.exe']);
  Bun.spawnSync(['taskkill', '/F', '/IM', 'calc.exe']);
  uia.uninitialize();
}

console.log(failures === 0 ? '\nPASS — WGC read the LIVE pixels of a fully-occluded background window (proven + SEEN, not asserted).' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
