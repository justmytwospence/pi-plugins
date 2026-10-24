// Pi's fullscreen screen with Sidebar (packages/pi-sidebar) open, for ../test-remote-clients.mjs: Pi's
// layout root (transcript, editor dock, footer) re-rooted into Sidebar's real split and drawn by
// Pi's real layout engine, as Sidebar mounts it. `collapsed` is the state the controller sets while
// a dialog waits (it holds `herdr:blocked`, or Pi reports a UI prompt).
import path from 'node:path';
import { createJiti } from 'jiti';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SIDEBAR = path.join(ROOT, 'packages/pi-sidebar');
const jiti = createJiti(import.meta.url);

// Sidebar loads its own copies of Pi's packages: give them the same theme and keybindings.
const ownSdk = path.join(SIDEBAR, 'node_modules/@earendil-works/pi-coding-agent/dist');
const ownSdkIndex = await import(path.join(ownSdk, 'index.js'));
const ownKeybindings = await import(path.join(ownSdk, 'core/keybindings.js'));
const ownTui = await import(path.join(SIDEBAR, 'node_modules/@earendil-works/pi-tui/dist/index.js'));
const { renderLayoutFrame } = await import(path.join(SIDEBAR, 'node_modules/@earendil-works/pi-tui/dist/layout.js'));
ownSdkIndex.initTheme('dark', false);
ownTui.setKeybindings(new ownKeybindings.KeybindingsManager({}));
const ownTheme = (await import(path.join(ownSdk, 'modes/interactive/theme/theme.js'))).theme;

const { SidebarPanel } = await jiti.import(path.join(SIDEBAR, 'src/panel.ts'));
const { SplitRoot, dividerLines } = await jiti.import(path.join(SIDEBAR, 'src/layout.ts'));
const { DEFAULT_MIN_COLUMNS, DEFAULT_RATIO } = await jiti.import(path.join(SIDEBAR, 'src/config.ts'));

const fill = (text) => ({ render: () => [text], invalidate() {} });

/**
 * One screen: main's layout root is the transcript (growing), then `dock` (a dialog or an editor,
 * given as width => lines), then `footer` (width => lines). Sidebar holds an answered exchange.
 */
export function sidebarScreen({ width, height, dock, footer, collapsed = false, focused = true, open = true }) {
  const tui = { terminal: { rows: height, columns: width }, requestRender() {}, setFocus() {} };
  const host = {
    status: () => [{ text: 'main: working' }],
    submit() {}, confirm() {}, abort() {}, focusMain() {}, focusSidebar() {}, close() {},
    isBusy: () => false,
    matchesToggle: () => false,
    matchesFocusSwitch: () => false,
    toggleLabel: "ctrl+'",
    mainHidesThinking: () => false,
    cwd: ROOT,
  };
  const panel = new SidebarPanel(tui, () => ownTheme, host);
  panel.focused = focused;
  panel.chat.seed([
    { role: 'user', content: [{ type: 'text', text: 'What is main doing?' }], timestamp: 0 },
    { role: 'assistant', content: [{ type: 'text', text: 'It is running the remote-client check over every dialog.' }], api: 'anthropic-messages', provider: 'anthropic', model: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 0 },
  ], (text) => ({ text }));
  const main = new ownTui.VStack([
    { component: fill(' Earlier transcript in main.'), basis: 0, grow: 1, minSize: 1 },
    { component: { render: (w) => dock(w), invalidate() {} }, basis: 'auto' },
    { component: { render: (w) => footer(w), invalidate() {} }, basis: 'auto' },
  ]);
  if (!open) return { lines: terminal(renderLayoutFrame(main, width, height, () => {}).lines), orientation: undefined };
  const root = new SplitRoot(main, panel.root, {
    ratio: () => DEFAULT_RATIO,
    minColumns: DEFAULT_MIN_COLUMNS,
    collapsed: () => collapsed,
    focused: () => focused,
    divider: (orientation, sidebarFocused, w, length) => dividerLines(orientation, w, (t) => ownTheme.fg('borderAccent', t), {
      sidebar: sidebarFocused, length, pointer: (t) => ownTheme.bold(ownTheme.fg('accent', t)),
    }),
  }, () => {});
  // The orientation follows the viewport from the next frame, as in Pi.
  renderLayoutFrame(root, width, height, () => {});
  const frame = renderLayoutFrame(root, width, height, () => {});
  return { lines: terminal(root.dimUnfocused(frame.lines, frame)), orientation: root.orientation };
}

// Pi's cursor markers are APC sequences a terminal never shows; a screen reader never sees them.
const terminal = (lines) => lines.map((line) => line.replace(/\x1b_pi:[^\x07]*\x07/gu, ''));
