// Real next-prompt receipts, ghost/fallback renderers and CustomEditor output over the normal
// footer. The in-memory UI never submits a prompt, executes a shell command or calls a classifier.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { default: nextPrompt } = await jiti.import('../../packages/pi-next-prompt/src/index.ts');
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { CustomEditor } = await import(new URL('./modes/interactive/components/custom-editor.js', sdkUrl));
const CURSOR = '\x1b_pi:c\x07';
const EMPTY_CURSOR = '\x1b[7m \x1b[0m';
const DRAFT = 'Keep my unsent draft';
const plain = lines => stripVTControlCharacters(lines.join('\n').replaceAll(CURSOR, ''));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

/** Idle baseline indices are local to the returned array; the runner offsets them on append. */
export async function nextPromptScreens({ theme, getEditorTheme, kb, sidebarScreen, idleFooter, height }) {
  const screens = [];
  const cwd = mkdtempSync(path.join(tmpdir(), 'pi-client-next-prompt-'));
  mkdirSync(path.join(cwd, '.pi'));
  writeFileSync(path.join(cwd, '.pi/next-prompt.json'), JSON.stringify({
    enabled: true, acceptKeys: ['tab', 'right'], maxChars: 0, jev: { enabled: false },
  }));
  try {
    for (const width of [46, 120, 180]) {
      for (const kind of ['prompt', 'terminal']) {
        for (const cursor of [true, false]) {
          const handlers = new Map();
          const tools = new Map();
          const events = new EventEmitter();
          // Only the shell's read-only availability protocol is needed: no shell is loaded/run.
          events.on('interactive-shell:inspect', ({ reply }) => reply({ available: true, layout: 'inline' }));
          const widgets = new Map();
          const inputs = new Set();
          const writes = [];
          const tui = { terminal: { columns: width, rows: height }, requestRender() {}, getFocusedComponent: () => editor };
          const editor = new CustomEditor(tui, getEditorTheme(), kb, { paddingX: 0 });
          editor.focused = true;
          if (!cursor) {
            // A real editor adapter with no cursor output exercises the extension's own fallback,
            // not a hand-drawn suggestion or substitute composer.
            const render = editor.render.bind(editor);
            editor.render = w => render(w).map(line => line.replaceAll(CURSOR, '').replaceAll(EMPTY_CURSOR, ' '));
          }
          editor.setText(DRAFT);
          const ui = {
            theme,
            getEditorText: () => editor.getExpandedText(),
            setEditorText: text => { writes.push(text); editor.setText(text); },
            setWidget(key, content) {
              if (content === undefined) widgets.delete(key);
              else widgets.set(key, typeof content === 'function' ? content(tui, theme) : { render: () => content });
            },
            onTerminalInput(handler) { inputs.add(handler); return () => inputs.delete(handler); },
            notify(message) { throw new Error(`unexpected next-prompt notification: ${message}`); },
          };
          const ctx = {
            cwd, ui, hasUI: true, mode: 'tui',
            sessionManager: { getBranch: () => [], getSessionId: () => 'client-next-prompt' },
            modelRegistry: { classify() { throw new Error('client fixture must not call a classifier'); } },
          };
          const diagnostics = nextPrompt({
            on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
            registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, events,
          });
          const emit = async (name, event = {}) => {
            for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
          };
          const press = data => {
            for (const handler of inputs) if (handler(data)?.consume) return true;
            editor.handleInput(data);
            return false;
          };
          const dock = w => [...editor.render(w), ...[...widgets.values()].flatMap(widget => widget.render(w))];
          const capture = (state, expectedDraft, expectedComposer = 'draft') => {
            const baseline = screens.length;
            for (const open of [false, true]) {
              const { lines } = sidebarScreen({ width, height, dock, footer: idleFooter, open, focused: false });
              screens.push({
                name: `next-prompt ${kind} ${state}`, width,
                under: open ? 'Sidebar open, main focused' : 'without Sidebar',
                idle: baseline, expectedComposer, expectedDraft, ansi: lines.join('\n'),
              });
            }
          };
          try {
            await emit('session_start');
            await flush(); // Pi wires onChange after attachment; let the observer bind first.
            await emit('agent_start');
            const text = kind === 'prompt' ? '/review  "fixture ready"' : "!i printf '%s'  'fixture ready'";
            const args = kind === 'prompt' ? { text } : { command: text.slice(3) };
            const original = editor.render(width);
            const result = await tools.get(`offer_${kind}`).execute('client-fixture', args, undefined, undefined, ctx);
            assert.equal(result.isError, undefined, 'a draft queues successfully');
            assert.equal(result.details.status, 'queued');
            assert.equal(result.details.text, text, 'queue retains exact quotes/internal whitespace');
            assert.equal(result.details.reason, 'editor contains a draft');
            assert.ok(!('surface' in result.details) && !('acceptAfterTurn' in result.details), 'retention is not a render receipt');
            assert.equal(widgets.size, 0, 'concealed offers mount no widget, including invisible padding rows');
            assert.deepEqual(dock(width), original, 'the queued dock is exactly the original real editor');
            assert.equal(editor.getExpandedText(), DRAFT);
            assert.deepEqual(writes, [], 'queue does not mutate the draft');
            const take = {};
            events.emit('prompt:take-next', take);
            assert.equal(take.text, undefined, 'hidden offers cannot become a stash draft');
            assert.equal(press('\t'), false, 'Tab cannot accept a hidden offer');
            assert.equal(editor.getExpandedText(), DRAFT, 'queued draft remains the sole composer');
            capture(`queued draft (${cursor ? 'cursor' : 'no cursor'})`, DRAFT);

            // Programmatic clearing must reveal through onChange, without a later key dispatch.
            editor.setText('');
            await flush();
            const revealed = dock(width);
            assert.ok(plain(revealed).includes(text), 'actual extension output contains the retained suggestion');
            assert.equal(editor.getExpandedText(), '', 'revealing does not insert text');
            assert.equal(widgets.size, cursor ? 0 : 1, 'only fallback output adds one real widget');
            assert.equal(revealed.length, editor.render(width).length + (cursor ? 0 : 1), 'no hidden rows accompany reveal');
            await flush(); // Only actual ghost/fallback output acknowledges the retained offer.
            assert.equal(diagnostics().ready, true, 'queued offer remains acknowledgeable after its tool returned');
            // Fallback stays outside the real empty editor frame: its draft is '', not a missing frame's null.
            capture(cursor ? 'revealed ghost' : 'revealed no-cursor fallback', cursor ? text : '', cursor ? 'draft' : 'empty');

            // A later draft conceals even the acknowledged offer; clearing reveals it again.
            editor.setText(DRAFT);
            await flush();
            assert.equal(widgets.size, 0);
            assert.ok(!plain(dock(width)).includes(text), 'later drafts suppress both actual surfaces');
            editor.setText('');
            await flush();
            dock(width);
            await flush();
            assert.equal(press('\t'), true, 'actual render acknowledgement allows copying while busy');
            assert.equal(editor.getExpandedText(), text, 'acceptance preserves the full exact suggestion');
            assert.deepEqual(writes, [text], 'acceptance is the only extension editor write');
            assert.equal(widgets.size, 0, 'accepted offers leave no fallback or hidden widget rows');
            capture(`accepted draft (${cursor ? 'cursor' : 'no cursor'})`, text);
          } finally {
            await emit('session_shutdown');
            assert.equal(inputs.size, 0, 'fixture releases its input observer');
          }
        }
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return screens;
}
