import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type {
  BOOLEAN,
  DECODING_SOURCE,
  EVENT_FIELD_TYPE,
  LPCGUID,
  LPCVOID,
  LPGUID,
  NULL,
  PBOOLEAN,
  PBYTE,
  PCEVENT_DESCRIPTOR,
  PEVENT_DESCRIPTOR,
  PEVENT_FILTER_DESCRIPTOR,
  PEVENT_MAP_INFO,
  PEVENT_RECORD,
  PPAYLOAD_FILTER_PREDICATE,
  PPPROVIDER_FILTER_INFO,
  PPROPERTY_DATA_DESCRIPTOR,
  PPROVIDER_ENUMERATION_INFO,
  PPROVIDER_EVENT_INFO,
  PPROVIDER_FIELD_INFOARRAY,
  PPVOID,
  PTDH_CONTEXT,
  PTDH_HANDLE,
  PTRACE_EVENT_INFO,
  PULONG,
  PUSHORT,
  PWCHAR,
  PWSTR,
  TDH_HANDLE,
  TDHSTATUS,
  ULONG,
  ULONGLONG,
  USHORT,
} from '../types/Tdh';

/**
 * Thin, lazy-loaded FFI bindings for `tdh.dll`.
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
 * import Tdh from './structs/Tdh';
 *
 * // Lazy: bind on first call
 * const status = Tdh.TdhEnumerateProviders(buffer.ptr, size.ptr);
 *
 * // Or preload a subset to avoid per-symbol lazy binding cost
 * Tdh.Preload(['TdhGetEventInformation', 'TdhFormatProperty']);
 * ```
 */
