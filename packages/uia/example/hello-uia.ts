/**
 * Hello UIA — type into Notepad and read it back, in ten lines.
 *
 * Launches Notepad, waits for its text area to appear in the accessibility tree, types a string by
 * driving the real keyboard, then reads the value back THROUGH the UIA tree. No native modules, no
 * Appium server, no .NET. (Requires an unlocked, interactive desktop — synthetic input is blocked on
 * a locked session.)
 *
 * APIs demonstrated:
 * - uia.attach / activate / waitFor / Element.focus / type / text (the Playwright-for-desktop core)
 *
 * Run: bun run example/hello-uia.ts
 */
import { ControlType, uia } from '@bun-win32/uia';

Bun.spawn(['notepad.exe']);
await Bun.sleep(2000);
const app = uia.attach({ className: 'Notepad' }).activate();
const edit = await app.waitFor({ controlType: ControlType.Document });
edit.focus().type('nothing native compiles, and it just works');
await Bun.sleep(300);
console.log(edit.text()); // → nothing native compiles, and it just works
uia.uninitialize();
