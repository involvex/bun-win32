// 2D texture creation with RTV/SRV/UAV views, plus RowPitch-correct CPU readback.

import { FFIType, toArrayBuffer, type Pointer } from 'bun:ffi';

import { comRelease, vcall } from './com';
import {
  CTX_COPY_RESOURCE,
  CTX_MAP,
  CTX_UNMAP,
  CTX_UPDATE_SUBRESOURCE,
  D3D11_BIND_RENDER_TARGET,
  D3D11_BIND_SHADER_RESOURCE,
  D3D11_BIND_UNORDERED_ACCESS,
  D3D11_CPU_ACCESS_READ,
  D3D11_MAP_READ,
  D3D11_SRV_DIMENSION_TEXTURE2D,
  D3D11_USAGE_DEFAULT,
  D3D11_USAGE_STAGING,
  DEV_CREATE_RENDER_TARGET_VIEW,
  DEV_CREATE_SHADER_RESOURCE_VIEW,
  DEV_CREATE_TEXTURE_2D,
  DEV_CREATE_UNORDERED_ACCESS_VIEW,
  DXGI_FORMAT_R16G16B16A16_FLOAT,
  DXGI_FORMAT_R32G32B32A32_FLOAT,
  DXGI_FORMAT_R8G8B8A8_UNORM,
} from './constants';
import { describeDeviceError, requireGpu } from './device';
import { trackResource } from './memory';

/** Result of {@link makeTexture}: the texture plus optional RTV/SRV/UAV views. */
export interface TextureResult {
  tex: bigint;
  rtv?: bigint;
  srv?: bigint;
  uav?: bigint;
}

export interface TextureOptions {
  w: number;
  h: number;
  /** DXGI format; defaults to R8G8B8A8_UNORM. */
  format?: number;
  rtv?: boolean;
  srv?: boolean;
  uav?: boolean;
  /** Create a STAGING (CPU-readable) texture instead of a GPU-bound one. */
  staging?: boolean;
}

/** Create a 2D texture with the requested bind flags and views. */
export function makeTexture(options: TextureOptions): TextureResult {
  const { device } = requireGpu();
  const { w, h, format = DXGI_FORMAT_R8G8B8A8_UNORM, rtv = false, srv = false, uav = false, staging = false } = options;

  let bindFlags = 0;
  if (rtv) bindFlags |= D3D11_BIND_RENDER_TARGET;
  if (srv) bindFlags |= D3D11_BIND_SHADER_RESOURCE;
  if (uav) bindFlags |= D3D11_BIND_UNORDERED_ACCESS;

  // D3D11_TEXTURE2D_DESC: 44 bytes. Width@0 Height@4 MipLevels@8 ArraySize@12
  // Format@16 SampleDesc.Count@20 SampleDesc.Quality@24 Usage@28 BindFlags@32
  // CPUAccessFlags@36 MiscFlags@40.
  const desc = Buffer.alloc(44);
  desc.writeUInt32LE(w, 0);
  desc.writeUInt32LE(h, 4);
  desc.writeUInt32LE(1, 8); // MipLevels
  desc.writeUInt32LE(1, 12); // ArraySize
  desc.writeUInt32LE(format, 16);
  desc.writeUInt32LE(1, 20); // SampleDesc.Count
  desc.writeUInt32LE(0, 24); // SampleDesc.Quality
  desc.writeUInt32LE(staging ? D3D11_USAGE_STAGING : D3D11_USAGE_DEFAULT, 28);
  desc.writeUInt32LE(staging ? 0 : bindFlags, 32);
  desc.writeUInt32LE(staging ? D3D11_CPU_ACCESS_READ : 0, 36);
  desc.writeUInt32LE(0, 40); // MiscFlags

  const pp = Buffer.alloc(8);
  if (vcall(device, DEV_CREATE_TEXTURE_2D, [FFIType.ptr, FFIType.ptr, FFIType.ptr], [desc.ptr!, null, pp.ptr!]) !== 0) {
    throw new Error('CreateTexture2D failed.');
  }
  const tex = pp.readBigUInt64LE(0);
  // 4 bytes/pixel covers every format this module creates by default; wide formats
  // (R32G32B32A32 16 B, R16G16B16A16 8 B) adjust the accounting only.
  const bytesPerPixel = format === DXGI_FORMAT_R32G32B32A32_FLOAT ? 16 : format === DXGI_FORMAT_R16G16B16A16_FLOAT ? 8 : 4;
  trackResource(tex, w * h * bytesPerPixel, 'texture');
  const result: TextureResult = { tex };
  if (staging) return result;

  if (rtv) {
    const ppRtv = Buffer.alloc(8);
    if (vcall(device, DEV_CREATE_RENDER_TARGET_VIEW, [FFIType.u64, FFIType.ptr, FFIType.ptr], [tex, null, ppRtv.ptr!]) !== 0) {
      throw new Error('CreateRenderTargetView (texture) failed.');
    }
    result.rtv = ppRtv.readBigUInt64LE(0);
  }
  if (srv) {
    // SRV desc: Format@0, ViewDimension@4 (TEXTURE2D=4), Texture2D{MostDetailedMip@8, MipLevels@12}.
    const srvDesc = Buffer.alloc(28);
    srvDesc.writeUInt32LE(format, 0);
    srvDesc.writeUInt32LE(D3D11_SRV_DIMENSION_TEXTURE2D, 4);
    srvDesc.writeUInt32LE(0, 8); // MostDetailedMip
    srvDesc.writeUInt32LE(1, 12); // MipLevels
    const ppSrv = Buffer.alloc(8);
    if (vcall(device, DEV_CREATE_SHADER_RESOURCE_VIEW, [FFIType.u64, FFIType.ptr, FFIType.ptr], [tex, srvDesc.ptr!, ppSrv.ptr!]) !== 0) {
      throw new Error('CreateShaderResourceView (texture) failed.');
    }
    result.srv = ppSrv.readBigUInt64LE(0);
  }
  if (uav) {
    // UAV desc: Format@0, ViewDimension@4 (TEXTURE2D=4), Texture2D{MipSlice@8}.
    const uavDesc = Buffer.alloc(28);
    uavDesc.writeUInt32LE(format, 0);
    uavDesc.writeUInt32LE(4, 4); // D3D11_UAV_DIMENSION_TEXTURE2D
    uavDesc.writeUInt32LE(0, 8); // MipSlice
    const ppUav = Buffer.alloc(8);
    if (vcall(device, DEV_CREATE_UNORDERED_ACCESS_VIEW, [FFIType.u64, FFIType.ptr, FFIType.ptr], [tex, uavDesc.ptr!, ppUav.ptr!]) !== 0) {
      throw new Error('CreateUnorderedAccessView (texture) failed.');
    }
    result.uav = ppUav.readBigUInt64LE(0);
  }
  return result;
}

