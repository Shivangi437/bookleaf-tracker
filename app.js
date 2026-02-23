// == Config ============================================================
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

// Detect environment: localhost uses proxy, GitHub Pages calls Freshdesk directly
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

// Admin access (no password required)

// == State ============================================================
const state = {
  authors: [],
  rawCSV: null,
  rrIndex: 0,
  tickets: [],
  fdAgentsLoaded: false,
  existingMap: {},       // email -> { consultant, stages, remarks } from imported tracker CSVs
  loadedTrackers: [],    // which consultant trackers have been loaded
  currentView: 'admin',  // 'admin' or consultant name
  adminUnlocked: true,   // starts as admin; lock when switching away
};

// == DOM refs ============================================================
const $id = (id) => document.getElementById(id);
const dom = {
  csvFile: $id('csv-file'), dropZone: $id('drop-zone'),
  filterIndian: $id('filter-indian'), filterIntl: $id('filter-intl'),
  btnImport: $id('btn-import'), btnSample: $id('btn-load-sample'),
  apiStatus: $id('api-status'),
  // (Razorpay API removed – data import via CSV/webhook only)
  // Freshdesk
  fdApiKey: $id('fd-api-key'), fdDomain: $id('fd-domain'),
  btnFdFetch: $id('btn-fd-fetch'), btnFdAutoAssign: $id('btn-fd-auto-assign'),
  fdStatus: $id('fd-status'),
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
  btnLoadTracker: $id('btn-load-tracker'), trackerStatus: $id('tracker-status'),
  trackerLoaded: $id('tracker-loaded'),
  identitySelect: $id('identity-select'), identityBadge: $id('identity-badge'),
};

// == Freshdesk API ============================================================
function fdHeaders() {
  const key = dom.fdApiKey.value.trim();
  if (IS_LOCAL) {
    return { 'Authorization': 'Basic ' + btoa(key + ':X'), 'Content-Type': 'application/json' };
  }
  // On Vercel, send API key via custom header — the proxy handles Basic auth
  return { 'x-fd-key': key, 'Content-Type': 'application/json' };
}
function fdUrl(path) {
  if (IS_LOCAL) return `/fd-api/${path}`;
  return `/api/freshdesk?path=${encodeURIComponent(path)}`;
}

