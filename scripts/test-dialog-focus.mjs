// Real SDK terminal dispatch, dialog stacks, FamilyViewHost, Fleet and SessionView.
// Only terminal transport and session-independent fixture data are in memory. This does
// not exercise child processes or pretend to be a complete AgentSession lifecycle test.
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDialogFixture, bounded, waitFor, observeInput, plain, KEY,
  MAIN_DRAFT, CHILD_DRAFT, SIDEBAR_DRAFT, CHOICE, QUESTION } from './lib/dialog-focus-fixture.mjs';

const { enter: ENTER, escape: ESCAPE } = KEY;
const marker = { select: 'Native select focus?', confirm: 'Native confirm focus?', input: 'Native input focus?',
  editor: 'Native editor focus?', question: QUESTION.question, approval: 'Allow bash printf focus?' };
function answer(kind, result) {
  if (kind === 'select') assert.equal(result, CHOICE);
  else if (kind === 'confirm') assert.equal(result, true);
  else if (kind === 'question') assert.deepEqual(result, { cancelled: false,
    answers: [{ index: 0, header: QUESTION.header, question: QUESTION.question, kind: 'option', answer: CHOICE }] });
  else if (kind === 'approval') assert.deepEqual(result, { choice: 'Allow once' });
  else assert.equal(result, 'Dialog answer');
}
async function visibleDialog(f, kind, starts = 1) {
  await waitFor('real prompt-start dispatch and dialog installation', () => f.state.starts === starts && f.dialogs.length > 0);
  const dialog = f.dialogs.at(-1).component;
  assert.equal(f.tui.getFocusedComponent(), dialog, 'the visible dialog must actually own input');
  assert.ok(plain(f.snapshot()).includes(marker[kind]), `visible ${kind} dialog, not a covering viewer`);
  assert.equal(f.state.footerBlocked, true);
  assert.equal(f.host.suspended, true);
  assert.equal(f.layout.mounted, false);
  assert.equal(f.tui.layoutRoot, f.root, 'native dialog must use its real editor dock');
  return dialog;
}

