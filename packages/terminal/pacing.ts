import Kernel32, { INFINITE } from '@bun-win32/kernel32';

const { round } = Math;
const CREATE_WAITABLE_TIMER_HIGH_RESOLUTION = 0x2;
const TIMER_ALL_ACCESS = 0x1f_0003;

Kernel32.Preload(['CreateWaitableTimerExW', 'SetWaitableTimer', 'WaitForSingleObject']);
const { CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject } = Kernel32;

/**
 * Build a precise frame-pacing wait function. Windows' default timer quantises to
 * the ~15.6 ms tick, so a 60 fps cap degrades to ~30 fps; a high-resolution
 * waitable timer (Windows 10 1803+) waits accurately without busy-spinning a core.
 * Returns `null` when the high-resolution timer is unavailable (older Windows).
 *
 * @example
 * const wait = createFrameWaiter();
 * wait?.(16.67); // block for ~16.67 ms
 */
export const createFrameWaiter = (): ((milliseconds: number) => void) | null => {
  try {
    const timer = CreateWaitableTimerExW(null, null, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
    if (!timer) return null;
    const dueTime = new BigInt64Array(1);
    return (milliseconds: number): void => {
      if (milliseconds <= 0) return;
      dueTime[0] = BigInt(-round(milliseconds * 1e4)); // relative, negative, 100 ns units
      SetWaitableTimer(timer, dueTime.ptr, 0, null, null, 0);
      WaitForSingleObject(timer, INFINITE);
    };
  } catch {
    return null;
  }
};
