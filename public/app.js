// ── Config ────────────────────────────────────────────────────────────────────
const CONSULTANTS = [
  { id: 'c-1', name: 'Vandana', fullName: 'Vandana Pradhan', email: 'vandana@bookleafpub.in', freshdeskAgentId: null, active: true },
  { id: 'c-2', name: 'Sapna',   fullName: 'Sapna Kumari',    email: 'sapna@bookleafpub.in',   freshdeskAgentId: null, active: true },
  { id: 'c-3', name: 'Tannu',   fullName: 'Tannu Tiwari',    email: 'tannu@bookleafpub.in',   freshdeskAgentId: null, active: true },
  { id: 'c-4', name: 'Roosha',  fullName: 'Roosha',           email: 'roosha@bookleafpub.in',  freshdeskAgentId: null, active: true },
  { id: 'c-5', name: 'Firdaus', fullName: 'Firdaus',          email: '',                        freshdeskAgentId: null, active: false },
];

const ACTIVE_CONSULTANTS = CONSULTANTS.filter(c => c.active);

const PACKAGES = {
  11999: { label: 'Indian Bestseller', key: 'indian' },
  249:   { label: 'Intl Bestseller',   key: 'intl' },
};

const FD_DOMAIN = 'bookleafpublishing.freshdesk.com';
const FD_STATUS = { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' };
const AUTHOR_STATUS_OPTIONS = ['assigned', 'in-progress', 'good-to-go', 'completed'];
const AUTHOR_STATUS_LABELS = {
  'assigned': 'Assigned',
  'in-progress': 'In Progress',
  'good-to-go': 'Good to Go',
  'completed': 'Completed',
};

// Detect environment: localhost uses proxy, GitHub Pages calls Freshdesk/Razorpay directly
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

// Workflow stages (matching Google Sheet columns exactly)
const STAGES = [
  'introEmail',        // Intro Email
  'authorResponse',    // Author Response
  'followUp',          // Follow-up Mail
  'markedYes',         // Marked "yes" for 5
  'filesGenerated',    // Files Generated
  'addressMarketing',  // Address and Marketing
  'primePlacement',    // Prime Placement
  'confirmationEmail', // Confirmation Email
];

const DEFAULT_REASSIGN_CUTOFF = '2026-02-17'; // YYYY-MM-DD (IST business cutoff)
const IS_BOOKING_MODE = new URLSearchParams(window.location.search).get('book') === 'true';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  authors: [],
  rawCSV: null,
  rrIndex: 0,
  tickets: [],
  fdAgentsLoaded: false,
  fdServerConfigured: false, // server proxy has FRESHDESK_API_KEY
  fdAutoRefreshPrefSeen: false,
  fdAutoRefreshTimer: null,  // setInterval ID for auto-refresh
  fdFetchInFlight: false,    // prevent overlapping ticket syncs
  fdAutoRefreshWasEnabledBefore429: false,
  fdLastFetchTime: null,     // timestamp of last successful fetch
  fdLastTicketCount: 0,      // ticket count from previous fetch (to detect new tickets)
  callbacks: [],             // callback requests: { id, authorEmail, authorName, consultant, datetime, notes, status }
  editingCallbackId: null,   // ID of callback being edited (null = new)
  dataScope: 'none',         // 'admin' | 'consultant' | 'none'
  adminPassword: '',         // session-only (never persisted in localStorage)
  dbPersistence: { configured: false, provider: null },
  consultantSheetUrls: {},   // consultant -> Google Sheet URL
  reassignCutoff: DEFAULT_REASSIGN_CUTOFF,
  trackerCounts: {},         // consultant -> count from tracker sheets
  existingMap: {},       // email → { consultant, stages, remarks } from imported tracker CSVs
  loadedTrackers: [],    // which consultant trackers have been loaded
  currentView: 'admin',  // 'admin' or consultant name
  adminUnlocked: true,   // starts as admin; lock when switching away
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $id = (id) => document.getElementById(id);
const dom = {
  csvFile: $id('csv-file'), dropZone: $id('drop-zone'),
  filterIndian: $id('filter-indian'), filterIntl: $id('filter-intl'),
  btnImport: $id('btn-import'), btnSample: $id('btn-load-sample'),
  apiStatus: $id('api-status'),
  // Razorpay
  rpKeyId: $id('rp-key-id'), rpKeySecret: $id('rp-key-secret'),
  rpDateFrom: $id('rp-date-from'), rpDateTo: $id('rp-date-to'),
  btnRpFetch: $id('btn-rp-fetch'), rpStatus: $id('rp-status'),
  // Freshdesk
  fdApiKey: $id('fd-api-key'), fdDomain: $id('fd-domain'),
  fdAuthMode: $id('fd-auth-mode'),
  btnFdFetch: $id('btn-fd-fetch'), btnFdAutoAssign: $id('btn-fd-auto-assign'),
  fdStatus: $id('fd-status'), fdAutoRefresh: $id('fd-auto-refresh'),
  fdRefreshInterval: $id('fd-refresh-interval'), fdLastUpdated: $id('fd-last-updated'),
  fdServerSyncCard: $id('fd-server-sync-card'),
  fdServerSyncSummary: $id('fd-server-sync-summary'),
  fdServerSyncHealth: $id('fd-server-sync-health'),
  fdServerSyncMeta: $id('fd-server-sync-meta'),
  btnFdServerSyncStatus: $id('btn-fd-server-sync-status'),
  // Stats
  statAuthors: $id('stat-authors'), statIndian: $id('stat-indian'),
  statIntl: $id('stat-intl'), statTickets: $id('stat-tickets'),
  statGood: $id('stat-good'), statAssigned: $id('stat-assigned'),
  btnAutoAssign: $id('btn-auto-assign'), btnClear: $id('btn-clear-assignments'),
  btnExport: $id('btn-export'),
  searchInput: $id('search-input'), filterPackage: $id('filter-package'),
  filterConsultant: $id('filter-consultant'), filterStatus: $id('filter-status'),
  tbody: $id('assignments-body'), workloadGrid: $id('workload-grid'),
  ticketsSection: $id('tickets-section'), ticketSearch: $id('ticket-search'),
  ticketFilterMatch: $id('ticket-filter-match'), ticketsBody: $id('tickets-body'),
  trackerConsultant: $id('tracker-consultant'), trackerCsv: $id('tracker-csv'),
  trackerSheetUrl: $id('tracker-sheet-url'), btnLoadTrackerSheet: $id('btn-load-tracker-sheet'),
  btnLoadTracker: $id('btn-load-tracker'), trackerStatus: $id('tracker-status'),
  trackerLoaded: $id('tracker-loaded'),
  identitySelect: $id('identity-select'), identityBadge: $id('identity-badge'),
  // Performance
  performanceGrid: $id('performance-grid'),
  // Callbacks
  callbackBody: $id('callback-body'), callbackFilter: $id('callback-filter'),
  callbackSearch: $id('callback-search'), btnAddCallback: $id('btn-add-callback'),
  callbackModal: $id('callback-modal'), cbAuthorEmail: $id('cb-author-email'),
  cbDatetime: $id('cb-datetime'), cbNotes: $id('cb-notes'),
  cbAuthorMatch: $id('cb-author-match'), cbAuthorList: $id('cb-author-list'),
  btnCbSave: $id('btn-cb-save'), btnCbCancel: $id('btn-cb-cancel'),
};

// ── Full-Stack State Persistence API ─────────────────────────────────────────
function canUseServerStateApi() {
  return location.hostname.endsWith('.vercel.app');
}

function hasDbPersistenceAvailable() {
  return !!(state.dbPersistence && state.dbPersistence.configured && canUseServerStateApi());
}

function getStateApiView() {
  return state.currentView === 'admin' ? 'admin' : state.currentView;
}

function stateApiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const adminPwd = (state.adminPassword || getStoredAdminPassword() || '').trim();
  if (adminPwd) headers['x-admin-password'] = adminPwd;
  return headers;
}

