// Capture the actual System 1 waterfall picker and billing confirmation using local-only fixtures.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { visibleWidth } from '@earendil-works/pi-tui';

const jiti = createJiti(import.meta.url);
const { openSystem1Picker, BILLING_CONFIRMATION } = await jiti.import('../../packages/pi-system1/src/ui.ts');

export async function system1Dialogs({ ExtensionSelectorComponent }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-client-system1-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const dialogs = [];
    for (const spec of [
      { name: 'System 1 picker (Jev then OpenAI)', waterfall: ['jev', 'openai-decisions'] },
      { name: 'System 1 picker (OpenAI then Jev)', waterfall: ['openai-decisions', 'jev'] },
      { name: 'System 1 picker (Jev only)', waterfall: ['jev'] },
      { name: 'System 1 picker (OpenAI only)', waterfall: ['openai-decisions'] },
      { name: 'System 1 picker (OpenAI unavailable)', waterfall: ['jev', 'openai-decisions'], unavailable: true },
      { name: 'System 1 picker (all unavailable)', waterfall: ['jev', 'openai-decisions'], unavailable: true, allMissing: true },
      { name: 'System 1 included-credit confirmation', waterfall: ['jev'], billing: true },
    ]) {
      const before = JSON.stringify({ waterfall: spec.waterfall, backend: spec.waterfall[0] });
      writeFileSync(path.join(dir, 'system1.json'), before);
      const bus = new EventEmitter();
      const events = { emit: (name, value) => bus.emit(name, value), on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); } };
      let blocked = false, captured, selects = 0;
      events.on('herdr:blocked', ({ active }) => { blocked = active; });
      const ctx = {
        hasUI: true, mode: 'tui', cwd: dir, isIdle: () => true,
        modelRegistry: {
          findOfType: (_type, provider, id) => ({ type: 'classifier', provider, id, api: provider === 'system1-openai' ? 'openai-decisions' : 'typesafe-system-one', baseUrl: 'https://api.openai.com/v1' }),
          classify: () => assert.fail('rendering System 1 dialogs must not call a model'),
          hasConfiguredAuth: () => !spec.allMissing,
          getProviderAuthStatus: () => ({ configured: !spec.unavailable }),
        },
        ui: {
          notify: () => assert.fail('cancelling a configured picker must not emit an error'),
          select: async (title, options) => {
            assert.equal(blocked, true, 'the complete picker/confirmation holds the blocked protocol');
            assert.ok(options.every(label => visibleWidth(label) <= 42), 'native select labels fit phone width');
            selects++;
            if (spec.billing && selects === 1) return 'Jev → OpenAI';
            if (spec.billing) assert.equal(title, BILLING_CONFIRMATION);
            else {
              assert.match(title, /System 1/);
              assert.deepEqual(options, ['Jev → OpenAI', 'OpenAI → Jev', 'Jev only', 'OpenAI only']);
            }
            captured = { title, options: [...options] };
            return undefined;
          },
        },
      };
      await openSystem1Picker({ events }, ctx);
      assert.ok(captured, `${spec.name} captured the real select`);
      assert.equal(blocked, false, 'cancellation releases the blocked protocol');
      assert.equal(selects, spec.billing ? 2 : 1);
      if (spec.unavailable) assert.match(captured.title, /OpenAI: missing/);
      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(path.join(dir, 'system1.json'), 'utf8'), before, 'capture never changes the configured order');
      dialogs.push({
        name: spec.name, question: captured.title.replace(/\s+/gu, ' ').trim(),
        lines: width => new ExtensionSelectorComponent(captured.title, captured.options, () => {}, () => {}).render(width),
        herdr: { options: captured.options.length, multi: false, labels: captured.options },
        collie: { kind: 'prompt-select', options: captured.options.length + 1, labels: captured.options, wraps: captured.options },
      });
    }
    return dialogs;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
