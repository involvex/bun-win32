import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

/**
 * Thin, lazy-loaded FFI bindings for `fltlib.dll` (Filesystem Filter Manager).
 *
 * Symbols are defined with explicit `FFIType` signatures and kept alphabetized.
 * The first call to a method binds the underlying native symbol via `bun:ffi`
 * and memoizes it; use `Preload` for eager binding.
 */
class Fltlib extends Win32 {
  protected static override name = 'fltlib.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {} as const satisfies Record<string, FFIFunction>;
}

export default Fltlib;
