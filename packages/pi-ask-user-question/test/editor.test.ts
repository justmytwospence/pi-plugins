import { expect, test } from 'vitest';
import { Editor, getKeybindings } from '@earendil-works/pi-tui';
import { QuestionDialog } from '../src/dialog.ts';
import { embeddedEditorFactory, type ProseEditor } from '../src/editor.ts';
import { fakeTui, plainTheme, q } from './harness.ts';

test('embedded discovery is optional and forwards only local callbacks', () => {
  let options: any;
  const create = embeddedEditorFactory({ events: { emit: (channel: string, request: any) => {
    expect(channel).toBe('pi-plugins.editor-factory.v1');
    request.factory = (input: any) => { options = input; return new Editor(input.tui, input.theme); };
  } } } as any);
  const editor = create(fakeTui(), { borderColor: (s: string) => s, selectList: {} } as any, getKeybindings() as any, () => {}, () => {});
  expect(options.surface).toBe('embedded');
  expect(options.onSubmit).toBeTypeOf('function');
  expect(options.onCancel).toBeTypeOf('function');
  expect(editor.getText()).toBe('');
});

test('first Escape exits modal input, second returns to list, finish disposes editors', () => {
  let disposed = 0;
  let state = 'insert';
  let result: unknown;
  const create: any = (tui: any, theme: any) => {
    const editor = new Editor(tui, theme) as ProseEditor;
    const base = editor.handleInput.bind(editor);
    (editor as any)[Symbol.for('pi-plugins.editor-mode.v1')] = () => ({ state });
    editor.handleInput = data => { if (data === '\x1b') state = 'normal'; else base(data); };
    editor.dispose = () => disposed++;
    return editor;
  };
  const d = new QuestionDialog(fakeTui(), plainTheme, getKeybindings() as any, [q('Why?', 'Why', ['A', 'B'])], r => { result = r; }, undefined, create);
  d.focused = true;
  d.handleInput('n');
  const context = Symbol.for('pi-plugins.input-context.v1');
  expect((d as any)[context]()).toBe('editor');
  d.handleInput('\x1b');
  expect((d as any)[context]()).toBe('editor');
  d.handleInput('\x1b');
  expect((d as any)[context]()).toBe('list');
  expect(result).toBeUndefined();
  d.handleInput('\x1b');
  expect(disposed).toBe(2);
});