async function loadFreshdeskAgents() {
  try {
    const res = await fetch(fdUrl('agents?per_page=100'), { headers: fdHeaders() });
    if (!res.ok) {
      console.warn(`Freshdesk agents API: ${res.status} -- skipping agent matching`);
      state.fdAgentsLoaded = true;
      return '(agents API unavailable -- ticket sync will still work)';
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
async function fetchFreshdeskTickets() {
  const key = dom.fdApiKey.value.trim();
  if (!key) { showFdStatus('Enter Freshdesk API key.', 'error'); return; }
  showFdStatus('Connecting to Freshdesk...', 'info');
  try {
    if (!state.fdAgentsLoaded) {
      const mapped = await loadFreshdeskAgents();
      showFdStatus(`Agents: ${mapped}. Fetching tickets...`, 'info');
    }
    let allTickets = [], page = 1, hasMore = true;
    while (hasMore && page <= 5) {
      const res = await fetch(fdUrl(`tickets?per_page=100&page=${page}&include=requester&order_by=created_at&order_type=desc`), { headers: fdHeaders() });
      if (!res.ok) throw new Error(`Tickets API: ${res.status}`);
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

    // Auto-mark: if Freshdesk ticket is Resolved/Closed -> mark author as "good-to-go"
    state.tickets.forEach(t => {
      if (t.isMatched && (t.statusCode === 4 || t.statusCode === 5)) {
        const author = state.authors.find(a => a.email.toLowerCase() === t.requesterEmail);
        if (author && author.status !== 'completed') {
          author.status = 'good-to-go';
        }
      }
      if (t.isMatched && t.matchedConsultant) {
        const c = CONSULTANTS.find(c2 => c2.name === t.matchedConsultant);
        if (c && c.freshdeskAgentId && c.freshdeskAgentId !== t.currentAssignee) t.needsReassign = true;
      }
    });

    const matched = state.tickets.filter(t => t.isMatched).length;
    const needsAssign = state.tickets.filter(t => t.needsReassign).length;
    const autoMarked = state.authors.filter(a => a.status === 'good-to-go').length;
    showFdStatus(`${state.tickets.length} tickets. ${matched} matched, ${needsAssign} need reassign, ${autoMarked} auto-marked "Good to Go".`, 'success');
    dom.btnFdAutoAssign.disabled = needsAssign === 0;
    dom.ticketsSection.classList.remove('hidden');
    refreshUI();
  } catch (err) {
    showFdStatus(`Error: ${err.message}`, 'error');
  }
}

async function autoAssignFreshdeskTickets() {
  const toAssign = state.tickets.filter(t => t.needsReassign);
  if (toAssign.length === 0) { showFdStatus('No tickets need reassignment.', 'info'); return; }
  showFdStatus(`Assigning ${toAssign.length} tickets...`, 'info');
  let success = 0, failed = 0;
  for (const ticket of toAssign) {
    const c = CONSULTANTS.find(c2 => c2.name === ticket.matchedConsultant);
    if (!c || !c.freshdeskAgentId) { failed++; continue; }
    try {
      const res = await fetch(fdUrl(`tickets/${ticket.id}`), { method: 'PUT', headers: fdHeaders(), body: JSON.stringify({ responder_id: c.freshdeskAgentId }) });
      if (res.ok) { ticket.currentAssignee = c.freshdeskAgentId; ticket.needsReassign = false; success++; } else failed++;
      await new Promise(r => setTimeout(r, 200));
    } catch { failed++; }
  }
  showFdStatus(`Done! ${success} assigned${failed > 0 ? `, ${failed} failed` : ''}.`, success > 0 ? 'success' : 'error');
  dom.btnFdAutoAssign.disabled = true;
  refreshUI();
}

async function assignSingleTicket(ticketId) {
  const ticket = state.tickets.find(t => t.id === ticketId);
  if (!ticket || !ticket.matchedConsultant) return;
  const c = CONSULTANTS.find(c2 => c2.name === ticket.matchedConsultant);
  if (!c || !c.freshdeskAgentId) { showFdStatus(`${ticket.matchedConsultant} not linked.`, 'error'); return; }
  try {
    const res = await fetch(fdUrl(`tickets/${ticketId}`), { method: 'PUT', headers: fdHeaders(), body: JSON.stringify({ responder_id: c.freshdeskAgentId }) });
    if (res.ok) { ticket.currentAssignee = c.freshdeskAgentId; ticket.needsReassign = false; showFdStatus(`#${ticketId} -> ${c.name}`, 'success'); refreshUI(); }
    else showFdStatus(`Failed #${ticketId}`, 'error');
  } catch (err) { showFdStatus(`Error: ${err.message}`, 'error'); }
}


// (Razorpay API removed - data import via CSV/webhook only)

// == Auto-load pre-built tracker data ============================================================
function loadPreBuiltTrackerData() {
  if (typeof TRACKER_DATA === 'undefined') return;
  const consultantCounts = {};
  Object.entries(TRACKER_DATA).forEach(([email, d]) => {
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
      status: d.st || 'assigned',
    };
    consultantCounts[d.c] = (consultantCounts[d.c] || 0) + 1;
  });
  state.loadedTrackers = Object.keys(consultantCounts);
  renderTrackerTags();
  console.log(`Pre-loaded ${Object.keys(state.existingMap).length} authors from tracker data:`, consultantCounts);
}

// == Consultant Tracker Import (manual override) ============================================================
function loadTrackerCSV() {
  const file = dom.trackerCsv.files[0];
  const consultant = dom.trackerConsultant.value;
  if (!file) { showTrackerStatus('Select a CSV file.', 'error'); return; }
  showTrackerStatus(`Parsing ${consultant}'s tracker...`, 'info');

  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete(r) {
      let count = 0;
      r.data.forEach(row => {
        // Try to find email column (flexible matching for different sheet formats)
        const email = (row['Email ID'] || row['Email'] || row['email'] || row['Email id'] || row['email id'] || '').toLowerCase().trim();
        if (!email) return;

        const name = (row['Name'] || row['Author'] || row['name'] || '').trim();
        const yesVal = (v) => v && (v.toLowerCase() === 'yes' || v === '✓' || v === '✔' || v === 'done' || v === 'Done' || v === 'TRUE');

        state.existingMap[email] = {
          consultant: consultant,
          name: name || null,
          introEmail: yesVal(row['Intro Email'] || row['Intro email']),
          authorResponse: yesVal(row['Author Response'] || row['Author response']),
          followUp: yesVal(row['Follow-up Mail'] || row['Follow-up'] || row['Follow up Mail']),
          markedYes: yesVal(row['Marked "yes" for 5'] || row['Marked Yes'] || row['Marked yes for 5']),
          filesGenerated: yesVal(row['Files Generated'] || row['Files generated']),
          addressMarketing: yesVal(row['Address and Marketing'] || row['Address & Marketing'] || row['Addr & Mktg']),
          primePlacement: yesVal(row['Prime Placement'] || row['Prime placement']),
          confirmationEmail: yesVal(row['Confirmation Email'] || row['Confirmation email']),
          remarks: row['Remarks'] || row['remarks'] || '',
          status: yesVal(row['Status']) || (row['Status'] || '').toLowerCase().includes('good') ? 'good-to-go' : 'assigned',
        };
        count++;
      });

      if (!state.loadedTrackers.includes(consultant)) state.loadedTrackers.push(consultant);
      showTrackerStatus(`${count} authors loaded for ${consultant}.`, 'success');
      renderTrackerTags();
      dom.trackerCsv.value = ''; // reset file input
    },
    error(e) { showTrackerStatus(`Parse error: ${e.message}`, 'error'); }
  });
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

// == CSV Parsing ============================================================
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
}

function extractName(row) {
  try { const p = JSON.parse(row.notes || ''); if (p.name) return p.name.trim(); if (p.registered_name) return p.registered_name.trim(); } catch {}
  try { const p = JSON.parse(row.card || ''); if (p.name && p.name.trim()) return p.name.trim(); } catch {}
  return row.email ? row.email.split('@')[0] : 'Unknown';
}
function parseDate(s) { if (!s) return 0; const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(m[3], m[2]-1, m[1], m[4], m[5], m[6]).getTime() : new Date(s).getTime() || 0; }
function formatDate(s) { if (!s) return '--'; const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[1]}/${m[2]}/${m[3]}` : s; }

// == Sample Data ============================================================
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
}

// == Actions ============================================================
function autoAssign() {
  state.rrIndex = 0;
  state.authors.forEach(a => { a.consultant = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length].name; a.status = 'assigned'; state.rrIndex++; });
  showStatus('Re-assigned via round-robin.', 'success'); refreshUI();
}
function clearAssignments() {
  state.authors.forEach(a => { a.consultant = ''; a.status = 'assigned'; });
  showStatus('Cleared.', 'info'); refreshUI();
}
function changeStatus(id, val) { const a = state.authors.find(x => x.id === id); if (a) { a.status = val; refreshUI(); } }
function reassign(id, val) { const a = state.authors.find(x => x.id === id); if (a) { a.consultant = val; refreshUI(); } }
function toggleStage(id, stage) {
  const a = state.authors.find(x => x.id === id);
  if (a) { a[stage] = !a[stage]; refreshUI(); }
}

// == Export ============================================================
function updateRemarks(id, val) { const a = state.authors.find(x => x.id === id); if (a) a.remarks = val; }

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

// == Team View ============================================================
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

  // Update booking filter: admin sees only confirmed/completed by default; consultant sees all
  if (callDom.filterStatus) {
    if (isAdmin) {
      callDom.filterStatus.innerHTML = '<option value="all">Confirmed & Completed</option><option value="confirmed">Confirmed</option><option value="completed">Completed</option>';
    } else {
      callDom.filterStatus.innerHTML = '<option value="all">All Statuses</option><option value="pending">No Booking</option><option value="confirmed">Confirmed</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>';
    }
  }

  refreshUI();
}

// == UI Rendering ============================================================
function refreshUI() { updateStats(); renderTable(); renderWorkload(); renderTickets(); toggleButtons(); }

function updateStats() {
  const authors = getViewAuthors();
  const isTeamView = state.currentView !== 'admin';

  dom.statAuthors.textContent = authors.length;
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
    document.querySelector('#stat-tickets').closest('.stat-card').querySelector('.stat-label').textContent = 'Open Tickets';
    document.querySelector('#stat-assigned').closest('.stat-card').querySelector('.stat-label').textContent = 'Need Reply';
    // "Need Reply" = authors with open/pending tickets
    const authorsNeedReply = authors.filter(a => {
      return myTickets.some(t => t.requesterEmail === a.email.toLowerCase() && (t.statusCode === 2 || t.statusCode === 3));
    }).length;
    dom.statAssigned.textContent = authorsNeedReply;
  } else {
    // Admin view: standard stats
    dom.statTickets.textContent = state.tickets.length;
    dom.statAssigned.textContent = authors.filter(a => a.consultant).length;
    document.querySelector('#stat-tickets').closest('.stat-card').querySelector('.stat-label').textContent = 'FD Tickets';
    document.querySelector('#stat-assigned').closest('.stat-card').querySelector('.stat-label').textContent = 'Assigned';
  }
}

function renderTable() {
  const search = dom.searchInput.value.toLowerCase();
  const pkgF = dom.filterPackage.value, conF = dom.filterConsultant.value, staF = dom.filterStatus.value;
  const isTeamView = state.currentView !== 'admin';
  // Update section heading
  const sectionH2 = document.querySelector('#assignments-section h2');
  if (sectionH2) {
    sectionH2.textContent = isTeamView ? `My Authors -- ${state.currentView}` : 'Author Assignments & Workflow';
  }
  let rows = getViewAuthors();
  if (search) rows = rows.filter(a => a.name.toLowerCase().includes(search) || a.email.toLowerCase().includes(search) || (a.consultant && a.consultant.toLowerCase().includes(search)));
  if (pkgF !== 'all') rows = rows.filter(a => a.packageKey === pkgF);
  if (!isTeamView && conF !== 'all') rows = rows.filter(a => a.consultant === conF);
  if (staF !== 'all') rows = rows.filter(a => a.status === staF);

  // Update table header based on view
  const thead = document.querySelector('#assignments-table thead tr');

  if (isTeamView) {
    // -- TEAM VIEW: simplified ticket-reply focused table --
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

      // Action: Reply link on Freshdesk (only show tickets raised by assigned authors, no "New Ticket")
      let actionBtn;
      if (latestTicket && hasOpenTicket) {
        const openTicket = authorTickets.find(t => t.statusCode === 2 || t.statusCode === 3);
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/${openTicket.id}" target="_blank" class="btn btn-sm btn-primary">Reply on FD</a>`;
      } else if (latestTicket) {
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/${latestTicket.id}" target="_blank" class="btn btn-sm btn-secondary">View Ticket</a>`;
      } else {
        actionBtn = '<span class="muted">No tickets</span>';
      }

      // Status badge (read-only in team view)
      const statusBadge = `<span class="badge status-badge-${a.status}">${a.status === 'good-to-go' ? 'Good to Go' : a.status === 'in-progress' ? 'In Progress' : a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span>`;

      return `<tr class="${hasOpenTicket ? 'row-needs-reply' : ''}">
        <td class="td-center muted">${idx + 1}</td>
        <td class="td-name">${esc(a.name)}</td>
        <td class="td-email">${esc(a.email)}</td>
        <td><span class="badge ${pkgC}">${esc(a.package)}</span></td>
        <td>${formatDate(a.paymentDate)}</td>
        <td>${statusBadge}</td>
        <td class="td-tickets">${tBadge}</td>
        <td class="td-center">${actionBtn}</td>
        <td><input type="text" value="${esc(a.remarks||'')}" onchange="updateRemarks('${a.id}',this.value)" class="remarks-input remarks-wide" placeholder="Add note..."></td>
      </tr>`;
    }).join('');

  } else {
    // -- ADMIN VIEW: full workflow table --
    if (thead) {
      thead.innerHTML = '<th>Author</th><th>Email</th><th>Package</th><th>Date</th><th>Consultant</th><th>Intro Email</th><th>Author Resp.</th><th>Follow-up</th><th>Marked Yes</th><th>Status</th><th>Files Gen.</th><th>Addr &amp; Mktg</th><th>Prime Place.</th><th>Confirm Email</th><th>Remarks</th><th>FD</th>';
    }
    if (rows.length === 0) { dom.tbody.innerHTML = '<tr class="empty-row"><td colspan="16">No matching records.</td></tr>'; return; }

    dom.tbody.innerHTML = rows.map(a => {
      const pkgC = a.packageKey === 'indian' ? 'badge-indian' : 'badge-intl';
      const conOpts = CONSULTANTS.map(c => `<option value="${c.name}" ${a.consultant === c.name ? 'selected' : ''}>${c.name}${c.active ? '' : ' (Left)'}</option>`).join('');
      const tix = state.tickets.filter(t => t.requesterEmail === a.email.toLowerCase()).length;
      const tBadge = tix > 0 ? `<span class="badge badge-fd">${tix}</span>` : '<span class="muted">--</span>';

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
          <option value="assigned" ${a.status==='assigned'?'selected':''}>Assigned</option>
          <option value="in-progress" ${a.status==='in-progress'?'selected':''}>In Progress</option>
          <option value="good-to-go" ${a.status==='good-to-go'?'selected':''}>Good to Go</option>
          <option value="completed" ${a.status==='completed'?'selected':''}>Completed</option>
        </select></td>
        <td class="td-center">${ck('filesGenerated')}</td>
        <td class="td-center">${ck('addressMarketing')}</td>
        <td class="td-center">${ck('primePlacement')}</td>
        <td class="td-center">${ck('confirmationEmail')}</td>
        <td><input type="text" value="${esc(a.remarks||'')}" onchange="updateRemarks('${a.id}',this.value)" class="remarks-input" placeholder="--"></td>
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
    // -- TEAM VIEW: summary cards with action-focused stats --
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

    dom.workloadGrid.innerHTML = `
      <div class="summary-card summary-total"><span class="summary-num">${assigned.length}</span><span class="summary-label">Total Authors</span></div>
      <div class="summary-card summary-pending"><span class="summary-num">${pending}</span><span class="summary-label">New / Assigned</span></div>
      <div class="summary-card summary-inprog"><span class="summary-num">${inProg}</span><span class="summary-label">In Progress</span></div>
      <div class="summary-card summary-good"><span class="summary-num">${good}</span><span class="summary-label">Good to Go</span></div>
      <div class="summary-card summary-done"><span class="summary-num">${done}</span><span class="summary-label">Completed</span></div>
      <div class="summary-card summary-tickets"><span class="summary-num">${openTix}</span><span class="summary-label">Open Tickets</span></div>
    `;
  } else {
    // -- ADMIN VIEW: consultant workload cards --
    dom.workloadGrid.innerHTML = visibleConsultants.map(c => {
      const assigned = state.authors.filter(a => a.consultant === c.name);
      const indian = assigned.filter(a => a.packageKey === 'indian').length;
      const intl = assigned.filter(a => a.packageKey === 'intl').length;
      const good = assigned.filter(a => a.status === 'good-to-go').length;
      const done = assigned.filter(a => a.status === 'completed').length;
      const emails = assigned.map(a => a.email.toLowerCase());
      const tix = state.tickets.filter(t => emails.includes(t.requesterEmail)).length;
      const tag = c.active ? (c.freshdeskAgentId ? '<span class="fd-connected">FD ✓</span>' : '<span class="fd-disconnected">FD ✗</span>') : '<span class="resigned-tag">Resigned</span>';

      return `<div class="workload-card ${c.active ? '' : 'wl-resigned'}">
        <div class="wl-header"><h3>${esc(c.name)}</h3>${tag}</div>
        <div class="workload-stats">
          <span class="wl-total">${assigned.length}</span>
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
  if (!state.tickets.length) return;
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
    const act = t.needsReassign ? `<button class="btn btn-sm btn-accent" onclick="assignSingleTicket(${t.id})">-> ${esc(t.matchedConsultant)}</button>` : (t.isMatched ? '<span class="muted">OK</span>' : '<span class="muted">--</span>');
    return `<tr>
      <td><a href="https://${FD_DOMAIN}/a/tickets/${t.id}" target="_blank" class="ticket-link">#${t.id}</a></td>
      <td class="td-subject">${esc(t.subject)}</td>
      <td class="td-email">${esc(t.requesterEmail)}</td>
      <td class="${mc}">${t.matchedAuthor ? esc(t.matchedAuthor) : '<span class="muted">--</span>'}</td>
      <td>${t.matchedConsultant ? esc(t.matchedConsultant) : '<span class="muted">--</span>'}</td>
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
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// == Events ============================================================
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
// Freshdesk -- persist API key in localStorage
dom.fdApiKey.addEventListener('input', () => {
  const key = dom.fdApiKey.value.trim();
  dom.btnFdFetch.disabled = !key;
  if (key) {
    try { localStorage.setItem('bookleaf-fd-key', key); } catch {}
  } else {
    try { localStorage.removeItem('bookleaf-fd-key'); } catch {}
  }
});
dom.btnFdFetch.addEventListener('click', fetchFreshdeskTickets);
dom.btnFdAutoAssign.addEventListener('click', autoAssignFreshdeskTickets);
dom.ticketSearch.addEventListener('input', renderTickets);
dom.ticketFilterMatch.addEventListener('change', renderTickets);
dom.btnLoadTracker.addEventListener('click', loadTrackerCSV);
dom.identitySelect.addEventListener('change', e => {
  const view = e.target.value;
  if (view === 'admin') {
    state.adminUnlocked = true;
  } else {
    state.adminUnlocked = false;
  }
  switchView(view);
});
dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
dom.dropZone.addEventListener('drop', e => { e.preventDefault(); dom.dropZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.name.endsWith('.csv')) handleFile(f); else showStatus('Drop a .csv file.', 'error'); });

// == Startup ============================================================

// Restore saved Freshdesk API key
(function restoreFdKey() {
  try {
    const savedKey = localStorage.getItem('bookleaf-fd-key');
    if (savedKey) {
      dom.fdApiKey.value = savedKey;
      dom.btnFdFetch.disabled = false;
    }
  } catch {}
})();

loadPreBuiltTrackerData();
loadPreBuiltAuthors();

// Freshdesk API works via serverless proxy on Vercel, no hint needed

// URL-based view: ?view=Vandana or ?view=admin
(function applyURLView() {
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get('view');
  if (viewParam) {
    const validViews = ['admin', ...CONSULTANTS.map(c => c.name)];
    if (validViews.includes(viewParam)) {
      if (viewParam !== 'admin') {
        state.adminUnlocked = false;
        dom.identitySelect.value = viewParam;
        switchView(viewParam);
        // Hide identity selector for team members (they only see their view)
        document.querySelector('.identity-selector').style.display = 'none';
      }
    }
  }
})();

function parseDate_DDMMYYYY(str) {
  if (!str) return null;
  // Handle "DD/MM/YYYY" or "DD/MM/YYYY HH:MM:SS"
  const parts = str.split(/[\s]+/)[0].split('/');
  if (parts.length !== 3) return null;
  return new Date(+parts[2], +parts[1] - 1, +parts[0]);
}

const REASSIGN_CUTOFF = new Date(2025, 1, 17); // 17 Feb 2025

function loadPreBuiltAuthors() {
  if (typeof AUTHORS_DATA === 'undefined') return;
  let rrIdx = 0;
  let reassigned = 0;
  state.authors = AUTHORS_DATA.map((a, i) => {
    let consultant = a.c;
    let status = a.st;

    // Round-robin reassign authors with payment date after 17 Feb 2025
    const dt = parseDate_DDMMYYYY(a.dt);
    if (dt && dt > REASSIGN_CUTOFF) {
      const c = ACTIVE_CONSULTANTS[rrIdx % ACTIVE_CONSULTANTS.length];
      rrIdx++;
      consultant = c.name;
      if (!status || status === 'assigned') status = 'assigned';
      reassigned++;
    }

    return {
      id: `a-${i}`,
      name: a.n, email: a.e, phone: a.ph,
      package: a.pl, packageKey: a.pk, paymentDate: a.dt,
      consultant, status, remarks: a.rm || '',
      introEmail: !!a.ie, authorResponse: !!a.ar, followUp: !!a.fu, markedYes: !!a.my,
      filesGenerated: !!a.fg, addressMarketing: !!a.am, primePlacement: !!a.pp, confirmationEmail: !!a.ce,
    };
  });
  state.rrIndex = rrIdx; // Continue round-robin from where we left off
  console.log(`Auto-loaded ${state.authors.length} authors (${reassigned} reassigned after 17-Feb-2025)`);
  refreshUI();
}

// ── Razorpay Webhook ──────────────────────────────────────────────────────
state.webhookLog = [];

const webhookDom = {
  secret: $id('rp-webhook-secret'),
  payload: $id('webhook-payload'),
  btnProcess: $id('btn-webhook-process'),
  btnSimulate: $id('btn-webhook-simulate'),
  btnClear: $id('btn-webhook-clear'),
  status: $id('webhook-status'),
  logBody: $id('webhook-log-body'),
};

function showWebhookStatus(m, t) {
  webhookDom.status.textContent = m;
  webhookDom.status.className = `status-msg status-${t}`;
  webhookDom.status.classList.remove('hidden');
  clearTimeout(showWebhookStatus._t);
  showWebhookStatus._t = setTimeout(() => webhookDom.status.classList.add('hidden'), 8000);
}

function processWebhookPayload() {
  const raw = webhookDom.payload.value.trim();
  if (!raw) { showWebhookStatus('Paste a webhook JSON payload.', 'error'); return; }

  let data;
  try { data = JSON.parse(raw); } catch (e) { showWebhookStatus(`Invalid JSON: ${e.message}`, 'error'); return; }

  const event = data.event;
  if (event !== 'payment.captured') {
    showWebhookStatus(`Ignored event: ${event}. Only payment.captured is processed.`, 'info');
    state.webhookLog.unshift({ time: new Date().toLocaleTimeString(), event, author: '–', email: '–', pkg: '–', amount: '–', status: 'Ignored' });
    renderWebhookLog();
    return;
  }

  const payment = data.payload && data.payload.payment && data.payload.payment.entity;
  if (!payment) { showWebhookStatus('Malformed payload: missing payment entity.', 'error'); return; }

  const email = (payment.email || '').toLowerCase().trim();
  if (!email) { showWebhookStatus('Payment has no email.', 'error'); return; }

  const amountPaise = payment.amount;
  const amountRupees = amountPaise / 100;
  const pkg = PACKAGES[amountRupees];

  if (!pkg) {
    showWebhookStatus(`Unknown package amount: ₹${amountRupees}. Skipped.`, 'info');
    state.webhookLog.unshift({ time: new Date().toLocaleTimeString(), event, author: '–', email, pkg: `₹${amountRupees}`, amount: `₹${amountRupees}`, status: 'Unknown Pkg' });
    renderWebhookLog();
    return;
  }

  // Check duplicate
  const existing = state.authors.find(a => a.email.toLowerCase() === email);
  if (existing) {
    showWebhookStatus(`Duplicate: ${email} already exists (assigned to ${existing.consultant}).`, 'info');
    state.webhookLog.unshift({ time: new Date().toLocaleTimeString(), event, author: existing.name, email, pkg: pkg.label, amount: `₹${amountRupees}`, status: 'Duplicate' });
    renderWebhookLog();
    return;
  }

  // Extract name
  let name = '';
  try {
    if (payment.notes && typeof payment.notes === 'object') {
      name = payment.notes.name || payment.notes.registered_name || '';
    }
  } catch {}
  if (!name && payment.card && payment.card.name) name = payment.card.name;
  if (!name) name = email.split('@')[0];

  // Round-robin assign
  const c = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length];
  state.rrIndex++;

  const newAuthor = {
    id: payment.id || `wh-${Date.now()}`,
    name: name.trim(), email: (payment.email || '').trim(),
    phone: (payment.contact || '').trim(),
    package: pkg.label, packageKey: pkg.key,
    paymentDate: payment.created_at ? new Date(payment.created_at * 1000).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN'),
    consultant: c.name, status: 'assigned', remarks: 'Via webhook',
    introEmail: false, authorResponse: false, followUp: false, markedYes: false,
    filesGenerated: false, addressMarketing: false, primePlacement: false, confirmationEmail: false,
  };

  state.authors.push(newAuthor);
  showWebhookStatus(`Author added: ${newAuthor.name} (${email}) → ${c.name}`, 'success');
  state.webhookLog.unshift({ time: new Date().toLocaleTimeString(), event, author: newAuthor.name, email, pkg: pkg.label, amount: `₹${amountRupees}`, status: 'Added' });
  renderWebhookLog();
  refreshUI();
}

function simulateWebhookEvent() {
  const samplePayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: `pay_sim_${Date.now()}`,
          amount: 1199900,
          currency: 'INR',
          status: 'captured',
          email: `author_${Math.floor(Math.random()*9999)}@example.com`,
          contact: `+9199${Math.floor(10000000 + Math.random()*89999999)}`,
          notes: { name: `Test Author ${Math.floor(Math.random()*999)}` },
          created_at: Math.floor(Date.now()/1000),
        }
      }
    }
  };
  webhookDom.payload.value = JSON.stringify(samplePayload, null, 2);
  webhookDom.btnProcess.disabled = false;
  showWebhookStatus('Sample webhook payload generated. Click "Process" to add the author.', 'info');
}

