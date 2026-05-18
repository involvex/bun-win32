import type { Pointer } from 'bun:ffi';

export type { HRESULT } from '@bun-win32/core';

export enum DWRITE_FACTORY_TYPE {
  DWRITE_FACTORY_TYPE_ISOLATED = 1,
  DWRITE_FACTORY_TYPE_SHARED = 0,
}

export type IUnknown = Pointer;
export type LPLPVOID = Pointer;
export type REFIID = Pointer;
