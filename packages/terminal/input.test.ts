// Decode-contract checks for the console-record fields the focus / paste features
// rely on: that a FOCUS_EVENT round-trips through the kernel32 decoder, and that
// injected (pasted) text is distinguishable by its zero virtual-key code. Run:
// `bun run packages/terminal/input.test.ts`.

import { EventType, INPUT_RECORD_SIZE, decodeInputRecord } from '@bun-win32/kernel32';

let passCount = 0;
let failCount = 0;
const assert = (label: string, condition: boolean, detail = ''): void => {
  if (condition) passCount++;
  else {
    failCount++;
    console.log(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// Build one INPUT_RECORD (x64 stride INPUT_RECORD_SIZE). The union starts at +0x04.
const makeRecord = (fill: (record: Buffer) => void): Buffer => {
  const record = Buffer.alloc(INPUT_RECORD_SIZE);
  fill(record);
  return record;
};

{
  const gained = makeRecord((record) => {
    record.writeUInt16LE(EventType.FOCUS_EVENT, 0x00);
    record.writeInt32LE(1, 0x04); // bSetFocus
  });
  const decoded = decodeInputRecord(gained);
  assert('FOCUS_EVENT type', decoded.eventType === EventType.FOCUS_EVENT);
  assert('focus gained → setFocus true', decoded.focusEvent?.setFocus === true);
}

{
  const lost = makeRecord((record) => {
    record.writeUInt16LE(EventType.FOCUS_EVENT, 0x00);
    record.writeInt32LE(0, 0x04);
  });
  assert('focus lost → setFocus false', decodeInputRecord(lost).focusEvent?.setFocus === false);
}

{
  // Pasted/injected character: keyDown, no physical key (VK 0), a real code unit.
  const pasted = makeRecord((record) => {
    record.writeUInt16LE(EventType.KEY_EVENT, 0x00);
    record.writeInt32LE(1, 0x04); // bKeyDown
    record.writeUInt16LE(1, 0x08); // repeatCount
    record.writeUInt16LE(0, 0x0a); // virtualKeyCode = 0 → injected
    record.writeUInt16LE(0, 0x0c); // virtualScanCode = 0
    record.writeUInt16LE(0x48, 0x0e); // 'H'
  });
  const decoded = decodeInputRecord(pasted);
  assert('paste signal: VK 0 with a character', decoded.keyEvent?.virtualKeyCode === 0 && decoded.keyEvent?.character === 0x48);
  assert('paste signal: keyDown', decoded.keyEvent?.keyDown === true);
}

{
  // Typed character: a real virtual-key code distinguishes it from a paste.
  const typed = makeRecord((record) => {
    record.writeUInt16LE(EventType.KEY_EVENT, 0x00);
    record.writeInt32LE(1, 0x04);
    record.writeUInt16LE(1, 0x08);
    record.writeUInt16LE(0x48, 0x0a); // VK_H — a physical key
    record.writeUInt16LE(0x23, 0x0c);
    record.writeUInt16LE(0x68, 0x0e); // 'h'
  });
  assert('typed char has a non-zero virtual-key code', decodeInputRecord(typed).keyEvent?.virtualKeyCode === 0x48);
}

console.log(`input.test: ${passCount} pass, ${failCount} fail`);
if (failCount > 0) process.exit(1);
