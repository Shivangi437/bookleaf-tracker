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

// Admin password (change this to your preferred password)
const ADMIN_PASSWORD = 'bookleaf2025';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  authors: [],
  rawCSV: null,
  rrIndex: 0,
  tickets: [],
  fdAgentsLoaded: false,
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

// ── Freshdesk API ────────────────────────────────────────────────────────────
function fdHeaders() {
  const key = dom.fdApiKey.value.trim();
  return { 'Authorization': 'Basic ' + btoa(key + ':X'), 'Content-Type': 'application/json' };
}
function fdUrl(path) { return `/api/fd/${path}`; }

async function loadFreshdeskAgents() {
  const res = await fetch(fdUrl('agents?per_page=100'), { headers: fdHeaders() });
  if (!res.ok) throw new Error(`Freshdesk agents API: ${res.status}`);
  const agents = await res.json();
  CONSULTANTS.forEach(c => {
    if (!c.email) return;
    const match = agents.find(a => a.contact && a.contact.email && a.contact.email.toLowerCase() === c.email.toLowerCase());
    if (match) c.freshdeskAgentId = match.id;
  });
  state.fdAgentsLoaded = true;
  return CONSULTANTS.filter(c => c.freshdeskAgentId).map(c => c.name).join(', ');
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

    // Auto-mark: if Freshdesk ticket is Resolved/Closed → mark author as "good-to-go"
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
  } catch (err) { showFdStatus(`Error: ${err.message}`, 'error'); }
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
function rpUrl(path) { return `/api/rp/${path}`; }

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
        const err = await res.json().catch(() => ({}));
        throw new Error(`Razorpay API: ${res.status} — ${err.detail || err.error || 'Unknown error'}`);
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

  } catch (err) {
    showRpStatus(`Error: ${err.message}`, 'error');
    console.error('Razorpay API error:', err);
  }
}

// ── Auto-load pre-built tracker data ──────────────────────────────────────────
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

// ── Consultant Tracker Import (manual override) ──────────────────────────────
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
}

function extractName(row) {
  try { const p = JSON.parse(row.notes || ''); if (p.name) return p.name.trim(); if (p.registered_name) return p.registered_name.trim(); } catch {}
  try { const p = JSON.parse(row.card || ''); if (p.name && p.name.trim()) return p.name.trim(); } catch {}
  return row.email ? row.email.split('@')[0] : 'Unknown';
}
function parseDate(s) { if (!s) return 0; const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(m[3], m[2]-1, m[1], m[4], m[5], m[6]).getTime() : new Date(s).getTime() || 0; }
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
}

// ── Actions ──────────────────────────────────────────────────────────────────
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

// ── Export ────────────────────────────────────────────────────────────────────
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

  refreshUI();
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
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

      // Action: Reply link on Freshdesk, or "Create Ticket" prompt
      let actionBtn;
      if (latestTicket && hasOpenTicket) {
        const openTicket = authorTickets.find(t => t.statusCode === 2 || t.statusCode === 3);
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/${openTicket.id}" target="_blank" class="btn btn-sm btn-primary">Reply on FD</a>`;
      } else if (latestTicket) {
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/${latestTicket.id}" target="_blank" class="btn btn-sm btn-secondary">View Ticket</a>`;
      } else {
        actionBtn = `<a href="https://${FD_DOMAIN}/a/tickets/new?email=${encodeURIComponent(a.email)}" target="_blank" class="btn btn-sm btn-accent">New Ticket</a>`;
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
          <option value="assigned" ${a.status==='assigned'?'selected':''}>Assigned</option>
          <option value="in-progress" ${a.status==='in-progress'?'selected':''}>In Progress</option>
          <option value="good-to-go" ${a.status==='good-to-go'?'selected':''}>Good to Go</option>
          <option value="completed" ${a.status==='completed'?'selected':''}>Completed</option>
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

    dom.workloadGrid.innerHTML = `
      <div class="summary-card summary-total"><span class="summary-num">${assigned.length}</span><span class="summary-label">Total Authors</span></div>
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
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Events ───────────────────────────────────────────────────────────────────
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
dom.fdApiKey.addEventListener('input', () => { dom.btnFdFetch.disabled = !dom.fdApiKey.value.trim(); });
dom.btnFdFetch.addEventListener('click', fetchFreshdeskTickets);
dom.btnFdAutoAssign.addEventListener('click', autoAssignFreshdeskTickets);
dom.ticketSearch.addEventListener('input', renderTickets);
dom.ticketFilterMatch.addEventListener('change', renderTickets);
dom.btnLoadTracker.addEventListener('click', loadTrackerCSV);
dom.identitySelect.addEventListener('change', e => {
  const view = e.target.value;
  if (view === 'admin') {
    // Require password for admin access
    if (!state.adminUnlocked) {
      const pwd = prompt('Enter admin password:');
      if (pwd !== ADMIN_PASSWORD) {
        alert('Incorrect password.');
        // Reset dropdown to previous value
        dom.identitySelect.value = state.currentView;
        return;
      }
      state.adminUnlocked = true;
    }
  } else {
    // Lock admin when switching to team view
    state.adminUnlocked = false;
  }
  switchView(view);
});
dom.dropZone.addEventListener('dragover', e => { e.preventDefault(); dom.dropZone.classList.add('drag-over'); });
dom.dropZone.addEventListener('dragleave', () => dom.dropZone.classList.remove('drag-over'));
dom.dropZone.addEventListener('drop', e => { e.preventDefault(); dom.dropZone.classList.remove('drag-over'); const f = e.dataTransfer.files[0]; if (f && f.name.endsWith('.csv')) handleFile(f); else showStatus('Drop a .csv file.', 'error'); });

// ── Startup ──────────────────────────────────────────────────────────────────
loadPreBuiltTrackerData();
loadPreBuiltAuthors();

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

function loadPreBuiltAuthors() {
  if (typeof AUTHORS_DATA === 'undefined') return;
  state.authors = AUTHORS_DATA.map((a, i) => ({
    id: `a-${i}`,
    name: a.n, email: a.e, phone: a.ph,
    package: a.pl, packageKey: a.pk, paymentDate: a.dt,
    consultant: a.c, status: a.st, remarks: a.rm || '',
    introEmail: !!a.ie, authorResponse: !!a.ar, followUp: !!a.fu, markedYes: !!a.my,
    filesGenerated: !!a.fg, addressMarketing: !!a.am, primePlacement: !!a.pp, confirmationEmail: !!a.ce,
  }));
  console.log(`Auto-loaded ${state.authors.length} authors`);
  refreshUI();
}
