/* ==========================================================================
   Tide — app.js
   A seven-day desk for phrases you reuse and thoughts you dump.
   No server, no login. Data lives in localStorage; optional GitHub sync.

   ▶ Easy-to-change values live in CONFIG below.
     - App name:    CONFIG.appName
     - Colors:      app.css :root
     - Fonts:       app.css @font-face / body { font-family }
   ========================================================================== */

'use strict';

/* ── 1. CONFIG ─────────────────────────────────────────────────────────── */

const CONFIG = {
  appName: 'Tide',
  fileBase: 'tide',
  storageKey: 'tide.v1',
  draftKey: 'tide.draft.v1',
  cleanupTimeKey: 'tide.v1.lastCleanupAt',   // separate from storageKey — see saveState() note
  backupTimeKey: 'tide.v1.lastBackupAt',     // separate from storageKey — see saveState() note
  mirrorPrefix: 'tide-mirror-',
  mirrorUrl: './__tide-mirror.json',
  schema: 1,
  maxTextLength: 5000,
  maxLabelLength: 40,
  previewLong: 200,
  undoMs: 5000,
  maxPinned: 50,
  emergencyCap: 300,
  cleanupCheckIntervalMs: 7 * 24 * 60 * 60 * 1000, // how often we even check, independent of retentionDays
  fontStepPx: { 1: 6, 2: 8, 3: 10, 4: 12, 5: 14, 6: 17 },
  defaultFontStep: 4,
  defaults: {
    fontStep: 4,
    retentionDays: 7,
    mergeDuplicates: true,
    lastTab: 'clips'
  }
};

const TYPE_LABEL = { url: 'URL', email: 'Email', phone: 'Phone', number: 'Number', long: 'Long', text: 'Text' };

function nowIso() { return new Date().toISOString(); }
function isoOr(v) {
  const d = v ? new Date(v) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
function cmpAsc(a, b) { return new Date(a).getTime() - new Date(b).getTime(); }
function cmpDesc(a, b) { return new Date(b).getTime() - new Date(a).getTime(); }

/* ── 2. store: read / write / normalize ────────────────────────────────── */

let state = { version: CONFIG.schema, app: 'tide', items: [], deleted: [], settings: { ...CONFIG.defaults } };
let storageOK = true;

/**
 * Normalizes one item. `opts.fallbackTouchedAt`, if given, is used ONLY when
 * the raw item has no lastTouchedAt at all (see plan 4-4-②: items arriving
 * from sync with no clock get the merge time; items with a real value are
 * always respected as-is, even if that means they're already close to
 * expiring). Local loads pass no fallback, so a missing value falls back to
 * createdAt instead — legitimate for a never-touched local item.
 */
function normalizeItem(it, opts = {}) {
  const createdAt = isoOr(it.createdAt);
  const kind = it.kind === 'dump' ? 'dump' : 'clip';
  const text = String(it.text == null ? '' : it.text).slice(0, CONFIG.maxTextLength);
  const fallbackTouched = opts.fallbackTouchedAt || createdAt;
  return {
    id: typeof it.id === 'string' && it.id ? it.id : makeId(),
    kind,
    text,
    label: kind === 'clip' && typeof it.label === 'string' ? it.label.slice(0, CONFIG.maxLabelLength) : '',
    type: kind === 'clip' ? (TYPE_LABEL[it.type] ? it.type : detectType(text)) : '',
    pinned: it.pinned === true,
    createdAt,
    lastTouchedAt: it.lastTouchedAt ? isoOr(it.lastTouchedAt) : fallbackTouched,
    updatedAt: it.updatedAt ? isoOr(it.updatedAt) : createdAt,
    usedAt: kind === 'clip' && it.usedAt ? isoOr(it.usedAt) : null,
    useCount: kind === 'clip' && Number.isFinite(it.useCount) ? it.useCount : 0,
    archivedAt: it.archivedAt ? isoOr(it.archivedAt) : null
  };
}

function normalizeTomb(d) {
  return { id: d.id, at: isoOr(d.at) };
}

function normalize(data, opts = {}) {
  const out = { version: CONFIG.schema, app: 'tide', items: [], deleted: [], settings: { ...CONFIG.defaults } };
  if (!data || typeof data !== 'object') return out;

  if (Array.isArray(data.items)) {
    out.items = data.items
      .filter(it => it && typeof it.text === 'string' && it.text.trim() !== '')
      .map(it => normalizeItem(it, opts));
  }
  if (Array.isArray(data.deleted)) {
    out.deleted = data.deleted
      .filter(d => d && typeof d.id === 'string' && d.id && d.at)
      .map(normalizeTomb);
  }

  const s = (data.settings && typeof data.settings === 'object') ? data.settings : {};
  const step = Number(s.fontStep);
  out.settings.fontStep = CONFIG.fontStepPx[step] ? step : CONFIG.defaults.fontStep;
  out.settings.retentionDays = [7, 14, 30, 0].includes(Number(s.retentionDays)) ? Number(s.retentionDays) : CONFIG.defaults.retentionDays;
  out.settings.mergeDuplicates = s.mergeDuplicates !== false;
  out.settings.lastTab = s.lastTab === 'dump' ? 'dump' : 'clips';

  return out;
}

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(CONFIG.storageKey);
  } catch (e) {
    storageOK = false;
    return;
  }
  if (!raw) return;
  try {
    state = normalize(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not read saved data.', e);
  }
}

function saveState() {
  cleanupTombstones();
  state.savedAt = nowIso();
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(state));
    storageOK = true;
  } catch (e) {
    storageOK = false;
    toast('Storage is full — could not save. Delete some items.', 'err', 6000);
  }
  writeMirror();
  if (isSyncEnabled()) schedulePush();
}

/**
 * The expiry-clock helper (plan 4-1). Call this — and only this — for every
 * action listed in the "resets the clock" table: create, copy (card tap or
 * menu), edit+save, unpin, move between Clips/Dump, merge-on-recapture.
 * It bumps BOTH lastTouchedAt (expiry) and updatedAt (sync conflict order)
 * together, because every one of those actions is a genuine user change
 * worth both resetting the countdown and telling other devices about.
 * Passive events — render, search, app open, sync merge itself — must NOT
 * call this, or the item would silently outlive its retention period.
 */
function touch(item) {
  const t = nowIso();
  item.lastTouchedAt = t;
  item.updatedAt = t;
}

function makeId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

/* ── 3. type detection (carried over from clip's app.js detectType) ─────── */

function detectType(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return 'url';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return 'email';
  const digits = t.replace(/\D/g, '');
  if (/^[+0][\d\s().-]{6,}$/.test(t) && digits.length >= 8 && digits.length <= 15) return 'phone';
  if (/^[\d\s-]{4,}$/.test(t)) return 'number';
  if (t.length > CONFIG.previewLong) return 'long';
  return 'text';
}

/* ── 4. CRUD ───────────────────────────────────────────────────────────── */

function countPinned() { return state.items.filter(it => it.pinned).length; }
function countDumpUnpinned() { return state.items.filter(it => it.kind === 'dump' && !it.pinned).length; }
function findItem(id) { return state.items.find(it => it.id === id) || null; }

function itemsOfKind(kind, list) { return (list || state.items).filter(it => it.kind === kind); }
function sortedPinned(list) {
  return list.filter(it => it.pinned).sort((a, b) => cmpDesc(a.lastTouchedAt, b.lastTouchedAt));
}
function sortedByCreated(list) {
  return list.filter(it => !it.pinned).sort((a, b) => cmpDesc(a.createdAt, b.createdAt));
}

/** Silent, non-user-facing safety valve. Not shown in UI, no confirmation —
    only trips if localStorage is at risk of filling up (plan 4-3). */
function trimEmergency() {
  const unpinned = state.items.filter(it => !it.pinned).sort((a, b) => cmpAsc(a.lastTouchedAt, b.lastTouchedAt));
  const over = unpinned.length - CONFIG.emergencyCap;
  if (over <= 0) return 0;
  const doomed = new Set(unpinned.slice(0, over).map(it => it.id));
  state.items = state.items.filter(it => !doomed.has(it.id));
  return doomed.size;
}

/**
 * Adds a Clip or Dump entry.
 * @returns {{item:object, merged:boolean, truncated:boolean, removed:number}|null}
 */