// Retain all 96 original cases (both handler orders, widths, split states, primary owners,
// and select/confirm/QuestionDialog/ApprovalDialog), now using the shared fixture.
async function testPrompt({ width, open, primary, footerFirst, kind }) {
  const f = await createDialogFixture({ width, handlerOrder: footerFirst ? 'footer-first' : 'sidebar-first' });
  const { fleet, host, layout, editor, tui, state, mode } = f;
  const primaryInputs = [];
  let primaryDisposals = 0, primaryDone, primaryClosed;
  const activePrimary = { focused: false, render: () => ['Active family primary view'], invalidate() {},
    handleInput: data => primaryInputs.push(data), dispose: () => { primaryDisposals++; } };
  try {
    const selectFleet = () => {
      f.send(KEY.down);
      const widget = mode.extensionWidgetsBelow.get('subagents-fleet');
      assert.ok(widget, 'real Fleet widget must be mounted');
      assert.match(plain(widget.render(width)), /● Actionable Fleet target/u, 'Fleet must really be preselected');
    };
    selectFleet(); f.send(ENTER);
    await waitFor('Fleet positive control', () => state.fleetOpens === 1 && !fleet.viewer);
    selectFleet();
    assert.equal(state.mainSubmits, 0);
    assert.deepEqual(f.mainInputs, [], 'Fleet consumes navigation/Enter before main');
    assert.equal(host.mountSplit(layout), true);
    if (!open) host.unmountSplit();
    assert.equal(host.sidebarRequestedOpen, open);
    if (primary) {
      primaryClosed = host.view({ factory: (_tui, _theme, _kb, done) => { primaryDone = done; return activePrimary; } });
      await waitFor('active primary installed', () => tui.getFocusedComponent() === activePrimary);
    }
    const expectedPrimary = primary ? activePrimary : f.root;
    assert.equal(host.currentPrimary, expectedPrimary);
    const prompt = f.prompt(kind);
    let resolutions = 0;
    void prompt.then(() => { resolutions++; }, () => {});
    const dialog = await visibleDialog(f, kind);
    assert.equal(dialog.constructor.name, { select: 'ExtensionSelectorComponent', confirm: 'ExtensionSelectorComponent',
      question: 'QuestionDialog', approval: 'ApprovalDialog' }[kind], 'actual dialog, not a fallback or substitute');
    if (footerFirst) assert.equal(state.startFocus, dialog, 'late Sidebar start must preserve installed dialog focus');
    assert.equal(resolutions, 0);
    const dialogInputs = observeInput(dialog);
    f.send(ENTER);
    await nextTurn();
    assert.equal(state.fleetOpens, 1);
    assert.deepEqual(f.mainInputs, []);
    assert.deepEqual(primaryInputs, []);
    assert.deepEqual(dialogInputs, [ENTER], 'exactly the dialog receives Enter');
    answer(kind, await bounded('dialog answer', prompt));
    await waitFor('real prompt-end dispatch', () => state.ends === 1 && !state.footerBlocked);
    assert.equal(resolutions, 1);
    assert.equal(state.mainSubmits, 0);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.trace, footerFirst
      ? ['footer:start', 'sidebar:start', 'footer:end', 'sidebar:end']
      : ['sidebar:start', 'footer:start', 'sidebar:end', 'footer:end']);
    assert.deepEqual(state.events.map(({ type, kind, reason }) => ({ type, kind, reason })), [
      { type: 'ui_prompt_start', kind: ['question', 'approval'].includes(kind) ? 'custom' : kind, reason: 'ui_prompt' },
      { type: 'ui_prompt_end', kind: ['question', 'approval'].includes(kind) ? 'custom' : kind, reason: 'ui_prompt' },
    ]);
    assert.equal(mode.extensionDialogs.length, 0);
    assert.deepEqual(mode.editorContainer.children, [editor]);
    assert.equal(state.endFocus, editor);
    assert.equal(host.suspended, false);
    assert.equal(host.currentPrimary, expectedPrimary);
    assert.equal(layout.mounted, open);
    assert.equal(host.sidebarRequestedOpen, open);
    const expectedFocus = primary ? activePrimary : editor;
    assert.notEqual(tui.getFocusedComponent(), dialog);
    assert.equal(tui.getFocusedComponent(), expectedFocus);
    assert.equal(editor.getText(), MAIN_DRAFT);
    assert.equal(primaryDisposals, 0);
    f.send('z'); await nextTurn();
    assert.deepEqual(dialogInputs, [ENTER]);
    assert.equal(tui.getFocusedComponent(), expectedFocus);
    assert.deepEqual(f.mainInputs, primary ? [] : ['z']);
    assert.deepEqual(primaryInputs, primary ? ['z'] : []);
    assert.equal(editor.getText(), primary ? MAIN_DRAFT : `${MAIN_DRAFT}z`);
    assert.equal(state.fleetOpens, 1);
  } finally {
    primaryDone?.();
    if (primaryClosed) await bounded('primary cleanup', primaryClosed);
    await f.dispose();
  }
}

