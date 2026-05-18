import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type {
  HRESULT,
  LPBOOL,
  NULL,
  PBYTE,
  PCBYTE,
  PCTBS_CONTEXT_PARAMS,
  PTBS_HCONTEXT,
  PUINT32,
  PVOID,
  PWSTR,
  TBS_COMMAND_LOCALITY,
  TBS_COMMAND_PRIORITY,
  TBS_HANDLE,
  TBS_HCONTEXT,
  TBS_OWNERAUTH_TYPE,
  TBS_RESULT,
  UINT32,
} from '../types/Tbs';

/**
 * Thin, lazy-loaded FFI bindings for `tbs.dll`.
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
 * import Tbs from './structs/Tbs';
 *
 * // Lazy: bind on first call
 * const params = Buffer.alloc(4); // TBS_CONTEXT_PARAMS { version }
 * params.writeUInt32LE(1, 0);
 * const ctx = Buffer.alloc(8);
 * Tbs.Tbsi_Context_Create(params.ptr, ctx.ptr);
 *
 * // Or preload a subset to avoid per-symbol lazy binding cost
 * Tbs.Preload(['Tbsi_Context_Create', 'Tbsip_Submit_Command', 'Tbsip_Context_Close']);
 * ```
 */
class Tbs extends Win32 {
  protected static override name = 'tbs.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    GetDeviceID: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetDeviceIDString: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Tbsi_Context_Create: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Create_Windows_Key: { args: [FFIType.u32], returns: FFIType.u32 },
    Tbsi_GetDeviceInfo: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Get_OwnerAuth: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Get_TCG_Log: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Get_TCG_Log_Ex: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Physical_Presence_Command: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    Tbsi_Revoke_Attestation: { args: [], returns: FFIType.u32 },
    Tbsip_Cancel_Commands: { args: [FFIType.u64], returns: FFIType.u32 },
    Tbsip_Context_Close: { args: [FFIType.u64], returns: FFIType.u32 },
    Tbsip_Submit_Command: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-getdeviceid
  public static GetDeviceID(pbWindowsAIK: PBYTE | NULL, cbWindowsAIK: UINT32, pcbResult: PUINT32, pfProtectedByTPM: LPBOOL | NULL): HRESULT {
    return Tbs.Load('GetDeviceID')(pbWindowsAIK, cbWindowsAIK, pcbResult, pfProtectedByTPM);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-getdeviceidstring
  public static GetDeviceIDString(pszWindowsAIK: PWSTR | NULL, cchWindowsAIK: UINT32, pcchResult: PUINT32, pfProtectedByTPM: LPBOOL | NULL): HRESULT {
    return Tbs.Load('GetDeviceIDString')(pszWindowsAIK, cchWindowsAIK, pcchResult, pfProtectedByTPM);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_context_create
  public static Tbsi_Context_Create(pContextParams: PCTBS_CONTEXT_PARAMS, phContext: PTBS_HCONTEXT): TBS_RESULT {
    return Tbs.Load('Tbsi_Context_Create')(pContextParams, phContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_create_windows_key
  public static Tbsi_Create_Windows_Key(keyHandle: TBS_HANDLE): TBS_RESULT {
    return Tbs.Load('Tbsi_Create_Windows_Key')(keyHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_getdeviceinfo
  public static Tbsi_GetDeviceInfo(Size: UINT32, Info: PVOID): TBS_RESULT {
    return Tbs.Load('Tbsi_GetDeviceInfo')(Size, Info);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_get_ownerauth
  public static Tbsi_Get_OwnerAuth(hContext: TBS_HCONTEXT, ownerauthType: TBS_OWNERAUTH_TYPE, pOutputBuf: PBYTE | NULL, pOutputBufLen: PUINT32): TBS_RESULT {
    return Tbs.Load('Tbsi_Get_OwnerAuth')(hContext, ownerauthType, pOutputBuf, pOutputBufLen);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_get_tcg_log
  public static Tbsi_Get_TCG_Log(hContext: TBS_HCONTEXT, pOutputBuf: PBYTE | NULL, pOutputBufLen: PUINT32): TBS_RESULT {
    return Tbs.Load('Tbsi_Get_TCG_Log')(hContext, pOutputBuf, pOutputBufLen);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_get_tcg_log_ex
  public static Tbsi_Get_TCG_Log_Ex(logType: UINT32, pbOutput: PBYTE | NULL, pcbOutput: PUINT32): TBS_RESULT {
    return Tbs.Load('Tbsi_Get_TCG_Log_Ex')(logType, pbOutput, pcbOutput);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_physical_presence_command
  public static Tbsi_Physical_Presence_Command(hContext: TBS_HCONTEXT, pabInput: PCBYTE, cbInput: UINT32, pabOutput: PBYTE, pcbOutput: PUINT32): TBS_RESULT {
    return Tbs.Load('Tbsi_Physical_Presence_Command')(hContext, pabInput, cbInput, pabOutput, pcbOutput);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsi_revoke_attestation
  public static Tbsi_Revoke_Attestation(): TBS_RESULT {
    return Tbs.Load('Tbsi_Revoke_Attestation')();
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsip_cancel_commands
  public static Tbsip_Cancel_Commands(hContext: TBS_HCONTEXT): TBS_RESULT {
    return Tbs.Load('Tbsip_Cancel_Commands')(hContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsip_context_close
  public static Tbsip_Context_Close(hContext: TBS_HCONTEXT): TBS_RESULT {
    return Tbs.Load('Tbsip_Context_Close')(hContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tbs/nf-tbs-tbsip_submit_command
  public static Tbsip_Submit_Command(hContext: TBS_HCONTEXT, Locality: TBS_COMMAND_LOCALITY, Priority: TBS_COMMAND_PRIORITY, pabCommand: PCBYTE, cbCommand: UINT32, pabResult: PBYTE, pcbResult: PUINT32): TBS_RESULT {
    return Tbs.Load('Tbsip_Submit_Command')(hContext, Locality, Priority, pabCommand, cbCommand, pabResult, pcbResult);
  }
}

export default Tbs;