function addItem(kind, rawText, opts = {}) {
  let text = String(rawText == null ? '' : rawText).replace(/\r\n/g, '\n');
  if (text.trim() === '') return null;

  let truncated = false;
  if (text.length > CONFIG.maxTextLength) {
    text = text.slice(0, CONFIG.maxTextLength);
    truncated = true;
  }

  const label = kind === 'clip' ? String(opts.label || '').trim().slice(0, CONFIG.maxLabelLength) : '';
  const pinned = opts.pinned === true;

  if (kind === 'clip' && state.settings.mergeDuplicates) {
    const dup = state.items.find(it => it.kind === 'clip' && it.text === text);
    if (dup) {
      dup.createdAt = nowIso();
      if (label) dup.label = label;
      if (pinned && !dup.pinned) {
        if (countPinned() >= CONFIG.maxPinned) {
          toast('Pin limit reached (' + CONFIG.maxPinned + '). Saved without pinning.', 'warn', 4000);
        } else {
          dup.pinned = true;
        }
      }
      touch(dup);
      const removed = trimEmergency();
      saveState();
      return { item: dup, merged: true, truncated, removed };
    }
  }

  if (pinned && countPinned() >= CONFIG.maxPinned) {
    toast('Pin limit reached (' + CONFIG.maxPinned + '). Unpin one first.', 'warn');
    return null;
  }

  const now = nowIso();
  const item = {
    id: makeId(), kind, text, label,
    type: kind === 'clip' ? detectType(text) : '',
    pinned,
    createdAt: now, lastTouchedAt: now, updatedAt: now,
    usedAt: null, useCount: 0, archivedAt: null
  };
  state.items.unshift(item);

  const removed = trimEmergency();
  saveState();
  return { item, merged: false, truncated, removed };
}

/** Card tap (Clips) or menu Copy (either kind). Touches the clock either way. */
function copyItem(item) {
  return writeClipboard(item.text).then(() => {
    if (item.kind === 'clip') {
      item.usedAt = nowIso();
      item.useCount = (item.useCount || 0) + 1;
    }
    touch(item);
    saveState();
    return true;
  });
}

/** Edit sheet save. Touches the clock (plan 4-1: "편집 후 저장"). */
function updateItem(item, { text, label, pinned }) {
  item.text = String(text).slice(0, CONFIG.maxTextLength);
  if (item.kind === 'clip') {
    item.label = String(label || '').trim().slice(0, CONFIG.maxLabelLength);
    item.type = detectType(item.text);
  }
  item.pinned = pinned;
  touch(item);
  const removed = trimEmergency();
  saveState();
  return removed;
}

/** Pin toggle. Only unpinning touches the clock — pinning freezes it instead. */
function togglePin(item) {
  if (!item.pinned && countPinned() >= CONFIG.maxPinned) {
    toast('Pin limit reached (' + CONFIG.maxPinned + '). Unpin one first.', 'warn');
    return false;
  }
  item.pinned = !item.pinned;
  if (!item.pinned) touch(item);
  trimEmergency();
  saveState();
  return true;
}

/** Clips ↔ Dump. Touches the clock (plan 4-1). */
function moveItemKind(item, toKind) {
  item.kind = toKind;
  if (toKind === 'dump') {
    item.label = '';
    item.type = '';
  } else {
    item.type = detectType(item.text);
  }
  touch(item);
  saveState();
}

function deleteItem(item) {
  state.items = state.items.filter(it => it.id !== item.id);
  state.deleted = (state.deleted || []).concat([{ id: item.id, at: nowIso() }]);
  saveState();
}

/* ── 5. retention (plan 4장) ──────────────────────────────────────────── */

function isExpired(item, retentionDays) {
  if (item.pinned || !retentionDays) return false;
  const t = new Date(item.lastTouchedAt).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t >= retentionDays * 24 * 60 * 60 * 1000;
}

/** Days left before expiry, or null if pinned / retention is "Never". */
function daysLeft(item, retentionDays) {
  if (item.pinned || !retentionDays) return null;
  const t = new Date(item.lastTouchedAt).getTime();
  if (isNaN(t)) return null;
  const deadline = t + retentionDays * 24 * 60 * 60 * 1000;
  return Math.ceil((deadline - Date.now()) / (24 * 60 * 60 * 1000));
}

function recordCleanupTime() {
  try { localStorage.setItem(CONFIG.cleanupTimeKey, nowIso()); } catch (e) { /* ignore */ }
}
function getLastCleanupTime() {
  try { return localStorage.getItem(CONFIG.cleanupTimeKey); } catch (e) { return null; }
}

function autoCleanupDue() {
  if (state.settings.retentionDays === 0) return false;
  if (!isSyncEnabled()) return false; // can't archive without sync — see performCleanup
  const last = getLastCleanupTime();
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= CONFIG.cleanupCheckIntervalMs;
}

/**
 * Archives items to tide/archive/<YYYY-MM>.json (grouped by createdAt month,
 * read → merge → write so an existing month's records are never clobbered —
 * sync.js has no append API). On success, stamps archivedAt on each item and
 * saves BEFORE the caller deletes them, so a crash between "uploaded" and
 * "deleted locally" is recoverable without re-uploading (plan 5-1 note).
 */
async function archiveItems(items) {
  if (!window.SharedSync) return false;
  const token = getSyncToken();
  if (!token) return false;

  const byMonth = {};
  items.forEach(it => {
    const m = it.createdAt.slice(0, 7);
    (byMonth[m] = byMonth[m] || []).push(it);
  });

  const config = syncConfig();
  const stamp = nowIso();
  try {
    for (const month of Object.keys(byMonth)) {
      const path = SYNC.archiveDir + '/' + month + '.json';
      const existing = await window.SharedSync.readFile(config, path);
      let arr = [];
      if (existing && existing.exists && existing.content) {
        try { arr = JSON.parse(existing.content); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
      }
      const records = byMonth[month].map(it => ({
        id: it.id, kind: it.kind, text: it.text, createdAt: it.createdAt, archivedAt: stamp
      }));
      await window.SharedSync.writeFile(config, path, JSON.stringify(arr.concat(records), null, 2), {
        sha: existing && existing.sha,
        message: 'archive: tide ' + month
      });
    }
  } catch (e) {
    return false;
  }

  items.forEach(it => { it.archivedAt = stamp; });
  saveState();
  return true;
}

/**
 * Runs a cleanup pass: archive expired items, then delete only what was
 * confirmed archived. "Nothing anywhere is deleted without an archive" is
 * the hard rule (plan 4-5) — if sync/archive isn't available, this only
 * ever deletes when the user explicitly confirms via the manual button.
 */
async function performCleanup(opts = {}) {
  const silent = opts.silent === true;

  // Recovery: items already stamped archivedAt from a run that crashed
  // between "uploaded" and "deleted locally" — safe to delete, no re-upload.
  const leftover = state.items.filter(it => it.archivedAt);
  if (leftover.length) {
    const ids = new Set(leftover.map(it => it.id));
    const now = nowIso();
    state.deleted = (state.deleted || []).concat(leftover.map(it => ({ id: it.id, at: now })));
    state.items = state.items.filter(it => !ids.has(it.id));
    saveState();
  }

  const retentionDays = state.settings.retentionDays;
  if (retentionDays === 0) {
    if (!silent) toast('Retention is set to Never — nothing to clear.', 'warn');
    return;
  }

  const expired = state.items.filter(it => isExpired(it, retentionDays));
  if (expired.length === 0) {
    recordCleanupTime();
    if (!silent) toast('Nothing to clear.', 'ok');
    render();
    return;
  }

  if (isSyncEnabled() && getSyncToken()) {
    const ok = await archiveItems(expired);
    if (!ok) {
      if (!silent) toast('Could not reach the archive — items were kept.', 'warn', 5000);
      return;
    }
    const ids = new Set(expired.map(it => it.id));
    const now = nowIso();
    state.deleted = (state.deleted || []).concat(expired.map(it => ({ id: it.id, at: now })));
    state.items = state.items.filter(it => !ids.has(it.id));
    recordCleanupTime();
    saveState();
    toast(expired.length + ' item' + (expired.length === 1 ? '' : 's') + ' archived and cleared.', null, 3200);
    render();
    return;
  }

  // No sync available — this path only ever runs from the manual button.
  if (silent) return;
  const ok = await confirmAsk(
    'Clear expired items?',
    expired.length + ' item(s) will be deleted without a cloud archive because Sync is off. Back up first if you want to keep a copy.',
    'Delete'
  );
  if (!ok) return;
  snapshot();
  const ids = new Set(expired.map(it => it.id));
  const now = nowIso();
  state.deleted = (state.deleted || []).concat(expired.map(it => ({ id: it.id, at: now })));
  state.items = state.items.filter(it => !ids.has(it.id));
  recordCleanupTime();
  saveState();
  render();
  toastUndo(expired.length + ' item(s) cleared.');
}

async function runAutoCleanupIfDue() {
  if (!autoCleanupDue()) return;
  await performCleanup({ silent: true });
  refreshSettingsUI();
}

/* ── 6. run mode (Safari ↔ Home Screen app) + mirror cache ──────────────
   iOS keeps Home Screen app and Safari localStorage fully separate.
   Cache Storage is sometimes visible from both, so it's used as a manual
   transfer channel. If it's unavailable, this fails silently — no impact
   on the rest of the app. Carried over from clip's app.js. ─────────────── */

function runMode() {
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  return standalone ? 'app' : 'browser';
}
function modeName(mode) { return mode === 'app' ? 'Home Screen app' : 'Safari browser'; }

function writeMirror() {
  if (typeof caches === 'undefined') return;
  try {
    caches.open(CONFIG.mirrorPrefix + runMode()).then(c =>
      c.put(CONFIG.mirrorUrl, new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json' }
      }))
    ).catch(() => {});
  } catch (e) { /* ignore */ }
}

