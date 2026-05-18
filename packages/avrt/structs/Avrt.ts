import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type { AVRT_PRIORITY, BOOL, HANDLE, LPCSTR, LPCWSTR, LPDWORD, LPGUID, NULL, PHANDLE, PLARGE_INTEGER, PULONG } from '../types/Avrt';

/**
 * Thin, lazy-loaded FFI bindings for `avrt.dll`.
 *
 * Each static method corresponds one-to-one with a Win32 export declared in `Symbols`.
 * The first call to a method binds the underlying native symbol via `bun:ffi` and
 * memoizes it on the class for subsequent calls. For bulk, up-front binding, use `Preload`.
 *
 * Symbols are defined with explicit `FFIType` signatures and kept alphabetized.
 * You normally do not access `Symbols` directly; call the static methods or preload
 * a subset for hot paths.
 *
 * @example
 * ```ts
 * import Avrt from './structs/Avrt';
 *
 * // Lazy: bind on first call
 * const taskIndex = Buffer.alloc(4);
 * const handle = Avrt.AvSetMmThreadCharacteristicsW(Buffer.from('Pro Audio\0', 'utf16le').ptr, taskIndex.ptr);
 *
 * // Or preload a subset to avoid per-symbol lazy binding cost
 * Avrt.Preload(['AvSetMmThreadCharacteristicsW', 'AvRevertMmThreadCharacteristics']);
 * ```
 */
class Avrt extends Win32 {
  protected static override name = 'avrt.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    AvQuerySystemResponsiveness: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    AvRevertMmThreadCharacteristics: { args: [FFIType.u64], returns: FFIType.i32 },
    AvRtCreateThreadOrderingGroup: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AvRtCreateThreadOrderingGroupExA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AvRtCreateThreadOrderingGroupExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AvRtDeleteThreadOrderingGroup: { args: [FFIType.u64], returns: FFIType.i32 },
    AvRtJoinThreadOrderingGroup: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    AvRtLeaveThreadOrderingGroup: { args: [FFIType.u64], returns: FFIType.i32 },
    AvRtWaitOnThreadOrderingGroup: { args: [FFIType.u64], returns: FFIType.i32 },
    AvSetMmMaxThreadCharacteristicsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    AvSetMmMaxThreadCharacteristicsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    AvSetMmThreadCharacteristicsA: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    AvSetMmThreadCharacteristicsW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    AvSetMmThreadPriority: { args: [FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avquerysystemresponsiveness
  public static AvQuerySystemResponsiveness(AvrtHandle: HANDLE, SystemResponsivenessValue: PULONG): BOOL {
    return Avrt.Load('AvQuerySystemResponsiveness')(AvrtHandle, SystemResponsivenessValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrevertmmthreadcharacteristics
  public static AvRevertMmThreadCharacteristics(AvrtHandle: HANDLE): BOOL {
    return Avrt.Load('AvRevertMmThreadCharacteristics')(AvrtHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtcreatethreadorderinggroup
  public static AvRtCreateThreadOrderingGroup(Context: PHANDLE, Period: PLARGE_INTEGER, ThreadOrderingGuid: LPGUID, Timeout: PLARGE_INTEGER | NULL): BOOL {
    return Avrt.Load('AvRtCreateThreadOrderingGroup')(Context, Period, ThreadOrderingGuid, Timeout);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtcreatethreadorderinggroupexa
  public static AvRtCreateThreadOrderingGroupExA(Context: PHANDLE, Period: PLARGE_INTEGER, ThreadOrderingGuid: LPGUID, Timeout: PLARGE_INTEGER | NULL, TaskName: LPCSTR): BOOL {
    return Avrt.Load('AvRtCreateThreadOrderingGroupExA')(Context, Period, ThreadOrderingGuid, Timeout, TaskName);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtcreatethreadorderinggroupexw
  public static AvRtCreateThreadOrderingGroupExW(Context: PHANDLE, Period: PLARGE_INTEGER, ThreadOrderingGuid: LPGUID, Timeout: PLARGE_INTEGER | NULL, TaskName: LPCWSTR): BOOL {
    return Avrt.Load('AvRtCreateThreadOrderingGroupExW')(Context, Period, ThreadOrderingGuid, Timeout, TaskName);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtdeletethreadorderinggroup
  public static AvRtDeleteThreadOrderingGroup(Context: HANDLE): BOOL {
    return Avrt.Load('AvRtDeleteThreadOrderingGroup')(Context);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtjointhreadorderinggroup
  public static AvRtJoinThreadOrderingGroup(Context: PHANDLE, ThreadOrderingGuid: LPGUID, Before: BOOL): BOOL {
    return Avrt.Load('AvRtJoinThreadOrderingGroup')(Context, ThreadOrderingGuid, Before);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtleavethreadorderinggroup
  public static AvRtLeaveThreadOrderingGroup(Context: HANDLE): BOOL {
    return Avrt.Load('AvRtLeaveThreadOrderingGroup')(Context);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avrtwaitonthreadorderinggroup
  public static AvRtWaitOnThreadOrderingGroup(Context: HANDLE): BOOL {
    return Avrt.Load('AvRtWaitOnThreadOrderingGroup')(Context);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmmaxthreadcharacteristicsa
  public static AvSetMmMaxThreadCharacteristicsA(FirstTask: LPCSTR, SecondTask: LPCSTR, TaskIndex: LPDWORD): HANDLE {
    return Avrt.Load('AvSetMmMaxThreadCharacteristicsA')(FirstTask, SecondTask, TaskIndex);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmmaxthreadcharacteristicsw
  public static AvSetMmMaxThreadCharacteristicsW(FirstTask: LPCWSTR, SecondTask: LPCWSTR, TaskIndex: LPDWORD): HANDLE {
    return Avrt.Load('AvSetMmMaxThreadCharacteristicsW')(FirstTask, SecondTask, TaskIndex);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsa
  public static AvSetMmThreadCharacteristicsA(TaskName: LPCSTR, TaskIndex: LPDWORD): HANDLE {
    return Avrt.Load('AvSetMmThreadCharacteristicsA')(TaskName, TaskIndex);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadcharacteristicsw
  public static AvSetMmThreadCharacteristicsW(TaskName: LPCWSTR, TaskIndex: LPDWORD): HANDLE {
    return Avrt.Load('AvSetMmThreadCharacteristicsW')(TaskName, TaskIndex);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/avrt/nf-avrt-avsetmmthreadpriority
  public static AvSetMmThreadPriority(AvrtHandle: HANDLE, Priority: AVRT_PRIORITY): BOOL {
    return Avrt.Load('AvSetMmThreadPriority')(AvrtHandle, Priority);
  }
}

export default Avrt;
