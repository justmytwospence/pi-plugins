// Actual pi-cc-render splash/resource renderers over Pi's real editor and native model/MCP controls.
// Controls are cancelled without selecting anything: no network, model/default changes or MCP writes.
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';
import { Container } from '@earendil-works/pi-tui';

const jiti = createJiti(import.meta.url);
const { renderHeaderLines } = await jiti.import('../../packages/pi-cc-render/src/feature/shell/startup-header.ts');
const { buildModelsSection, buildMcpSection, renderSection } = await jiti.import('../../packages/pi-cc-render/src/feature/shell/startup-resources.ts');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { CustomEditor } = await import(new URL('./modes/interactive/components/custom-editor.js', sdkUrl));
const { ModelSelectorComponent } = await import(new URL('./modes/interactive/components/model-selector.js', sdkUrl));
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdkUrl));
const { McpManagerView, showMcpManager } = await import(new URL('./extensions/mcp/ui.js', sdkUrl));
const { SplitRoot } = await jiti.import('../../packages/pi-sidebar/src/layout.ts');
// Match sidebarScreen's layout engine so its retained main/panel components stay real and stable.
const { renderLayoutFrame } = await import('../../packages/pi-sidebar/node_modules/@earendil-works/pi-tui/dist/layout.js');
const { TuiAltScreen } = await import('../../packages/pi-sidebar/node_modules/@earendil-works/pi-tui/dist/index.js');