async function testViewerPrompts({ sdkVersion, hosted, handlerOrder }) {
  const f = await createDialogFixture({ sdkVersion, sidebarOpen: hosted, handlerOrder, awaitedHandler: true });
  try {
    const { view, closed, inputs } = await f.openView({ hosted });
    assert.equal(f.runner.uiPromptDepth, 0, 'long-lived viewer must NOT hold runner prompt depth');
    assert.equal(f.state.starts, 0, 'opening a viewer is not a native prompt');
    f.send(KEY.pageUp);
    const scroll = view.scrollTop;
    inputs.length = 0;
    for (const [index, kind] of ['select', 'confirm', 'input', 'editor', 'question', 'approval'].entries()) {
      const prompt = f.prompt(kind);
      const dialog = await visibleDialog(f, kind, index + 1);
      const dialogInputs = observeInput(dialog);
      assert.equal(f.runner.uiPromptDepth, 1);
      const keys = ['input', 'editor'].includes(kind) ? ['Dialog answer', ENTER] : [ENTER];
      f.send(...keys);
      answer(kind, await bounded(`${kind} answer`, prompt));
      await waitFor('prompt restored', () => f.state.ends === index + 1);
      assert.deepEqual(dialogInputs, keys, 'dialog receives exactly the terminal keys once');
      assert.deepEqual(inputs, [], 'neither answer nor text may reach the hidden viewer');
      assert.deepEqual(f.mainInputs, [], 'main must not receive a dialog answer');
      assert.equal(f.state.fleetOpens, 0);
      assert.equal(f.runner.uiPromptDepth, 0);
      assert.equal(f.tui.getFocusedComponent(), view, 'restore same live SessionView, not a reconstruction');
      assert.equal(view.composer.getText(), CHILD_DRAFT);
      f.frame();
      assert.equal(view.scrollTop, scroll, 'dialog suspension preserves scroll');
      assert.equal(f.editor.getText(), MAIN_DRAFT);
      assert.equal(f.panel.input.getText(), SIDEBAR_DRAFT);
      assert.ok(plain(f.snapshot()).includes(CHILD_DRAFT));
      assert.equal(f.dialogs.length, 0);
    }
    assert.equal(f.state.starts, 6, 'successive native dialogs each emit their own lifecycle pair');
    assert.equal(f.state.ends, 6);
    assert.deepEqual(f.state.errors, []);
    f.send(ESCAPE); await bounded('viewer close', closed);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.editor.getText(), MAIN_DRAFT);
    // Draft retention must survive disposal, not just a temporary hide.
    const reopened = await f.openView({ hosted, run: view.current, draft: '' });
    assert.equal(reopened.view.composer.getText(), CHILD_DRAFT);
    f.send(ESCAPE); await bounded('reopened viewer close', reopened.closed);
  } finally { await f.dispose(); }
}

async function testHostedPaging({ sdkVersion, width, sidebarOpen, running, vim = false, stableProxy = false }) {
  const f = await createDialogFixture({ sdkVersion, width, sidebarOpen, stableProxy, vim });
  try {
    const { view, closed } = await f.openView({ hosted: true, status: running ? 'running' : 'done' });
    const native = f.renderer.viewportTop;
    const bottom = view.scrollTop;
    const page = f.kb.matches(KEY.pageUp, 'tui.altScreen.halfPageUp')
      ? Math.max(1, Math.floor(view.lastViewport / 2)) : Math.max(1, view.lastViewport - 1);
    assert.equal(f.kb.matches(KEY.pageUp, 'tui.altScreen.pageUp') || f.kb.matches(KEY.pageUp, 'tui.altScreen.halfPageUp'), true);
    assert.ok(bottom > page, 'long transcript must really overflow the hosted viewport');
    f.send(KEY.pageUp);
    assert.equal(view.scrollTop, bottom - page, 'native fullscreen handler must defer PageUp to exact hosted view');
    f.send(KEY.pageDown); assert.equal(view.scrollTop, bottom);
    f.send(KEY.top); assert.equal(view.scrollTop, 0);
    f.send(KEY.bottom); assert.equal(view.scrollTop, bottom);
    assert.equal(f.renderer.viewportTop, native, 'paging child must not scroll underlying main');
    // The lease must not globally disable fullscreen scrolling for other focus owners.
    f.tui.setFocus(f.editor);
    assert.equal(f.renderer.shouldDeferViewportInputToOverlay(), false);
    f.tui.setFocus(f.panel.input);
    assert.equal(f.renderer.shouldDeferViewportInputToOverlay(), false);
    const paused = view.scrollTop;
    f.send(KEY.pageUp);
    assert.equal(view.scrollTop, paused, 'Sidebar focus cannot scroll a child');
    f.tui.setFocus(view);
    assert.equal(f.renderer.shouldDeferViewportInputToOverlay(), true);
    assert.equal(f.editor.getText(), MAIN_DRAFT);
    assert.equal(f.panel.input.getText(), SIDEBAR_DRAFT);
    if (running) assert.equal(view.composer.getText(), CHILD_DRAFT);
    if (vim && running) f.send(ESCAPE); // Insert -> Normal is local, not return-to-main.
    f.send(ESCAPE); await bounded('hosted close', closed);
    assert.equal(Object.hasOwn(f.renderer, 'shouldDeferViewportInputToOverlay'), false, 'release the renderer lease');
    assert.equal(f.tui.getFocusedComponent(), f.editor);
  } finally { await f.dispose(); }
}

