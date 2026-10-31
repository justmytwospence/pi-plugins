// Actual SessionView frames through Pi's fullscreen renderer and native input dispatcher.
// Run data is in memory: no child process, model call, or synthetic replacement view.
import assert from 'node:assert/strict';
import {
  createDialogFixture, MAIN_DRAFT, CHILD_DRAFT, SIDEBAR_DRAFT, CHOICE, KEY, plain, waitFor, bounded,
} from '../lib/dialog-focus-fixture.mjs';

const labels = [CHOICE, 'Not this choice'];
const select = {
  question: 'Native select focus?',
  herdr: { options: labels.length, multi: false, labels },
  collie: { kind: 'prompt-select', options: labels.length + 1, labels, wraps: labels },
};
const layouts = [
  { hosted: false, sidebarOpen: false },
  { hosted: false, sidebarOpen: true },
  { hosted: true, sidebarOpen: true },
];

/** Idle baseline indices are local to this array; the caller offsets them when appending. */
export async function subagentScreens({ height = 40, footer, idleFooter, sessionFooter } = {}) {
  const screens = [];
  for (const width of [46, 120, 180]) {
    for (const status of ['running', 'done']) {
      let childBaseline, mainBaseline;
      for (const { hosted, sidebarOpen } of layouts) {
        const under = `${hosted ? 'hosted' : 'standalone'}, ${sidebarOpen ? 'Sidebar open' : 'without Sidebar'}`;
        const name = `subagent ${status === 'running' ? 'running' : 'ended'}`;
        const context = `${name} @${width} over ${under}`;
        const f = await createDialogFixture({ sdkVersion: '1.4', width, height, sidebarOpen, footer, idleFooter, sessionFooter });
        try {
          const { view, closed } = await f.openView({ hosted, status });
          const drafts = () => {
            assert.equal(f.editor.getExpandedText(), MAIN_DRAFT, `${context}: main draft survives`);
            assert.equal(f.panel.input.getText(), SIDEBAR_DRAFT, `${context}: Sidebar draft survives`);
          };
          const capture = (stage, expectation) => {
            const lines = f.snapshot();
            assert.equal(lines.length, height, `${context}: capture the whole fullscreen frame`);
            const text = plain(lines);
            screens.push({ name: `${name} ${stage}`, width, under, ...expectation, ansi: lines.join('\n') });
            return text;
          };
          const captureView = stage => {
            assert.equal(f.tui.getFocusedComponent(), view, `${context}: the same SessionView owns focus`);
            const text = capture(stage, status === 'running'
              ? { idle: childBaseline, expectedDraft: CHILD_DRAFT }
              : { terminal: true });
            assert.match(text, /Child transcript line/u, `${context}: the actual child transcript is visible`);
            assert.equal(text.includes(CHILD_DRAFT), status === 'running', `${context}: only a running child has a draft`);
            assert.ok(!text.includes(MAIN_DRAFT), `${context}: main is not a child-view send target`);
            drafts();
          };
          childBaseline ??= screens.length;
          captureView('view');

          const starts = f.state.starts, ends = f.state.ends;
          const prompt = f.prompt('select');
          await waitFor(`${context}: native select opens`, () => f.dialogs.length > 0 && f.state.starts > starts);
          const dialogText = capture('native select', { dialog: select });
          assert.match(dialogText, /Native select focus\?/u, `${context}: the native select is visible`);
          assert.ok(!dialogText.includes(CHILD_DRAFT), `${context}: the child composer is hidden during the select`);
          f.send(KEY.enter);
          assert.equal(await bounded(`${context}: select answer`, prompt), CHOICE);
          await waitFor(`${context}: native select closes`, () => f.dialogs.length === 0 && f.state.ends > ends);
          captureView('restored after select');

          f.send(KEY.escape);
          await bounded(`${context}: return to main`, closed);
          assert.equal(f.tui.getFocusedComponent(), f.editor, `${context}: closing returns focus to main`);
          drafts();
          mainBaseline ??= screens.length;
          const mainText = capture('returned main', { idle: mainBaseline, expectedDraft: MAIN_DRAFT });
          assert.ok(mainText.includes(MAIN_DRAFT), `${context}: main's draft is visible again`);
          assert.ok(!mainText.includes(CHILD_DRAFT), `${context}: the child composer is gone`);
          assert.equal(mainText.includes(SIDEBAR_DRAFT), sidebarOpen, `${context}: returning preserves Sidebar's open state`);
          assert.deepEqual(f.state.errors, [], `${context}: native lifecycle handlers succeed`);
        } finally {
          await f.dispose();
        }
      }
    }
  }
  return screens;
}
