import { type FFIFunction, FFIType, type Pointer } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type {
  BOOL,
  DOUBLE,
  DWORD,
  HANDLE,
  HBITMAP,
  HICON,
  HPALETTE,
  HRESULT,
  IEnumString,
  IPropertyBag2,
  IStream,
  IWICBitmap,
  IWICBitmapClipper,
  IWICBitmapCodecInfo,
  IWICBitmapDecoder,
  IWICBitmapEncoder,
  IWICBitmapFlipRotator,
  IWICBitmapFrameDecode,
  IWICBitmapFrameEncode,
  IWICBitmapLock,
  IWICBitmapScaler,
  IWICBitmapSource,
  IWICColorContext,
  IWICComponentFactory,
  IWICComponentInfo,
  IWICFastMetadataEncoder,
  IWICFormatConverter,
  IWICImagingFactory,
  IWICMetadataBlockReader,
  IWICMetadataBlockWriter,
  IWICMetadataQueryReader,
  IWICMetadataQueryWriter,
  IWICMetadataReader,
  IWICMetadataWriter,
  IWICPalette,
  IWICPixelFormatInfo,
  IWICStream,
  LPBOOL,
  LPBYTE,
  LPCWSTR,
  LPDOUBLE,
  LPGUID,
  LPLPOLESTR,
  LPPROPBAG2,
  LPPROPVARIANT,
  LPUINT,
  LPULARGE_INTEGER,
  LPULONG,
  LPVARIANT,
  LPWICBitmapPaletteType,
  LPWICColor,
  LPWICInProcPointer,
  LPWICPixelFormatGUID,
  LPWICRect,
  LPWSTR,
  NULL,
  PCWSTR,
  REFCLSID,
  REFGUID,
  REFIID,
  REFWICPixelFormatGUID,
  UINT,
  ULONG,
  ULONG_PTR,
  WICBitmapAlphaChannelOption,
  WICBitmapCreateCacheOption,
  WICBitmapDitherType,
  WICBitmapEncoderCacheOption,
  WICBitmapInterpolationMode,
  WICBitmapPaletteType,
  WICBitmapTransformOptions,
  WICDecodeOptions,
  WICInProcPointer,
  WICSectionAccessLevel,
} from '../types/WindowsCodecs';

/**
 * Thin, lazy-loaded FFI bindings for `windowscodecs.dll` (Windows Imaging Component).
 *
 * Each static method corresponds one-to-one with a `windowscodecs.dll` export declared in
 * `Symbols`. WIC exposes its COM interfaces through flat `*_Proxy` exports — each proxy takes
 * the owning interface pointer as the first parameter, then the original method's parameters.
 * COM interface pointers are opaque tokens (`bigint`), obtained from the `**` out-parameters
 * of the create/get functions and passed back by value; you never dereference them locally.
 *
 * The first call to a method binds the underlying native symbol via `bun:ffi` and memoizes
 * it on the class for subsequent calls. For bulk, up-front binding, use `Preload`.
 *
 * @example
 * ```ts
 * import WindowsCodecs from './structs/WindowsCodecs';
 *
 * const out = Buffer.alloc(8);
 * WindowsCodecs.WICCreateImagingFactory_Proxy(0x0237, out.ptr!);
 * const factory = out.readBigUInt64LE(0);
 * ```
 */
