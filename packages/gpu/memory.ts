// GPU resource accounting — pure-TS bookkeeping at the create/release chokepoints.
// GPU memory is invisible to JS heap tools; this is the only observability available.

const tracked = new Map<bigint, { byteSize: number; category: string }>();

export interface GpuMemoryReport {
  bytesByCategory: Record<string, number>;
  liveResources: number;
  totalBytes: number;
}

/** Live GPU resources created through the package's make* helpers (views are not counted; call-transient staging never appears). */
export function gpuMemory(): GpuMemoryReport {
  const bytesByCategory: Record<string, number> = {};
  let totalBytes = 0;
  for (const entry of tracked.values()) {
    bytesByCategory[entry.category] = (bytesByCategory[entry.category] ?? 0) + entry.byteSize;
    totalBytes += entry.byteSize;
  }
  return { bytesByCategory, liveResources: tracked.size, totalBytes };
}

/** Internal: forget every tracked resource and warn when any were leaked (destroyDevice calls this). */
export function reportLeaksAndReset(): void {
  if (tracked.size > 0) {
    let totalBytes = 0;
    for (const entry of tracked.values()) totalBytes += entry.byteSize;
    console.warn(`@bun-win32/gpu: destroyDevice() with ${tracked.size} live GPU resource(s) still tracked (${totalBytes} bytes). GPU memory is never garbage-collected — release buffers/textures/shaders before destroying the device.`);
  }
  tracked.clear();
}

/** Internal: register a created resource (the make* creators call this). */
export function trackResource(handle: bigint, byteSize: number, category: string): void {
  if (handle !== 0n) tracked.set(handle, { byteSize, category });
}

/** Internal: forget a released resource (comRelease calls this). */
export function untrackResource(handle: bigint): void {
  tracked.delete(handle);
}