async function testSuspendedClose(sdkVersion, operation) {
  const f = await createDialogFixture({ sdkVersion });
  try {
    const { view, closed } = await f.openView();
    const prompt = f.prompt('select');
    const dialog = await visibleDialog(f, 'select');
    const inputs = observeInput(dialog);
    if (operation === 'close') f.fleet.viewer.close();
    else if (operation === 'shutdown') f.fleet.dispose();
    else f.fleet.setUI({ ...f.ui });
    await bounded('close while suspended', closed);
    assert.equal(view.disposed, true);
    assert.equal(f.tui.getFocusedComponent(), dialog, 'closing a suspended view must not take dialog focus');
    f.send(ENTER); answer('select', await prompt);
    await waitFor('prompt end after close', () => f.state.ends === 1);
    f.fleet.update(); f.frame();
    assert.deepEqual(inputs, [ENTER]);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.renderer.overlayStack.some(entry => entry.component === view), false);
    assert.equal(f.editor.getText(), MAIN_DRAFT);
    assert.deepEqual(f.state.errors, []);
  } finally { await f.dispose(); }
}

async function testBlockedOverlays(sdkVersion) {
  const f = await createDialogFixture({ sdkVersion });
  let capturing, passive;
  try {
    // Cancellation before initial installation: closing must already be available, and a
    // later unblock must not install a stale reservation for even one frame.
    f.fleet.setBlocked('pending', true);
    const pending = f.track(f.fleet.show(f.ui, f.makeRun()));
    assert.ok(f.fleet.viewer.close, 'deferred installation must expose cancellation immediately');
    f.fleet.viewer.close(); await pending;
    f.fleet.setBlocked('pending', false);
    assert.equal(f.renderer.overlayStack.length, 0);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    const { view, closed } = await f.openView();
    f.fleet.setBlocked('first', true); f.fleet.setBlocked('second', true);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    const foreign = new f.sdk.CustomEditor(f.tui, f.theme.getEditorTheme(), f.kb);
    foreign.setText('External owner');
    const foreignInputs = observeInput(foreign);
    capturing = f.tui.showOverlay(foreign, { width: 35, maxHeight: 5 });
    const passiveComponent = new f.tuiModule.Text('Passive overlay', 0, 0);
    passive = f.tui.showOverlay(passiveComponent, { width: 20, maxHeight: 1, anchor: 'top-right', nonCapturing: true });
    f.fleet.setBlocked('first', false);
    f.fleet.update(); f.frame();
    assert.equal(f.renderer.overlayStack.find(e => e.component === view).hidden, true, 'one owner cannot release another hold');
    f.fleet.setBlocked('second', false); f.fleet.update(); f.frame();
    assert.equal(f.tui.getFocusedComponent(), foreign, 'final unblock must not replace unrelated capturing focus');
    assert.equal(f.renderer.overlayStack.find(e => e.component === view).hidden, true);
    f.send('!'); assert.deepEqual(foreignInputs, ['!']);
    capturing.hide(); capturing = undefined;
    f.tui.setFocus(f.editor); f.fleet.update(); f.frame();
    assert.equal(f.tui.getFocusedComponent(), view, 'availability reconciliation restores the live view when main returns');
    assert.equal(view.composer.getText(), CHILD_DRAFT);
    f.fleet.setBlocked('close', true);
    capturing = f.tui.showOverlay(foreign, { width: 35, maxHeight: 5 });
    f.fleet.viewer.close(); await closed;
    f.fleet.setBlocked('close', false); f.fleet.update(); f.frame();
    assert.equal(f.tui.getFocusedComponent(), foreign);
    assert.deepEqual(f.renderer.overlayStack.map(e => e.component), [passiveComponent, foreign], 'close removes only its own handle');
    assert.equal(f.runner.uiPromptDepth, 0);
    foreign.dispose?.();
  } finally { capturing?.hide(); passive?.hide(); await f.dispose(); }
}

