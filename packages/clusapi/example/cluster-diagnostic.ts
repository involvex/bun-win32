/**
 * Failover Cluster Diagnostic
 *
 * A thorough, richly-formatted Failover Cluster report. Probes the local node's
 * Cluster service state, decodes it against the documented NODE_CLUSTER_STATE
 * values, and — when a cluster service is present — opens a cluster handle,
 * reads the cluster name and CLUSTERVERSIONINFO, then enumerates every node,
 * group, resource, resource type, network, and network interface with their
 * decoded state. On the common standalone machine (no Cluster service) it
 * reports "not clustered" cleanly while still demonstrating the real FFI call
 * and Win32 return-code decoding.
 *
 * APIs demonstrated (Clusapi):
 *   - GetNodeClusterState        (is the Cluster service installed/running?)
 *   - OpenCluster / CloseCluster (connect to / release the local cluster)
 *   - GetClusterInformation      (cluster name + CLUSTERVERSIONINFO)
 *   - ClusterOpenEnum / ClusterEnum / ClusterGetEnumCount / ClusterCloseEnum
 *                                (enumerate nodes, groups, resources, networks)
 *   - OpenClusterNode / GetClusterNodeState / CloseClusterNode
 *   - OpenClusterGroup / GetClusterGroupState / CloseClusterGroup
 *   - OpenClusterResource / GetClusterResourceState / CloseClusterResource
 *   - OpenClusterNetwork / GetClusterNetworkState / CloseClusterNetwork
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT output)
 *   - GetLastError                                   (decode failure codes)
 *
 * Run: bun run example/cluster-diagnostic.ts
 */
import Clusapi, { CLUSTER_GROUP_STATE, CLUSTER_NETWORK_STATE, CLUSTER_NODE_STATE, CLUSTER_RESOURCE_STATE } from '../index';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Clusapi.Preload([
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
  'OpenClusterGroup',
  'GetClusterGroupState',
  'CloseClusterGroup',
  'OpenClusterResource',
  'GetClusterResourceState',
  'CloseClusterResource',
  'OpenClusterNetwork',
  'GetClusterNetworkState',
  'CloseClusterNetwork',
]);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'GetLastError']);