async function readMirror(mode) {
  if (typeof caches === 'undefined') return null;
  try {
    const c = await caches.open(CONFIG.mirrorPrefix + mode);
    const res = await c.match(CONFIG.mirrorUrl);
    if (!res) return null;
    return await res.json();
  } catch (e) { return null; }
}

async function pullFromOtherMode() {
  const other = runMode() === 'app' ? 'browser' : 'app';
  const data = await readMirror(other);
  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    toast('Nothing found from ' + modeName(other) + '.', 'warn', 4500);
    return;
  }
  const have = new Set(state.items.map(it => it.kind + '\u0000' + it.text));
  const fresh = normalize(data).items.filter(it => !have.has(it.kind + '\u0000' + it.text));
  if (fresh.length === 0) {
    toast('Nothing new to import.', 'ok', 3000);
    return;
  }
  const ok = await confirmAsk(
    'Import items?',
    'Adds ' + fresh.length + ' new item(s) from ' + modeName(other) + '. Nothing currently here is removed.',
    'Import'
  );
  if (!ok) return;
  snapshot();
  fresh.forEach(it => { it.id = makeId(); });
  state.items = fresh.concat(state.items);
  const removed = trimEmergency();
  saveState();
  closeSheet();
  render();
  toastUndo('Imported ' + fresh.length + ' item(s).' + (removed > 0 ? ' (' + removed + ' old ones cleared)' : ''));
}

/* ── 7. storage persistence request ──────────────────────────────────────
   WebKit may clear localStorage after 7 days without interaction.
   navigator.storage.persist() asks for protection; failure is silent. ─── */

let persistStatusText = 'Checking…';

async function ensurePersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) { persistStatusText = 'Unavailable'; return; }
    if (await navigator.storage.persisted()) { persistStatusText = 'Protected'; return; }
    persistStatusText = (await navigator.storage.persist()) ? 'Protected' : 'Not protected';
  } catch (e) {
    persistStatusText = 'Unavailable';
  } finally {
    refreshStorageLine();
  }
}
function refreshStorageLine() {
  if (!el['storage-line']) return;
  el['storage-line'].textContent = 'Storage protection: ' + persistStatusText;
  el['storage-line'].classList.toggle('warn', persistStatusText !== 'Protected');
}

/* ── 8. clipboard ──────────────────────────────────────────────────────── */

async function readClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
  return await navigator.clipboard.readText();
}
function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('unsupported'));
}

/* ── 9. URL intake (?add= / ?dump=) ──────────────────────────────────────
   ?add=   → Clips, switches to the Clips tab (plan 6-1)
   ?dump=  → Dump, stays wherever the user is; kept ready for a second
             Shortcut later without needing a redeploy (plan 9장). ───────── */

function handleUrlIntake() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (e) { return; }

  const add = params.get('add');
  const dump = params.get('dump');
  if (add == null && dump == null) return;

  try { history.replaceState({}, '', location.pathname + location.hash); } catch (e) { /* ignore */ }

  if (add != null) {
    switchTab('clips', { silent: true });
    const pin = params.get('pin') === '1';
    const label = params.get('label') || '';
    const res = addItem('clip', add, { pinned: pin, label });
    if (!res) {
      if (String(add).trim() === '') toast('Nothing to add — the clip was empty.', 'warn');
      return;
    }
    render();
    flashCard(res.item.id);
    afterAddToast(res, 'clip');
    return;
  }

  if (dump != null) {
    const res = addItem('dump', dump, {});
    if (!res) {
      if (String(dump).trim() === '') toast('Nothing to add — the entry was empty.', 'warn');
      return;
    }
    switchTab('dump', { silent: true });
    render();
    flashCard(res.item.id);
    afterAddToast(res, 'dump');
  }
}

/* ── 10. draft (Dump, plan 6-3) ───────────────────────────────────────── */

function loadDraft() {
  try { return localStorage.getItem(CONFIG.draftKey) || ''; } catch (e) { return ''; }
}
function saveDraft(text) {
  try {
    if (text) localStorage.setItem(CONFIG.draftKey, text);
    else localStorage.removeItem(CONFIG.draftKey);
  } catch (e) { /* ignore */ }
}

/* ── 11. cache / tabs ─────────────────────────────────────────────────── */

const el = {};
function cache() {
  [
    'btn-settings', 'tab-clips', 'tab-dump', 'dump-count',
    'search', 'btn-clear-search',
    'panel-clips', 'panel-dump',
    'btn-paste', 'btn-write',
    'group-clips-pinned', 'list-clips-pinned', 'count-clips-pinned',
    'group-clips-recent', 'list-clips-recent',
    'empty-clips', 'empty-clips-search',
    'dump-input', 'btn-dump-add', 'dump-count-hint',
    'group-dump-pinned', 'list-dump-pinned', 'count-dump-pinned', 'dump-groups',
    'empty-dump', 'empty-dump-search',
    'sheet-edit', 'edit-title', 'edit-label-wrap', 'edit-label', 'edit-text', 'edit-count', 'edit-pinned', 'btn-save-edit',
    'sheet-view', 'view-text', 'btn-view-copy',
    'sheet-settings', 'sheet-guide', 'sheet-menu', 'menu-preview', 'menu-list',
    'modal-confirm', 'confirm-title', 'confirm-desc', 'btn-confirm-yes', 'btn-confirm-no',
    'toast-wrap', 'app-url', 'guide-url', 'btn-copy-url', 'btn-copy-url2', 'btn-open-guide',
    'btn-fontstep-reset', 'retention-group', 'btn-clear-expired', 'cleanup-line', 'set-merge',
    'btn-export-json', 'btn-import-json', 'btn-export-csv', 'file-import', 'btn-wipe',
    'mode-line', 'btn-pull-other', 'pull-other-hint', 'storage-line', 'backup-line',
    'sync-toggle', 'sync-token', 'btn-sync-token-save', 'btn-sync-token-clear', 'sync-token-display',
    'sync-context-name', 'btn-sync-context-save', 'sync-context-note',
    'sync-status-line', 'sync-outbox-line', 'sync-error-line', 'btn-sync-now'
  ].forEach(id => { el[id] = document.getElementById(id); });
}

