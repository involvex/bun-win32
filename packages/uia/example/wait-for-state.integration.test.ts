/**
 * wait-for-state — waitForState (the Playwright expect(locator).toBeChecked()/toHaveValue()/toBeEnabled() analogue)
 * existed in the library (Element.waitForState) but the MCP/agent surface could NOT reach it: the wait_for tool only
 * branched on appear vs gone:true. This wires a `state` object into wait_for so a client can RETRY until a control
 * reaches a state instead of polling appear + re-snapshot + parse by hand.
 *
 * Proof (against the always-present taskbar — read-only, never closed, a real self-pumping process so no UIA
 * self-automation deadlock): wait_for {state:{enabled:true}} on the StartButton (always enabled) RESOLVES with
 * "reached"; {state:{enabled:false}} on the same control TIMES OUT quoting the "last seen" state; an EMPTY state is
 * REJECTED. Before the fix, state was ignored — wait_for returned "matched" (appear) and never timed out on a state
 * mismatch, so every assertion below fails. Launches NOTHING — the taskbar is a system window, so no force-kill.
 *
 * bun test is broken repo-wide — runnable harness (MCP subprocess + the taskbar):
 * Run: bun run example/wait-for-state.integration.test.ts
 */
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
  await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'wait-state', version: '1' } });
  const tools = (await call('tools/list', {})).result as { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } | undefined;
  const waitForTool = tools?.tools?.find((tool) => tool.name === 'wait_for');
  assert(waitForTool !== undefined && waitForTool.inputSchema?.properties?.state !== undefined, 'wait_for advertises a `state` property in its inputSchema (reachable by an MCP client)');
  assert(tools?.tools?.some((tool) => tool.name === 'wait_for_state') !== true, 'there is NO separate wait_for_state tool — state lives on wait_for (tool count unchanged)');

  const snap = textOf(await call('tools/call', { name: 'attach', arguments: { className: 'Shell_TrayWnd' } }));
  if (snap.length === 0) console.log('  skip: could not attach the taskbar');
  else if (!/StartButton/.test(snap)) console.log('  skip: no StartButton on this taskbar layout');
  else {
    // Resolve branch: the StartButton is always enabled → {enabled:true} reaches the state promptly.
    const reached = await call('tools/call', { name: 'wait_for', arguments: { selector: { automationId: 'StartButton' }, state: { enabled: true }, timeout: 3000 } });
    assert(reached.result?.isError !== true && /reached .*enabled.*true.* on /.test(textOf(reached)), `wait_for {state:{enabled:true}} RESOLVES with "reached" (got: ${JSON.stringify(textOf(reached).slice(0, 90))})`);

    // Timeout branch: the StartButton never becomes disabled → {enabled:false} TIMES OUT quoting the last-seen state.
    const stuck = await call('tools/call', { name: 'wait_for', arguments: { selector: { automationId: 'StartButton' }, state: { enabled: false }, timeout: 800 } });
    assert(stuck.result?.isError === true && /never reached|last seen/.test(textOf(stuck)), `wait_for {state:{enabled:false}} TIMES OUT with the last-seen state (got: ${JSON.stringify(textOf(stuck).slice(0, 90))})`);

    // Guard branch: an EMPTY state matches the first poll vacuously → rejected so no false "reached".
    const empty = await call('tools/call', { name: 'wait_for', arguments: { selector: { automationId: 'StartButton' }, state: {}, timeout: 800 } });
    assert(empty.result?.isError === true && /empty state/.test(textOf(empty)), `wait_for {state:{}} is REJECTED (got: ${JSON.stringify(textOf(empty).slice(0, 90))})`);
  }
} finally {
  proc.kill();
}

console.log(failures === 0 ? '\nPASS — wait_for reaches a control STATE (resolve / timeout / empty-state-guard) through the MCP surface.' : `\nFAILED — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