async function testNestedDialogs() {
  // 1.4 owns a dialog stack. 1.2 replaces its dock, so overlapping native docks are not
  // supported there; both versions exercise overlapping independent block owners above.
  const f = await createDialogFixture({ sdkVersion: '1.4', awaitedHandler: true });
  try {
    const { view, inputs } = await f.openView();
    const outer = f.prompt('select'); const outerDialog = await visibleDialog(f, 'select');
    const outerInputs = observeInput(outerDialog);
    const inner = f.prompt('input');
    await waitFor('nested input installed', () => f.dialogs.length === 2);
    const innerDialog = f.dialogs.at(-1).component;
    assert.equal(f.tui.getFocusedComponent(), innerDialog);
    assert.ok(plain(f.snapshot()).includes(marker.input));
    assert.equal(f.runner.uiPromptDepth, 2);
    const innerInputs = observeInput(innerDialog);
    f.send('nested', ENTER); assert.equal(await inner, 'nested');
    assert.equal(f.tui.getFocusedComponent(), outerDialog);
    assert.ok(plain(f.snapshot()).includes(marker.select));
    assert.equal(f.state.ends, 0, 'inner close must not resume the viewer');
    assert.equal(f.runner.uiPromptDepth, 1);
    f.send(ENTER); answer('select', await outer);
    await waitFor('outer end', () => f.state.ends === 1);
    assert.equal(f.tui.getFocusedComponent(), view);
    assert.deepEqual(innerInputs, ['nested', ENTER]);
    assert.deepEqual(outerInputs, [ENTER]);
    assert.deepEqual(inputs, []);
    assert.equal(f.state.starts, 1); assert.equal(f.runner.uiPromptDepth, 0);
  } finally { await f.dispose(); }
}

async function testRemappedPaging(sdkVersion) {
  const f = await createDialogFixture({ sdkVersion, stableProxy: true, sidebarOpen: true, bindings: {
    'tui.altScreen.pageUp': [], 'tui.altScreen.pageDown': [],
    'tui.altScreen.halfPageUp': 'alt+u', 'tui.altScreen.halfPageDown': 'alt+d',
    'tui.altScreen.top': 'alt+t', 'tui.altScreen.bottom': 'alt+b',
  } });
  try {
    const { view } = await f.openView({ hosted: true, status: 'done' });
    const bottom = view.scrollTop, half = Math.max(1, Math.floor(view.lastViewport / 2));
    f.send(KEY.pageUp, KEY.top);
    assert.equal(view.scrollTop, bottom, 'explicit rebind/disable removes old physical defaults');
    f.send('\x1bu'); assert.equal(view.scrollTop, bottom - half);
    f.send('\x1bd'); assert.equal(view.scrollTop, bottom);
    f.send('\x1bt'); assert.equal(view.scrollTop, 0);
    f.send('\x1bb'); assert.equal(view.scrollTop, bottom);
  } finally { await f.dispose(); }
}

