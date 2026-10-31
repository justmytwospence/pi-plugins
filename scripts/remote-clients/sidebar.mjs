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
const { SplitRoot, SplitLayout, dividerLines } = await jiti.import(path.join(SIDEBAR, 'src/layout.ts'));
const { FamilyViewHost } = await jiti.import(path.join(SIDEBAR, 'src/family/view-host.ts'));
const { DEFAULT_MIN_COLUMNS, DEFAULT_RATIO } = await jiti.import(path.join(SIDEBAR, 'src/config.ts'));

const fill = (text) => ({ render: () => [text], invalidate() {} });

/**
 * One screen: main's layout root is the transcript (growing), then `dock` (a dialog or an editor,
 * given as width => lines), then `footer` (width => lines). `transcript` may supply a real message
 * component ahead of the dock. Sidebar holds an answered exchange.
 */
export function sidebarScreen({ width, height, dock, footer, transcript = fill(' Earlier transcript in main.'), collapsed = false, focused = true, open = true }) {
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
    { component: transcript, basis: 0, grow: 1, minSize: 1 },
    { component: { render: (w) => dock(w), invalidate() {} }, basis: 'auto' },
    { component: { render: (w) => footer(w), invalidate() {} }, basis: 'auto' },
  ]);
  if (!open) return { lines: terminal(renderLayoutFrame(main, width, height, () => {}).lines), orientation: undefined };
  const settings = {
    ratio: () => DEFAULT_RATIO,
    minColumns: DEFAULT_MIN_COLUMNS,
    collapsed: () => collapsed,
    focused: () => focused,
    divider: (orientation, sidebarFocused, w, length) => dividerLines(orientation, w, (t) => ownTheme.fg('borderAccent', t), {
      sidebar: sidebarFocused, length, pointer: (t) => ownTheme.bold(ownTheme.fg('accent', t)),
    }),
  };
  const root = new SplitRoot(main, panel.root, settings, () => {});
  // Exercise the layout engine twice, as Pi does across initial render and invalidation.
  renderLayoutFrame(root, width, height, () => {});
  const frame = renderLayoutFrame(root, width, height, () => {});
  return { lines: terminal(root.dimUnfocused(frame.lines, frame)), orientation: root.orientation,
    fixture: { tui, main, panel, settings } };
}

/** Real hosted lifecycle screens. Read-only child/planner/scout fixtures intentionally have no
 * main composer; a phone must never type into Sidebar's draft as if it were main's editor.
 * Native dialogs use the supplied real Pi dock, not a lookalike question.
 */
export async function sidebarFamilyScreens(options) {
  const { fixture: { tui, main, panel, settings } } = sidebarScreen(options);
  let focus = null;
  tui.layoutRoot = main;
  tui.setLayoutRoot = root => { tui.layoutRoot = root; };
  tui.setFocus = component => { focus = component; };
  tui.getFocusedComponent = () => focus;
  const host = new FamilyViewHost(tui, ownTheme, new ownKeybindings.KeybindingsManager({}));
  const split = new SplitLayout(tui, panel.root, settings);
  host.mountSplit(split);
  const render = () => {
    renderLayoutFrame(tui.layoutRoot, options.width, options.height, () => {});
    const frame = renderLayoutFrame(tui.layoutRoot, options.width, options.height, () => {});
    const lines = tui.layoutRoot instanceof SplitRoot ? tui.layoutRoot.dimUnfocused(frame.lines, frame) : frame.lines;
    return terminal(lines);
  };
  let done;
  const closed = host.view({ factory: (_tui, _theme, _kb, finish, viewport) => {
    done = finish;
    const text = new ownTui.Text(`${options.label}\nRead-only enrolled-agent transcript.`, 0, 0);
    return {
      render(width) {
        const lines = text.render(width);
        return [...lines, ...Array.from({ length: Math.max(0, viewport().height - lines.length) }, () => '')];
      },
      invalidate() { text.invalidate(); },
    };
  } });
  await Promise.resolve();
  const hosted = render();
  host.unmountSplit();
  const expanded = render();
  host.mountSplit(split);
  const localRestore = host.suspend('local');
  const local = render();
  localRestore();
  const nativeRestore = host.suspend('native');
  const native = render();
  nativeRestore();
  const restored = render();
  done();
  await closed;
  const returned = render();
  host.dispose();
  return { hosted, expanded, local, native, restored, returned };
}

// Pi's cursor markers are APC sequences a terminal never shows; a screen reader never sees them.
const terminal = (lines) => lines.map((line) => line.replace(/\x1b_pi:[^\x07]*\x07/gu, ''));