class MemoryTerminal {
  constructor(columns, rows) { this.columns = columns; this.rows = rows; this.kittyProtocolActive = false; }
  start(input) { this.input = input; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write() {}
  hideCursor() {}
  showCursor() {}
  send(data) {
    assert.ok(this.input, 'native-control fixture starts the real terminal input dispatcher');
    this.input(data);
  }
}

const snapshot = {
  stage: 'starting', modelLabel: 'Claude Opus', thinkingLevel: 'high', contextWindow: 200_000, usedEstimate: 4700,
  toolDeclarationsKnown: true, mcpOriginsKnown: true,
  sources: [
    { id: 'system', category: 'system', label: 'System', tokens: 1400 },
    { id: 'files', category: 'files', label: 'Files', tokens: 900 },
    { id: 'tools', category: 'tools', label: 'Tools', tokens: 1000 },
    { id: 'mcp:example-docs', category: 'mcp', label: 'example-docs', tokens: 420 },
    { id: 'mcp:example-search', category: 'mcp', label: 'example-search', tokens: 180 },
    { id: 'history', category: 'history', label: 'History', tokens: 800 },
  ],
  caveats: ['Estimated from loaded content; request hooks and provider framing may add tokens.'],
};
const models = buildModelsSection([
  { provider: 'anthropic', id: 'claude-opus-5-5', contextWindow: 200_000 },
  { provider: 'openai', id: 'gpt-6.1', contextWindow: 1_000_000 },
], [{ provider: 'anthropic', id: 'claude-opus-5-5', contextWindow: 200_000 }],
{ provider: 'anthropic', id: 'claude-opus-5-5' });
const mcp = buildMcpSection([
  { name: 'example-docs', level: 'project' }, { name: 'example-search', level: 'project' },
], () => 'connected', () => undefined, () => 2, snapshot);
assert.ok(models && mcp, 'real resource builders must produce models and MCP sections');
const resources = [
  { title: 'Extensions', count: 1, layout: 'grid', category: 'tools', groups: [{ label: 'project', items: ['example-extension'] }] },
  { title: 'Context', count: 1, layout: 'columns', category: 'files', groups: [{ label: 'project', items: ['AGENTS.md'], tokens: [900] }], tokens: 900, contextWindow: snapshot.contextWindow },
  { title: 'Skills', count: 1, layout: 'grid', category: 'skills', groups: [{ label: 'user', items: ['example-skill'], tokens: [120] }], tokens: 120, contextWindow: snapshot.contextWindow },
  { title: 'Prompts', count: 1, layout: 'grid', groups: [{ label: 'project', items: ['/review'] }] },
];

/** The same read-only splash, editor and footer dock in Pi's normal and Sidebar layouts.
 * Idle baseline indices are local to this array; the caller offsets them when appending.
 */
export async function startupSplashScreens({
  theme, getEditorTheme, kb, sidebarScreen, idleFooter, height,
  modelSection = models,
  footerVariants = [{ name: 'default', idleFooter }],
}) {
  const screens = [];
  // Sidebar stacks below main at phone width; leave enough rows for the full listing and dock.
  const splashHeight = Math.max(height, 120);
  // The native header is empty: Extensions precede context-related resources and MCP,
  // which all precede the context map and Models in Pi's startup transcript.
  // The listing stays above either editor or native control dock.
  const transcript = { render: width => [
    ...resources.flatMap(section => [...renderSection(section, width, theme), '']),
    ...renderSection(mcp, width, theme),
    '',
    ...renderHeaderLines(width, theme, snapshot),
    '',
    ...renderSection(modelSection, width, theme),
  ], invalidate() {} };
  for (const width of [46, 120, 180]) {
    const lines = transcript.render(width).map(stripVTControlCharacters);
    const headings = ['Extensions', 'Context', 'Skills', 'Prompts', 'MCP', 'Start', 'Models'];
    const positions = headings.map(heading => lines.findIndex(line => line.includes(heading)));
    assert.match(lines[positions[5]], /Claude Opus:high/u, 'the summary keeps the model and effort');
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])),
      `startup listing follows resources → map → Models at width ${width}: ${JSON.stringify(positions)}`);
    for (const [server, tokens] of [['example-docs', 420], ['example-search', 180]]) {
      const row = lines.find(line => line.includes(server));
      assert.ok(row, `${server} is rendered at width ${width}`);
      assert.match(row, new RegExp(`(?:^|\\s)■\\s+${server}\\s+2 · ~${tokens} tok(?:\\s|$)`, 'u'),
        `${server} has one connected square and both metrics at width ${width}`);
      assert.doesNotMatch(row, /[■□●○◌◆✕]\s+[■□●○◌◆✕]/u,
        `${server} has no duplicate category or status glyph at width ${width}`);
    }
    assert.match(lines[0], /Extensions/u, 'Extensions starts the listing without a leading blank');
    assert.notEqual(lines.at(-1), '', 'Models ends the listing without a trailing blank');
  }
  const sidebarOptions = [
    ['without Sidebar', { open: false }],
    ['Sidebar collapsed', { collapsed: true, focused: false }],
    ['Sidebar expanded, main focused', { focused: false }],
    ['Sidebar expanded, Sidebar focused', { focused: true }],
  ];
  const availableModels = [
    { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus', contextWindow: 200_000 },
    { provider: 'openai', id: 'gpt-6.1', name: 'GPT 6.1', contextWindow: 1_000_000 },
  ];

  for (const { name: footerName, idleFooter: variantFooter, herdrModelCard = false } of footerVariants) {
    for (const width of [46, 120, 180]) {
      // Each width/variant compares only with its own no-Sidebar idle frame, not another footer.
      const baseline = screens.length;
      for (const [under, options] of sidebarOptions) {
        const editorContainer = new Container();
        // Retain the actual panel and layout across opening/cancellation instead of rebuilding a
        // lookalike Sidebar whose focus could not prove restoration. Even the absent case gets a
        // panel fixture, but only mounts main as its root.
        const { fixture: { tui: panelTui, main, panel, settings } } = sidebarScreen({
          width, height: splashHeight, transcript, dock: w => editorContainer.render(w),
          footer: variantFooter, open: true, focused: false,
        });
        const terminal = new MemoryTerminal(width, splashHeight);
        const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
        // Retain Sidebar's real component but delegate its fixture host to the real TUI.
        panelTui.requestRender = () => tui.requestRender();
        panelTui.setFocus = component => tui.setFocus(component);
        panelTui.getFocusedComponent = () => tui.getFocusedComponent();
        const editor = new CustomEditor(tui, getEditorTheme(), kb, { paddingX: 0 });
        editor.setText('next step');
        editorContainer.addChild(editor);
        const originalCollapsed = options.collapsed ?? false;
        let collapsed = originalCollapsed;
        settings.collapsed = () => collapsed;
        settings.focused = () => panel.focused;
        const root = options.open === false ? main : new SplitRoot(main, panel.root, settings, () => {});
        const originalFocus = options.focused ? panel.input : editor;
        tui.setLayoutRoot(root);
        tui.setFocus(originalFocus);
        tui.start();
        try {
          const draft = editor.getExpandedText();
          const cursor = editor.getCursor();
          const sidebarDraft = panel.input.getText();
          const render = () => {
            tui.renderNow();
            renderLayoutFrame(root, width, splashHeight, () => {});
            const frame = renderLayoutFrame(root, width, splashHeight, () => {});
            const drawn = root instanceof SplitRoot ? root.dimUnfocused(frame.lines, frame) : frame.lines;
            // A terminal consumes Pi's APC cursor markers; neither client sees them.
            const lines = drawn.map(line => line.replace(/\x1b_pi:[^\x07]*\x07/gu, ''));
            const text = stripVTControlCharacters(lines.join('\n'));
            assert.match(text, /Start(?:ing context)?/u, 'the real splash remains above the editor or native control');
            assert.match(text, /Models/u, 'model resource rows are on screen');
            assert.match(text, /MCP/u, 'MCP resource rows are on screen');
            assert.equal(text.includes('What is main doing?'), options.open !== false && !collapsed,
              'Sidebar is visible only when the retained split is expanded');
            return { ansi: lines.join('\n'), text };
          };
          const capture = (name, metadata) => {
            const frame = render();
            screens.push({ name: `startup splash + ${name} (${footerName})`, width, under, footerName, ...frame, ...metadata });
            return frame;
          };
          const idle = capture('idle editor', { idle: baseline, splash: 'closed' });
          assert.match(idle.text, /next step/u, 'the real idle editor retains its draft');
          const restored = name => {
            assert.equal(tui.getFocusedComponent(), originalFocus, 'cancellation restores the actual prior focus target');
            assert.equal(editor.focused, originalFocus === editor, 'editor focus matches the restored active half');
            assert.equal(panel.input.focused, originalFocus === panel.input, 'Sidebar input focus is restored');
            assert.equal(collapsed, originalCollapsed, 'cancellation restores prior Sidebar expansion');
            assert.deepEqual(editorContainer.children, [editor], 'cancellation restores the same real editor dock');
            assert.equal(editor.getExpandedText(), draft, 'cancellation preserves the unsent draft');
            assert.deepEqual(editor.getCursor(), cursor, 'cancellation preserves the editor cursor');
            assert.equal(panel.input.getText(), sidebarDraft, 'cancellation preserves the Sidebar draft');
            const frame = capture(`editor after ${name}`, { idle: baseline, splash: 'closed' });
            assert.equal(frame.text, idle.text, 'restoration renders the original idle screen');
            terminal.send('x');
            assert.equal(editor.getExpandedText(), originalFocus === editor ? `${draft}x` : draft, 'terminal input resumes only in the restored main editor');
            assert.equal(panel.input.getText(), originalFocus === panel.input ? `${sidebarDraft}x` : sidebarDraft, 'terminal input resumes only in the restored Sidebar input');
            terminal.send('\x7f');
            assert.equal(editor.getExpandedText(), draft, 'input-routing probe preserves main draft');
            assert.equal(panel.input.getText(), sidebarDraft, 'input-routing probe preserves Sidebar draft');
          };
          const suspend = () => {
            // Model native-prompt suspension like the controller: full-width main during the UI,
            // then the same requested split/focus. This is a renderer fixture, not a controller test.
            collapsed = true;
            return () => {
              assert.equal(tui.getFocusedComponent(), editor, 'native cancellation first restores Pi’s editor focus');
              collapsed = originalCollapsed;
              tui.setFocus(originalFocus);
            };
          };
          const nativeFrame = (control, component, name, visible) => {
            assert.equal(tui.getFocusedComponent(), component, 'the native control temporarily owns focus');
            assert.equal(component.focused, true, 'the native control receives actual focus');
            assert.equal(editor.focused, false, 'the main editor cannot receive native-control input');
            assert.equal(panel.input.focused, false, 'Sidebar cannot receive native-control input');
            assert.deepEqual(editorContainer.children, [component], 'native controls replace, not overlay, the editor dock');
            const frame = capture(name, {
              nativeControl: control, splash: control === 'mcp' ? 'manager' : 'model',
              ...(control === 'model' && herdrModelCard ? { herdrNative: {
                question: 'Select model (currently claude-opus-5-5 [anthropic])', multi: false,
                options: ['claude-opus-5-5 [anthropic] · default', 'gpt-6.1 [openai]'],
              } } : {}),
            });
            assert.match(frame.text, visible, 'the real native control is visible');
            assert.doesNotMatch(frame.text, /next step/u, 'the editor draft is absent while native controls own the dock');
          };

          const resumeModel = suspend();
          let selector;
          // Only the local catalog is exposed. The real selector refreshes it on construction, but
          // neither selection nor saving a default is permitted and no provider can be contacted.
          const modelRuntime = {
            getAvailableSnapshot: () => availableModels,
            getModel: (provider, id) => availableModels.find(model => model.provider === provider && model.id === id),
            getError: () => undefined,
            refresh: async () => ({ errors: new Map(), aborted: false }),
          };
          const selectorHost = {
            editor, editorContainer, ui: tui, keybindings: kb,
            disposeActiveSelector: InteractiveMode.prototype.disposeActiveSelector,
          };
          InteractiveMode.prototype.showSelector.call(selectorHost, done => {
            selector = new ModelSelectorComponent(tui, availableModels[0], modelRuntime, [],
              () => assert.fail('the model fixture must never select a model'),
              () => { done(); tui.requestRender(); }, undefined,
              () => assert.fail('the model fixture must never save a default'), availableModels[0]);
            return { component: selector, focus: selector, dispose: () => selector.dispose() };
          });
          try {
            assert.ok(selector instanceof ModelSelectorComponent, '/model must use Pi’s native selector');
            // Let its local refresh settle, including the shared refresh coordinator, before capture.
            await new Promise(resolve => setImmediate(resolve));
            nativeFrame('model', selector, 'native model selector', /Model Name: Claude Opus/u);
            terminal.send('\x1b[B');
            terminal.send('\x1b[A');
            terminal.send('\x1b');
            resumeModel();
            restored('model selector');
          } finally {
            selector.dispose();
          }

          const resumeMcp = suspend();
          let manager;
          const opened = showMcpManager({ ui: {
            custom: factory => InteractiveMode.prototype.showExtensionCustom.call(selectorHost, (nativeTui, nativeTheme, nativeKb, done) => {
              manager = factory(nativeTui, nativeTheme, nativeKb, done);
              assert.ok(manager instanceof McpManagerView, '/mcp must use Pi’s native manager');
              return manager;
            }),
            notify: message => assert.fail(message),
          } }, async view => {
            // The first native /mcp menu uses these same fields; no action is selected or persisted.
            const choice = await view.menu(() => ({
              title: 'MCP servers',
              items: [
                { value: 'example-docs', label: 'example-docs', description: 'connected · tools · project' },
                { value: 'example-search', label: 'example-search', description: 'connected · tools · project' },
              ],
              confirmLabel: 'manage', cancelLabel: 'close',
            }));
            assert.equal(choice, undefined, 'the MCP fixture cancels without managing a server');
          });
          await new Promise(resolve => setImmediate(resolve));
          nativeFrame('mcp', manager, 'native MCP manager', /MCP servers/u);
          terminal.send('\x1b[B');
          terminal.send('\x1b[A');
          terminal.send('\x1b');
          await opened;
          resumeMcp();
          restored('MCP manager');
        } finally {
          panel.dispose();
          editor.dispose?.();
          tui.stop({ preserveScreen: true });
        }
      }
    }
  }
  return screens;
}