async function postStateApi(action, payload = {}, opts = {}) {
  if (!hasDbPersistenceAvailable()) return { ok: false, skipped: true, reason: 'db-not-configured' };
  const body = {
    action,
    view: getStateApiView(),
    ...payload,
  };
  const res = await fetch('/api/state', {
    method: 'POST',
    headers: stateApiHeaders(),
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = (data && data.error) || `${action} failed (${res.status})`;
    if (!opts.silent) console.warn('State API error:', msg, data || '');
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data || { ok: true };
}

function authorToCompactOverride(author) {
  if (!author || !author.email) return null;
  return {
    e: String(author.email).trim().toLowerCase(),
    c: author.consultant || '',
    st: normalizeAuthorStatus(author.status),
    rm: author.remarks || '',
    ie: !!author.introEmail,
    ar: !!author.authorResponse,
    fu: !!author.followUp,
    my: !!author.markedYes,
    fg: !!author.filesGenerated,
    am: !!author.addressMarketing,
    pp: !!author.primePlacement,
    ce: !!author.confirmationEmail,
  };
}

function authorToCompactRow(author) {
  if (!author || !author.email) return null;
  return {
    n: author.name || '',
    e: String(author.email).trim().toLowerCase(),
    ph: author.phone || '',
    pk: author.packageKey || '',
    pl: author.package || '',
    dt: author.paymentDate || '',
    c: author.consultant || '',
    st: normalizeAuthorStatus(author.status),
    ie: !!author.introEmail,
    ar: !!author.authorResponse,
    fu: !!author.followUp,
    my: !!author.markedYes,
    fg: !!author.filesGenerated,
    am: !!author.addressMarketing,
    pp: !!author.primePlacement,
    ce: !!author.confirmationEmail,
    rm: author.remarks || '',
  };
}

function existingMapRowToCompact(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    c: row.consultant || '',
    n: row.name || null,
    ie: !!row.introEmail,
    ar: !!row.authorResponse,
    fu: !!row.followUp,
    my: !!row.markedYes,
    fg: !!row.filesGenerated,
    am: !!row.addressMarketing,
    pp: !!row.primePlacement,
    ce: !!row.confirmationEmail,
    rm: row.remarks || '',
    st: normalizeAuthorStatus(row.status),
  };
}

function queueAuthorOverridePersist(author) {
  const compact = authorToCompactOverride(author);
  if (!compact || !hasDbPersistenceAvailable()) return;
  if (!queueAuthorOverridePersist._pending) queueAuthorOverridePersist._pending = {};
  queueAuthorOverridePersist._pending[compact.e] = compact;
  clearTimeout(queueAuthorOverridePersist._timer);
  queueAuthorOverridePersist._timer = setTimeout(async () => {
    // Atomically swap out the pending map so new writes go to a fresh object.
    const pending = queueAuthorOverridePersist._pending || {};
    queueAuthorOverridePersist._pending = null; // force re-creation on next call
    const items = Object.values(pending);
    if (!items.length) return;
    try {
      await postStateApi('upsert_author_overrides', { items }, { silent: true });
    } catch (err) {
      console.warn('Author override persist failed:', err.message);
      // Re-queue failed items so they aren't lost.
      if (!queueAuthorOverridePersist._pending) queueAuthorOverridePersist._pending = {};
      items.forEach(item => {
        if (item.e && !queueAuthorOverridePersist._pending[item.e]) {
          queueAuthorOverridePersist._pending[item.e] = item;
        }
      });
    }
  }, 350);
}

function queueCallbacksPersist() {
  if (!hasDbPersistenceAvailable()) return;
  clearTimeout(queueCallbacksPersist._timer);
  queueCallbacksPersist._timer = setTimeout(async () => {
    // Snapshot callbacks at time of persist to avoid capturing mid-mutation state.
    const snapshot = JSON.parse(JSON.stringify(state.callbacks || []));
    try {
      await postStateApi('replace_callbacks', { callbacks: snapshot }, { silent: true });
    } catch (err) {
      console.warn('Callbacks persist failed:', err.message);
    }
  }, 350);
}

function queueAuthorsRuntimeSnapshotPersist() {
  if (!hasDbPersistenceAvailable()) return;
  if (state.currentView !== 'admin') return;
  clearTimeout(queueAuthorsRuntimeSnapshotPersist._timer);
  queueAuthorsRuntimeSnapshotPersist._timer = setTimeout(async () => {
    try {
      const authors = (state.authors || []).map(authorToCompactRow).filter(Boolean);
      await postStateApi('replace_authors_runtime', { authors }, { silent: true });
    } catch (err) {
      console.warn('Authors runtime snapshot persist failed:', err.message);
    }
  }, 500);
}

async function persistTrackerOverrideBatch(rowsMap, consultant) {
  if (!rowsMap || !Object.keys(rowsMap).length || !hasDbPersistenceAvailable()) return;
  try {
    await postStateApi('upsert_tracker_overrides', { rows: rowsMap, view: consultant || getStateApiView() }, { silent: true });
  } catch (err) {
    console.warn('Tracker override persist failed:', err.message);
  }
}

async function persistConsultantSheetUrl(consultant, url) {
  if (!consultant || !hasDbPersistenceAvailable()) return;
  state.consultantSheetUrls = { ...(state.consultantSheetUrls || {}), [consultant]: (url || '').trim() };
  try {
    await postStateApi('set_sheet_url', { consultant, url: (url || '').trim() }, { silent: true });
  } catch (err) {
    console.warn('Sheet URL persist failed:', err.message);
  }
}

function applyConsultantSheetInput() {
  if (!dom.trackerConsultant || !dom.trackerSheetUrl) return;
  const consultant = dom.trackerConsultant.value;
  const saved = (state.consultantSheetUrls && state.consultantSheetUrls[consultant]) || '';
  dom.trackerSheetUrl.value = saved || '';
}

// ── Freshdesk API ────────────────────────────────────────────────────────────
function fdHeaders() {
  const key = dom.fdApiKey.value.trim();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Basic ' + btoa(key + ':X');
  return headers;
}
function fdUrl(path) {
  if (IS_LOCAL) return `/fd-api/${path}`;
  if (location.hostname.endsWith('.vercel.app')) return `/api/fd/${path}`;
  // On GitHub Pages: use Freshdesk directly (may hit CORS — show helpful error)
  return `https://${FD_DOMAIN}/api/v2/${path}`;
}
function canUseFreshdeskProxy() {
  return IS_LOCAL || location.hostname.endsWith('.vercel.app');
}
function canUseFreshdeskServerCache() {
  return location.hostname.endsWith('.vercel.app');
}
function hasFreshdeskAuthAvailable() {
  const localKey = !!(dom.fdApiKey && dom.fdApiKey.value.trim());
  return localKey || (canUseFreshdeskProxy() && !!state.fdServerConfigured);
}
function refreshFreshdeskControls() {
  if (dom.btnFdFetch) dom.btnFdFetch.disabled = !hasFreshdeskAuthAvailable();
  if (dom.fdApiKey) {
    if (state.fdServerConfigured && !dom.fdApiKey.value.trim()) {
      dom.fdApiKey.placeholder = 'Using server Freshdesk key (optional override)';
    } else if (!state.fdServerConfigured) {
      dom.fdApiKey.placeholder = 'Paste your Freshdesk API key here';
    }
  }
  if (dom.fdAuthMode) {
    if (state.fdServerConfigured) {
      dom.fdAuthMode.textContent = 'Freshdesk auth: server key configured (auto-sync ready)';
      dom.fdAuthMode.classList.add('fd-auth-mode-ok');
      dom.fdAuthMode.classList.remove('fd-auth-mode-warn');
    } else {
      dom.fdAuthMode.textContent = 'Freshdesk auth: no server key configured (manual key required)';
      dom.fdAuthMode.classList.add('fd-auth-mode-warn');
      dom.fdAuthMode.classList.remove('fd-auth-mode-ok');
    }
  }
}
async function detectFreshdeskProxyConfig() {
  if (!canUseFreshdeskProxy()) return;
  try {
    const res = await fetch(fdUrl('config'));
    if (!res.ok) throw new Error(`FD config ${res.status}`);
    const body = await res.json().catch(() => ({}));
    state.fdServerConfigured = !!(body && body.configured);
  } catch (err) {
    console.warn('Freshdesk proxy config check failed:', err.message);
    state.fdServerConfigured = false;
  }
  refreshFreshdeskControls();
}

function setFdServerSyncCardState({ tone = 'info', label = 'Checking', summary = '', items = [] } = {}) {
  if (!dom.fdServerSyncCard) return;
  if (dom.fdServerSyncHealth) {
    dom.fdServerSyncHealth.textContent = label;
    dom.fdServerSyncHealth.className = `badge fd-sync-health fd-sync-health-${tone}`;
  }
  if (dom.fdServerSyncSummary) {
    dom.fdServerSyncSummary.textContent = summary || '';
  }
  if (dom.fdServerSyncMeta && Array.isArray(items) && items.length) {
    dom.fdServerSyncMeta.innerHTML = items.map(item => `
      <div class="meta-item">
        <span class="meta-label">${esc(item.label || '')}</span>
        <span class="meta-value">${esc(item.value || '—')}</span>
      </div>`).join('');
  }
}

function formatAgeShort(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function formatDateTimeShort(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  try {
    return dt.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return dt.toISOString();
  }
}

function getFdCacheHealth(ageMs) {
  if (!Number.isFinite(ageMs)) return { tone: 'warn', label: 'No Cache', freshness: 'No cached snapshot yet' };
  if (ageMs <= 2 * 60 * 60 * 1000) return { tone: 'ok', label: 'Healthy', freshness: `Fresh (${formatAgeShort(ageMs)})` };
  if (ageMs <= 30 * 60 * 60 * 1000) return { tone: 'warn', label: 'Delayed', freshness: `Stale (${formatAgeShort(ageMs)})` };
  return { tone: 'error', label: 'Stale', freshness: `Very old (${formatAgeShort(ageMs)})` };
}

async function refreshFreshdeskServerSyncStatus(opts = {}) {
  if (!canUseFreshdeskServerCache() || !dom.fdServerSyncCard) return false;
  if (state.currentView !== 'admin') {
    dom.fdServerSyncCard.classList.add('hidden');
    return false;
  }
  dom.fdServerSyncCard.classList.remove('hidden');
  setFdServerSyncCardState({
    tone: 'info',
    label: 'Checking',
    summary: 'Checking server sync status...',
    items: [
      { label: 'Freshdesk Key', value: state.fdServerConfigured ? 'Configured' : 'Checking' },
      { label: 'Cache Store', value: 'Checking' },
      { label: 'Cron Secret', value: 'Checking' },
      { label: 'Cache', value: 'Checking' },
    ],
  });

  const adminPassword = (opts.adminPassword || state.adminPassword || getStoredAdminPassword() || '').trim();
  let runtime = null;
  try {
    const res = await fetch('/api/fd-sync?status=1');
    if (res.ok) runtime = await res.json().catch(() => null);
  } catch {}

  let cacheState = { code: 0, body: null };
  if (adminPassword) {
    try {
      const url = new URL('/api/fd-cache', window.location.origin);
      url.searchParams.set('view', 'admin');
      const res = await fetch(url.toString(), { headers: { 'x-admin-password': adminPassword } });
      let body = null;
      try { body = await res.json(); } catch {}
      cacheState = { code: res.status, body };
    } catch (err) {
      cacheState = { code: -1, body: { error: err.message } };
    }
  } else {
    cacheState = { code: 401, body: { error: 'Admin unlock required' } };
  }

  const fdConfigured = runtime ? !!runtime.freshdeskConfigured : !!state.fdServerConfigured;
  const cacheStoreConfigured = runtime ? !!(runtime.cacheStoreConfigured ?? runtime.kvConfigured) : (cacheState.code !== 503);
  const cacheStoreKind = runtime && runtime.cacheStore ? String(runtime.cacheStore) : (cacheStoreConfigured ? 'configured' : 'none');
  const cronSecretConfigured = runtime ? !!runtime.cronSecretConfigured : false;
  const scheduleHint = runtime && runtime.defaultVercelCronSchedule ? runtime.defaultVercelCronSchedule : '*/10 * * * *';

  let tone = 'info';
  let label = 'Ready';
  let summary = 'Server sync endpoint is reachable.';
  let cacheValue = 'Not checked';
  let lastSyncValue = '—';

  if (!fdConfigured) {
    tone = 'warn';
    label = 'No FD Key';
    summary = 'Server Freshdesk key is missing. Background sync cannot run.';
  }

  if (!cacheStoreConfigured) {
    tone = 'error';
    label = 'Store Missing';
    summary = 'No persistent cache store is configured. Server sync has nowhere to store tickets.';
    cacheValue = 'Unavailable';
  } else if (cacheState.code === 200 && cacheState.body) {
    const fetchedAtRaw = cacheState.body.fetchedAt || (runtime && runtime.cacheFetchedAt) || null;
    const fetchedAt = fetchedAtRaw ? new Date(fetchedAtRaw) : null;
    const ageMs = fetchedAt && !Number.isNaN(fetchedAt.getTime()) ? (Date.now() - fetchedAt.getTime()) : NaN;
    const health = getFdCacheHealth(ageMs);
    tone = health.tone;
    label = health.label;
    cacheValue = `${cacheState.body.ticketCount ?? 0} tickets`;
    lastSyncValue = fetchedAt ? `${formatDateTimeShort(fetchedAt)} (${formatAgeShort(ageMs)})` : 'Unknown';
    summary = `Server cache available. ${health.freshness}.`;
  } else if (cacheState.code === 404) {
    tone = fdConfigured && cacheStoreConfigured ? 'warn' : tone;
    label = 'No Cache';
    cacheValue = 'No snapshot yet';
    summary = 'Cache store is configured but no Freshdesk cache snapshot exists yet. Run /api/fd-sync once or wait for scheduler.';
  } else if (cacheState.code === 401) {
    tone = cacheStoreConfigured ? 'warn' : tone;
    label = cacheStoreConfigured ? 'Locked' : label;
    cacheValue = cacheStoreConfigured ? 'Admin unlock required' : cacheValue;
    summary = cacheStoreConfigured ? 'Unlock Admin to read cache status details.' : summary;
  } else if (cacheState.code > 0) {
    tone = 'error';
    label = 'Error';
    cacheValue = `HTTP ${cacheState.code}`;
    summary = `Could not read Freshdesk cache status (${cacheState.code}).`;
  } else if (cacheState.code === -1) {
    tone = 'error';
    label = 'Error';
    cacheValue = 'Request failed';
    summary = `Could not read Freshdesk cache status: ${(cacheState.body && cacheState.body.error) || 'Unknown error'}.`;
  }

  setFdServerSyncCardState({
    tone,
    label,
    summary,
    items: [
      { label: 'Freshdesk Key', value: fdConfigured ? 'Configured' : 'Missing' },
      { label: 'Cache Store', value: cacheStoreConfigured ? (cacheStoreKind === 'blob' ? 'Blob' : cacheStoreKind === 'kv' ? 'KV' : 'Configured') : 'Missing' },
      { label: 'Cron Secret', value: cronSecretConfigured ? 'Configured' : 'Missing' },
      { label: 'Cache', value: cacheValue },
      { label: 'Last Sync', value: lastSyncValue },
      { label: 'Vercel Cron', value: `Configured (${scheduleHint})` },
    ],
  });
  return true;
}

async function loadFreshdeskTicketCacheFromServer(opts = {}) {
  if (!canUseFreshdeskServerCache()) return false;
  if (!opts.force && state.tickets.length) return false;
  const adminPassword = (opts.adminPassword || state.adminPassword || getStoredAdminPassword() || '').trim();
  if (!adminPassword) return false;
  try {
    const url = new URL('/api/fd-cache', window.location.origin);
    url.searchParams.set('view', 'admin');
    const res = await fetch(url.toString(), { headers: { 'x-admin-password': adminPassword } });
    if (!res.ok) {
      // 404 before first cron sync is normal; don't treat as app error.
      if (!opts.silent && res.status !== 404) {
        showFdStatus(`Freshdesk cache unavailable (${res.status}).`, 'info');
      }
      return false;
    }
    const body = await res.json().catch(() => ({}));
    const cachedTickets = Array.isArray(body.tickets) ? body.tickets : [];

    // Re-match cached tickets against current state.authors (may include newly imported authors)
    cachedTickets.forEach(t => {
      const author = state.authors.find(a => a.email.toLowerCase() === t.requesterEmail);
      if (author) {
        t.isMatched = true;
        t.matchedAuthor = author.name;
        t.matchedConsultant = author.consultant;
      }
      // Re-check needsReassign against current agent map
      if (t.isMatched && t.matchedConsultant) {
        const c = CONSULTANTS.find(c2 => c2.name === t.matchedConsultant);
        if (c && c.freshdeskAgentId && c.freshdeskAgentId !== t.currentAssignee) {
          t.needsReassign = true;
        }
      }
    });
    state.tickets = cachedTickets;

    state.fdLastTicketCount = cachedTickets.length;
    state.fdLastCheckedTime = new Date();
    if (body.fetchedAt) {
      const parsed = new Date(body.fetchedAt);
      if (!Number.isNaN(parsed.getTime())) {
        state.fdLastFetchTime = parsed;
      }
    }
    updateFdLastUpdated();
    if (dom.btnFdAutoAssign) {
      const needsAssign = state.tickets.filter(t => t.needsReassign).length;
      dom.btnFdAutoAssign.disabled = needsAssign === 0;
    }
    if (dom.ticketsSection) {
      if (cachedTickets.length > 0) dom.ticketsSection.classList.remove('hidden');
      else dom.ticketsSection.classList.add('hidden');
    }
    if (opts.refreshUI !== false) {
      refreshUI();
    }
    if (cachedTickets.length && !opts.silent) {
      showFdStatus(`Loaded ${cachedTickets.length} cached tickets from server sync.`, 'info');
    }
    if (state.currentView === 'admin') {
      refreshFreshdeskServerSyncStatus({ adminPassword, silent: true }).catch(() => {});
    }
    return true;
  } catch (err) {
    if (!opts.silent) {
      showFdStatus(`Freshdesk cache error: ${err.message}`, 'error');
    }
    return false;
  }
}

function canUseServerCacheAutoRefresh() {
  const hasAdminPwd = !!((state.adminPassword || getStoredAdminPassword() || '').trim());
  return state.currentView === 'admin' && canUseFreshdeskServerCache() && state.fdServerConfigured && hasAdminPwd;
}

async function refreshFreshdeskForAutoTick() {
  if (canUseServerCacheAutoRefresh()) {
    const loaded = await loadFreshdeskTicketCacheFromServer({
      force: true,
      silent: true,
      refreshUI: true,
    });
    if (loaded) return true;
  }
  if (!hasFreshdeskAuthAvailable()) return false;
  await fetchFreshdeskTickets({ trigger: 'auto', silentIfBusy: true, maxPages: 2 });
  return true;
}
function rpUrl(path) {
  if (IS_LOCAL) return `/rp-api/${path}`;
  if (location.hostname.endsWith('.vercel.app')) return `/api/rp/${path}`;
  return `https://api.razorpay.com/v1/${path}`;
}

async function loadFreshdeskAgents() {
  try {
    const res = await fetch(fdUrl('agents?per_page=100'), { headers: fdHeaders() });
    if (!res.ok) {
      console.warn(`Freshdesk agents API: ${res.status} — skipping agent matching`);
      state.fdAgentsLoaded = true;
      return '(agents API unavailable — ticket sync will still work)';
    }
    const agents = await res.json();
    CONSULTANTS.forEach(c => {
      if (!c.email) return;
      const match = agents.find(a => a.contact && a.contact.email && a.contact.email.toLowerCase() === c.email.toLowerCase());
      if (match) c.freshdeskAgentId = match.id;
    });
    state.fdAgentsLoaded = true;
    return CONSULTANTS.filter(c => c.freshdeskAgentId).map(c => c.name).join(', ') || '(no agents matched)';
  } catch (err) {
    console.warn('Freshdesk agents error:', err.message);
    state.fdAgentsLoaded = true;
    return '(agents API unavailable)';
  }
}

function getRetryAfterSeconds(res) {
  try {
    const raw = res && res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
    const sec = Number(raw);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null;
  } catch {
    return null;
  }
}

function handleFreshdeskRateLimit(retryAfterSec) {
  if (canUseServerCacheAutoRefresh()) {
    const mins = retryAfterSec ? Math.max(1, Math.ceil(retryAfterSec / 60)) : null;
    const msg = mins
      ? `Freshdesk live fetch rate limit hit (429). Server-cache auto-refresh will continue. Wait ~${mins} min before retrying manual live fetch.`
      : 'Freshdesk live fetch rate limit hit (429). Server-cache auto-refresh will continue.';
    showFdStatus(msg, 'error');
    return;
  }
  const mins = retryAfterSec ? Math.max(1, Math.ceil(retryAfterSec / 60)) : null;
  if (dom.fdAutoRefresh && dom.fdAutoRefresh.checked) {
    state.fdAutoRefreshWasEnabledBefore429 = true;
    dom.fdAutoRefresh.checked = false;
  }
  stopFdAutoRefresh();
  persistFreshdeskPrefs();
  const msg = mins
    ? `Freshdesk rate limit hit (429). Auto-refresh paused. Wait ~${mins} min, then click "Fetch & Sync Tickets" or re-enable auto-refresh.`
    : 'Freshdesk rate limit hit (429). Auto-refresh paused. Wait a few minutes, then click "Fetch & Sync Tickets".';
  showFdStatus(msg, 'error');
}

async function fetchFreshdeskTickets(opts = {}) {
  if (state.fdFetchInFlight) {
    if (!opts.silentIfBusy) showFdStatus('Freshdesk sync already in progress...', 'info');
    return;
  }
  if (!hasFreshdeskAuthAvailable()) { showFdStatus('Enter Freshdesk API key (or configure FRESHDESK_API_KEY on the server).', 'error'); return; }
  state.fdFetchInFlight = true;
  showFdStatus('Connecting to Freshdesk...', 'info');
  try {
    if (!state.fdAgentsLoaded) {
      const mapped = await loadFreshdeskAgents();
      showFdStatus(`Agents: ${mapped}. Fetching tickets...`, 'info');
    }
    const maxPages = opts.maxPages || (opts.trigger === 'auto' ? 2 : 5);
    let allTickets = [], page = 1, hasMore = true;
    while (hasMore && page <= maxPages) {
      const res = await fetch(fdUrl(`tickets?per_page=100&page=${page}&include=requester&order_by=created_at&order_type=desc`), { headers: fdHeaders() });
      if (!res.ok) {
        if (res.status === 404) throw new Error('Tickets API: 404 — your API key may not have agent-level access. Use an agent API key from Freshdesk → Profile Settings.');
        if (res.status === 401) throw new Error('Tickets API: 401 — invalid API key. Check your key in Freshdesk → Profile Settings → API Key.');
        if (res.status === 429) {
          const e = new Error('Tickets API: 429');
          e.status = 429;
          e.retryAfterSec = getRetryAfterSeconds(res);
          throw e;
        }
        throw new Error(`Tickets API: ${res.status}`);
      }
      const tickets = await res.json();
      allTickets = allTickets.concat(tickets);
      hasMore = tickets.length === 100;
      page++;
    }

    state.tickets = allTickets.map(t => {
      const email = (t.requester ? t.requester.email : (t.email || '')).toLowerCase().trim();
      const author = state.authors.find(a => a.email.toLowerCase() === email);
      return {
        id: t.id, subject: t.subject || '(No subject)', requesterEmail: email,
        matchedAuthor: author ? author.name : null, matchedConsultant: author ? author.consultant : null,
        currentAssignee: t.responder_id, status: FD_STATUS[t.status] || `Status ${t.status}`,
        statusCode: t.status, isMatched: !!author, needsReassign: false,
      };
    });

    // Re-check needsReassign against current agent map
    state.tickets.forEach(t => {
      if (t.isMatched && t.matchedConsultant) {
        const c = CONSULTANTS.find(c2 => c2.name === t.matchedConsultant);
        if (c && c.freshdeskAgentId && c.freshdeskAgentId !== t.currentAssignee) t.needsReassign = true;
      }
    });

    const prevCount = state.tickets.length > 0 ? state.fdLastTicketCount || 0 : 0;
    const matched = state.tickets.filter(t => t.isMatched).length;
    const needsAssign = state.tickets.filter(t => t.needsReassign).length;
    const autoMarked = state.authors.filter(a => a.status === 'good-to-go').length;
    const newCount = state.tickets.length - prevCount;
    state.fdLastTicketCount = state.tickets.length;

    // Update last-fetched timestamp
    state.fdLastFetchTime = new Date();
    updateFdLastUpdated();

    // Status message — highlight new tickets if this is a refresh
    let statusMsg = `${state.tickets.length} tickets. ${matched} matched, ${needsAssign} need reassign, ${autoMarked} auto-marked "Good to Go".`;
    if (prevCount > 0 && newCount > 0) {
      statusMsg = `🔔 ${newCount} new ticket${newCount > 1 ? 's' : ''}! ` + statusMsg;
      notifyNewTickets(newCount);
    }
    showFdStatus(statusMsg, 'success');
    if (dom.btnFdAutoAssign) dom.btnFdAutoAssign.disabled = needsAssign === 0;
    if (dom.ticketsSection) dom.ticketsSection.classList.remove('hidden');
    refreshUI();

    // Keep writes explicit: auto-refresh/manual sync should not auto-assign on Freshdesk.
    if (needsAssign > 0 && opts.trigger === 'manual') {
      showFdStatus(statusMsg + ' Click "Auto-Assign Tickets" to push reassignment changes to Freshdesk.', 'info');
    }
  } catch (err) {
    if (err && (err.status === 429 || String(err.message || '').includes('429'))) {
      handleFreshdeskRateLimit(err.retryAfterSec);
      return;
    }
    if (!IS_LOCAL && ((err.message || '').includes('Failed to fetch') || (err.message || '').includes('NetworkError'))) {
      showFdStatus('Error: Freshdesk API blocked by CORS. Use the local proxy (python3 server.py → localhost:8080) for Freshdesk integration.', 'error');
    } else {
      showFdStatus(`Error: ${err.message}`, 'error');
    }
  } finally {
    state.fdFetchInFlight = false;
  }
}

async function autoAssignFreshdeskTickets() {
  const toAssign = state.tickets.filter(t => t.needsReassign);
  if (toAssign.length === 0) { showFdStatus('No tickets need reassignment.', 'info'); return; }
  showFdStatus(`Assigning ${toAssign.length} tickets...`, 'info');
  let success = 0, failed = 0;
  let stoppedByRateLimit = false;
  for (const ticket of toAssign) {
    const c = CONSULTANTS.find(c2 => c2.name === ticket.matchedConsultant);
    if (!c || !c.freshdeskAgentId) { failed++; continue; }
    try {
      const res = await fetch(fdUrl(`tickets/${ticket.id}`), { method: 'PUT', headers: fdHeaders(), body: JSON.stringify({ responder_id: c.freshdeskAgentId }) });
      if (res.status === 429) {
        handleFreshdeskRateLimit(getRetryAfterSeconds(res));
        stoppedByRateLimit = true;
        break;
      }
      if (res.ok) { ticket.currentAssignee = c.freshdeskAgentId; ticket.needsReassign = false; success++; } else failed++;
      await new Promise(r => setTimeout(r, 200));
    } catch { failed++; }
  }
  if (stoppedByRateLimit) return;
  showFdStatus(`Done! ${success} assigned${failed > 0 ? `, ${failed} failed` : ''}.`, success > 0 ? 'success' : 'error');
  if (dom.btnFdAutoAssign) dom.btnFdAutoAssign.disabled = true;
  refreshUI();
}

async function assignSingleTicket(ticketId) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (!ticket || !ticket.matchedConsultant) return;
  const c = CONSULTANTS.find(c2 => c2.name === ticket.matchedConsultant);
  if (!c || !c.freshdeskAgentId) { showFdStatus(`${ticket.matchedConsultant} not linked.`, 'error'); return; }
  try {
    const res = await fetch(fdUrl(`tickets/${ticketId}`), { method: 'PUT', headers: fdHeaders(), body: JSON.stringify({ responder_id: c.freshdeskAgentId }) });
    if (res.ok) { ticket.currentAssignee = c.freshdeskAgentId; ticket.needsReassign = false; showFdStatus(`#${ticketId} → ${c.name}`, 'success'); refreshUI(); }
    else showFdStatus(`Failed #${ticketId}`, 'error');
  } catch (err) { showFdStatus(`Error: ${err.message}`, 'error'); }
}

// ── Razorpay API ─────────────────────────────────────────────────────────────
function rpHeaders() {
  const keyId = dom.rpKeyId.value.trim();
  const keySecret = dom.rpKeySecret.value.trim();
  return { 'Authorization': 'Basic ' + btoa(keyId + ':' + keySecret), 'Content-Type': 'application/json' };
}

function showRpStatus(m, t) {
  dom.rpStatus.textContent = m;
  dom.rpStatus.className = `status-msg status-${t}`;
  dom.rpStatus.classList.remove('hidden');
  clearTimeout(showRpStatus._t);
  showRpStatus._t = setTimeout(() => dom.rpStatus.classList.add('hidden'), 12000);
}

async function fetchRazorpayPayments() {
  const keyId = dom.rpKeyId.value.trim();
  const keySecret = dom.rpKeySecret.value.trim();
  if (!keyId || !keySecret) { showRpStatus('Enter both Razorpay Key ID and Key Secret.', 'error'); return; }

  const incI = dom.filterIndian.checked, incN = dom.filterIntl.checked;
  if (!incI && !incN) { showRpStatus('Select at least one package filter.', 'error'); return; }

  // Date range
  const fromDate = dom.rpDateFrom.value ? new Date(dom.rpDateFrom.value) : null;
  const toDate = dom.rpDateTo.value ? new Date(dom.rpDateTo.value + 'T23:59:59') : null;

  showRpStatus('Connecting to Razorpay API...', 'info');

  try {
    let allPayments = [], skip = 0, hasMore = true;
    const batchSize = 100;

    // Build query params
    let params = `count=${batchSize}`;
    if (fromDate) params += `&from=${Math.floor(fromDate.getTime() / 1000)}`;
    if (toDate) params += `&to=${Math.floor(toDate.getTime() / 1000)}`;

    while (hasMore) {
      const url = rpUrl(`payments?${params}&skip=${skip}`);
      showRpStatus(`Fetching payments... (${allPayments.length} so far)`, 'info');

      const res = await fetch(url, { headers: rpHeaders() });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        const errMsg = (errBody.error && typeof errBody.error === 'object') ? errBody.error.description : (errBody.detail || errBody.error || 'Unknown error');
        throw new Error(`Razorpay API: ${res.status} — ${errMsg}`);
      }

      const data = await res.json();
      const items = data.items || [];
      allPayments = allPayments.concat(items);
      hasMore = items.length === batchSize;
      skip += batchSize;

      // Safety: max 50 pages (5000 payments)
      if (skip >= 5000) { hasMore = false; }

      // Rate limit: small delay between pages
      if (hasMore) await new Promise(r => setTimeout(r, 300));
    }

    showRpStatus(`${allPayments.length} payments fetched. Processing...`, 'info');

    // Filter: only captured payments for the selected packages
    const targetAmounts = [];
    if (incI) targetAmounts.push(1199900); // ₹11,999 in paise
    if (incN) targetAmounts.push(24900);   // ₹249 in paise

    const captured = allPayments.filter(p =>
      p.status === 'captured' && targetAmounts.includes(p.amount)
    );

    // Deduplicate by email (keep latest payment)
    const byEmail = {};
    captured.forEach(p => {
      const email = (p.email || '').toLowerCase().trim();
      if (!email) return;
      if (!byEmail[email] || p.created_at > byEmail[email].created_at) {
        byEmail[email] = p;
      }
    });

    const unique = Object.values(byEmail);
    unique.sort((a, b) => a.created_at - b.created_at);

    // Merge with existing tracker data + round-robin for new authors
    state.rrIndex = 0;
    let preAssigned = 0, newAssigned = 0;

    const newAuthors = unique.map((p, i) => {
      const email = (p.email || '').toLowerCase().trim();
      const amountRupees = p.amount / 100;
      const pkg = PACKAGES[amountRupees];
      const existing = state.existingMap[email];

      // Check if already in current authors list
      const alreadyLoaded = state.authors.find(a => a.email.toLowerCase() === email);
      if (alreadyLoaded) return null; // skip duplicates

      let consultant, status, remarks;
      let introEmail = false, authorResponse = false, followUp = false, markedYes = false;
      let filesGenerated = false, addressMarketing = false, primePlacement = false, confirmationEmail = false;

      if (existing) {
        consultant = existing.consultant;
        status = existing.status || 'assigned';
        remarks = existing.remarks || '';
        introEmail = !!existing.introEmail;
        authorResponse = !!existing.authorResponse;
        followUp = !!existing.followUp;
        markedYes = !!existing.markedYes;
        filesGenerated = !!existing.filesGenerated;
        addressMarketing = !!existing.addressMarketing;
        primePlacement = !!existing.primePlacement;
        confirmationEmail = !!existing.confirmationEmail;
        preAssigned++;
      } else {
        const c = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length];
        state.rrIndex++;
        consultant = c.name;
        status = 'assigned';
        remarks = '';
        newAssigned++;
      }

      // Extract name from Razorpay notes or card
      let name = '';
      try {
        if (p.notes && typeof p.notes === 'object') {
          name = p.notes.name || p.notes.registered_name || '';
        }
      } catch {}
      if (!name && p.card && p.card.name) name = p.card.name;
      if (!name) name = email.split('@')[0];

      const paymentDate = p.created_at ? new Date(p.created_at * 1000).toLocaleDateString('en-IN') : '';

      return {
        id: p.id || `rp-${i}`,
        name: existing && existing.name ? existing.name : name.trim(),
        email: (p.email || '').trim(),
        phone: (p.contact || '').trim(),
        package: pkg ? pkg.label : `₹${amountRupees}`,
        packageKey: pkg ? pkg.key : 'other',
        paymentDate,
        consultant, status, remarks,
        introEmail, authorResponse, followUp, markedYes,
        filesGenerated, addressMarketing, primePlacement, confirmationEmail,
      };
    }).filter(Boolean);

    // Add new authors to existing list
    state.authors = state.authors.concat(newAuthors);

    showRpStatus(
      `Done! ${captured.length} bestseller payments → ${unique.length} unique authors. ${newAuthors.length} new added (${preAssigned} matched trackers, ${newAssigned} round-robin). Total: ${state.authors.length} authors.`,
      'success'
    );
    refreshUI();
    queueAuthorsRuntimeSnapshotPersist();

  } catch (err) {
    showRpStatus(`Error: ${err.message}`, 'error');
    console.error('Razorpay API error:', err);
  }
}