function switchTab(tab, opts) {
  const silent = opts && opts.silent;
  const initial = opts && opts.initial;
  el['tab-clips'].setAttribute('aria-selected', String(tab === 'clips'));
  el['tab-dump'].setAttribute('aria-selected', String(tab === 'dump'));
  el['panel-clips'].classList.toggle('hidden', tab !== 'clips');
  el['panel-dump'].classList.toggle('hidden', tab !== 'dump');
  el['search'].value = '';
  currentQuery = '';
  el['btn-clear-search'].classList.add('hidden');
  if (!silent) { state.settings.lastTab = tab; saveState(); }
  render();
  // Plan 6-3: entering Dump should put the cursor in the input immediately.
  // iOS Safari only opens the keyboard for focus() called SYNCHRONOUSLY
  // inside the click handler's own call stack — a setTimeout (even 0ms)
  // detaches it from the user gesture and the keyboard silently refuses to
  // open. The panel is already un-hidden above (synchronously, in this same
  // stack), so calling focus() here — no timer, no await between the click
  // and this line — satisfies both conditions at once. Skipped on the
  // initial page-load restore, where there's no click to attach to and
  // popping the keyboard unasked for would be unwelcome.
  if (tab === 'dump' && !initial) {
    el['dump-input'].focus();
  }
}

