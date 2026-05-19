/**
 * Clusapi Integration Test
 *
 * A real FFI integration test that loads `C:\Windows\System32\clusapi.dll`
 * through the bindings and exercises the Failover Cluster API against the
 * live system — no mocks, no stubs. It is written to pass on BOTH a clustered
 * server and (the common case) a standalone workstation with no Cluster
 * service installed.
 *
 *   - GetNodeClusterState  returns ERROR_SUCCESS (0) and writes a valid
 *                          NODE_CLUSTER_STATE value into the out buffer.
 *   - OpenCluster(NULL)    returns a non-zero HCLUSTER when the Cluster
 *                          service is running, else 0n with a sensible
 *                          GetLastError — both verified.
 *   - When clustered, the cluster handle round-trips through GetCluster
 *                          Information and CloseCluster releases it cleanly.
 *   - The enum trio (ClusterOpenEnum / ClusterGetEnumCount / ClusterCloseEnum)
 *                          is bound and callable end-to-end when clustered.
 *   - Every example-critical symbol resolves as a callable function.
 *
 * Run: bun test example/clusapi.integration.test.ts
 */

import { expect, test } from 'bun:test';
import { FFIType, dlopen } from 'bun:ffi';

import Clusapi from '../index';

const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;

// Documented NODE_CLUSTER_STATE values (clusapi.h).
const VALID_NODE_STATES = new Set([0x00, 0x01, 0x03, 0x13]);

const kernel32 = dlopen('kernel32.dll', {
  GetLastError: { args: [], returns: FFIType.u32 },
});

test('GetNodeClusterState succeeds and yields a documented NODE_CLUSTER_STATE', () => {
  const stateBuffer = Buffer.alloc(4);
  const rc = Clusapi.GetNodeClusterState(null, stateBuffer.ptr!);
  expect(rc).toBe(ERROR_SUCCESS);

  const state = stateBuffer.readUInt32LE(0);
  expect(VALID_NODE_STATES.has(state)).toBe(true);
});

test('OpenCluster(NULL) behaves correctly whether or not the node is clustered', () => {
  const stateBuffer = Buffer.alloc(4);
  Clusapi.GetNodeClusterState(null, stateBuffer.ptr!);
  const serviceRunning = (stateBuffer.readUInt32LE(0) & 0x10) !== 0;

  const hCluster = Clusapi.OpenCluster(null);

  if (serviceRunning) {
    expect(hCluster).not.toBe(0n);

    // Round-trip the handle through GetClusterInformation.
    const cviSize = 304;
    const cvi = Buffer.alloc(cviSize);
    cvi.writeUInt32LE(cviSize, 0);
    const cch = Buffer.alloc(4);
    cch.writeUInt32LE(256, 0);
    const nameBuffer = Buffer.alloc(256 * 2);
    const infoRc = Clusapi.GetClusterInformation(hCluster, nameBuffer.ptr!, cch.ptr!, cvi.ptr!);
    expect([ERROR_SUCCESS, ERROR_MORE_DATA]).toContain(infoRc);

    // The enum trio must be callable end-to-end.
    const CLUSTER_ENUM_NODE = 0x0000_0001;
    const hEnum = Clusapi.ClusterOpenEnum(hCluster, CLUSTER_ENUM_NODE);
    expect(hEnum).not.toBe(0n);
    const count = Clusapi.ClusterGetEnumCount(hEnum);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Clusapi.ClusterCloseEnum(hEnum)).toBe(ERROR_SUCCESS);

    expect(Clusapi.CloseCluster(hCluster)).not.toBe(0);
  } else {
    // Standalone: no Cluster service. OpenCluster must fail cleanly with 0n
    // and a non-zero last-error code (the real RPC/LPC failure).
    expect(hCluster).toBe(0n);
    const err = kernel32.symbols.GetLastError();
    expect(err).not.toBe(0);
  }
});

test('example-critical clusapi symbols resolve as callable functions', () => {
  for (const name of [
    'GetNodeClusterState',
    'OpenCluster',
    'CloseCluster',
    'GetClusterInformation',
    'ClusterOpenEnum',
    'ClusterEnum',
    'ClusterGetEnumCount',
    'ClusterCloseEnum',
    'OpenClusterNode',
    'GetClusterNodeState',
    'CloseClusterNode',
  ] as const) {
    expect(typeof Clusapi[name]).toBe('function');
  }
});