// ── Auto-load pre-built tracker data ──────────────────────────────────────────
function loadPreBuiltTrackerData(trackerData) {
  const source = trackerData || (typeof TRACKER_DATA !== 'undefined' ? TRACKER_DATA : null);
  state.existingMap = {};
  state.loadedTrackers = [];
  if (!source) { renderTrackerTags(); return; }
  const consultantCounts = {};
  Object.entries(source).forEach(([email, d]) => {
    state.existingMap[email.toLowerCase()] = {
      consultant: d.c,
      name: d.n || null,
      introEmail: d.ie,
      authorResponse: d.ar,
      followUp: d.fu,
      markedYes: d.my,
      filesGenerated: d.fg,
      addressMarketing: d.am,
      primePlacement: d.pp,
      confirmationEmail: d.ce,
      remarks: d.rm || '',
      status: normalizeAuthorStatus(d.st),
    };
    consultantCounts[d.c] = (consultantCounts[d.c] || 0) + 1;
  });
  state.loadedTrackers = Object.keys(consultantCounts);
  renderTrackerTags();
  console.log(`Pre-loaded ${Object.keys(state.existingMap).length} authors from tracker data:`, consultantCounts);
}

// ── Consultant Tracker Import (manual override) ──────────────────────────────
function loadTrackerCSV() {
  const file = dom.trackerCsv.files[0];
  const consultant = dom.trackerConsultant.value;
  if (!file) { showTrackerStatus('Select a CSV file.', 'error'); return; }
  showTrackerStatus(`Parsing ${consultant}'s tracker...`, 'info');

  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(r) {
      const { count } = upsertTrackerRows(r.data, consultant);
      if (!state.loadedTrackers.includes(consultant)) state.loadedTrackers.push(consultant);
      showTrackerStatus(`${count} authors loaded for ${consultant}.`, 'success');
      renderTrackerTags();
      dom.trackerCsv.value = ''; // reset file input
    },
    error(e) { showTrackerStatus(`Parse error: ${e.message}`, 'error'); }
  });
}