/* ── 12. render helpers ───────────────────────────────────────────────── */

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function oneLine(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function relTime(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + 'd ago';
  const d = new Date(then);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
function timeOfDay(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function dateGroupLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const dOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const nOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((nOnly - dOnly) / oneDay);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function daysBadge(item) {
  const d = daysLeft(item, state.settings.retentionDays);
  if (d === null || d > 3) return '';
  const shown = Math.max(d, 0);
  return '<span class="badge warn">' + shown + 'd</span>';
}

function clipCardHtml(item) {
  const label = item.label ? '<span class="card-label">' + esc(item.label) + '</span>' : '';
  const badge = '<span class="badge">' + esc(TYPE_LABEL[item.type] || 'Text') + '</span>';
  return '' +
    '<article class="card' + (item.pinned ? ' pinned' : '') + '" data-id="' + esc(item.id) + '">' +
      '<button type="button" class="card-main" data-act="copy" ' +
        'aria-label="Copy: ' + esc(oneLine(item.text).slice(0, 60)) + '">' +
        label +
        '<span class="card-text clamp-2">' + esc(item.text) + '</span>' +
        '<span class="card-meta">' + badge + daysBadge(item) +
          '<span>' + esc(relTime(item.createdAt)) + '</span>' +
        '</span>' +
      '</button>' +
      '<button type="button" class="card-more" data-act="menu" aria-label="Open menu">⋯</button>' +
    '</article>';
}

function dumpCardHtml(item) {
  return '' +
    '<article class="card' + (item.pinned ? ' pinned' : '') + '" data-id="' + esc(item.id) + '">' +
      '<button type="button" class="card-main" data-act="expand" ' +
        'aria-label="Open: ' + esc(oneLine(item.text).slice(0, 60)) + '">' +
        '<span class="card-meta"><span class="card-time">' + esc(timeOfDay(item.createdAt)) + '</span>' + daysBadge(item) + '</span>' +
        '<span class="card-text">' + esc(item.text) + '</span>' +
      '</button>' +
      '<button type="button" class="card-more" data-act="menu" aria-label="Open menu">⋯</button>' +
    '</article>';
}

let currentQuery = '';

function matchesQuery(it, q) {
  if (!q) return true;
  return it.text.toLowerCase().includes(q) || (it.label || '').toLowerCase().includes(q);
}

function renderClips() {
  const q = currentQuery.trim().toLowerCase();
  const list = itemsOfKind('clip').filter(it => matchesQuery(it, q));
  const pinned = sortedPinned(list);
  const recent = sortedByCreated(list);

  el['list-clips-pinned'].innerHTML = pinned.map(clipCardHtml).join('');
  el['list-clips-recent'].innerHTML = recent.map(clipCardHtml).join('');
  el['group-clips-pinned'].classList.toggle('hidden', pinned.length === 0);
  el['group-clips-recent'].classList.toggle('hidden', recent.length === 0);
  el['count-clips-pinned'].textContent = pinned.length;

  const nothing = pinned.length === 0 && recent.length === 0;
  el['empty-clips'].classList.toggle('hidden', !(nothing && !q));
  el['empty-clips-search'].classList.toggle('hidden', !(nothing && !!q));
}

function renderDump() {
  const q = currentQuery.trim().toLowerCase();
  const list = itemsOfKind('dump').filter(it => matchesQuery(it, q));
  const pinned = sortedPinned(list);
  const rest = list.filter(it => !it.pinned).sort((a, b) => cmpDesc(a.createdAt, b.createdAt));

  el['list-dump-pinned'].innerHTML = pinned.map(dumpCardHtml).join('');
  el['group-dump-pinned'].classList.toggle('hidden', pinned.length === 0);
  el['count-dump-pinned'].textContent = pinned.length;

  const groups = [];
  let curLabel = null, curBucket = null;
  rest.forEach(it => {
    const label = dateGroupLabel(it.createdAt);
    if (label !== curLabel) { curLabel = label; curBucket = []; groups.push({ label, items: curBucket }); }
    curBucket.push(it);
  });
  el['dump-groups'].innerHTML = groups.map(g =>
    '<section class="group"><h2 class="date-head">' + esc(g.label) + '</h2>' +
    '<div class="cards">' + g.items.map(dumpCardHtml).join('') + '</div></section>'
  ).join('');

  const unpinnedCount = countDumpUnpinned();
  el['dump-count'].textContent = unpinnedCount;
  el['dump-count'].classList.toggle('hidden', unpinnedCount === 0);

  const nothing = pinned.length === 0 && rest.length === 0;
  el['empty-dump'].classList.toggle('hidden', !(nothing && !q));
  el['empty-dump-search'].classList.toggle('hidden', !(nothing && !!q));
}

function render() {
  renderClips();
  renderDump();
}

function flashCard(id) {
  const node = document.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
  if (!node) return;
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 900);
}

/* ── 13. sheets / focus trap / toast / confirm (from clip's app.js) ─────── */

let openSheetEl = null;
let lastFocus = null;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openSheet(node) {
  if (!openSheetEl) lastFocus = document.activeElement;
  node.classList.remove('hidden');
  openSheetEl = node;
  document.body.style.overflow = 'hidden';
  const first = node.querySelector('input, textarea, button');
  if (first && !/iPhone|iPad|iPod/.test(navigator.userAgent)) first.focus();
}
function closeSheet() {
  if (!openSheetEl) return;
  openSheetEl.classList.add('hidden');
  openSheetEl = null;
  document.body.style.overflow = '';
  if (lastFocus && document.contains(lastFocus) && typeof lastFocus.focus === 'function') lastFocus.focus();
  lastFocus = null;
}
function trapFocus(container, ev) {
  const nodes = Array.prototype.filter.call(
    container.querySelectorAll(FOCUSABLE),
    n => n.offsetWidth > 0 || n.offsetHeight > 0 || n === document.activeElement
  );
  if (nodes.length === 0) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (!container.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
}
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  root.style.setProperty('--vvh', vv.height + 'px');
  root.style.setProperty('--vvt', vv.offsetTop + 'px');
}
function toast(message, kind, ms) {
  const box = document.createElement('div');
  box.className = 'toast' + (kind ? ' ' + kind : '');
  const span = document.createElement('span');
  span.className = 'toast-text';
  span.textContent = message;
  box.appendChild(span);
  el['toast-wrap'].appendChild(box);
  setTimeout(() => box.remove(), ms || 2600);
  return box;
}
function afterAddToast(res, kind) {
  if (res.truncated) {
    toast('Text was long — saved the first ' + CONFIG.maxTextLength.toLocaleString() + ' characters.', 'warn', 6000);
  } else if (res.merged) {
    toast('Already had this — moved it to the top.', 'ok');
  } else {
    toast(kind === 'dump' ? 'Added.' : 'Saved.', 'ok', 1800);
  }
}
let undoSnapshot = null, undoTimer = null;
function snapshot() { undoSnapshot = JSON.stringify({ items: state.items, deleted: state.deleted, settings: state.settings }); }
function restoreSnapshot() {
  if (!undoSnapshot) return;
  try {
    const snap = JSON.parse(undoSnapshot);
    state.items = Array.isArray(snap.items) ? snap.items : [];
    state.deleted = Array.isArray(snap.deleted) ? snap.deleted : state.deleted;
    if (snap.settings) state.settings = snap.settings;
    saveState();
    refreshSettingsUI();
    render();
    toast('Undone.', 'ok');
  } catch (e) {
    toast('Could not undo.', 'err');
  }
  undoSnapshot = null;
}
function toastUndo(message) {
  if (undoTimer) clearTimeout(undoTimer);
  const box = toast(message, null, CONFIG.undoMs);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = 'Undo';
  btn.addEventListener('click', () => { restoreSnapshot(); box.remove(); });
  box.appendChild(btn);
  undoTimer = setTimeout(() => { undoSnapshot = null; }, CONFIG.undoMs);
}
let confirmResolve = null;
function confirmAsk(title, desc, yesText) {
  el['confirm-title'].textContent = title;
  el['confirm-desc'].textContent = desc;
  el['btn-confirm-yes'].textContent = yesText || 'Delete';
  el['modal-confirm'].classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  return new Promise(resolve => { confirmResolve = resolve; });
}
function confirmClose(answer) {
  el['modal-confirm'].classList.add('hidden');
  if (!openSheetEl) document.body.style.overflow = '';
  if (confirmResolve) { confirmResolve(answer); confirmResolve = null; }
}

/* ── 14. editor sheet (Write / Edit, shared by Clips + Dump) ────────────── */

let editingId = null;
let editingKind = 'clip';

function openEditor(kind, item) {
  editingId = item ? item.id : null;
  editingKind = item ? item.kind : kind;
  const isClip = editingKind === 'clip';
  el['edit-title'].textContent = item ? 'Edit' : (isClip ? 'Write' : 'New entry');
  el['edit-label-wrap'].classList.toggle('hidden', !isClip);
  el['edit-label'].classList.toggle('hidden', !isClip);
  el['edit-label'].value = item ? (item.label || '') : '';
  el['edit-text'].value = item ? item.text : '';
  el['edit-pinned'].checked = item ? item.pinned : false;
  updateEditCount();
  openSheet(el['sheet-edit']);
  if (!item) setTimeout(() => el['edit-text'].focus(), 120);
}
function updateEditCount() {
  const n = el['edit-text'].value.length;
  el['edit-count'].textContent = n.toLocaleString() + ' characters'
    + (n > CONFIG.maxTextLength ? ' · only the first ' + CONFIG.maxTextLength.toLocaleString() + ' will be saved' : '');
}
function saveEditor() {
  const text = el['edit-text'].value;
  const label = el['edit-label'].value;
  const pinned = el['edit-pinned'].checked;
  if (text.trim() === '') { toast('Text is empty.', 'warn'); el['edit-text'].focus(); return; }

  if (editingId) {
    const item = findItem(editingId);
    if (!item) { closeSheet(); return; }
    if (!item.pinned && pinned && countPinned() >= CONFIG.maxPinned) {
      toast('Pin limit reached (' + CONFIG.maxPinned + ').', 'warn');
      return;
    }
    snapshot();
    updateItem(item, { text, label, pinned });
    closeSheet();
    render();
    toast('Saved.', 'ok');
  } else {
    const res = addItem(editingKind, text, { label, pinned });
    if (!res) return;
    closeSheet();
    render();
    flashCard(res.item.id);
    afterAddToast(res, editingKind);
  }
}

/* ── 15. Clips: paste / card menu ────────────────────────────────────────── */

async function pasteFromClipboard() {
  try {
    const text = await readClipboard();
    if (!text || text.trim() === '') { toast('Clipboard is empty.', 'warn'); return; }
    const res = addItem('clip', text, {});
    if (!res) return;
    render();
    flashCard(res.item.id);
    afterAddToast(res, 'clip');
  } catch (e) {
    toast('Could not read the clipboard. Paste it below instead.', 'warn', 4000);
    openEditor('clip', null);
  }
}

function openMenu(item) {
  const isClip = item.kind === 'clip';
  el['menu-preview'].textContent = (item.label || item.text.slice(0, 60));
  const actions = [];
  actions.push({ key: 'pin', text: item.pinned ? '📌 Unpin' : '📌 Pin' });
  actions.push({ key: 'copy', text: '⧉ Copy' });
  actions.push({ key: 'edit', text: '✎ Edit' });
  actions.push({ key: 'view', text: '🔍 View full text' });
  if (isClip && item.type === 'url') actions.push({ key: 'open', text: '↗ Open link' });
  if (isClip && item.type === 'email') actions.push({ key: 'mail', text: '✉ Compose email' });
  if (isClip && item.type === 'phone') actions.push({ key: 'tel', text: '☎ Call' });
  actions.push({ key: 'move', text: isClip ? '↷ Move to Dump' : '↷ Keep as clip' });
  actions.push({ key: 'delete', text: '🗑 Delete', danger: true });

  el['menu-list'].innerHTML = actions.map(a =>
    '<button type="button" class="menu-item' + (a.danger ? ' danger' : '') + '" data-menu="' + a.key + '">' + esc(a.text) + '</button>'
  ).join('');
  el['sheet-menu'].dataset.id = item.id;
  openSheet(el['sheet-menu']);
}

async function runMenuAction(key, item) {
  if (key === 'pin') {
    const ok = togglePin(item);
    closeSheet();
    if (ok) { render(); toast(item.pinned ? 'Pinned.' : 'Unpinned.', 'ok'); }
    return;
  }
  if (key === 'copy') {
    closeSheet();
    try {
      await copyItem(item);
      flashCard(item.id);
      toast('Copied.', 'ok', 1800);
    } catch (e) {
      el['view-text'].value = item.text;
      openSheet(el['sheet-view']);
      setTimeout(() => el['view-text'].select(), 150);
    }
    render();
    return;
  }
  if (key === 'edit') { closeSheet(); openEditor(item.kind, item); return; }
  if (key === 'view') { closeSheet(); el['view-text'].value = item.text; openSheet(el['sheet-view']); return; }
  if (key === 'open') { closeSheet(); window.open(item.text.trim(), '_blank', 'noopener'); return; }
  if (key === 'mail') { closeSheet(); location.href = 'mailto:' + item.text.trim(); return; }
  if (key === 'tel') { closeSheet(); location.href = 'tel:' + item.text.replace(/[^\d+]/g, ''); return; }
  if (key === 'move') {
    closeSheet();
    const toKind = item.kind === 'clip' ? 'dump' : 'clip';
    moveItemKind(item, toKind);
    render();
    toast(toKind === 'dump' ? 'Moved to Dump.' : 'Kept as a clip.', 'ok');
    return;
  }
  if (key === 'delete') {
    closeSheet();
    const ok = await confirmAsk('Delete this item?', item.label || item.text.slice(0, 80), 'Delete');
    if (!ok) return;
    snapshot();
    deleteItem(item);
    render();
    toastUndo('Deleted.');
  }
}

/* ── 16. Dump: input row ─────────────────────────────────────────────── */

let composing = false; // guards against IME (Korean input) truncation on Add

function updateDumpHint() {
  const n = el['dump-input'].value.length;
  el['dump-count-hint'].textContent = n > 0 ? n.toLocaleString() + ' / ' + CONFIG.maxTextLength.toLocaleString() : '';
}

function submitDump() {
  if (composing) return; // Add pressed mid-IME-composition — wait for compositionend
  const text = el['dump-input'].value;
  if (text.trim() === '') return;
  const res = addItem('dump', text, {});
  if (!res) return;
  el['dump-input'].value = '';
  saveDraft('');
  updateDumpHint();
  el['dump-input'].focus();
  render();
  flashCard(res.item.id);
  afterAddToast(res, 'dump');
}

function expandDump(item) {
  el['view-text'].value = item.text;
  openSheet(el['sheet-view']);
}

/* ── 17. settings: text size / retention / shortcut URLs ────────────────── */

function applyFontStep() {
  const px = CONFIG.fontStepPx[state.settings.fontStep] || CONFIG.fontStepPx[CONFIG.defaultFontStep];
  document.documentElement.style.setProperty('--fs-root', px + 'px');
  document.querySelectorAll('.seg-btn[data-step]').forEach(b => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.step) === state.settings.fontStep));
  });
}
function applyRetentionUI() {
  document.querySelectorAll('.seg-btn[data-retention]').forEach(b => {
    b.setAttribute('aria-pressed', String(Number(b.dataset.retention) === state.settings.retentionDays));
  });
}
function baseUrl() { return location.origin + location.pathname.replace(/index\.html$/, ''); }
function appUrl() { return baseUrl() + '?add='; }