// Enable ANSI escape processing so colors render in modern terminals.
const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[91m';
const GREEN = '\x1b[92m';
const YELLOW = '\x1b[93m';
const CYAN = '\x1b[96m';
const RESET = '\x1b[0m';

// NODE_CLUSTER_STATE — documented values from clusapi.h.
const NODE_CLUSTER_STATE: Record<number, string> = {
  0x00: 'ClusterStateNotInstalled',
  0x01: 'ClusterStateNotConfigured',
  0x03: 'ClusterStateNotRunning',
  0x13: 'ClusterStateRunning',
};

// CLUSTER_ENUM_* item-type bits used by ClusterOpenEnum.
const CLUSTER_ENUM_NODE = 0x0000_0001;
const CLUSTER_ENUM_RESTYPE = 0x0000_0002;
const CLUSTER_ENUM_RESOURCE = 0x0000_0004;
const CLUSTER_ENUM_GROUP = 0x0000_0008;
const CLUSTER_ENUM_NETWORK = 0x0000_0010;
const CLUSTER_ENUM_NETINTERFACE = 0x0000_0020;

const ERROR_MORE_DATA = 234;

function rule(label: string): void {
  const line = '─'.repeat(Math.max(0, 64 - label.length));
  console.log(`\n${BOLD}${CYAN}── ${label} ${line}${RESET}`);
}

function field(label: string, value: string): void {
  console.log(`  ${DIM}${label.padEnd(26)}${RESET}${value}`);
}

function readWide(buf: Buffer, chars: number): string {
  return buf
    .subarray(0, chars * 2)
    .toString('utf16le')
    .replace(/\0.*$/, '');
}

function nodeStateName(s: number): string {
  return CLUSTER_NODE_STATE[s] ?? `0x${(s >>> 0).toString(16)}`;
}
function groupStateName(s: number): string {
  return CLUSTER_GROUP_STATE[s] ?? `0x${(s >>> 0).toString(16)}`;
}
function resourceStateName(s: number): string {
  return CLUSTER_RESOURCE_STATE[s] ?? `0x${(s >>> 0).toString(16)}`;
}
function networkStateName(s: number): string {
  return CLUSTER_NETWORK_STATE[s] ?? `0x${(s >>> 0).toString(16)}`;
}

console.log(`${BOLD}Failover Cluster Diagnostic${RESET}`);
console.log(`${DIM}clusapi.dll · live FFI · ${new Date().toISOString()}${RESET}`);

// ── Step 1: probe the local node's Cluster service state ───────────────────
rule('Local Node Cluster Service');

const stateBuf = Buffer.alloc(4);
const stateRc = Clusapi.GetNodeClusterState(null, stateBuf.ptr!);

if (stateRc !== 0) {
  field('GetNodeClusterState', `${RED}failed, rc=${stateRc}${RESET}`);
  console.log(`\n${RED}Unable to query Cluster service state.${RESET}`);
  process.exit(0);
}

const nodeState = stateBuf.readUInt32LE(0);
const installed = (nodeState & 0x01) !== 0;
const configured = (nodeState & 0x02) !== 0;
const running = (nodeState & 0x10) !== 0;

field('Raw state', `0x${nodeState.toString(16).padStart(2, '0')}`);
field('Decoded', NODE_CLUSTER_STATE[nodeState] ?? 'unknown');
field('Cluster service installed', installed ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`);
field('Cluster configured', configured ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`);
field('Cluster service running', running ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`);

if (!running) {
  console.log(`\n${YELLOW}This machine is not an active cluster node — the Cluster service ` + `is ${installed ? 'installed but not running' : 'not installed'}.${RESET}`);
  console.log(`${DIM}This is the expected result on a standalone workstation/server. The real ` + `FFI call to clusapi.dll succeeded; there is simply no cluster to enumerate.${RESET}`);
  process.exit(0);
}

// ── Step 2: open the local cluster ─────────────────────────────────────────
rule('Cluster Connection');

const hCluster = Clusapi.OpenCluster(null);
if (hCluster === 0n) {
  const err = Kernel32.GetLastError();
  field('OpenCluster(NULL)', `${RED}failed, GetLastError=${err}${RESET}`);
  process.exit(0);
}
field('OpenCluster(NULL)', `${GREEN}connected${RESET} (handle 0x${hCluster.toString(16)})`);

// CLUSTERVERSIONINFO layout (x64). dwVersionInfoSize must be set on input.
// DWORD dwVersionInfoSize; WORD MajorVersion; WORD MinorVersion;
// WORD BuildNumber; WCHAR szVendorId[64]; WCHAR szCSDVersion[64];
// DWORD dwClusterHighestVersion; DWORD dwClusterLowestVersion;
// DWORDLONG dwFlags; DWORD dwReserved1; DWORD dwReserved2;
const CVI_SIZE = 304;
const cvi = Buffer.alloc(CVI_SIZE);
cvi.writeUInt32LE(CVI_SIZE, 0);

const nameLen = Buffer.alloc(4);
nameLen.writeUInt32LE(256, 0);
const nameBuf = Buffer.alloc(256 * 2);

const infoRc = Clusapi.GetClusterInformation(hCluster, nameBuf.ptr!, nameLen.ptr!, cvi.ptr!);
if (infoRc === 0 || infoRc === ERROR_MORE_DATA) {
  const clusterName = readWide(nameBuf, nameLen.readUInt32LE(0) || 256);
  const major = cvi.readUInt16LE(4);
  const minor = cvi.readUInt16LE(6);
  const build = cvi.readUInt16LE(8);
  const vendor = cvi
    .subarray(10, 10 + 128)
    .toString('utf16le')
    .replace(/\0.*$/, '');
  field('Cluster name', `${BOLD}${clusterName}${RESET}`);
  field('Cluster version', `${major}.${minor} build ${build}`);
  field('Vendor', vendor || '(unknown)');
} else {
  field('GetClusterInformation', `${YELLOW}rc=${infoRc}${RESET}`);
}

// ── Step 3: enumerate every cluster object class ───────────────────────────
type EnumSpec = {
  label: string;
  bit: number;
  open: (h: bigint, name: string) => bigint;
  close: (h: bigint) => void;
  state: (h: bigint) => string;
};

const specs: EnumSpec[] = [
  {
    label: 'Nodes',
    bit: CLUSTER_ENUM_NODE,
    open: (h, n) => Clusapi.OpenClusterNode(h, Buffer.from(n + '\0', 'utf16le').ptr!),
    close: (h) => void Clusapi.CloseClusterNode(h),
    state: (h) => nodeStateName(Clusapi.GetClusterNodeState(h)),
  },
  {
    label: 'Groups',
    bit: CLUSTER_ENUM_GROUP,
    open: (h, n) => Clusapi.OpenClusterGroup(h, Buffer.from(n + '\0', 'utf16le').ptr!),
    close: (h) => void Clusapi.CloseClusterGroup(h),
    state: (h) => groupStateName(Clusapi.GetClusterGroupState(h, null, null)),
  },
  {
    label: 'Resources',
    bit: CLUSTER_ENUM_RESOURCE,
    open: (h, n) => Clusapi.OpenClusterResource(h, Buffer.from(n + '\0', 'utf16le').ptr!),
    close: (h) => void Clusapi.CloseClusterResource(h),
    state: (h) => resourceStateName(Clusapi.GetClusterResourceState(h, null, null, null, null)),
  },
  {
    label: 'Resource Types',
    bit: CLUSTER_ENUM_RESTYPE,
    open: () => 0n,
    close: () => {},
    state: () => '',
  },
  {
    label: 'Networks',
    bit: CLUSTER_ENUM_NETWORK,
    open: (h, n) => Clusapi.OpenClusterNetwork(h, Buffer.from(n + '\0', 'utf16le').ptr!),
    close: (h) => void Clusapi.CloseClusterNetwork(h),
    state: (h) => networkStateName(Clusapi.GetClusterNetworkState(h)),
  },
  {
    label: 'Network Interfaces',
    bit: CLUSTER_ENUM_NETINTERFACE,
    open: () => 0n,
    close: () => {},
    state: () => '',
  },
];

for (const spec of specs) {
  rule(spec.label);
  const hEnum = Clusapi.ClusterOpenEnum(hCluster, spec.bit);
  if (hEnum === 0n) {
    field(spec.label, `${RED}ClusterOpenEnum failed${RESET}`);
    continue;
  }

  const count = Clusapi.ClusterGetEnumCount(hEnum);
  field('Count', String(count));

  for (let i = 0; i < count; i++) {
    const typeBuf = Buffer.alloc(4);
    const cch = Buffer.alloc(4);
    cch.writeUInt32LE(256, 0);
    const nameOut = Buffer.alloc(256 * 2);

    let rc = Clusapi.ClusterEnum(hEnum, i, typeBuf.ptr!, nameOut.ptr!, cch.ptr!);
    if (rc === ERROR_MORE_DATA) {
      const needed = cch.readUInt32LE(0) + 1;
      const bigName = Buffer.alloc(needed * 2);
      cch.writeUInt32LE(needed, 0);
      rc = Clusapi.ClusterEnum(hEnum, i, typeBuf.ptr!, bigName.ptr!, cch.ptr!);
      if (rc === 0) {
        const objName = readWide(bigName, cch.readUInt32LE(0));
        printItem(spec, objName, i);
      }
      continue;
    }
    if (rc !== 0) {
      console.log(`  ${RED}[${i}] ClusterEnum rc=${rc}${RESET}`);
      continue;
    }
    const objName = readWide(nameOut, cch.readUInt32LE(0));
    printItem(spec, objName, i);
  }

  Clusapi.ClusterCloseEnum(hEnum);
}

function printItem(spec: EnumSpec, name: string, index: number): void {
  let stateText = '';
  if (spec.open !== undefined) {
    const obj = spec.open(hCluster, name);
    if (obj !== 0n) {
      try {
        const s = spec.state(obj);
        if (s) stateText = `  ${DIM}state=${RESET}${s}`;
      } finally {
        spec.close(obj);
      }
    }
  }
  console.log(`  ${GREEN}[${index}]${RESET} ${name}${stateText}`);
}

rule('Cleanup');
field('CloseCluster', Clusapi.CloseCluster(hCluster) ? `${GREEN}released${RESET}` : `${RED}failed${RESET}`);
console.log(`\n${BOLD}${GREEN}Diagnostic complete.${RESET}`);