function normalizeGoogleSheetCsvUrl(inputUrl) {
  const raw = String(inputUrl || '').trim();
  if (!raw) throw new Error('Paste a Google Sheet link.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL.');
  }
  // Direct CSV/export URLs are accepted as-is.
  if (url.searchParams.get('format') === 'csv' || url.pathname.includes('/export')) {
    return url.toString();
  }
  const m = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('Not a valid Google Sheet link.');
  const sheetId = m[1];
  const gid = url.searchParams.get('gid') || '0';
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${encodeURIComponent(gid)}`;
}

async function loadTrackerSheetUrl() {
  const consultant = dom.trackerConsultant.value;
  const inputUrl = (dom.trackerSheetUrl && dom.trackerSheetUrl.value || '').trim();
  if (!inputUrl) { showTrackerStatus('Paste a Google Sheet link first.', 'error'); return; }
  let csvUrl = '';
  try {
    csvUrl = normalizeGoogleSheetCsvUrl(inputUrl);
  } catch (err) {
    showTrackerStatus(err.message || 'Invalid sheet URL.', 'error');
    return;
  }

  showTrackerStatus(`Fetching ${consultant}'s Google Sheet...`, 'info');
  try {
    const res = await fetch(csvUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Sheet fetch failed (${res.status})`);
    const csvText = await res.text();
    Papa.parse(csvText, {
      header: true, skipEmptyLines: true,
      complete(r) {
        const { count } = upsertTrackerRows(r.data, consultant);
        if (!state.loadedTrackers.includes(consultant)) state.loadedTrackers.push(consultant);
        persistConsultantSheetUrl(consultant, inputUrl).catch(() => {});
        renderTrackerTags();
        showTrackerStatus(`${count} authors loaded for ${consultant} from Google Sheet.`, 'success');
      },
      error(e) {
        showTrackerStatus(`Parse error: ${e.message}`, 'error');
      },
    });
  } catch (err) {
    showTrackerStatus(`Google Sheet load failed: ${err.message}`, 'error');
  }
}

function upsertTrackerRows(rows, consultant) {
  let count = 0;
  const compactPatch = {};
  (rows || []).forEach(row => {
    if (!row || typeof row !== 'object') return;
    // Try to find email column (flexible matching for different sheet formats)
    const email = (row['Email ID'] || row['Email'] || row['email'] || row['Email id'] || row['email id'] || '').toLowerCase().trim();
    if (!email) return;

    const name = (row['Name'] || row['Author'] || row['name'] || '').trim();
    const yesVal = (v) => {
      const raw = String(v ?? '').trim();
      if (!raw) return false;
      const lower = raw.toLowerCase();
      return lower === 'yes' || lower === 'done' || lower === 'true' || raw === '✓' || raw === '✔';
    };

    const completedCol = yesVal(row['Completed'] || row['completed']);
    const baseStatus = normalizeAuthorStatus(row['Status'] || row['status']);
    const status = completedCol && baseStatus === 'assigned' ? 'completed' : baseStatus;
    const remarks = String(row['Remarks'] || row['remarks'] || row['Email Update'] || row['email update'] || '').trim();
    const existing = state.existingMap[email] || {};

    state.existingMap[email] = {
      ...existing,
      consultant: consultant,
      name: name || existing.name || null,
      introEmail: yesVal(row['Intro Email'] || row['Intro email']) || !!existing.introEmail,
      authorResponse: yesVal(row['Author Response'] || row['Author response']) || !!existing.authorResponse,
      followUp: yesVal(row['Follow-up Mail'] || row['Follow-up'] || row['Follow up Mail'] || row['Mail (Template)']) || !!existing.followUp,
      markedYes: yesVal(row['Marked "yes" for 5'] || row['Marked Yes'] || row['Marked yes for 5'] || row['Marked "yes" for 5 Author Copies']) || !!existing.markedYes,
      filesGenerated: yesVal(row['Files Generated'] || row['Files generated']) || !!existing.filesGenerated,
      addressMarketing: yesVal(row['Address and Marketing'] || row['Address & Marketing'] || row['Addr & Mktg'] || row['Address and Marketing Guide']) || !!existing.addressMarketing,
      primePlacement: yesVal(row['Prime Placement'] || row['Prime placement']) || !!existing.primePlacement,
      confirmationEmail: yesVal(row['Confirmation Email'] || row['Confirmation email']) || !!existing.confirmationEmail,
      remarks: remarks || existing.remarks || '',
      status: status || existing.status || 'assigned',
    };
    compactPatch[email] = existingMapRowToCompact(state.existingMap[email]);
    count++;
  });
  if (count > 0) {
    persistTrackerOverrideBatch(compactPatch, consultant).catch(() => {});
  }
  return { count, patch: compactPatch };
}

function showTrackerStatus(m, t) {
  dom.trackerStatus.textContent = m;
  dom.trackerStatus.className = `status-msg status-${t}`;
  dom.trackerStatus.classList.remove('hidden');
  clearTimeout(showTrackerStatus._t);
  showTrackerStatus._t = setTimeout(() => dom.trackerStatus.classList.add('hidden'), 6000);
}

function renderTrackerTags() {
  if (state.loadedTrackers.length === 0) { dom.trackerLoaded.innerHTML = ''; return; }
  const totalAuthors = Object.keys(state.existingMap).length;
  dom.trackerLoaded.innerHTML = state.loadedTrackers.map(c =>
    `<span class="tracker-tag">${c} ✓</span>`
  ).join('') + `<span class="tracker-tag" style="background:#e0f2fe;color:#0369a1">${totalAuthors} authors mapped</span>`;
}

// ── CSV Parsing ──────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  showStatus('Parsing CSV...', 'info');
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(r) { state.rawCSV = r.data; dom.btnImport.disabled = false; showStatus(`${r.data.length} rows parsed. Click Import.`, 'success'); },
    error(e) { showStatus(`Parse error: ${e.message}`, 'error'); }
  });
}

function importAndAssign() {
  if (!state.rawCSV) return;
  const incI = dom.filterIndian.checked, incN = dom.filterIntl.checked;
  const filtered = state.rawCSV.filter(row => {
    if (row.status !== 'captured') return false;
    const amt = parseFloat(row.amount);
    return (incI && amt === 11999) || (incN && amt === 249);
  });
  const byEmail = {};
  filtered.forEach(row => {
    const email = (row.email || '').toLowerCase().trim();
    if (!email) return;
    if (!byEmail[email] || parseDate(row.created_at) > parseDate(byEmail[email].created_at)) byEmail[email] = row;
  });
  const unique = Object.values(byEmail);
  unique.sort((a, b) => parseDate(a.created_at) - parseDate(b.created_at));

  state.rrIndex = 0;
  let preAssigned = 0;
  state.authors = unique.map((row, i) => {
    const amt = parseFloat(row.amount);
    const pkg = PACKAGES[amt];
    const email = (row.email || '').toLowerCase().trim();
    const existing = state.existingMap[email];

    let consultant, status, remarks;
    let introEmail = false, authorResponse = false, followUp = false, markedYes = false;
    let filesGenerated = false, addressMarketing = false, primePlacement = false, confirmationEmail = false;

    if (existing) {
      // Use existing assignment from tracker sheet
      consultant = existing.consultant;
      status = existing.status || 'assigned';
      remarks = existing.remarks || '';
      introEmail = !!existing.introEmail;
      authorResponse = !!existing.authorResponse;
      followUp = !!existing.followUp;
      markedYes = !!existing.markedYes;
      filesGenerated = !!existing.filesGenerated;
      addressMarketing = !!existing.addressMarketing;
      primePlacement = !!existing.primePlacement;
      confirmationEmail = !!existing.confirmationEmail;
      preAssigned++;
    } else {
      // Round-robin for new authors
      const c = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length];
      state.rrIndex++;
      consultant = c.name;
      status = 'assigned';
      remarks = '';
    }

    return {
      id: row.id || `a-${i}`, name: existing && existing.name ? existing.name : extractName(row),
      email: (row.email || '').trim(), phone: (row.contact || '').trim(),
      package: pkg ? pkg.label : `₹${amt}`, packageKey: pkg ? pkg.key : 'other',
      paymentDate: row.created_at || '', consultant, status, remarks,
      introEmail, authorResponse, followUp, markedYes,
      filesGenerated, addressMarketing, primePlacement, confirmationEmail,
    };
  });
  const newAssigned = state.authors.length - preAssigned;
  showStatus(`${state.authors.length} authors. ${preAssigned} matched from trackers, ${newAssigned} new (round-robin).`, 'success');
  refreshUI();
  queueAuthorsRuntimeSnapshotPersist();
}

function extractName(row) {
  try { const p = JSON.parse(row.notes || ''); if (p.name) return p.name.trim(); if (p.registered_name) return p.registered_name.trim(); } catch {}
  try { const p = JSON.parse(row.card || ''); if (p.name && p.name.trim()) return p.name.trim(); } catch {}
  return row.email ? row.email.split('@')[0] : 'Unknown';
}
function normalizeAuthorStatus(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'assigned';
  if (v === '✓' || v === '✔' || v === 'yes' || v === 'true' || v === 'done') return 'good-to-go';
  if (v.includes('good') || v.includes('g2g') || v.includes('gtg')) return 'good-to-go';
  if (v.includes('in progress') || v.includes('in-progress') || v === 'inprogress') return 'in-progress';
  if (v.includes('complete') || v.includes('resolved') || v.includes('closed')) return 'completed';
  if (v === 'assigned') return 'assigned';
  return 'assigned';
}
function authorStatusLabel(status) { return AUTHOR_STATUS_LABELS[normalizeAuthorStatus(status)] || 'Assigned'; }
function authorStatusOptionsHtml(currentStatus) {
  const normalized = normalizeAuthorStatus(currentStatus);
  return AUTHOR_STATUS_OPTIONS.map(s =>
    `<option value="${s}" ${normalized===s?'selected':''}>${AUTHOR_STATUS_LABELS[s]}</option>`
  ).join('');
}
function syncAuthorToExistingMap(author) {
  if (!author || !author.email) return;
  const email = String(author.email).trim().toLowerCase();
  if (!email) return;
  const prev = state.existingMap[email];
  if (!prev) return;
  state.existingMap[email] = {
    ...prev,
    consultant: author.consultant || prev.consultant || '',
    name: author.name || prev.name || null,
    introEmail: !!author.introEmail,
    authorResponse: !!author.authorResponse,
    followUp: !!author.followUp,
    markedYes: !!author.markedYes,
    filesGenerated: !!author.filesGenerated,
    addressMarketing: !!author.addressMarketing,
    primePlacement: !!author.primePlacement,
    confirmationEmail: !!author.confirmationEmail,
    remarks: author.remarks || '',
    status: normalizeAuthorStatus(author.status),
  };
}
function parseDate(s) { if (!s) return 0; const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(m[3], m[2]-1, m[1], m[4], m[5], m[6]).getTime() : new Date(s).getTime() || 0; }
function parseDateDDMMYYYY(s) {
  if (!s) return null;
  const raw = String(s).trim().split(/\s+/)[0];
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}
function parseISODateOnly(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
function formatDate(s) { if (!s) return '—'; const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[1]}/${m[2]}/${m[3]}` : s; }

// ── Sample Data ──────────────────────────────────────────────────────────────
function loadSampleData() {
  state.rrIndex = 0;
  const s = [
    { name: 'Prisha Goel', email: 'prisha.p23@gmail.com', phone: '+917011363048', package: 'Indian Bestseller', packageKey: 'indian', paymentDate: '17/11/2025' },
    { name: 'Kavya PK', email: 'kavya@gmail.com', phone: '+917907571937', package: 'Indian Bestseller', packageKey: 'indian', paymentDate: '17/11/2025' },
    { name: 'Danielle Moody', email: 'dani@gmail.com', phone: '8035439679', package: 'Intl Bestseller', packageKey: 'intl', paymentDate: '17/11/2025' },
    { name: 'Alia Colaco', email: 'alia@gmail.com', phone: '+919870506772', package: 'Indian Bestseller', packageKey: 'indian', paymentDate: '17/11/2025' },
    { name: 'Veena Garg', email: 'veena@gmail.com', phone: '+918696270000', package: 'Indian Bestseller', packageKey: 'indian', paymentDate: '17/11/2025' },
  ];
  state.authors = s.map((a, i) => {
    const c = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length]; state.rrIndex++;
    return { id: `a-${i}`, ...a, consultant: c.name, status: 'assigned', remarks: '',
      introEmail: false, authorResponse: false, followUp: false, markedYes: false,
      filesGenerated: false, addressMarketing: false, primePlacement: false, confirmationEmail: false };
  });
  showStatus('Sample data loaded.', 'success'); refreshUI();
  queueAuthorsRuntimeSnapshotPersist();
}

