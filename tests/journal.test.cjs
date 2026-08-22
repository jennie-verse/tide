const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadApp(locationOverride = {}) {
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
    location: { origin: 'https://example.test', hostname: 'example.test', href: 'https://example.test/tide/', pathname: '/tide/', search: '', hash: '', ...locationOverride },
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

test('Pages ownership is portable and custom domains stop sync explicitly', () => {
  const pages = loadApp({ hostname: 'new-owner.github.io', origin: 'https://new-owner.github.io', href: 'https://new-owner.github.io/tide/' });
  assert.equal(vm.runInContext('syncConfig().owner', pages.context), 'new-owner');
  const custom = loadApp();
  assert.throws(() => vm.runInContext('syncConfig()', custom.context), error => error.code === 'PAGES_OWNER_UNRESOLVED');
  assert.match(vm.runInContext('describeSyncError((() => { try { syncConfig(); } catch (e) { return e; } })())', custom.context), /Cannot determine the GitHub account/);
});

test('shortcut URL keeps the current deployment path and query entry', () => {
  const { context } = loadApp({ origin: 'https://new-owner.github.io', hostname: 'new-owner.github.io', pathname: '/tide/index.html', href: 'https://new-owner.github.io/tide/index.html' });
  assert.equal(vm.runInContext('baseUrl()', context), 'https://new-owner.github.io/tide/');
  assert.equal(vm.runInContext('appUrl()', context), 'https://new-owner.github.io/tide/?add=');
});

test('merge keeps the newest item and a newer tombstone wins', () => {
  const { context } = loadApp();
  vm.runInContext(`
    state.items = [{ id:'a', kind:'clip', text:'old', createdAt:'2026-08-01T00:00:00Z', updatedAt:'2026-08-02T00:00:00Z' }];
    state.deleted = [];
    mergeRemote([{ items:[{ id:'a', kind:'clip', text:'new', createdAt:'2026-08-01T00:00:00Z', updatedAt:'2026-08-03T00:00:00Z' }], deleted:[] }]);
    globalThis.afterNew = state.items[0].text;
    mergeRemote([{ items:[], deleted:[{ id:'a', at:'2026-08-04T00:00:00Z' }] }]);
    globalThis.afterDelete = state.items.length;
  `, context);
  assert.equal(context.afterNew, 'new');
  assert.equal(context.afterDelete, 0);
});

test('retention preserves pinned items and removes only expired unpinned items', () => {
  const { context } = loadApp();
  vm.runInContext(`
    state.settings.retentionDays = 7;
    state.items = [
      normalizeItem({ id:'p', kind:'clip', text:'pinned', pinned:true, createdAt:'2020-01-01T00:00:00Z', lastTouchedAt:'2020-01-01T00:00:00Z' }),
      normalizeItem({ id:'x', kind:'dump', text:'expired', pinned:false, createdAt:'2020-01-01T00:00:00Z', lastTouchedAt:'2020-01-01T00:00:00Z' })
    ];
    globalThis.expired = state.items.filter(item => isExpired(item, state.settings.retentionDays)).map(item => item.id);
  `, context);
  assert.deepEqual(Array.from(context.expired), ['x']);
});