function backupAgoText(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

function refreshCleanupLine() {
  if (!el['cleanup-line']) return;
  const last = getLastCleanupTime();
  el['cleanup-line'].textContent = 'Last cleanup: ' + (last ? backupAgoText(last) : 'never');
}

function refreshSettingsUI() {
  applyFontStep();
  applyRetentionUI();
  if (!el['set-merge']) return;
  el['set-merge'].checked = state.settings.mergeDuplicates;
  el['app-url'].textContent = appUrl();
  el['guide-url'].textContent = appUrl();
  refreshCleanupLine();

  const mode = runMode();
  el['mode-line'].textContent = mode === 'app'
    ? 'Running in: Home Screen app — items saved via the Shortcut won’t show up here'
    : 'Running in: Safari browser — same storage the Shortcut uses';
  el['mode-line'].classList.toggle('warn', mode === 'app');
  el['btn-pull-other'].textContent = 'Import from ' + modeName(mode === 'app' ? 'browser' : 'app');
  const syncOn = isSyncEnabled();
  el['btn-pull-other'].classList.toggle('hidden', syncOn);
  el['pull-other-hint'].classList.toggle('hidden', syncOn);

  refreshStorageLine();
  refreshBackupLine();
  refreshSyncUI();
}

/* ── 18. backup / restore / CSV (plan 5-2, 4-4-①) ────────────────────── */

function todayStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
async function exportFile(filename, content, mime) {
  try {
    const file = new File([content], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false;
  }
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
    return true;
  } catch (e) {
    toast('Could not create the file.', 'err');
    return false;
  }
}

/** Backup body deliberately excludes lastCleanupAt/lastBackupAt/sync fields
    (plan 5-2) — those live in separate keys so restoring an old backup can
    never rewind "last cleanup" or "last backup" into the past. */
async function exportJson() {
  const payload = JSON.stringify({
    version: CONFIG.schema, app: 'tide', savedAt: nowIso(),
    items: state.items, deleted: state.deleted, settings: state.settings
  }, null, 2);
  const ok = await exportFile(CONFIG.fileBase + '-backup-' + todayStamp() + '.json', payload, 'application/json');
  if (ok) { recordBackupTime(); refreshBackupLine(); }
}
function recordBackupTime() {
  try { localStorage.setItem(CONFIG.backupTimeKey, nowIso()); } catch (e) { /* ignore */ }
}
function getLastBackupTime() {
  try { return localStorage.getItem(CONFIG.backupTimeKey); } catch (e) { return null; }
}
function refreshBackupLine() {
  if (!el['backup-line']) return;
  const backupAt = getLastBackupTime();
  const overdue = !backupAt || (Date.now() - new Date(backupAt).getTime()) >= 7 * 24 * 60 * 60 * 1000;
  const base = backupAt ? 'Last backup: ' + backupAgoText(backupAt) : 'Last backup: never';
  el['backup-line'].textContent = base + (overdue ? ' · backup recommended' : '');
  el['backup-line'].classList.toggle('warn', overdue);
}
function exportCsv() {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['kind', 'label', 'text', 'type', 'pinned', 'createdAt']];
  state.items
    .slice()
    .sort((a, b) => cmpDesc(a.createdAt, b.createdAt))
    .forEach(it => rows.push([it.kind, it.label, it.text, TYPE_LABEL[it.type] || '', it.pinned ? 'Y' : 'N', it.createdAt]));
  const csv = '﻿' + rows.map(r => r.map(q).join(',')).join('\r\n');
  exportFile(CONFIG.fileBase + '-' + todayStamp() + '.csv', csv, 'text/csv');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    let data;
    try { data = JSON.parse(String(reader.result)); }
    catch (e) { toast('Could not read the JSON file.', 'err', 4000); return; }
    if (!data || !Array.isArray(data.items)) { toast('This is not a Tide backup file.', 'err', 4000); return; }
    if (Number(data.version) > CONFIG.schema) { toast('This backup is from a newer version — update Tide first.', 'warn', 5000); return; }

    let desc = 'The ' + state.items.length + ' item(s) here will be replaced by the ' + data.items.length + ' in the backup.';
    if (isSyncEnabled()) desc += ' Sync is on, so other devices will pick up this change too.';
    const ok = await confirmAsk('Restore this backup?', desc, 'Restore');
    if (!ok) return;

    snapshot();
    const restoreTime = nowIso();
    // Plan 4-4-①: an old backup's items are all past their retention period
    // already — reset the clock to the restore moment so they don't all
    // vanish on the very next cleanup pass.
    const next = normalize(data);
    next.items.forEach(it => { it.lastTouchedAt = restoreTime; it.updatedAt = restoreTime; it.archivedAt = null; });

    const keepIds = new Set(next.items.map(it => it.id));
    const removalTombs = state.items.filter(it => !keepIds.has(it.id)).map(it => ({ id: it.id, at: restoreTime }));
    state.items = next.items;
    state.deleted = (state.deleted || []).concat(next.deleted || []).concat(removalTombs);
    state.settings = next.settings;
    trimEmergency();
    saveState();
    refreshSettingsUI();
    render();
    toastUndo('Restored. ' + state.items.length + ' item(s).');
  };
  reader.onerror = () => toast('Could not read the file.', 'err');
  reader.readAsText(file);
}

async function wipeAll() {
  const ok1 = await confirmAsk('Delete everything?', 'Pinned items are deleted too. Back up first if you want to keep a copy.', 'Continue');
  if (!ok1) return;
  let desc = state.items.length + ' item(s) will all be deleted.';
  if (isSyncEnabled()) desc += ' Sync is on, so other devices will lose them too.';
  const ok2 = await confirmAsk('Are you sure?', desc, 'Delete all');
  if (!ok2) return;
  snapshot();
  const now = nowIso();
  state.deleted = (state.deleted || []).concat(state.items.map(it => ({ id: it.id, at: now })));
  state.items = [];
  saveState();
  render();
  toastUndo('Deleted everything.');
}

/* ── 19. cross-device sync (plan 4-5, 5-1, 5-3) ──────────────────────────
   Writes full snapshots to webapp-data/tide/data.<contextId>.json, one file
   per storage context (Safari and the Home Screen app are separate
   contexts even on the same iPhone). Reading merges every context's file.
   Each item's own updatedAt decides which version of a conflicting item
   wins; lastTouchedAt is never invented by the merge itself (plan 4-4-②).
   ────────────────────────────────────────────────────────────────────── */

const SYNC = {
  namespace: 'tide',
  owner: 'jennie-verse',
  repo: 'webapp-data',
  branch: 'main',
  dirPath: 'tide',
  basePath: 'tide/data.json',
  archiveDir: 'tide/archive',
  enabledKey: 'tide.syncEnabled',
  tokenKey: 'sync.token.v1',
  lastSyncKey: 'tide.lastSyncAt',
  debounceMs: 4000,
  tombstoneMaxDays: 90
};

let syncPushTimer = null;
let syncLastError = null;

function isSyncEnabled() { try { return localStorage.getItem(SYNC.enabledKey) === '1'; } catch (e) { return false; } }
function setSyncEnabled(v) { try { localStorage.setItem(SYNC.enabledKey, v ? '1' : '0'); } catch (e) { /* ignore */ } }
function getSyncToken() { try { return localStorage.getItem(SYNC.tokenKey) || ''; } catch (e) { return ''; } }
function setSyncToken(v) {
  try { if (v) localStorage.setItem(SYNC.tokenKey, v); else localStorage.removeItem(SYNC.tokenKey); } catch (e) { /* ignore */ }
}
function syncConfig() { return { owner: SYNC.owner, repo: SYNC.repo, token: getSyncToken(), branch: SYNC.branch }; }
async function resolveSyncConfig() { return syncConfig(); }
function getSyncContextId() { try { return localStorage.getItem(SYNC.namespace + '.syncContextId'); } catch (e) { return null; } }
function getSyncContextLabel() { try { return localStorage.getItem(SYNC.namespace + '.syncContextLabel') || ''; } catch (e) { return ''; } }

