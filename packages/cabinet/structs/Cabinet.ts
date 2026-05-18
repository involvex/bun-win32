import { type FFIFunction, FFIType } from 'bun:ffi';

import { Win32 } from '@bun-win32/core';

import type {
  BOOL,
  COMPRESS_INFORMATION_CLASS,
  COMPRESSOR_HANDLE,
  DECOMPRESSOR_HANDLE,
  DWORD,
  HFCI,
  HFDI,
  INT,
  INT_PTR,
  LPCVOID,
  LPSTR,
  LPVOID,
  NULL,
  PCABINETDLLVERSIONINFO,
  PCCAB,
  PCOMPRESS_ALLOCATION_ROUTINES,
  PCOMPRESSOR_HANDLE,
  PDECOMPRESSOR_HANDLE,
  PERF,
  PFDICABINETINFO,
  PFNALLOC,
  PFNCLOSE,
  PFNFCIALLOC,
  PFNFCICLOSE,
  PFNFCIDELETE,
  PFNFCIFILEPLACED,
  PFNFCIFREE,
  PFNFCIGETNEXTCABINET,
  PFNFCIGETOPENINFO,
  PFNFCIGETTEMPFILE,
  PFNFCIOPEN,
  PFNFCIREAD,
  PFNFCISEEK,
  PFNFCISTATUS,
  PFNFCIWRITE,
  PFNFDIDECRYPT,
  PFNFDINOTIFY,
  PFNFREE,
  PFNOPEN,
  PFNREAD,
  PFNSEEK,
  PFNWRITE,
  PSIZE_T,
  PVOID,
  SIZE_T,
  TCOMP,
  USHORT,
  VOID,
} from '../types/Cabinet';

/**
 * Thin, lazy-loaded FFI bindings for `cabinet.dll`.
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
 * import Cabinet from './structs/Cabinet';
 *
 * // Lazy: bind on first call
 * const handle = Buffer.alloc(8);
 * Cabinet.CreateCompressor(COMPRESS_ALGORITHM.COMPRESS_ALGORITHM_XPRESS, null, handle.ptr);
 *
 * // Or preload a subset to avoid per-symbol lazy binding cost
 * Cabinet.Preload(['CreateCompressor', 'Compress', 'CloseCompressor']);
 * ```
 */
class Cabinet extends Win32 {
  protected static override name = 'cabinet.dll';