class Tdh extends Win32 {
  protected static override name = 'tdh.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    TdhAggregatePayloadFilters: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhCleanupPayloadEventFilterDescriptor: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhCloseDecodingHandle: { args: [FFIType.u64], returns: FFIType.u32 },
    TdhCreatePayloadFilter: { args: [FFIType.ptr, FFIType.ptr, FFIType.u8, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhDeletePayloadFilter: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhEnumerateManifestProviderEvents: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhEnumerateProviderFieldInformation: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhEnumerateProviderFilters: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhEnumerateProviders: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhEnumerateProvidersForDecodingSource: { args: [FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    TdhFormatProperty: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u16, FFIType.u16, FFIType.u16, FFIType.u16, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetDecodingParameter: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    TdhGetEventInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetEventMapInformation: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetManifestEventInformation: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetProperty: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    TdhGetPropertySize: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetWppMessage: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhGetWppProperty: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhLoadManifest: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhLoadManifestFromBinary: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhLoadManifestFromMemory: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TdhOpenDecodingHandle: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhQueryProviderFieldInformation: { args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    TdhSetDecodingParameter: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
    TdhUnloadManifest: { args: [FFIType.ptr], returns: FFIType.u32 },
    TdhUnloadManifestFromMemory: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhaggregatepayloadfilters
  public static TdhAggregatePayloadFilters(PayloadFilterCount: ULONG, PayloadFilterPtrs: PPVOID, EventMatchALLFlags: PBOOLEAN | NULL, EventFilterDescriptor: PEVENT_FILTER_DESCRIPTOR): TDHSTATUS {
    return Tdh.Load('TdhAggregatePayloadFilters')(PayloadFilterCount, PayloadFilterPtrs, EventMatchALLFlags, EventFilterDescriptor);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhcleanuppayloadeventfilterdescriptor
  public static TdhCleanupPayloadEventFilterDescriptor(EventFilterDescriptor: PEVENT_FILTER_DESCRIPTOR): TDHSTATUS {
    return Tdh.Load('TdhCleanupPayloadEventFilterDescriptor')(EventFilterDescriptor);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhclosedecodinghandle
  public static TdhCloseDecodingHandle(Handle: TDH_HANDLE): TDHSTATUS {
    return Tdh.Load('TdhCloseDecodingHandle')(Handle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhcreatepayloadfilter
  public static TdhCreatePayloadFilter(ProviderGuid: LPCGUID, EventDescriptor: PCEVENT_DESCRIPTOR, EventMatchANY: BOOLEAN, PayloadPredicateCount: ULONG, PayloadPredicates: PPAYLOAD_FILTER_PREDICATE, PayloadFilter: PPVOID): TDHSTATUS {
    return Tdh.Load('TdhCreatePayloadFilter')(ProviderGuid, EventDescriptor, EventMatchANY, PayloadPredicateCount, PayloadPredicates, PayloadFilter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhdeletepayloadfilter
  public static TdhDeletePayloadFilter(PayloadFilter: PPVOID): TDHSTATUS {
    return Tdh.Load('TdhDeletePayloadFilter')(PayloadFilter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhenumeratemanifestproviderevents
  public static TdhEnumerateManifestProviderEvents(ProviderGuid: LPGUID, Buffer: PPROVIDER_EVENT_INFO | NULL, BufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhEnumerateManifestProviderEvents')(ProviderGuid, Buffer, BufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhenumerateproviderfieldinformation
  public static TdhEnumerateProviderFieldInformation(pGuid: LPGUID, EventFieldType: EVENT_FIELD_TYPE, pBuffer: PPROVIDER_FIELD_INFOARRAY | NULL, pBufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhEnumerateProviderFieldInformation')(pGuid, EventFieldType, pBuffer, pBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhenumerateproviderfilters
  public static TdhEnumerateProviderFilters(Guid: LPGUID, TdhContextCount: ULONG, TdhContext: PTDH_CONTEXT | NULL, FilterCount: PULONG, Buffer: PPPROVIDER_FILTER_INFO | NULL, BufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhEnumerateProviderFilters')(Guid, TdhContextCount, TdhContext, FilterCount, Buffer, BufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhenumerateproviders
  public static TdhEnumerateProviders(pBuffer: PPROVIDER_ENUMERATION_INFO | NULL, pBufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhEnumerateProviders')(pBuffer, pBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhenumerateprovidersfordecodingsource
  public static TdhEnumerateProvidersForDecodingSource(filter: DECODING_SOURCE, buffer: PPROVIDER_ENUMERATION_INFO | NULL, bufferSize: ULONG, bufferRequired: PULONG): TDHSTATUS {
    return Tdh.Load('TdhEnumerateProvidersForDecodingSource')(filter, buffer, bufferSize, bufferRequired);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhformatproperty
  public static TdhFormatProperty(
    EventInfo: PTRACE_EVENT_INFO,
    MapInfo: PEVENT_MAP_INFO | NULL,
    PointerSize: ULONG,
    PropertyInType: USHORT,
    PropertyOutType: USHORT,
    PropertyLength: USHORT,
    UserDataLength: USHORT,
    UserData: PBYTE,
    BufferSize: PULONG,
    Buffer: PWCHAR | NULL,
    UserDataConsumed: PUSHORT,
  ): TDHSTATUS {
    return Tdh.Load('TdhFormatProperty')(EventInfo, MapInfo, PointerSize, PropertyInType, PropertyOutType, PropertyLength, UserDataLength, UserData, BufferSize, Buffer, UserDataConsumed);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetdecodingparameter
  public static TdhGetDecodingParameter(Handle: TDH_HANDLE, TdhContext: PTDH_CONTEXT): TDHSTATUS {
    return Tdh.Load('TdhGetDecodingParameter')(Handle, TdhContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgeteventinformation
  public static TdhGetEventInformation(Event: PEVENT_RECORD, TdhContextCount: ULONG, TdhContext: PTDH_CONTEXT | NULL, Buffer: PTRACE_EVENT_INFO | NULL, BufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhGetEventInformation')(Event, TdhContextCount, TdhContext, Buffer, BufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgeteventmapinformation
  public static TdhGetEventMapInformation(pEvent: PEVENT_RECORD, pMapName: PWSTR, pBuffer: PEVENT_MAP_INFO | NULL, pBufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhGetEventMapInformation')(pEvent, pMapName, pBuffer, pBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetmanifesteventinformation
  public static TdhGetManifestEventInformation(ProviderGuid: LPGUID, EventDescriptor: PEVENT_DESCRIPTOR, Buffer: PTRACE_EVENT_INFO | NULL, BufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhGetManifestEventInformation')(ProviderGuid, EventDescriptor, Buffer, BufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetproperty
  public static TdhGetProperty(pEvent: PEVENT_RECORD, TdhContextCount: ULONG, pTdhContext: PTDH_CONTEXT | NULL, PropertyDataCount: ULONG, pPropertyData: PPROPERTY_DATA_DESCRIPTOR, BufferSize: ULONG, pBuffer: PBYTE): TDHSTATUS {
    return Tdh.Load('TdhGetProperty')(pEvent, TdhContextCount, pTdhContext, PropertyDataCount, pPropertyData, BufferSize, pBuffer);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetpropertysize
  public static TdhGetPropertySize(pEvent: PEVENT_RECORD, TdhContextCount: ULONG, pTdhContext: PTDH_CONTEXT | NULL, PropertyDataCount: ULONG, pPropertyData: PPROPERTY_DATA_DESCRIPTOR, pPropertySize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhGetPropertySize')(pEvent, TdhContextCount, pTdhContext, PropertyDataCount, pPropertyData, pPropertySize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetwppmessage
  public static TdhGetWppMessage(Handle: TDH_HANDLE, EventRecord: PEVENT_RECORD, BufferSize: PULONG, Buffer: PBYTE): TDHSTATUS {
    return Tdh.Load('TdhGetWppMessage')(Handle, EventRecord, BufferSize, Buffer);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhgetwppproperty
  public static TdhGetWppProperty(Handle: TDH_HANDLE, EventRecord: PEVENT_RECORD, PropertyName: PWSTR, BufferSize: PULONG, Buffer: PBYTE): TDHSTATUS {
    return Tdh.Load('TdhGetWppProperty')(Handle, EventRecord, PropertyName, BufferSize, Buffer);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhloadmanifest
  public static TdhLoadManifest(Manifest: PWSTR): TDHSTATUS {
    return Tdh.Load('TdhLoadManifest')(Manifest);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhloadmanifestfrombinary
  public static TdhLoadManifestFromBinary(BinaryPath: PWSTR): TDHSTATUS {
    return Tdh.Load('TdhLoadManifestFromBinary')(BinaryPath);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhloadmanifestfrommemory
  public static TdhLoadManifestFromMemory(pData: LPCVOID, cbData: ULONG): TDHSTATUS {
    return Tdh.Load('TdhLoadManifestFromMemory')(pData, cbData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhopendecodinghandle
  public static TdhOpenDecodingHandle(Handle: PTDH_HANDLE): TDHSTATUS {
    return Tdh.Load('TdhOpenDecodingHandle')(Handle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhqueryproviderfieldinformation
  public static TdhQueryProviderFieldInformation(pGuid: LPGUID, EventFieldValue: ULONGLONG, EventFieldType: EVENT_FIELD_TYPE, pBuffer: PPROVIDER_FIELD_INFOARRAY | NULL, pBufferSize: PULONG): TDHSTATUS {
    return Tdh.Load('TdhQueryProviderFieldInformation')(pGuid, EventFieldValue, EventFieldType, pBuffer, pBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhsetdecodingparameter
  public static TdhSetDecodingParameter(Handle: TDH_HANDLE, TdhContext: PTDH_CONTEXT): TDHSTATUS {
    return Tdh.Load('TdhSetDecodingParameter')(Handle, TdhContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhunloadmanifest
  public static TdhUnloadManifest(Manifest: PWSTR): TDHSTATUS {
    return Tdh.Load('TdhUnloadManifest')(Manifest);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/tdh/nf-tdh-tdhunloadmanifestfrommemory
  public static TdhUnloadManifestFromMemory(pData: LPCVOID, cbData: ULONG): TDHSTATUS {
    return Tdh.Load('TdhUnloadManifestFromMemory')(pData, cbData);
  }
}

export default Tdh;