function renderWebhookLog() {
  if (state.webhookLog.length === 0) {
    webhookDom.logBody.innerHTML = '<tr class="empty-row"><td colspan="7">No webhook events received yet.</td></tr>';
    return;
  }
  webhookDom.logBody.innerHTML = state.webhookLog.map(e => {
    const sc = e.status === 'Added' ? 'webhook-ok' : e.status === 'Duplicate' ? 'webhook-dup' : 'webhook-err';
    return `<tr>
      <td class="muted">${e.time}</td>
      <td>${esc(e.event)}</td>
      <td class="td-name">${esc(e.author)}</td>
      <td class="td-email">${esc(e.email)}</td>
      <td>${esc(e.pkg)}</td>
      <td>${esc(e.amount)}</td>
      <td class="${sc}">${e.status}</td>
    </tr>`;
  }).join('');
}

// Webhook events
webhookDom.payload.addEventListener('input', () => {
  webhookDom.btnProcess.disabled = !webhookDom.payload.value.trim();
});
webhookDom.btnProcess.addEventListener('click', processWebhookPayload);
webhookDom.btnSimulate.addEventListener('click', simulateWebhookEvent);
webhookDom.btnClear.addEventListener('click', () => {
  state.webhookLog = [];
  renderWebhookLog();
  webhookDom.payload.value = '';
  webhookDom.btnProcess.disabled = true;
  showWebhookStatus('Log cleared.', 'info');
});