async function testModalOwnership(sdkVersion, vim) {
  const mode = Symbol.for('pi-plugins.editor-mode.v1');
  const f = await createDialogFixture({ sdkVersion, vim, stableProxy: true, bindings: {
    'tui.altScreen.halfPageUp': 'ctrl+u', 'tui.altScreen.halfPageDown': 'ctrl+d',
  } });
  try {
    const { view } = await f.openView({ hosted: true });
    const originalRun = view.current, bottom = view.scrollTop;
    f.send('\x15'); assert.equal(view.composer.getText(), '', 'Insert/native Ctrl+U edits, not scrolls');
    f.send('abc', '\x01', '\x04'); assert.equal(view.composer.getText(), 'bc');
    assert.equal(view.scrollTop, bottom);
    if (!vim) return;
    assert.equal(view.composer.constructor.name, 'EmbeddedEditor', 'use actual pi-vim composer');
    f.send(ESCAPE); assert.equal(view[mode]().state, 'normal');
    f.send('\x15'); assert.ok(view.scrollTop < bottom, 'idle Normal Ctrl+U scrolls child');
    const top = view.scrollTop;
    const composerInputs = observeInput(view.composer);
    for (const key of ['\t', '\n', '\x0b', KEY.pageUp, '\x15', '\x04']) {
      if (view[mode]().state !== 'normal') f.send(ESCAPE);
      f.send(':', 'z'); assert.equal(view[mode]().state, 'ex');
      composerInputs.length = 0;
      f.send(key);
      assert.deepEqual(composerInputs, [key], 'EX receives even physical session/viewport shortcuts');
      assert.equal(f.tui.getFocusedComponent(), view, 'EX must precede session cycling');
      assert.equal(view.current, originalRun);
      assert.equal(view.scrollTop, top);
    }
    if (view[mode]().state !== 'normal') f.send(ESCAPE);
    f.send('d'); assert.equal(view[mode]().state, 'pending');
    f.send('\t'); assert.equal(f.tui.getFocusedComponent(), view, 'pending operators own Tab');
    if (view[mode]().state !== 'normal') f.send(ESCAPE);
    f.send('v'); assert.equal(view[mode]().state, 'visual');
    f.send('\t', '\x04'); assert.equal(f.tui.getFocusedComponent(), view, 'Visual owns Tab and Ctrl+D');
    assert.equal(view.scrollTop, top);
    if (view[mode]().state !== 'normal') f.send(ESCAPE);
    f.send('i');
    // Use the native autocomplete provider, not a mocked isShowingAutocomplete flag.
    view.composer.setAutocompleteProvider({
      getSuggestions: () => ({ items: [{ value: 'alpha', label: 'alpha' }, { value: 'beta', label: 'beta' }], prefix: '/' }),
      applyCompletion: (lines, line, _col, item) => ({ lines: [item.value], cursorLine: line, cursorCol: item.value.length }),
    });
    view.composer.setText(''); f.send('/');
    await waitFor('real autocomplete popup', () => view.composer.isShowingAutocomplete());
    f.send('\t');
    assert.equal(view.current, originalRun, 'autocomplete Tab completes instead of cycling');
    assert.equal(view.composer.getText(), 'alpha');
    assert.equal(f.editor.getText(), MAIN_DRAFT);
  } finally { await f.dispose(); }
}

