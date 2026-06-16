/**
 * clipboard-files — read_clipboard used to report the Explorer copy/paste workflow as "(clipboard empty or not text)":
 * Ctrl+C on files puts CF_HDROP (a file-drop list), not CF_UNICODETEXT, so a text-only read saw nothing. read_clipboard
 * now parses CF_HDROP (DROPFILES struct, zero new bindings) and lists the copied file paths, then falls back to text.
 *
 * Proof: seed a CF_HDROP file list (PowerShell Set-Clipboard -Path), then readClipboardFiles() returns the paths and the
 * MCP read_clipboard tool lists them; setting text clears the file list (text read wins again). No windows spawned.
 *
 * bun test is broken repo-wide — runnable harness (MCP subprocess + the OS clipboard):
 * Run: bun run example/clipboard-files.integration.test.ts
 */
import { readClipboard, readClipboardFiles } from '@bun-win32/uia';

type Rpc = { id?: number; result?: { isError?: boolean; content?: { text?: string }[] } };
const proc = Bun.spawn(['bun', 'run', `${import.meta.dir}/../mcp.ts`], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: { ...Bun.env, BUN_UIA_PROFILE: 'safe' } });
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = '';
const pending = new Map<number, (message: Rpc) => void>();
void (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length === 0) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (typeof message.id === 'number' && pending.has(message.id)) {
          pending.get(message.id)!(message);
          pending.delete(message.id);
        }
      } catch {}
    }
  }
})();
let nextId = 1;
const call = (method: string, params: unknown): Promise<Rpc> => {
  const id = nextId++;
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  proc.stdin.flush();
  return new Promise((resolve) => pending.set(id, resolve));
};
const textOf = (m: Rpc): string => m.result?.content?.[0]?.text ?? '';

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) console.log(`  ok: ${message}`);
  else {
    console.error(`  FAIL: ${message}`);
    failures += 1;
  }
}

try {
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'clipboard-files', version: '1' } });

  // Seed a CF_HDROP file list the way Explorer's Ctrl+C does.
  const seed = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command', "Set-Clipboard -Path 'C:\\Windows\\System32\\notepad.exe','C:\\Windows\\System32\\calc.exe'"]);
  await Bun.sleep(200);
  const files = readClipboardFiles();
  if (seed.exitCode !== 0 || files.length === 0) console.log('  skip: could not seed a CF_HDROP file list (Set-Clipboard unavailable)');
  else {
    assert(files.length === 2 && files.some((path) => /notepad\.exe$/i.test(path)) && files.some((path) => /calc\.exe$/i.test(path)), `readClipboardFiles() returns the copied file paths (got ${JSON.stringify(files)})`);
    assert(readClipboard() === '', 'readClipboard() (text) is empty for a file-drop clipboard — the old behavior, now no longer the whole story');

    const wire = await call('tools/call', { name: 'read_clipboard', arguments: {} });
    assert(wire.result?.isError !== true && /2 files on the clipboard \(CF_HDROP\)/.test(textOf(wire)) && /notepad\.exe/i.test(textOf(wire)), `MCP read_clipboard lists the copied files (got: ${JSON.stringify(textOf(wire).slice(0, 90))})`);

    // Setting text clears the file list — the text path wins again (regression guard).
    await call('tools/call', { name: 'set_clipboard', arguments: { text: 'plain text now' } });
    await Bun.sleep(100);
    const afterText = await call('tools/call', { name: 'read_clipboard', arguments: {} });
    assert(/plain text now/.test(textOf(afterText)) && !/CF_HDROP/.test(textOf(afterText)) && readClipboardFiles().length === 0, 'after set_clipboard, read_clipboard returns the text (no stale file list)');
  }
} finally {
  proc.kill();
}

console.log(failures === 0 ? '\nPASS — read_clipboard surfaces copied files (CF_HDROP) and still reads text.' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