// Load webhook events received server-side (from Vercel serverless function)
async function loadWebhookEvents() {
  if (IS_LOCAL) return; // No serverless endpoint locally
  try {
    const res = await fetch('/api/razorpay-webhook');
    if (!res.ok) return;
    const events = await res.json();
    if (!Array.isArray(events) || events.length === 0) return;

    let added = 0;
    events.forEach(e => {
      if (!e.processed || !e.email) return;
      const amountRupees = e.amount || 0;
      const pkg = PACKAGES[amountRupees];
      state.webhookLog.push({
        time: e.receivedAt ? new Date(e.receivedAt).toLocaleTimeString() : '–',
        event: e.event || 'payment.captured',
        author: e.name || '–',
        email: e.email || '–',
        pkg: pkg ? pkg.label : `₹${amountRupees}`,
        amount: `₹${amountRupees}`,
        status: 'Server',
      });

      const email = (e.email || '').toLowerCase().trim();
      if (!email) return;
      const existing = state.authors.find(a => a.email.toLowerCase() === email);
      if (existing) return;
      if (!pkg) return;

      const c = ACTIVE_CONSULTANTS[state.rrIndex % ACTIVE_CONSULTANTS.length];
      state.rrIndex++;

      state.authors.push({
        id: e.paymentId || `wh-${Date.now()}-${added}`,
        name: (e.name || email.split('@')[0]).trim(),
        email: email,
        phone: (e.phone || '').trim(),
        package: pkg.label, packageKey: pkg.key,
        paymentDate: e.createdAt ? new Date(e.createdAt * 1000).toLocaleDateString('en-IN') : new Date(e.receivedAt).toLocaleDateString('en-IN'),
        consultant: c.name, status: 'assigned', remarks: 'Via webhook (server)',
        introEmail: false, authorResponse: false, followUp: false, markedYes: false,
        filesGenerated: false, addressMarketing: false, primePlacement: false, confirmationEmail: false,
      });
      added++;
    });

    if (added > 0 || state.webhookLog.length > 0) {
      renderWebhookLog();
      if (added > 0) refreshUI();
      console.log(`Loaded ${events.length} server webhook events, ${added} new authors added.`);
    }
  } catch (err) {
    console.warn('Could not load webhook events:', err.message);
  }
}