async function testDialogFields(sdkVersion, selectNavOrder, activity) {
  const f = await createDialogFixture({ sdkVersion, selectNavOrder });
  let pill, pillOpens = 0;
  try {
    if (activity === 'Pill') {
      f.fleet.dispose();
      const { PillView } = await f.production('pi-bg/src/pill.ts');
      pill = new PillView({ pill: () => ({ label: 'Independent tasks' }), open: () => { pillOpens++; } }, 'focus-pill');
      pill.setUI(f.ui); pill.update();
    }
    f.send(KEY.down, ENTER);
    await waitFor('actionable activity positive control', () => activity === 'Pill' ? pillOpens === 1 : f.state.fleetOpens === 1);
    assert.deepEqual(f.mainInputs, []);
    // An unmarked native list exercises {data} rewriting, not only suite components that
    // decline it. Both registration orders must deliver each rewritten key exactly once.
    f.send(KEY.down);
    const select = f.prompt('select'), native = await visibleDialog(f, 'select');
    const rewritten = observeInput(native);
    f.send('\n', '\x0b', ENTER); answer('select', await select);
    await waitFor('select end', () => f.state.ends === 1);
    assert.deepEqual(rewritten, [KEY.down, KEY.up, ENTER]);
    for (const field of ['question-custom', 'question-note', 'approval-message', 'approval-rule']) for (const draft of ['', 'Field draft']) {
      f.send(KEY.down); // preselected Fleet/Pill may never steal an embedded field's Down/Enter
      const kind = field.startsWith('question') ? 'question' : 'approval';
      const starts = f.state.starts + 1;
      const prompt = f.prompt(kind, field === 'approval-rule' ? { choices: ['Allow once', 'Edit the rule...', 'Block'], editRow: 'Edit the rule...' } : {});
      const dialog = await visibleDialog(f, kind, starts);
      const open = () => {
        if (field === 'question-custom') {
          // Opening the text row once leaves it selected when its field closes.
          if (dialog.slots[0].cursor !== QUESTION.options.length) f.send(KEY.down, KEY.down);
          f.send(ENTER);
        } else if (field === 'question-note' || field === 'approval-message') f.send('n');
        else {
          if (!dialog.editing && dialog.list.getSelectedItem()?.value !== 'Edit the rule...') f.send(KEY.down);
          f.send(ENTER);
        }
      };
      open();
      const received = observeInput(dialog), sent = [];
      const send = (...keys) => { sent.push(...keys); f.send(...keys); };
      if (draft) send(draft);
      send(KEY.down, KEY.left);
      assert.equal(f.tui.getFocusedComponent(), dialog);
      assert.equal(dialog[Symbol.for('pi-plugins.input-context.v1')](), 'editor');
      assert.ok(plain(f.snapshot()).includes(draft || marker[kind]));
      if (!draft && field !== 'question-note') {
        send(ENTER); assert.equal(dialog[Symbol.for('pi-plugins.input-context.v1')](), 'editor', 'empty field stays owned');
      }
      send(ESCAPE);
      assert.equal(f.dialogs.at(-1).component, dialog, 'Escape closes only the field, not the whole dialog');
      assert.equal(dialog[Symbol.for('pi-plugins.input-context.v1')](), 'list');
      assert.deepEqual(received, sent, 'Down/Left/Enter/Escape belong exactly once to the embedded wrapper');
      open();
      f.send('\x05', '\x15', 'Field answer', ENTER);
      if (field === 'question-note') f.send(ENTER);
      const result = await bounded(`${field} submit`, prompt);
      if (field === 'question-custom') assert.equal(result.answers[0].answer, 'Field answer');
      else if (field === 'question-note') assert.equal(result.answers[0].notes, 'Field answer');
      else if (field === 'approval-message') assert.deepEqual(result, { choice: 'Block', message: 'Field answer' });
      else assert.deepEqual(result, { choice: 'Edit the rule...', edited: 'Field answer' });
      await waitFor('field prompt end', () => f.state.ends === starts);
      assert.deepEqual(f.mainInputs, []);
      assert.equal(f.editor.getText(), MAIN_DRAFT);
      assert.equal(f.panel.input.getText(), SIDEBAR_DRAFT);
      assert.equal(activity === 'Pill' ? pillOpens : f.state.fleetOpens, 1);
    }
    const { DiffViewer } = await f.production('pi-diff-review/src/viewer.ts');
    const { DEFAULTS } = await f.production('pi-diff-review/src/config.ts');
    const { parseDiff } = await f.production('pi-diff-review/src/parse.ts');
    const threads = [];
    const diffHost = { threads, checks: new Map(), editorDrafts: new Map(), config: { ...DEFAULTS, view: 'unified' },
      turns: () => [], load: async () => { throw new Error('fixture must not load a repository'); },
      persist() {}, send() {}, open: async () => 'unused', copy: async () => {},
    };
    const data = { root: '/tmp', scope: { kind: 'working', label: 'Focus diff', base: 'HEAD', target: 'working' },
      files: parseDiff('diff --git a/focus.ts b/focus.ts\n--- a/focus.ts\n+++ b/focus.ts\n@@ -1 +1 @@\n-old\n+new\n') };
    for (const draft of ['', 'Comment draft']) {
      f.send(KEY.down);
      let finish;
      const result = f.track(f.ui.custom((tui, theme, keys, done) => {
        finish = done; return new DiffViewer(tui, theme, keys, diffHost, data, done);
      }));
      try {
        await waitFor('real DiffViewer', () => f.dialogs.at(-1)?.component.constructor.name === 'DiffViewer');
        const diff = f.dialogs.at(-1).component;
        f.send('c');
        assert.equal(diff[Symbol.for('pi-plugins.input-context.v1')](), 'editor');
        const received = observeInput(diff), keys = [...(draft ? [draft] : []), KEY.down, KEY.left, ESCAPE];
        f.send(...keys); assert.deepEqual(received, keys);
        assert.equal(f.tui.getFocusedComponent(), diff);
        f.send('c');
        assert.ok(plain(f.snapshot()).includes(draft || 'Comment'));
        f.send('\x05', '\x15', 'Review note', ENTER);
        assert.equal(threads.at(-1).body, 'Review note');
        f.send('q'); await bounded('diff close', result);
        await nextTurn();
        assert.equal(f.editor.getText(), MAIN_DRAFT);
        assert.deepEqual(f.mainInputs, []);
        assert.equal(activity === 'Pill' ? pillOpens : f.state.fleetOpens, 1);
      } finally { finish?.(); }
    }
    assert.deepEqual(f.state.errors, []);
  } finally { pill?.dispose(); await f.dispose(); }
}

