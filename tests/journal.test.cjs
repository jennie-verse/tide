const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApp() {
  const values = new Map();
  const context = vm.createContext({
    console,
    Date,
    Promise,
    URL,
    Blob,
    File: class File {},
    TextEncoder,
    setTimeout: () => 1,
    clearTimeout: () => {},
    location: { origin: 'https://example.test', pathname: '/tide/' },
    navigator: {},
    window: { addEventListener() {}, SharedSync: null },
    document: { addEventListener() {}, documentElement: { style: { setProperty() {} } } },
    localStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(key, String(value)); },
      removeItem(key) { values.delete(key); },
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'app.js' });
  return { context, source, values };
}

test('journal opt-in is independent and defaults off when normal sync is already on', () => {
  const { context, values } = loadApp();
  values.set('tide.syncEnabled', '1');
  assert.equal(vm.runInContext('isSyncEnabled()', context), true);
  assert.equal(vm.runInContext('isJournalEnabled()', context), false);
  vm.runInContext('setJournalEnabled(true)', context);
  assert.equal(values.get('tide.journalEnabled.v1'), '1');
});

test('projection contains the full Tide record but no authentication data', () => {
  const { context } = loadApp();
  vm.runInContext(`globalThis.result = tideJournalRecord(normalizeItem({
    id: 'fixture-clip', kind: 'clip', text: 'Fixture text', label: 'Fixture label',
    type: 'text', pinned: true, createdAt: '2026-08-17T14:00:00.000Z',
    lastTouchedAt: '2026-08-17T15:00:00.000Z', updatedAt: '2026-08-17T15:00:00.000Z',
    usedAt: '2026-08-17T15:00:00.000Z', useCount: 2
  }))`, context);
  const result = context.result;
  assert.equal(result.kind, 'clip');
  assert.equal(result.title, 'Fixture label');
  assert.equal(result.data.text, 'Fixture text');
  assert.equal(result.data.useCount, 2);
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('projection title fallbacks and tombstones retain the original creation day', () => {
  const { context } = loadApp();
  vm.runInContext(`
    const fixture = normalizeItem({
      id: 'fixture-dump', kind: 'dump', text: '\\n  First line  \\nSecond',
      createdAt: '2026-08-17T14:00:00.000Z', journalDate: '2026-08-17',
      updatedAt: '2026-08-17T14:00:00.000Z'
    });
    globalThis.result = {
      date: fixture.journalDate,
      record: tideJournalRecord(fixture, { deleted: true, updatedAt: '2026-08-18T01:00:00.000Z' })
    };
  `, context);
  assert.equal(context.result.date, '2026-08-17');
  assert.equal(context.result.record.title, 'First line');
  assert.equal(context.result.record.deleted, true);
  assert.equal(context.result.record.updatedAt, '2026-08-18T01:00:00.000Z');
});

test('all primary Tide mutation paths enqueue only after the local save call', () => {
  const { source } = loadApp();
  const pairs = [
    /saveState\(\);\s*queueJournalItem\(dup/,
    /saveState\(\);\s*queueJournalItem\(item\)/,
    /saveState\(\);\s*queueJournalItem\(item, \{ deleted: true/,
  ];
  pairs.forEach(pattern => assert.match(source, pattern));
  assert.match(source, /import\(JOURNAL\.moduleUrl\)/);
});
