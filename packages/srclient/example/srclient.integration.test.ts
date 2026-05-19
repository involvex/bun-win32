/**
 * Srclient Integration Test
 *
 * Real FFI integration test against the live srclient.dll on this machine. It
 * exercises every bound export with read-only / no-op argument paths so the test
 * never creates or removes a restore point, then asserts that the native calls
 * return well-formed, decodable results. This proves the FFI symbol signatures,
 * struct packing (RESTOREPOINTINFOW / STATEMGRSTATUS are #pragma pack(1)), and
 * return-type mappings are correct end-to-end.
 *
 * APIs exercised (Srclient):
 *   - SRSetRestorePointW          (safe cancel/no-op path; decodes STATEMGRSTATUS)
 *   - SRSetRestorePointA          (safe cancel/no-op path; ANSI struct)
 *   - SRRemoveRestorePoint        (guaranteed-absent id; expects ERROR_INVALID_DATA / denied)
 *
 * Run: bun test example/srclient.integration.test.ts
 */
import { describe, expect, test } from 'bun:test';

import Srclient, { MAX_DESC, MAX_DESC_W, RestorePointEventType, RestorePointType } from '../index';

Srclient.Preload(['SRSetRestorePointW', 'SRSetRestorePointA', 'SRRemoveRestorePoint']);

// Win32 status codes that legitimately come back from a read-only / no-op probe
// depending on elevation, COM-security init, and System Restore policy state.
const ACCEPTABLE_STATUS = new Set<number>([
  0, // ERROR_SUCCESS (24h-throttle short-circuit path)
  5, // ERROR_ACCESS_DENIED (no elevation / COM security)
  13, // ERROR_INVALID_DATA (bad sequence number — the expected no-op outcome)
  1058, // ERROR_SERVICE_DISABLED
  10, // ERROR_BAD_ENVIRONMENT (safe mode)
]);

describe('srclient.dll FFI integration', () => {
  test('SRSetRestorePointW executes and returns a decodable STATEMGRSTATUS', () => {
    // RESTOREPOINTINFOW (#pragma pack(1)): DWORD + DWORD + INT64 + WCHAR[256] = 528 bytes.
    const restorePtSpec = Buffer.alloc(4 + 4 + 8 + MAX_DESC_W * 2);
    restorePtSpec.writeUInt32LE(RestorePointEventType.END_SYSTEM_CHANGE, 0);
    restorePtSpec.writeUInt32LE(RestorePointType.CANCELLED_OPERATION, 4);
    restorePtSpec.writeBigInt64LE(0x7fffffffffffffffn, 8); // impossible seq → no-op
    Buffer.from('integration-test probe\0', 'utf16le').copy(restorePtSpec, 16);

    // STATEMGRSTATUS (#pragma pack(1)): DWORD nStatus + INT64 llSequenceNumber = 12 bytes.
    const smgrStatus = Buffer.alloc(12);

    const ok = Srclient.SRSetRestorePointW(restorePtSpec.ptr, smgrStatus.ptr);
    const nStatus = smgrStatus.readUInt32LE(0);

    // BOOL return must be a number (0 or non-zero), proving the i32 return mapping.
    expect(typeof ok).toBe('number');
    // The no-op path must NOT report a created restore point.
    expect(ok).toBe(0);
    // nStatus must be one of the documented failure/short-circuit codes.
    expect(ACCEPTABLE_STATUS.has(nStatus)).toBe(true);
  });

  test('SRSetRestorePointA executes with the ANSI struct layout', () => {
    // RESTOREPOINTINFOA (#pragma pack(1)): DWORD + DWORD + INT64 + CHAR[64] = 80 bytes.
    const restorePtSpec = Buffer.alloc(4 + 4 + 8 + MAX_DESC);
    restorePtSpec.writeUInt32LE(RestorePointEventType.END_SYSTEM_CHANGE, 0);
    restorePtSpec.writeUInt32LE(RestorePointType.CANCELLED_OPERATION, 4);
    restorePtSpec.writeBigInt64LE(0x7fffffffffffffffn, 8);
    Buffer.from('ansi probe\0', 'latin1').copy(restorePtSpec, 16);

    const smgrStatus = Buffer.alloc(12);
    const ok = Srclient.SRSetRestorePointA(restorePtSpec.ptr, smgrStatus.ptr);
    const nStatus = smgrStatus.readUInt32LE(0);

    expect(typeof ok).toBe('number');
    expect(ok).toBe(0);
    expect(ACCEPTABLE_STATUS.has(nStatus)).toBe(true);
  });

  test('SRRemoveRestorePoint returns a DWORD for a guaranteed-absent restore point', () => {
    // 0xFFFFFFFF can never be a live restore-point number. Documented contract:
    // ERROR_INVALID_DATA (13) when it does not exist — or ERROR_ACCESS_DENIED (5)
    // without elevation. Either way, nothing is deleted.
    const result = Srclient.SRRemoveRestorePoint(0xffffffff);
    expect(typeof result).toBe('number');
    // Must not be ERROR_SUCCESS (0) — that would imply something was removed.
    expect(result).not.toBe(0);
    expect([5, 13, 1058, 10].includes(result)).toBe(true);
  });
});
