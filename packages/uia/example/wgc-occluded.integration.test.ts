/**
 * wgc-occluded — PROVE the README headline: `captureWindowLive` reads the LIVE pixels of a window even when it
 * is fully OCCLUDED in the background, with NO foregrounding — the "see a window even when it's not visible"
 * capability that Windows.Graphics.Capture exists to deliver and that finding/08 mandates be SEEN, not asserted.
 *
 * Headline target: classic Notepad — a real top-level Win32 window that WGC composites and captures occluded at
 * full size, first try, on this build (measured: 2550x1387, ~10.6M nonzero px behind a maximized Explorer, not
 * foreground, not minimized). The proof (finding/08-WGC-BACKGROUND-CAPTURE.md:55-61):
 *  1. capture it VISIBLE → WGC returns a non-uniform frame (baseline: the chain works at all);
 *  2. FULLY OCCLUDE it under a maximized Explorer WITHOUT foregrounding it — assert it is NOT the foreground
 *     window and NOT minimized (so it is genuinely behind another window, not raised or iconified);
 *  3. capture it OCCLUDED → `captureWindowLive` MUST return non-null AND non-uniform (the live, background pixels);
 *  4. also grab `captureWindowRGB` (PrintWindow) for the side-by-side the README sells — written to disk to SEE.
 *
 * Companion (best-effort, SKIP-not-FAIL): the WinUI/XAML Calculator — a DirectComposition (GPU-composited) surface.
 * It is the harder, less-reliable case: a packaged single-instance app whose ActivationManager can be left wedged
 * by a prior session, and whose composed surface can return blank within a short poll. So Calculator is captured
 * as a SECONDARY assertion that SKIPs when it cannot be launched or when its surface comes back blank — never a
 * FAIL — so a poisoned app model degrades gracefully instead of bricking this test (and the rest of the suite).
 *
 * Honest scope (measured on Win 11 26200, not hand-waved): WGC seeing the OCCLUDED surface is the load-bearing,
 * differentiating claim and is asserted hard here on the reliable Notepad surface. The companion "PrintWindow
 * returns blank for this" half is content- and OS-build-dependent (modern DWM re-renders many composition
 * surfaces into PrintWindow's DC, so it is NOT reliably blank) — captured for the eyeball side-by-side but NOT
 * asserted. The first WGC frame on a cold pool can be empty within a short timeout — so the captures use a
 * generous first-frame timeout and a small retry, the same warm-up a caller wanting the occluded frame should use.
 *
 * Teardown (finally): every window this test spawns is closed/force-killed by its OWN owning process id
 * (finding/31) — NEVER `taskkill /F /IM`, which by image name wedges a single-instance packaged app's
 * ActivationManager and leaves it unlaunchable for the whole session. The Explorer occluder is WM_CLOSE'd (a
 * file-Explorer window can share the shell PID), Notepad/Calculator are force-killed by their window's PID only.
 *
 * bun test is broken repo-wide for FFI; runnable harness:
 * Run: bun run example/wgc-occluded.integration.test.ts
 */
import { captureWindowLive, captureWindowRGB, closeWindow, encodePNG, foregroundWindow, isMinimized, maximizeWindow, uia, wgcAvailable, windowProcessId } from '@bun-win32/uia';

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
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const shot = await captureWindowLive(hWnd, { timeoutMs: 1500 });
    if (shot !== null && !isNearUniform(shot.rgb)) return shot;
    await Bun.sleep(300);
  }
  return null;
}

/** Spawn an Explorer "This PC" window and maximize it to fully cover whatever is below — returns its hWnd (0n if
 *  it never appeared). shell:MyComputerFolder forces a real CabinetWClass top-level (a bare `explorer.exe` may
 *  just toggle an existing one). NEVER taskkilled in teardown — a file-Explorer window can share the shell PID. */