// ── Actions ──────────────────────────────────────────────────────────────────
function autoAssign() {
  if (ACTIVE_CONSULTANTS.length === 0) { showStatus('No active consultants available.', 'error'); return; }
  state.rrIndex = 0;
  state.authors.forEach(a => {
    if (!a.consultant || a.status === 'assigned') {
      a.consultant = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length].name;
      a.status = 'assigned';
      state.rrIndex++;
    }
  });
  showStatus('Re-assigned new authors via round-robin.', 'success'); refreshUI();
  queueAuthorsRuntimeSnapshotPersist();
}
function clearAssignments() {
  if (!confirm('This will clear all consultant assignments and reset all statuses. Continue?')) return;
  state.authors.forEach(a => { a.consultant = ''; a.status = 'assigned'; });
  showStatus('Cleared.', 'info'); refreshUI();
  queueAuthorsRuntimeSnapshotPersist();
}
function changeStatus(id, val) {
  const a = state.authors.find(x => x.id === id);
  if (!a) return;
  const normalized = normalizeAuthorStatus(val);
  if (a.status === normalized) return;
  a.status = normalized;
  syncAuthorToExistingMap(a);
  queueAuthorOverridePersist(a);
  refreshUI();
}
function reassign(id, val) {
  const a = state.authors.find(x => x.id === id);
  if (!a) return;
  a.consultant = val;
  syncAuthorToExistingMap(a);
  queueAuthorOverridePersist(a);
  refreshUI();
}
function toggleStage(id, stage) {
  if (!STAGES.includes(stage)) return;
  const a = state.authors.find(x => x.id === id);
  if (a) {
    a[stage] = !a[stage];
    syncAuthorToExistingMap(a);
    queueAuthorOverridePersist(a);
    refreshUI();
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
function updateRemarks(id, val) {
  const a = state.authors.find(x => x.id === id);
  if (!a) return;
  a.remarks = val;
  syncAuthorToExistingMap(a);
  queueAuthorOverridePersist(a);
}

function exportCSV() {
  const rows = [['Author','Email','Phone','Package','Payment Date','Consultant','Status','Intro Email','Author Response','Follow-up','Marked Yes','Files Generated','Address & Marketing','Prime Placement','Confirmation Email','Remarks','FD Tickets']];
  getViewAuthors().forEach(a => {
    const tc = state.tickets.filter(t => t.requesterEmail === a.email.toLowerCase()).length;
    rows.push([a.name, a.email, a.phone, a.package, a.paymentDate, a.consultant, a.status,
      a.introEmail?'Yes':'No', a.authorResponse?'Yes':'No', a.followUp?'Yes':'No', a.markedYes?'Yes':'No',
      a.filesGenerated?'Yes':'No', a.addressMarketing?'Yes':'No', a.primePlacement?'Yes':'No',
      a.confirmationEmail?'Yes':'No', a.remarks||'', tc]);
  });
  const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `assignments_${new Date().toISOString().split('T')[0]}.csv`; link.click();
  URL.revokeObjectURL(url);
}

// ── Team View ────────────────────────────────────────────────────────────────
function getViewAuthors() {
  if (state.currentView === 'admin') return state.authors;
  return state.authors.filter(a => a.consultant === state.currentView);
}

function switchView(view) {
  state.currentView = view;
  const isAdmin = view === 'admin';

  // Update badge
  if (isAdmin) {
    dom.identityBadge.textContent = 'Admin View';
    dom.identityBadge.className = 'identity-badge identity-admin';
  } else {
    dom.identityBadge.textContent = `${view}'s Dashboard`;
    dom.identityBadge.className = 'identity-badge identity-consultant';
  }

  // Show/hide admin-only elements
  document.querySelectorAll('.admin-section, .actions-row').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });

  // Show/hide filters not needed in team view
  if (dom.filterConsultant) dom.filterConsultant.style.display = isAdmin ? '' : 'none';
  if (dom.filterPackage) dom.filterPackage.style.display = isAdmin ? '' : 'none';

  // Update workload section heading
  const wlH2 = document.querySelector('#workload-section h2');
  if (wlH2) wlH2.textContent = isAdmin ? 'Consultant Workload' : 'My Summary';

  // In team view, show status filter with ticket-relevant options
  if (!isAdmin) {
    dom.filterStatus.innerHTML = '<option value="all">All Statuses</option><option value="assigned">Assigned</option><option value="in-progress">In Progress</option><option value="good-to-go">Good to Go</option><option value="completed">Completed</option>';
  }
  if (dom.fdServerSyncCard) {
    dom.fdServerSyncCard.classList.toggle('hidden', !isAdmin);
    if (isAdmin) refreshFreshdeskServerSyncStatus({ silent: true }).catch(() => {});
  }

  refreshUI();
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
function refreshUI() { updateStats(); renderTable(); renderWorkload(); renderTickets(); renderPerformance(); renderCallbacks(); toggleButtons(); }

function updateStats() {
  const authors = getViewAuthors();
  const isTeamView = state.currentView !== 'admin';
  const trackerCount = isTeamView ? getTrackerCountByConsultant(state.currentView) : 0;

  dom.statAuthors.textContent = isTeamView ? (trackerCount || authors.length) : authors.length;
  dom.statIndian.textContent = authors.filter(a => a.packageKey === 'indian').length;
  dom.statIntl.textContent = authors.filter(a => a.packageKey === 'intl').length;
  dom.statGood.textContent = authors.filter(a => a.status === 'good-to-go').length;

  if (isTeamView) {
    // Team view: show open tickets count + need reply count
    const viewEmails = authors.map(a => a.email.toLowerCase());
    const myTickets = state.tickets.filter(t => viewEmails.includes(t.requesterEmail));
    const openTickets = myTickets.filter(t => t.statusCode === 2 || t.statusCode === 3).length;
    dom.statTickets.textContent = openTickets;
    // Update labels for team view
    const statAuthorsCard = document.querySelector('#stat-authors')?.closest('.stat-card')?.querySelector('.stat-label');
    const statTicketsCard = document.querySelector('#stat-tickets')?.closest('.stat-card')?.querySelector('.stat-label');
    const statAssignedCard = document.querySelector('#stat-assigned')?.closest('.stat-card')?.querySelector('.stat-label');
    if (statAuthorsCard) statAuthorsCard.textContent = trackerCount ? 'Tracker Authors' : 'Authors';
    if (statTicketsCard) statTicketsCard.textContent = 'Open Tickets';
    if (statAssignedCard) statAssignedCard.textContent = 'Need Reply';
    // "Need Reply" = authors with open/pending tickets
    const authorsNeedReply = authors.filter(a => {
      return myTickets.some(t => t.requesterEmail === a.email.toLowerCase() && (t.statusCode === 2 || t.statusCode === 3));
    }).length;
    dom.statAssigned.textContent = authorsNeedReply;
  } else {
    // Admin view: standard stats
    dom.statTickets.textContent = state.tickets.length;
    dom.statAssigned.textContent = authors.filter(a => a.consultant).length;
    const statAuthorsCardA = document.querySelector('#stat-authors')?.closest('.stat-card')?.querySelector('.stat-label');
    const statTicketsCardA = document.querySelector('#stat-tickets')?.closest('.stat-card')?.querySelector('.stat-label');
    const statAssignedCardA = document.querySelector('#stat-assigned')?.closest('.stat-card')?.querySelector('.stat-label');
    if (statAuthorsCardA) statAuthorsCardA.textContent = 'Authors';
    if (statTicketsCardA) statTicketsCardA.textContent = 'FD Tickets';
    if (statAssignedCardA) statAssignedCardA.textContent = 'Assigned';
  }
}

function renderTable() {
  const search = dom.searchInput.value.toLowerCase();
  const pkgF = dom.filterPackage.value, conF = dom.filterConsultant.value, staF = dom.filterStatus.value;
  const isTeamView = state.currentView !== 'admin';
  // Update section heading
  const sectionH2 = document.querySelector('#assignments-section h2');
  if (sectionH2) {
    sectionH2.textContent = isTeamView ? `My Authors — ${state.currentView}` : 'Author Assignments & Workflow';
  }
  let rows = getViewAuthors();
  if (search) rows = rows.filter(a => a.name.toLowerCase().includes(search) || a.email.toLowerCase().includes(search) || (a.consultant && a.consultant.toLowerCase().includes(search)));
  if (pkgF !== 'all') rows = rows.filter(a => a.packageKey === pkgF);
  if (!isTeamView && conF !== 'all') rows = rows.filter(a => a.consultant === conF);
  if (staF !== 'all') rows = rows.filter(a => a.status === staF);

  // Update table header based on view
  const thead = document.querySelector('#assignments-table thead tr');

  if (isTeamView) {
    // ── TEAM VIEW: simplified ticket-reply focused table ──
    if (thead) {
      thead.innerHTML = '<th>#</th><th>Author</th><th>Email</th><th>Package</th><th>Date</th><th>Status</th><th>FD Tickets</th><th>Action</th><th>Remarks</th>';
    }
    if (rows.length === 0) { dom.tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No authors assigned to you.</td></tr>'; return; }

    dom.tbody.innerHTML = rows.map((a, idx) => {
      const pkgC = a.packageKey === 'indian' ? 'badge-indian' : 'badge-intl';
      const authorTickets = state.tickets.filter(t => t.requesterEmail === a.email.toLowerCase());
      const tix = authorTickets.length;
      const hasOpenTicket = authorTickets.some(t => t.statusCode === 2 || t.statusCode === 3);
      const latestTicket = authorTickets.length > 0 ? authorTickets[0] : null;

      // Ticket badge with status
      let tBadge;
      if (tix > 0) {
        const openCount = authorTickets.filter(t => t.statusCode === 2).length;
        const pendCount = authorTickets.filter(t => t.statusCode === 3).length;
        const resCount = authorTickets.filter(t => t.statusCode === 4 || t.statusCode === 5).length;
        let parts = [];
        if (openCount) parts.push(`<span class="badge fd-status-open">${openCount} Open</span>`);
        if (pendCount) parts.push(`<span class="badge fd-status-pending">${pendCount} Pending</span>`);
        if (resCount) parts.push(`<span class="badge fd-status-resolved">${resCount} Resolved</span>`);
        tBadge = parts.join(' ');
      } else {
        tBadge = '<span class="muted">No tickets</span>';
      }

      // Action (team view): only allow replying to open/pending Freshdesk tickets
      let actionBtn;
      if (latestTicket && hasOpenTicket) {
        const openTicket = authorTickets.find(t => t.statusCode === 2 || t.statusCode === 3);
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/${openTicket.id}" target="_blank" class="btn btn-sm btn-primary">Reply on FD</a>`;
      } else {
        actionBtn = `<span class="muted">No open FD ticket</span>`;
      }

      // Status is editable in team view as well (Google Sheet-like workflow updates).
      const statusSelect = `<select onchange="changeStatus('${a.id}',this.value)" class="inline-select status-${a.status}" aria-label="Status for ${esc(a.name)}">
        ${authorStatusOptionsHtml(a.status)}
      </select>`;

      return `<tr class="${hasOpenTicket ? 'row-needs-reply' : ''}">
        <td class="td-center muted">${idx + 1}</td>
        <td class="td-name">${esc(a.name)}</td>
        <td class="td-email">${esc(a.email)}</td>
        <td><span class="badge ${pkgC}">${esc(a.package)}</span></td>
        <td>${formatDate(a.paymentDate)}</td>
        <td>${statusSelect}</td>
        <td class="td-tickets">${tBadge}</td>
        <td class="td-center">${actionBtn}</td>
        <td><input type="text" value="${esc(a.remarks||'')}" onchange="updateRemarks('${a.id}',this.value)" class="remarks-input remarks-wide" placeholder="Add note..."></td>
      </tr>`;
    }).join('');

  } else {
    // ── ADMIN VIEW: full workflow table ──
    if (thead) {
      thead.innerHTML = '<th>Author</th><th>Email</th><th>Package</th><th>Date</th><th>Consultant</th><th>Intro Email</th><th>Author Resp.</th><th>Follow-up</th><th>Marked Yes</th><th>Status</th><th>Files Gen.</th><th>Addr &amp; Mktg</th><th>Prime Place.</th><th>Confirm Email</th><th>Remarks</th><th>FD</th>';
    }
    if (rows.length === 0) { dom.tbody.innerHTML = '<tr class="empty-row"><td colspan="16">No matching records.</td></tr>'; return; }

    dom.tbody.innerHTML = rows.map(a => {
      const pkgC = a.packageKey === 'indian' ? 'badge-indian' : 'badge-intl';
      const conOpts = CONSULTANTS.map(c => `<option value="${c.name}" ${a.consultant === c.name ? 'selected' : ''}>${c.name}${c.active ? '' : ' (Left)'}</option>`).join('');
      const tix = state.tickets.filter(t => t.requesterEmail === a.email.toLowerCase()).length;
      const tBadge = tix > 0 ? `<span class="badge badge-fd">${tix}</span>` : '<span class="muted">—</span>';

      const ck = (stage) => `<input type="checkbox" ${a[stage] ? 'checked' : ''} onchange="toggleStage('${a.id}','${stage}')" class="stage-cb">`;

      return `<tr>
        <td class="td-name">${esc(a.name)}</td>
        <td class="td-email">${esc(a.email)}</td>
        <td><span class="badge ${pkgC}">${esc(a.package)}</span></td>
        <td>${formatDate(a.paymentDate)}</td>
        <td><select onchange="reassign('${a.id}',this.value)" class="inline-select">${conOpts}</select></td>
        <td class="td-center">${ck('introEmail')}</td>
        <td class="td-center">${ck('authorResponse')}</td>
        <td class="td-center">${ck('followUp')}</td>
        <td class="td-center">${ck('markedYes')}</td>
        <td><select onchange="changeStatus('${a.id}',this.value)" class="inline-select status-${a.status}">
          ${authorStatusOptionsHtml(a.status)}
        </select></td>
        <td class="td-center">${ck('filesGenerated')}</td>
        <td class="td-center">${ck('addressMarketing')}</td>
        <td class="td-center">${ck('primePlacement')}</td>
        <td class="td-center">${ck('confirmationEmail')}</td>
        <td><input type="text" value="${esc(a.remarks||'')}" onchange="updateRemarks('${a.id}',this.value)" class="remarks-input" placeholder="—"></td>
        <td class="td-center">${tBadge}</td>
      </tr>`;
    }).join('');
  }
}

function renderWorkload() {
  if (state.authors.length === 0) { dom.workloadGrid.innerHTML = '<p class="placeholder-text">Import data to view.</p>'; return; }
  const isTeamView = state.currentView !== 'admin';
  const visibleConsultants = isTeamView
    ? CONSULTANTS.filter(c => c.name === state.currentView)
    : CONSULTANTS.filter(c => c.active || state.authors.some(a => a.consultant === c.name));

  if (isTeamView) {
    // ── TEAM VIEW: summary cards with action-focused stats ──
    const c = visibleConsultants[0];
    if (!c) return;
    const assigned = state.authors.filter(a => a.consultant === c.name);
    const good = assigned.filter(a => a.status === 'good-to-go').length;
    const done = assigned.filter(a => a.status === 'completed').length;
    const inProg = assigned.filter(a => a.status === 'in-progress').length;
    const pending = assigned.filter(a => a.status === 'assigned').length;
    const emails = assigned.map(a => a.email.toLowerCase());
    const myTickets = state.tickets.filter(t => emails.includes(t.requesterEmail));
    const openTix = myTickets.filter(t => t.statusCode === 2 || t.statusCode === 3).length;
    const resolvedTix = myTickets.filter(t => t.statusCode === 4 || t.statusCode === 5).length;
    const trackerCount = getTrackerCountByConsultant(c.name);

    dom.workloadGrid.innerHTML = `
      <div class="summary-card summary-total"><span class="summary-num">${trackerCount || assigned.length}</span><span class="summary-label">${trackerCount ? 'Tracker Authors' : 'Current Authors'}</span></div>
      ${trackerCount ? `<div class="summary-card"><span class="summary-num">${assigned.length}</span><span class="summary-label">Current Pool</span></div>` : ''}
      <div class="summary-card summary-pending"><span class="summary-num">${pending}</span><span class="summary-label">New / Assigned</span></div>
      <div class="summary-card summary-inprog"><span class="summary-num">${inProg}</span><span class="summary-label">In Progress</span></div>
      <div class="summary-card summary-good"><span class="summary-num">${good}</span><span class="summary-label">Good to Go</span></div>
      <div class="summary-card summary-done"><span class="summary-num">${done}</span><span class="summary-label">Completed</span></div>
      <div class="summary-card summary-tickets"><span class="summary-num">${openTix}</span><span class="summary-label">Open Tickets</span></div>
    `;
  } else {
    // ── ADMIN VIEW: consultant workload cards ──
    dom.workloadGrid.innerHTML = visibleConsultants.map(c => {
      const assigned = state.authors.filter(a => a.consultant === c.name);
      const indian = assigned.filter(a => a.packageKey === 'indian').length;
      const intl = assigned.filter(a => a.packageKey === 'intl').length;
      const good = assigned.filter(a => a.status === 'good-to-go').length;
      const done = assigned.filter(a => a.status === 'completed').length;
      const emails = assigned.map(a => a.email.toLowerCase());
      const tix = state.tickets.filter(t => emails.includes(t.requesterEmail)).length;
      const trackerCount = getTrackerCountByConsultant(c.name);
      const tag = c.active ? (c.freshdeskAgentId ? '<span class="fd-connected">FD ✓</span>' : '<span class="fd-disconnected">FD ✗</span>') : '<span class="resigned-tag">Resigned</span>';

      return `<div class="workload-card ${c.active ? '' : 'wl-resigned'}">
        <div class="wl-header"><h3>${esc(c.name)}</h3>${tag}</div>
        <div class="workload-stats">
          <span class="wl-total">${trackerCount || assigned.length}</span>
          ${trackerCount ? `<span class="wl-tickets">${assigned.length} CUR</span>` : ''}
          <span class="wl-indian">${indian} IND</span>
          <span class="wl-intl">${intl} INTL</span>
          <span class="wl-good">${good} GTG</span>
          <span class="wl-done">${done} Done</span>
          ${tix ? `<span class="wl-tickets">${tix} FD</span>` : ''}
        </div>
        <div class="workload-bar"><div class="bar-fill" style="width:${state.authors.length ? (assigned.length/state.authors.length*100) : 0}%"></div></div>
      </div>`;
    }).join('');
  }
}

function renderTickets() {
  if (!dom.ticketsBody) return;
  if (!state.tickets.length) {
    dom.ticketsBody.innerHTML = '<tr class="empty-row"><td colspan="7">No tickets synced yet.</td></tr>';
    if (dom.btnFdAutoAssign) dom.btnFdAutoAssign.disabled = true;
    if (dom.ticketsSection) dom.ticketsSection.classList.add('hidden');
    return;
  }
  if (dom.ticketsSection) dom.ticketsSection.classList.remove('hidden');
  const search = (dom.ticketSearch.value || '').toLowerCase();
  const mf = dom.ticketFilterMatch.value;
  let rows = state.tickets;
  // In team view, only show tickets for this consultant's authors
  if (state.currentView !== 'admin') {
    const viewEmails = getViewAuthors().map(a => a.email.toLowerCase());
    rows = rows.filter(t => viewEmails.includes(t.requesterEmail));
  }
  if (search) rows = rows.filter(t => t.subject.toLowerCase().includes(search) || t.requesterEmail.includes(search) || (t.matchedAuthor && t.matchedAuthor.toLowerCase().includes(search)));
  if (mf === 'matched') rows = rows.filter(t => t.isMatched);
  if (mf === 'unmatched') rows = rows.filter(t => !t.isMatched);
  if (!rows.length) { dom.ticketsBody.innerHTML = '<tr class="empty-row"><td colspan="7">No tickets.</td></tr>'; return; }
  dom.ticketsBody.innerHTML = rows.map(t => {
    const mc = t.isMatched ? 'td-matched' : 'td-unmatched';
    const sc = `fd-status-${t.status.toLowerCase()}`;
    const act = t.needsReassign ? `<button class="btn btn-sm btn-accent" onclick="assignSingleTicket(${t.id})">→ ${esc(t.matchedConsultant)}</button>` : (t.isMatched ? '<span class="muted">OK</span>' : '<span class="muted">—</span>');
    return `<tr>
      <td><a href="https://${FD_DOMAIN}/a/tickets/${t.id}" target="_blank" class="ticket-link">#${t.id}</a></td>
      <td class="td-subject">${esc(t.subject)}</td>
      <td class="td-email">${esc(t.requesterEmail)}</td>
      <td class="${mc}">${t.matchedAuthor ? esc(t.matchedAuthor) : '<span class="muted">—</span>'}</td>
      <td>${t.matchedConsultant ? esc(t.matchedConsultant) : '<span class="muted">—</span>'}</td>
      <td><span class="badge ${sc}">${t.status}</span></td>
      <td>${act}</td>
    </tr>`;
  }).join('');
}

function toggleButtons() {
  const h = state.authors.length > 0;
  dom.btnAutoAssign.disabled = !h; dom.btnClear.disabled = !h; dom.btnExport.disabled = !h;
}

function showStatus(m, t) { dom.apiStatus.textContent = m; dom.apiStatus.className = `status-msg status-${t}`; dom.apiStatus.classList.remove('hidden'); clearTimeout(showStatus._t); showStatus._t = setTimeout(() => dom.apiStatus.classList.add('hidden'), 8000); }
function showFdStatus(m, t) { dom.fdStatus.textContent = m; dom.fdStatus.className = `status-msg status-${t}`; dom.fdStatus.classList.remove('hidden'); clearTimeout(showFdStatus._t); showFdStatus._t = setTimeout(() => dom.fdStatus.classList.add('hidden'), 10000); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML.replace(/'/g, '&#39;'); }
function getTrackerCountByConsultant(name) {
  if (state.trackerCounts && Number.isFinite(Number(state.trackerCounts[name]))) {
    return Number(state.trackerCounts[name]);
  }
  let count = 0;
  Object.values(state.existingMap || {}).forEach(v => { if (v && v.consultant === name) count++; });
  return count;
}

// ── Performance Tracker (visible to all) ──────────────────────────────────────
function renderPerformance() {
  if (!dom.performanceGrid) return;
  if (state.authors.length === 0) {
    dom.performanceGrid.innerHTML = '<p class="placeholder-text">Import data to view performance.</p>';
    return;
  }

  const visibleConsultants = CONSULTANTS.filter(
    c => c.active || state.authors.some(a => a.consultant === c.name)
  );
  let metrics = visibleConsultants.map(c => {
    const assigned = state.authors.filter(a => a.consultant === c.name);
    const total = assigned.length;
    const trackerCount = getTrackerCountByConsultant(c.name);
    const completed = assigned.filter(a => a.status === 'completed').length;
    const goodToGo = assigned.filter(a => a.status === 'good-to-go').length;
    const inProgress = assigned.filter(a => a.status === 'in-progress').length;

    // Workflow completion: count stages done across all assigned authors
    let totalStages = 0, doneStages = 0;
    assigned.forEach(a => {
      STAGES.forEach(s => { totalStages++; if (a[s]) doneStages++; });
    });
    const workflowPct = totalStages > 0 ? Math.round((doneStages / totalStages) * 100) : 0;

    // Tickets resolved
    const emails = assigned.map(a => a.email.toLowerCase());
    const myTickets = state.tickets.filter(t => emails.includes(t.requesterEmail));
    const resolved = myTickets.filter(t => t.statusCode === 4 || t.statusCode === 5).length;

    // Callbacks completed
    const cbDone = state.callbacks.filter(cb => cb.consultant === c.name && cb.status === 'completed').length;
    const cbTotal = state.callbacks.filter(cb => cb.consultant === c.name).length;

    // Performance score: weighted composite
    const score = (completed * 10) + (goodToGo * 5) + (inProgress * 2) + (resolved * 3) + (cbDone * 4) + Math.round(workflowPct * total / 100);

    return { name: c.name, total, trackerCount, completed, goodToGo, inProgress, workflowPct, resolved, cbDone, cbTotal, score };
  });

  if (state.currentView !== 'admin') {
    metrics = metrics.filter(m => m.name === state.currentView);
  }

  // Sort by score descending
  metrics.sort((a, b) => b.score - a.score);
  const maxScore = metrics[0]?.score || 1;

  dom.performanceGrid.innerHTML = metrics.map((m, idx) => {
    const rank = idx + 1;
    const rankClass = rank <= 3 ? ` perf-rank-${rank}` : '';
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

    return `<div class="perf-card${rankClass}">
      <span class="perf-rank">${medal}</span>
      <div class="perf-name">${esc(m.name)}</div>
      <div class="perf-score">${m.score} pts</div>
      <div class="perf-stats">
        <span>✅ ${m.completed} done</span>
        <span>🟢 ${m.goodToGo} GTG</span>
        <span>📊 ${m.workflowPct}% workflow</span>
        <span>🗂 ${m.trackerCount || m.total} tracker</span>
        ${m.trackerCount ? `<span>📋 ${m.total} current</span>` : ''}
        ${m.resolved ? `<span>🎫 ${m.resolved} resolved</span>` : ''}
        ${m.cbDone ? `<span>📞 ${m.cbDone}/${m.cbTotal} callbacks</span>` : ''}
      </div>
      <div class="perf-bar"><div class="perf-bar-fill" style="width:${Math.round((m.score / maxScore) * 100)}%"></div></div>
    </div>`;
  }).join('');
}

// ── Callback Tracker ─────────────────────────────────────────────────────────
function generateCallbackId() {
  return 'cb-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
}

function saveCallbacksToStorage() {
  try { localStorage.setItem('bookleaf_callbacks', JSON.stringify(state.callbacks)); } catch {}
  queueCallbacksPersist();
}

function loadCallbacksFromStorage() {
  try {
    const saved = localStorage.getItem('bookleaf_callbacks');
    if (saved) state.callbacks = JSON.parse(saved);
  } catch {}
}

function openCallbackModal(callbackId) {
  state.editingCallbackId = callbackId || null;
  const modal = dom.callbackModal;
  if (!modal) return;

  // Populate author datalist
  if (dom.cbAuthorList) {
    dom.cbAuthorList.innerHTML = state.authors.map(a =>
      `<option value="${esc(a.email)}">${esc(a.name)} — ${esc(a.email)}</option>`
    ).join('');
  }

  if (callbackId) {
    const cb = state.callbacks.find(c => c.id === callbackId);
    if (!cb) return;
    const modalTitleEdit = document.getElementById('callback-modal-title');
    if (modalTitleEdit) modalTitleEdit.textContent = 'Edit Callback';
    dom.cbAuthorEmail.value = cb.authorEmail;
    dom.cbDatetime.value = cb.datetime;
    dom.cbNotes.value = cb.notes || '';
  } else {
    const modalTitleNew = document.getElementById('callback-modal-title');
    if (modalTitleNew) modalTitleNew.textContent = 'Schedule Callback';
    dom.cbAuthorEmail.value = '';
    // Default: tomorrow 11am
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(11, 0, 0, 0);
    dom.cbDatetime.value = tomorrow.toISOString().slice(0, 16);
    dom.cbNotes.value = '';
  }

  updateCbAuthorMatch();
  modal.classList.remove('hidden');
}

function closeCallbackModal() {
  if (dom.callbackModal) dom.callbackModal.classList.add('hidden');
  state.editingCallbackId = null;
}

function updateCbAuthorMatch() {
  if (!dom.cbAuthorMatch) return;
  const email = (dom.cbAuthorEmail.value || '').toLowerCase().trim();
  const author = state.authors.find(a => a.email.toLowerCase() === email);
  if (author) {
    dom.cbAuthorMatch.textContent = `✓ ${author.name} — ${author.consultant}`;
    dom.cbAuthorMatch.style.color = '#16a34a';
  } else if (email) {
    dom.cbAuthorMatch.textContent = 'No matching author (will save anyway)';
    dom.cbAuthorMatch.style.color = '#d97706';
  } else {
    dom.cbAuthorMatch.textContent = '';
  }
}

function saveCallback() {
  const email = (dom.cbAuthorEmail.value || '').trim();
  const datetime = dom.cbDatetime.value;
  const notes = (dom.cbNotes.value || '').trim();

  if (!email) { alert('Enter an author email.'); return; }
  if (!datetime) { alert('Pick a date & time.'); return; }

  const author = state.authors.find(a => a.email.toLowerCase() === email.toLowerCase());
  const authorName = author ? author.name : email.split('@')[0];
  const consultant = author ? author.consultant : (state.currentView !== 'admin' ? state.currentView : '');

  if (state.editingCallbackId) {
    const cb = state.callbacks.find(c => c.id === state.editingCallbackId);
    if (cb) {
      cb.authorEmail = email;
      cb.authorName = authorName;
      cb.consultant = consultant;
      cb.datetime = datetime;
      cb.notes = notes;
    }
  } else {
    state.callbacks.push({
      id: generateCallbackId(),
      authorEmail: email,
      authorName: authorName,
      consultant: consultant,
      datetime: datetime,
      notes: notes,
      status: 'upcoming',
    });
  }

  saveCallbacksToStorage();
  closeCallbackModal();
  refreshUI();
}

function updateCallbackStatus(cbId, newStatus) {
  const cb = state.callbacks.find(c => c.id === cbId);
  if (cb) { cb.status = newStatus; saveCallbacksToStorage(); refreshUI(); }
}

function deleteCallback(cbId) {
  state.callbacks = state.callbacks.filter(c => c.id !== cbId);
  saveCallbacksToStorage();
  refreshUI();
}

function generateCalendarLink(cb) {
  // Google Calendar link
  const start = new Date(cb.datetime);
  const end = new Date(start.getTime() + 30 * 60000); // 30 min call
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const title = encodeURIComponent(`Callback: ${cb.authorName} — Bookleaf Publishing`);
  const details = encodeURIComponent(`Author: ${cb.authorName}\nEmail: ${cb.authorEmail}\nConsultant: ${cb.consultant}\n\nNotes: ${cb.notes || 'N/A'}`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${fmt(start)}/${fmt(end)}&details=${details}`;
}

function autoUpdateCallbackStatuses() {
  const now = new Date();
  let changed = false;
  state.callbacks.forEach(cb => {
    if (cb.status === 'upcoming') {
      const cbTime = new Date(cb.datetime);
      // If callback time was more than 1 hour ago and still "upcoming", mark as missed
      if (cbTime < new Date(now.getTime() - 60 * 60000)) {
        cb.status = 'missed';
        changed = true;
      }
    }
  });
  if (changed) saveCallbacksToStorage();
}

function renderCallbacks() {
  if (!dom.callbackBody) return;
  autoUpdateCallbackStatuses();

  const filterVal = dom.callbackFilter ? dom.callbackFilter.value : 'upcoming';
  const search = dom.callbackSearch ? dom.callbackSearch.value.toLowerCase() : '';
  const isTeamView = state.currentView !== 'admin';

  let rows = state.callbacks;

  // Team view: only show callbacks for this consultant
  if (isTeamView) {
    rows = rows.filter(cb => cb.consultant === state.currentView);
  }

  if (filterVal === 'upcoming') rows = rows.filter(cb => cb.status === 'upcoming');
  else if (filterVal === 'completed') rows = rows.filter(cb => cb.status === 'completed');
  else if (filterVal === 'missed') rows = rows.filter(cb => cb.status === 'missed');

  if (search) {
    rows = rows.filter(cb =>
      cb.authorName.toLowerCase().includes(search) ||
      cb.authorEmail.toLowerCase().includes(search) ||
      (cb.consultant && cb.consultant.toLowerCase().includes(search))
    );
  }

  // Sort by datetime
  rows.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (rows.length === 0) {
    dom.callbackBody.innerHTML = `<tr class="empty-row"><td colspan="7">${filterVal === 'upcoming' ? 'No upcoming callbacks.' : 'No callbacks found.'}</td></tr>`;
    return;
  }

  dom.callbackBody.innerHTML = rows.map(cb => {
    const dt = new Date(cb.datetime);
    const dtStr = dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const statusClass = `cb-status-${cb.status}`;
    const statusLabel = cb.status === 'upcoming' ? 'Upcoming' : cb.status === 'completed' ? 'Completed' : cb.status === 'missed' ? 'Missed' : cb.status;
    const calLink = generateCalendarLink(cb);

    let actions = '';
    if (cb.status === 'upcoming') {
      actions = `
        <button class="btn btn-sm btn-primary" onclick="updateCallbackStatus('${cb.id}','completed')">✓ Done</button>
        <a href="${calLink}" target="_blank" class="btn-cal-link">📅 Calendar</a>
        <button class="btn btn-sm btn-secondary" onclick="openCallbackModal('${cb.id}')" style="font-size:0.75rem;">Edit</button>
      `;
    } else if (cb.status === 'missed') {
      actions = `
        <button class="btn btn-sm btn-accent" onclick="openCallbackModal('${cb.id}')">Reschedule</button>
        <button class="btn btn-sm btn-secondary" onclick="updateCallbackStatus('${cb.id}','completed')">Mark Done</button>
      `;
    } else {
      actions = `<span class="muted">—</span>`;
    }

    return `<tr>
      <td class="td-name">${esc(cb.authorName)}</td>
      <td class="td-email">${esc(cb.authorEmail)}</td>
      <td>${esc(cb.consultant || '—')}</td>
      <td>${dtStr}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(cb.notes || '')}">${esc(cb.notes || '—')}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>`;
  }).join('');
}

// ── Auto-Refresh & Notifications ─────────────────────────────────────────────
function updateFdLastUpdated() {
  if (!dom.fdLastUpdated) return;
  const parts = [];
  if (state.fdLastFetchTime) {
    const fmt = state.fdLastFetchTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    parts.push(`Server sync: ${fmt}`);
  }
  if (state.fdLastCheckedTime) {
    const fmt2 = state.fdLastCheckedTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    parts.push(`Last checked: ${fmt2}`);
  }
  dom.fdLastUpdated.textContent = parts.join(' · ') || '';
}

function startFdAutoRefresh() {
  stopFdAutoRefresh();
  const usingServerCache = canUseServerCacheAutoRefresh();
  const minutes = usingServerCache ? 1 : (parseInt(dom.fdRefreshInterval.value) || 5);
  const ms = minutes * 60 * 1000;
  state.fdAutoRefreshTimer = setInterval(() => {
    if (!hasFreshdeskAuthAvailable() && !canUseServerCacheAutoRefresh()) {
      stopFdAutoRefresh();
      dom.fdAutoRefresh.checked = false;
      persistFreshdeskPrefs();
      return;
    }
    refreshFreshdeskForAutoTick().then(() => {
      state.fdLastCheckedTime = new Date();
      updateFdLastUpdated();
    }).catch(err => {
      console.warn('Auto-refresh tick failed:', err && err.message ? err.message : err);
    });
  }, ms);
  const source = usingServerCache ? 'server cache' : 'Freshdesk live';
  showFdStatus(`Auto-refresh ON — every ${minutes} min (${source}).`, 'info');
}

function stopFdAutoRefresh() {
  if (state.fdAutoRefreshTimer) {
    clearInterval(state.fdAutoRefreshTimer);
    state.fdAutoRefreshTimer = null;
  }
}

function notifyNewTickets(count) {
  // Browser notification (if permission granted)
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('Bookleaf Tracker', {
      body: `${count} new Freshdesk ticket${count > 1 ? 's' : ''} received!`,
      icon: 'https://shivangi437.github.io/bookleaf-tracker/favicon.ico',
    });
  }
  // Also flash the page title briefly
  const origTitle = document.title;
  document.title = `🔔 ${count} new ticket${count > 1 ? 's' : ''}! — Bookleaf Tracker`;
  setTimeout(() => { document.title = origTitle; }, 8000);
}

// ── Events ───────────────────────────────────────────────────────────────────
if (!IS_BOOKING_MODE) {
dom.csvFile.addEventListener('change', e => handleFile(e.target.files[0]));
dom.btnImport.addEventListener('click', importAndAssign);
dom.btnSample.addEventListener('click', loadSampleData);
dom.btnAutoAssign.addEventListener('click', autoAssign);
dom.btnClear.addEventListener('click', clearAssignments);
dom.btnExport.addEventListener('click', exportCSV);
dom.searchInput.addEventListener('input', renderTable);
dom.filterPackage.addEventListener('change', renderTable);
dom.filterConsultant.addEventListener('change', renderTable);
dom.filterStatus.addEventListener('change', renderTable);
// Razorpay
function checkRpReady() { dom.btnRpFetch.disabled = !(dom.rpKeyId.value.trim() && dom.rpKeySecret.value.trim()); }
dom.rpKeyId.addEventListener('input', checkRpReady);
dom.rpKeySecret.addEventListener('input', checkRpReady);
dom.btnRpFetch.addEventListener('click', fetchRazorpayPayments);
// Set default date range: last 3 months
(function setDefaultDates() {
  const today = new Date();
  const threeMonthsAgo = new Date(today);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  dom.rpDateTo.value = today.toISOString().split('T')[0];
  dom.rpDateFrom.value = threeMonthsAgo.toISOString().split('T')[0];
})();
// Freshdesk
dom.fdApiKey.addEventListener('input', () => { refreshFreshdeskControls(); persistFreshdeskPrefs(); });
dom.btnFdFetch.addEventListener('click', () => {
  fetchFreshdeskTickets({ trigger: 'manual', maxPages: 5 });
  // If auto-refresh checkbox is checked, start auto-refresh after first manual fetch
  if (dom.fdAutoRefresh && dom.fdAutoRefresh.checked && !state.fdAutoRefreshTimer) {
    startFdAutoRefresh();
  }
});
dom.btnFdAutoAssign.addEventListener('click', autoAssignFreshdeskTickets);
if (dom.btnFdServerSyncStatus) {
  dom.btnFdServerSyncStatus.addEventListener('click', () => {
    refreshFreshdeskServerSyncStatus({ adminPassword: state.adminPassword || getStoredAdminPassword() }).catch(err => {
      console.warn('Freshdesk server sync status refresh failed:', err && err.message ? err.message : err);
    });
  });
}
if (dom.fdAutoRefresh) {
  dom.fdAutoRefresh.addEventListener('change', () => {
    persistFreshdeskPrefs();
    if (dom.fdAutoRefresh.checked) {
      if (!hasFreshdeskAuthAvailable() && !canUseServerCacheAutoRefresh()) {
        showFdStatus('Enter API key first (or configure server Freshdesk key), then enable auto-refresh.', 'error');
        dom.fdAutoRefresh.checked = false;
        return;
      }
      // Request notification permission
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      startFdAutoRefresh();
      // Also do an immediate fetch if we haven't fetched yet
      if (!state.fdLastFetchTime) {
        refreshFreshdeskForAutoTick().catch(err => {
          console.warn('Immediate auto-refresh bootstrap failed:', err && err.message ? err.message : err);
        });
      }
    } else {
      stopFdAutoRefresh();
      showFdStatus('Auto-refresh OFF.', 'info');
    }
  });
}
if (dom.fdRefreshInterval) {
  dom.fdRefreshInterval.addEventListener('change', () => {
    persistFreshdeskPrefs();
    if (dom.fdAutoRefresh && dom.fdAutoRefresh.checked) startFdAutoRefresh();
  });
}
dom.ticketSearch.addEventListener('input', renderTickets);
dom.ticketFilterMatch.addEventListener('change', renderTickets);
dom.btnLoadTracker.addEventListener('click', loadTrackerCSV);
if (dom.btnLoadTrackerSheet) dom.btnLoadTrackerSheet.addEventListener('click', loadTrackerSheetUrl);
if (dom.trackerConsultant) dom.trackerConsultant.addEventListener('change', applyConsultantSheetInput);
// Callbacks
if (dom.btnAddCallback) dom.btnAddCallback.addEventListener('click', () => openCallbackModal());
if (dom.btnCbSave) dom.btnCbSave.addEventListener('click', saveCallback);
if (dom.btnCbCancel) dom.btnCbCancel.addEventListener('click', closeCallbackModal);
if (dom.cbAuthorEmail) dom.cbAuthorEmail.addEventListener('input', updateCbAuthorMatch);
if (dom.callbackFilter) dom.callbackFilter.addEventListener('change', renderCallbacks);
if (dom.callbackSearch) dom.callbackSearch.addEventListener('input', renderCallbacks);
dom.identitySelect.addEventListener('change', async e => {
  const view = e.target.value;
  const prevView = state.currentView;
  try {
    if (view === 'admin') {
      const ok = await ensureAdminDataLoaded();
      if (!ok) {
        dom.identitySelect.value = prevView;
        return;
      }
      state.adminUnlocked = true;
      await loadFreshdeskTicketCacheFromServer({ silent: true });
    } else {
      state.adminUnlocked = false;
      if (state.dataScope !== 'consultant' || state.currentView !== view) {
        await loadScopeData(view);
      }
    }
    switchView(view);
  } catch (err) {
    console.error('View switch failed:', err);
    alert(`Failed to switch view: ${err.message}`);
    dom.identitySelect.value = prevView;
  }
});
dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
dom.dropZone.addEventListener('drop', e => { e.preventDefault(); dom.dropZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.name.endsWith('.csv')) handleFile(f); else showStatus('Drop a .csv file.', 'error'); });
}

