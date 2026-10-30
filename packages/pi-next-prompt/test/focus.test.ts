import { mkdtempSync } from 'node:fs';
import { expect, test } from 'vitest';
import nextPrompt from '../src/index.ts';
import { harness } from './harness.ts';
const SURFACE = Symbol.for('pi-plugins.editor-surface.v1');

async function offered() {
  const h = harness();
  nextPrompt(h.pi);
  const ctx = h.ctx({ cwd: mkdtempSync('/tmp/next-focus-'), modelRegistry: undefined });
  let focused: any = { [SURFACE]: 'main', getText: () => ctx.ui.editorText, render: () => [], isShowingAutocomplete: () => false };
  const main = focused;
  const tui = { getFocusedComponent: () => focused, requestRender() {}, terminal: { columns: 80 } };
  ctx.ui.setWidget = (key: string, content: any) => {
    if (typeof content === 'function') content(tui, { fg: (_: string, s: string) => s });
    if (content === undefined) ctx.ui.widgets.delete(key);
    else ctx.ui.widgets.set(key, { content });
  };
  await h.emit('session_start', {}, ctx);
  await h.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n<next>Run tests</next>' }] } }, ctx);
  await h.emit('agent_before_settle', { outcome: 'completed' }, ctx);
  await h.emit('agent_settled', {}, ctx);
  return { h, ctx, main, focus: (value: any) => { focused = value; } };
}

test('a modal never accepts into an empty main draft', async () => {
  const { h, ctx, focus } = await offered();
  focus({ render: () => [] });
  await h.commands.get('next-prompt').handler('status', ctx);
  expect(ctx.ui.notes.at(-1).message).toContain('Focus: not main editor; editor: empty');
  expect(ctx.ui.notes.at(-1).message).toContain('vet unavailable (shown)');
  expect(ctx.ui.press('\t')).toBe(false);
  expect(ctx.ui.editorText).toBe('');
});
test('embedded editors and autocomplete retain acceptance keys', async () => {
  for (const embedded of [true, false]) {
    const { h, ctx, main, focus } = await offered();
    if (embedded) focus({ ...main, [SURFACE]: 'embedded' });
    else main.isShowingAutocomplete = () => true;
    await h.commands.get('next-prompt').handler('status', ctx);
    expect(ctx.ui.notes.at(-1).message).toContain(`Focus: ${embedded ? 'embedded editor' : 'autocomplete'}; editor: empty`);
    expect(ctx.ui.press('\t')).toBe(false);
    expect(ctx.ui.editorText).toBe('');
  }
});
test('EX, Visual and pending Normal operations own acceptance keys', async () => {
  for (const state of ['ex', 'visual', 'pending']) {
    const { h, ctx, main } = await offered();
    main[Symbol.for('pi-plugins.editor-mode.v1')] = () => ({ state });
    await h.commands.get('next-prompt').handler('status', ctx);
    expect(ctx.ui.notes.at(-1).message).toContain(`Focus: editor mode; editor: empty`);
    expect(ctx.ui.press('\t')).toBe(false);
    expect(ctx.ui.editorText).toBe('');
  }
});

test('tree navigation invalidates a late classifier response and its status', async () => {
  const h = harness(); nextPrompt(h.pi);
  let finish: (value: any) => void = () => {};
  const response = new Promise(resolve => { finish = resolve; });
  const ctx = h.ctx({ cwd: mkdtempSync('/tmp/next-late-'), modelRegistry: { findOfType: () => ({}), classify: () => response } });
  await h.emit('session_start', {}, ctx);
  await h.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done.\n<next>Run tests</next>' }] } }, ctx);
  await h.emit('agent_before_settle', { outcome: 'completed' }, ctx);
  const settle = h.emit('agent_settled', {}, ctx);
  await h.emit('session_tree', {}, ctx);
  finish({ model: 'fake', stopReason: 'stop', answers: { useful: { type: 'bool', probability: 1 } } });
  await settle;
  expect(ctx.ui.widgets.size).toBe(0);
  await h.commands.get('next-prompt').handler('status', ctx);
  expect(ctx.ui.notes.at(-1).message).toContain('none yet');
});

test('RPC hasUI is not terminal UI', async () => {
  const h = harness(); nextPrompt(h.pi);
  const ctx = h.ctx({ mode: 'rpc', hasUI: true });
  await h.emit('session_start', {}, ctx);
  const options = { sections: {} };
  await h.emit('before_agent_start', { prompt: 'x', systemPromptOptions: options }, ctx);
  expect(options.sections).toEqual({});
  expect(ctx.ui.inputHandlers).toHaveLength(0);
  await h.commands.get('next-prompt').handler('status', ctx);
  expect(ctx.ui.notes.at(-1).message).toContain('instruction not injected (not terminal UI (rpc))');
  expect(ctx.ui.notes.at(-1).message).toContain('UI: not terminal UI (rpc)');
});

test('status reports unavailable focus inspection distinctly from model omission', async () => {
  const h = harness(); nextPrompt(h.pi);
  const ctx = h.ctx({ cwd: mkdtempSync('/tmp/next-no-focus-') });
  ctx.ui.setWidget = (key: string, content: any) => {
    if (typeof content === 'function') content({ requestRender() {} }, {});
    if (content === undefined) ctx.ui.widgets.delete(key);
  };
  await h.emit('session_start', {}, ctx);
  const options = { sections: {} };
  await h.emit('before_agent_start', { prompt: 'x', systemPromptOptions: options }, ctx);
  await h.commands.get('next-prompt').handler('status', ctx);
  expect(options.sections).toEqual({});
  expect(ctx.ui.notes.at(-1).message).toContain('instruction not injected (focus inspection unavailable)');
  expect(ctx.ui.notes.at(-1).message).toContain('none yet');
  expect(ctx.ui.inputHandlers).toHaveLength(0);
});
