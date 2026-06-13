// The UI Automation root: the COM apartment plus the in-process IUIAutomation client, created once.

import Combase from '@bun-win32/combase';

import { comRelease, guid, hresult } from './com';
import { CLSCTX_INPROC_SERVER, CLSID_CUIAutomation, COINIT_APARTMENTTHREADED, IID_IUIAutomation, S_FALSE, S_OK } from './constants';

let pAutomation = 0n;
let comInitialized = false;

/**
 * Initialize COM (single-threaded apartment) and create the in-process IUIAutomation client.
 * Idempotent — returns the cached client pointer on subsequent calls. Throws (does not exit) when
 * UI Automation is unavailable so callers can catch and degrade.
 */
export function initialize(): bigint {
  if (pAutomation !== 0n) return pAutomation;
  if (!comInitialized) {
    const initHr = Combase.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    if (initHr !== S_OK && initHr !== S_FALSE) throw new Error(`CoInitializeEx failed: ${hresult(initHr)}`);
    comInitialized = true;
  }
  const clsid = guid(CLSID_CUIAutomation);
  const iid = guid(IID_IUIAutomation);
  const out = Buffer.alloc(8);
  const createHr = Combase.CoCreateInstance(clsid.ptr!, 0n, CLSCTX_INPROC_SERVER, iid.ptr!, out.ptr!);
  if (createHr !== S_OK) throw new Error(`CoCreateInstance(CUIAutomation) failed: ${hresult(createHr)} — UI Automation is unavailable on this system.`);
  pAutomation = out.readBigUInt64LE(0);
  if (pAutomation === 0n) throw new Error('CoCreateInstance(CUIAutomation) returned a null client.');
  return pAutomation;
}

/** The IUIAutomation client pointer, initializing on first use. */
export function automation(): bigint {
  return pAutomation !== 0n ? pAutomation : initialize();
}

/** Release the IUIAutomation client and uninitialize COM. Safe to call when never initialized. */
export function uninitialize(): void {
  if (pAutomation !== 0n) {
    comRelease(pAutomation);
    pAutomation = 0n;
  }
  if (comInitialized) {
    Combase.CoUninitialize();
    comInitialized = false;
  }
}
