import type { Pointer } from 'bun:ffi';

export type { HRESULT } from '@bun-win32/core';

export const DXCORE_ADAPTER_ATTRIBUTE_D3D11_GRAPHICS = '8c47866b-7583-450d-f0f0-6bada895af4b';
export const DXCORE_ADAPTER_ATTRIBUTE_D3D12_CORE_COMPUTE = '248e2800-a793-4724-abaa-23a6de1be090';
export const DXCORE_ADAPTER_ATTRIBUTE_D3D12_GRAPHICS = '0c9ece4d-2f6e-4f01-8c96-e89e331b47b1';
export const IID_IDXCoreAdapter = 'f0db4c7f-fe5a-42a2-bd62-f2a6cf6fc83e';
export const IID_IDXCoreAdapterFactory = '78ee5945-c36e-4b13-a669-005dd11c0f06';
export const IID_IDXCoreAdapterList = '526c7776-40e9-459b-b711-f32ad76dfc28';

export enum DXCoreAdapterPreference {
  Hardware = 0,
  HighPerformance = 2,
  MinimumPower = 1,
}

export enum DXCoreAdapterProperty {
  AcgCompatible = 10,
  ComputePreemptionGranularity = 5,
  DedicatedAdapterMemory = 7,
  DedicatedSystemMemory = 8,
  DriverDescription = 2,
  DriverVersion = 1,
  GraphicsPreemptionGranularity = 6,
  HardwareID = 3,
  HardwareIDParts = 14,
  InstanceLuid = 0,
  IsDetachable = 13,
  IsHardware = 11,
  IsIntegrated = 12,
  KmdModelVersion = 4,
  SharedSystemMemory = 9,
}

export enum DXCoreAdapterState {
  AdapterMemoryBudget = 1,
  IsDriverUpdateInProgress = 0,
}

export enum DXCoreNotificationType {
  AdapterBudgetChange = 2,
  AdapterHardwareContentProtectionTeardown = 3,
  AdapterListStale = 0,
  AdapterNoLongerValid = 1,
}

export enum DXCoreSegmentGroup {
  Local = 0,
  NonLocal = 1,
}

export type LPLPVOID = Pointer;
export type REFIID = Pointer;