// Auto-load webhook events on page load
loadWebhookEvents();

// ══ Booking System (Calendly-style, single booking per author) ══════════════

// 1. State initialization + localStorage load
state.bookings = [];
(function loadBookingsFromStorage() {
  try {
    const saved = localStorage.getItem('bookleaf-bookings');
    if (saved) state.bookings = JSON.parse(saved);
  } catch (e) {
    console.warn('Failed to load bookings from localStorage:', e);
    state.bookings = [];
  }
})();

function saveBookings() {
  try {
    localStorage.setItem('bookleaf-bookings', JSON.stringify(state.bookings));
  } catch (e) {
    console.warn('Failed to save bookings:', e);
  }
}

// 2. Booking DOM refs
const callDom = {
  overviewStats: $id('call-overview-stats'),
  search:        $id('call-search'),
  filterStatus:  $id('call-filter-status'),
  filterCon:     $id('call-filter-consultant'),
  btnExport:     $id('btn-call-export'),
  trackerBody:   $id('call-tracker-body'),
};

// 3. Token generation + link generation
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function generateBookingToken(authorEmail, consultant) {
  return djb2Hash(authorEmail + '|' + consultant + '|' + ADMIN_PASSWORD);
}

function generateBookingLink(authorEmail, consultant) {
  const token = generateBookingToken(authorEmail, consultant);
  const base = window.location.origin + window.location.pathname;
  const params = new URLSearchParams({
    book: 'true',
    author: authorEmail,
    consultant: consultant,
    token: token,
  });
  return base + '?' + params.toString();
}

function copyBookingLink(authorEmail, consultant) {
  const link = generateBookingLink(authorEmail, consultant);
  navigator.clipboard.writeText(link).then(() => {
    showBookingToast('Booking link copied!');
  }).catch(() => {
    const tmp = document.createElement('input');
    tmp.value = link;
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand('copy');
    document.body.removeChild(tmp);
    showBookingToast('Booking link copied!');
  });
}