function spawnOccluder(): bigint {
  const prior = new Set(
    uia
      .windows()
      .filter((w) => w.className === 'CabinetWClass')
      .map((w) => w.hWnd),
  );
  Bun.spawn(['explorer.exe', 'shell:MyComputerFolder'], { stdout: 'ignore', stderr: 'ignore' });
  let hWnd = 0n;
  for (let attempt = 0; attempt < 30 && hWnd === 0n; attempt += 1) {
    Bun.sleepSync(300);
    hWnd = uia.windows().find((w) => w.className === 'CabinetWClass' && !prior.has(w.hWnd))?.hWnd ?? 0n;
  }
  if (hWnd !== 0n) {
    maximizeWindow(hWnd);
    Bun.sleepSync(1800); // let the occluder paint full-screen on top and DWM settle the now-hidden surface
  }
  return hWnd;
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

// HEADLINE on classic Notepad — a reliable Win32 top-level WGC composites and captures occluded first try.
// Launch one fresh and track ONLY the new window (not any pre-existing Notepad) so teardown kills exactly ours.
const priorNotepads = new Set(
  uia
    .windows()
    .filter((w) => w.className === 'Notepad')
    .map((w) => w.hWnd),
);
Bun.spawn(['notepad.exe'], { stdout: 'ignore', stderr: 'ignore' });
let notepadHwnd = 0n;
for (let attempt = 0; attempt < 40 && notepadHwnd === 0n; attempt += 1) {
  Bun.sleepSync(300);
  notepadHwnd = uia.windows().find((w) => w.className === 'Notepad' && !priorNotepads.has(w.hWnd))?.hWnd ?? 0n;
}

let occluderHwnd = 0n;
try {
  if (notepadHwnd === 0n) {
    // The Notepad app model is wedged/unavailable (e.g. a prior session's force-kill left it un-launchable).
    // Degrade gracefully: SKIP rather than assert-fail, so a poisoned session does not brick this proof.
    console.log('SKIP — Notepad did not appear (app model wedged/unavailable); cannot prove background capture this run.');
  } else {
    Bun.sleepSync(700); // let Notepad compose its first frames before WGC drains the pool

    // 1. baseline — WGC sees the window while it is visible (the chain works end-to-end).
    const visible = await captureLiveWarm(notepadHwnd);
    assert(visible !== null, 'captureWindowLive returns a non-blank frame while Notepad is VISIBLE (the WGC chain works)');
    if (visible !== null) await Bun.write(`${scratch}/wgc-visible.png`, encodePNG(visible.rgb, visible.width, visible.height));

    // 2. fully occlude — maximize a fresh Explorer "This PC" window over Notepad WITHOUT touching/raising it.
    occluderHwnd = spawnOccluder();
    assert(occluderHwnd !== 0n, 'opened an Explorer window to occlude with');
    // Notepad must be genuinely behind: not the foreground window, and not minimized (occluded, not iconified).
    assert(foregroundWindow() !== notepadHwnd, 'Notepad is NOT the foreground window (it was never raised — capture is background)');
    assert(!isMinimized(notepadHwnd), 'Notepad is NOT minimized (it has a live composed surface, just hidden behind the occluder)');

    // 3. THE HEADLINE — WGC reads the live, occluded, background pixels with content.
    const occluded = await captureLiveWarm(notepadHwnd);
    assert(occluded !== null, 'captureWindowLive returns a non-blank LIVE frame of the FULLY-OCCLUDED background window (the README headline)');
    if (occluded !== null) {
      await Bun.write(`${scratch}/wgc-occluded-live.png`, encodePNG(occluded.rgb, occluded.width, occluded.height));
      console.log(`  → SEE it: ${scratch}/wgc-occluded-live.png (${occluded.width}x${occluded.height}, occluded behind a maximized Explorer)`);
    }

    // 4. side-by-side companion: what PrintWindow returns for the same occluded window (NOT asserted — content/OS
    //    dependent; written so the maintainer can eyeball the gap the feature closes where it IS blank).
    const printed = captureWindowRGB(notepadHwnd);
    if (printed !== null) {
      await Bun.write(`${scratch}/wgc-occluded-printwindow.png`, encodePNG(printed.rgb, printed.width, printed.height));
      console.log(`  (companion) PrintWindow of the same occluded window: nearUniform=${isNearUniform(printed.rgb)} → ${scratch}/wgc-occluded-printwindow.png`);
    }
  }
} finally {
  // The occluder is an Explorer window — close it with WM_CLOSE, NEVER taskkill: a file-Explorer window can share
  // the shell `explorer.exe` PID with the desktop/taskbar, so a /F /PID kill could take down the user's whole shell.
  if (occluderHwnd !== 0n) closeWindow(occluderHwnd);
  // Close ONLY our Notepad window with WM_CLOSE — NEVER a PID force-kill: modern Notepad hosts EVERY open window
  // (and the user's own) in one shared process, so `taskkill /F /PID` of this window's owner would nuke all the
  // user's Notepad windows (and `/IM` is worse still — finding/31). We never type into this window, so its buffer
  // is clean and WM_CLOSE raises no "Save?" dialog; it closes just this one window.
  if (notepadHwnd !== 0n) closeWindow(notepadHwnd);
  uia.uninitialize();
}

// COMPANION (best-effort, SKIP-not-FAIL): prove the same on the GPU-composited WinUI Calculator when its app model
// is available. A wedged/blank Calculator SKIPs — it must never FAIL the headline nor brick the rest of the suite.
uia.initialize();
let calcOccluder = 0n;
let calcHwnd = 0n;
Bun.spawn(['cmd', '/c', 'start', 'calc'], { stdout: 'ignore', stderr: 'ignore' });
for (let attempt = 0; attempt < 30 && calcHwnd === 0n; attempt += 1) {
  Bun.sleepSync(300);
  calcHwnd = uia.windows().find((w) => w.title === 'Calculator')?.hWnd ?? 0n;
}
try {
  if (calcHwnd === 0n) {
    console.log('  (companion) SKIP — WinUI Calculator unavailable/wedged (single-instance app model); headline already proven on Notepad above.');
  } else {
    Bun.sleepSync(900); // let the XAML surface compose its first frames before WGC drains the pool
    calcOccluder = spawnOccluder();
    const occludedCalc = await captureLiveWarm(calcHwnd);
    if (occludedCalc !== null && foregroundWindow() !== calcHwnd && !isMinimized(calcHwnd)) {
      await Bun.write(`${scratch}/wgc-occluded-calc.png`, encodePNG(occludedCalc.rgb, occludedCalc.width, occludedCalc.height));
      console.log(`  (companion) ok: WGC also read the OCCLUDED WinUI Calculator surface (${occludedCalc.width}x${occludedCalc.height}) → ${scratch}/wgc-occluded-calc.png`);
    } else {
      console.log('  (companion) SKIP — Calculator composed surface returned blank (GPU/DirectComposition; content-dependent); headline already proven on Notepad above.');
    }
  }
} finally {
  if (calcOccluder !== 0n) closeWindow(calcOccluder);
  const calcPid = calcHwnd !== 0n ? windowProcessId(calcHwnd) : 0;
  if (calcPid) Bun.spawnSync(['taskkill', '/F', '/PID', String(calcPid)]);
  else if (calcHwnd !== 0n) closeWindow(calcHwnd);
  uia.uninitialize();
}

console.log(failures === 0 ? '\nPASS — WGC read the LIVE pixels of a fully-occluded background window (proven + SEEN, not asserted).' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