// ── Startup / Data Bootstrap ────────────────────────────────────────────────
function isValidView(view) {
  return view === 'admin' || CONSULTANTS.some(c => c.name === view);
}

function getRequestedView() {
  const viewParam = new URLSearchParams(window.location.search).get('view');
  return isValidView(viewParam) ? viewParam : 'admin';
}

function showEnvironmentHint() {
  if (!IS_LOCAL) {
    const hint = document.createElement('div');
    hint.className = 'status-msg status-info';
    hint.style.cssText = 'margin:0;border-radius:0 0 6px 6px;font-size:0.82rem;padding:6px 12px;';
    hint.textContent = 'ℹ️ Freshdesk, Razorpay, and author data APIs work on this Vercel deployment via /api proxies. Use python3 server.py only for local development.';
    const fdPanel = document.getElementById('freshdesk-panel');
    if (fdPanel && fdPanel.querySelector('.config-form')) fdPanel.querySelector('.config-form').prepend(hint);
  }
}

function persistFreshdeskPrefs() {
  try {
    const key = (dom.fdApiKey && dom.fdApiKey.value || '').trim();
    if (key) localStorage.setItem('bookleaf_freshdesk_api_key', key);
    else localStorage.removeItem('bookleaf_freshdesk_api_key');
    if (dom.fdAutoRefresh) localStorage.setItem('bookleaf_freshdesk_auto_refresh', dom.fdAutoRefresh.checked ? '1' : '0');
    if (dom.fdRefreshInterval) localStorage.setItem('bookleaf_freshdesk_refresh_interval', String(dom.fdRefreshInterval.value || '5'));
  } catch {}
}

