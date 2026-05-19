import type { Pointer } from 'bun:ffi';

export type { HRESULT, NULL } from '@bun-win32/core';

export const CLSID_SystemInformation = '{C01B9BA0-BEA7-41BA-B604-D0A36F469133}';
export const CLSID_UpdateSearcher = '{B699E5E8-67FF-4177-88B0-3684A3388BFB}';
export const CLSID_UpdateServiceManager = '{F8D253D9-89A4-4DAA-87B6-1168369F0B21}';
export const CLSID_UpdateSession = '{4CB43D7F-7EEE-4906-8698-60DA1C38F2FE}';
export const CLSID_WindowsUpdateAgentInfo = '{C2E88C2F-6F5B-4AAA-894B-55C847AD3A2D}';

export const IID_IDispatch = '{00020400-0000-0000-C000-000000000046}';
export const IID_ISearchResult = '{D40CFF62-E08C-4498-941A-01E25F0FD33C}';
export const IID_ISystemInformation = '{ADE87BF7-7B56-4275-8FAB-B9B0E591844B}';
export const IID_IUnknown = '{00000000-0000-0000-C000-000000000046}';
export const IID_IUpdate = '{6A92B07A-D821-4682-B423-5C805022CC4D}';
export const IID_IUpdateCollection = '{07F7438C-7709-4CA5-B518-912792881347}';
export const IID_IUpdateHistoryEntry = '{BE56A644-AF0E-4E0E-A311-C1D8E695CBFF}';
export const IID_IUpdateHistoryEntryCollection = '{A7F04F3C-A290-435B-AADF-A116C3357A5C}';
export const IID_IUpdateSearcher = '{8F45ABF1-F9AE-4B95-A933-F0F66E5056EA}';
export const IID_IUpdateSession = '{816858A4-260D-4260-933A-2585F1ABC76B}';
export const IID_IWindowsUpdateAgentInfo = '{85713FA1-7796-4FA2-BE3B-E2D6124DD373}';

export enum AutomaticUpdatesNotificationLevel {
  aunlDisabled = 1,
  aunlNotConfigured = 0,
  aunlNotifyBeforeDownload = 2,
  aunlNotifyBeforeInstallation = 3,
  aunlScheduledInstallation = 4,
}

export enum DeploymentAction {
  daDetection = 3,
  daInstallation = 1,
  daNone = 0,
  daOptionalInstallation = 4,
  daUninstallation = 2,
}

export enum InstallationImpact {
  iiMinor = 1,
  iiNormal = 0,
  iiRequiresExclusiveHandling = 2,
}

export enum InstallationRebootBehavior {
  irbAlwaysRequiresReboot = 1,
  irbCanRequestReboot = 2,
  irbNeverReboots = 0,
}

export enum OperationResultCode {
  orcAborted = 5,
  orcFailed = 4,
  orcInProgress = 1,
  orcNotStarted = 0,
  orcSucceeded = 2,
  orcSucceededWithErrors = 3,
}

export enum ServerSelection {
  ssDefault = 0,
  ssManagedServer = 1,
  ssOthers = 3,
  ssWindowsUpdate = 2,
}

export enum UpdateExceptionContext {
  uecGeneral = 1,
  uecSearchIncomplete = 4,
  uecWindowsDriver = 2,
  uecWindowsInstaller = 3,
}

export enum UpdateOperation {
  uoInstallation = 1,
  uoUninstallation = 2,
}

export enum UpdateType {
  utDriver = 2,
  utSoftware = 1,
}

export type ISearchResult = bigint;
export type ISystemInformation = bigint;
export type IUpdate = bigint;
export type IUpdateCollection = bigint;
export type IUpdateHistoryEntry = bigint;
export type IUpdateHistoryEntryCollection = bigint;
export type IUpdateSearcher = bigint;
export type IUpdateSession = bigint;
export type IWindowsUpdateAgentInfo = bigint;
export type PPVOID = Pointer;
export type REFCLSID = Pointer;
export type REFIID = Pointer;
