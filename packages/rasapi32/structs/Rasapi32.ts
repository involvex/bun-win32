import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type {
  BOOL,
  DWORD,
  HANDLE,
  HRASCONN,
  HWND,
  LPBOOL,
  LPBYTE,
  LPCSTR,
  LPCWSTR,
  LPDWORD,
  LPHRASCONN,
  LPRASAUTODIALENTRYA,
  LPRASAUTODIALENTRYW,
  LPRASCONNA,
  LPRASCONNSTATUSA,
  LPRASCONNSTATUSW,
  LPRASCONNW,
  LPRASCREDENTIALSA,
  LPRASCREDENTIALSW,
  LPRASCTRYINFOA,
  LPRASCTRYINFOW,
  LPRASDEVINFOA,
  LPRASDEVINFOW,
  LPRASDIALEXTENSIONS,
  LPRASDIALPARAMSA,
  LPRASDIALPARAMSW,
  LPRASEAPUSERIDENTITYA,
  LPRASEAPUSERIDENTITYW,
  LPRASENTRYA,
  LPRASENTRYNAMEA,
  LPRASENTRYNAMEW,
  LPRASENTRYW,
  LPRASNAPSTATE,
  LPRASSUBENTRYA,
  LPRASSUBENTRYW,
  LPRASUPDATECONN,
  LPRAS_STATS,
  LPSTR,
  LPVOID,
  LPWSTR,
  NULL,
  PLPRASEAPUSERIDENTITYA,
  PLPRASEAPUSERIDENTITYW,
  PLPSTR,
  PLPWSTR,
  PRAS_PROJECTION_INFO,
  RASPROJECTION,
  UINT,
  VOID,
} from '../types/Rasapi32';

/**
 * Thin, lazy-loaded FFI bindings for `rasapi32.dll`.
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
 * import Rasapi32 from './structs/Rasapi32';
 *
 * // Lazy: bind on first call
 * const result = Rasapi32.RasEnumConnectionsW(null, lpcb.ptr, lpcConnections.ptr);
 *
 * // Or preload a subset to avoid per-symbol lazy binding cost
 * Rasapi32.Preload(['RasEnumConnectionsW', 'RasGetConnectStatusW']);
 * ```
 */
