import type { Pointer } from 'bun:ffi';

export type { DWORD, HRESULT, LPSTR, LPWSTR, NULL } from '@bun-win32/core';

export const MAX_ERROR_TEXT_LEN = 160;

export type PPVOID = Pointer;
export type REFCLSID = Pointer;
export type REFIID = Pointer;
