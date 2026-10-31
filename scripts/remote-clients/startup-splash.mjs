// Actual pi-cc-render splash/resource renderers over Pi's real editor and native MCP manager view.
// The manager is opened only to its first menu and cancelled: this fixture never changes MCP config.
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';
import { Container } from '@earendil-works/pi-tui';

const jiti = createJiti(import.meta.url);
const { renderHeaderLines } = await jiti.import('../../packages/pi-cc-render/src/feature/shell/startup-header.ts');
const { buildModelsSection, buildMcpSection, renderSection } = await jiti.import('../../packages/pi-cc-render/src/feature/shell/startup-resources.ts');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { CustomEditor } = await import(new URL('./modes/interactive/components/custom-editor.js', sdkUrl));
const { McpManagerView, showMcpManager } = await import(new URL('./extensions/mcp/ui.js', sdkUrl));

const snapshot = {
  stage: 'starting', modelLabel: 'Claude Opus', contextWindow: 200_000, usedEstimate: 4100,
  sources: [
    { id: 'system', category: 'system', label: 'System', tokens: 1400 },
    { id: 'files', category: 'files', label: 'Files', tokens: 900 },
    { id: 'tools', category: 'tools', label: 'Tools', tokens: 1000 },
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
], () => 'connected', () => undefined, () => 2);
assert.ok(models && mcp, 'real resource builders must produce models and MCP sections');
const resources = [
  { title: 'Context', count: 1, layout: 'columns', category: 'files', groups: [{ label: 'project', items: ['AGENTS.md'], tokens: [900] }], tokens: 900, contextWindow: snapshot.contextWindow },
  { title: 'Skills', count: 1, layout: 'grid', category: 'skills', groups: [{ label: 'user', items: ['example-skill'], tokens: [120] }], tokens: 120, contextWindow: snapshot.contextWindow },
  { title: 'Prompts', count: 1, layout: 'grid', groups: [{ label: 'project', items: ['/review'] }] },
  { title: 'Extensions', count: 1, layout: 'grid', category: 'tools', groups: [{ label: 'project', items: ['example-extension'] }] },
];

/** The same read-only splash, editor and footer dock in Pi's normal and Sidebar layouts. */
export async function startupSplashScreens({ theme, getEditorTheme, kb, sidebarScreen, idleFooter, height }) {
  const screens = [];
  // Sidebar stacks below main at phone width; leave enough rows for the full listing and dock.
  const splashHeight = Math.max(height, 120);
  const tui = { terminal: { rows: splashHeight, columns: 180 }, requestRender() {} };
  const editor = new CustomEditor(tui, getEditorTheme(), kb, { paddingX: 0 });
  editor.setText('next step');
  let focused = editor;
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const managerTui = { ...tui, setFocus: component => { focused = component; }, getFocusedComponent: () => focused };
  // The native header is empty: Pi's startup listing owns Models, followed by the context map
  // and the remaining resources in the transcript, above either dock.
  const transcript = { render: width => [
    ...renderSection(models, width, theme),
    ...renderHeaderLines(width, theme, snapshot),
    ...resources.flatMap(section => renderSection(section, width, theme)),
    ...renderSection(mcp, width, theme),
  ], invalidate() {} };
  for (const width of [46, 120, 180]) {
    const lines = transcript.render(width).map(stripVTControlCharacters);
    const headings = ['Models', 'Starting context', 'Context', 'Skills', 'Prompts', 'Extensions', 'MCP'];
    const positions = headings.map(heading => lines.findIndex(line => line.includes(heading)));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])),
      `startup listing follows Models → map → resources at width ${width}: ${JSON.stringify(positions)}`);
  }
  const sidebarOptions = [
    ['without Sidebar', { open: false }],
    ['Sidebar open, main focused', { focused: false }],
    ['Sidebar open, Sidebar focused', { focused: true }],
  ];
  const render = (width, dock, options) => {
    const { lines } = sidebarScreen({ width, height: splashHeight, transcript, dock, footer: idleFooter, ...options });
    const text = stripVTControlCharacters(lines.join('\n'));
    assert.match(text, /Starting context/u, 'the real splash remains above the editor or MCP manager');
    assert.match(text, /Models/u, 'model resource rows are on screen');
    assert.match(text, /MCP/u, 'MCP resource rows are on screen');
    return { ansi: lines.join('\n'), text };
  };

  for (const width of [46, 120, 180]) {
    tui.terminal.columns = width;
    const closed = sidebarOptions.map(([under, options]) => ({
      name: 'startup splash + idle editor', width, under,
      ...render(width, w => editorContainer.render(w), options),
    }));
    for (const frame of closed) assert.match(frame.text, /next step/u, 'the real idle editor retains its draft');
    const baseline = screens.length;
    screens.push(...closed.map(frame => ({ ...frame, idle: baseline, splash: 'closed' })));

    let manager;
    let close;
    const opened = showMcpManager({ ui: {
      custom: factory => new Promise(resolve => {
        const done = () => {
          editorContainer.clear();
          editorContainer.addChild(editor);
          focused = editor;
          resolve();
        };
        manager = factory(managerTui, theme, kb, done);
        assert.ok(manager instanceof McpManagerView, '/mcp must use Pi’s native manager');
        editorContainer.clear();
        editorContainer.addChild(manager);
        focused = manager;
        manager.focused = true;
        close = () => manager.handleInput('\x1b');
      }),
      notify: message => assert.fail(message),
    } }, async view => {
      // The first native /mcp menu uses these same fields; no action is selected or persisted.
      await view.menu(() => ({
        title: 'MCP servers',
        items: [
          { value: 'example-docs', label: 'example-docs', description: 'connected · tools · project' },
          { value: 'example-search', label: 'example-search', description: 'connected · tools · project' },
        ],
        confirmLabel: 'manage', cancelLabel: 'close',
      }));
    });
    assert.equal(focused, manager, 'the native manager temporarily owns focus');
    assert.equal(editorContainer.children.includes(editor), false, 'the manager replaces, not overlays, the editor dock');
    for (const [under, options] of sidebarOptions) {
      const frame = render(width, w => editorContainer.render(w), options);
      assert.match(frame.text, /MCP servers/u, 'the native manager is visible');
      assert.doesNotMatch(frame.text, /next step/u, 'the draft is hidden while the manager owns the dock');
      screens.push({ name: 'startup splash + native MCP manager', width, under, ...frame, splash: 'manager' });
    }
    close();
    await opened;
    assert.equal(focused, editor, 'cancelling native MCP controls restores editor focus');
    assert.deepEqual(editorContainer.children, [editor], 'cancelling restores the real editor dock');
    assert.equal(editor.getExpandedText(), 'next step', 'cancelling preserves the unsent draft');
    for (const [under, options] of sidebarOptions) {
      screens.push({ name: 'startup splash + editor after MCP manager', width, under,
        ...render(width, w => editorContainer.render(w), options), idle: baseline, splash: 'closed' });
    }
  }
  return screens;
}