class Rasapi32 extends Win32 {
  protected static override name = 'rasapi32.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    RasClearConnectionStatistics: { args: [FFIType.u64], returns: FFIType.u32 },
    RasClearLinkStatistics: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    RasConnectionNotificationA: { args: [FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    RasConnectionNotificationW: { args: [FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.u32 },
    RasCreatePhonebookEntryA: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasCreatePhonebookEntryW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasDeleteEntryA: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasDeleteEntryW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasDeleteSubEntryA: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasDeleteSubEntryW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasDialA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasDialW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEditPhonebookEntryA: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEditPhonebookEntryW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumAutodialAddressesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumAutodialAddressesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumConnectionsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumConnectionsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumDevicesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumDevicesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumEntriesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasEnumEntriesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasFreeEapUserIdentityA: { args: [FFIType.ptr], returns: FFIType.void },
    RasFreeEapUserIdentityW: { args: [FFIType.ptr], returns: FFIType.void },
    RasGetAutodialAddressA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetAutodialAddressW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetAutodialEnableA: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RasGetAutodialEnableW: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RasGetAutodialParamA: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetAutodialParamW: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetConnectStatusA: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetConnectStatusW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetConnectionStatistics: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetCountryInfoA: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetCountryInfoW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetCredentialsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetCredentialsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetCustomAuthDataA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetCustomAuthDataW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEapUserDataA: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEapUserDataW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEapUserIdentityA: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetEapUserIdentityW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetEntryDialParamsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEntryDialParamsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEntryPropertiesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetEntryPropertiesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetErrorStringA: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasGetErrorStringW: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasGetLinkStatistics: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RasGetNapStatus: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasGetProjectionInfoA: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetProjectionInfoEx: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetProjectionInfoW: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetSubEntryHandleA: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RasGetSubEntryHandleW: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RasGetSubEntryPropertiesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasGetSubEntryPropertiesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasHangUpA: { args: [FFIType.u64], returns: FFIType.u32 },
    RasHangUpW: { args: [FFIType.u64], returns: FFIType.u32 },
    RasInvokeEapUI: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.u32 },
    RasRenameEntryA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasRenameEntryW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasSetAutodialAddressA: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
    RasSetAutodialAddressW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
    RasSetAutodialEnableA: { args: [FFIType.u32, FFIType.i32], returns: FFIType.u32 },
    RasSetAutodialEnableW: { args: [FFIType.u32, FFIType.i32], returns: FFIType.u32 },
    RasSetAutodialParamA: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetAutodialParamW: { args: [FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetCredentialsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    RasSetCredentialsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    RasSetCustomAuthDataA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetCustomAuthDataW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetEapUserDataA: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetEapUserDataW: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetEntryDialParamsA: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    RasSetEntryDialParamsW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.u32 },
    RasSetEntryPropertiesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetEntryPropertiesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetSubEntryPropertiesA: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasSetSubEntryPropertiesW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    RasUpdateConnection: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    RasValidateEntryNameA: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RasValidateEntryNameW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasclearconnectionstatistics
  public static RasClearConnectionStatistics(hRasConn: HRASCONN): DWORD {
    return Rasapi32.Load('RasClearConnectionStatistics')(hRasConn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasclearlinkstatistics
  public static RasClearLinkStatistics(hRasConn: HRASCONN, dwSubEntry: DWORD): DWORD {
    return Rasapi32.Load('RasClearLinkStatistics')(hRasConn, dwSubEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasconnectionnotificationa
  public static RasConnectionNotificationA(hrasconn: HRASCONN, hEvent: HANDLE, dwFlags: DWORD): DWORD {
    return Rasapi32.Load('RasConnectionNotificationA')(hrasconn, hEvent, dwFlags);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasconnectionnotificationw
  public static RasConnectionNotificationW(hrasconn: HRASCONN, hEvent: HANDLE, dwFlags: DWORD): DWORD {
    return Rasapi32.Load('RasConnectionNotificationW')(hrasconn, hEvent, dwFlags);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rascreatephonebookentrya
  public static RasCreatePhonebookEntryA(hwnd: HWND, lpszPhonebook: LPCSTR | NULL): DWORD {
    return Rasapi32.Load('RasCreatePhonebookEntryA')(hwnd, lpszPhonebook);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rascreatephonebookentryw
  public static RasCreatePhonebookEntryW(hwnd: HWND, lpszPhonebook: LPCWSTR | NULL): DWORD {
    return Rasapi32.Load('RasCreatePhonebookEntryW')(hwnd, lpszPhonebook);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdeleteentrya
  public static RasDeleteEntryA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR): DWORD {
    return Rasapi32.Load('RasDeleteEntryA')(lpszPhonebook, lpszEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdeleteentryw
  public static RasDeleteEntryW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR): DWORD {
    return Rasapi32.Load('RasDeleteEntryW')(lpszPhonebook, lpszEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdeletesubentrya
  public static RasDeleteSubEntryA(pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, dwSubentryId: DWORD): DWORD {
    return Rasapi32.Load('RasDeleteSubEntryA')(pszPhonebook, pszEntry, dwSubentryId);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdeletesubentryw
  public static RasDeleteSubEntryW(pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, dwSubEntryId: DWORD): DWORD {
    return Rasapi32.Load('RasDeleteSubEntryW')(pszPhonebook, pszEntry, dwSubEntryId);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdiala
  public static RasDialA(lpRasDialExtensions: LPRASDIALEXTENSIONS | NULL, lpszPhonebook: LPCSTR | NULL, lpRasDialParams: LPRASDIALPARAMSA, dwNotifierType: DWORD, lpvNotifier: LPVOID | NULL, lphRasConn: LPHRASCONN): DWORD {
    return Rasapi32.Load('RasDialA')(lpRasDialExtensions, lpszPhonebook, lpRasDialParams, dwNotifierType, lpvNotifier, lphRasConn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasdialw
  public static RasDialW(lpRasDialExtensions: LPRASDIALEXTENSIONS | NULL, lpszPhonebook: LPCWSTR | NULL, lpRasDialParams: LPRASDIALPARAMSW, dwNotifierType: DWORD, lpvNotifier: LPVOID | NULL, lphRasConn: LPHRASCONN): DWORD {
    return Rasapi32.Load('RasDialW')(lpRasDialExtensions, lpszPhonebook, lpRasDialParams, dwNotifierType, lpvNotifier, lphRasConn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-raseditphonebookentrya
  public static RasEditPhonebookEntryA(hwnd: HWND, lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR): DWORD {
    return Rasapi32.Load('RasEditPhonebookEntryA')(hwnd, lpszPhonebook, lpszEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-raseditphonebookentryw
  public static RasEditPhonebookEntryW(hwnd: HWND, lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR): DWORD {
    return Rasapi32.Load('RasEditPhonebookEntryW')(hwnd, lpszPhonebook, lpszEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumautodialaddressesa
  public static RasEnumAutodialAddressesA(lppRasAutodialAddresses: PLPSTR | NULL, lpdwcbRasAutodialAddresses: LPDWORD, lpdwcRasAutodialAddresses: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumAutodialAddressesA')(lppRasAutodialAddresses, lpdwcbRasAutodialAddresses, lpdwcRasAutodialAddresses);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumautodialaddressesw
  public static RasEnumAutodialAddressesW(lppRasAutodialAddresses: PLPWSTR | NULL, lpdwcbRasAutodialAddresses: LPDWORD, lpdwcRasAutodialAddresses: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumAutodialAddressesW')(lppRasAutodialAddresses, lpdwcbRasAutodialAddresses, lpdwcRasAutodialAddresses);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumconnectionsa
  public static RasEnumConnectionsA(lprasconn: LPRASCONNA | NULL, lpcb: LPDWORD, lpcConnections: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumConnectionsA')(lprasconn, lpcb, lpcConnections);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumconnectionsw
  public static RasEnumConnectionsW(lprasconn: LPRASCONNW | NULL, lpcb: LPDWORD, lpcConnections: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumConnectionsW')(lprasconn, lpcb, lpcConnections);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumdevicesa
  public static RasEnumDevicesA(lpRasDevInfo: LPRASDEVINFOA | NULL, lpcb: LPDWORD, lpcDevices: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumDevicesA')(lpRasDevInfo, lpcb, lpcDevices);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumdevicesw
  public static RasEnumDevicesW(lpRasDevInfo: LPRASDEVINFOW | NULL, lpcb: LPDWORD, lpcDevices: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumDevicesW')(lpRasDevInfo, lpcb, lpcDevices);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumentriesa
  public static RasEnumEntriesA(reserved: LPCSTR | NULL, lpszPhonebook: LPCSTR | NULL, lprasentryname: LPRASENTRYNAMEA | NULL, lpcb: LPDWORD, lpcEntries: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumEntriesA')(reserved, lpszPhonebook, lprasentryname, lpcb, lpcEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasenumentriesw
  public static RasEnumEntriesW(reserved: LPCWSTR | NULL, lpszPhonebook: LPCWSTR | NULL, lprasentryname: LPRASENTRYNAMEW | NULL, lpcb: LPDWORD, lpcEntries: LPDWORD): DWORD {
    return Rasapi32.Load('RasEnumEntriesW')(reserved, lpszPhonebook, lprasentryname, lpcb, lpcEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasfreeeapuseridentitya
  public static RasFreeEapUserIdentityA(pRasEapUserIdentity: LPRASEAPUSERIDENTITYA | NULL): VOID {
    return Rasapi32.Load('RasFreeEapUserIdentityA')(pRasEapUserIdentity);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasfreeeapuseridentityw
  public static RasFreeEapUserIdentityW(pRasEapUserIdentity: LPRASEAPUSERIDENTITYW | NULL): VOID {
    return Rasapi32.Load('RasFreeEapUserIdentityW')(pRasEapUserIdentity);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialaddressa
  public static RasGetAutodialAddressA(lpszAddress: LPCSTR | NULL, lpdwReserved: LPDWORD | NULL, lpAutoDialEntries: LPRASAUTODIALENTRYA | NULL, lpdwcbAutoDialEntries: LPDWORD, lpdwcAutoDialEntries: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetAutodialAddressA')(lpszAddress, lpdwReserved, lpAutoDialEntries, lpdwcbAutoDialEntries, lpdwcAutoDialEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialaddressw
  public static RasGetAutodialAddressW(lpszAddress: LPCWSTR | NULL, lpdwReserved: LPDWORD | NULL, lpAutoDialEntries: LPRASAUTODIALENTRYW | NULL, lpdwcbAutoDialEntries: LPDWORD, lpdwcAutoDialEntries: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetAutodialAddressW')(lpszAddress, lpdwReserved, lpAutoDialEntries, lpdwcbAutoDialEntries, lpdwcAutoDialEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialenablea
  public static RasGetAutodialEnableA(dwDialingLocation: DWORD, lpfEnabled: LPBOOL): DWORD {
    return Rasapi32.Load('RasGetAutodialEnableA')(dwDialingLocation, lpfEnabled);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialenablew
  public static RasGetAutodialEnableW(dwDialingLocation: DWORD, lpfEnabled: LPBOOL): DWORD {
    return Rasapi32.Load('RasGetAutodialEnableW')(dwDialingLocation, lpfEnabled);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialparama
  public static RasGetAutodialParamA(dwKey: DWORD, lpvValue: LPVOID, lpdwcbValue: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetAutodialParamA')(dwKey, lpvValue, lpdwcbValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetautodialparamw
  public static RasGetAutodialParamW(dwKey: DWORD, lpvValue: LPVOID, lpdwcbValue: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetAutodialParamW')(dwKey, lpvValue, lpdwcbValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetconnectstatusa
  public static RasGetConnectStatusA(hrasconn: HRASCONN, lprasconnstatus: LPRASCONNSTATUSA): DWORD {
    return Rasapi32.Load('RasGetConnectStatusA')(hrasconn, lprasconnstatus);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetconnectstatusw
  public static RasGetConnectStatusW(hrasconn: HRASCONN, lprasconnstatus: LPRASCONNSTATUSW): DWORD {
    return Rasapi32.Load('RasGetConnectStatusW')(hrasconn, lprasconnstatus);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetconnectionstatistics
  public static RasGetConnectionStatistics(hRasConn: HRASCONN, lpStatistics: LPRAS_STATS): DWORD {
    return Rasapi32.Load('RasGetConnectionStatistics')(hRasConn, lpStatistics);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcountryinfoa
  public static RasGetCountryInfoA(lpRasCtryInfo: LPRASCTRYINFOA | NULL, lpdwSize: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetCountryInfoA')(lpRasCtryInfo, lpdwSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcountryinfow
  public static RasGetCountryInfoW(lpRasCtryInfo: LPRASCTRYINFOW | NULL, lpdwSize: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetCountryInfoW')(lpRasCtryInfo, lpdwSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcredentialsa
  public static RasGetCredentialsA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR, lpCredentials: LPRASCREDENTIALSA): DWORD {
    return Rasapi32.Load('RasGetCredentialsA')(lpszPhonebook, lpszEntry, lpCredentials);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcredentialsw
  public static RasGetCredentialsW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR, lpCredentials: LPRASCREDENTIALSW): DWORD {
    return Rasapi32.Load('RasGetCredentialsW')(lpszPhonebook, lpszEntry, lpCredentials);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcustomauthdataa
  public static RasGetCustomAuthDataA(pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, pbCustomAuthData: LPBYTE | NULL, pdwSizeofCustomAuthData: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetCustomAuthDataA')(pszPhonebook, pszEntry, pbCustomAuthData, pdwSizeofCustomAuthData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetcustomauthdataw
  public static RasGetCustomAuthDataW(pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, pbCustomAuthData: LPBYTE | NULL, pdwSizeofCustomAuthData: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetCustomAuthDataW')(pszPhonebook, pszEntry, pbCustomAuthData, pdwSizeofCustomAuthData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeteapuserdataa
  public static RasGetEapUserDataA(hToken: HANDLE | 0n, pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, pbEapData: LPBYTE | NULL, pdwSizeofEapData: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetEapUserDataA')(hToken, pszPhonebook, pszEntry, pbEapData, pdwSizeofEapData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeteapuserdataw
  public static RasGetEapUserDataW(hToken: HANDLE | 0n, pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, pbEapData: LPBYTE | NULL, pdwSizeofEapData: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetEapUserDataW')(hToken, pszPhonebook, pszEntry, pbEapData, pdwSizeofEapData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeteapuseridentitya
  public static RasGetEapUserIdentityA(pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, dwFlags: DWORD, hwnd: HWND | 0n, ppRasEapUserIdentity: PLPRASEAPUSERIDENTITYA): DWORD {
    return Rasapi32.Load('RasGetEapUserIdentityA')(pszPhonebook, pszEntry, dwFlags, hwnd, ppRasEapUserIdentity);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeteapuseridentityw
  public static RasGetEapUserIdentityW(pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, dwFlags: DWORD, hwnd: HWND | 0n, ppRasEapUserIdentity: PLPRASEAPUSERIDENTITYW): DWORD {
    return Rasapi32.Load('RasGetEapUserIdentityW')(pszPhonebook, pszEntry, dwFlags, hwnd, ppRasEapUserIdentity);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetentrydialparamsa
  public static RasGetEntryDialParamsA(lpszPhonebook: LPCSTR | NULL, lpRasDialParams: LPRASDIALPARAMSA, lpfPassword: LPBOOL): DWORD {
    return Rasapi32.Load('RasGetEntryDialParamsA')(lpszPhonebook, lpRasDialParams, lpfPassword);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetentrydialparamsw
  public static RasGetEntryDialParamsW(lpszPhonebook: LPCWSTR | NULL, lpRasDialParams: LPRASDIALPARAMSW, lpfPassword: LPBOOL): DWORD {
    return Rasapi32.Load('RasGetEntryDialParamsW')(lpszPhonebook, lpRasDialParams, lpfPassword);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetentrypropertiesa
  public static RasGetEntryPropertiesA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR, lpRasEntry: LPRASENTRYA | NULL, lpdwEntryInfoSize: LPDWORD | NULL, lpbDeviceInfo: LPBYTE | NULL, lpdwDeviceInfoSize: LPDWORD | NULL): DWORD {
    return Rasapi32.Load('RasGetEntryPropertiesA')(lpszPhonebook, lpszEntry, lpRasEntry, lpdwEntryInfoSize, lpbDeviceInfo, lpdwDeviceInfoSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetentrypropertiesw
  public static RasGetEntryPropertiesW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR, lpRasEntry: LPRASENTRYW | NULL, lpdwEntryInfoSize: LPDWORD | NULL, lpbDeviceInfo: LPBYTE | NULL, lpdwDeviceInfoSize: LPDWORD | NULL): DWORD {
    return Rasapi32.Load('RasGetEntryPropertiesW')(lpszPhonebook, lpszEntry, lpRasEntry, lpdwEntryInfoSize, lpbDeviceInfo, lpdwDeviceInfoSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeterrorstringa
  public static RasGetErrorStringA(ResourceId: UINT, lpszString: LPSTR, InBufSize: DWORD): DWORD {
    return Rasapi32.Load('RasGetErrorStringA')(ResourceId, lpszString, InBufSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgeterrorstringw
  public static RasGetErrorStringW(ResourceId: UINT, lpszString: LPWSTR, InBufSize: DWORD): DWORD {
    return Rasapi32.Load('RasGetErrorStringW')(ResourceId, lpszString, InBufSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetlinkstatistics
  public static RasGetLinkStatistics(hRasConn: HRASCONN, dwSubEntry: DWORD, lpStatistics: LPRAS_STATS): DWORD {
    return Rasapi32.Load('RasGetLinkStatistics')(hRasConn, dwSubEntry, lpStatistics);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetnapstatus
  public static RasGetNapStatus(hRasconn: HRASCONN, pRasNapState: LPRASNAPSTATE): DWORD {
    return Rasapi32.Load('RasGetNapStatus')(hRasconn, pRasNapState);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetprojectioninfo
  public static RasGetProjectionInfoA(hrasconn: HRASCONN, rasprojection: RASPROJECTION, lpprojection: LPVOID, lpcb: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetProjectionInfoA')(hrasconn, rasprojection, lpprojection, lpcb);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetprojectioninfoex
  public static RasGetProjectionInfoEx(hrasconn: HRASCONN, pRasProjection: PRAS_PROJECTION_INFO | NULL, lpdwSize: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetProjectionInfoEx')(hrasconn, pRasProjection, lpdwSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetprojectioninfo
  public static RasGetProjectionInfoW(hrasconn: HRASCONN, rasprojection: RASPROJECTION, lpprojection: LPVOID, lpcb: LPDWORD): DWORD {
    return Rasapi32.Load('RasGetProjectionInfoW')(hrasconn, rasprojection, lpprojection, lpcb);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetsubentryhandlea
  public static RasGetSubEntryHandleA(hrasconn: HRASCONN, dwSubEntry: DWORD, lphrasconn: LPHRASCONN): DWORD {
    return Rasapi32.Load('RasGetSubEntryHandleA')(hrasconn, dwSubEntry, lphrasconn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetsubentryhandlew
  public static RasGetSubEntryHandleW(hrasconn: HRASCONN, dwSubEntry: DWORD, lphrasconn: LPHRASCONN): DWORD {
    return Rasapi32.Load('RasGetSubEntryHandleW')(hrasconn, dwSubEntry, lphrasconn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetsubentrypropertiesa
  public static RasGetSubEntryPropertiesA(
    lpszPhonebook: LPCSTR | NULL,
    lpszEntry: LPCSTR,
    dwSubEntry: DWORD,
    lpRasSubEntry: LPRASSUBENTRYA | NULL,
    lpdwcb: LPDWORD | NULL,
    lpbDeviceConfig: LPBYTE | NULL,
    lpdwcbDeviceConfig: LPDWORD | NULL,
  ): DWORD {
    return Rasapi32.Load('RasGetSubEntryPropertiesA')(lpszPhonebook, lpszEntry, dwSubEntry, lpRasSubEntry, lpdwcb, lpbDeviceConfig, lpdwcbDeviceConfig);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasgetsubentrypropertiesw
  public static RasGetSubEntryPropertiesW(
    lpszPhonebook: LPCWSTR | NULL,
    lpszEntry: LPCWSTR,
    dwSubEntry: DWORD,
    lpRasSubEntry: LPRASSUBENTRYW | NULL,
    lpdwcb: LPDWORD | NULL,
    lpbDeviceConfig: LPBYTE | NULL,
    lpdwcbDeviceConfig: LPDWORD | NULL,
  ): DWORD {
    return Rasapi32.Load('RasGetSubEntryPropertiesW')(lpszPhonebook, lpszEntry, dwSubEntry, lpRasSubEntry, lpdwcb, lpbDeviceConfig, lpdwcbDeviceConfig);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rashangupa
  public static RasHangUpA(hrasconn: HRASCONN): DWORD {
    return Rasapi32.Load('RasHangUpA')(hrasconn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rashangupw
  public static RasHangUpW(hrasconn: HRASCONN): DWORD {
    return Rasapi32.Load('RasHangUpW')(hrasconn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasinvokeeapui
  public static RasInvokeEapUI(hrasconn: HRASCONN, dwSubEntry: DWORD, lpRasDialExtensions: LPRASDIALEXTENSIONS, hwnd: HWND): DWORD {
    return Rasapi32.Load('RasInvokeEapUI')(hrasconn, dwSubEntry, lpRasDialExtensions, hwnd);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasrenameentrya
  public static RasRenameEntryA(lpszPhonebook: LPCSTR | NULL, lpszOldEntry: LPCSTR, lpszNewEntry: LPCSTR): DWORD {
    return Rasapi32.Load('RasRenameEntryA')(lpszPhonebook, lpszOldEntry, lpszNewEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasrenameentryw
  public static RasRenameEntryW(lpszPhonebook: LPCWSTR | NULL, lpszOldEntry: LPCWSTR, lpszNewEntry: LPCWSTR): DWORD {
    return Rasapi32.Load('RasRenameEntryW')(lpszPhonebook, lpszOldEntry, lpszNewEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialaddressa
  public static RasSetAutodialAddressA(lpszAddress: LPCSTR | NULL, dwReserved: DWORD, lpAutoDialEntries: LPRASAUTODIALENTRYA | NULL, dwcbAutoDialEntries: DWORD, dwcAutoDialEntries: DWORD): DWORD {
    return Rasapi32.Load('RasSetAutodialAddressA')(lpszAddress, dwReserved, lpAutoDialEntries, dwcbAutoDialEntries, dwcAutoDialEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialaddressw
  public static RasSetAutodialAddressW(lpszAddress: LPCWSTR | NULL, dwReserved: DWORD, lpAutoDialEntries: LPRASAUTODIALENTRYW | NULL, dwcbAutoDialEntries: DWORD, dwcAutoDialEntries: DWORD): DWORD {
    return Rasapi32.Load('RasSetAutodialAddressW')(lpszAddress, dwReserved, lpAutoDialEntries, dwcbAutoDialEntries, dwcAutoDialEntries);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialenablea
  public static RasSetAutodialEnableA(dwDialingLocation: DWORD, fEnabled: BOOL): DWORD {
    return Rasapi32.Load('RasSetAutodialEnableA')(dwDialingLocation, fEnabled);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialenablew
  public static RasSetAutodialEnableW(dwDialingLocation: DWORD, fEnabled: BOOL): DWORD {
    return Rasapi32.Load('RasSetAutodialEnableW')(dwDialingLocation, fEnabled);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialparama
  public static RasSetAutodialParamA(dwKey: DWORD, lpvValue: LPVOID, dwcbValue: DWORD): DWORD {
    return Rasapi32.Load('RasSetAutodialParamA')(dwKey, lpvValue, dwcbValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetautodialparamw
  public static RasSetAutodialParamW(dwKey: DWORD, lpvValue: LPVOID, dwcbValue: DWORD): DWORD {
    return Rasapi32.Load('RasSetAutodialParamW')(dwKey, lpvValue, dwcbValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetcredentialsa
  public static RasSetCredentialsA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR, lpCredentials: LPRASCREDENTIALSA, fClearCredentials: BOOL): DWORD {
    return Rasapi32.Load('RasSetCredentialsA')(lpszPhonebook, lpszEntry, lpCredentials, fClearCredentials);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetcredentialsw
  public static RasSetCredentialsW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR, lpCredentials: LPRASCREDENTIALSW, fClearCredentials: BOOL): DWORD {
    return Rasapi32.Load('RasSetCredentialsW')(lpszPhonebook, lpszEntry, lpCredentials, fClearCredentials);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetcustomauthdataa
  public static RasSetCustomAuthDataA(pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, pbCustomAuthData: LPBYTE, dwSizeofCustomAuthData: DWORD): DWORD {
    return Rasapi32.Load('RasSetCustomAuthDataA')(pszPhonebook, pszEntry, pbCustomAuthData, dwSizeofCustomAuthData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetcustomauthdataw
  public static RasSetCustomAuthDataW(pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, pbCustomAuthData: LPBYTE, dwSizeofCustomAuthData: DWORD): DWORD {
    return Rasapi32.Load('RasSetCustomAuthDataW')(pszPhonebook, pszEntry, pbCustomAuthData, dwSizeofCustomAuthData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasseteapuserdataa
  public static RasSetEapUserDataA(hToken: HANDLE | 0n, pszPhonebook: LPCSTR | NULL, pszEntry: LPCSTR, pbEapData: LPBYTE, dwSizeofEapData: DWORD): DWORD {
    return Rasapi32.Load('RasSetEapUserDataA')(hToken, pszPhonebook, pszEntry, pbEapData, dwSizeofEapData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasseteapuserdataw
  public static RasSetEapUserDataW(hToken: HANDLE | 0n, pszPhonebook: LPCWSTR | NULL, pszEntry: LPCWSTR, pbEapData: LPBYTE, dwSizeofEapData: DWORD): DWORD {
    return Rasapi32.Load('RasSetEapUserDataW')(hToken, pszPhonebook, pszEntry, pbEapData, dwSizeofEapData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetentrydialparamsa
  public static RasSetEntryDialParamsA(lpszPhonebook: LPCSTR | NULL, lpRasDialParams: LPRASDIALPARAMSA, fRemovePassword: BOOL): DWORD {
    return Rasapi32.Load('RasSetEntryDialParamsA')(lpszPhonebook, lpRasDialParams, fRemovePassword);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetentrydialparamsw
  public static RasSetEntryDialParamsW(lpszPhonebook: LPCWSTR | NULL, lpRasDialParams: LPRASDIALPARAMSW, fRemovePassword: BOOL): DWORD {
    return Rasapi32.Load('RasSetEntryDialParamsW')(lpszPhonebook, lpRasDialParams, fRemovePassword);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetentrypropertiesa
  public static RasSetEntryPropertiesA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR, lpRasEntry: LPRASENTRYA, dwEntryInfoSize: DWORD, lpbDeviceInfo: LPBYTE | NULL, dwDeviceInfoSize: DWORD): DWORD {
    return Rasapi32.Load('RasSetEntryPropertiesA')(lpszPhonebook, lpszEntry, lpRasEntry, dwEntryInfoSize, lpbDeviceInfo, dwDeviceInfoSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetentrypropertiesw
  public static RasSetEntryPropertiesW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR, lpRasEntry: LPRASENTRYW, dwEntryInfoSize: DWORD, lpbDeviceInfo: LPBYTE | NULL, dwDeviceInfoSize: DWORD): DWORD {
    return Rasapi32.Load('RasSetEntryPropertiesW')(lpszPhonebook, lpszEntry, lpRasEntry, dwEntryInfoSize, lpbDeviceInfo, dwDeviceInfoSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetsubentrypropertiesa
  public static RasSetSubEntryPropertiesA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR, dwSubEntry: DWORD, lpRasSubEntry: LPRASSUBENTRYA, dwcbRasSubEntry: DWORD, lpbDeviceConfig: LPBYTE | NULL, dwcbDeviceConfig: DWORD): DWORD {
    return Rasapi32.Load('RasSetSubEntryPropertiesA')(lpszPhonebook, lpszEntry, dwSubEntry, lpRasSubEntry, dwcbRasSubEntry, lpbDeviceConfig, dwcbDeviceConfig);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rassetsubentrypropertiesw
  public static RasSetSubEntryPropertiesW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR, dwSubEntry: DWORD, lpRasSubEntry: LPRASSUBENTRYW, dwcbRasSubEntry: DWORD, lpbDeviceConfig: LPBYTE | NULL, dwcbDeviceConfig: DWORD): DWORD {
    return Rasapi32.Load('RasSetSubEntryPropertiesW')(lpszPhonebook, lpszEntry, dwSubEntry, lpRasSubEntry, dwcbRasSubEntry, lpbDeviceConfig, dwcbDeviceConfig);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasupdateconnection
  public static RasUpdateConnection(hrasconn: HRASCONN, lprasupdateconn: LPRASUPDATECONN): DWORD {
    return Rasapi32.Load('RasUpdateConnection')(hrasconn, lprasupdateconn);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasvalidateentrynamea
  public static RasValidateEntryNameA(lpszPhonebook: LPCSTR | NULL, lpszEntry: LPCSTR): DWORD {
    return Rasapi32.Load('RasValidateEntryNameA')(lpszPhonebook, lpszEntry);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ras/nf-ras-rasvalidateentrynamew
  public static RasValidateEntryNameW(lpszPhonebook: LPCWSTR | NULL, lpszEntry: LPCWSTR): DWORD {
    return Rasapi32.Load('RasValidateEntryNameW')(lpszPhonebook, lpszEntry);
  }
}

export default Rasapi32;