  /** @inheritdoc */
  protected static override readonly Symbols = {
    CloseCompressor: { args: [FFIType.u64], returns: FFIType.i32 },
    CloseDecompressor: { args: [FFIType.u64], returns: FFIType.i32 },
    Compress: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    CreateCompressor: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CreateDecompressor: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    Decompress: { args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    DllGetVersion: { args: [FFIType.ptr], returns: FFIType.void },
    FCIAddFile: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u16], returns: FFIType.i32 },
    FCICreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
    FCIDestroy: { args: [FFIType.u64], returns: FFIType.i32 },
    FCIFlushCabinet: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    FCIFlushFolder: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    FDICopy: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    FDICreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.u64 },
    FDIDestroy: { args: [FFIType.u64], returns: FFIType.i32 },
    FDIIsCabinet: { args: [FFIType.u64, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    FDITruncateCabinet: { args: [FFIType.u64, FFIType.ptr, FFIType.u16], returns: FFIType.i32 },
    QueryCompressorInformation: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    QueryDecompressorInformation: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    ResetCompressor: { args: [FFIType.u64], returns: FFIType.i32 },
    ResetDecompressor: { args: [FFIType.u64], returns: FFIType.i32 },
    SetCompressorInformation: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    SetDecompressorInformation: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  } as const satisfies Record<string, FFIFunction>;

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-closecompressor
  public static CloseCompressor(CompressorHandle: COMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('CloseCompressor')(CompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-closedecompressor
  public static CloseDecompressor(DecompressorHandle: DECOMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('CloseDecompressor')(DecompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-compress
  public static Compress(CompressorHandle: COMPRESSOR_HANDLE, UncompressedData: LPCVOID | NULL, UncompressedDataSize: SIZE_T, CompressedBuffer: PVOID | NULL, CompressedBufferSize: SIZE_T, CompressedDataSize: PSIZE_T): BOOL {
    return Cabinet.Load('Compress')(CompressorHandle, UncompressedData, UncompressedDataSize, CompressedBuffer, CompressedBufferSize, CompressedDataSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-createcompressor
  public static CreateCompressor(Algorithm: DWORD, AllocationRoutines: PCOMPRESS_ALLOCATION_ROUTINES | NULL, CompressorHandle: PCOMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('CreateCompressor')(Algorithm, AllocationRoutines, CompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-createdecompressor
  public static CreateDecompressor(Algorithm: DWORD, AllocationRoutines: PCOMPRESS_ALLOCATION_ROUTINES | NULL, DecompressorHandle: PDECOMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('CreateDecompressor')(Algorithm, AllocationRoutines, DecompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-decompress
  public static Decompress(DecompressorHandle: DECOMPRESSOR_HANDLE, CompressedData: LPCVOID | NULL, CompressedDataSize: SIZE_T, UncompressedBuffer: PVOID | NULL, UncompressedBufferSize: SIZE_T, UncompressedDataSize: PSIZE_T | NULL): BOOL {
    return Cabinet.Load('Decompress')(DecompressorHandle, CompressedData, CompressedDataSize, UncompressedBuffer, UncompressedBufferSize, UncompressedDataSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/devnotes/dllgetversion
  public static DllGetVersion(pcdvi: PCABINETDLLVERSIONINFO): VOID {
    return Cabinet.Load('DllGetVersion')(pcdvi);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fci/nf-fci-fciaddfile
  public static FCIAddFile(hfci: HFCI, pszSourceFile: LPSTR, pszFileName: LPSTR, fExecute: BOOL, pfnfcignc: PFNFCIGETNEXTCABINET, pfnfcis: PFNFCISTATUS, pfnfcigoi: PFNFCIGETOPENINFO, typeCompress: TCOMP): BOOL {
    return Cabinet.Load('FCIAddFile')(hfci, pszSourceFile, pszFileName, fExecute, pfnfcignc, pfnfcis, pfnfcigoi, typeCompress);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fci/nf-fci-fcicreate
  public static FCICreate(
    perf: PERF,
    pfnfcifp: PFNFCIFILEPLACED,
    pfna: PFNFCIALLOC,
    pfnf: PFNFCIFREE,
    pfnopen: PFNFCIOPEN,
    pfnread: PFNFCIREAD,
    pfnwrite: PFNFCIWRITE,
    pfnclose: PFNFCICLOSE,
    pfnseek: PFNFCISEEK,
    pfndelete: PFNFCIDELETE,
    pfnfcigtf: PFNFCIGETTEMPFILE,
    pccab: PCCAB,
    pv: LPVOID | NULL,
  ): HFCI {
    return Cabinet.Load('FCICreate')(perf, pfnfcifp, pfna, pfnf, pfnopen, pfnread, pfnwrite, pfnclose, pfnseek, pfndelete, pfnfcigtf, pccab, pv);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fci/nf-fci-fcidestroy
  public static FCIDestroy(hfci: HFCI): BOOL {
    return Cabinet.Load('FCIDestroy')(hfci);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fci/nf-fci-fciflushcabinet
  public static FCIFlushCabinet(hfci: HFCI, fGetNextCab: BOOL, pfnfcignc: PFNFCIGETNEXTCABINET, pfnfcis: PFNFCISTATUS): BOOL {
    return Cabinet.Load('FCIFlushCabinet')(hfci, fGetNextCab, pfnfcignc, pfnfcis);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fci/nf-fci-fciflushfolder
  public static FCIFlushFolder(hfci: HFCI, pfnfcignc: PFNFCIGETNEXTCABINET, pfnfcis: PFNFCISTATUS): BOOL {
    return Cabinet.Load('FCIFlushFolder')(hfci, pfnfcignc, pfnfcis);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fdi/nf-fdi-fdicopy
  public static FDICopy(hfdi: HFDI, pszCabinet: LPSTR, pszCabPath: LPSTR, flags: INT, pfnfdin: PFNFDINOTIFY, pfnfdid: PFNFDIDECRYPT | NULL, pvUser: LPVOID | NULL): BOOL {
    return Cabinet.Load('FDICopy')(hfdi, pszCabinet, pszCabPath, flags, pfnfdin, pfnfdid, pvUser);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fdi/nf-fdi-fdicreate
  public static FDICreate(pfnalloc: PFNALLOC, pfnfree: PFNFREE, pfnopen: PFNOPEN, pfnread: PFNREAD, pfnwrite: PFNWRITE, pfnclose: PFNCLOSE, pfnseek: PFNSEEK, cpuType: INT, perf: PERF): HFDI {
    return Cabinet.Load('FDICreate')(pfnalloc, pfnfree, pfnopen, pfnread, pfnwrite, pfnclose, pfnseek, cpuType, perf);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fdi/nf-fdi-fdidestroy
  public static FDIDestroy(hfdi: HFDI): BOOL {
    return Cabinet.Load('FDIDestroy')(hfdi);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fdi/nf-fdi-fdiiscabinet
  public static FDIIsCabinet(hfdi: HFDI, hf: INT_PTR, pfdici: PFDICABINETINFO): BOOL {
    return Cabinet.Load('FDIIsCabinet')(hfdi, hf, pfdici);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/fdi/nf-fdi-fditruncatecabinet
  public static FDITruncateCabinet(hfdi: HFDI, pszCabinetName: LPSTR, iFolderToDelete: USHORT): BOOL {
    return Cabinet.Load('FDITruncateCabinet')(hfdi, pszCabinetName, iFolderToDelete);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-querycompressorinformation
  public static QueryCompressorInformation(CompressorHandle: COMPRESSOR_HANDLE, CompressInformationClass: COMPRESS_INFORMATION_CLASS, CompressInformation: PVOID, CompressInformationSize: SIZE_T): BOOL {
    return Cabinet.Load('QueryCompressorInformation')(CompressorHandle, CompressInformationClass, CompressInformation, CompressInformationSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-querydecompressorinformation
  public static QueryDecompressorInformation(DecompressorHandle: DECOMPRESSOR_HANDLE, CompressInformationClass: COMPRESS_INFORMATION_CLASS, CompressInformation: PVOID, CompressInformationSize: SIZE_T): BOOL {
    return Cabinet.Load('QueryDecompressorInformation')(DecompressorHandle, CompressInformationClass, CompressInformation, CompressInformationSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-resetcompressor
  public static ResetCompressor(CompressorHandle: COMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('ResetCompressor')(CompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-resetdecompressor
  public static ResetDecompressor(DecompressorHandle: DECOMPRESSOR_HANDLE): BOOL {
    return Cabinet.Load('ResetDecompressor')(DecompressorHandle);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-setcompressorinformation
  public static SetCompressorInformation(CompressorHandle: COMPRESSOR_HANDLE, CompressInformationClass: COMPRESS_INFORMATION_CLASS, CompressInformation: LPCVOID, CompressInformationSize: SIZE_T): BOOL {
    return Cabinet.Load('SetCompressorInformation')(CompressorHandle, CompressInformationClass, CompressInformation, CompressInformationSize);
  }

  // https://learn.microsoft.com/en-us/windows/win32/api/compressapi/nf-compressapi-setdecompressorinformation
  public static SetDecompressorInformation(DecompressorHandle: DECOMPRESSOR_HANDLE, CompressInformationClass: COMPRESS_INFORMATION_CLASS, CompressInformation: LPCVOID, CompressInformationSize: SIZE_T): BOOL {
    return Cabinet.Load('SetDecompressorInformation')(DecompressorHandle, CompressInformationClass, CompressInformation, CompressInformationSize);
  }
}

export default Cabinet;
