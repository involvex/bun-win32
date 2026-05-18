# @bun-win32/dsound

Zero-dependency, zero-overhead Win32 DirectSound bindings for [Bun](https://bun.sh) on Windows.

## Overview

`@bun-win32/dsound` exposes the `dsound.dll` exports using [Bun](https://bun.sh)'s FFI. It provides a single class, `DSound`, which lazily binds native symbols on first use. You can optionally preload a subset or all symbols up-front via `Preload()`.

The bindings are strongly typed for a smooth DX in TypeScript.

## Features

- [Bun](https://bun.sh)-first ergonomics on Windows 10/11.
- Direct FFI to `dsound.dll` (DirectSound — device/capture creation and enumeration, full-duplex, and default-device GUID resolution).
- In-source docs in `structs/DSound.ts` with links to Microsoft Docs.
- Lazy binding on first call; optional eager preload (`DSound.Preload()`).
- No wrapper overhead; calls map 1:1 to native APIs.
- Strongly-typed Win32 aliases (see `types/DSound.ts`).

## Requirements

- [Bun](https://bun.sh) runtime
- Windows 10 or later

## Installation

```sh
bun add @bun-win32/dsound
```

## Quick Start

```ts
import DSound from '@bun-win32/dsound';

// Open the default playback device → an IDirectSound8 COM interface pointer.
const ppDS8 = Buffer.alloc(8);
const hr = DSound.DirectSoundCreate8(null, ppDS8.ptr, null);
if (hr !== 0) throw new Error(`DirectSoundCreate8 failed: 0x${(hr >>> 0).toString(16)}`);

const device = ppDS8.readBigUInt64LE(0);
console.log(`IDirectSound8 @ 0x${device.toString(16)}`);
// ... walk IDirectSound8::CreateSoundBuffer / SetCooperativeLevel / Release via the COM vtable.
```

> [!NOTE]
> AI agents: see `AI.md` for the package binding contract and source-navigation guidance. It explains how to use the package without scanning the entire implementation.

## Examples

Run the included examples:

```sh
# A real synth: synthesizes PCM in JS, plays it through dsound.dll,
# and paints a play-cursor-locked ANSI oscilloscope + VU meter
bun run example:dsound-tone-organ

# Full audio-endpoint diagnostic: every playback/capture driver,
# default-device GUIDs, decoded DSCAPS, and speaker configuration
bun run example:dsound-device-report
```

## Notes

- Either rely on lazy binding or call `DSound.Preload()`.
- Windows only. Bun runtime required.
