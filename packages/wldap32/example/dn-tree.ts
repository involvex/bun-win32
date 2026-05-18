/**
 * LDAP Directory Tree
 *
 * Takes a flat list of LDAP distinguished names and reconstructs the directory
 * hierarchy purely from native DN decomposition. Every DN is split into its
 * relative components by wldap32's own ldap_explode_dnW, the components are
 * woven into a tree, and the tree is drawn with box-drawing characters and
 * ANSI colour — domain components in blue, organizational units in yellow,
 * leaf objects in green. Nodes are revealed top-down with a brief pause for a
 * "directory replicating" effect (skipped automatically when output is piped).
 *
 * No LDAP server is contacted; the structure is derived entirely from the
 * native string decomposition of each DN.
 *
 * APIs demonstrated:
 *   - ldap_explode_dnW             (split each DN into RDN components)
 *   - ldap_value_freeW             (free the ldap_explode_dnW string array)
 *   - ldap_dn2ufnW                 (user-friendly name for the summary line)
 *   - ldap_memfreeW                (free the ldap_dn2ufnW string)
 *
 * Run: bun run example/dn-tree.ts
 */

import { type Pointer, toArrayBuffer } from 'bun:ffi';

import Wldap32 from '../index';

Wldap32.Preload(['ldap_explode_dnW', 'ldap_value_freeW', 'ldap_dn2ufnW', 'ldap_memfreeW']);

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const BLUE = '\x1b[38;5;39m';
const YELLOW = '\x1b[38;5;220m';
const GREEN = '\x1b[38;5;48m';
const GREY = '\x1b[90m';
const MAGENTA = '\x1b[38;5;213m';

const DIRECTORY: string[] = [
  'CN=Ada Lovelace,OU=Engineering,OU=People,DC=acme,DC=example,DC=com',
  'CN=Grace Hopper,OU=Engineering,OU=People,DC=acme,DC=example,DC=com',
  'CN=Alan Turing,OU=Research,OU=People,DC=acme,DC=example,DC=com',
  'CN=Katherine Johnson,OU=Research,OU=People,DC=acme,DC=example,DC=com',
  'CN=Build Server 01,OU=Servers,OU=Devices,DC=acme,DC=example,DC=com',
  'CN=Build Server 02,OU=Servers,OU=Devices,DC=acme,DC=example,DC=com',
  'CN=Printer-3F,OU=Printers,OU=Devices,DC=acme,DC=example,DC=com',
  'CN=Domain Admins,OU=Groups,DC=acme,DC=example,DC=com',
  'CN=Backup Operators,OU=Groups,DC=acme,DC=example,DC=com',
  'CN=guest,OU=Service Accounts,DC=acme,DC=example,DC=com',
];

interface TreeNode {
  children: Map<string, TreeNode>;
  isLeaf: boolean;
  label: string;
}

function newNode(label: string): TreeNode {
  return { children: new Map(), isLeaf: false, label };
}

function readWideString(addr: number | bigint, maxBytes = 1024): string {
  const value = typeof addr === 'bigint' ? Number(addr) : addr;
  if (!value) return '';
  const buffer = Buffer.from(toArrayBuffer(value as Pointer, 0, maxBytes));
  let end = buffer.length;
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    if (buffer.readUInt16LE(index) === 0) {
      end = index;
      break;
    }
  }
  return buffer.subarray(0, end).toString('utf16le');
}

// Split a DN with the real wldap32 parser. ldap_explode_dnW returns a
// NULL-terminated array of wide-string pointers, ordered leaf -> root.
function explodeDn(dn: string): string[] {
  const arrayPointer = Wldap32.ldap_explode_dnW(Buffer.from(dn + '\0', 'utf16le').ptr, 0);
  if (!arrayPointer) return [];
  const parts: string[] = [];
  for (let offset = 0; ; offset += 8) {
    const elementAddress = new BigUint64Array(toArrayBuffer(arrayPointer, offset, 8))[0]!;
    if (elementAddress === 0n) break;
    parts.push(readWideString(elementAddress));
  }
  Wldap32.ldap_value_freeW(arrayPointer);
  return parts;
}

function colourFor(component: string, isLeaf: boolean): string {
  if (isLeaf) return GREEN;
  if (component.startsWith('DC=')) return BLUE;
  if (component.startsWith('OU=')) return YELLOW;
  return MAGENTA;
}

function iconFor(component: string, isLeaf: boolean): string {
  if (isLeaf) return '●';
  if (component.startsWith('DC=')) return '◆';
  if (component.startsWith('OU=')) return '▸';
  return '○';
}

const root = newNode('');

for (const dn of DIRECTORY) {
  const components = explodeDn(dn);
  if (components.length === 0) continue;
  // Components arrive leaf -> root; walk root -> leaf to build the hierarchy.
  let cursor = root;
  for (let index = components.length - 1; index >= 0; index -= 1) {
    const component = components[index]!;
    let child = cursor.children.get(component);
    if (!child) {
      child = newNode(component);
      cursor.children.set(component, child);
    }
    if (index === 0) child.isLeaf = true;
    cursor = child;
  }
}

const interactive = Boolean(process.stdout.isTTY);

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function render(node: TreeNode, prefix: string, isLast: boolean, depth: number): Promise<void> {
  if (depth >= 0) {
    const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    const colour = colourFor(node.label, node.isLeaf);
    const icon = iconFor(node.label, node.isLeaf);
    console.log(`${GREY}${prefix}${connector}${RESET}${colour}${icon} ${node.label}${RESET}`);
    if (interactive) await sleep(node.isLeaf ? 14 : 36);
  }

  const childPrefix = depth <= 0 ? '' : prefix + (isLast ? '   ' : `${GREY}│${RESET}  `);
  const children = [...node.children.values()].sort((left, right) => left.label.localeCompare(right.label));
  for (let index = 0; index < children.length; index += 1) {
    await render(children[index]!, childPrefix, index === children.length - 1, depth + 1);
  }
}

let leafCount = 0;
let containerCount = 0;
(function tally(node: TreeNode): void {
  for (const child of node.children.values()) {
    if (child.isLeaf) leafCount += 1;
    else containerCount += 1;
    tally(child);
  }
})(root);

console.log(`\n${BOLD}${MAGENTA}LDAP Directory Tree${RESET}  ${GREY}— reconstructed from ${DIRECTORY.length} DNs via ldap_explode_dnW${RESET}\n`);

const topComponents = [...root.children.values()];
for (let index = 0; index < topComponents.length; index += 1) {
  await render(topComponents[index]!, '', index === topComponents.length - 1, 0);
}

const sampleUfnPointer = Wldap32.ldap_dn2ufnW(Buffer.from(DIRECTORY[0]! + '\0', 'utf16le').ptr);
const sampleUfn = sampleUfnPointer === null ? '' : readWideString(sampleUfnPointer);
if (sampleUfnPointer !== null) Wldap32.ldap_memfreeW(sampleUfnPointer);

console.log(`\n${GREY}${'─'.repeat(60)}${RESET}`);
console.log(`${BLUE}◆ domain${RESET}   ${YELLOW}▸ org-unit${RESET}   ${GREEN}● leaf object${RESET}`);
console.log(`${DIM}${containerCount} containers, ${leafCount} leaf objects${RESET}`);
console.log(`${DIM}ldap_dn2ufnW("${DIRECTORY[0]}")${RESET}`);
console.log(`${DIM}  → ${sampleUfn}${RESET}\n`);