function cleanupTombstones() {
  if (!Array.isArray(state.deleted) || state.deleted.length === 0) return;
  const cutoff = Date.now() - SYNC.tombstoneMaxDays * 24 * 60 * 60 * 1000;
  state.deleted = state.deleted.filter(d => { const t = new Date(d.at).getTime(); return !isNaN(t) && t >= cutoff; });
}

function describeSyncError(err) {
  if (!err) return 'Unknown error';
  if (err.type === 'auth') return 'The token is invalid or expired.';
  if (err.type === 'network') return 'A network error stopped the request.';
  if (err.type === 'notfound') return 'The repository was not found. Check the name.';
  if (err.type === 'conflict') return 'A conflict happened and retrying failed.';
  return err.message || 'Unknown error';
}
function setSyncError(msg) { syncLastError = msg; }
function markSyncedNow() {
  syncLastError = null;
  try { localStorage.setItem(SYNC.lastSyncKey, nowIso()); } catch (e) { /* ignore */ }
}

function mergeRemote(remoteFiles) {
  const mergeNow = nowIso();
  const itemMap = new Map();
  const tombMap = new Map();

  const addItems = (items, fallback) => {
    (items || []).forEach(raw => {
      if (!raw || typeof raw.id !== 'string' || !raw.id) return;
      const it = normalizeItem(raw, fallback ? { fallbackTouchedAt: fallback } : {});
      const existing = itemMap.get(it.id);
      if (!existing || new Date(it.updatedAt) > new Date(existing.updatedAt)) itemMap.set(it.id, it);
    });
  };
  const addTombs = (deleted) => {
    (deleted || []).forEach(raw => {
      if (!raw || typeof raw.id !== 'string' || !raw.id || !raw.at) return;
      const at = isoOr(raw.at);
      const existing = tombMap.get(raw.id);
      if (!existing || new Date(at) > new Date(existing)) tombMap.set(raw.id, at);
    });
  };

  addItems(state.items, null);
  addTombs(state.deleted);
  remoteFiles.forEach(f => { addItems(f && f.items, mergeNow); addTombs(f && f.deleted); });

  const merged = [];
  itemMap.forEach((item, id) => {
    const tombAt = tombMap.get(id);
    if (tombAt && new Date(tombAt) > new Date(item.updatedAt)) return;
    merged.push(item);
  });
  const tombList = [];
  tombMap.forEach((at, id) => tombList.push({ id, at }));

  state.items = merged;
  state.deleted = tombList;
}

async function ensureSyncContextId() {
  if (!window.SharedSync) return null;
  const existing = await window.SharedSync.getContextId(SYNC.namespace);
  if (existing) return existing;
  const label = el['sync-context-name'] ? el['sync-context-name'].value.trim() : '';
  return window.SharedSync.ensureContextId(SYNC.namespace, () => label);
}

async function pullAndMerge() {
  if (!window.SharedSync || !isSyncEnabled()) return;
  const token = getSyncToken();
  if (!token) { setSyncError('No token — could not sync.'); refreshSyncUI(); return; }
  const contextId = getSyncContextId();
  if (!contextId) return;

  const config = syncConfig();
  try {
    const dir = await window.SharedSync.listDir(config, SYNC.dirPath);
    const files = dir.filter(f => f.type === 'file' && /^data\..+\.json$/.test(f.name));
    const remoteFiles = [];
    for (const f of files) {
      const res = await window.SharedSync.readFile(config, f.path);
      if (res && res.exists && res.content) {
        try { remoteFiles.push(JSON.parse(res.content)); } catch (e) { /* skip corrupt file */ }
      }
    }
    mergeRemote(remoteFiles);
    trimEmergency();
    saveState();
    render();
    markSyncedNow();
  } catch (e) {
    setSyncError(describeSyncError(e));
  }
  refreshSyncUI();
}

function schedulePush() {
  if (syncPushTimer) clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => { syncPushTimer = null; pushNow(); }, SYNC.debounceMs);
}
function flushPendingPush() {
  if (!syncPushTimer) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = null;
  pushNow();
}
async function pushNow() {
  if (!window.SharedSync || !isSyncEnabled()) return;
  const token = getSyncToken();
  if (!token) { setSyncError('No token — could not send.'); refreshSyncUI(); return; }
  const contextId = getSyncContextId();
  if (!contextId) return;

  const path = await window.SharedSync.contextFilePath(SYNC.basePath, contextId);
  const payload = JSON.stringify({
    context: contextId, updatedAt: nowIso(), items: state.items, deleted: state.deleted || []
  });
  const stamp = nowIso().slice(0, 16);

  try {
    await window.SharedSync.outboxEnqueueReplace(SYNC.namespace, { path, content: payload, message: 'sync: tide ' + stamp });
  } catch (e) {
    setSyncError('Could not queue the update.');
    refreshSyncUI();
    return;
  }
  refreshSyncOutboxCount();

  if (navigator.onLine) {
    const result = await window.SharedSync.outboxFlush(SYNC.namespace, resolveSyncConfig);
    if (result && result.error) setSyncError(describeSyncError(result.error));
    else markSyncedNow();
    refreshSyncOutboxCount();
    refreshSyncUI();
  }
}
async function refreshSyncOutboxCount() {
  if (!el['sync-outbox-line']) return;
  let n = 0;
  try { if (window.SharedSync) n = (await window.SharedSync.outboxList(SYNC.namespace)).length; } catch (e) { n = 0; }
  el['sync-outbox-line'].textContent = n + ' pending';
}

function refreshSyncUI() {
  if (!el['sync-toggle']) return;
  el['sync-toggle'].checked = isSyncEnabled();
  if (document.activeElement !== el['sync-context-name']) el['sync-context-name'].value = getSyncContextLabel();

  const token = getSyncToken();
  el['sync-token-display'].textContent = token ? ('Saved · ends in ' + token.slice(-4)) : 'No token saved';
  if (document.activeElement !== el['sync-token']) el['sync-token'].value = '';

  let lastSync = null;
  try { lastSync = localStorage.getItem(SYNC.lastSyncKey); } catch (e) { /* ignore */ }
  el['sync-status-line'].textContent = 'Last synced: ' + (lastSync ? backupAgoText(lastSync) : 'never');

  if (syncLastError) {
    el['sync-error-line'].textContent = 'Last error: ' + syncLastError;
    el['sync-error-line'].classList.remove('hidden');
  } else {
    el['sync-error-line'].classList.add('hidden');
  }
  refreshSyncOutboxCount();
}

function bindSync() {
  el['sync-toggle'].addEventListener('change', async () => {
    const turningOn = el['sync-toggle'].checked;
    if (!turningOn) {
      setSyncEnabled(false);
      refreshSyncUI();
      refreshSettingsUI();
      toast('Sync turned off.', 'ok');
      return;
    }
    if (!getSyncToken()) {
      el['sync-toggle'].checked = false;
      toast('Save a token first.', 'warn', 4000);
      return;
    }
    const contextId = await ensureSyncContextId();
    if (!contextId) {
      el['sync-toggle'].checked = false;
      toast('Could not identify this device/app.', 'err');
      return;
    }
    setSyncEnabled(true);
    refreshSyncUI();
    refreshSettingsUI();
    toast('Sync turned on.', 'ok');
    pullAndMerge();
  });

  el['btn-sync-token-save'].addEventListener('click', () => {
    const v = el['sync-token'].value.trim();
    if (!v) { toast('Enter a token.', 'warn'); return; }
    setSyncToken(v);
    el['sync-token'].value = '';
    refreshSyncUI();
    toast('Token saved.', 'ok');
  });
  el['btn-sync-token-clear'].addEventListener('click', async () => {
    // The token key is per-origin, so Atlas and Trace read the same saved value.
    const ok = await confirmAsk('Clear the token?', 'Atlas and Trace share this token, so their sync stops too. You’ll need to paste a token again to turn it back on.', 'Clear');
    if (!ok) return;
    setSyncToken('');
    setSyncEnabled(false);
    refreshSyncUI();
    toast('Token cleared.', 'ok');
  });
  el['btn-sync-context-save'].addEventListener('click', async () => {
    if (!window.SharedSync) return;
    const label = el['sync-context-name'].value.trim();
    if (!label) { toast('Enter a name.', 'warn'); return; }
    await window.SharedSync.ensureContextId(SYNC.namespace, () => label);
    await window.SharedSync.setContextLabel(SYNC.namespace, label);
    refreshSyncUI();
    toast('Name saved.', 'ok');
  });
  el['btn-sync-now'].addEventListener('click', async () => {
    if (!isSyncEnabled()) { toast('Turn on Sync first.', 'warn'); return; }
    if (!navigator.onLine) { toast('You’re offline. Try again once connected.', 'warn'); return; }
    await pullAndMerge();
    await pushNow();
  });
}

