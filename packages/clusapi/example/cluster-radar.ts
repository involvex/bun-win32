/**
 * Cluster Radar
 *
 * A live, animated console "radar" that sweeps the Failover Cluster fabric in
 * real time. A rotating radar beam paints the screen; each detected cluster
 * node is plotted as a blip whose color pulses with its decoded state. The
 * radar polls clusapi.dll on every frame using the real GetNodeClusterState
 * call, so the display reacts to the actual Cluster service. On a standalone
 * machine (no Cluster service) the radar still sweeps and honestly reports an
 * empty fabric — proving the FFI round-trip works even with nothing to find.
 *
 * APIs demonstrated (Clusapi):
 *   - GetNodeClusterState   (poll local Cluster service state every frame)
 *   - OpenCluster / CloseCluster
 *   - ClusterOpenEnum / ClusterEnum / ClusterGetEnumCount / ClusterCloseEnum
 *   - OpenClusterNode / GetClusterNodeState / CloseClusterNode
 *
 * APIs demonstrated (Kernel32, cross-package):
 *   - GetStdHandle / GetConsoleMode / SetConsoleMode (enable ANSI VT output)
 *   - SetConsoleTitleW                               (window title)
 *
 * Run: bun run example/cluster-radar.ts
 */
import Clusapi, { CLUSTER_NODE_STATE } from '../index';
import Kernel32, { STD_HANDLE } from '@bun-win32/kernel32';

Clusapi.Preload(['GetNodeClusterState', 'OpenCluster', 'CloseCluster', 'ClusterOpenEnum', 'ClusterEnum', 'ClusterGetEnumCount', 'ClusterCloseEnum', 'OpenClusterNode', 'GetClusterNodeState', 'CloseClusterNode']);
Kernel32.Preload(['GetStdHandle', 'GetConsoleMode', 'SetConsoleMode', 'SetConsoleTitleW']);

const ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
const hStdout = Kernel32.GetStdHandle(STD_HANDLE.OUTPUT);
const modeBuf = Buffer.alloc(4);
if (Kernel32.GetConsoleMode(hStdout, modeBuf.ptr!)) {
  Kernel32.SetConsoleMode(hStdout, modeBuf.readUInt32LE(0) | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
}
Kernel32.SetConsoleTitleW(Buffer.from('Cluster Radar\0', 'utf16le').ptr!);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[92m';
const CYAN = '\x1b[96m';
const YELLOW = '\x1b[93m';
const RED = '\x1b[91m';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

const CLUSTER_ENUM_NODE = 0x0000_0001;
const ERROR_MORE_DATA = 234;

const R = 11; // radar radius in character rows
const W = R * 2 + 1;
const H = R * 2 + 1;

type Blip = { name: string; angle: number; radius: number; state: number };

function readWide(buf: Buffer, chars: number): string {
  return buf
    .subarray(0, chars * 2)
    .toString('utf16le')
    .replace(/\0.*$/, '');
}

function discoverNodes(): { clustered: boolean; nodeState: number; blips: Blip[] } {
  const stateBuf = Buffer.alloc(4);
  const rc = Clusapi.GetNodeClusterState(null, stateBuf.ptr!);
  const nodeState = rc === 0 ? stateBuf.readUInt32LE(0) : -1;
  const running = rc === 0 && (nodeState & 0x10) !== 0;
  if (!running) return { clustered: false, nodeState, blips: [] };

  const hCluster = Clusapi.OpenCluster(null);
  if (hCluster === 0n) return { clustered: false, nodeState, blips: [] };

  const blips: Blip[] = [];
  const hEnum = Clusapi.ClusterOpenEnum(hCluster, CLUSTER_ENUM_NODE);
  if (hEnum !== 0n) {
    const count = Clusapi.ClusterGetEnumCount(hEnum);
    for (let i = 0; i < count; i++) {
      const typeBuf = Buffer.alloc(4);
      const cch = Buffer.alloc(4);
      cch.writeUInt32LE(256, 0);
      const nameOut = Buffer.alloc(256 * 2);
      let er = Clusapi.ClusterEnum(hEnum, i, typeBuf.ptr!, nameOut.ptr!, cch.ptr!);
      let name = '';
      if (er === 0) {
        name = readWide(nameOut, cch.readUInt32LE(0));
      } else if (er === ERROR_MORE_DATA) {
        const need = cch.readUInt32LE(0) + 1;
        const big = Buffer.alloc(need * 2);
        cch.writeUInt32LE(need, 0);
        er = Clusapi.ClusterEnum(hEnum, i, typeBuf.ptr!, big.ptr!, cch.ptr!);
        if (er === 0) name = readWide(big, cch.readUInt32LE(0));
      }
      if (!name) continue;

      let st = -1;
      const hNode = Clusapi.OpenClusterNode(hCluster, Buffer.from(name + '\0', 'utf16le').ptr!);
      if (hNode !== 0n) {
        st = Clusapi.GetClusterNodeState(hNode);
        Clusapi.CloseClusterNode(hNode);
      }
      const angle = (i / Math.max(1, count)) * Math.PI * 2;
      blips.push({ name, angle, radius: R - 2, state: st });
    }
    Clusapi.ClusterCloseEnum(hEnum);
  }
  Clusapi.CloseCluster(hCluster);
  return { clustered: true, nodeState, blips };
}

function stateColor(s: number): string {
  switch (s) {
    case CLUSTER_NODE_STATE.ClusterNodeUp:
      return GREEN;
    case CLUSTER_NODE_STATE.ClusterNodePaused:
      return YELLOW;
    case CLUSTER_NODE_STATE.ClusterNodeJoining:
      return CYAN;
    case CLUSTER_NODE_STATE.ClusterNodeDown:
      return RED;
    default:
      return DIM;
  }
}

let running = true;
process.on('SIGINT', () => {
  running = false;
});

process.stdout.write(HIDE_CURSOR + CLEAR);

const NODE_CLUSTER_STATE: Record<number, string> = {
  0x00: 'NotInstalled',
  0x01: 'NotConfigured',
  0x03: 'NotRunning',
  0x13: 'Running',
};

let sweep = 0;
const TOTAL_FRAMES = 240;
let frame = 0;

const timer = setInterval(() => {
  if (!running || frame >= TOTAL_FRAMES) {
    clearInterval(timer);
    process.stdout.write(SHOW_CURSOR + RESET);
    console.log(`\n${DIM}Radar offline. Swept ${frame} frames.${RESET}`);
    process.exit(0);
  }
  frame++;
  sweep = (sweep + 0.18) % (Math.PI * 2);

  const probe = discoverNodes();

  const grid: string[][] = Array.from({ length: H }, () => Array(W).fill(' '));

  // Draw the radar dish (circle) + cross hairs.
  for (let a = 0; a < 360; a += 3) {
    const rad = (a * Math.PI) / 180;
    const x = Math.round(R + Math.cos(rad) * R);
    const y = Math.round(R + Math.sin(rad) * (R * 0.5));
    if (grid[y]) grid[y][x] = `${DIM}${CYAN}·${RESET}`;
  }
  for (let i = -R; i <= R; i++) {
    if (grid[R]) grid[R][R + i] = `${DIM}${CYAN}·${RESET}`;
    const yy = Math.round(R + i * 0.5);
    if (grid[yy]) grid[yy][R] = `${DIM}${CYAN}·${RESET}`;
  }

  // The sweeping beam.
  for (let r = 0; r <= R; r++) {
    const x = Math.round(R + Math.cos(sweep) * r);
    const y = Math.round(R + Math.sin(sweep) * (r * 0.5));
    if (grid[y] && grid[y][x] !== undefined) grid[y][x] = `${GREEN}${r === R ? '◆' : '─'}${RESET}`;
  }

  // Plot node blips; pulse those near the beam.
  for (const b of probe.blips) {
    const x = Math.round(R + Math.cos(b.angle) * b.radius);
    const y = Math.round(R + Math.sin(b.angle) * (b.radius * 0.5));
    const near = Math.abs(((b.angle - sweep + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.4;
    const glyph = near ? '◉' : '●';
    if (grid[y] && grid[y][x] !== undefined) grid[y][x] = `${BOLD}${stateColor(b.state)}${glyph}${RESET}`;
  }

  // Render.
  let out = CLEAR;
  out += `${BOLD}${CYAN}╔══ CLUSTER RADAR ══════════════════════════════╗${RESET}\n`;
  for (let y = 0; y < H; y++) {
    out += `${CYAN}║${RESET} ` + grid[y].join('') + '\n';
  }
  out += `${BOLD}${CYAN}╚═══════════════════════════════════════════════╝${RESET}\n`;

  const svc = NODE_CLUSTER_STATE[probe.nodeState] ?? `0x${(probe.nodeState >>> 0).toString(16)}`;
  out += `${DIM}sweep ${(((sweep / (Math.PI * 2)) * 100) | 0).toString().padStart(3)}%  `;
  out += `frame ${frame}/${TOTAL_FRAMES}  `;
  out += `service: ${RESET}`;
  out += probe.clustered ? `${GREEN}${svc}${RESET}` : `${YELLOW}${svc}${RESET}`;
  out += `${DIM}  contacts: ${RESET}${BOLD}${probe.blips.length}${RESET}\n`;

  if (probe.blips.length === 0) {
    out += `${YELLOW}No cluster fabric detected — this node is standalone.${RESET}\n`;
    out += `${DIM}The radar is live: every frame issues a real GetNodeClusterState`;
    out += ` FFI call into clusapi.dll. There is simply nothing to paint.${RESET}\n`;
  } else {
    for (const b of probe.blips) {
      const sName = CLUSTER_NODE_STATE[b.state] ?? `0x${(b.state >>> 0).toString(16)}`;
      out += `  ${stateColor(b.state)}●${RESET} ${b.name.padEnd(20)} ${DIM}${sName}${RESET}\n`;
    }
  }
  out += `${DIM}Ctrl+C to disengage.${RESET}`;

  process.stdout.write(out);
}, 70);