function showBookingToast(msg) {
  let toast = document.getElementById('booking-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'booking-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#065f46;color:#fff;padding:12px 24px;border-radius:8px;font-size:0.9rem;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.2);transition:opacity 0.3s;';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(showBookingToast._t);
  showBookingToast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// 4. Booking CRUD
function createBooking(data) {
  const booking = {
    id: 'bk-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
    authorName: data.authorName || '',
    authorEmail: (data.authorEmail || '').toLowerCase().trim(),
    authorPhone: data.authorPhone || '',
    consultant: data.consultant || '',
    date: data.date || '',
    timeSlot: data.timeSlot || '',
    notes: data.notes || '',
    status: data.status || 'confirmed',
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  state.bookings.push(booking);
  saveBookings();
  return booking;
}

function updateBookingStatus(bookingId, newStatus) {
  const booking = state.bookings.find(b => b.id === bookingId);
  if (!booking) return null;
  booking.status = newStatus;
  if (newStatus === 'completed') booking.completedAt = new Date().toISOString();
  saveBookings();
  refreshUI();
  return booking;
}

function getBookingForAuthor(authorEmail) {
  const email = (authorEmail || '').toLowerCase().trim();
  const matches = state.bookings
    .filter(b => b.authorEmail === email && b.status !== 'cancelled')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return matches[0] || null;
}

// 5. renderCallOverview() - simple stats
function renderCallOverview() {
  if (!callDom.overviewStats) return;
  const isAdmin = state.currentView === 'admin';
  const authors = getViewAuthors();
  const total = authors.length;
  const booked = authors.filter(a => {
    return state.bookings.some(b =>
      b.authorEmail === a.email.toLowerCase().trim() && b.status !== 'cancelled'
    );
  }).length;
  const completed = authors.filter(a => {
    return state.bookings.some(b =>
      b.authorEmail === a.email.toLowerCase().trim() && b.status === 'completed'
    );
  }).length;
  const pending = total - booked;

  // Update section title and description based on view
  const titleEl = document.getElementById('booking-section-title');
  const descEl = document.getElementById('booking-section-desc');
  if (isAdmin) {
    if (titleEl) titleEl.textContent = 'Booking Tracker';
    if (descEl) descEl.textContent = 'Overview of all confirmed author bookings.';
  } else {
    if (titleEl) titleEl.textContent = 'My Author Bookings';
    if (descEl) descEl.textContent = 'Generate a booking link for each author. Authors pick a slot (10 AM -- 6 PM, Mon--Sat) and confirm.';
  }

  // Hide consultant filter in team view
  if (callDom.filterCon) callDom.filterCon.style.display = isAdmin ? '' : 'none';

  const statCard = (val, label, color) => `<div style="flex:1;min-width:140px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;text-align:center;">
    <div style="font-size:1.8rem;font-weight:700;color:${color};">${val}</div>
    <div style="font-size:0.8rem;color:#6b7280;">${label}</div>
  </div>`;

  callDom.overviewStats.innerHTML = `<div style="display:flex;gap:16px;flex-wrap:wrap;">
    ${statCard(total, 'Total Authors', '#6366f1')}
    ${statCard(pending, 'No Booking', '#9ca3af')}
    ${statCard(booked - completed, 'Scheduled', '#f59e0b')}
    ${statCard(completed, 'Completed', '#10b981')}
  </div>`;
}

// 6. renderCallTracker() - role-based: admin=read-only, consultant=copy link + actions
function renderCallTracker() {
  if (!callDom.trackerBody) return;
  const isAdmin = state.currentView === 'admin';

  const search = (callDom.search ? callDom.search.value : '').toLowerCase();
  const statusF = callDom.filterStatus ? callDom.filterStatus.value : 'all';
  const conF = callDom.filterCon ? callDom.filterCon.value : 'all';

  let authors = getViewAuthors();

  if (search) {
    authors = authors.filter(a =>
      a.name.toLowerCase().includes(search) ||
      a.email.toLowerCase().includes(search) ||
      (a.consultant && a.consultant.toLowerCase().includes(search))
    );
  }
  if (conF !== 'all') {
    authors = authors.filter(a => a.consultant === conF);
  }

  // Admin view: default to showing only booked authors (confirmed/completed)
  // Consultant view: show all their authors
  if (isAdmin && statusF === 'all') {
    authors = authors.filter(a => {
      const b = getBookingForAuthor(a.email);
      return b && (b.status === 'confirmed' || b.status === 'completed');
    });
  } else if (statusF !== 'all') {
    if (statusF === 'pending') {
      authors = authors.filter(a => !getBookingForAuthor(a.email));
    } else {
      authors = authors.filter(a => {
        const b = getBookingForAuthor(a.email);
        return b && b.status === statusF;
      });
    }
  }

  // Update table header based on view
  const thead = document.getElementById('call-tracker-head');
  if (isAdmin) {
    // Admin: read-only view — Author | Email | Consultant | Date & Time | Status
    if (thead) thead.innerHTML = '<th>Author</th><th>Email</th><th>Consultant</th><th>Date &amp; Time</th><th>Status</th>';
    const cols = 5;
    if (authors.length === 0) {
      callDom.trackerBody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No confirmed bookings yet.</td></tr>`;
      return;
    }
    callDom.trackerBody.innerHTML = authors.map(a => {
      const booking = getBookingForAuthor(a.email);
      const dateCell = formatBookingDate(booking);
      const statusCell = formatBookingStatus(booking);
      return `<tr>
        <td class="td-name">${esc(a.name)}</td>
        <td class="td-email">${esc(a.email)}</td>
        <td>${esc(a.consultant || '')}</td>
        ${dateCell}${statusCell}
      </tr>`;
    }).join('');
  } else {
    // Consultant: full control — Author | Email | Booking | Date & Time | Status | Actions
    if (thead) thead.innerHTML = '<th>Author</th><th>Email</th><th>Booking</th><th>Date &amp; Time</th><th>Status</th><th>Actions</th>';
    const cols = 6;
    if (authors.length === 0) {
      callDom.trackerBody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No authors assigned to you.</td></tr>`;
      return;
    }
    callDom.trackerBody.innerHTML = authors.map(a => {
      const booking = getBookingForAuthor(a.email);

      // Booking column: Copy Link or "Booked"
      let bookingCell;
      if (!booking) {
        bookingCell = `<td class="td-center">
          <button class="btn btn-sm btn-secondary" onclick="copyBookingLink('${esc(a.email)}','${esc(a.consultant)}')" title="Copy booking link for this author">
            Copy Link
          </button>
        </td>`;
      } else {
        bookingCell = `<td class="td-center"><span style="color:#6366f1;font-weight:500;">Booked</span></td>`;
      }

      const dateCell = formatBookingDate(booking);
      const statusCell = formatBookingStatus(booking);

      // Actions: Done/Cancel for confirmed bookings
      let actionsCell;
      if (!booking) {
        actionsCell = `<td class="td-center muted">&ndash;</td>`;
      } else if (booking.status === 'confirmed') {
        actionsCell = `<td class="td-center">
          <button class="btn btn-sm" style="background:#10b981;color:#fff;font-size:0.72rem;padding:3px 8px;" onclick="updateBookingStatus('${booking.id}','completed')">Done</button>
          <button class="btn btn-sm" style="background:#ef4444;color:#fff;font-size:0.72rem;padding:3px 8px;" onclick="updateBookingStatus('${booking.id}','cancelled')">Cancel</button>
        </td>`;
      } else if (booking.status === 'completed') {
        actionsCell = `<td class="td-center"><span style="color:#10b981;">&#10003;</span></td>`;
      } else {
        actionsCell = `<td class="td-center muted">&ndash;</td>`;
      }

      return `<tr>
        <td class="td-name">${esc(a.name)}</td>
        <td class="td-email">${esc(a.email)}</td>
        ${bookingCell}${dateCell}${statusCell}${actionsCell}
      </tr>`;
    }).join('');
  }
}

// Helper: format booking date cell
function formatBookingDate(booking) {
  if (booking && booking.date) {
    const dObj = new Date(booking.date + 'T12:00:00');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `<td class="td-center">${dayNames[dObj.getDay()]}, ${dObj.getDate()} ${monthNames[dObj.getMonth()]}<br><span style="font-size:0.8rem;color:#6b7280;">${esc(booking.timeSlot || '')}</span></td>`;
  }
  return `<td class="td-center muted">&ndash;</td>`;
}

// Helper: format booking status badge
function formatBookingStatus(booking) {
  if (!booking) {
    return `<td class="td-center"><span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:0.78rem;font-weight:500;background:#f3f4f6;color:#6b7280;">No Booking</span></td>`;
  }
  let bg, color;
  switch (booking.status) {
    case 'confirmed': bg = '#fef3c7'; color = '#92400e'; break;
    case 'completed': bg = '#d1fae5'; color = '#065f46'; break;
    case 'cancelled': bg = '#fee2e2'; color = '#991b1b'; break;
    default: bg = '#e0e7ff'; color = '#3730a3';
  }
  const label = booking.status.charAt(0).toUpperCase() + booking.status.slice(1);
  return `<td class="td-center"><span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:0.78rem;font-weight:500;background:${bg};color:${color};">${label}</span></td>`;
}

// 7. exportCallData()
function exportCallData() {
  const headers = ['Author', 'Email', 'Phone', 'Consultant', 'Date', 'Time Slot', 'Status', 'Notes', 'Created At', 'Completed At'];
  const rows = [headers];

  state.bookings.forEach(b => {
    rows.push([
      b.authorName, b.authorEmail, b.authorPhone, b.consultant,
      b.date, b.timeSlot, b.status, b.notes, b.createdAt, b.completedAt || '',
    ]);
  });

  // Add authors without bookings
  const bookedEmails = new Set(state.bookings.map(b => b.authorEmail));
  getViewAuthors().forEach(a => {
    if (!bookedEmails.has(a.email.toLowerCase().trim())) {
      rows.push([a.name, a.email, a.phone, a.consultant, '', '', 'pending', '', '', '']);
    }
  });

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `bookings_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// 8. initAuthorBookingView() - Calendly-like author form
function initAuthorBookingView(params) {
  const authorEmail = (params.get('author') || '').toLowerCase().trim();
  const consultant = params.get('consultant') || '';
  const token = params.get('token') || '';

  // Validate token
  const expectedToken = generateBookingToken(authorEmail, consultant);
  if (token !== expectedToken) {
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;">
      <div style="text-align:center;padding:40px;max-width:480px;">
        <div style="font-size:3rem;margin-bottom:16px;">&#9888;</div>
        <h2 style="color:#991b1b;margin-bottom:8px;">Invalid Booking Link</h2>
        <p style="color:#6b7280;">This booking link is invalid or has expired. Please contact your consultant for a new link.</p>
      </div>
    </div>`;
    return;
  }

  const author = state.authors.find(a => a.email.toLowerCase().trim() === authorEmail);
  const authorName = author ? author.name : authorEmail.split('@')[0];
  const consultantObj = CONSULTANTS.find(c => c.name === consultant);
  const consultantFullName = consultantObj ? consultantObj.fullName : consultant;

  // Check if already booked
  const existingBooking = getBookingForAuthor(authorEmail);

  // Hide admin UI
  document.querySelectorAll('header, footer, main > *:not(#author-callback-view)').forEach(el => {
    el.style.display = 'none';
  });

  const acbView = $id('author-callback-view');
  if (acbView) {
    acbView.classList.remove('hidden');
    acbView.style.display = '';
  }

  const acbSubtitle = $id('acb-subtitle');
  const acbGreeting = $id('acb-greeting');
  const acbDesc = $id('acb-description');
  if (acbSubtitle) acbSubtitle.textContent = 'Bookleaf Publishing';
  if (acbGreeting) acbGreeting.textContent = `Hello ${authorName}!`;
  if (acbDesc) acbDesc.textContent = `${consultantFullName} has invited you to book a call. Please pick a date and time that works best for you (10 AM \u2013 6 PM).`;

  if (existingBooking && existingBooking.status === 'confirmed') {
    showBookingThankYou(existingBooking, consultantObj);
    return;
  }

  const formDiv = $id('acb-form');
  if (!formDiv) return;

  // Generate next 7 weekdays (skip Sundays)
  const dates = [];
  const today = new Date();
  let cursor = new Date(today);
  cursor.setDate(cursor.getDate() + 1);
  while (dates.length < 7) {
    if (cursor.getDay() !== 0) dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // Time slots: 10:00 AM to 6:00 PM in 30-min intervals
  const timeSlots = [];
  for (let h = 10; h < 18; h++) {
    for (let m = 0; m < 60; m += 30) {
      const hour12 = h > 12 ? h - 12 : h;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const label = `${hour12}:${m === 0 ? '00' : m} ${ampm}`;
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      timeSlots.push({ label, value });
    }
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  formDiv.innerHTML = `
    <div style="max-width:560px;margin:0 auto;">
      <div style="margin-bottom:20px;">
        <label style="display:block;font-weight:600;margin-bottom:6px;color:#374151;">Your Name</label>
        <input type="text" id="bk-name" value="${esc(authorName)}" readonly
          style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;font-size:0.95rem;color:#6b7280;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:20px;">
        <label style="display:block;font-weight:600;margin-bottom:6px;color:#374151;">Email</label>
        <input type="email" id="bk-email" value="${esc(authorEmail)}" readonly
          style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;font-size:0.95rem;color:#6b7280;box-sizing:border-box;">
      </div>
      <div style="margin-bottom:20px;">
        <label style="display:block;font-weight:600;margin-bottom:6px;color:#374151;">Phone</label>
        <input type="tel" id="bk-phone" value="${esc(author ? author.phone : '')}" placeholder="Your phone number"
          style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:8px;">
        <label style="display:block;font-weight:600;margin-bottom:6px;color:#374151;">Select a Date</label>
      </div>
      <div id="bk-date-grid" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;">
        ${dates.map((d, i) => {
          const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          return `<button type="button" class="bk-date-btn" data-date="${dateStr}" data-index="${i}"
            style="flex:1;min-width:70px;padding:12px 8px;border:2px solid #e5e7eb;border-radius:10px;background:#fff;cursor:pointer;text-align:center;transition:all 0.15s;"
            onmouseover="this.style.borderColor='#818cf8'" onmouseout="if(!this.classList.contains('bk-selected'))this.style.borderColor='#e5e7eb'">
            <div style="font-size:0.78rem;color:#6b7280;font-weight:500;">${dayNames[d.getDay()]}</div>
            <div style="font-size:1.3rem;font-weight:700;color:#1f2937;">${d.getDate()}</div>
            <div style="font-size:0.72rem;color:#9ca3af;">${monthNames[d.getMonth()]}</div>
          </button>`;
        }).join('')}
      </div>

      <div id="bk-time-section" style="display:none;margin-bottom:24px;">
        <label style="display:block;font-weight:600;margin-bottom:8px;color:#374151;">Select a Time</label>
        <div id="bk-time-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
          ${timeSlots.map(t => {
            return `<button type="button" class="bk-time-btn" data-time="${t.value}" data-label="${t.label}"
              style="padding:10px 4px;border:2px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer;font-size:0.85rem;color:#374151;font-weight:500;transition:all 0.15s;"
              onmouseover="this.style.borderColor='#818cf8'" onmouseout="if(!this.classList.contains('bk-selected'))this.style.borderColor='#e5e7eb'">
              ${t.label}
            </button>`;
          }).join('')}
        </div>
      </div>

      <div style="margin-bottom:24px;">
        <label style="display:block;font-weight:600;margin-bottom:6px;color:#374151;">Notes (optional)</label>
        <textarea id="bk-notes" rows="3" placeholder="Any specific topics you'd like to discuss..."
          style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;resize:vertical;font-family:inherit;box-sizing:border-box;"></textarea>
      </div>

      <div id="bk-selection-summary" style="display:none;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin-bottom:20px;">
        <span style="font-weight:600;color:#166534;">Selected:</span>
        <span id="bk-summary-text" style="color:#166534;"></span>
      </div>

      <button type="button" id="bk-submit-btn" disabled
        style="width:100%;padding:14px;background:#6366f1;color:#fff;border:none;border-radius:10px;font-size:1rem;font-weight:600;cursor:pointer;opacity:0.5;transition:all 0.2s;"
        onmouseover="if(!this.disabled)this.style.background='#4f46e5'" onmouseout="this.style.background='#6366f1'">
        Confirm Booking
      </button>
    </div>
  `;

  let selectedDate = null;
  let selectedTime = null;
  let selectedTimeLabel = null;

  function updateSubmitState() {
    const btn = $id('bk-submit-btn');
    const summary = $id('bk-selection-summary');
    const summaryText = $id('bk-summary-text');
    if (selectedDate && selectedTime) {
      btn.disabled = false;
      btn.style.opacity = '1';
      summary.style.display = '';
      const dObj = new Date(selectedDate + 'T12:00:00');
      summaryText.textContent = `${dayNames[dObj.getDay()]}, ${dObj.getDate()} ${monthNames[dObj.getMonth()]} ${dObj.getFullYear()} at ${selectedTimeLabel}`;
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.5';
      summary.style.display = 'none';
    }
  }

  $id('bk-date-grid').addEventListener('click', function(e) {
    const btn = e.target.closest('.bk-date-btn');
    if (!btn) return;
    this.querySelectorAll('.bk-date-btn').forEach(b => {
      b.classList.remove('bk-selected');
      b.style.borderColor = '#e5e7eb';
      b.style.background = '#fff';
    });
    btn.classList.add('bk-selected');
    btn.style.borderColor = '#6366f1';
    btn.style.background = '#eef2ff';
    selectedDate = btn.dataset.date;
    $id('bk-time-section').style.display = '';
    selectedTime = null;
    selectedTimeLabel = null;
    $id('bk-time-grid').querySelectorAll('.bk-time-btn').forEach(b => {
      b.classList.remove('bk-selected');
      b.style.borderColor = '#e5e7eb';
      b.style.background = '#fff';
      b.style.color = '#374151';
    });
    updateSubmitState();
  });

  $id('bk-time-grid').addEventListener('click', function(e) {
    const btn = e.target.closest('.bk-time-btn');
    if (!btn) return;
    this.querySelectorAll('.bk-time-btn').forEach(b => {
      b.classList.remove('bk-selected');
      b.style.borderColor = '#e5e7eb';
      b.style.background = '#fff';
      b.style.color = '#374151';
    });
    btn.classList.add('bk-selected');
    btn.style.borderColor = '#6366f1';
    btn.style.background = '#6366f1';
    btn.style.color = '#fff';
    selectedTime = btn.dataset.time;
    selectedTimeLabel = btn.dataset.label;
    updateSubmitState();
  });

  $id('bk-submit-btn').addEventListener('click', function() {
    if (!selectedDate || !selectedTime) return;
    const phone = ($id('bk-phone') ? $id('bk-phone').value : '').trim();
    const notes = ($id('bk-notes') ? $id('bk-notes').value : '').trim();
    const booking = createBooking({
      authorName: authorName,
      authorEmail: authorEmail,
      authorPhone: phone,
      consultant: consultant,
      date: selectedDate,
      timeSlot: selectedTimeLabel,
      notes: notes,
      status: 'confirmed',
    });
    if (author && phone) author.phone = phone;
    showBookingThankYou(booking, consultantObj);
  });
}

function showBookingThankYou(booking, consultantObj) {
  const formDiv = $id('acb-form');
  const thankYou = $id('acb-thankyou');
  const responseSummary = $id('acb-response-summary');

  if (formDiv) formDiv.style.display = 'none';
  if (thankYou) {
    thankYou.classList.remove('hidden');
    thankYou.style.display = '';
  }

  const dObj = booking.date ? new Date(booking.date + 'T12:00:00') : null;
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dateFormatted = dObj
    ? `${dayNames[dObj.getDay()]}, ${dObj.getDate()} ${monthNames[dObj.getMonth()]} ${dObj.getFullYear()}`
    : 'N/A';

  const consultantEmail = consultantObj ? consultantObj.email : '';
  const mailSubject = encodeURIComponent(`Booking Confirmation - ${booking.authorName}`);
  const mailBody = encodeURIComponent(`Hi ${consultantObj ? consultantObj.fullName : booking.consultant},\n\nI have booked a call for ${dateFormatted} at ${booking.timeSlot}.\n\nPlease confirm.\n\nThank you,\n${booking.authorName}`);
  const mailtoLink = consultantEmail ? `mailto:${consultantEmail}?subject=${mailSubject}&body=${mailBody}` : '';

  if (responseSummary) {
    responseSummary.innerHTML = `
      <div style="max-width:480px;margin:0 auto;text-align:center;">
        <div style="font-size:3rem;margin-bottom:12px;">&#9989;</div>
        <h2 style="color:#065f46;margin-bottom:8px;">Booking Confirmed!</h2>
        <p style="color:#6b7280;margin-bottom:24px;">Your call has been scheduled.</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;text-align:left;margin-bottom:24px;">
          <div style="margin-bottom:12px;"><strong style="color:#374151;">Date:</strong> <span style="color:#065f46;">${esc(dateFormatted)}</span></div>
          <div style="margin-bottom:12px;"><strong style="color:#374151;">Time:</strong> <span style="color:#065f46;">${esc(booking.timeSlot || 'N/A')}</span></div>
          <div style="margin-bottom:12px;"><strong style="color:#374151;">Consultant:</strong> <span style="color:#065f46;">${esc(consultantObj ? consultantObj.fullName : booking.consultant)}</span></div>
          ${booking.notes ? `<div><strong style="color:#374151;">Notes:</strong> <span style="color:#6b7280;">${esc(booking.notes)}</span></div>` : ''}
        </div>
        ${mailtoLink ? `<a href="${mailtoLink}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:0.95rem;">
          Send Confirmation Email
        </a>` : ''}
        <p style="color:#9ca3af;font-size:0.82rem;margin-top:16px;">You can close this page. Your consultant will reach out to confirm.</p>
      </div>
    `;
  }
}

// 9. Event listeners
(function attachCallTrackerListeners() {
  if (callDom.search) callDom.search.addEventListener('input', renderCallTracker);
  if (callDom.filterStatus) callDom.filterStatus.addEventListener('change', renderCallTracker);
  if (callDom.filterCon) callDom.filterCon.addEventListener('change', renderCallTracker);
  if (callDom.btnExport) callDom.btnExport.addEventListener('click', exportCallData);
})();

// 10. URL detection for ?book=true
(function checkBookingMode() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('book') === 'true') {
    initAuthorBookingView(params);
  }
})();

// 11. refreshUI override
const _origRefreshUI = refreshUI;
refreshUI = function() {
  _origRefreshUI();
  renderCallOverview();
  renderCallTracker();
};

// 12. Initial render
renderCallOverview();
renderCallTracker();
