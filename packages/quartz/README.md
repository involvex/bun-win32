# @bun-win32/quartz

Zero-dependency, zero-overhead Win32 Quartz bindings for [Bun](https://bun.sh) on Windows.

## Overview

`@bun-win32/quartz` exposes the `quartz.dll` exports using [Bun](https://bun.sh)'s FFI. It provides a single class, `Quartz`, which lazily binds native symbols on first use. You can optionally preload a subset or all symbols up-front via `Preload()`.

> [!NOTE]
> AI agents: see `AI.md` for the package binding contract and source-navigation guidance. It explains how to use the package without scanning the entire implementation.