const failures = [];
let cases = 0;
async function check(label, fn) {
  try { await fn(); }
  catch (error) { failures.push(new Error(label, { cause: error })); console.error(`FAIL ${label}: ${error.stack}`); }
  cases++;
}
for (const footerFirst of [true, false]) {
  for (const width of [46, 120, 180]) for (const open of [false, true]) for (const primary of [false, true]) {
    for (const kind of ['select', 'confirm', 'question', 'approval']) {
      const label = `${kind}, ${width} columns, Sidebar ${open ? 'open' : 'closed'}, ${primary ? 'active primary' : 'main'}, ${footerFirst ? 'footer' : 'Sidebar'} handler first`;
      await check(label, () => testPrompt({ width, open, primary, footerFirst, kind }));
    }
  }
}
console.log('Checked all 96 original Pi 1.4 dialog-focus cases');
for (const sdkVersion of ['1.2', '1.4']) {
  for (const hosted of [false, true]) for (const handlerOrder of ['footer-first', 'sidebar-first']) {
    await check(`Pi ${sdkVersion} ${hosted ? 'hosted' : 'standalone'} viewer successive dialogs, ${handlerOrder}`,
      () => testViewerPrompts({ sdkVersion, hosted, handlerOrder }));
  }
  for (const width of [46, 120, 180]) for (const sidebarOpen of [false, true]) for (const running of [false, true]) {
    await check(`Pi ${sdkVersion} hosted paging @${width}, Sidebar ${sidebarOpen}, running ${running}`,
      () => testHostedPaging({ sdkVersion, width, sidebarOpen, running }));
  }
  for (const selectNavOrder of ['before', 'after']) for (const activity of ['Fleet', 'Pill']) await check(
    `Pi ${sdkVersion} embedded question/approval/diff fields, select-nav ${selectNavOrder} ${activity}`,
    () => testDialogFields(sdkVersion, selectNavOrder, activity));
  for (const operation of ['close', 'shutdown', 'rebind']) await check(`Pi ${sdkVersion} suspended ${operation}`,
    () => testSuspendedClose(sdkVersion, operation));
  await check(`Pi ${sdkVersion} independent block holds, deferred cancellation and foreign overlays`, () => testBlockedOverlays(sdkVersion));
  await check(`Pi ${sdkVersion} rebound/disabled hosted viewport keys`, () => testRemappedPaging(sdkVersion));
  for (const vim of [false, true]) await check(`Pi ${sdkVersion} ${vim ? 'pi-vim modal' : 'native editor'} key ownership`, () => testModalOwnership(sdkVersion, vim));
  await check(`Pi ${sdkVersion} stable TUI proxy and real pi-vim hosted paging`,
    () => testHostedPaging({ sdkVersion, width: 120, sidebarOpen: true, running: true, vim: true, stableProxy: true }));
}
await check('Pi 1.4 nested native dialogs preserve outer owner', testNestedDialogs);
if (failures.length) throw new AggregateError(failures, `${failures.length}/${cases} dialog focus cases failed`);
console.log(`PASS ${cases} real-terminal dialog/viewer cases on Pi 1.2/1.4; no hidden input owner or lost viewport keys`);