class WindowsCodecs extends Win32 {
  protected static override name = 'windowscodecs.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    DllCanUnloadNow: { args: [], returns: FFIType.i32 },
    DllGetClassObject: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IEnumString_Next_WIC_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IEnumString_Reset_WIC_Proxy: { args: [FFIType.u64], returns: FFIType.i32 },
    IPropertyBag2_Write_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapClipper_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_DoesSupportAnimation_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_DoesSupportLossless_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_DoesSupportMultiframe_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_GetContainerFormat_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_GetDeviceManufacturer_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_GetDeviceModels_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_GetFileExtensions_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapCodecInfo_GetMimeTypes_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_CopyPalette_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapDecoder_GetColorContexts_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetDecoderInfo_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetFrameCount_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetFrame_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetMetadataQueryReader_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetPreview_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapDecoder_GetThumbnail_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapEncoder_Commit_Proxy: { args: [FFIType.u64], returns: FFIType.i32 },
    IWICBitmapEncoder_CreateNewFrame_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapEncoder_GetEncoderInfo_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapEncoder_GetMetadataQueryWriter_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapEncoder_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    IWICBitmapEncoder_SetPalette_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapEncoder_SetThumbnail_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapFlipRotator_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    IWICBitmapFrameDecode_GetColorContexts_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapFrameDecode_GetMetadataQueryReader_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapFrameDecode_GetThumbnail_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapFrameEncode_Commit_Proxy: { args: [FFIType.u64], returns: FFIType.i32 },
    IWICBitmapFrameEncode_GetMetadataQueryWriter_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapFrameEncode_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapFrameEncode_SetColorContexts_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapFrameEncode_SetResolution_Proxy: { args: [FFIType.u64, FFIType.f64, FFIType.f64], returns: FFIType.i32 },
    IWICBitmapFrameEncode_SetSize_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    IWICBitmapFrameEncode_SetThumbnail_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapFrameEncode_WriteSource_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapLock_GetDataPointer_STA_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapLock_GetStride_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapScaler_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    IWICBitmapSource_CopyPalette_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmapSource_CopyPixels_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapSource_GetPixelFormat_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapSource_GetResolution_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmapSource_GetSize_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmap_Lock_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICBitmap_SetPalette_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICBitmap_SetResolution_Proxy: { args: [FFIType.u64, FFIType.f64, FFIType.f64], returns: FFIType.i32 },
    IWICColorContext_InitializeFromMemory_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    IWICComponentFactory_CreateMetadataWriterFromReader_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentFactory_CreateQueryWriterFromBlockWriter_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentInfo_GetAuthor_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentInfo_GetCLSID_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentInfo_GetFriendlyName_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentInfo_GetSpecVersion_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICComponentInfo_GetVersion_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICFastMetadataEncoder_Commit_Proxy: { args: [FFIType.u64], returns: FFIType.i32 },
    IWICFastMetadataEncoder_GetMetadataQueryWriter_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICFormatConverter_Initialize_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.f64, FFIType.u32], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapClipper_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapFlipRotator_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapFromHBITMAP_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapFromHICON_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapFromMemory_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapFromSource_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmapScaler_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateBitmap_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateComponentInfo_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateDecoderFromFileHandle_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateDecoderFromFilename_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateDecoderFromStream_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateEncoder_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateFastMetadataEncoderFromDecoder_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateFastMetadataEncoderFromFrameDecode_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateFormatConverter_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreatePalette_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateQueryWriterFromReader_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateQueryWriter_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICImagingFactory_CreateStream_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataBlockReader_GetCount_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataBlockReader_GetReaderByIndex_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryReader_GetContainerFormat_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryReader_GetEnumerator_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryReader_GetLocation_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryReader_GetMetadataByName_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryWriter_RemoveMetadataByName_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICMetadataQueryWriter_SetMetadataByName_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICPalette_GetColorCount_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICPalette_GetColors_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICPalette_GetType_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICPalette_HasAlpha_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICPalette_InitializeCustom_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    IWICPalette_InitializeFromBitmap_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    IWICPalette_InitializeFromPalette_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICPalette_InitializePredefined_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    IWICPixelFormatInfo_GetBitsPerPixel_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICPixelFormatInfo_GetChannelCount_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    IWICPixelFormatInfo_GetChannelMask_Proxy: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IWICStream_InitializeFromIStream_Proxy: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    IWICStream_InitializeFromMemory_Proxy: { args: [FFIType.u64, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    WICConvertBitmapSource: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    WICCreateBitmapFromSection: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    WICCreateBitmapFromSectionEx: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    WICCreateColorContext_Proxy: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    WICCreateImagingFactory_Proxy: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    WICGetMetadataContentSize: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    WICMapGuidToShortName: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WICMapSchemaToName: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WICMapShortNameToGuid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WICMatchMetadataContent: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    WICSerializeMetadataContent: { args: [FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
    WICSetEncoderFormat_Proxy: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-dllcanunloadnow
  public static DllCanUnloadNow(): HRESULT {
    return WindowsCodecs.Load('DllCanUnloadNow')();
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-dllgetclassobject
  public static DllGetClassObject(rclsid: REFCLSID, riid: REFIID, ppv: Pointer): HRESULT {
    return WindowsCodecs.Load('DllGetClassObject')(rclsid, riid, ppv);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-ienumstring-next
  public static IEnumString_Next_WIC_Proxy(This: IEnumString, celt: ULONG, rgelt: LPLPOLESTR, pceltFetched: LPULONG | NULL): HRESULT {
    return WindowsCodecs.Load('IEnumString_Next_WIC_Proxy')(This, celt, rgelt, pceltFetched);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-ienumstring-reset
  public static IEnumString_Reset_WIC_Proxy(This: IEnumString): HRESULT {
    return WindowsCodecs.Load('IEnumString_Reset_WIC_Proxy')(This);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/ocidl/nf-ocidl-ipropertybag2-write
  public static IPropertyBag2_Write_Proxy(This: IPropertyBag2, cProperties: ULONG, pPropBag: LPPROPBAG2, pvarValue: LPVARIANT): HRESULT {
    return WindowsCodecs.Load('IPropertyBag2_Write_Proxy')(This, cProperties, pPropBag, pvarValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapclipper-initialize
  public static IWICBitmapClipper_Initialize_Proxy(This: IWICBitmapClipper, pISource: IWICBitmapSource | 0n, prc: LPWICRect): HRESULT {
    return WindowsCodecs.Load('IWICBitmapClipper_Initialize_Proxy')(This, pISource, prc);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-doessupportanimation
  public static IWICBitmapCodecInfo_DoesSupportAnimation_Proxy(This: IWICBitmapCodecInfo, pfSupportAnimation: LPBOOL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_DoesSupportAnimation_Proxy')(This, pfSupportAnimation);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-doessupportlossless
  public static IWICBitmapCodecInfo_DoesSupportLossless_Proxy(This: IWICBitmapCodecInfo, pfSupportLossless: LPBOOL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_DoesSupportLossless_Proxy')(This, pfSupportLossless);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-doessupportmultiframe
  public static IWICBitmapCodecInfo_DoesSupportMultiframe_Proxy(This: IWICBitmapCodecInfo, pfSupportMultiframe: LPBOOL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_DoesSupportMultiframe_Proxy')(This, pfSupportMultiframe);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-getcontainerformat
  public static IWICBitmapCodecInfo_GetContainerFormat_Proxy(This: IWICBitmapCodecInfo, pguidContainerFormat: LPGUID): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_GetContainerFormat_Proxy')(This, pguidContainerFormat);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-getdevicemanufacturer
  public static IWICBitmapCodecInfo_GetDeviceManufacturer_Proxy(This: IWICBitmapCodecInfo, cchDeviceManufacturer: UINT, wzDeviceManufacturer: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_GetDeviceManufacturer_Proxy')(This, cchDeviceManufacturer, wzDeviceManufacturer, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-getdevicemodels
  public static IWICBitmapCodecInfo_GetDeviceModels_Proxy(This: IWICBitmapCodecInfo, cchDeviceModels: UINT, wzDeviceModels: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_GetDeviceModels_Proxy')(This, cchDeviceModels, wzDeviceModels, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-getfileextensions
  public static IWICBitmapCodecInfo_GetFileExtensions_Proxy(This: IWICBitmapCodecInfo, cchFileExtensions: UINT, wzFileExtensions: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_GetFileExtensions_Proxy')(This, cchFileExtensions, wzFileExtensions, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapcodecinfo-getmimetypes
  public static IWICBitmapCodecInfo_GetMimeTypes_Proxy(This: IWICBitmapCodecInfo, cchMimeTypes: UINT, wzMimeTypes: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapCodecInfo_GetMimeTypes_Proxy')(This, cchMimeTypes, wzMimeTypes, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-copypalette
  public static IWICBitmapDecoder_CopyPalette_Proxy(This: IWICBitmapDecoder, pIPalette: IWICPalette | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_CopyPalette_Proxy')(This, pIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getcolorcontexts
  public static IWICBitmapDecoder_GetColorContexts_Proxy(This: IWICBitmapDecoder, cCount: UINT, ppIColorContexts: Pointer | NULL, pcActualCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetColorContexts_Proxy')(This, cCount, ppIColorContexts, pcActualCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getdecoderinfo
  public static IWICBitmapDecoder_GetDecoderInfo_Proxy(This: IWICBitmapDecoder, ppIDecoderInfo: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetDecoderInfo_Proxy')(This, ppIDecoderInfo);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getframecount
  public static IWICBitmapDecoder_GetFrameCount_Proxy(This: IWICBitmapDecoder, pCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetFrameCount_Proxy')(This, pCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getframe
  public static IWICBitmapDecoder_GetFrame_Proxy(This: IWICBitmapDecoder, index: UINT, ppIBitmapFrame: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetFrame_Proxy')(This, index, ppIBitmapFrame);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getmetadataqueryreader
  public static IWICBitmapDecoder_GetMetadataQueryReader_Proxy(This: IWICBitmapDecoder, ppIMetadataQueryReader: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetMetadataQueryReader_Proxy')(This, ppIMetadataQueryReader);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getpreview
  public static IWICBitmapDecoder_GetPreview_Proxy(This: IWICBitmapDecoder, ppIBitmapSource: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetPreview_Proxy')(This, ppIBitmapSource);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapdecoder-getthumbnail
  public static IWICBitmapDecoder_GetThumbnail_Proxy(This: IWICBitmapDecoder, ppIThumbnail: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapDecoder_GetThumbnail_Proxy')(This, ppIThumbnail);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-commit
  public static IWICBitmapEncoder_Commit_Proxy(This: IWICBitmapEncoder): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_Commit_Proxy')(This);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-createnewframe
  public static IWICBitmapEncoder_CreateNewFrame_Proxy(This: IWICBitmapEncoder, ppIFrameEncode: Pointer, ppIEncoderOptions: Pointer | NULL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_CreateNewFrame_Proxy')(This, ppIFrameEncode, ppIEncoderOptions);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-getencoderinfo
  public static IWICBitmapEncoder_GetEncoderInfo_Proxy(This: IWICBitmapEncoder, ppIEncoderInfo: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_GetEncoderInfo_Proxy')(This, ppIEncoderInfo);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-getmetadataquerywriter
  public static IWICBitmapEncoder_GetMetadataQueryWriter_Proxy(This: IWICBitmapEncoder, ppIMetadataQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_GetMetadataQueryWriter_Proxy')(This, ppIMetadataQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-initialize
  public static IWICBitmapEncoder_Initialize_Proxy(This: IWICBitmapEncoder, pIStream: IStream | 0n, cacheOption: WICBitmapEncoderCacheOption): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_Initialize_Proxy')(This, pIStream, cacheOption);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-setpalette
  public static IWICBitmapEncoder_SetPalette_Proxy(This: IWICBitmapEncoder, pIPalette: IWICPalette | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_SetPalette_Proxy')(This, pIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapencoder-setthumbnail
  public static IWICBitmapEncoder_SetThumbnail_Proxy(This: IWICBitmapEncoder, pIThumbnail: IWICBitmapSource | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapEncoder_SetThumbnail_Proxy')(This, pIThumbnail);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapfliprotator-initialize
  public static IWICBitmapFlipRotator_Initialize_Proxy(This: IWICBitmapFlipRotator, pISource: IWICBitmapSource | 0n, options: WICBitmapTransformOptions): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFlipRotator_Initialize_Proxy')(This, pISource, options);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframedecode-getcolorcontexts
  public static IWICBitmapFrameDecode_GetColorContexts_Proxy(This: IWICBitmapFrameDecode, cCount: UINT, ppIColorContexts: Pointer | NULL, pcActualCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameDecode_GetColorContexts_Proxy')(This, cCount, ppIColorContexts, pcActualCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframedecode-getmetadataqueryreader
  public static IWICBitmapFrameDecode_GetMetadataQueryReader_Proxy(This: IWICBitmapFrameDecode, ppIMetadataQueryReader: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameDecode_GetMetadataQueryReader_Proxy')(This, ppIMetadataQueryReader);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframedecode-getthumbnail
  public static IWICBitmapFrameDecode_GetThumbnail_Proxy(This: IWICBitmapFrameDecode, ppIThumbnail: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameDecode_GetThumbnail_Proxy')(This, ppIThumbnail);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-commit
  public static IWICBitmapFrameEncode_Commit_Proxy(This: IWICBitmapFrameEncode): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_Commit_Proxy')(This);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-getmetadataquerywriter
  public static IWICBitmapFrameEncode_GetMetadataQueryWriter_Proxy(This: IWICBitmapFrameEncode, ppIMetadataQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_GetMetadataQueryWriter_Proxy')(This, ppIMetadataQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-initialize
  public static IWICBitmapFrameEncode_Initialize_Proxy(This: IWICBitmapFrameEncode, pIEncoderOptions: IPropertyBag2 | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_Initialize_Proxy')(This, pIEncoderOptions);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-setcolorcontexts
  public static IWICBitmapFrameEncode_SetColorContexts_Proxy(This: IWICBitmapFrameEncode, cCount: UINT, ppIColorContext: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_SetColorContexts_Proxy')(This, cCount, ppIColorContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-setresolution
  public static IWICBitmapFrameEncode_SetResolution_Proxy(This: IWICBitmapFrameEncode, dpiX: DOUBLE, dpiY: DOUBLE): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_SetResolution_Proxy')(This, dpiX, dpiY);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-setsize
  public static IWICBitmapFrameEncode_SetSize_Proxy(This: IWICBitmapFrameEncode, uiWidth: UINT, uiHeight: UINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_SetSize_Proxy')(This, uiWidth, uiHeight);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-setthumbnail
  public static IWICBitmapFrameEncode_SetThumbnail_Proxy(This: IWICBitmapFrameEncode, pIThumbnail: IWICBitmapSource | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_SetThumbnail_Proxy')(This, pIThumbnail);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapframeencode-writesource
  public static IWICBitmapFrameEncode_WriteSource_Proxy(This: IWICBitmapFrameEncode, pIBitmapSource: IWICBitmapSource | 0n, prc: LPWICRect | NULL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapFrameEncode_WriteSource_Proxy')(This, pIBitmapSource, prc);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmaplock-getdatapointer
  public static IWICBitmapLock_GetDataPointer_STA_Proxy(This: IWICBitmapLock, pcbBufferSize: LPUINT, ppbData: LPWICInProcPointer | NULL): HRESULT {
    return WindowsCodecs.Load('IWICBitmapLock_GetDataPointer_STA_Proxy')(This, pcbBufferSize, ppbData);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmaplock-getstride
  public static IWICBitmapLock_GetStride_Proxy(This: IWICBitmapLock, pcbStride: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapLock_GetStride_Proxy')(This, pcbStride);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapscaler-initialize
  public static IWICBitmapScaler_Initialize_Proxy(This: IWICBitmapScaler, pISource: IWICBitmapSource | 0n, uiWidth: UINT, uiHeight: UINT, mode: WICBitmapInterpolationMode): HRESULT {
    return WindowsCodecs.Load('IWICBitmapScaler_Initialize_Proxy')(This, pISource, uiWidth, uiHeight, mode);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapsource-copypalette
  public static IWICBitmapSource_CopyPalette_Proxy(This: IWICBitmapSource, pIPalette: IWICPalette | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmapSource_CopyPalette_Proxy')(This, pIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapsource-copypixels
  public static IWICBitmapSource_CopyPixels_Proxy(This: IWICBitmapSource, prc: LPWICRect | NULL, cbStride: UINT, cbBufferSize: UINT, pbBuffer: LPBYTE): HRESULT {
    return WindowsCodecs.Load('IWICBitmapSource_CopyPixels_Proxy')(This, prc, cbStride, cbBufferSize, pbBuffer);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapsource-getpixelformat
  public static IWICBitmapSource_GetPixelFormat_Proxy(This: IWICBitmapSource, pPixelFormat: LPWICPixelFormatGUID): HRESULT {
    return WindowsCodecs.Load('IWICBitmapSource_GetPixelFormat_Proxy')(This, pPixelFormat);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapsource-getresolution
  public static IWICBitmapSource_GetResolution_Proxy(This: IWICBitmapSource, pDpiX: LPDOUBLE, pDpiY: LPDOUBLE): HRESULT {
    return WindowsCodecs.Load('IWICBitmapSource_GetResolution_Proxy')(This, pDpiX, pDpiY);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmapsource-getsize
  public static IWICBitmapSource_GetSize_Proxy(This: IWICBitmapSource, puiWidth: LPUINT, puiHeight: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICBitmapSource_GetSize_Proxy')(This, puiWidth, puiHeight);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmap-lock
  public static IWICBitmap_Lock_Proxy(This: IWICBitmap, prcLock: LPWICRect | NULL, flags: DWORD, ppILock: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICBitmap_Lock_Proxy')(This, prcLock, flags, ppILock);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmap-setpalette
  public static IWICBitmap_SetPalette_Proxy(This: IWICBitmap, pIPalette: IWICPalette | 0n): HRESULT {
    return WindowsCodecs.Load('IWICBitmap_SetPalette_Proxy')(This, pIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicbitmap-setresolution
  public static IWICBitmap_SetResolution_Proxy(This: IWICBitmap, dpiX: DOUBLE, dpiY: DOUBLE): HRESULT {
    return WindowsCodecs.Load('IWICBitmap_SetResolution_Proxy')(This, dpiX, dpiY);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccolorcontext-initializefrommemory
  public static IWICColorContext_InitializeFromMemory_Proxy(This: IWICColorContext, pbBuffer: LPBYTE, cbBufferSize: UINT): HRESULT {
    return WindowsCodecs.Load('IWICColorContext_InitializeFromMemory_Proxy')(This, pbBuffer, cbBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-iwiccomponentfactory-createmetadatawriterfromreader
  public static IWICComponentFactory_CreateMetadataWriterFromReader_Proxy(This: IWICComponentFactory, pIReader: IWICMetadataReader | 0n, pguidVendor: LPGUID | NULL, ppIWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICComponentFactory_CreateMetadataWriterFromReader_Proxy')(This, pIReader, pguidVendor, ppIWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-iwiccomponentfactory-createquerywriterfromblockwriter
  public static IWICComponentFactory_CreateQueryWriterFromBlockWriter_Proxy(This: IWICComponentFactory, pIBlockWriter: IWICMetadataBlockWriter | 0n, ppIQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICComponentFactory_CreateQueryWriterFromBlockWriter_Proxy')(This, pIBlockWriter, ppIQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccomponentinfo-getauthor
  public static IWICComponentInfo_GetAuthor_Proxy(This: IWICComponentInfo, cchAuthor: UINT, wzAuthor: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICComponentInfo_GetAuthor_Proxy')(This, cchAuthor, wzAuthor, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccomponentinfo-getclsid
  public static IWICComponentInfo_GetCLSID_Proxy(This: IWICComponentInfo, pclsid: LPGUID): HRESULT {
    return WindowsCodecs.Load('IWICComponentInfo_GetCLSID_Proxy')(This, pclsid);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccomponentinfo-getfriendlyname
  public static IWICComponentInfo_GetFriendlyName_Proxy(This: IWICComponentInfo, cchFriendlyName: UINT, wzFriendlyName: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICComponentInfo_GetFriendlyName_Proxy')(This, cchFriendlyName, wzFriendlyName, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccomponentinfo-getspecversion
  public static IWICComponentInfo_GetSpecVersion_Proxy(This: IWICComponentInfo, cchSpecVersion: UINT, wzSpecVersion: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICComponentInfo_GetSpecVersion_Proxy')(This, cchSpecVersion, wzSpecVersion, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwiccomponentinfo-getversion
  public static IWICComponentInfo_GetVersion_Proxy(This: IWICComponentInfo, cchVersion: UINT, wzVersion: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICComponentInfo_GetVersion_Proxy')(This, cchVersion, wzVersion, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicfastmetadataencoder-commit
  public static IWICFastMetadataEncoder_Commit_Proxy(This: IWICFastMetadataEncoder): HRESULT {
    return WindowsCodecs.Load('IWICFastMetadataEncoder_Commit_Proxy')(This);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicfastmetadataencoder-getmetadataquerywriter
  public static IWICFastMetadataEncoder_GetMetadataQueryWriter_Proxy(This: IWICFastMetadataEncoder, ppIMetadataQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICFastMetadataEncoder_GetMetadataQueryWriter_Proxy')(This, ppIMetadataQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicformatconverter-initialize
  public static IWICFormatConverter_Initialize_Proxy(
    This: IWICFormatConverter,
    pISource: IWICBitmapSource | 0n,
    dstFormat: REFWICPixelFormatGUID,
    dither: WICBitmapDitherType,
    pIPalette: IWICPalette | 0n,
    alphaThresholdPercent: DOUBLE,
    paletteTranslate: WICBitmapPaletteType,
  ): HRESULT {
    return WindowsCodecs.Load('IWICFormatConverter_Initialize_Proxy')(This, pISource, dstFormat, dither, pIPalette, alphaThresholdPercent, paletteTranslate);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapclipper
  public static IWICImagingFactory_CreateBitmapClipper_Proxy(This: IWICImagingFactory, ppIBitmapClipper: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapClipper_Proxy')(This, ppIBitmapClipper);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapfliprotator
  public static IWICImagingFactory_CreateBitmapFlipRotator_Proxy(This: IWICImagingFactory, ppIBitmapFlipRotator: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapFlipRotator_Proxy')(This, ppIBitmapFlipRotator);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapfromhbitmap
  public static IWICImagingFactory_CreateBitmapFromHBITMAP_Proxy(This: IWICImagingFactory, hBitmap: HBITMAP, hPalette: HPALETTE | 0n, options: WICBitmapAlphaChannelOption, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapFromHBITMAP_Proxy')(This, hBitmap, hPalette, options, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapfromhicon
  public static IWICImagingFactory_CreateBitmapFromHICON_Proxy(This: IWICImagingFactory, hIcon: HICON, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapFromHICON_Proxy')(This, hIcon, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapfrommemory
  public static IWICImagingFactory_CreateBitmapFromMemory_Proxy(
    This: IWICImagingFactory,
    uiWidth: UINT,
    uiHeight: UINT,
    pixelFormat: REFWICPixelFormatGUID,
    cbStride: UINT,
    cbBufferSize: UINT,
    pbBuffer: LPBYTE,
    ppIBitmap: Pointer,
  ): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapFromMemory_Proxy')(This, uiWidth, uiHeight, pixelFormat, cbStride, cbBufferSize, pbBuffer, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapfromsource
  public static IWICImagingFactory_CreateBitmapFromSource_Proxy(This: IWICImagingFactory, pIBitmapSource: IWICBitmapSource | 0n, option: WICBitmapCreateCacheOption, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapFromSource_Proxy')(This, pIBitmapSource, option, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmapscaler
  public static IWICImagingFactory_CreateBitmapScaler_Proxy(This: IWICImagingFactory, ppIBitmapScaler: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmapScaler_Proxy')(This, ppIBitmapScaler);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createbitmap
  public static IWICImagingFactory_CreateBitmap_Proxy(This: IWICImagingFactory, uiWidth: UINT, uiHeight: UINT, pixelFormat: REFWICPixelFormatGUID, option: WICBitmapCreateCacheOption, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateBitmap_Proxy')(This, uiWidth, uiHeight, pixelFormat, option, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createcomponentinfo
  public static IWICImagingFactory_CreateComponentInfo_Proxy(This: IWICImagingFactory, clsidComponent: REFCLSID, ppIInfo: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateComponentInfo_Proxy')(This, clsidComponent, ppIInfo);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createdecoderfromfilehandle
  public static IWICImagingFactory_CreateDecoderFromFileHandle_Proxy(This: IWICImagingFactory, hFile: ULONG_PTR, pguidVendor: LPGUID | NULL, metadataOptions: WICDecodeOptions, ppIDecoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateDecoderFromFileHandle_Proxy')(This, hFile, pguidVendor, metadataOptions, ppIDecoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createdecoderfromfilename
  public static IWICImagingFactory_CreateDecoderFromFilename_Proxy(This: IWICImagingFactory, wzFilename: LPCWSTR, pguidVendor: LPGUID | NULL, dwDesiredAccess: DWORD, metadataOptions: WICDecodeOptions, ppIDecoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateDecoderFromFilename_Proxy')(This, wzFilename, pguidVendor, dwDesiredAccess, metadataOptions, ppIDecoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createdecoderfromstream
  public static IWICImagingFactory_CreateDecoderFromStream_Proxy(This: IWICImagingFactory, pIStream: IStream | 0n, pguidVendor: LPGUID | NULL, metadataOptions: WICDecodeOptions, ppIDecoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateDecoderFromStream_Proxy')(This, pIStream, pguidVendor, metadataOptions, ppIDecoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createencoder
  public static IWICImagingFactory_CreateEncoder_Proxy(This: IWICImagingFactory, guidContainerFormat: REFGUID, pguidVendor: LPGUID | NULL, ppIEncoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateEncoder_Proxy')(This, guidContainerFormat, pguidVendor, ppIEncoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createfastmetadataencoderfromdecoder
  public static IWICImagingFactory_CreateFastMetadataEncoderFromDecoder_Proxy(This: IWICImagingFactory, pIDecoder: IWICBitmapDecoder | 0n, ppIFastEncoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateFastMetadataEncoderFromDecoder_Proxy')(This, pIDecoder, ppIFastEncoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createfastmetadataencoderfromframedecode
  public static IWICImagingFactory_CreateFastMetadataEncoderFromFrameDecode_Proxy(This: IWICImagingFactory, pIFrameDecoder: IWICBitmapFrameDecode | 0n, ppIFastEncoder: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateFastMetadataEncoderFromFrameDecode_Proxy')(This, pIFrameDecoder, ppIFastEncoder);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createformatconverter
  public static IWICImagingFactory_CreateFormatConverter_Proxy(This: IWICImagingFactory, ppIFormatConverter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateFormatConverter_Proxy')(This, ppIFormatConverter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createpalette
  public static IWICImagingFactory_CreatePalette_Proxy(This: IWICImagingFactory, ppIPalette: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreatePalette_Proxy')(This, ppIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createquerywriterfromreader
  public static IWICImagingFactory_CreateQueryWriterFromReader_Proxy(This: IWICImagingFactory, pIQueryReader: IWICMetadataQueryReader | 0n, pguidVendor: LPGUID | NULL, ppIQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateQueryWriterFromReader_Proxy')(This, pIQueryReader, pguidVendor, ppIQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createquerywriter
  public static IWICImagingFactory_CreateQueryWriter_Proxy(This: IWICImagingFactory, guidMetadataFormat: REFGUID, pguidVendor: LPGUID | NULL, ppIQueryWriter: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateQueryWriter_Proxy')(This, guidMetadataFormat, pguidVendor, ppIQueryWriter);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicimagingfactory-createstream
  public static IWICImagingFactory_CreateStream_Proxy(This: IWICImagingFactory, ppIWICStream: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICImagingFactory_CreateStream_Proxy')(This, ppIWICStream);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-iwicmetadatablockreader-getcount
  public static IWICMetadataBlockReader_GetCount_Proxy(This: IWICMetadataBlockReader, pcCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICMetadataBlockReader_GetCount_Proxy')(This, pcCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-iwicmetadatablockreader-getreaderbyindex
  public static IWICMetadataBlockReader_GetReaderByIndex_Proxy(This: IWICMetadataBlockReader, nIndex: UINT, ppIMetadataReader: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICMetadataBlockReader_GetReaderByIndex_Proxy')(This, nIndex, ppIMetadataReader);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataqueryreader-getcontainerformat
  public static IWICMetadataQueryReader_GetContainerFormat_Proxy(This: IWICMetadataQueryReader, pguidContainerFormat: LPGUID): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryReader_GetContainerFormat_Proxy')(This, pguidContainerFormat);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataqueryreader-getenumerator
  public static IWICMetadataQueryReader_GetEnumerator_Proxy(This: IWICMetadataQueryReader, ppIEnumString: Pointer): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryReader_GetEnumerator_Proxy')(This, ppIEnumString);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataqueryreader-getlocation
  public static IWICMetadataQueryReader_GetLocation_Proxy(This: IWICMetadataQueryReader, cchMaxLength: UINT, wzNamespace: LPWSTR | NULL, pcchActualLength: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryReader_GetLocation_Proxy')(This, cchMaxLength, wzNamespace, pcchActualLength);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataqueryreader-getmetadatabyname
  public static IWICMetadataQueryReader_GetMetadataByName_Proxy(This: IWICMetadataQueryReader, wzName: LPCWSTR, pvarValue: LPPROPVARIANT | NULL): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryReader_GetMetadataByName_Proxy')(This, wzName, pvarValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataquerywriter-removemetadatabyname
  public static IWICMetadataQueryWriter_RemoveMetadataByName_Proxy(This: IWICMetadataQueryWriter, wzName: LPCWSTR): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryWriter_RemoveMetadataByName_Proxy')(This, wzName);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicmetadataquerywriter-setmetadatabyname
  public static IWICMetadataQueryWriter_SetMetadataByName_Proxy(This: IWICMetadataQueryWriter, wzName: LPCWSTR, pvarValue: LPPROPVARIANT): HRESULT {
    return WindowsCodecs.Load('IWICMetadataQueryWriter_SetMetadataByName_Proxy')(This, wzName, pvarValue);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-getcolorcount
  public static IWICPalette_GetColorCount_Proxy(This: IWICPalette, pcCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICPalette_GetColorCount_Proxy')(This, pcCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-getcolors
  public static IWICPalette_GetColors_Proxy(This: IWICPalette, cCount: UINT, pColors: LPWICColor, pcActualColors: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICPalette_GetColors_Proxy')(This, cCount, pColors, pcActualColors);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-gettype
  public static IWICPalette_GetType_Proxy(This: IWICPalette, pePaletteType: LPWICBitmapPaletteType): HRESULT {
    return WindowsCodecs.Load('IWICPalette_GetType_Proxy')(This, pePaletteType);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-hasalpha
  public static IWICPalette_HasAlpha_Proxy(This: IWICPalette, pfHasAlpha: LPBOOL): HRESULT {
    return WindowsCodecs.Load('IWICPalette_HasAlpha_Proxy')(This, pfHasAlpha);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-initializecustom
  public static IWICPalette_InitializeCustom_Proxy(This: IWICPalette, pColors: LPWICColor, cCount: UINT): HRESULT {
    return WindowsCodecs.Load('IWICPalette_InitializeCustom_Proxy')(This, pColors, cCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-initializefrombitmap
  public static IWICPalette_InitializeFromBitmap_Proxy(This: IWICPalette, pISurface: IWICBitmapSource | 0n, cCount: UINT, fAddTransparentColor: BOOL): HRESULT {
    return WindowsCodecs.Load('IWICPalette_InitializeFromBitmap_Proxy')(This, pISurface, cCount, fAddTransparentColor);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-initializefrompalette
  public static IWICPalette_InitializeFromPalette_Proxy(This: IWICPalette, pIPalette: IWICPalette | 0n): HRESULT {
    return WindowsCodecs.Load('IWICPalette_InitializeFromPalette_Proxy')(This, pIPalette);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpalette-initializepredefined
  public static IWICPalette_InitializePredefined_Proxy(This: IWICPalette, ePaletteType: WICBitmapPaletteType, fAddTransparentColor: BOOL): HRESULT {
    return WindowsCodecs.Load('IWICPalette_InitializePredefined_Proxy')(This, ePaletteType, fAddTransparentColor);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpixelformatinfo-getbitsperpixel
  public static IWICPixelFormatInfo_GetBitsPerPixel_Proxy(This: IWICPixelFormatInfo, puiBitsPerPixel: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICPixelFormatInfo_GetBitsPerPixel_Proxy')(This, puiBitsPerPixel);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpixelformatinfo-getchannelcount
  public static IWICPixelFormatInfo_GetChannelCount_Proxy(This: IWICPixelFormatInfo, puiChannelCount: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICPixelFormatInfo_GetChannelCount_Proxy')(This, puiChannelCount);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicpixelformatinfo-getchannelmask
  public static IWICPixelFormatInfo_GetChannelMask_Proxy(This: IWICPixelFormatInfo, uiChannelIndex: UINT, cbMaskBuffer: UINT, pbMaskBuffer: LPBYTE | NULL, pcbActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('IWICPixelFormatInfo_GetChannelMask_Proxy')(This, uiChannelIndex, cbMaskBuffer, pbMaskBuffer, pcbActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicstream-initializefromistream
  public static IWICStream_InitializeFromIStream_Proxy(This: IWICStream, pIStream: IStream | 0n): HRESULT {
    return WindowsCodecs.Load('IWICStream_InitializeFromIStream_Proxy')(This, pIStream);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-iwicstream-initializefrommemory
  public static IWICStream_InitializeFromMemory_Proxy(This: IWICStream, pbBuffer: WICInProcPointer, cbBufferSize: DWORD): HRESULT {
    return WindowsCodecs.Load('IWICStream_InitializeFromMemory_Proxy')(This, pbBuffer, cbBufferSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wicconvertbitmapsource
  public static WICConvertBitmapSource(dstFormat: REFWICPixelFormatGUID, pISrc: IWICBitmapSource, ppIDst: Pointer): HRESULT {
    return WindowsCodecs.Load('WICConvertBitmapSource')(dstFormat, pISrc, ppIDst);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wiccreatebitmapfromsection
  public static WICCreateBitmapFromSection(width: UINT, height: UINT, pixelFormat: REFWICPixelFormatGUID, hSection: HANDLE, stride: UINT, offset: UINT, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('WICCreateBitmapFromSection')(width, height, pixelFormat, hSection, stride, offset, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wiccreatebitmapfromsectionex
  public static WICCreateBitmapFromSectionEx(width: UINT, height: UINT, pixelFormat: REFWICPixelFormatGUID, hSection: HANDLE, stride: UINT, offset: UINT, desiredAccessLevel: WICSectionAccessLevel, ppIBitmap: Pointer): HRESULT {
    return WindowsCodecs.Load('WICCreateBitmapFromSectionEx')(width, height, pixelFormat, hSection, stride, offset, desiredAccessLevel, ppIBitmap);
  }

  // https://learn.microsoft.com/en-us/windows/win32/wic/-wic-api-proxyfunctions
  public static WICCreateColorContext_Proxy(pICodecFactory: IWICImagingFactory, ppIWICColorContext: Pointer): HRESULT {
    return WindowsCodecs.Load('WICCreateColorContext_Proxy')(pICodecFactory, ppIWICColorContext);
  }

  // https://learn.microsoft.com/en-us/windows/win32/wic/-wic-api-proxyfunctions
  public static WICCreateImagingFactory_Proxy(SDKVersion: UINT, ppIImagingFactory: Pointer): HRESULT {
    return WindowsCodecs.Load('WICCreateImagingFactory_Proxy')(SDKVersion, ppIImagingFactory);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-wicgetmetadatacontentsize
  public static WICGetMetadataContentSize(guidContainerFormat: REFGUID, pIWriter: IWICMetadataWriter, pcbSize: LPULARGE_INTEGER): HRESULT {
    return WindowsCodecs.Load('WICGetMetadataContentSize')(guidContainerFormat, pIWriter, pcbSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wicmapguidtoshortname
  public static WICMapGuidToShortName(guid: REFGUID, cchName: UINT, wzName: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('WICMapGuidToShortName')(guid, cchName, wzName, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wicmapschematoname
  public static WICMapSchemaToName(guidMetadataFormat: REFGUID, pwzSchema: LPWSTR, cchName: UINT, wzName: LPWSTR | NULL, pcchActual: LPUINT): HRESULT {
    return WindowsCodecs.Load('WICMapSchemaToName')(guidMetadataFormat, pwzSchema, cchName, wzName, pcchActual);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodec/nf-wincodec-wicmapshortnametoguid
  public static WICMapShortNameToGuid(wzName: PCWSTR, pguid: LPGUID): HRESULT {
    return WindowsCodecs.Load('WICMapShortNameToGuid')(wzName, pguid);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-wicmatchmetadatacontent
  public static WICMatchMetadataContent(guidContainerFormat: REFGUID, pguidVendor: LPGUID | NULL, pIStream: IStream, pguidMetadataFormat: LPGUID): HRESULT {
    return WindowsCodecs.Load('WICMatchMetadataContent')(guidContainerFormat, pguidVendor, pIStream, pguidMetadataFormat);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/wincodecsdk/nf-wincodecsdk-wicserializemetadatacontent
  public static WICSerializeMetadataContent(guidContainerFormat: REFGUID, pIWriter: IWICMetadataWriter, dwPersistOptions: DWORD, pIStream: IStream): HRESULT {
    return WindowsCodecs.Load('WICSerializeMetadataContent')(guidContainerFormat, pIWriter, dwPersistOptions, pIStream);
  }

  // https://learn.microsoft.com/en-us/windows/win32/wic/-wic-api-proxyfunctions
  public static WICSetEncoderFormat_Proxy(pSourceIn: IWICBitmapSource, pIPalette: IWICPalette, pIFrameEncode: IWICBitmapFrameEncode, ppSourceOut: Pointer): HRESULT {
    return WindowsCodecs.Load('WICSetEncoderFormat_Proxy')(pSourceIn, pIPalette, pIFrameEncode, ppSourceOut);
  }
}

export default WindowsCodecs;