async function initSync() {
  if (!window.SharedSync) return;
  try { await window.SharedSync.ready; } catch (e) { return; }
  refreshSyncUI();

  window.SharedSync.outboxWatch(SYNC.namespace, resolveSyncConfig, {
    onFlushed: (result) => {
      if (result && result.flushed && result.flushed.length > 0) markSyncedNow();
      refreshSyncOutboxCount();
      refreshSyncUI();
    },
    onError: (err) => { setSyncError(describeSyncError(err)); refreshSyncOutboxCount(); refreshSyncUI(); }
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPendingPush(); });
  window.addEventListener('pagehide', flushPendingPush);

  if (isSyncEnabled() && getSyncToken() && getSyncContextId()) pullAndMerge();
  refreshSyncOutboxCount();
  runAutoCleanupIfDue();
}

/* ── 20. bind ─────────────────────────────────────────────────────────── */

function bind() {
  el['tab-clips'].addEventListener('click', () => switchTab('clips'));
  el['tab-dump'].addEventListener('click', () => switchTab('dump'));

  el['search'].addEventListener('input', () => {
    currentQuery = el['search'].value;
    el['btn-clear-search'].classList.toggle('hidden', !currentQuery);
    render();
  });
  el['btn-clear-search'].addEventListener('click', () => {
    el['search'].value = ''; currentQuery = ''; el['btn-clear-search'].classList.add('hidden'); render(); el['search'].focus();
  });

  // Clips
  el['btn-paste'].addEventListener('click', pasteFromClipboard);
  el['btn-write'].addEventListener('click', () => openEditor('clip', null));

  // Dump input — Return = newline, Add commits. compositionstart/end guards
  // Korean (and other IME) input so a mid-composition Add can't cut the
  // last character (plan 6-3 / 12장 checklist).
  el['dump-input'].addEventListener('compositionstart', () => { composing = true; });
  el['dump-input'].addEventListener('compositionend', () => { composing = false; });
  el['dump-input'].addEventListener('input', () => {
    updateDumpHint();
    saveDraft(el['dump-input'].value);
  });
  el['btn-dump-add'].addEventListener('click', submitDump);

  // Editor sheet
  el['btn-save-edit'].addEventListener('click', saveEditor);
  el['edit-text'].addEventListener('input', updateEditCount);

  // Cards (event delegation)
  document.querySelectorAll('.cards, #dump-groups').forEach(box => {
    box.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      const card = btn.closest('.card');
      if (!card) return;
      const item = findItem(card.dataset.id);
      if (!item) return;
      if (btn.dataset.act === 'copy') {
        copyItem(item).then(() => { flashCard(item.id); toast('Copied.', 'ok', 1800); render(); })
          .catch(() => { el['view-text'].value = item.text; openSheet(el['sheet-view']); setTimeout(() => el['view-text'].select(), 150); });
      } else if (btn.dataset.act === 'expand') {
        expandDump(item);
      } else {
        openMenu(item);
      }
    });
  });
  // #dump-groups is rebuilt on every render(), so also delegate from the panel itself.
  el['panel-dump'].addEventListener('click', ev => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const card = btn.closest('.card');
    if (!card) return;
    const item = findItem(card.dataset.id);
    if (!item) return;
    if (btn.dataset.act === 'expand') expandDump(item);
  });

  el['menu-list'].addEventListener('click', ev => {
    const btn = ev.target.closest('[data-menu]');
    if (!btn) return;
    const item = findItem(el['sheet-menu'].dataset.id);
    if (!item) { closeSheet(); return; }
    runMenuAction(btn.dataset.menu, item);
  });

  el['btn-view-copy'].addEventListener('click', () => {
    writeClipboard(el['view-text'].value)
      .then(() => toast('Copied.', 'ok', 1800))
      .catch(() => { el['view-text'].select(); toast('Press and hold to copy.', 'warn'); });
  });

  document.querySelectorAll('[data-close-sheet]').forEach(b => b.addEventListener('click', closeSheet));
  document.querySelectorAll('.sheet-backdrop').forEach(bd => {
    bd.addEventListener('click', ev => { if (ev.target === bd) closeSheet(); });
  });
  document.addEventListener('keydown', ev => {
    const modalOpen = !el['modal-confirm'].classList.contains('hidden');
    if (ev.key === 'Escape') { if (modalOpen) confirmClose(false); else if (openSheetEl) closeSheet(); return; }
    if (ev.key === 'Tab') { if (modalOpen) trapFocus(el['modal-confirm'], ev); else if (openSheetEl) trapFocus(openSheetEl, ev); }
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    syncViewport();
  }

  el['btn-confirm-yes'].addEventListener('click', () => confirmClose(true));
  el['btn-confirm-no'].addEventListener('click', () => confirmClose(false));
  el['modal-confirm'].addEventListener('click', ev => { if (ev.target === el['modal-confirm']) confirmClose(false); });

  // Settings
  el['btn-settings'].addEventListener('click', () => { refreshSettingsUI(); openSheet(el['sheet-settings']); });

  document.querySelectorAll('.seg-btn[data-step]').forEach(b => b.addEventListener('click', () => {
    state.settings.fontStep = Number(b.dataset.step);
    saveState(); applyFontStep();
  }));
  el['btn-fontstep-reset'].addEventListener('click', () => {
    state.settings.fontStep = CONFIG.defaultFontStep;
    saveState(); applyFontStep();
    toast('Reset to default size.', 'ok');
  });

  document.querySelectorAll('.seg-btn[data-retention]').forEach(b => b.addEventListener('click', () => {
    state.settings.retentionDays = Number(b.dataset.retention);
    saveState(); applyRetentionUI(); render();
    toast(state.settings.retentionDays === 0 ? 'Auto-clearing turned off.' : 'Retention set to ' + state.settings.retentionDays + ' days.', 'ok');
  }));
  el['btn-clear-expired'].addEventListener('click', () => performCleanup({ silent: false }).then(refreshCleanupLine));

  el['set-merge'].addEventListener('change', () => { state.settings.mergeDuplicates = el['set-merge'].checked; saveState(); });

  const copyUrl = () => writeClipboard(appUrl())
    .then(() => toast('Address copied.', 'ok'))
    .catch(() => toast('Could not copy — press and hold the address instead.', 'warn', 4000));
  el['btn-copy-url'].addEventListener('click', copyUrl);
  el['btn-copy-url2'].addEventListener('click', copyUrl);
  el['btn-open-guide'].addEventListener('click', () => { closeSheet(); refreshSettingsUI(); openSheet(el['sheet-guide']); });

  el['btn-export-json'].addEventListener('click', exportJson);
  el['btn-export-csv'].addEventListener('click', exportCsv);
  el['btn-import-json'].addEventListener('click', () => el['file-import'].click());
  el['file-import'].addEventListener('change', ev => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importJson(f);
    ev.target.value = '';
  });
  el['btn-wipe'].addEventListener('click', wipeAll);

  el['btn-pull-other'].addEventListener('click', pullFromOtherMode);

  bindSync();

  window.addEventListener('storage', ev => {
    if (ev.key !== CONFIG.storageKey) return;
    loadState(); refreshSettingsUI(); render();
  });
}

/* ── 21. init ─────────────────────────────────────────────────────────── */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW registration failed', e));
  });
}

function init() {
  cache();
  loadState();
  applyFontStep();
  switchTab(state.settings.lastTab, { silent: true, initial: true });
  el['dump-input'].value = loadDraft();
  updateDumpHint();
  bind();
  handleUrlIntake();
  render();
  if (!storageOK) toast('Storage is limited in this browser. Turn off Private Browsing in Safari.', 'err', 7000);
  registerSW();
  ensurePersistentStorage();
  initSync();
}

document.addEventListener('DOMContentLoaded', init);