function restoreFreshdeskPrefs() {
  try {
    const savedKey = localStorage.getItem('bookleaf_freshdesk_api_key') || '';
    const savedAuto = localStorage.getItem('bookleaf_freshdesk_auto_refresh');
    const savedInterval = localStorage.getItem('bookleaf_freshdesk_refresh_interval');
    state.fdAutoRefreshPrefSeen = savedAuto !== null;
    if (dom.fdApiKey && savedKey) {
      dom.fdApiKey.value = savedKey;
    }
    if (dom.fdRefreshInterval && savedInterval) {
      const valid = [...dom.fdRefreshInterval.options].some(o => o.value === savedInterval);
      if (valid) dom.fdRefreshInterval.value = savedInterval;
    }
    if (dom.fdAutoRefresh && savedAuto === '1') {
      dom.fdAutoRefresh.checked = true;
    }
    refreshFreshdeskControls();
  } catch {}
}

function maybeResumeFreshdeskAutoConnect() {
  if (state.currentView !== 'admin') return;
  if (!hasFreshdeskAuthAvailable() && !canUseServerCacheAutoRefresh()) return;

  // Auto-enable auto-refresh when server cache is available (regardless of saved pref).
  if (canUseServerCacheAutoRefresh() && dom.fdAutoRefresh && !dom.fdAutoRefresh.checked) {
    dom.fdAutoRefresh.checked = true;
    persistFreshdeskPrefs();
  }

  if (dom.fdAutoRefresh && dom.fdAutoRefresh.checked) {
    startFdAutoRefresh();
    // Always do an immediate fetch on page load to ensure tickets are visible right away.
    refreshFreshdeskForAutoTick().catch(err => {
      console.warn('Initial auto-connect refresh failed:', err && err.message ? err.message : err);
    });
  }
}