/**
 * Create a texture from tightly packed CPU pixels (UpdateSubresource upload with
 * SrcRowPitch = w × bytesPerPixel). Defaults to an SRV-bound R8G8B8A8 texture —
 * the image-processing input. Re-uploading while the SRV is bound to a shader
 * stage is invalid; unbind first.
 */
export function textureFromPixels(pixels: Uint8Array, w: number, h: number, options: { format?: number; srv?: boolean; uav?: boolean; bytesPerPixel?: number } = {}): TextureResult {
  const { context } = requireGpu();
  const { format = DXGI_FORMAT_R8G8B8A8_UNORM, srv = true, uav = false, bytesPerPixel = 4 } = options;
  if (pixels.byteLength !== w * h * bytesPerPixel) {
    throw new Error(`textureFromPixels: pixels is ${pixels.byteLength} bytes but ${w}×${h}×${bytesPerPixel} requires ${w * h * bytesPerPixel}.`);
  }
  const result = makeTexture({ w, h, format, srv, uav });
  const source = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  vcall(context, CTX_UPDATE_SUBRESOURCE, [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], [result.tex, 0, null, source.ptr!, w * bytesPerPixel, 0], FFIType.void);
  return result;
}

/**
 * Read a GPU texture back to tightly packed CPU pixels: staging copy, Map READ,
 * then a per-row walk honoring the driver's RowPitch (RowPitch ≠ w×bpp on many
 * GPUs — naive tight-packing reads garbage). `format` must match the source texture.
 */
export function readbackTexture(tex: bigint, w: number, h: number, bytesPerPixel = 4, format = DXGI_FORMAT_R8G8B8A8_UNORM): Uint8Array {
  const { context } = requireGpu();
  const staging = makeTexture({ w, h, format, staging: true });

  vcall(context, CTX_COPY_RESOURCE, [FFIType.u64, FFIType.u64], [staging.tex, tex], FFIType.void);

  const mapped = Buffer.alloc(16); // pData@0, RowPitch u32@8, DepthPitch u32@12
  const hr = vcall(context, CTX_MAP, [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], [staging.tex, 0, D3D11_MAP_READ, 0, mapped.ptr!]);
  if (hr !== 0) {
    comRelease(staging.tex);
    throw new Error(`ID3D11DeviceContext::Map (texture readback) failed: ${describeDeviceError(hr)}`);
  }
  const dataPtr = mapped.readBigUInt64LE(0);
  const rowPitch = mapped.readUInt32LE(8);
  const rowBytes = w * bytesPerPixel;
  const tight = new Uint8Array(rowBytes * h);
  const source = new Uint8Array(toArrayBuffer(Number(dataPtr) as Pointer, 0, rowPitch * h));
  for (let y = 0; y < h; y += 1) tight.set(source.subarray(y * rowPitch, y * rowPitch + rowBytes), y * rowBytes);
  vcall(context, CTX_UNMAP, [FFIType.u64, FFIType.u32], [staging.tex, 0], FFIType.void);
  comRelease(staging.tex);
  return tight;
}