function getStoredAdminPassword() {
  try { return sessionStorage.getItem('bookleaf_admin_pwd') || ''; } catch { return ''; }
}

function setStoredAdminPassword(pwd) {
  try {
    if (pwd) sessionStorage.setItem('bookleaf_admin_pwd', pwd);
    else sessionStorage.removeItem('bookleaf_admin_pwd');
  } catch {}
}

async function fetchBootstrapPayload(view, adminPassword) {
  const url = new URL('/api/data', window.location.origin);
  url.searchParams.set('kind', 'bootstrap');
  url.searchParams.set('view', view || 'admin');
  const headers = {};
  if (adminPassword) headers['x-admin-password'] = adminPassword;
  const res = await fetch(url.toString(), { headers });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((body && body.error) || `Data API ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body || {};
}

function applyBootstrapPayload(payload) {
  const trackerData = payload.tracker || payload.trackerData || null;
  const authorsData = payload.authors || payload.authorsData || null;
  if (payload.dbPersistence && typeof payload.dbPersistence === 'object') {
    state.dbPersistence = {
      configured: !!payload.dbPersistence.configured,
      provider: payload.dbPersistence.provider || null,
    };
  } else {
    state.dbPersistence = { configured: false, provider: null };
  }
  if (Array.isArray(payload.callbacks)) {
    state.callbacks = payload.callbacks;
  }
  if (payload.consultantSheetUrls && typeof payload.consultantSheetUrls === 'object') {
    state.consultantSheetUrls = { ...payload.consultantSheetUrls };
  }
  if (payload.reassignCutoff) state.reassignCutoff = payload.reassignCutoff;
  if (payload.trackerCounts && typeof payload.trackerCounts === 'object') {
    state.trackerCounts = payload.trackerCounts;
  } else if (trackerData && typeof trackerData === 'object') {
    const counts = {};
    Object.values(trackerData).forEach(v => {
      if (!v || !v.c) return;
      counts[v.c] = (counts[v.c] || 0) + 1;
    });
    state.trackerCounts = counts;
  } else {
    state.trackerCounts = {};
  }
  loadPreBuiltTrackerData(trackerData);
  loadPreBuiltAuthors(authorsData, { reassignCutoff: payload.reassignCutoff || state.reassignCutoff });
  state.dataScope = payload.scope || (trackerData ? 'admin' : 'consultant');
  applyConsultantSheetInput();
}

async function loadScopeData(view, adminPassword) {
  const payload = await fetchBootstrapPayload(view, adminPassword);
  applyBootstrapPayload(payload);
  return payload;
}

async function ensureAdminDataLoaded() {
  if (state.dataScope === 'admin' && state.authors.length) return true;
  let pwd = state.adminPassword || getStoredAdminPassword();
  for (;;) {
    if (!pwd) {
      pwd = prompt('Enter admin password:');
      if (!pwd) return false;
    }
    try {
      await loadScopeData('admin', pwd);
      state.adminPassword = pwd;
      setStoredAdminPassword(pwd);
      return true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        alert('Incorrect admin password.');
        pwd = '';
        state.adminPassword = '';
        setStoredAdminPassword('');
        continue;
      }
      throw err;
    }
  }
}

async function bootstrapTrackerMode() {
  loadCallbacksFromStorage();
  showEnvironmentHint();
  restoreFreshdeskPrefs();
  await detectFreshdeskProxyConfig();
  if (getRequestedView() === 'admin') {
    refreshFreshdeskServerSyncStatus({ silent: true }).catch(() => {});
  }

  const requestedView = getRequestedView();
  if (requestedView === 'admin') {
    const ok = await ensureAdminDataLoaded();
    if (!ok) {
      // Fallback to the first active consultant without exposing admin dataset.
      const fallback = ACTIVE_CONSULTANTS[0]?.name || CONSULTANTS[0].name;
      dom.identitySelect.value = fallback;
      state.adminUnlocked = false;
      await loadScopeData(fallback);
      switchView(fallback);
      return;
    }
    state.adminUnlocked = true;
    dom.identitySelect.value = 'admin';
    // Auto-load cached Freshdesk tickets on page open (visible status message).
    await loadFreshdeskTicketCacheFromServer({ adminPassword: state.adminPassword, silent: false, refreshUI: true });
    await refreshFreshdeskServerSyncStatus({ adminPassword: state.adminPassword, silent: true });
    switchView('admin');
    maybeResumeFreshdeskAutoConnect();
    return;
  }

  state.adminUnlocked = false;
  dom.identitySelect.value = requestedView;
  await loadScopeData(requestedView);
  switchView(requestedView);
}

async function bootstrapBookingMode() {
  // This local revision no longer bundles the public booking UI. Keep bootstrap split so
  // booking mode can be added back without initializing the internal tracker dashboard.
  document.body.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui;background:#f8fafc;color:#0f172a;">
      <div style="max-width:560px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;box-shadow:0 10px 30px rgba(15,23,42,.06);">
        <h2 style="margin:0 0 8px 0;font-size:1.1rem;">Booking Page Not Available</h2>
        <p style="margin:0;color:#475569;line-height:1.45;">This build is the internal tracker dashboard. Public booking mode should be deployed as a separate entrypoint.</p>
      </div>
    </main>`;
}

(async function bootstrapApp() {
  try {
    if (IS_BOOKING_MODE) {
      await bootstrapBookingMode();
      return;
    }
    await bootstrapTrackerMode();
  } catch (err) {
    console.error('Bootstrap failed:', err);
    showStatus(`Startup error: ${err.message}`, 'error');
  }
})();

function loadPreBuiltAuthors(authorsData, opts = {}) {
  const source = authorsData || (typeof AUTHORS_DATA !== 'undefined' ? AUTHORS_DATA : null);
  if (!source) { state.authors = []; refreshUI(); return; }
  const cutoffRaw = opts.reassignCutoff || state.reassignCutoff || DEFAULT_REASSIGN_CUTOFF;
  const cutoff = parseISODateOnly(cutoffRaw);
  state.reassignCutoff = cutoffRaw;
  let rrIdx = 0;
  let reassigned = 0;
  state.authors = source.map((a, i) => {
    let consultant = a.c;
    let status = normalizeAuthorStatus(a.st);

    // Reassign only newer records if cutoff is configured.
    const dt = parseDateDDMMYYYY(a.dt);
    if (cutoff && dt && dt > cutoff && status === 'assigned') {
      const c = ACTIVE_CONSULTANTS[rrIdx % ACTIVE_CONSULTANTS.length];
      rrIdx++;
      consultant = c.name;
      reassigned++;
    }

    return {
      id: `a-${i}`,
      name: a.n || '', email: a.e || '', phone: a.ph || '',
      package: a.pl || '', packageKey: a.pk || '', paymentDate: a.dt || '',
      consultant, status, remarks: a.rm || '',
      introEmail: !!a.ie, authorResponse: !!a.ar, followUp: !!a.fu, markedYes: !!a.my,
      filesGenerated: !!a.fg, addressMarketing: !!a.am, primePlacement: !!a.pp, confirmationEmail: !!a.ce,
    };
  });
  state.rrIndex = rrIdx;
  if (cutoff) {
    console.log(`Auto-loaded ${state.authors.length} authors (${reassigned} reassigned after ${cutoffRaw})`);
  } else {
    console.log(`Auto-loaded ${state.authors.length} authors`);
  }
  refreshUI();
}
