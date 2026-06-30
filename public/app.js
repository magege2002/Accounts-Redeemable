// ── STATE ──────────────────────────────────────────────────────────────────
let matters = [];
let stagingEntries = [];
let panelBImages = [];   // { file, url } objects
let _baseline     = null;  // parsed Clio CSV rows — restored from localStorage on load
let _baselineMeta = null;  // { filename, count } — stored alongside _baseline
let _sortField    = 'date'; // staging table sort column
let _sortDir      = 'asc';  // 'asc' | 'desc'
let _frozenSortOrder  = null; // Array<id> — permanent visual order; set after every sort, only cleared by setSort()
// (No _cloneDisplayTimer — frozen sort order is permanent until user clicks a column header)
let _sidebarId         = null;  // entry id currently shown in conflict sidebar
let _clioIgnoreIds     = new Set(); // entry ids the user has marked "different" from baseline
let _baselineMap       = new Map(); // entry id → matched baseline object (rebuilt by getClioMatchIds)
let _callNotesIds      = new Set(); // entry ids with advisory Call+Notes badge (rebuilt by getClioMatchIds)
let _lastClickId        = null;  // entry id of the most recent row click (double-click detection)
let _lastClickTs        = 0;     // timestamp of that click
let _lastClickSidebarId = null;  // what _sidebarId was when that click fired
let _deletedTray        = [];    // soft-deleted entries awaiting permanent delete
let _trayCounter        = 0;     // monotonic id for tray items
let _trayExpanded       = false; // Recently Deleted section expand state
const TRAY_MAX          = 20;    // max recoverable entries kept
const UNDO_MS           = 10000; // undo window in ms
let _descResizeTimerId  = null;  // debounce timer for textarea auto-resize
let _tooltipTarget      = null;  // td element currently triggering the description tooltip
let _tooltipAutoTimer   = null;  // auto-dismiss timer (4s max display duration)
let _validationFlags   = new Map(); // entry id → [{ type, ...meta }] advisory flags
let _vfDismissed       = new Set(); // "entryId:type" keys for user-dismissed flags
const _confRiskDowngradedThisSession = new Set(); // entry IDs already downgraded this session (prevents repeat toasts)
let _focusFlagType     = null;      // flag type that opened the sidebar (null = generic row click)
let _vfPreview         = null;      // { id, type, field, value } — pending AI suggestion
let _approveUndoTimers = new Map(); // toastId → { timerId, entryId, prevStatus }
let _followIndicatorTimer = null;   // setTimeout id for follow-entry indicator
let _sortScheduleTimer  = null;   // 800ms delayed re-sort for explicit status-change actions
const _editingLocks       = new Set(); // entry IDs in editing lock mode (clones being actively edited)
let _editingLockPromptId  = null;   // entry ID whose row currently shows the "Finish editing?" inline prompt
let _suppressLockClickAway = false; // bypasses click-away check when re-opening sidebar via Keep editing
let _sidebarOrigin    = null;       // 'review' when sidebar was opened via Edit in Capture; null otherwise
let _pinnedAfter      = new Map();  // cloneId → originalId — keeps clones below their source until explicit re-sort
let _entryHistory     = new Map();  // entryId → [{field, oldVal, newVal, ts}] — last 5 field changes per entry
let _relatedExpanded  = new Set();  // entry ids for which the proximity-match list is expanded
let _refineSnapshot   = null;       // [{id, description, category, matter, client, rate, status}] — pre-refine copy
let _refineUndoTimer  = null;       // setTimeout id — clears snapshot after 60 s
let _refineUndoToastId = null;      // DOM id of the active refine-undo toast
let _deleteConfirmTimer = null;     // setTimeout id — auto-cancels sidebar delete confirmation after 3 s
const _approveInProgress = new Set(); // entry ids with an in-flight approve/unapprove call — guards against double-click
let _searchQuery     = '';          // current text in the search box (shared, both tabs)
let _searchMode      = 'dropdown'; // 'dropdown' (Mode 1 — floating results, table unchanged) | 'isolation' (Mode 2 — table filtered)
let _isolationScroll = 0;          // .staging-wrap scrollTop saved just before entering isolation mode
let _sdOutsideHandler = null;      // document mousedown handler for closing search dropdown on outside click
const _callDurSugDismissed = new Set(); // "entryId:source" keys — dismissed call-note duration suggestions

const ACTIVITY_CATEGORIES = [
  'Phone call', 'Text exchange', 'Document review',
  'Research', 'Court filing', 'Administrative',
  'Notes — Timed', 'Notes — Estimated',
];

// ── HELPERS ────────────────────────────────────────────────────────────────
function getMatter(num) { return matters.find(m => m.num === num); }

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function wordOverlap(a, b) {
  const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wa = words(a), wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

// Extract { matter, surname } pairs from active matters for CONF_RISK checking
function _getClientSurnames() {
  return matters
    .filter(m => m.active)
    .map(m => {
      const base    = m.client.replace(/\(.*\)/g, '').trim();
      const surname = base.split(/\s+/).pop() || '';
      return { matter: m.num, surname, client: m.client };
    })
    .filter(x => x.surname.length >= 3);
}

// Auto-scrub: for each foreign-matter surname found in description, call the AI scrub
// endpoint sequentially and return the cleaned description. Skips if no foreign surnames
// are detected (avoids unnecessary round-trips). Used when cloning an entry.
async function _autoScrubDescription(description, matter) {
  if (!description || !matter) return description;
  const clientSurnames = _getClientSurnames();
  let scrubbed = description;
  for (const { matter: clientMatter, surname } of clientSurnames) {
    if (clientMatter === matter) continue; // own matter — keep
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!rx.test(scrubbed)) continue; // surname not present — skip API call
    try {
      const result = await api('POST', '/api/ai/scrub-description', { description: scrubbed, surname });
      if (result && result.scrubbed) scrubbed = result.scrubbed;
      console.log('[autoScrub] removed', JSON.stringify(surname), '→', JSON.stringify(scrubbed));
    } catch (err) {
      console.warn('[autoScrub] scrub failed for surname', JSON.stringify(surname), err.message);
    }
  }
  return scrubbed;
}

// ── API ────────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── INIT ───────────────────────────────────────────────────────────────────
async function init() {
  initTooltip();

  // Delete undo toast container — bottom-center
  const toastArea = document.createElement('div');
  toastArea.id = 'deleteToastArea';
  document.body.appendChild(toastArea);

  // Approve undo toast container — bottom-left
  const approveArea = document.createElement('div');
  approveArea.id = 'approveToastArea';
  document.body.appendChild(approveArea);

  // Follow-entry indicator — bottom-right
  const followEl = document.createElement('div');
  followEl.id = 'followEntryIndicator';
  followEl.innerHTML = `<span class="follow-label" style="opacity:0.7;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Entry moved</span>
    <button class="btn btn-sm btn-ghost" id="followEntryBtn"
      style="font-size:11px;padding:2px 8px">Follow ↓</button>`;
  document.body.appendChild(followEl);

  // Restore baseline from previous session (if any)
  try {
    const storedEntries = localStorage.getItem('ar_baseline_entries');
    const storedMeta    = localStorage.getItem('ar_baseline_meta');
    if (storedEntries && storedMeta) {
      const parsed = JSON.parse(storedEntries);
      const meta   = JSON.parse(storedMeta);
      if (Array.isArray(parsed) && parsed.length > 0) {
        _baseline     = parsed;
        _baselineMeta = meta;
        console.log('[baseline] restored', _baseline.length, 'entries from localStorage — file:', meta.filename);
      }
    }
  } catch (restoreErr) {
    console.warn('[baseline] localStorage restore failed:', restoreErr);
    localStorage.removeItem('ar_baseline_entries');
    localStorage.removeItem('ar_baseline_meta');
  }

  // Restore dismissed "Mark as Different" IDs so they survive page refreshes
  try {
    const dismissed = localStorage.getItem('ar_baseline_dismissed');
    if (dismissed) {
      const arr = JSON.parse(dismissed);
      if (Array.isArray(arr)) arr.forEach(id => _clioIgnoreIds.add(id));
      console.log('[baseline] restored', _clioIgnoreIds.size, 'dismissed IDs from localStorage');
    }
  } catch (dismissErr) {
    console.warn('[baseline] dismissed IDs restore failed:', dismissErr);
    localStorage.removeItem('ar_baseline_dismissed');
  }

  // Escape key priority: desc popup → QA dropdown → search dropdown (Mode 1) → isolation mode (Mode 2) → sidebar close
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    // The desc popup's textarea handles Escape with stopPropagation, so this handler
    // should never see it while the popup is open — but guard here too for safety.
    if (document.getElementById('descPopup')) return;
    const qaOpen = document.getElementById('qaDropdown')?.style.display !== 'none'
                || document.getElementById('qeDropdown')?.style.display !== 'none';
    if (qaOpen) { _closeQADropdown(); return; }
    // Close Mode 1 dropdown if visible (either tab)
    const dd  = document.getElementById('captureSearchDropdown');
    const rdd = document.getElementById('reviewSearchDropdown');
    if ((dd && dd.style.display !== 'none') || (rdd && rdd.style.display !== 'none')) {
      _closeSearchDropdown(); return;
    }
    // Exit isolation mode (Mode 2) if active — restores scroll position
    if (_searchMode === 'isolation') { _exitIsolation(true); return; }
    if (_searchQuery.length > 0) { _clearSearch(); return; }
    if (_sidebarId !== null) closeConflictSidebar();
  });

  [matters, stagingEntries] = await Promise.all([
    api('GET', '/api/matters'),
    api('GET', '/api/entries'),
  ]);
  populateMatterDropdowns();
  _loadDismissedConfriskFlags(); // restore CONF_RISK dismissals before first render/validation pass
  renderStagingTable();
  _updateBaselineUI(); // re-apply after DOM is fully ready (handles restored baseline)
  document.getElementById('qa-date').value = todayStr();
  document.getElementById('qe-date').value = todayStr();
  _initStickySearch();
}

// ── NAV ────────────────────────────────────────────────────────────────────
function switchSection(sec) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('sec-' + sec).classList.add('active');
  document.querySelector(`[data-section="${sec}"]`).classList.add('active');
  // Clear fixed state — the IntersectionObserver will re-evaluate once the new
  // section is visible and re-apply .search-fixed if the header is out of view.
  document.getElementById('captureSearchBar')?.classList.remove('search-fixed');
  document.getElementById('reviewSearchBar')?.classList.remove('search-fixed');
  // Keep search bar in sync with shared _searchQuery when switching tabs
  _updateSearchUI();
  if (sec === 'review') {
    renderReview();
    // If the sidebar is open, carry the context into the Review tab —
    // scroll to that entry's row and pulse it so the user lands on the right entry.
    if (_sidebarId !== null) {
      requestAnimationFrame(() => _scrollReviewToEntry(_sidebarId));
    }
  }
  if (sec === 'export')  generatePreview();
  if (sec === 'audit')   { /* state preserved */ }
  if (sec === 'archive') renderArchive();
}

// ── SEARCH ─────────────────────────────────────────────────────────────────

// Use IntersectionObserver to detect when each tab's section header has scrolled
// above the nav bar, then toggle .search-fixed (position:fixed;top:56px) so the
// search bar stays accessible at any scroll depth.
// Reads the staging/review table wrapper's bounding rect and applies left + width
// to any currently-fixed search bar so it stays pixel-aligned with the table columns.
// Called on IntersectionObserver transitions, window resize, and sidebar open/close.
function _alignFixedSearchBar() {
  // Only the Capture search bar can be independently fixed (the Review one lives
  // inside the sticky reviewControlBar and never needs dynamic positioning).
  const captureBar = document.getElementById('captureSearchBar');
  if (captureBar && captureBar.classList.contains('search-fixed')) {
    const wrap = document.querySelector('.staging-wrap');
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      captureBar.style.left  = rect.left + 'px';
      captureBar.style.width = rect.width + 'px';
    }
  }
}

function _initStickySearch() {
  // Measure control bar height to know where the search bar should sit when fixed.
  // The nav is 56px; the capture control bar sits below it (also sticky).
  const ctrlBar  = document.getElementById('captureControlBar');
  const ctrlBarH = ctrlBar ? ctrlBar.offsetHeight : 40;
  const navH     = 56;
  const captureSearchTop = navH + ctrlBarH; // px from viewport top when fixed

  // rootMargin accounts for the nav + control bar so the observer fires when the
  // staging-table header disappears behind the combined bar, not the raw viewport top.
  const captureOpts = {
    threshold: 0,
    rootMargin: `-${captureSearchTop}px 0px 0px 0px`,
  };

  const captureHeader = document.getElementById('stagingTableHeader');
  const captureBar    = document.getElementById('captureSearchBar');
  if (captureHeader && captureBar) {
    new IntersectionObserver(entries => {
      if (!document.getElementById('sec-capture')?.classList.contains('active')) return;
      const isFixed = !entries[0].isIntersecting;
      captureBar.classList.toggle('search-fixed', isFixed);
      // Set top dynamically — re-measure in case control bar height changed
      if (isFixed) {
        const cb = document.getElementById('captureControlBar');
        captureBar.style.top = (navH + (cb ? cb.offsetHeight : ctrlBarH)) + 'px';
        _alignFixedSearchBar(); // snap left/width to staging-wrap bounds
      } else {
        captureBar.style.top   = '';
        captureBar.style.left  = '';
        captureBar.style.width = '';
      }
    }, captureOpts).observe(captureHeader);
  }

  // Review: the search bar lives inside .review-ctrl-bar which is CSS sticky —
  // no IntersectionObserver needed; it always scrolls with its container.

  // Re-align on window resize (viewport width change shifts the table wrapper bounds)
  window.addEventListener('resize', _alignFixedSearchBar);
}

// ── QUICK ADD DROPDOWN (sticky bar) ────────────────────────────────────────

function _openQADropdown(type) {
  const isActivity = type === 'activity';
  const dropId = isActivity ? 'qaDropdown' : 'qeDropdown';
  const btnId  = isActivity ? 'openQABtn'  : 'openQEBtn';

  // If same dropdown already open, close it (toggle)
  const drop = document.getElementById(dropId);
  if (drop && drop.style.display !== 'none') { _closeQADropdown(); return; }

  _closeQADropdown(); // close any other open dropdown first

  const btn = document.getElementById(btnId);
  if (!drop || !btn) return;

  // Populate matter select with current active matters
  const activeMats = matters.filter(m => m.active);
  const opts = '<option value="">-- Select --</option>' + activeMats.map(m =>
    `<option value="${m.num}">${m.num} — ${m.client}</option>`
  ).join('');
  const mSel = drop.querySelector('select');
  if (mSel) mSel.innerHTML = opts;

  // Preset today's date
  const dateInput = drop.querySelector('input[type="date"]');
  if (dateInput && !dateInput.value) dateInput.value = todayStr();

  // Show and position below the button
  drop.style.display = 'block';
  const btnRect = btn.getBoundingClientRect();
  let left = btnRect.right - 310; // align right edge to button right
  if (left < 8) left = 8;
  if (left + 310 > window.innerWidth - 8) left = window.innerWidth - 318;
  drop.style.top  = (btnRect.bottom + 5) + 'px';
  drop.style.left = left + 'px';

  // Focus description input
  setTimeout(() => {
    const descInput = drop.querySelector('input[type="text"]');
    if (descInput) descInput.focus();
  }, 40);

  // Click-outside handler
  drop._outsideClick = ev => {
    if (!drop.contains(ev.target) && ev.target !== btn) _closeQADropdown();
  };
  setTimeout(() => document.addEventListener('mousedown', drop._outsideClick, true), 0);
}

function _closeQADropdown() {
  ['qaDropdown', 'qeDropdown'].forEach(id => {
    const d = document.getElementById(id);
    if (!d || d.style.display === 'none') return;
    d.style.display = 'none';
    if (d._outsideClick) {
      document.removeEventListener('mousedown', d._outsideClick, true);
      d._outsideClick = null;
    }
  });
}

function _qadFillMatter() {
  // No extra auto-fill needed in minimal dropdown — matter num is enough for submission
}

async function _qaDropdownSubmit(type) {
  if (type === 'activity') {
    const matterVal = document.getElementById('qad-matter')?.value || '';
    const desc      = document.getElementById('qad-desc')?.value.trim() || '';
    if (!desc) { document.getElementById('qad-desc')?.focus(); return; }
    const m = getMatter(matterVal);
    const entry = {
      matter:      m ? m.num : '',
      client:      m ? m.client : '',
      date:        document.getElementById('qad-date')?.value || todayStr(),
      duration:    parseFloat(document.getElementById('qad-dur')?.value) || 0.1,
      description: desc,
      category:    inferCategory(desc),
      type:        'Time',
      rate:        m ? m.rate : 0,
      status:      m ? 'Ready' : 'Needs Review',
      source:      'quick_add',
    };
    const saved = await api('POST', '/api/entries', entry);
    stagingEntries.push(saved);
    renderStagingTable();
    // Reset desc and dur but keep matter/date for convenience
    if (document.getElementById('qad-desc'))  document.getElementById('qad-desc').value  = '';
    if (document.getElementById('qad-dur'))   document.getElementById('qad-dur').value   = '0.1';
    _closeQADropdown();
    _showSimpleToast('Activity entry added.');
  } else {
    const matterVal = document.getElementById('qed-matter')?.value || '';
    const desc      = document.getElementById('qed-desc')?.value.trim() || '';
    const amount    = parseFloat(document.getElementById('qed-amount')?.value) || 0;
    if (!desc)   { document.getElementById('qed-desc')?.focus(); return; }
    if (!amount) { document.getElementById('qed-amount')?.focus(); return; }
    const m = getMatter(matterVal);
    const entry = {
      matter:      m ? m.num : '',
      client:      m ? m.client : '',
      date:        document.getElementById('qed-date')?.value || todayStr(),
      duration:    1.0,
      description: desc,
      category:    'Administrative',
      type:        'Expense',
      rate:        amount,
      status:      m ? 'Ready' : 'Needs Review',
      source:      'panel_d',
    };
    const saved = await api('POST', '/api/entries', entry);
    stagingEntries.push(saved);
    renderStagingTable();
    if (document.getElementById('qed-desc'))   document.getElementById('qed-desc').value   = '';
    if (document.getElementById('qed-amount')) document.getElementById('qed-amount').value = '';
    _closeQADropdown();
    _showSimpleToast('Expense entry added.');
  }
}

function _onSearchInput(value) {
  _searchQuery = value;
  const isCapture = document.getElementById('sec-capture')?.classList.contains('active');
  const isReview  = document.getElementById('sec-review')?.classList.contains('active');

  if (!value) {
    _closeSearchDropdown();
    if (_searchMode === 'isolation') {
      _exitIsolation(true);  // clear isolation + restore scroll
    } else {
      _updateSearchUI();
    }
    return;
  }

  if (_searchMode === 'isolation') {
    // Mode 2: table already filtered — update filter in real-time as user edits query
    if (isCapture) renderStagingTable();
    if (isReview)  renderReview();
    _updateSearchUI();
  } else {
    // Mode 1: show floating dropdown of matching entries; do NOT filter the table
    if (isCapture) _renderSearchDropdown(value, 'capture');
    if (isReview)  _renderSearchDropdown(value, 'review');
    _updateSearchUI();
  }
}

function _clearSearch() {
  if (_searchMode === 'isolation') {
    // Exit isolation — clears query, restores scroll, fires amber pulse
    _exitIsolation(true);
    return;
  }
  _searchQuery = '';
  const captureInput = document.getElementById('captureSearchInput');
  const reviewInput  = document.getElementById('reviewSearchInput');
  if (captureInput) captureInput.value = '';
  if (reviewInput)  reviewInput.value  = '';
  _closeSearchDropdown();
  _updateSearchUI();
}

// Sync both search bars to current _searchQuery and update ancillary UI.
// Pass filteredCount + totalCount to update the hint text (null = no hint).
function _updateSearchUI(filteredCount, totalCount) {
  const has        = _searchQuery.length > 0;
  const isIsolated = _searchMode === 'isolation';

  // Sync input values across both bars
  const captureInput = document.getElementById('captureSearchInput');
  const reviewInput  = document.getElementById('reviewSearchInput');
  if (captureInput && captureInput.value !== _searchQuery) captureInput.value = _searchQuery;
  if (reviewInput  && reviewInput.value  !== _searchQuery) reviewInput.value  = _searchQuery;

  // Clear button visibility
  const captureClear = document.getElementById('captureSearchClear');
  const reviewClear  = document.getElementById('reviewSearchClear');
  if (captureClear) captureClear.classList.toggle('visible', has);
  if (reviewClear)  reviewClear.classList.toggle('visible', has);

  // Isolation-mode visual indicator on the search bar border
  document.getElementById('captureSearchBar')?.classList.toggle('isolation-mode', isIsolated && has);
  document.getElementById('reviewSearchBar')?.classList.toggle('isolation-mode',  isIsolated && has);

  // Results hint (only meaningful in isolation mode with filter active)
  const captureHint = document.getElementById('captureSearchHint');
  const reviewHint  = document.getElementById('reviewSearchHint');
  const hintText = (isIsolated && has && filteredCount != null)
    ? `Showing ${filteredCount} of ${totalCount}`
    : isIsolated && has
      ? 'Filtering…'
      : '';
  if (captureHint) captureHint.textContent = hintText;
  if (reviewHint)  reviewHint.textContent  = hintText;
}

// ── SEARCH MODE 1 — FLOATING DROPDOWN ─────────────────────────────────────

// Handle Enter key on search inputs: Enter in Mode 1 → enter isolation (Mode 2).
function _onSearchKeydown(ev) {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  if (_searchQuery.trim()) _enterIsolation();
}

// ── DATE SEARCH NORMALIZER ───────────────────────────────────────────────────
// Strips all non-numeric characters so any separator (/, -, space) is ignored.
// Stored dates are ISO "YYYY-MM-DD" → normalized to "YYYYMMDD".
// Query examples: "5/14" → "514", "05-14" → "0514", "2026/05/14" → "20260514".
//
// Also handles US month-day-year order:
//   "05/14/2026" → digits "05142026" → try reading as MMDDYYYY → rearrange to "20260514".
//
// Returns true if the entry date contains the normalized query.
// Returns false immediately when the query has no digits (e.g. "lewis") so other fields
// can still match without the date field producing false positives.
function _matchesDate(entryDate, queryStr) {
  const qn = (queryStr || '').replace(/\D/g, '');
  if (!qn) return false;
  const norm = (entryDate || '').replace(/\D/g, '');
  if (norm.includes(qn)) return true;
  // Also try US MDY 8-digit form (MMDDYYYY → YYYYMMDD)
  if (qn.length === 8) {
    const asISO = qn.slice(4) + qn.slice(0, 4);   // "05142026" → "20260514"
    if (norm.includes(asISO)) return true;
  }
  return false;
}

// Show a floating dropdown listing up to 8 matching entries.
// tab: 'capture' | 'review' — determines which dropdown element to populate and
// which click handler to attach ('_searchDropdownSelect' vs '_reviewDropdownSelect').
function _renderSearchDropdown(query, tab) {
  const isReviewTab = tab === 'review';
  const dropId  = isReviewTab ? 'reviewSearchDropdown' : 'captureSearchDropdown';
  const dropdown = document.getElementById(dropId);
  if (!dropdown) return;
  if (!query) { _closeSearchDropdown(); return; }

  const q = query.toLowerCase().trim();
  if (!q) { _closeSearchDropdown(); return; }

  const matches = stagingEntries.filter(e =>
    (e.matter      || '').toLowerCase().includes(q) ||
    (e.client      || '').toLowerCase().includes(q) ||
    (e.description || '').toLowerCase().includes(q) ||
    _matchesDate(e.date, q)                          ||
    (e.category    || '').toLowerCase().includes(q)
  ).slice(0, 8);

  const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clickFn = isReviewTab ? '_reviewDropdownSelect' : '_searchDropdownSelect';

  if (!matches.length) {
    dropdown.innerHTML = `<div class="sd-empty">No matches for "${esc(q)}"</div>`;
    dropdown.style.display = 'block';
  } else {
    dropdown.innerHTML = matches.map(e => {
      const sc      = e.status === 'Approved' ? 'badge-approved' : e.status === 'Needs Review' ? 'badge-review' : 'badge-ready';
      const desc    = esc((e.description || '').slice(0, 70));
      const ellip   = (e.description || '').length > 70 ? '…' : '';
      const dur     = parseFloat(e.duration) || 0;
      const bill    = dur * (parseFloat(e.rate) || 0);
      const durStr  = e.type === 'Expense' ? `${Math.round(dur) || 1} qty` : `${dur.toFixed(1)} hr`;
      const billStr = '$' + bill.toFixed(2);
      const client  = e.client ? ' · ' + esc(e.client) : '';
      return `<div class="sd-item" onclick="${clickFn}(${e.id})">
        <div class="sd-meta">${esc(e.matter || '—')}${client} &nbsp;<span class="badge ${sc}" style="font-size:9px;padding:1px 5px">${esc(e.status)}</span></div>
        <div class="sd-desc">${desc}${ellip}</div>
        <div class="sd-meta">${esc(e.date || '—')} · ${durStr} · ${billStr}</div>
      </div>`;
    }).join('') + `<div class="sd-footer">
      <span class="sd-count">${matches.length} match${matches.length !== 1 ? 'es' : ''}</span>
      <button class="sd-filter-btn" onclick="event.stopPropagation(); _enterIsolation()">Filter ↵</button>
    </div>`;
    dropdown.style.display = 'block';
  }

  // Attach a capture-phase mousedown listener to close when clicking outside either search bar
  if (!_sdOutsideHandler) {
    _sdOutsideHandler = (ev) => {
      const cb = document.getElementById('captureSearchBar');
      const rb = document.getElementById('reviewSearchBar');
      if ((!cb || !cb.contains(ev.target)) && (!rb || !rb.contains(ev.target))) {
        _closeSearchDropdown();
      }
    };
    document.addEventListener('mousedown', _sdOutsideHandler, true);
  }
}

function _closeSearchDropdown() {
  const cdd = document.getElementById('captureSearchDropdown');
  const rdd = document.getElementById('reviewSearchDropdown');
  if (cdd) cdd.style.display = 'none';
  if (rdd) rdd.style.display = 'none';
  if (_sdOutsideHandler) {
    document.removeEventListener('mousedown', _sdOutsideHandler, true);
    _sdOutsideHandler = null;
  }
}

// Navigate to a Capture staging-table entry when clicked in the Capture dropdown.
function _searchDropdownSelect(entryId) {
  _closeSearchDropdown();
  _searchQuery = '';
  const ci = document.getElementById('captureSearchInput');
  if (ci) ci.value = '';
  _updateSearchUI();
  if (!document.getElementById('sec-capture')?.classList.contains('active')) {
    switchSection('capture');
  }
  requestAnimationFrame(() => {
    const row = document.querySelector(`#stagingBody tr[data-id="${entryId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('pulse-blue');
    void row.offsetWidth;
    row.classList.add('pulse-blue');
    setTimeout(() => row.classList.remove('pulse-blue'), 2000);
  });
}

// Navigate to a Review-groups entry when clicked in the Review dropdown.
function _reviewDropdownSelect(entryId) {
  _closeSearchDropdown();
  _searchQuery = '';
  const ri = document.getElementById('reviewSearchInput');
  if (ri) ri.value = '';
  _updateSearchUI();
  // Stay in Review tab — scroll to that entry's row and pulse it.
  requestAnimationFrame(() => {
    const row = document.querySelector(`#reviewGroups tr[data-id="${entryId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    _pulseRowSalmon(row);
  });
}

// ── SEARCH MODE 2 — ISOLATION (table filter) ───────────────────────────────

// Save scroll position and switch to isolation mode (table is now filtered).
function _enterIsolation() {
  if (!_searchQuery.trim()) return;
  const isReview = document.getElementById('sec-review')?.classList.contains('active');
  if (isReview) {
    // Review groups scroll with the window (not inside a fixed-height container)
    _isolationScroll = window.scrollY;
  } else {
    const wrap = document.querySelector('.staging-wrap');
    _isolationScroll = wrap ? wrap.scrollTop : 0;
  }
  _searchMode = 'isolation';
  _closeSearchDropdown();
  const isCapture = document.getElementById('sec-capture')?.classList.contains('active');
  if (isCapture) renderStagingTable();
  if (isReview)  renderReview();
  _updateSearchUI();
}

// Exit isolation mode: clear query, restore scroll, pulse first row to orient the user.
function _exitIsolation(restoreScroll) {
  const wasCapture = document.getElementById('sec-capture')?.classList.contains('active');
  const wasReview  = document.getElementById('sec-review')?.classList.contains('active');
  const savedScroll = _isolationScroll;
  _searchMode      = 'dropdown';
  _isolationScroll = 0;
  _searchQuery     = '';
  const ci = document.getElementById('captureSearchInput');
  const ri = document.getElementById('reviewSearchInput');
  if (ci) ci.value = '';
  if (ri) ri.value = '';
  _closeSearchDropdown();
  const isCapture = document.getElementById('sec-capture')?.classList.contains('active');
  const isReview  = document.getElementById('sec-review')?.classList.contains('active');
  if (isCapture) renderStagingTable();
  if (isReview)  renderReview();
  _updateSearchUI();

  if (restoreScroll) {
    requestAnimationFrame(() => {
      if (wasCapture) {
        // Restore the staging-wrap scroll inside its fixed-height container
        const wrap = document.querySelector('.staging-wrap');
        if (wrap) {
          wrap.scrollTop = savedScroll;
          requestAnimationFrame(() => {
            const firstRow = document.querySelector('#stagingBody tr[data-id]');
            if (firstRow) {
              firstRow.classList.remove('pulse-amber');
              void firstRow.offsetWidth;
              firstRow.classList.add('pulse-amber');
              setTimeout(() => firstRow.classList.remove('pulse-amber'), 1500);
            }
          });
        }
      } else if (wasReview) {
        // Restore the page scroll position for the Review groups view
        window.scrollTo({ top: savedScroll, behavior: 'instant' });
      }
    });
  }
}

// ── SETTINGS ───────────────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settingsModal').classList.add('open');
  renderMatterTable();
}
function closeSettings() {
  document.getElementById('settingsModal').classList.remove('open');
  populateMatterDropdowns();
  renderStagingTable();
}

function renderMatterTable() {
  const tbody = document.getElementById('matterBody');
  tbody.innerHTML = matters.map(m => `
    <tr>
      <td>${m.num}</td>
      <td>${m.client}</td>
      <td>$${m.rate}</td>
      <td><span class="badge ${m.active ? 'badge-ready' : 'badge-review'}">${m.active ? 'Active' : 'Closed'}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="toggleMatter(${m.id})">${m.active ? 'Close' : 'Reopen'}</button>
        <button class="del-btn" onclick="deleteMatter(${m.id})">×</button>
      </td>
    </tr>
  `).join('');
}

async function addMatter() {
  const num    = document.getElementById('new-matter-num').value.trim();
  const client = document.getElementById('new-matter-client').value.trim();
  const rate   = parseFloat(document.getElementById('new-matter-rate').value) || 0;
  if (!num || !client) return;
  try {
    const m = await api('POST', '/api/matters', { num, client, rate });
    matters.push(m);
    document.getElementById('new-matter-num').value    = '';
    document.getElementById('new-matter-client').value = '';
    document.getElementById('new-matter-rate').value   = '';
    renderMatterTable();
  } catch (e) {
    alert(e.message);
  }
}

async function toggleMatter(id) {
  const m = matters.find(x => x.id === id);
  if (!m) return;
  const updated = await api('PUT', `/api/matters/${id}`, { active: !m.active });
  Object.assign(m, updated);
  renderMatterTable();
}

async function deleteMatter(id) {
  if (!confirm('Delete this matter?')) return;
  await api('DELETE', `/api/matters/${id}`);
  matters = matters.filter(m => m.id !== id);
  renderMatterTable();
}

// ── MATTER DROPDOWNS ───────────────────────────────────────────────────────
function populateMatterDropdowns() {
  const activeMats = matters.filter(m => m.active);
  const opts = '<option value="">-- Select --</option>' + activeMats.map(m =>
    `<option value="${m.num}">${m.num} — ${m.client}</option>`
  ).join('');
  // Existing panel selects
  const qaEl = document.getElementById('qa-matter');
  if (qaEl) qaEl.innerHTML = opts;
  const qeEl = document.getElementById('qe-matter');
  if (qeEl) qeEl.innerHTML = opts;
  // Sticky-bar dropdown selects
  const qadEl = document.getElementById('qad-matter');
  if (qadEl) qadEl.innerHTML = opts;
  const qedEl = document.getElementById('qed-matter');
  if (qedEl) qedEl.innerHTML = opts;
}

function qaFillMatter() {
  const m = getMatter(document.getElementById('qa-matter').value);
  document.getElementById('qa-client').value = m ? m.client : '';
  document.getElementById('qa-rate').value   = m ? m.rate   : '';
}

function qeFilMatter() {
  const m = getMatter(document.getElementById('qe-matter').value);
  document.getElementById('qe-client').value = m ? m.client : '';
}

// ── DOCX ATTACH (shared helper) ────────────────────────────────────────────
async function attachDocx(targetTextAreaId, statusId) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.onchange = async () => {
      if (!input.files.length) return resolve(null);
      const file = input.files[0];
      const statusEl = document.getElementById(statusId);
      if (statusEl) statusEl.innerHTML = '<span class="spin">⟳</span> Extracting docx...';
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch('/api/ai/extract-docx', { method: 'POST', body: fd });
        const data = await res.json();
        if (data.text) {
          const ta = document.getElementById(targetTextAreaId);
          if (ta) ta.value = data.text;
          if (statusEl) statusEl.innerHTML = `✓ Extracted from ${file.name}`;
        }
        resolve(data.text || null);
      } catch (e) {
        if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">Docx extraction failed</span>`;
        resolve(null);
      }
    };
    input.click();
  });
}

// ── PANEL A — MANUAL / DOCX ────────────────────────────────────────────────
async function parseEntries() {
  const text = document.getElementById('rawNotes').value.trim();
  if (!text) return;
  const status = document.getElementById('parse-status');
  status.innerHTML = '<span class="spin">⟳</span> Parsing with AI...';
  try {
    const { entries } = await api('POST', '/api/ai/parse-text', { text });
    const saved = await api('POST', '/api/entries/batch', entries);
    stagingEntries.push(...saved);
    const flagged = saved.filter(e => e.status === 'Needs Review').length;
    status.innerHTML = `✓ Added ${saved.length} entries (${flagged} need review)`;
    document.getElementById('rawNotes').value = '';
    renderStagingTable();
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
  }
}

async function attachDocxA() {
  await attachDocx('rawNotes', 'parse-status');
}

// ── PANEL B — SCREENSHOTS + TEXT + DOCX ───────────────────────────────────
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('dropzone').classList.remove('dragover');
  addImages([...e.dataTransfer.files]);
}
function handleImgSelect(e) { addImages([...e.target.files]); }

function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    panelBImages.push({ file: f, url: URL.createObjectURL(f) });
    const img = document.createElement('img');
    img.src = panelBImages[panelBImages.length - 1].url;
    img.className = 'thumb';
    document.getElementById('thumbGrid').appendChild(img);
  }
}

async function extractScreenshots() {
  const additionalText = document.getElementById('panelBText').value.trim();
  if (!panelBImages.length && !additionalText) {
    alert('Add screenshots or paste text first.');
    return;
  }
  const status = document.getElementById('extract-status');
  status.innerHTML = '<span class="spin">⟳</span> Extracting...';

  const fd = new FormData();
  for (const { file } of panelBImages) fd.append('images', file);
  if (additionalText) fd.append('text', additionalText);

  try {
    const res = await fetch('/api/ai/extract-screenshots', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const { entries } = await res.json();
    const saved = await api('POST', '/api/entries/batch', entries);
    stagingEntries.push(...saved);
    const flagged = saved.filter(e => e.status === 'Needs Review').length;
    status.innerHTML = `✓ Extracted ${saved.length} entries (${flagged} need review)`;
    panelBImages = [];
    document.getElementById('thumbGrid').innerHTML = '';
    document.getElementById('panelBText').value = '';
    renderStagingTable();
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
  }
}

async function attachDocxB() {
  await attachDocx('panelBText', 'extract-status');
}

// ── PANEL C — VXT IMPORT ──────────────────────────────────────────────────
async function parseVXT() {
  const text = document.getElementById('vxtText').value.trim();
  if (!text) return;
  const status = document.getElementById('vxt-status');
  status.innerHTML = '<span class="spin">⟳</span> Parsing with AI...';
  try {
    const { entries } = await api('POST', '/api/ai/parse-vxt', { text });
    const saved = await api('POST', '/api/entries/batch', entries);
    stagingEntries.push(...saved);
    const flagged = saved.filter(e => e.status === 'Needs Review').length;
    status.innerHTML = `✓ Added ${saved.length} entries (${flagged} need review)`;
    document.getElementById('vxtText').value = '';
    renderStagingTable();
  } catch (e) {
    status.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
  }
}

async function attachVXTFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.onchange = async () => {
      if (!input.files.length) return resolve(null);
      const file = input.files[0];
      const ext = file.name.split('.').pop().toLowerCase();
      const statusEl = document.getElementById('vxt-status');
      if (ext === 'docx') {
        resolve(await attachDocx('vxtText', 'vxt-status'));
      } else {
        const reader = new FileReader();
        reader.onload = e => {
          const ta = document.getElementById('vxtText');
          if (ta) ta.value = e.target.result;
          if (statusEl) statusEl.innerHTML = `✓ Loaded ${file.name}`;
          resolve(e.target.result || null);
        };
        reader.readAsText(file);
      }
    };
    input.click();
  });
}

// ── PANEL D — QUICK ADD ────────────────────────────────────────────────────
function inferCategory(desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('call') || d.includes('phone'))                              return 'Phone call';
  if (d.includes('text') || d.includes('message') || d.includes('sms'))      return 'Text exchange';
  if (d.includes('draft') || d.includes('letter') || d.includes('chron') ||
      d.includes('memo') || d.includes('review document'))                    return 'Document review';
  if (d.includes('research') || d.includes('westlaw') || d.includes('lexis')) return 'Research';
  if (d.includes('court') || d.includes('filing') || d.includes('ecf'))      return 'Court filing';
  if (d.includes('notes') || d.includes('timed'))                             return 'Notes — Timed';
  return 'Administrative';
}

async function quickAdd() {
  const m    = getMatter(document.getElementById('qa-matter').value);
  const desc = document.getElementById('qa-desc').value.trim();
  if (!desc) { alert('Please enter a task description.'); return; }
  const entry = {
    matter:      m ? m.num : '',
    client:      m ? m.client : '',
    date:        document.getElementById('qa-date').value || todayStr(),
    duration:    parseFloat(document.getElementById('qa-dur').value) || 0.1,
    description: desc,
    category:    inferCategory(desc),
    type:        document.getElementById('qa-type').value,
    rate:        m ? m.rate : 0,
    status:      m ? 'Ready' : 'Needs Review',
    source:      'quick_add',
  };
  const saved = await api('POST', '/api/entries', entry);
  stagingEntries.push(saved);
  document.getElementById('qa-desc').value = '';
  document.getElementById('qa-dur').value  = '0.1';
  renderStagingTable();
}

// ── PANEL D — EXPENSE QUICK ADD ───────────────────────────────────────────
async function quickAddExpense() {
  const m      = getMatter(document.getElementById('qe-matter').value);
  const desc   = document.getElementById('qe-desc').value.trim();
  const amount = parseFloat(document.getElementById('qe-amount').value) || 0;
  const date   = document.getElementById('qe-date').value || todayStr();
  const vendor = document.getElementById('qe-vendor').value.trim();
  if (!desc)   { alert('Please enter a description.'); return; }
  if (!amount) { alert('Please enter an amount.'); return; }
  const entry = {
    matter:       m ? m.num : '',
    client:       m ? m.client : '',
    date,
    duration:     1.0,        // quantity = 1.0 for all expenses
    description:  desc,
    category:     'Administrative',
    type:         'Expense',
    rate:         amount,     // price = dollar amount
    vendor_name:  vendor,
    status:       m ? 'Ready' : 'Needs Review',
    source:       'panel_d',
  };
  const saved = await api('POST', '/api/entries', entry);
  stagingEntries.push(saved);
  document.getElementById('qe-desc').value   = '';
  document.getElementById('qe-amount').value = '';
  document.getElementById('qe-vendor').value = '';
  renderStagingTable();
}

// ── DESCRIPTION HOVER TOOLTIP ─────────────────────────────────────────────
function initTooltip() {
  if (document.getElementById('descTooltip')) return;
  const tip = document.createElement('div');
  tip.id = 'descTooltip';
  tip.className = 'desc-tooltip';
  document.body.appendChild(tip);

  // Fix 1: global mousemove — force-hide if mouse strays more than 10px outside
  // the target cell. Catches cases where mouseleave never fires (rapid movement,
  // overlapping elements, focus changes, browser quirks).
  document.addEventListener('mousemove', e => {
    if (!_tooltipTarget) return;
    const r = _tooltipTarget.getBoundingClientRect();
    if (e.clientX < r.left - 10 || e.clientX > r.right  + 10 ||
        e.clientY < r.top  - 10 || e.clientY > r.bottom + 10) {
      hideDescTooltip();
    }
  }, { passive: true });

  // Fix 3: hide on any scroll inside the staging table wrapper — target row moves
  // away from the anchored tooltip position.
  const wrap = document.querySelector('.staging-wrap');
  if (wrap) {
    wrap.addEventListener('scroll', hideDescTooltip, { passive: true });
  }
}

function showDescTooltip(el) {
  const id = parseInt(el.dataset.entryId, 10);
  const entry = stagingEntries.find(e => e.id === id);
  if (!entry || !entry.description) return;
  const tip = document.getElementById('descTooltip');
  if (!tip) return;

  // Reset auto-hide timer and target on every new hover
  clearTimeout(_tooltipAutoTimer);
  _tooltipTarget = el;

  tip.textContent = entry.description;

  // Render off-screen to measure height before committing position
  tip.style.left = '-9999px';
  tip.style.top = '0';
  tip.style.display = 'block';

  const rect = el.getBoundingClientRect();
  const tipH = tip.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom;

  const top = spaceBelow >= tipH + 10 ? rect.bottom + 6 : rect.top - tipH - 6;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 420 - 8));

  tip.style.top = top + 'px';
  tip.style.left = left + 'px';

  // Fix 2: hard 4s cap — dismiss even if mouseleave somehow never fires
  _tooltipAutoTimer = setTimeout(hideDescTooltip, 4000);
}

function hideDescTooltip() {
  clearTimeout(_tooltipAutoTimer);
  _tooltipAutoTimer = null;
  _tooltipTarget    = null;
  const tip = document.getElementById('descTooltip');
  if (tip) tip.style.display = 'none';
}

// ── DESCRIPTION TEXTAREA AUTO-RESIZE ─────────────────────────────────────
function _descAutoResize(el) {
  const style = getComputedStyle(el);
  const lineH = parseFloat(style.lineHeight) || 20;
  const padV  = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const maxH  = lineH * 3 + padV; // cap at 3 rows
  el.style.height = 'auto';
  const natural = el.scrollHeight;
  el.style.height = Math.min(natural, maxH) + 'px';
  // Show scrollbar only when content exceeds the 3-row cap; hide it when it fits
  el.style.overflowY = natural > maxH ? 'auto' : 'hidden';
}

// Debounced wrapper — only fires resize 150ms after last input event
function _descAutoResizeDebounced(el) {
  clearTimeout(_descResizeTimerId);
  _descResizeTimerId = setTimeout(() => _descAutoResize(el), 150);
}

// ── DESCRIPTION EXPAND POPUP ──────────────────────────────────────────────
function openDescPopup(event, entryId) {
  event.stopPropagation();
  hideDescTooltip();

  const entry = stagingEntries.find(e => e.id === entryId);
  if (!entry) return;

  // ── Fix 2: Capture selection from source textarea BEFORE any DOM changes ──
  const srcTA = event.target?.closest?.('textarea') || (event.target?.tagName === 'TEXTAREA' ? event.target : null);
  const srcSelStart = srcTA ? srcTA.selectionStart : -1;
  const srcSelEnd   = srcTA ? srcTA.selectionEnd   : -1;

  // Remove any existing popup
  const existing = document.getElementById('descPopup');
  if (existing) existing.remove();

  const safeDesc = (entry.description || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const popup = document.createElement('div');
  popup.id = 'descPopup';
  popup.dataset.entryId = String(entryId);
  // Note: NO inline onclick on the header — drag + click handled via JS listeners below
  popup.innerHTML = `
    <div class="desc-popup-header">
      <span>Edit Description<span class="desc-popup-find-hint">↑ click to find entry</span></span>
      <button type="button" class="desc-popup-close" onclick="event.stopPropagation(); closeDescPopup()">×</button>
    </div>
    <textarea class="desc-popup-ta" id="descPopupTa">${safeDesc}</textarea>`;
  document.body.appendChild(popup);

  // ── Fix 1: Position — restore from sessionStorage or default below/above source ──
  const srcRect = event.target ? event.target.getBoundingClientRect() : { left: 100, top: 200, bottom: 220, width: 400 };
  const popW    = Math.max(400, srcRect.width);
  popup.style.width = popW + 'px';

  const savedPos = (() => {
    try { return JSON.parse(sessionStorage.getItem('descPopupPos')); } catch (_) { return null; }
  })();

  if (savedPos && typeof savedPos.top === 'number' && typeof savedPos.left === 'number') {
    popup.style.left = Math.max(8, Math.min(savedPos.left, window.innerWidth  - popW - 8)) + 'px';
    popup.style.top  = Math.max(8, Math.min(savedPos.top,  window.innerHeight - 200  - 8)) + 'px';
  } else {
    const spaceBelow = window.innerHeight - srcRect.bottom;
    popup.style.left = Math.max(8, Math.min(srcRect.left, window.innerWidth - popW - 8)) + 'px';
    popup.style.top  = (spaceBelow >= 196 ? srcRect.bottom + 6 : srcRect.top - 196 - 6) + 'px';
  }

  // ── Fix 2: Focus textarea and restore selection from source ──
  const ta = document.getElementById('descPopupTa');
  ta.focus();
  if (srcSelEnd > srcSelStart && srcSelStart >= 0) {
    // Mirror the user's selection from the small textarea into the popup
    ta.setSelectionRange(srcSelStart, srcSelEnd);
  } else {
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ── Fix 1: Drag support ───────────────────────────────────────────────────
  const header   = popup.querySelector('.desc-popup-header');
  let _wasDragged = false;

  header.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.desc-popup-close')) return;
    ev.preventDefault(); // keep textarea focus during drag; prevent text selection
    const rect = popup.getBoundingClientRect();
    const startX = ev.clientX, startY = ev.clientY;
    const startLeft = rect.left, startTop = rect.top;
    _wasDragged = false;

    const onMove = (mv) => {
      const dx = mv.clientX - startX;
      const dy = mv.clientY - startY;
      if (!_wasDragged && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      _wasDragged = true;
      const newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth  - popup.offsetWidth  - 4));
      const newTop  = Math.max(0, Math.min(startTop  + dy, window.innerHeight - popup.offsetHeight - 4));
      popup.style.left = newLeft + 'px';
      popup.style.top  = newTop  + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (_wasDragged) {
        // Persist drag position for next open
        sessionStorage.setItem('descPopupPos', JSON.stringify({
          top:  parseInt(popup.style.top,  10),
          left: parseInt(popup.style.left, 10),
        }));
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // Click header — scroll to entry only if the user didn't drag
  header.addEventListener('click', (ev) => {
    if (ev.target.closest('.desc-popup-close')) return;
    if (_wasDragged) { _wasDragged = false; return; } // suppress click after drag
    _descPopupScrollToEntry();
  });

  // Escape → save and close (handled on the textarea so Enter is never intercepted
  // and stopPropagation prevents the global Escape handler from double-firing).
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeDescPopup();
    }
    // Enter: intentionally unhandled — standard textarea newline behavior.
  });

  // Click outside → save and close (deferred one frame so the dblclick itself doesn't close it)
  requestAnimationFrame(() => {
    popup._clickHandler = (ev) => { if (!popup.contains(ev.target)) closeDescPopup(); };
    document.addEventListener('mousedown', popup._clickHandler, true);
  });
}

function closeDescPopup() {
  const popup = document.getElementById('descPopup');
  if (!popup) return;

  const ta      = document.getElementById('descPopupTa');
  const entryId = parseInt(popup.dataset.entryId, 10);
  const newVal  = ta ? ta.value : '';

  // Remove the click-outside listener before DOM removal
  // (the textarea's own keydown listener is garbage-collected with the element)
  if (popup._clickHandler) document.removeEventListener('mousedown', popup._clickHandler, true);
  popup.remove();

  // Persist — updateEntry will re-render the table with the saved value
  updateEntry(entryId, 'description', newVal);
}

function _descPopupScrollToEntry() {
  const popup = document.getElementById('descPopup');
  if (!popup) return;
  const entryId = parseInt(popup.dataset.entryId, 10);
  if (!entryId) return;
  const row = document.querySelector(`#stagingBody tr[data-id="${entryId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Re-trigger the blue pulse animation
  row.classList.remove('pulse-blue');
  void row.offsetWidth; // force reflow to restart animation cleanly
  row.classList.add('pulse-blue');
  setTimeout(() => row.classList.remove('pulse-blue'), 2000);
}

// ── BILLING PERIOD BASELINE ────────────────────────────────────────────────
function _parseCSVRow(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function _parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = _parseCSVRow(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = _parseCSVRow(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

function _normalizeDate(d) {
  if (!d) return '';
  const s = d.trim();
  // MM/DD/YYYY → YYYY-MM-DD
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  return s;  // assume already YYYY-MM-DD
}

function loadBaseline(event) {
  const file = event.target.files[0];
  if (!file) return;
  const input = event.target;   // capture before going async — event object can go stale
  const reader = new FileReader();
  reader.onload = e => {
    const rows = _parseCSV(e.target.result);
    console.log('[baseline] raw headers:', rows.length ? Object.keys(rows[0]) : '(empty)');
    console.log('[baseline] first 3 raw rows:', rows.slice(0, 3));

    // Accept any column that looks like a description: note, description, memo, notes
    const descKey = rows.length
      ? ['note', 'description', 'memo', 'notes'].find(k => k in rows[0])
      : null;
    // Accept any column that looks like a matter: matter, matter_number, matter #, client_matter
    const matterKey = rows.length
      ? ['matter', 'matter_number', 'matter #', 'client_matter', 'matter number'].find(k => k in rows[0])
      : null;

    console.log('[baseline] using matterKey:', matterKey, '  descKey:', descKey);

    _baseline = rows
      .filter(r => (matterKey && r[matterKey]) && (descKey && r[descKey]))
      .map(r => ({
        ...r,
        // Normalise to the field names the matching logic expects
        matter: matterKey ? r[matterKey] : r.matter,
        note:   descKey   ? r[descKey]   : r.note,
        date:   _normalizeDate(r.date || r.activity_date || r['date'] || ''),
      }));

    console.log('[baseline] loaded', _baseline.length, 'entries (filtered from', rows.length, 'rows)');
    console.log('[baseline] sample entry:', _baseline[0]);

    // Persist across page refreshes
    _baselineMeta = { filename: file.name, count: _baseline.length };
    try {
      localStorage.setItem('ar_baseline_entries', JSON.stringify(_baseline));
      localStorage.setItem('ar_baseline_meta',    JSON.stringify(_baselineMeta));
    } catch (storageErr) {
      console.warn('[baseline] localStorage save failed (quota?):', storageErr);
    }

    // New baseline invalidates previous Mark-as-Different dismissals
    _clioIgnoreIds.clear();
    localStorage.removeItem('ar_baseline_dismissed');
    input.value = '';
    _updateBaselineUI();
    renderStagingTable();
  };
  reader.readAsText(file);
}

function clearBaseline() {
  _baseline     = null;
  _baselineMeta = null;
  _clioIgnoreIds.clear();
  localStorage.removeItem('ar_baseline_entries');
  localStorage.removeItem('ar_baseline_meta');
  localStorage.removeItem('ar_baseline_dismissed');
  const fileInput = document.getElementById('baselineFile');
  if (fileInput) fileInput.value = '';
  _updateBaselineUI();
  renderStagingTable();
}

function _updateBaselineUI() {
  const banner   = document.getElementById('baselineBanner');
  const statusEl = document.getElementById('baseline-status');
  const clearBtn = document.getElementById('baseline-clear-btn');
  const countEl  = document.getElementById('baseline-count');

  const active   = _baseline && _baseline.length > 0;
  const n        = active ? _baseline.length : 0;
  const filename = _baselineMeta ? _baselineMeta.filename : '';

  // Capture-tab banner (full bar)
  if (banner) {
    banner.style.display = active ? 'flex' : 'none';
    if (countEl) countEl.textContent = n;
    const fnEl = document.getElementById('baseline-filename');
    if (fnEl) fnEl.textContent = filename ? ` (${filename})` : '';
  }
  // Capture-tab header pill (subtle indicator with filename)
  const pill = document.getElementById('capture-baseline-pill');
  if (pill) {
    pill.style.display = active ? 'flex' : 'none';
    const pillCount = document.getElementById('capture-baseline-count');
    if (pillCount) pillCount.textContent = n;
    const pillFn = document.getElementById('capture-baseline-filename');
    if (pillFn) pillFn.textContent = filename ? ` (${filename})` : '';
  }
  // Audit-tab status line
  if (statusEl) {
    statusEl.textContent = active
      ? `✓ ${n} Clio entries loaded${filename ? ` — ${filename}` : ''}`
      : 'No baseline loaded';
    statusEl.style.color     = active ? 'var(--green)' : '';
    statusEl.style.fontStyle = active ? 'normal' : 'italic';
  }
  if (clearBtn) clearBtn.style.display = active ? 'inline-flex' : 'none';
}

function getClioMatchIds() {
  _baselineMap  = new Map(); // entry id → matched baseline object
  _callNotesIds = new Set(); // entry ids with advisory Call+Notes badge
  if (!_baseline || !_baseline.length) return new Set();
  const matchIds = new Set();

  for (const e of stagingEntries) {
    if (_clioIgnoreIds.has(e.id)) continue;
    const eType   = e.type === 'Expense' ? 'expenseentry' : 'timeentry';
    const eIsNote = e.category === 'Notes — Timed' || e.category === 'Notes — Estimated';
    const eIsCall = e.category === 'Phone call';

    for (const b of _baseline) {
      if ((b.matter || '').toLowerCase() !== (e.matter || '').toLowerCase()) continue;
      if (b.date !== (e.date || '')) continue;
      if ((b.type || '').toLowerCase() !== eType) continue;

      const bActivityLc = (b.activity_description || '').toLowerCase().trim();
      const bIsCall = bActivityLc === 'phone call';
      const bIsText = bActivityLc === 'text exchange';

      // Category gate: Notes — Timed/Estimated staging entries are intentionally distinct
      // from Phone call AND Text exchange baseline entries. A note about a call or a text
      // thread is a separate billable activity from the call/exchange itself.
      // This gate applies before ALL match conditions (primary and secondary).
      if (eIsNote && (bIsCall || bIsText)) continue;

      // Primary: description similarity ≥ 70%
      if (wordOverlap(e.description || '', b.note || '') >= 0.7) {
        matchIds.add(e.id); _baselineMap.set(e.id, b); break;
      }

      // Secondary: Phone call staging vs Phone call baseline — duration proximity.
      // A call should only match against another call baseline entry.
      if (eIsCall && bIsCall) {
        const durDiff = Math.abs((parseFloat(b.quantity) || 0) - (parseFloat(e.duration) || 0));
        if (durDiff <= 0.1) { matchIds.add(e.id); _baselineMap.set(e.id, b); break; }
      }

      // Secondary: Notes staging vs same-type baseline — duration proximity.
      // Notes-vs-call and Notes-vs-text are already gated above.
      if (eIsNote && !bIsCall && !bIsText) {
        const durDiff = Math.abs((parseFloat(b.quantity) || 0) - (parseFloat(e.duration) || 0));
        if (durDiff <= 0.1) { matchIds.add(e.id); _baselineMap.set(e.id, b); break; }
      }
    }
  }

  // Advisory "Call + Notes" badge — second pass.
  // Marks notes entries (not already flagged as Clio matches) that have a corresponding
  // phone call in the baseline on the same matter and date. Informational only.
  for (const e of stagingEntries) {
    if (matchIds.has(e.id)) continue; // already flagged — badge would be redundant
    const eIsNote = e.category === 'Notes — Timed' || e.category === 'Notes — Estimated';
    if (!eIsNote) continue;
    const eType = e.type === 'Expense' ? 'expenseentry' : 'timeentry';
    for (const b of _baseline) {
      if ((b.matter || '').toLowerCase() !== (e.matter || '').toLowerCase()) continue;
      if (b.date !== (e.date || '')) continue;
      if ((b.type || '').toLowerCase() !== eType) continue;
      const bIsCall = (b.activity_description || '').toLowerCase().trim() === 'phone call';
      if (bIsCall) { _callNotesIds.add(e.id); break; }
    }
  }

  return matchIds;
}

// ── CALL-NOTE DURATION SUGGESTION ─────────────────────────────────────────
// Advisory sidebar card for Notes — Timed/Estimated entries whose description
// contains call-note language. Cross-references Clio baseline and Panel B staging
// for a matching Phone call or Text exchange on the same matter + date.

// Matches Notes entries whose description indicates they document a call.
const CALL_NOTE_REGEX = /(?:\bcall\s+notes?\b|\bnotes?\s+(?:from|re:?|following|after)\s+(?:a\s+)?(?:phone\s+)?call\b|\bcall\s+w\/)/i;

function _isCallNoteEntry(entry) {
  const cat = entry.category || '';
  return (cat === 'Notes — Timed' || cat === 'Notes — Estimated') &&
         CALL_NOTE_REGEX.test(entry.description || '');
}

// Returns an array (Clio first, Panel B second) of { source, type, duration } matches.
// Skips any source already dismissed by the user and matches where the duration
// is already correct (within 0.05 hr tolerance).
function _findCallDurSuggestions(entry) {
  if (!_isCallNoteEntry(entry)) return [];
  const eMatter = (entry.matter || '').toLowerCase();
  const eDate   = entry.date || '';
  const eDur    = parseFloat(entry.duration) || 0;
  const results = [];

  // Source A: Clio baseline — Phone call or Text exchange on same matter + date
  if (!_callDurSugDismissed.has(`${entry.id}:clio`) && _baseline && _baseline.length) {
    for (const b of _baseline) {
      if ((b.matter || '').toLowerCase() !== eMatter) continue;
      if (b.date !== eDate) continue;
      const bAct = (b.activity_description || '').toLowerCase().trim();
      if (bAct !== 'phone call' && bAct !== 'text exchange') continue;
      const dur = parseFloat(b.quantity) || 0;
      if (dur > 0 && Math.abs(dur - eDur) >= 0.05) {
        results.push({
          source:   'clio',
          type:     bAct === 'phone call' ? 'Phone call' : 'Text exchange',
          duration: dur,
        });
        break; // first Clio match wins
      }
    }
  }

  // Source B: Panel B staging entries — Phone call or Text exchange on same matter + date
  if (!_callDurSugDismissed.has(`${entry.id}:panel_b`)) {
    for (const se of stagingEntries) {
      if (se.id === entry.id) continue;
      if ((se.matter || '').toLowerCase() !== eMatter) continue;
      if (se.date !== eDate) continue;
      if (se.source !== 'panel_b') continue;
      if (se.category !== 'Phone call' && se.category !== 'Text exchange') continue;
      const dur = parseFloat(se.duration) || 0;
      if (dur > 0 && Math.abs(dur - eDur) >= 0.05) {
        results.push({
          source:   'panel_b',
          type:     se.category,
          duration: dur,
        });
        break; // first Panel B match wins
      }
    }
  }

  return results;
}

// Apply button — sets duration field and upgrades Notes — Estimated to Notes — Timed.
async function applyCallDurSug(entryId, durationHr, source) {
  _callDurSugDismissed.add(`${entryId}:${source}`);
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;
  await updateEntry(entryId, 'duration', durationHr);
  if (e.category === 'Notes — Estimated') {
    await updateEntry(entryId, 'category', 'Notes — Timed');
  }
  // Force sidebar refresh in case both updateEntry calls were no-ops (value already matched)
  if (_sidebarId === entryId) _renderSidebarContent(entryId);
}

// Dismiss button — hides the suggestion card for this entry + source permanently.
function dismissCallDurSug(entryId, source) {
  _callDurSugDismissed.add(`${entryId}:${source}`);
  if (_sidebarId === entryId) _renderSidebarContent(entryId);
}

// ── SORT ───────────────────────────────────────────────────────────────────
function setSort(field) {
  if (_sortField === field) {
    _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    _sortField = field;
    _sortDir   = 'asc';
  }
  // User explicitly re-sorted — release frozen order and sticky pins immediately
  _frozenSortOrder = null;
  _pinnedAfter.clear(); // explicit column-header re-sort releases all sticky positions
  // Show follow indicator for the currently open sidebar entry (it may move)
  if (_sidebarId !== null) _showFollowIndicator(_sidebarId);
  renderStagingTable();
}

// Status sort priority (ascending = attention-first):
//   0 Needs Review / Duplicate  → surface conflicts at top
//   1 Already in Clio           → surface baseline matches next
//   2 Ready                     → clean entries below conflicts
//   3 Approved                  → completed entries last
// Descending reverses the order (Approved first).
const STATUS_SORT_PRIORITY = { 'needs-review': 0, 'duplicate': 0, 'clio': 1, 'ready': 2, 'approved': 3 };

// Display labels for each status-sort priority group — used by the visual divider rows
// injected into the Capture table when sorted by Status column.
const STATUS_GROUP_LABELS = { 0: 'Needs Review', 1: 'In Clio Baseline', 2: 'Ready', 3: 'Approved' };

function _effectiveStatusPriority(entry, dupeIds, clioIds) {
  if (dupeIds.has(entry.id))              return STATUS_SORT_PRIORITY['duplicate'];
  if (clioIds.has(entry.id))              return STATUS_SORT_PRIORITY['clio'];
  if (entry.status === 'Needs Review')    return STATUS_SORT_PRIORITY['needs-review'];
  if (entry.status === 'Approved')        return STATUS_SORT_PRIORITY['approved'];
  return STATUS_SORT_PRIORITY['ready']; // Ready or anything else
}

function sortEntries(entries) {
  // ── Frozen order (clone-display window) ────────────────────────────────────
  // While _frozenSortOrder is set, return entries in the captured order so the
  // clone remains visually adjacent to its original. Entries not in the list
  // (shouldn't happen, but guards against race) are appended at the end.
  if (_frozenSortOrder !== null) {
    const idMap  = new Map(entries.map(e => [e.id, e]));
    const result = _frozenSortOrder.map(id => idMap.get(id)).filter(Boolean);
    const inSet  = new Set(_frozenSortOrder);
    for (const e of entries) { if (!inSet.has(e.id)) result.push(e); }
    return result;
  }

  const dir = _sortDir === 'asc' ? 1 : -1;

  // Pre-compute effective status priorities once (avoids O(n²) set lookups inside comparator)
  let priorityMap;
  if (_sortField === 'status') {
    const dupeIds = getDuplicateIds();
    const clioIds = getClioMatchIds();
    priorityMap = new Map(entries.map(e => [e.id, _effectiveStatusPriority(e, dupeIds, clioIds)]));
  }

  const sorted = [...entries].sort((a, b) => {
    switch (_sortField) {
      case 'matter':   return String(a.matter || '').localeCompare(String(b.matter || '')) * dir;
      case 'client':   return String(a.client || '').localeCompare(String(b.client || '')) * dir;
      case 'date':     return String(a.date   || '').localeCompare(String(b.date   || '')) * dir;
      case 'billable': {
        const va = (parseFloat(a.duration) || 0) * (parseFloat(a.rate) || 0);
        const vb = (parseFloat(b.duration) || 0) * (parseFloat(b.rate) || 0);
        return (va - vb) * dir;
      }
      case 'status': {
        // Primary: status priority group — dir controls which group surfaces first
        const pa = priorityMap.get(a.id) ?? 2;
        const pb = priorityMap.get(b.id) ?? 2;
        if (pa !== pb) return (pa - pb) * dir;
        // Secondary: client name A-Z — always ascending so clients cluster within each group
        const clientCmp = String(a.client || '').localeCompare(String(b.client || ''));
        if (clientCmp !== 0) return clientCmp;
        // Tertiary: date ascending (oldest first) — always ascending for chronological reading
        return String(a.date || '').localeCompare(String(b.date || ''));
      }
      case 'source': {
        const sa = SOURCE_SORT_ORDER[a.source] ?? 9;
        const sb = SOURCE_SORT_ORDER[b.source] ?? 9;
        return (sa - sb) * dir;
      }
      case 'type':
        return String(a.type || '').localeCompare(String(b.type || '')) * dir;
      case 'category': {
        // Sort by locked ACTIVITY_CATEGORIES list order, not alphabetically
        const ca = ACTIVITY_CATEGORIES.indexOf(a.category);
        const cb = ACTIVITY_CATEGORIES.indexOf(b.category);
        return ((ca === -1 ? 999 : ca) - (cb === -1 ? 999 : cb)) * dir;
      }
      case 'rate':
        return ((parseFloat(a.rate) || 0) - (parseFloat(b.rate) || 0)) * dir;
      default:
        return 0;
    }
  });

  // Re-apply sticky duplicate positions — clones stay directly below their original
  // until the user explicitly triggers a column re-sort (which calls _pinnedAfter.clear())
  if (_pinnedAfter.size > 0) {
    for (const [cloneId, origId] of _pinnedAfter) {
      const fromIdx = sorted.findIndex(e => e.id === cloneId);
      const toIdx   = sorted.findIndex(e => e.id === origId);
      if (fromIdx === -1 || toIdx === -1) continue;
      const [item] = sorted.splice(fromIdx, 1);
      // Re-find origId after removal (index may have shifted)
      const insertAfter = sorted.findIndex(e => e.id === origId);
      if (insertAfter === -1) { sorted.push(item); continue; }
      sorted.splice(insertAfter + 1, 0, item);
    }
  }

  return sorted;
}

// ── QUICK APPROVE ──────────────────────────────────────────────────────────
async function quickApprove(id) {
  // Guard: ignore duplicate clicks while an approve call is already in flight for this entry.
  if (_approveInProgress.has(id)) return;
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  const prevStatus = e.status;
  _approveInProgress.add(id);

  // ── Optimistic update ────────────────────────────────────────────────────
  // Set status immediately in memory so any re-render triggered by blur/onchange events
  // during the await sees the entry as Approved and disables the ✓ button at once.
  // This is the core fix for the double-click issue.
  e.status = 'Approved';

  const wrap = document.querySelector('.staging-wrap');
  const savedScrollTop  = wrap ? wrap.scrollTop  : 0;
  const savedScrollLeft = wrap ? wrap.scrollLeft : 0;

  renderStagingTable(); // immediate paint — button becomes disabled before API returns
  requestAnimationFrame(() => {
    const w = document.querySelector('.staging-wrap');
    if (w) { w.scrollTop = savedScrollTop; w.scrollLeft = savedScrollLeft; }
  });
  if (_sidebarId === id) _renderSidebarContent(id);

  // ── Persist to server ────────────────────────────────────────────────────
  try {
    const updated = await api('PUT', `/api/entries/${id}`, { status: 'Approved' });
    Object.assign(e, updated); // sync any server-side fields (timestamps etc.)
    renderStagingTable();
    requestAnimationFrame(() => {
      const w = document.querySelector('.staging-wrap');
      if (w) { w.scrollTop = savedScrollTop; w.scrollLeft = savedScrollLeft; }
    });
    refreshBanner();
    _showApproveToast(e, prevStatus);
    if (_sidebarId === id) _renderSidebarContent(id);
  } catch (err) {
    // Roll back the optimistic update if the server call failed.
    e.status = prevStatus;
    renderStagingTable();
    console.error('[quickApprove] API call failed — rolled back status for entry', id, err);
  } finally {
    _approveInProgress.delete(id);
  }
}

// ── CAPTURE SET READY ─────────────────────────────────────────────────────
// Sets a Needs Review entry to Ready in the Capture tab.
// Clears advisory validation flags (LONG_DESC, DAVIDSON_REVIEW, EST_TIME) so the
// badges disappear — the user has reviewed and intentionally marked the entry ready.
// CONF_RISK entries revert via _applyConfRiskDowngrades and stay NR.
async function captureSetReady(id) {
  if (_approveInProgress.has(id)) return;
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  const prevStatus = e.status;
  _approveInProgress.add(id);

  // Dismiss advisory flags so they no longer block the Ready state
  ['LONG_DESC', 'DAVIDSON_REVIEW', 'EST_TIME'].forEach(type => {
    _vfDismissed.add(`${id}:${type}`);
  });

  // Optimistic update — schedule sort FIRST so timer is set when renderStagingTable runs.
  // This suppresses status-group dividers during the 800ms animation window (dividers
  // would be wrong because the entry hasn't moved to its new section yet).
  e.status = 'Ready';
  _scheduleSort(id); // sets timer + shows follow indicator before the render
  renderStagingTable();
  if (_sidebarId === id) _renderSidebarContent(id);

  try {
    const updated = await api('PUT', `/api/entries/${id}`, { status: 'Ready' });
    Object.assign(e, updated); // apply server-confirmed values (sort timer will re-render)
    refreshBanner();
    _showSimpleToast('Entry marked Ready.');
    if (_sidebarId === id) _renderSidebarContent(id);
  } catch (err) {
    // Roll back optimistic update, flag dismissals, and the pending sort
    e.status = prevStatus;
    ['LONG_DESC', 'DAVIDSON_REVIEW', 'EST_TIME'].forEach(type => _vfDismissed.delete(`${id}:${type}`));
    _cancelScheduledSort();
    renderStagingTable();
    console.error('[captureSetReady] API call failed — rolled back status for entry', id, err);
  } finally {
    _approveInProgress.delete(id);
  }
}

// Sets a Ready entry back to Needs Review from the Capture sidebar.
async function sidebarUnmark(id) {
  if (_approveInProgress.has(id)) return;
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  _approveInProgress.add(id);
  e.status = 'Needs Review'; // optimistic
  _scheduleSort(id); // timer set before render — suppresses dividers during animation window
  renderStagingTable();
  if (_sidebarId === id) _renderSidebarContent(id);

  try {
    const updated = await api('PUT', `/api/entries/${id}`, { status: 'Needs Review' });
    Object.assign(e, updated);
    refreshBanner();
    if (_sidebarId === id) _renderSidebarContent(id);
    _showSimpleToast('Entry unmarked — set back to Needs Review.');
  } catch (err) {
    e.status = 'Ready'; // roll back
    _cancelScheduledSort();
    renderStagingTable();
    if (_sidebarId === id) _renderSidebarContent(id);
    console.error('[sidebarUnmark] API call failed — rolled back status for entry', id, err);
  } finally {
    _approveInProgress.delete(id);
  }
}

// ── CONFLICT SIDEBAR ──────────────────────────────────────────────────────

function findSiblings(entryId) {
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e || !e.matter || !e.date) return [];
  return stagingEntries.filter(x => x.id !== entryId && x.matter === e.matter && x.date === e.date);
}

// Entries on the same date with >50% description word overlap assigned to a DIFFERENT matter.
// These likely came from the same source interaction and are shown for cross-checking.
function _getProximityMatches(entry) {
  if (!entry.date) return [];
  const desc = entry.description || '';
  return stagingEntries.filter(x =>
    x.id     !== entry.id &&
    x.date   === entry.date &&
    x.matter !== entry.matter &&
    wordOverlap(desc, x.description || '') > 0.5
  );
}

// Active matters whose client surname appears in the entry description but have NO staging
// entry on the same date — surfaces likely-missing companion entries (the Eubanks gap case).
function _getMissingMatterSuggestions(entry) {
  if (!entry.date) return [];
  const clientSurnames = _getClientSurnames();
  const desc = entry.description || '';
  const suggestions = [];
  for (const { matter, surname, client } of clientSurnames) {
    if (matter === entry.matter) continue; // own matter — not interesting here
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!rx.test(desc)) continue;
    // Only suggest if no staging entry for this matter exists on this date
    const hasEntry = stagingEntries.some(x => x.matter === matter && x.date === entry.date);
    if (!hasEntry) suggestions.push({ matter, client, surname });
  }
  return suggestions;
}

function _pulseRow(row) {
  row.classList.remove('pulse-amber');
  void row.offsetWidth; // force reflow — restarts CSS animation
  row.classList.add('pulse-amber');
  setTimeout(() => row.classList.remove('pulse-amber'), 1500);
}

// Salmon pulse variant — used by Find, sort-after-status-change, and Review scroll-to
function _pulseRowSalmon(row) {
  row.classList.remove('pulse-salmon');
  void row.offsetWidth;
  row.classList.add('pulse-salmon');
  setTimeout(() => row.classList.remove('pulse-salmon'), 1600);
}

// Scroll the Review tab to the given entry id and pulse it salmon.
// Safe to call speculatively — no-ops silently if the entry isn't rendered (filtered out).
function _scrollReviewToEntry(id) {
  const row = document.querySelector(`#reviewGroups tr[data-id="${id}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  _pulseRowSalmon(row);
}

function highlightConflicts(row, shouldHighlight) {
  if (!shouldHighlight) return;
  const matter = row.dataset.matter;
  const date   = row.dataset.date;
  if (!matter || !date) return;
  document.querySelectorAll('tr[data-id][data-matter][data-date]').forEach(r => {
    if (r !== row && r.dataset.matter === matter && r.dataset.date === date) {
      r.classList.add('conflict-peer');
    }
  });
}

function clearConflictHighlights() {
  document.querySelectorAll('.conflict-peer').forEach(r => r.classList.remove('conflict-peer'));
}

// ── Sidebar open / close ──────────────────────────────────────────────────

function openConflictSidebar(entryId) {
  hideDescTooltip(); // Fix 4: dismiss tooltip on sidebar open/swap

  // Editing lock click-away: if the currently open sidebar is a locked entry and the user is
  // switching to a different entry, show the "Finish editing?" inline prompt on the locked row.
  if (!_suppressLockClickAway &&
      _sidebarId !== null && _sidebarId !== entryId &&
      _editingLocks.has(_sidebarId)) {
    _editingLockPromptId = _sidebarId;
    _syncEditLockPrompt(); // inject the prompt row immediately (before the re-render from this open)
  }

  _sidebarId = entryId;
  _renderSidebarContent(entryId); // rebuilds _baselineMap as a side effect
  document.getElementById('conflictSidebar').classList.add('open');
  document.body.classList.add('sb-is-open'); // Fix 6: extra padding on last table columns
  _applySidebarHighlight();
  // Log matched baseline entry so mismatches can be diagnosed in the console
  const matchedB = _baselineMap.get(entryId);
  if (matchedB) {
    console.log('[sidebar] Already in Clio — staging entry id:', entryId,
      '\n  matched baseline row:', matchedB);
  }
}

function closeConflictSidebar() {
  hideDescTooltip(); // Fix 4: dismiss tooltip on sidebar close
  // Fix 7: save scroll position before removing the "Viewing" badge
  // (removing the badge can change row height and cause a scroll-snap reflow)
  const wrap = document.querySelector('.staging-wrap');
  const savedTop  = wrap ? wrap.scrollTop  : 0;
  const savedLeft = wrap ? wrap.scrollLeft : 0;

  document.getElementById('conflictSidebar').classList.remove('open');
  document.body.classList.remove('sb-is-open'); // Fix 6
  _sidebarId     = null;
  _focusFlagType = null;
  _vfPreview     = null;
  _sidebarOrigin = null;
  _applySidebarHighlight(); // clears highlight + removes Viewing badge (may change row height)

  // Fix 7: restore exact scroll position after the badge removal reflow
  if (wrap) {
    wrap.scrollTop  = savedTop;
    wrap.scrollLeft = savedLeft;
  }

  const qaSlot = document.getElementById('sbQuickApproveSlot');
  if (qaSlot) qaSlot.innerHTML = '';
  const gotoOrigSlot = document.getElementById('sbGotoOriginalSlot');
  if (gotoOrigSlot) gotoOrigSlot.innerHTML = '';
  const sbEditSlot = document.getElementById('sbEditSlot');
  if (sbEditSlot) sbEditSlot.innerHTML = '';
  const sbFooter = document.getElementById('conflictSidebarFooter');
  if (sbFooter) sbFooter.innerHTML = '';
  if (_deleteConfirmTimer) { clearTimeout(_deleteConfirmTimer); _deleteConfirmTimer = null; }
}

// Apply or clear the "Viewing" row highlight in the staging table.
// Called whenever _sidebarId changes (open, close, swap) and after every renderStagingTable.
function _applySidebarHighlight() {
  // Strip highlight + Viewing badge from every row in both tables
  document.querySelectorAll('tr.sb-active-row').forEach(r => {
    r.classList.remove('sb-active-row');
  });
  document.querySelectorAll('.sb-viewing-badge').forEach(b => b.remove());

  if (_sidebarId === null) return;

  // Capture tab row
  const captureRow = document.querySelector(`#stagingBody tr[data-id="${_sidebarId}"]`);
  if (captureRow) {
    captureRow.classList.add('sb-active-row');
    // Inject "Viewing" pill into the status cell alongside existing badges
    const statusCell = captureRow.querySelector('.status-cell');
    if (statusCell) {
      const pill = document.createElement('span');
      pill.className = 'badge sb-viewing-badge';
      pill.textContent = 'Viewing';
      const sel = statusCell.querySelector('select');
      if (sel) statusCell.insertBefore(pill, sel);
      else statusCell.appendChild(pill);
    }
  }

  // Review tab row (no Viewing pill — status cell is read-only badges only)
  const reviewRow = document.querySelector(`#reviewGroups tr[data-id="${_sidebarId}"]`);
  if (reviewRow) {
    reviewRow.classList.add('sb-active-row');
  }
}

// ── Row click handler — single click opens/swaps, same-row double-click closes
const _DBL_MS = 400; // double-click window in ms

function rowClick(event, entryId) {
  if (event.target.closest('input,select,button,textarea,.del-btn,.vf-badge')) return;

  const now   = Date.now();
  const isDbl = entryId === _lastClickId && (now - _lastClickTs) < _DBL_MS;

  if (isDbl) {
    // Reset so a third click starts a fresh sequence
    _lastClickId = null;
    _lastClickTs = 0;
    // Only close if this row was already open BEFORE the double-click sequence started.
    // If _lastClickSidebarId !== entryId, click 1 already swapped — do nothing extra.
    if (_lastClickSidebarId === entryId) {
      closeConflictSidebar();
    }
    return;
  }

  // Single click — capture sidebar state before this click changes it
  _lastClickSidebarId = _sidebarId;
  _lastClickId        = entryId;
  _lastClickTs        = now;
  _focusFlagType = null; // generic row click — no specific flag focused
  openConflictSidebar(entryId);
}

// ── Sidebar content renderer ──────────────────────────────────────────────

function _renderSidebarContent(entryId) {
  hideDescTooltip(); // Fix 4: dismiss tooltip on sidebar content swap
  const content = document.getElementById('conflictSidebarContent');
  if (!content) return;

  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) { closeConflictSidebar(); return; }

  const dupeIds  = getDuplicateIds();
  const clioIds  = getClioMatchIds();
  const siblings = findSiblings(entryId);

  const isDupe          = dupeIds.has(e.id);
  const isInClio        = clioIds.has(e.id);
  const isSplit         = e.source === 'split';
  const isReview        = e.status === 'Needs Review';
  // Which tab opened the sidebar — drives two conditional rendering decisions:
  // (1) "Edit in Capture ↗" only shown from Review context
  // (2) per-entry action buttons (Mark as Different, Delete) only shown from Capture context
  const isReviewContext = !!document.getElementById('sec-review')?.classList.contains('active');
  const billable = (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0);

  const srcLabel = {
    panel_a:  'Manual / Docx',
    panel_b:  'Screenshot',
    wisetime: 'WiseTime',
    split:    'Split',
    call_log: 'Call Log',
    cloned:   'Cloned',
    notabill: 'NotaBill',
  }[e.source] || (e.source || '—');

  // Status badge + matching label color for the sidebar Status field
  let statusBadge, statusLabelColor;
  if (isDupe) {
    statusBadge      = '<span class="badge badge-duplicate">Duplicate</span>';
    statusLabelColor = 'color:var(--red)';
  } else if (isInClio) {
    statusBadge      = '<span class="badge badge-clio">Already in Clio</span>';
    statusLabelColor = 'color:#7c3aed';
  } else if (isReview) {
    statusBadge      = '<span class="badge badge-review">Needs Review</span>';
    statusLabelColor = 'color:var(--amber)';
  } else if (e.status === 'Approved') {
    statusBadge      = '<span class="badge badge-approved">Approved</span>';
    statusLabelColor = 'color:var(--approved)';
  } else {
    statusBadge      = '<span class="badge badge-ready">Ready</span>';
    statusLabelColor = 'color:var(--green)';
  }

  // ── Editing lock banner (shown at very top when this clone is still in edit mode) ──
  const isEditLocked = _editingLocks.has(entryId);
  let html = isEditLocked
    ? `<div class="edit-lock-banner">
        <span style="flex:1">✏ Editing new entry — click <strong>Done</strong> when finished to place it correctly</span>
        <button class="btn btn-sm" onclick="commitEditingLock(${entryId})"
          style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;white-space:nowrap">✓ Done</button>
      </div>`
    : '';

  // ── Section 1: Entry Summary ──────────────────────────────────────────
  // (Edit in Capture / Return to Review buttons moved to sidebar header row 2 — sbEditSlot)
  html += `
    <div class="sb-section-hdr" style="color:#1a3a5c">Entry Summary</div>
    <div class="sb-field"><div class="sb-lbl">Matter</div><div class="sb-val">${e.matter || '—'}</div></div>
    <div class="sb-field"><div class="sb-lbl">Client</div><div class="sb-val">${e.client || '—'}</div></div>
    <div class="sb-field"><div class="sb-lbl">Date</div><div class="sb-val">${e.date || '—'}</div></div>
    <div class="sb-field"><div class="sb-lbl">${e.type === 'Expense' ? 'Quantity' : 'Duration'}</div><div class="sb-val">${e.type === 'Expense' ? (() => { const q = Math.round(parseFloat(e.duration)||1); return q + (q !== 1 ? ' units' : ' unit'); })() : `${(parseFloat(e.duration)||0).toFixed(1)} hr`}</div></div>
    <div class="sb-field"><div class="sb-lbl">Billable</div><div class="sb-val" style="font-weight:600">$${billable.toFixed(2)}</div></div>
    <div class="sb-field"><div class="sb-lbl">Category</div><div class="sb-val">${e.category || '—'}</div></div>
    <div class="sb-field"><div class="sb-lbl">Source</div><div class="sb-val">${srcLabel}</div></div>
    <div class="sb-field"><div class="sb-lbl" style="${statusLabelColor}">Status</div><div class="sb-val">${statusBadge}</div></div>
    <div class="sb-field"><div class="sb-lbl">Description</div>
      <div class="sb-val" style="white-space:pre-wrap">${(e.description || '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
    </div>`;

  // ── Duration Suggestion (call-note entries only) ──────────────────────
  // Blue advisory card: a Phone call or Text exchange was found on the same matter + date
  // in the Clio baseline (Source A, shown first) or Panel B staging (Source B).
  // Clio is more authoritative — shown first if both sources match.
  {
    const callDurSugs = _findCallDurSuggestions(e);
    if (callDurSugs.length > 0) {
      const escS = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += `<hr class="sb-divider">`;
      for (const sug of callDurSugs) {
        const srcLabel = sug.source === 'clio' ? 'Clio baseline' : 'Panel B entry';
        html += `<div class="call-dur-sug">
          <div class="call-dur-sug-hdr">
            <span class="call-dur-sug-title">⏱ Duration Suggestion</span>
            <span class="call-dur-sug-src">${srcLabel}</span>
          </div>
          <div class="call-dur-sug-body">
            A <strong>${escS(sug.type)}</strong> entry for <strong>${escS(e.matter || '—')}</strong>
            on <strong>${escS(e.date || '—')}</strong> shows
            <strong>${sug.duration.toFixed(1)} hr</strong> — apply to this entry?
          </div>
          <div class="call-dur-sug-actions">
            <button class="btn btn-sm call-dur-apply-btn"
              onclick="applyCallDurSug(${e.id}, ${sug.duration}, '${sug.source}')">
              ↑ Apply ${sug.duration.toFixed(1)} hr</button>
            <button class="btn btn-sm btn-ghost"
              onclick="dismissCallDurSug(${e.id}, '${sug.source}')">Dismiss</button>
          </div>
        </div>`;
      }
    }
  }

  // ── Section 2: Conflict Details (only when flagged) ───────────────────
  // Split sibling display moved to Related Entries section (shown for all entries)
  const hasConflict = isDupe || isInClio || isReview;
  if (hasConflict) {
    html += `<hr class="sb-divider">`;

    // Probable duplicate
    if (isDupe && siblings.length > 0) {
      html += `<div class="sb-section-hdr" style="color:#dc2626;margin-top:0">Probable Duplicate (${siblings.length})</div>`;
      html += siblings.map(s => _sbCard(s)).join('');
    }

    // Already in Clio
    if (isInClio) {
      html += `<div class="sb-section-hdr" style="color:#7c3aed;margin-top:${isDupe?'16px':'0'}">Baseline Match</div>
        <p style="font-size:12px;color:var(--text-muted);line-height:1.5;margin:0 0 12px">
          This entry exists in your Clio baseline — verify before approving.
        </p>`;
      // Use the baseline entry captured by getClioMatchIds() — exact same match logic, no re-scan
      const matchedB = _baselineMap.get(e.id);
      if (matchedB) {
        // ── Diagnostic log: verify all expected Clio CSV fields are present ──
        console.log('[baseline-match] matched row fields →', {
          matter:               matchedB.matter,
          date:                 matchedB.date,
          quantity:             matchedB.quantity,
          price:                matchedB.price,
          note:                 matchedB.note,
          activity_description: matchedB.activity_description,
          type:                 matchedB.type,
        });

        // quantity is a string from CSV parsing — distinguish '' / undefined from a real 0
        const rawQty  = (matchedB.quantity ?? '').toString().trim();
        const bDur    = rawQty !== '' ? parseFloat(rawQty) : NaN;
        const bDurStr = (!isNaN(bDur) && bDur > 0) ? `${bDur.toFixed(1)} hr` : '—';

        // Hover tooltip text: full Clio note; fall back to activity_description if blank
        const _bTip  = (matchedB.note || '').trim() || (matchedB.activity_description || '').trim();
        const _bAttr = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        html += `<div class="sb-card" style="border-color:rgba(149,128,205,.34);background:rgba(149,128,205,.1)"
          ${_bTip ? `data-fulldesc="${_bAttr(_bTip)}"` : ''}
          onmouseenter="_showRelTooltip(this)" onmouseleave="_hideRelTooltip()">
          <div class="sb-card-meta" style="color:#cbbdf0">${matchedB.matter || ''} · ${matchedB.date || ''}</div>
          <div class="sb-card-desc">${(matchedB.note || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').slice(0, 140)}</div>
          <div style="font-size:11px;color:var(--text-muted)">
            Duration: ${bDurStr}${matchedB.price ? ` · $${matchedB.price}` : ''}
          </div>
        </div>`;
      }
      html += !isReviewContext ? `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-sm btn-ghost" onclick="markAsDifferent(${e.id})"
          style="color:#cbbdf0;border-color:rgba(149,128,205,.34)">Mark as Different</button>
        <button class="btn btn-sm" onclick="deleteEntryFromSidebar(${e.id})"
          style="background:var(--red-bg);color:var(--red);border:1px solid rgba(224,133,122,.4)">Delete Entry</button>
      </div>` : '';
    }

    // Needs Review with no specific conflict
    if (isReview && !isDupe && !isInClio) {
      html += `<div class="sb-section-hdr" style="color:var(--amber)">Needs Review</div>
        <p style="font-size:12px;color:var(--text-muted);line-height:1.5;margin:0">
          No specific conflict found — review description and matter assignment before approving.
        </p>`;
    }
  }

  // ── Section 3: Validation Flags ─────────────────────────────────────────
  const vFlags = _validationFlags.get(e.id) || [];
  if (vFlags.length > 0) {
    // Header color tracks most severe active flag: red for Conf Risk, amber for everything else.
    const vfHdrColor = vFlags.some(f => f.type === 'CONF_RISK') ? '#b03030' : '#b87a10';
    html += `<hr class="sb-divider">
      <div class="sb-section-hdr" style="color:${vfHdrColor}">Validation Flags</div>`;

    for (const flag of vFlags) {
      const isFocused  = _focusFlagType === flag.type;
      const blockClass = `vf-flag-block${
        isFocused ? (flag.type === 'CONF_RISK' ? ' vf-conf-focused' : ' vf-focused') : ''
      }`;
      const hasPrev = _vfPreview && _vfPreview.id === e.id && _vfPreview.type === flag.type;
      const esc = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      if (flag.type === 'LONG_DESC') {
        const len = (e.description || '').length;
        html += `<div class="${blockClass}">
          <div class="vf-flag-hdr">
            <span class="badge vf-long-desc">Long Desc</span>
            <span class="vf-flag-msg">${len} chars — max 80</span>
          </div>
          ${isFocused ? `
            <div class="vf-excerpt">${esc((e.description||'').slice(0,120))}${len > 120 ? '…' : ''}</div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn-sm" id="vfCompressBtn"
                onclick="vfCompress(${e.id})"
                style="background:var(--amber-bg);color:var(--amber);border:1px solid rgba(234,168,99,.34)">AI Compress</button>
              <button class="btn btn-sm btn-ghost" onclick="vfDismissFlag(${e.id},'LONG_DESC')"
                style="font-size:11px">Dismiss</button>
            </div>
            ${hasPrev ? `<div class="vf-preview-block">
              <div class="vf-preview-lbl">Compressed to (${(_vfPreview.value||'').length} chars):</div>
              <div class="vf-preview-text">${esc(_vfPreview.value)}</div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-sm" onclick="vfAccept(${e.id},'description')"
                  style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a">Accept</button>
                <button class="btn btn-sm btn-ghost" onclick="vfDismissPreview()"
                  style="font-size:11px">Discard</button>
              </div>
            </div>` : ''}
          ` : `<button class="btn btn-sm btn-ghost vf-review-btn"
              onclick="_openVFSidebar(${e.id},'LONG_DESC')">Review →</button>`}
        </div>`;
      }

      if (flag.type === 'CONF_RISK') {
        const confSurnames = flag.surnames || (flag.surname ? [flag.surname] : []);
        const summaryText  = confSurnames.length > 1
          ? `References ${confSurnames.length} other clients: ${confSurnames.map(s => `"${esc(s)}"`).join(', ')}`
          : `References "${esc(confSurnames[0] || '')}"`;
        html += `<div class="${blockClass}">
          <div class="vf-flag-hdr">
            <span class="badge vf-conf-risk">${confSurnames.length > 1 ? `Conf. Risk (${confSurnames.length})` : 'Conf. Risk'}</span>
            <span class="vf-flag-msg">${summaryText}</span>
          </div>
          ${isFocused ? `
            <div class="vf-excerpt">${esc((e.description||'').slice(0,120))}${(e.description||'').length > 120 ? '…' : ''}</div>
            ${confSurnames.length > 1 ? `<p style="font-size:11px;color:var(--text-muted);margin:8px 0 4px;line-height:1.4">
              Scrub each detected name individually. Start with the most critical.
            </p>` : ''}
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              ${confSurnames.map(sn => `
                <button class="btn btn-sm" data-scrub-btn="${esc(sn)}"
                  onclick="vfScrub(${e.id},'${sn.replace(/'/g,"\\'")}')"
                  style="background:#fde8e8;color:#991b1b;border:1px solid #fca5a5">
                  AI Scrub "${esc(sn)}"
                </button>`).join('')}
              <button class="btn btn-sm btn-ghost" onclick="vfDismissFlag(${e.id},'CONF_RISK')"
                style="font-size:11px">Dismiss All</button>
            </div>
            ${hasPrev ? `<div class="vf-preview-block">
              <div class="vf-preview-lbl">Scrubbed:</div>
              <div class="vf-preview-text">${esc(_vfPreview.value)}</div>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-sm" onclick="vfAccept(${e.id},'description')"
                  style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a">Accept</button>
                <button class="btn btn-sm btn-ghost" onclick="vfDismissPreview()"
                  style="font-size:11px">Discard</button>
              </div>
            </div>` : ''}
          ` : `<button class="btn btn-sm btn-ghost vf-review-btn"
              onclick="_openVFSidebar(${e.id},'CONF_RISK')">Review →</button>`}
        </div>`;
      }

      if (flag.type === 'DAVIDSON_REVIEW') {
        const davidsonMatter = matters.find(m => (m.num||'').toLowerCase().includes('davidson') && m.active);
        html += `<div class="${blockClass}">
          <div class="vf-flag-hdr">
            <span class="badge vf-davidson">Davidson?</span>
            <span class="vf-flag-msg">Internal firm keywords on client matter</span>
          </div>
          ${isFocused ? `
            <div class="vf-excerpt">${esc((e.description||'').slice(0,120))}${(e.description||'').length > 120 ? '…' : ''}</div>
            <p style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.4">
              This entry is assigned to <strong>${esc(e.matter||'—')}</strong> but mentions
              internal firm topics. It may belong in the Davidson Internal matter instead.
            </p>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
              ${davidsonMatter ? `<button class="btn btn-sm" onclick="vfReassignToDavidson(${e.id},'${davidsonMatter.num.replace(/'/g,"\\'")}')"
                style="background:#eff6ff;color:#1e40af;border:1px solid #bfdbfe">Reassign to Davidson</button>` : ''}
              <button class="btn btn-sm btn-ghost" onclick="vfDismissFlag(${e.id},'DAVIDSON_REVIEW')"
                style="font-size:11px">Keep Current Matter</button>
            </div>
          ` : `<button class="btn btn-sm btn-ghost vf-review-btn"
              onclick="_openVFSidebar(${e.id},'DAVIDSON_REVIEW')">Review →</button>`}
        </div>`;
      }

      if (flag.type === 'EST_TIME') {
        html += `<div class="${blockClass}">
          <div class="vf-flag-hdr">
            <span class="badge vf-est-time">Est. Time</span>
            <span class="vf-flag-msg">Duration is estimated</span>
          </div>
          ${isFocused ? `
            <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.4">
              This entry uses an estimated duration. Update the Qty/Dur field in the staging
              table with the actual time, then use the button below to change the category to
              Notes — Timed.
            </p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm" onclick="vfMarkTimed(${e.id})"
                style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a">Mark as Timed</button>
              <button class="btn btn-sm btn-ghost" onclick="vfDismissFlag(${e.id},'EST_TIME')"
                style="font-size:11px">Dismiss</button>
            </div>
          ` : `<button class="btn btn-sm btn-ghost vf-review-btn"
              onclick="_openVFSidebar(${e.id},'EST_TIME')">Review →</button>`}
        </div>`;
      }
    }
  }

  // ── Section 4: Unified Related Entries ────────────────────────────────────
  {
    const esc2    = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const escAttr = s => esc2(s).replace(/"/g,'&quot;');

    const cloneOrigId    = _pinnedAfter.get(e.id);
    const cloneOrigEntry = cloneOrigId != null ? stagingEntries.find(x => x.id === cloneOrigId) : null;
    const splitSibs      = isSplit ? siblings : [];
    const proxMatches    = _getProximityMatches(e);
    const missSugs       = _getMissingMatterSuggestions(e);

    const totalRelated = (cloneOrigEntry ? 1 : 0) + splitSibs.length + proxMatches.length;
    const hasRelated   = totalRelated > 0 || missSugs.length > 0;

    if (hasRelated) {
      // Collapsed by default when ≥ 3 entries; expanded by default when 1–2.
      // _relatedExpanded tracks whether the user has deviated from the default.
      const defaultExp = totalRelated < 3;
      const userToggled = _relatedExpanded.has(e.id);
      const isExp = userToggled ? !defaultExp : defaultExp;

      // Type pills: Original (navy) / Split (teal) / Related (blue)
      const origPill  = `<span style="display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap;color:#fff;background:#1a3a5c;border:1px solid #1a3a5c">Original</span>`;
      const splitPill = `<span style="display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap;color:#0e7490;background:#e0f7f4;border:1px solid #a8dbd7">Split</span>`;
      const relPill   = `<span style="display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:700;white-space:nowrap;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe">Related</span>`;

      // Card builder — matter/client/date, type+status+source badges, 80-char desc, duration/bill, Go to
      const relCard = (entry, typePill) => {
        const bill  = (parseFloat(entry.duration) || 0) * (parseFloat(entry.rate) || 0);
        const dsc   = esc2((entry.description || '').slice(0, 80));
        const trunc = (entry.description || '').length > 80;
        const isDupeE = dupeIds.has(entry.id), isClioE = clioIds.has(entry.id);
        const isRevE  = entry.status === 'Needs Review';
        const sBadge  = isDupeE   ? '<span class="badge badge-duplicate">Duplicate</span>'
                      : isClioE   ? '<span class="badge badge-clio">Already in Clio</span>'
                      : isRevE    ? '<span class="badge badge-review">Needs Review</span>'
                      : entry.status === 'Approved' ? '<span class="badge badge-approved">Approved</span>'
                      :             '<span class="badge badge-ready">Ready</span>';
        const sc      = SOURCE_PILL_CONFIG[entry.source] || { label: entry.source || '—', color: '#374151', bg: '#f9fafb', border: '#e5e7eb' };
        const srcPill = `<span style="display:inline-block;padding:1px 6px;border-radius:20px;font-size:10px;font-weight:600;white-space:nowrap;color:${sc.color};background:${sc.bg};border:1px solid ${sc.border}">${sc.label}</span>`;
        return `<div class="rel-entry-card" data-fulldesc="${escAttr(entry.description || '')}" onmouseenter="_showRelTooltip(this)" onmouseleave="_hideRelTooltip()">
          <div class="rel-entry-meta">${esc2(entry.matter)} · ${esc2(entry.client)} · ${esc2(entry.date || '—')}</div>
          <div class="rel-entry-badges">${typePill}${sBadge}${srcPill}</div>
          <div class="rel-entry-desc">${dsc}${trunc ? '…' : ''}</div>
          <div class="rel-entry-footer">
            <span style="font-size:11px;color:var(--text-muted)">${entry.type === 'Expense' ? `${Math.round(parseFloat(entry.duration)||1)} qty` : `${(parseFloat(entry.duration)||0).toFixed(1)} hr`} · $${bill.toFixed(2)}</span>
            <button class="btn btn-sm btn-ghost" style="font-size:10px;padding:1px 6px" onclick="goToEntry(${entry.id})">Go to ↗</button>
          </div>
        </div>`;
      };

      const countLabel = totalRelated > 0 ? ` (${totalRelated})` : '';
      html += `<hr class="sb-divider">
        <button class="rel-toggle" onclick="toggleRelatedExpanded(${e.id})">
          <span>Related Entries${countLabel}</span>
          <span class="rel-toggle-arrow">${isExp ? '▲' : '▼'}</span>
        </button>`;

      if (isExp) {
        // Order: Original → Split siblings → Proximity matches
        if (cloneOrigEntry)       html += relCard(cloneOrigEntry, origPill);
        splitSibs.forEach(s  => { html += relCard(s, splitPill); });
        proxMatches.forEach(s => { html += relCard(s, relPill);  });

        // Missing matter suggestions (below cards, always shown when section is open)
        if (missSugs.length > 0) {
          html += missSugs.map(sug => `
            <div class="rel-miss-suggestion">
              <span class="rel-miss-text">No <strong>${esc2(sug.matter)}</strong> entry found for this date — create one?</span>
              <button class="btn btn-sm rel-miss-btn"
                onclick="quickCloneForMatter(${e.id},'${sug.matter.replace(/'/g,"\\'")}')">Quick Clone</button>
            </div>`).join('');
        }
      }
    }
  }

  // ── Section 5: Entry History ─────────────────────────────────────────────
  const hist = (_entryHistory.get(entryId) || []).slice().reverse().slice(0, 3); // newest first, max 3
  if (hist.length > 0) {
    const FIELD_LABELS = {
      description: 'Description', category: 'Category', matter: 'Matter',
      date: 'Date', duration: 'Duration', rate: 'Rate', status: 'Status',
    };
    html += `<hr class="sb-divider">
      <div class="sb-section-hdr" style="color:#64748b">Recent Changes</div>`;
    hist.forEach((item, displayIdx) => {
      const label   = FIELD_LABELS[item.field] || item.field;
      const ts      = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const oldDisp = String(item.oldVal ?? '').slice(0, 60) || '(empty)';
      const newDisp = String(item.newVal ?? '').slice(0, 60) || '(empty)';
      const esc     = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      html += `<div class="hist-item">
        <div class="hist-meta">
          <span class="hist-field">${label}</span>
          <span class="hist-ts">${ts}</span>
          <button class="btn btn-sm btn-ghost hist-revert-btn"
            onclick="revertHistoryItem(${entryId},${displayIdx})"
            title="Revert this change">↩ Revert</button>
        </div>
        <div class="hist-change">
          <span class="hist-old" title="${esc(item.oldVal)}">${esc(oldDisp)}${String(item.oldVal||'').length > 60 ? '…' : ''}</span>
          <span class="hist-arrow">→</span>
          <span class="hist-new" title="${esc(item.newVal)}">${esc(newDisp)}${String(item.newVal||'').length > 60 ? '…' : ''}</span>
        </div>
      </div>`;
    });
  }

  content.innerHTML = html;

  // ── Sidebar header action button — context-aware ────────────────────────
  // Capture context: "✓ Ready" (NR) | "⚑ Unmark" (Ready) | locked badge (Approved)
  // Review context:  "✓ Approve" (Ready/NR) | "⚑ Unapprove" (Approved)
  const qaSlot = document.getElementById('sbQuickApproveSlot');
  if (qaSlot) {
    if (isReviewContext) {
      // Review tab: Approve / Unapprove
      if (e.status === 'Approved') {
        qaSlot.innerHTML = `<button class="sb-unapprove-btn"
          onclick="sidebarUnapprove(${e.id})"
          title="Set back to Ready">↩ Undo</button>`;
      } else {
        qaSlot.innerHTML = `<button class="sb-quick-approve-btn"
          onclick="quickApprove(${e.id})"
          title="Approve this entry">✓ Approve</button>`;
      }
    } else {
      // Capture tab: Ready / Unmark / locked badge
      if (e.status === 'Approved') {
        qaSlot.innerHTML = `<span class="sb-approved-badge" title="Approved — manage in Review tab">✓ Approved</span>`;
      } else if (e.status === 'Ready') {
        qaSlot.innerHTML = `<button class="sb-unmark-btn"
          onclick="sidebarUnmark(${e.id})"
          title="Set back to Needs Review">⚑ Unmark</button>`;
      } else {
        const blockType = _blockingFlagType(e.description ?? '', e.matter ?? '', e.category ?? '');
        const title     = blockType === 'CONF_RISK' ? 'Resolve Conf. Risk before marking Ready'
                        :                             'Mark this entry as Ready';
        qaSlot.innerHTML = `<button class="sb-quick-approve-btn"
          ${blockType ? 'disabled' : `onclick="captureSetReady(${e.id})"`}
          title="${title}">✓ Ready</button>`;
      }
    }
  }

  // ── "Go to Original" slot in sidebar header ─────────────────────────────
  // Visible only when this entry is a clone with a known original (tracked in _pinnedAfter).
  const gotoOrigSlot = document.getElementById('sbGotoOriginalSlot');
  if (gotoOrigSlot) {
    const origId = _pinnedAfter.get(e.id);
    if (origId != null && stagingEntries.some(x => x.id === origId)) {
      gotoOrigSlot.innerHTML = `<button class="sb-goto-original-btn"
        onclick="goToEntry(${origId})"
        title="Original — scroll to and highlight the source entry">⤴</button>`;
    } else {
      gotoOrigSlot.innerHTML = '';
    }
  }

  // ── Edit-context slot in sidebar header row 2 ────────────────────────────
  // Shows "✏ Edit" when opened from Review (links to Capture tab for editing),
  // or "↩ Review" when the sidebar was originally opened from the Review tab.
  const sbEditSlot = document.getElementById('sbEditSlot');
  if (sbEditSlot) {
    if (isReviewContext) {
      sbEditSlot.innerHTML = `<button class="sb-find-btn" onclick="editInCapture(${e.id})" title="Switch to Capture tab and edit this entry">✏ Edit</button>`;
    } else if (_sidebarOrigin === 'review') {
      sbEditSlot.innerHTML = `<button class="sb-find-btn" onclick="returnToReview(${e.id})" title="Return to Review tab">↩ Review</button>`;
    } else {
      sbEditSlot.innerHTML = '';
    }
  }

  // ── Footer: Copy + Delete buttons ────────────────────────────────────────
  // Guard: if delete confirmation is already showing, don't overwrite it.
  const sbFooter = document.getElementById('conflictSidebarFooter');
  if (sbFooter && _deleteConfirmTimer === null) {
    sbFooter.innerHTML = `
      <button class="sb-copy-btn" onclick="_copyEntryToClipboard(${e.id})" title="Copy entry details to clipboard">⧉ Copy</button>
      <button class="sb-delete-btn" onclick="_showDeleteConfirm(${e.id})">🗑 Delete Entry</button>`;
  }
}

function _copyEntryToClipboard(entryId) {
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;
  const billable = (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0);
  const text = [
    `Matter: ${e.matter || '—'}`,
    `Client: ${e.client || '—'}`,
    `Date: ${e.date || '—'}`,
    e.type === 'Expense'
      ? `Quantity: ${Math.round(parseFloat(e.duration)||1)} unit${Math.round(parseFloat(e.duration)||1) !== 1 ? 's' : ''}`
      : `Duration: ${(parseFloat(e.duration)||0).toFixed(1)} hr`,
    `Description: ${e.description || '—'}`,
    `Category: ${e.category || '—'}`,
    `Billable: $${billable.toFixed(2)}`,
  ].join(' | ');

  const _showCopied = () => {
    const footer = document.getElementById('conflictSidebarFooter');
    if (!footer) return;
    const btn = footer.querySelector('.sb-copy-btn');
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.textContent = '✓ Copied!';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 1500);
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(_showCopied).catch(() => _fallbackCopy(text, _showCopied));
  } else {
    _fallbackCopy(text, _showCopied);
  }
}

function _fallbackCopy(text, onDone) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); if (onDone) onDone(); } catch (_) {}
  ta.remove();
}

function _sbCard(s) {
  const bill = (parseFloat(s.duration) || 0) * (parseFloat(s.rate) || 0);
  const raw  = s.description || '';
  const desc = raw.length > 100 ? raw.slice(0, 100) + '…' : raw;
  return `<div class="sb-card">
    <div class="sb-card-meta">${s.matter || '—'} · ${s.date || '—'}</div>
    <div class="sb-card-desc">${desc.replace(/&/g,'&amp;').replace(/</g,'&lt;') || '<em>No description</em>'}</div>
    <div class="sb-card-footer">
      <span style="font-size:11px;color:var(--text-muted)">${s.type === 'Expense' ? `${Math.round(parseFloat(s.duration)||1)} qty` : `${(parseFloat(s.duration)||0).toFixed(1)} hr`} · $${bill.toFixed(2)} · ${s.status}</span>
      <button class="btn btn-sm btn-ghost" onclick="goToEntry(${s.id})">Go to ↗</button>
    </div>
  </div>`;
}

// ── Sidebar actions ───────────────────────────────────────────────────────

function goToEntry(entryId) {
  const inReview = document.getElementById('sec-review')?.classList.contains('active');

  if (inReview) {
    // Stay in Review tab — swap sidebar content and scroll+pulse the Review row.
    openConflictSidebar(entryId);
    setTimeout(() => {
      const row = document.querySelector(`#reviewGroups tr[data-id="${entryId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _pulseRowSalmon(row);
      }
    }, 50);
  } else {
    // Capture tab — switch if needed, swap sidebar, scroll+pulse staging row.
    const captureSection = document.getElementById('sec-capture');
    const isInCapture = captureSection && captureSection.classList.contains('active');
    if (!isInCapture) switchSection('capture');

    openConflictSidebar(entryId);

    setTimeout(() => {
      const row = document.querySelector(`#stagingBody tr[data-id="${entryId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _pulseRow(row);
      }
    }, isInCapture ? 50 : 150);
  }
}

// ── Related Entries hover tooltip ─────────────────────────────────────────
// Shows the full untruncated description of a related entry card on hover.
// The tooltip element is created once and reused; positioned to the left of
// the sidebar, vertically centred on the hovered card.

function _showRelTooltip(cardEl) {
  const text = cardEl.dataset.fulldesc;
  if (!text || !text.trim()) return;

  let tip = document.getElementById('_relTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = '_relTooltip';
    tip.style.cssText = [
      'position:fixed',
      'z-index:2000',
      'background:#1a3a5c',
      'color:#fff',
      'font-size:12px',
      'line-height:1.5',
      'padding:8px 12px',
      'border-radius:6px',
      'max-width:320px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.28)',
      'pointer-events:none',
      'white-space:pre-wrap',
      'word-break:break-word',
    ].join(';');
    document.body.appendChild(tip);
  }

  tip.textContent = text;

  // Measure off-screen to get real height before final placement.
  tip.style.left = '-9999px';
  tip.style.top  = '0px';
  tip.style.display = 'block';

  const tipH = tip.offsetHeight;
  const tipW = tip.offsetWidth;

  const cardRect = cardEl.getBoundingClientRect();
  const sb       = document.getElementById('conflictSidebar');
  const sbRect   = sb ? sb.getBoundingClientRect() : cardRect;

  // Prefer left of sidebar; fall back to overlapping sidebar top-of-card if screen too narrow.
  let left = sbRect.left - tipW - 12;
  if (left < 10) left = Math.max(10, cardRect.left - tipW - 6);
  if (left < 10) left = 10;  // last resort

  // Vertically centre on the hovered card, clamped to viewport.
  let top = cardRect.top + (cardRect.height / 2) - (tipH / 2);
  top = Math.max(10, Math.min(top, window.innerHeight - tipH - 10));

  tip.style.left = left + 'px';
  tip.style.top  = top  + 'px';
}

function _hideRelTooltip() {
  const tip = document.getElementById('_relTooltip');
  if (tip) tip.style.display = 'none';
}

function markAsDifferent(entryId) {
  _clioIgnoreIds.add(entryId);
  try { localStorage.setItem('ar_baseline_dismissed', JSON.stringify([..._clioIgnoreIds])); } catch (_) {}
  _scheduleSort(entryId); // timer set before render — entry is no longer "In Clio"
  renderStagingTable();
  _renderSidebarContent(entryId);
}

// Quick-action checkmark on Already in Clio rows in the Capture table:
// dismisses the Clio match AND sets status to Ready in one click, no sidebar needed.
async function captureClioMarkReady(entryId) {
  if (_approveInProgress.has(entryId)) return;
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;

  _approveInProgress.add(entryId);
  const prevStatus = e.status;

  // Dismiss the Clio match locally and persist to localStorage
  _clioIgnoreIds.add(entryId);
  try { localStorage.setItem('ar_baseline_dismissed', JSON.stringify([..._clioIgnoreIds])); } catch (_) {}

  // Optimistic status update — schedule sort before render so dividers stay suppressed
  e.status = 'Ready';
  _scheduleSort(entryId); // timer set before render
  renderStagingTable();
  if (_sidebarId === entryId) _renderSidebarContent(entryId);

  try {
    const updated = await api('PUT', `/api/entries/${entryId}`, { status: 'Ready' });
    Object.assign(e, updated);
    refreshBanner();
    _showSimpleToast('Marked as different — entry is Ready.');
    if (_sidebarId === entryId) _renderSidebarContent(entryId);
  } catch (err) {
    // Roll back both the status and the Clio dismissal
    e.status = prevStatus;
    _clioIgnoreIds.delete(entryId);
    try { localStorage.setItem('ar_baseline_dismissed', JSON.stringify([..._clioIgnoreIds])); } catch (_) {}
    _cancelScheduledSort();
    renderStagingTable();
    console.error('[captureClioMarkReady] failed — rolled back', err);
  } finally {
    _approveInProgress.delete(entryId);
  }
}

// ↑ Find — scrolls the staging table to the currently open sidebar entry and pulses it.
// Always works from any tab or scroll position; sidebar stays open.
function sidebarGoToEntry() {
  if (_sidebarId === null) return;
  const inReview = document.getElementById('sec-review')?.classList.contains('active');

  if (inReview) {
    // Review tab: scroll the matter group table to this entry
    const row = document.querySelector(`#reviewGroups tr[data-id="${_sidebarId}"]`);
    if (!row) {
      _showSimpleToast('Entry not visible in Review — it may be filtered or not yet rendered.');
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    _pulseRowSalmon(row);
  } else {
    // Capture tab (default): scroll the staging table to this entry
    const row = document.querySelector(`#stagingBody tr[data-id="${_sidebarId}"]`);
    if (!row) {
      _showSimpleToast('Entry not visible — check the Capture tab or clear any active search filter.');
      return;
    }
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    _pulseRowSalmon(row);
  }
}

// Route all sidebar deletes through the inline confirmation footer.
function deleteEntryFromSidebar(entryId) {
  _showDeleteConfirm(entryId);
}

// Replace footer with "Delete this entry? Confirm | Cancel" — auto-cancels after 3 s.
function _showDeleteConfirm(entryId) {
  const footer = document.getElementById('conflictSidebarFooter');
  if (!footer) return;
  if (_deleteConfirmTimer) { clearTimeout(_deleteConfirmTimer); _deleteConfirmTimer = null; }
  footer.innerHTML = `
    <span class="sb-delete-confirm-text">Delete this entry?</span>
    <div style="display:flex;gap:6px;flex-shrink:0">
      <button class="sb-delete-confirm-btn" onclick="_confirmDeleteEntry(${entryId})">Confirm</button>
      <button class="sb-delete-cancel-btn"  onclick="_cancelDeleteConfirm()">Cancel</button>
    </div>`;
  _deleteConfirmTimer = setTimeout(() => _cancelDeleteConfirm(), 5000);
}

// Restore default delete button without performing a delete.
function _cancelDeleteConfirm() {
  if (_deleteConfirmTimer) { clearTimeout(_deleteConfirmTimer); _deleteConfirmTimer = null; }
  const footer = document.getElementById('conflictSidebarFooter');
  if (!footer || _sidebarId === null) return;
  footer.innerHTML = `
    <button class="sb-copy-btn" onclick="_copyEntryToClipboard(${_sidebarId})" title="Copy entry details to clipboard">⧉ Copy</button>
    <button class="sb-delete-btn" onclick="_showDeleteConfirm(${_sidebarId})">🗑 Delete Entry</button>`;
}

// Perform the delete after confirmation.
function _confirmDeleteEntry(entryId) {
  hideDescTooltip(); // dismiss before sidebar closes and row is removed
  if (_deleteConfirmTimer) { clearTimeout(_deleteConfirmTimer); _deleteConfirmTimer = null; }
  closeConflictSidebar();
  const entry = stagingEntries.find(x => x.id === entryId);
  if (entry) _softDelete(entry);
}

// Edit in Capture — closes sidebar, jumps to Capture tab, scrolls & pulses row blue, reopens sidebar
// Navigate from Review sidebar → Capture tab keeping the sidebar open.
// Sets _sidebarOrigin so the sidebar shows "Return to Review ↗" while in Capture.
function editInCapture(entryId) {
  _sidebarOrigin = 'review'; // must be set before re-render so button updates correctly

  // Switch to Capture tab (sidebar stays open — no close/reopen cycle)
  const captureBtn = document.querySelector('.nav-tab[data-section="capture"]');
  if (captureBtn && !captureBtn.classList.contains('active')) captureBtn.click();

  // Give the tab render one frame to settle, then scroll + pulse + update sidebar button
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const row = document.querySelector(`#stagingBody tr[data-id="${entryId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _pulseRow(row); // amber pulse — entry is already highlighted blue by sb-active-row
      }
      // Re-render sidebar content now that Capture is active — flips button to "Return to Review ↗"
      _renderSidebarContent(entryId);
    });
  });
}

// Navigate from Capture sidebar → Review tab keeping the sidebar open.
// Clears _sidebarOrigin so the sidebar shows "Edit in Capture ↗" while in Review.
function returnToReview(entryId) {
  _sidebarOrigin = null;

  // Switch to Review tab — this calls renderReview() internally
  switchSection('review');

  // After Review renders, scroll to the entry row and pulse it
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const row = document.querySelector(`#sec-review tr[data-id="${entryId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.remove('pulse-blue');
        void row.offsetWidth;
        row.classList.add('pulse-blue');
        row.addEventListener('animationend', () => row.classList.remove('pulse-blue'), { once: true });
      }
      // Re-render sidebar content now that Review is active — flips button back to "Edit in Capture ↗"
      _renderSidebarContent(entryId);
    });
  });
}

// ── APPROVE TOAST (Fix #4) ────────────────────────────────────────────────

function _showApproveToast(entry, prevStatus) {
  const area = document.getElementById('approveToastArea');
  if (!area) return;
  const toastId = 'at_' + Date.now();
  const div = document.createElement('div');
  div.id = toastId;
  div.className = 'approve-toast';
  div.innerHTML = `
    <span>✓ Approved — ${(entry.matter || 'entry').replace(/</g,'&lt;')}</span>
    <button class="toast-undo-btn" onclick="_undoApprove('${toastId}',${entry.id},'${prevStatus}')">Undo</button>
    <button class="toast-dismiss-btn" onclick="_dismissApproveToast('${toastId}')" title="Dismiss">×</button>
    <div class="approve-progress"></div>`;
  area.appendChild(div);
  const timerId = setTimeout(() => _dismissApproveToast(toastId), 5000);
  _approveUndoTimers.set(toastId, { timerId, entryId: entry.id, prevStatus });
}

async function _undoApprove(toastId, entryId, prevStatus) {
  const item = _approveUndoTimers.get(toastId);
  if (item) { clearTimeout(item.timerId); _approveUndoTimers.delete(toastId); }
  _dismissApproveToast(toastId);
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;
  const updated = await api('PUT', `/api/entries/${entryId}`, { status: prevStatus });
  Object.assign(e, updated);
  renderStagingTable();
  refreshBanner();
}

function _dismissApproveToast(toastId) {
  document.getElementById(toastId)?.remove();
  const item = _approveUndoTimers.get(toastId);
  if (item) { clearTimeout(item.timerId); _approveUndoTimers.delete(toastId); }
}

// Sidebar Unapprove — sets entry back to Ready from sidebar header button.
// No undo toast needed: the sidebar's ✓ Approve button is the persistent re-approve path.
async function sidebarUnapprove(id) {
  if (_approveInProgress.has(id)) return;
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  _approveInProgress.add(id);
  // Optimistic update — immediately reflect Ready so button swaps before API returns.
  e.status = 'Ready';
  _scheduleSort(id); // timer set before render — suppresses dividers during animation window
  renderStagingTable();
  if (_sidebarId === id) _renderSidebarContent(id);

  try {
    const updated = await api('PUT', `/api/entries/${id}`, { status: 'Ready' });
    Object.assign(e, updated);
    refreshBanner();
    if (_sidebarId === id) _renderSidebarContent(id);
    _showSimpleToast('Entry unapproved — set back to Ready.');
  } catch (err) {
    e.status = 'Approved'; // roll back
    _cancelScheduledSort();
    renderStagingTable();
    if (_sidebarId === id) _renderSidebarContent(id);
    console.error('[sidebarUnapprove] API call failed — rolled back status for entry', id, err);
  } finally {
    _approveInProgress.delete(id);
  }
}

// Lightweight informational toast — no undo. ms controls auto-dismiss (default 5 s).
function _showSimpleToast(msg, ms = 5000) {
  const area = document.getElementById('approveToastArea');
  if (!area) return;
  const toastId = 'st_' + Date.now();
  const div = document.createElement('div');
  div.id = toastId;
  div.className = 'simple-toast';
  div.innerHTML = `<span>${msg.replace(/</g, '&lt;')}</span>
    <button class="toast-dismiss-btn" onclick="this.closest('.simple-toast').remove()" title="Dismiss">×</button>`;
  area.appendChild(div);
  setTimeout(() => document.getElementById(toastId)?.remove(), ms);
}

// ── FOLLOW-ENTRY INDICATOR (Fix #5) ──────────────────────────────────────

function _showFollowIndicator(entryId, durationMs = 5000) {
  const indicator = document.getElementById('followEntryIndicator');
  if (!indicator) return;

  // Show matter/client context in the label
  const e = stagingEntries.find(x => x.id === entryId);
  const label = indicator.querySelector('.follow-label');
  if (label) {
    label.textContent = e ? `${e.matter || '—'} · ${e.client || '—'}` : 'Entry moved';
  }

  const btn = document.getElementById('followEntryBtn');
  if (btn) {
    btn.onclick = () => {
      const row = document.querySelector(`tr[data-id="${entryId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _pulseRow(row);
      }
      _hideFollowIndicator();
    };
  }
  indicator.style.display = 'flex';
  clearTimeout(_followIndicatorTimer);
  _followIndicatorTimer = setTimeout(_hideFollowIndicator, durationMs);
}

function _hideFollowIndicator() {
  const indicator = document.getElementById('followEntryIndicator');
  if (indicator) indicator.style.display = 'none';
  clearTimeout(_followIndicatorTimer);
  _followIndicatorTimer = null;
}

// ── SORT SCHEDULER ────────────────────────────────────────────────────────
// Used by every explicit status-change action (Quick Ready, status dropdown, Unapprove, etc.).
// Field edits (matter, description, date, duration, rate) NEVER call this — they stay frozen.
//
// Pattern:
//   1. Immediately show the follow indicator so the user knows movement is imminent.
//   2. After 800ms: clear the frozen sort order, re-sort, pulse the entry salmon at its new position.
//
// Only one sort can be scheduled at a time. A second call cancels the first (rare edge case:
// two status changes within 800ms — the first entry's position will remain frozen until the
// user triggers an explicit column-header sort).

function _scheduleSort(id, indicatorMs = 5000) {
  clearTimeout(_sortScheduleTimer);
  _showFollowIndicator(id, indicatorMs); // pre-emptive: user sees movement is coming before it happens
  _sortScheduleTimer = setTimeout(() => {
    _sortScheduleTimer = null;
    // Never release the frozen order while a clone is still being edited — the locked entry
    // must stay in place until its own Done button clears the lock.
    if (_editingLocks.size === 0) _frozenSortOrder = null;
    renderStagingTable();
    // Pulse the entry at its newly sorted position after renderStagingTable's own RAF settles
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = document.querySelector(`#stagingBody tr[data-id="${id}"]`);
      if (row) _pulseRowSalmon(row);
    }));
  }, 800);
}

// Roll back a scheduled sort (called on API failure after an optimistic status change).
// Cancels the pending movement and hides the pre-emptive follow indicator.
function _cancelScheduledSort() {
  clearTimeout(_sortScheduleTimer);
  _sortScheduleTimer = null;
  _hideFollowIndicator();
}

// ── VALIDATION FLAG ACTIONS ────────────────────────────────────────────────

// Dismiss a specific flag for an entry (user has consciously reviewed it)
function vfDismissFlag(entryId, flagType) {
  _vfDismissed.add(`${entryId}:${flagType}`);
  // CONF_RISK dismissals are persisted to localStorage so they survive page refreshes.
  // The dismissal is keyed by description hash — if the description changes later,
  // the hash won't match and the flag can re-trigger on the updated text.
  if (flagType === 'CONF_RISK') {
    const e = stagingEntries.find(x => x.id === entryId);
    if (e) _persistDismissedConfrisk(entryId, e.description);
  }
  _vfPreview     = null;
  _focusFlagType = null;
  _runValidation();
  _injectValidationBadges();
  if (_sidebarId === entryId) _renderSidebarContent(entryId);
}

// Discard a pending AI suggestion without applying it
function vfDismissPreview() {
  _vfPreview = null;
  if (_sidebarId !== null) _renderSidebarContent(_sidebarId);
}

// AI Compress — send description to /api/ai/compress-description
async function vfCompress(entryId) {
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;
  const btn = document.getElementById('vfCompressBtn');
  if (btn) { btn.textContent = '⟳ Compressing…'; btn.disabled = true; }
  try {
    const { compressed } = await api('POST', '/api/ai/compress-description', { description: e.description });
    _vfPreview = { id: entryId, type: 'LONG_DESC', field: 'description', value: compressed };
    _renderSidebarContent(entryId);
  } catch (err) {
    if (btn) { btn.textContent = 'AI Compress'; btn.disabled = false; }
    alert('Compress failed: ' + err.message);
  }
}

// AI Scrub — send description to /api/ai/scrub-description
async function vfScrub(entryId, surname) {
  const e = stagingEntries.find(x => x.id === entryId);
  if (!e) return;
  try {
    const { scrubbed } = await api('POST', '/api/ai/scrub-description', { description: e.description, surname });
    _vfPreview = { id: entryId, type: 'CONF_RISK', field: 'description', value: scrubbed };
    _renderSidebarContent(entryId);
  } catch (err) {
    alert('Scrub failed: ' + err.message);
  }
}

// Accept a pending AI suggestion — applies it via updateEntry
async function vfAccept(entryId, field) {
  if (!_vfPreview || _vfPreview.id !== entryId || _vfPreview.field !== field) return;
  const value = _vfPreview.value;
  _vfPreview     = null;
  _focusFlagType = null;
  // updateEntry re-renders the table and re-runs validation — sidebar stays open
  await updateEntry(entryId, field, value);
}

// Reassign to Davidson — moves entry to the Davidson Internal matter
async function vfReassignToDavidson(entryId, davidsonNum) {
  _vfDismissed.add(`${entryId}:DAVIDSON_REVIEW`);
  _focusFlagType = null;
  await updateEntry(entryId, 'matter', davidsonNum);
  // updateEntry triggers renderStagingTable which re-runs validation
}

// Mark as Timed — changes category from Notes — Estimated to Notes — Timed
async function vfMarkTimed(entryId) {
  _vfDismissed.add(`${entryId}:EST_TIME`);
  _focusFlagType = null;
  await updateEntry(entryId, 'category', 'Notes — Timed');
  // updateEntry triggers renderStagingTable which re-runs validation and re-renders sidebar
}

// ── SOURCE PILL ────────────────────────────────────────────────────────────
const SOURCE_PILL_CONFIG = {
  panel_a:  { label: 'Panel A',   color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
  panel_b:  { label: 'Panel B',   color: '#0f766e', bg: '#f0fdfa', border: '#99f6e4' },
  manual:   { label: 'Quick Add', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
  wisetime: { label: 'WiseTime',  color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  notabill: { label: 'NotaBill',  color: '#6d28d9', bg: '#faf5ff', border: '#ddd6fe' },
  split:    { label: 'Split',     color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  call_log: { label: 'Call Log',  color: '#991b1b', bg: '#fef2f2', border: '#fecaca' },
  cloned:   { label: 'Cloned',    color: '#374151', bg: '#f9fafb', border: '#e5e7eb' },
};
function _sourcePill(source) {
  const c = SOURCE_PILL_CONFIG[source] || { label: source || '—', color: '#374151', bg: '#f9fafb', border: '#e5e7eb' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap;color:${c.color};background:${c.bg};border:1px solid ${c.border}">${c.label}</span>`;
}

// Source sort order (for grouping by input channel)
const SOURCE_SORT_ORDER = { panel_a: 0, panel_b: 1, manual: 2, wisetime: 3, notabill: 4, split: 5, call_log: 6, cloned: 7 };

// ── CONF RISK DISMISSED FLAG PERSISTENCE ──────────────────────────────────
// Dismissed CONF_RISK flags survive page refreshes via localStorage.
// Each dismissal is keyed by entryId + a hash of the description at dismissal time.
// If the description later changes, the hash won't match and the flag can re-trigger.

const _VF_CR_DISMISSED_KEY = 'ar_conf_risk_dismissed';

// Lightweight deterministic hash (djb2) — used to fingerprint descriptions.
function _strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// Called once in init() after stagingEntries is populated.
// Repopulates _vfDismissed for any CONF_RISK entries whose description hasn't changed.
// Removes stale records (entries deleted or description changed).
function _loadDismissedConfriskFlags() {
  try {
    const stored = JSON.parse(localStorage.getItem(_VF_CR_DISMISSED_KEY) || '{}');
    const stale = [];
    for (const [idStr, hash] of Object.entries(stored)) {
      const id = parseInt(idStr, 10);
      const e = stagingEntries.find(x => x.id === id);
      if (!e) { stale.push(idStr); continue; } // entry deleted — remove
      if (_strHash(e.description || '') === hash) {
        _vfDismissed.add(`${id}:CONF_RISK`); // restore dismissal
      } else {
        stale.push(idStr); // description changed — allow re-detection
      }
    }
    if (stale.length) {
      stale.forEach(k => delete stored[k]);
      localStorage.setItem(_VF_CR_DISMISSED_KEY, JSON.stringify(stored));
    }
  } catch { /* ignore storage errors */ }
}

// Persist a CONF_RISK dismissal: entryId → hash of description at time of dismissal.
function _persistDismissedConfrisk(entryId, description) {
  try {
    const stored = JSON.parse(localStorage.getItem(_VF_CR_DISMISSED_KEY) || '{}');
    stored[String(entryId)] = _strHash(description || '');
    localStorage.setItem(_VF_CR_DISMISSED_KEY, JSON.stringify(stored));
  } catch { /* ignore */ }
}

// Remove the CONF_RISK dismissal for an entry when its description is saved.
// Allows legitimate re-detection if the new description still contains a foreign surname.
function _clearDismissedConfrisk(entryId) {
  try {
    const stored = JSON.parse(localStorage.getItem(_VF_CR_DISMISSED_KEY) || '{}');
    if (String(entryId) in stored) {
      delete stored[String(entryId)];
      localStorage.setItem(_VF_CR_DISMISSED_KEY, JSON.stringify(stored));
    }
  } catch { /* ignore */ }
}

// ── REAL-TIME VALIDATION ──────────────────────────────────────────────────

// Runs four client-side advisory checks across all staging entries.
// Updates _validationFlags map — does NOT modify any entry fields.
function _runValidation() {
  const clientSurnames = _getClientSurnames();
  const newFlags = new Map();

  for (const e of stagingEntries) {
    const isApproved = e.status === 'Approved';
    const flags = [];
    const desc  = e.description || '';
    const key   = type => `${e.id}:${type}`;

    // 1. LONG_DESC — description exceeds 80 characters.
    //    Skipped for Approved entries (user signed off on length).
    if (!isApproved && desc.length > 80 && !_vfDismissed.has(key('LONG_DESC'))) {
      flags.push({ type: 'LONG_DESC' });
    }

    // 2. CONF_RISK — description references another client's surname.
    //    Checked on ALL entries including Approved — confidentiality cannot be waived by approval.
    //    Auto-downgrade to Needs Review is handled by _applyConfRiskDowngrades() below.
    if (!_vfDismissed.has(key('CONF_RISK'))) {
      const matchedSurnames = [];
      for (const { matter, surname } of clientSurnames) {
        if (matter === e.matter) continue; // own matter — not a cross-ref
        const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = new RegExp(`\\b${escaped}\\b`, 'i');
        if (rx.test(desc)) matchedSurnames.push(surname);
      }
      if (matchedSurnames.length > 0) {
        flags.push({ type: 'CONF_RISK', surnames: matchedSurnames });
      }
    }

    // 3. DAVIDSON_REVIEW — non-Davidson entry mentioning internal firm keywords.
    //    Skipped for Approved entries.
    const isDavidsonMatter = (e.matter || '').toLowerCase().includes('davidson');
    if (!isApproved && !isDavidsonMatter && !_vfDismissed.has(key('DAVIDSON_REVIEW')) && desc.length > 0) {
      const internalKw = /wakulla|\blead call\b|\bfirm intake\b|\bintake\b|\bleads\b|\bfirm insurance\b|\bbusiness insurance\b|\boffice rent\b|\bfirm admin\b|\bfirm operations\b|\binternal firm\b/i;
      if (internalKw.test(desc)) {
        flags.push({ type: 'DAVIDSON_REVIEW' });
      }
    }

    // 4. EST_TIME — category is Notes — Estimated.
    //    Skipped for Approved entries.
    if (!isApproved && e.category === 'Notes — Estimated' && !_vfDismissed.has(key('EST_TIME'))) {
      flags.push({ type: 'EST_TIME' });
    }

    if (flags.length) newFlags.set(e.id, flags);
  }

  _validationFlags = newFlags;

  // Auto-downgrade any Ready/Approved entries that now have an active CONF_RISK flag.
  _applyConfRiskDowngrades();
}

// Downgrade entries with an active CONF_RISK flag from Ready/Approved → Needs Review.
// Runs synchronously (memory update) then fires async API persists and a deferred re-render.
// Called at the end of every _runValidation() pass.
// _confRiskDowngradedThisSession gates repeat fires — each entry is only downgraded once per
// session, preventing multiple toasts and redundant API calls on subsequent render passes.
function _applyConfRiskDowngrades() {
  const toDowngrade = [];
  for (const [id, flags] of _validationFlags) {
    if (!flags.some(f => f.type === 'CONF_RISK')) continue;
    if (_confRiskDowngradedThisSession.has(id)) continue; // already handled this session
    const e = stagingEntries.find(x => x.id === id);
    if (!e) continue;
    if (e.status !== 'Ready' && e.status !== 'Approved') continue; // already Needs Review or other
    toDowngrade.push(e);
  }
  if (toDowngrade.length === 0) return;

  // Optimistic memory update — prevents re-triggering on the next render pass.
  for (const e of toDowngrade) {
    e.status = 'Needs Review';
    _confRiskDowngradedThisSession.add(e.id); // prevent repeat downgrade on next validation pass
  }

  // Show a single one-time toast for the whole batch.
  const n = toDowngrade.length;
  _showSimpleToast(
    n === 1
      ? '1 entry downgraded to Needs Review due to Confidentiality Risk.'
      : `${n} entries downgraded to Needs Review due to Confidentiality Risk flags.`
  );

  // Persist to SQLite (fire-and-forget — memory already updated).
  for (const e of toDowngrade) {
    api('PUT', `/api/entries/${e.id}`, { status: 'Needs Review' }).catch(err =>
      console.error('[confRiskDowngrade] persist failed for entry', e.id, err)
    );
  }

  // Defer re-render until the current renderStagingTable call stack unwinds,
  // preventing recursive calls through _runValidation → _applyConfRiskDowngrades.
  setTimeout(() => {
    renderStagingTable();
    refreshBanner();
    if (_sidebarId !== null) _renderSidebarContent(_sidebarId);
  }, 0);
}

// Injects validation badge elements into already-rendered staging table rows.
// Called inside requestAnimationFrame after tbody.innerHTML is set.
function _injectValidationBadges() {
  // Clear flag class from all rows before re-evaluating which rows have active flags
  document.querySelectorAll('tr.row-has-flags').forEach(r => r.classList.remove('row-has-flags'));

  for (const [id, flags] of _validationFlags) {
    // Approved entries never show validation flags in the Capture table —
    // the entry has been reviewed and approved; flags are no longer actionable.
    const entry = stagingEntries.find(e => e.id === id);
    if (entry && entry.status === 'Approved') continue;

    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (!row) continue;
    const statusCell = row.querySelector('.status-cell');
    if (!statusCell) continue;

    // Mark the row as having active flags (used for Ready row background tint)
    if (flags.length > 0) row.classList.add('row-has-flags');

    // Remove any previously injected vf-badges before re-injecting
    statusCell.querySelectorAll('.vf-badge').forEach(b => b.remove());

    const select = statusCell.querySelector('select');
    for (const flag of flags) {
      const badge = document.createElement('span');
      badge.className = 'badge vf-badge';
      badge.addEventListener('click', ev => {
        ev.stopPropagation();
        _openVFSidebar(id, flag.type);
      });

      switch (flag.type) {
        case 'LONG_DESC': {
          const len = (stagingEntries.find(e => e.id === id) || {}).description?.length || 0;
          badge.classList.add('vf-long-desc');
          badge.textContent = 'Long Desc';
          badge.title = `Description is ${len} chars — max 80. Click for AI compress.`;
          break;
        }
        case 'CONF_RISK': {
          badge.classList.add('vf-conf-risk');
          const surnameList = (flag.surnames || [flag.surname]).filter(Boolean);
          badge.textContent = surnameList.length > 1 ? `Conf. Risk (${surnameList.length})` : 'Conf. Risk';
          badge.title = `Description may reference ${surnameList.map(s => `"${s}"`).join(', ')} (another client). Click to review.`;
          break;
        }
        case 'DAVIDSON_REVIEW':
          badge.classList.add('vf-davidson');
          badge.textContent = 'Davidson?';
          badge.title = 'Davidson matter: description appears client-focused — no internal firm keywords found. Click to review or reassign.';
          break;
        case 'EST_TIME':
          badge.classList.add('vf-est-time');
          badge.textContent = 'Est. Time';
          badge.title = 'Category is Notes — Estimated. Verify actual duration before export.';
          break;
      }

      // Insert before the status select so badges appear to its left
      if (select) statusCell.insertBefore(badge, select);
      else statusCell.appendChild(badge);
    }
  }
}

// Open sidebar for a specific validation flag (badge was clicked)
function _openVFSidebar(entryId, flagType) {
  _focusFlagType = flagType;
  openConflictSidebar(entryId);
}

// ── STAGING TABLE ──────────────────────────────────────────────────────────
function renderStagingTable() {
  hideDescTooltip(); // always dismiss before any DOM manipulation — prevents dangling tooltips
  const tbody = document.getElementById('stagingBody');

  // ── Render sortable thead ────────────────────────────────────────────────
  const thead = document.getElementById('stagingHead');
  if (thead) {
    const arrow = f => `<span style="margin-left:3px;font-size:9px;opacity:${_sortField===f?1:0.22}">${_sortField===f&&_sortDir==='desc'?'▼':'▲'}</span>`;
    const sh    = (label, f) => `<th style="cursor:pointer;user-select:none;white-space:nowrap" onclick="setSort('${f}')">${label}${arrow(f)}</th>`;
    thead.innerHTML = `<tr>
      <th style="width:32px"></th>
      ${sh('Matter #','matter')}
      ${sh('Client','client')}
      ${sh('Date','date')}
      <th>Qty/Dur</th>
      <th>Description / Vendor</th>
      ${sh('Category','category')}
      ${sh('Source','source')}
      ${sh('Type','type')}
      ${sh('Rate/Price','rate')}
      ${sh('Billable','billable')}
      ${sh('Status','status')}
      <th style="min-width:112px;width:112px"></th>
    </tr>`;
  }

  if (!stagingEntries.length) {
    tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:24px">No entries yet — use the panels above to capture time entries</td></tr>';
    updateSummary();
    _updateSearchUI();
    return;
  }

  const dupeIds = getDuplicateIds();
  const clioIds = getClioMatchIds();
  const sorted  = sortEntries(stagingEntries);

  // Freeze the visual order immediately after computing it.
  // _frozenSortOrder is null only right after setSort() clears it (user clicked a column header).
  // All other renderStagingTable() calls (edits, status changes, quick-ready, clone, etc.) find
  // _frozenSortOrder already set and go through the frozen path in sortEntries() — so nothing moves.
  if (_frozenSortOrder === null) {
    _frozenSortOrder = sorted.map(e => e.id);
  }

  // Apply search filter — ONLY in isolation mode (Mode 2). Dropdown mode (Mode 1) leaves table unchanged.
  const q = (_searchMode === 'isolation' ? _searchQuery : '').toLowerCase().trim();
  const visible = q
    ? sorted.filter(e =>
        (e.matter      || '').toLowerCase().includes(q) ||
        (e.client      || '').toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q) ||
        _matchesDate(e.date, q)                          ||
        (e.category    || '').toLowerCase().includes(q) ||
        (e.source      || '').toLowerCase().includes(q) ||
        (e.status      || '').toLowerCase().includes(q)
      )
    : sorted;

  if (visible.length === 0 && q) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:24px">No entries match "${q.replace(/</g,'&lt;')}"</td></tr>`;
    updateSummary(0);
    _updateSearchUI(0, stagingEntries.length);
    return;
  }

  const _statusRows = visible.map(e => {
    // Flag whether the description text itself matched the search term
    const descMatches = q && (e.description || '').toLowerCase().includes(q);
    // Time: duration(hrs) × rate($/hr). Expense: duration(qty) × rate($/unit). Formula is identical.
    const billable  = (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0);
    const isDupe    = dupeIds.has(e.id);
    const isInClio  = clioIds.has(e.id);
    const isReview  = e.status === 'Needs Review';
    const isWiseTime = e.source === 'wisetime';
    const isCloned   = e.source === 'cloned';
    const isSplit    = e.source === 'split';
    const isCallLog  = e.source === 'call_log';

    const isEditLocked = _editingLocks.has(e.id);
    const rowClass = (isDupe ? 'duplicate' : isInClio ? 'clio-match' : (isReview ? 'needs-review' : (e.status === 'Approved' ? 'approved' : (e.status === 'Ready' ? 'ready' : ''))))
      + (isEditLocked ? ' editing-locked' : '');

    const matterOpts = matters.filter(m => m.active).map(m =>
      `<option value="${m.num}" ${m.num === e.matter ? 'selected' : ''}>${m.num}</option>`
    ).join('');
    const catOpts = ACTIVITY_CATEGORIES.map(c =>
      `<option ${c === e.category ? 'selected' : ''}>${c}</option>`
    ).join('');

    const statusClass = e.status === 'Needs Review' ? 's-needs-review' : e.status === 'Approved' ? 's-approved' : 's-ready';
    const statusSelect = `<select class="status-select ${statusClass}" onchange="updateEntry(${e.id},'status',this.value)">
      <option value="Ready"        ${e.status === 'Ready'        ? 'selected' : ''}>Ready</option>
      <option value="Needs Review" ${e.status === 'Needs Review' ? 'selected' : ''}>Needs Review</option>
      <option value="Approved"     ${e.status === 'Approved'     ? 'selected' : ''}>Approved</option>
    </select>`;
    const isCallNotes = _callNotesIds.has(e.id);
    let systemFlags = '';
    if (isDupe)        systemFlags += '<span class="badge badge-duplicate" title="Probable Duplicate — click row for details">Duplicate</span>';
    if (isInClio)      systemFlags += '<span class="badge badge-clio" title="Matches a Clio baseline entry — click row for details">Already in Clio</span>';
    if (isCallNotes)   systemFlags += '<span class="badge badge-callnotes" title="A related phone call exists in the Clio baseline for this matter and date — advisory only, no action required">Call + Notes</span>';
    if (isWiseTime)    systemFlags += '<span class="badge badge-wisetime" title="WiseTime entry — advisory only">WiseTime</span>';
    if (isCloned)      systemFlags += '<span class="badge badge-wisetime" title="Cloned from an Approved entry — review before export">Cloned</span>';
    if (isCallLog)     systemFlags += '<span class="badge badge-error" title="Possible call log — VXT may have already logged this call">Call Log</span>';
    const statusBadge     = `<div class="status-cell">${systemFlags}${statusSelect}</div>`;
    const isApproved      = e.status === 'Approved';
    const isNR            = e.status === 'Needs Review';
    const isReady         = e.status === 'Ready';
    const isHoverable     = isDupe || isReview || isSplit;
    // Check for blocking Conf Risk flag — prevents NR quick-ready in the table
    const hasConfRisk     = (_validationFlags.get(e.id) || []).some(f => f.type === 'CONF_RISK');

    return `<tr class="${rowClass}" data-id="${e.id}" data-matter="${e.matter||''}" data-date="${e.date||''}"
      style="cursor:pointer"
      onclick="rowClick(event,${e.id})"
      onmouseenter="highlightConflicts(this,${isHoverable})"
      onmouseleave="clearConflictHighlights()">
      <td class="row-drag" title="Drag to reorder">⋮⋮</td>
      <td><select onchange="updateEntry(${e.id},'matter',this.value)" style="min-width:130px">
        <option value="">-- None --</option>${matterOpts}
      </select></td>
      <td style="font-size:12px;color:var(--text-muted);white-space:nowrap">${e.client || '—'}</td>
      <td><input type="date" value="${e.date}" onchange="updateEntry(${e.id},'date',this.value)" style="min-width:120px" /></td>
      <td style="white-space:nowrap">${e.type === 'Expense'
        ? `<input type="number" value="${Math.round(parseFloat(e.duration)||1)}" step="1" min="1"
             onchange="updateEntry(${e.id},'duration',Math.max(1,parseInt(this.value)||1))"
             style="width:52px" /><span style="font-size:11px;color:var(--text-muted);margin-left:3px">qty</span>`
        : `<input type="number" value="${e.duration}" step="0.1" min="0.1"
             onchange="updateEntry(${e.id},'duration',parseFloat(this.value))"
             style="width:60px" />`}</td>
      <td data-entry-id="${e.id}" class="${descMatches ? 'search-desc-match' : ''}" onmouseenter="showDescTooltip(this)" onmouseleave="hideDescTooltip()">
        <textarea class="desc-ta"
          onchange="updateEntry(${e.id},'description',this.value)"
          ondblclick="openDescPopup(event,${e.id})"
          oninput="_descAutoResizeDebounced(this)"
          onmousedown="event.stopPropagation()"
          onmousemove="event.stopPropagation()"
        >${(e.description || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
        ${e.type === 'Expense' && (e.vendor_name || '').trim() ? `<div class="expense-vendor-label">Vendor: ${(e.vendor_name).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>` : ''}
      </td>
      <td class="cat-cell"><select onchange="updateEntry(${e.id},'category',this.value)" style="min-width:130px">${catOpts}</select></td>
      <td style="white-space:nowrap;text-align:center">${_sourcePill(e.source)}</td>
      <td style="white-space:nowrap"><select onchange="updateEntry(${e.id},'type',this.value)" style="min-width:82px">
        <option ${e.type === 'Time' ? 'selected' : ''}>Time</option>
        <option ${e.type === 'Expense' ? 'selected' : ''}>Expense</option>
      </select></td>
      <td style="white-space:nowrap;padding:7px 10px">$<input type="number" value="${e.rate}" onchange="updateEntry(${e.id},'rate',parseFloat(this.value))" style="width:68px" /></td>
      <td style="font-weight:600">$${billable.toFixed(2)}</td>
      <td>${statusBadge}</td>
      <td style="white-space:nowrap">
        ${isEditLocked
          ? `<button class="btn btn-sm"
                onclick="event.stopPropagation(); commitEditingLock(${e.id})"
                style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;font-size:11px;padding:2px 7px"
                title="Commit editing — entry will sort to its correct position">✓ Done</button>`
          : isInClio && !isDupe
            ? `<button class="btn btn-sm"
                  onclick="event.stopPropagation(); captureClioMarkReady(${e.id})"
                  style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;"
                  title="Mark as Different — dismiss Clio match and set Ready">✓</button>`
            : isNR && !isDupe
              ? hasConfRisk
                ? `<button class="btn btn-sm" disabled
                      style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;opacity:0.4;cursor:not-allowed"
                      title="Resolve Conf. Risk before marking Ready.">✓</button>`
                : `<button class="btn btn-sm"
                      onclick="event.stopPropagation(); captureSetReady(${e.id})"
                      style="background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;"
                      title="Mark as Ready">✓</button>`
              : ''}
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); duplicateEntry(${e.id})" title="Clone this row as a new entry">⧉</button>
        <button class="del-btn" onclick="deleteEntry(${e.id})">×</button>
      </td>
    </tr>`;
  });

  // Inject status-group divider rows when the table is sorted by Status.
  // Each divider labels the group (Needs Review / In Clio Baseline / Ready / Approved)
  // and draws a thicker top border so the transition between groups is visually clear.
  //
  // Three conditions must ALL be true before dividers appear:
  //   1. Sorted by status
  //   2. No editing lock active (clone being edited — entry is in non-natural position)
  //   3. No pending sort-schedule timer — means a status change just happened and the
  //      entry hasn't moved to its correct section yet; dividers would label it wrong.
  //      After the 800ms timer fires, the entry moves and dividers re-appear correctly.
  if (_sortField === 'status' && _editingLocks.size === 0 && _sortScheduleTimer === null) {
    const _pm = new Map(visible.map(e => [e.id, _effectiveStatusPriority(e, dupeIds, clioIds)]));
    let _lastPriority = -1;
    const _withDividers = [];
    for (let _i = 0; _i < visible.length; _i++) {
      const _p = _pm.get(visible[_i].id) ?? 2;
      if (_p !== _lastPriority) {
        _lastPriority = _p;
        const _lbl = STATUS_GROUP_LABELS[_p] || 'Status Group';
        _withDividers.push(
          `<tr class="status-group-divider" data-priority="${_p}"><td colspan="13"><span class="status-group-label">${_lbl}</span></td></tr>`
        );
      }
      _withDividers.push(_statusRows[_i]);
    }
    tbody.innerHTML = _withDividers.join('');
  } else {
    tbody.innerHTML = _statusRows.join('');
  }

  updateSummary(q ? visible.length : null);
  _updateSearchUI(q ? visible.length : null, sorted.length);
  _runValidation(); // sync check — updates _validationFlags before paint

  // After paint: resize textareas, inject validation badges, restore sidebar highlight, sync lock prompt
  requestAnimationFrame(() => {
    document.querySelectorAll('#stagingBody .desc-ta').forEach(_descAutoResize);
    _injectValidationBadges();
    _applySidebarHighlight(); // must run after badges so Viewing pill lands last-before-select
    _syncEditLockPrompt();    // re-inject inline prompt row if one is pending
  });
}

async function updateEntry(id, field, val) {
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  // Capture old value before the API call for history tracking
  const oldVal = e[field];

  const patch = { [field]: val };
  if (field === 'matter') {
    const m = getMatter(val);
    if (m) { patch.client = m.client; if (e.type !== 'Expense') patch.rate = m.rate; }
    if (val && e.status === 'Needs Review') patch.status = 'Ready';
  }
  // Do NOT auto-infer category when editing existing entries — only infer on initial creation.
  // Auto-inference on description edits would overwrite manually-set categories with 'Administrative'.
  const updated = await api('PUT', `/api/entries/${id}`, patch);

  // Record the change in per-entry history (skip if value unchanged)
  const TRACKED = ['description', 'category', 'matter', 'date', 'duration', 'rate', 'status'];
  if (TRACKED.includes(field) && String(oldVal ?? '') !== String(val ?? '')) {
    const hist = _entryHistory.get(id) || [];
    hist.push({ field, oldVal: oldVal ?? '', newVal: val, ts: Date.now() });
    if (hist.length > 5) hist.shift(); // keep last 5
    _entryHistory.set(id, hist);
  }

  Object.assign(e, updated);

  // When the description is saved, clear any persisted CONF_RISK dismissal for this entry.
  // The old dismissal was tied to the previous description hash; the new description may or
  // may not contain a foreign surname, so re-evaluation should run fresh.
  if (field === 'description') _clearDismissedConfrisk(id);

  // Status dropdown = explicit status change → entry moves to correct section after 800ms.
  // Schedule BEFORE renderStagingTable so _sortScheduleTimer is set when the render runs —
  // this suppresses section-group dividers during the animation window (dividers would be
  // wrong while the entry is still in its old position). Timer fires → dividers reappear.
  // Approving gives an 8-second follow indicator window since the entry may jump far in the list.
  if (field === 'status') {
    _scheduleSort(id, val === 'Approved' ? 8000 : 5000);
  }

  renderStagingTable();
  // Re-render sidebar if it's open for this entry (e.g. after vfAccept)
  if (_sidebarId === id) _renderSidebarContent(id);
}

// Toggle expand/collapse of proximity-match list in Related Entries for this entry
function toggleRelatedExpanded(entryId) {
  if (_relatedExpanded.has(entryId)) {
    _relatedExpanded.delete(entryId);
  } else {
    _relatedExpanded.add(entryId);
  }
  if (_sidebarId === entryId) _renderSidebarContent(entryId);
}

// Create a new entry pre-filled for a suggested matter (description cleared for manual entry).
// Inserts it below the source entry and opens it in the sidebar for immediate editing.
async function quickCloneForMatter(sourceId, suggestedMatter) {
  const source = stagingEntries.find(x => x.id === sourceId);
  if (!source) return;
  const m = getMatter(suggestedMatter);
  const copy = {
    matter:      suggestedMatter,
    client:      m ? m.client : '',
    date:        source.date,
    duration:    source.duration,
    description: '', // cleared — user fills in
    category:    source.category,
    type:        source.type,
    rate:        m ? m.rate : source.rate,
    status:      'Needs Review',
    source:      'manual',
  };
  const saved = await api('POST', '/api/entries', copy);
  const origIdx = stagingEntries.findIndex(x => x.id === sourceId);
  if (origIdx !== -1) stagingEntries.splice(origIdx + 1, 0, saved);
  else stagingEntries.push(saved);
  _pinnedAfter.set(saved.id, sourceId);
  renderStagingTable();
  _showFollowIndicator(saved.id);
  openConflictSidebar(saved.id);
}

// Revert a history item by index in the newest-first display order (displayIdx 0 = most recent)
async function revertHistoryItem(entryId, displayIdx) {
  const hist = (_entryHistory.get(entryId) || []).slice().reverse(); // newest first
  const item = hist[displayIdx];
  if (!item) return;
  // Remove this item from history before calling updateEntry (which would re-push)
  const stored = _entryHistory.get(entryId) || [];
  // Find the actual index in the stored (oldest-first) array and remove it
  const storedIdx = stored.length - 1 - displayIdx;
  if (storedIdx >= 0) stored.splice(storedIdx, 1);
  _entryHistory.set(entryId, stored);
  await updateEntry(entryId, item.field, item.oldVal);
}

async function deleteEntry(id) {
  hideDescTooltip(); // dismiss before row is removed from DOM
  const entry = stagingEntries.find(x => x.id === id);
  if (!entry) return;
  _softDelete(entry);
}

// ── RECENTLY DELETED TRAY ─────────────────────────────────────────────────

function _softDelete(entry) {
  hideDescTooltip(); // dismiss before the row is removed from the DOM
  // Remove from in-memory staging immediately (no await — all sync in main path)
  stagingEntries = stagingEntries.filter(x => x.id !== entry.id);
  renderStagingTable();
  // Also re-render review tab if it's active
  if (document.getElementById('sec-review')?.classList.contains('active')) renderReview();

  // If tray is full, permanently purge the oldest entry right now
  if (_deletedTray.length >= TRAY_MAX) {
    const oldest = _deletedTray.shift();
    clearTimeout(oldest.timerId);
    clearInterval(oldest.countdownId);
    _dismissToast(oldest.trayId);
    api('DELETE', `/api/entries/${oldest.entry.id}`); // fire-and-forget
  }

  const trayId = ++_trayCounter;
  const item   = { trayId, entry, timerId: null, countdownId: null, secondsLeft: Math.ceil(UNDO_MS / 1000) };
  _deletedTray.push(item);

  // 10-second permanent-delete timer
  item.timerId = setTimeout(async () => {
    clearInterval(item.countdownId);
    _deletedTray = _deletedTray.filter(x => x.trayId !== trayId);
    _dismissToast(trayId);
    _renderDeletedTray();
    await api('DELETE', `/api/entries/${entry.id}`);
  }, UNDO_MS);

  // Countdown updater (fires every second)
  item.countdownId = setInterval(() => {
    item.secondsLeft = Math.max(0, item.secondsLeft - 1);
    _updateToastCountdown(trayId, item.secondsLeft);
  }, 1000);

  _showDeleteToast(item);
  _renderDeletedTray();
}

async function _undoDelete(trayId) {
  const idx = _deletedTray.findIndex(x => x.trayId === trayId);
  if (idx === -1) return;
  const item = _deletedTray[idx];
  clearTimeout(item.timerId);
  clearInterval(item.countdownId);
  _deletedTray.splice(idx, 1);
  _dismissToast(trayId);
  // Re-insert into SQLite (gets a new auto-increment ID)
  const restored = await api('POST', '/api/entries', item.entry);
  stagingEntries.push(restored);
  renderStagingTable();
  _renderDeletedTray();
}

// Called from the tray UI Restore button — same logic as undo
function _restoreFromTray(trayId) { _undoDelete(trayId); }

async function _dismissToastAndPurge(trayId) {
  const idx = _deletedTray.findIndex(x => x.trayId === trayId);
  if (idx === -1) { _dismissToast(trayId); return; }
  const item = _deletedTray[idx];
  clearTimeout(item.timerId);
  clearInterval(item.countdownId);
  _deletedTray.splice(idx, 1);
  _dismissToast(trayId);
  _renderDeletedTray();
  await api('DELETE', `/api/entries/${item.entry.id}`);
}

async function _clearAllDeleted() {
  const items = [..._deletedTray];
  _deletedTray    = [];
  _trayExpanded   = false;
  for (const item of items) {
    clearTimeout(item.timerId);
    clearInterval(item.countdownId);
    _dismissToast(item.trayId);
  }
  _renderDeletedTray();
  await Promise.all(items.map(item => api('DELETE', `/api/entries/${item.entry.id}`)));
}

async function _purgeDeletedTray() {
  await _clearAllDeleted();
}

// ── Toast DOM helpers ─────────────────────────────────────────────────────

function _showDeleteToast(item) {
  const area = document.getElementById('deleteToastArea');
  if (!area) return;
  const el = document.createElement('div');
  el.className = 'delete-toast';
  el.id = `toast-${item.trayId}`;
  el.innerHTML = `<span>Entry deleted</span>
    <button class="toast-undo-btn" onclick="_undoDelete(${item.trayId})">Undo (${item.secondsLeft}s)</button>
    <button class="toast-dismiss-btn" onclick="_dismissToastAndPurge(${item.trayId})" title="Dismiss">×</button>`;
  area.appendChild(el);
}

function _updateToastCountdown(trayId, secondsLeft) {
  const btn = document.querySelector(`#toast-${trayId} .toast-undo-btn`);
  if (btn) btn.textContent = `Undo (${secondsLeft}s)`;
}

function _dismissToast(trayId) {
  const el = document.getElementById(`toast-${trayId}`);
  if (el) el.remove();
}

// ── Tray section renderer ─────────────────────────────────────────────────

function _toggleTray() {
  _trayExpanded = !_trayExpanded;
  _renderDeletedTray();
}

function _renderDeletedTray() {
  const section = document.getElementById('deletedTraySection');
  if (!section) return;
  if (!_deletedTray.length) { section.innerHTML = ''; return; }

  const count = _deletedTray.length;
  const rows  = _deletedTray.map(item => {
    const e    = item.entry;
    const bill = (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0);
    const desc = (e.description || '').slice(0, 60) + (e.description?.length > 60 ? '…' : '');
    return `<tr class="tray-row">
      <td style="padding:6px 10px;white-space:nowrap">${e.date || '—'}</td>
      <td style="padding:6px 10px;white-space:nowrap">${e.matter || '—'}</td>
      <td style="padding:6px 10px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${(e.description||'').replace(/"/g,'&quot;')}">${desc || '—'}</td>
      <td style="padding:6px 10px;white-space:nowrap">${e.type === 'Expense' ? `${Math.round(parseFloat(e.duration)||1)} qty` : `${(parseFloat(e.duration)||0).toFixed(1)} hr`} · $${bill.toFixed(2)}</td>
      <td style="padding:6px 10px;white-space:nowrap">
        <button class="btn btn-sm btn-ghost" onclick="_restoreFromTray(${item.trayId})"
          style="font-size:11px">Restore</button>
      </td>
    </tr>`;
  }).join('');

  section.innerHTML = `<div class="deleted-tray-wrap">
    <div class="deleted-tray-toggle" onclick="_toggleTray()">
      <span style="font-weight:500">🗑 Recently Deleted — ${count} entr${count === 1 ? 'y' : 'ies'}</span>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-ghost btn-sm" style="font-size:11px"
          onclick="event.stopPropagation();_clearAllDeleted()">Clear All</button>
        <span>${_trayExpanded ? '▲' : '▼'}</span>
      </div>
    </div>
    ${_trayExpanded ? `<div class="deleted-tray-body">
      <table style="width:100%;border-collapse:collapse">
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}
  </div>`;
}

async function duplicateEntry(id) {
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;

  // ── Resolve description ───────────────────────────────────────────────────
  // Use in-memory value as canonical source. The textarea DOM read was previously
  // used to handle the onchange async race, but it can itself return '' if the row
  // is mid-rerender. Instead: prefer the textarea value only when it is non-empty
  // and longer than the in-memory value (i.e. the user typed something unsaved).
  // In all other cases fall back to stagingEntries which reflects the persisted DB value.
  const descTA      = document.querySelector(`#stagingBody tr[data-id="${id}"] .desc-ta`);
  const taVal       = descTA ? descTA.value : null;
  const memVal      = e.description ?? '';
  // Prefer textarea value if it is non-empty and either memory is empty or textarea is newer/longer
  const description = (taVal !== null && taVal.length > 0 && taVal.length >= memVal.length)
    ? taVal
    : memVal;

  // ── CHECKPOINT 1: before fetch ────────────────────────────────────────────
  console.log('[duplicateEntry] CHECKPOINT 1 — before fetch');
  console.log('  id:', id);
  console.log('  e.description (memory):', JSON.stringify(memVal));
  console.log('  descTA.value (DOM)    :', JSON.stringify(taVal));
  console.log('  description (resolved):', JSON.stringify(description));
  console.log('  full source entry     :', JSON.stringify(e));

  // ── Auto-scrub foreign surnames from description ───────────────────────────
  // If the entry has a matter assigned, strip any other client surnames before
  // saving the clone — produces an attorney-client-clean description automatically.
  let finalDesc = description;
  if (e.matter && description) {
    finalDesc = await _autoScrubDescription(description, e.matter);
    if (finalDesc !== description) {
      console.log('[duplicateEntry] auto-scrub changed description from',
        JSON.stringify(description), 'to', JSON.stringify(finalDesc));
    }
  }

  const copy = {
    matter:      e.matter,
    client:      e.client,
    date:        e.date,
    duration:    e.duration,
    description: finalDesc,
    category:    e.category,
    type:        e.type,
    rate:        e.rate,
    status:      e.status,
    source:      e.status === 'Approved' ? 'cloned' : e.source,
  };

  console.log('[duplicateEntry] CHECKPOINT 1b — copy object being POSTed:', JSON.stringify(copy));

  const saved = await api('POST', '/api/entries', copy);
  console.log('[duplicateEntry] CHECKPOINT 1c — saved entry returned from API:', JSON.stringify(saved));

  // ── Compute frozen display order BEFORE splicing the clone into stagingEntries ──
  // sortEntries() on the current state gives the active sorted view. We then
  // inject the clone ID immediately after the original so the table renders
  // with the clone adjacent regardless of active sort column (fixes Status sort).
  const currentSorted = sortEntries([...stagingEntries]);
  const origSortIdx   = currentSorted.findIndex(e => e.id === id);
  const frozenIds     = currentSorted.map(e => e.id);
  frozenIds.splice(origSortIdx !== -1 ? origSortIdx + 1 : frozenIds.length, 0, saved.id);
  _frozenSortOrder = frozenIds;

  // Now add the clone to the live array
  const origIdx = stagingEntries.findIndex(x => x.id === id);
  if (origIdx !== -1) {
    stagingEntries.splice(origIdx + 1, 0, saved);
  } else {
    stagingEntries.push(saved);
  }

  // Pin also registered (used after frozen order clears)
  _pinnedAfter.set(saved.id, id);

  // Mark as editing locked BEFORE render so the lock styling appears immediately.
  _editingLocks.add(saved.id);

  // Render with frozen order — clone appears directly below original.
  // Frozen order persists until the user commits (Done) or explicitly clicks a column header.
  renderStagingTable();

  // Open the sidebar immediately on the new clone so the user can edit it right away.
  openConflictSidebar(saved.id);
  _showSimpleToast('Clone created — edit, then click ✓ Done to place it.', 5000);
  _showFollowIndicator(saved.id);
}

// ── Editing Lock functions ─────────────────────────────────────────────────

// Injects (or removes) the "Finish editing?" prompt sub-row below the locked entry.
// Called from renderStagingTable RAF and directly from openConflictSidebar on click-away.
function _syncEditLockPrompt() {
  // Clear any stale prompt rows from a previous render
  document.querySelectorAll('.edit-lock-prompt-row').forEach(r => r.remove());
  if (_editingLockPromptId === null) return;
  const lockedRow = document.querySelector(`#stagingBody tr[data-id="${_editingLockPromptId}"]`);
  if (!lockedRow) return;
  const pid = _editingLockPromptId;
  const promptRow = document.createElement('tr');
  promptRow.className = 'edit-lock-prompt-row';
  promptRow.innerHTML = `<td colspan="13">
    <span style="font-size:12px;color:#7c3a3a;font-weight:500">Finish editing?</span>
    <button class="btn btn-sm" onclick="event.stopPropagation(); commitEditingLock(${pid})"
      style="margin-left:10px;background:var(--green-bg);color:var(--green);border:1px solid #b5d89a;"
      title="Commit and place entry in its sorted position">Done</button>
    <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); _keepEditingLocked(${pid})"
      style="margin-left:4px"
      title="Return to editing this entry">Keep editing</button>
  </td>`;
  lockedRow.insertAdjacentElement('afterend', promptRow);
}

// Commit the editing lock for an entry: remove lock, schedule the sort, then re-render.
// _scheduleSort must be called BEFORE renderStagingTable so _sortScheduleTimer is set
// when the render runs — this suppresses status-group dividers in the intermediate state
// where the lock is gone but the entry is still in its frozen (pre-sort) position.
function commitEditingLock(id) {
  _editingLocks.delete(id);
  if (_editingLockPromptId === id) _editingLockPromptId = null;
  // Schedule sort first — sets timer so dividers are suppressed in the render below
  _scheduleSort(id);
  // Re-render without lock styling (entry still frozen; timer fires → moves after 800ms)
  renderStagingTable();
  if (_sidebarId === id) _renderSidebarContent(id);
}

// "Keep editing": dismiss the prompt and re-open the sidebar on the locked entry.
function _keepEditingLocked(id) {
  _editingLockPromptId = null;
  _syncEditLockPrompt(); // remove the prompt row immediately
  _suppressLockClickAway = true;
  openConflictSidebar(id);
  _suppressLockClickAway = false;
  // Scroll the locked row into view so the user can see it
  const row = document.querySelector(`#stagingBody tr[data-id="${id}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function clearStaging() {
  if (!confirm('Clear all staging entries?')) return;
  await api('DELETE', '/api/entries/all');
  stagingEntries = [];
  renderStagingTable();
}

function updateSummary(filteredCount = null) {
  const total  = stagingEntries.length;
  // Hours only sums Time entries — Expense `duration` is a unit quantity, not hours.
  const hours  = stagingEntries.filter(e => e.type !== 'Expense').reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
  const bill   = stagingEntries.reduce((s, e) => s + (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0), 0);
  const review = stagingEntries.filter(e => e.status === 'Needs Review').length;
  const ready  = stagingEntries.filter(e => e.status === 'Ready').length;

  // Entries label: show "N / total" in isolation mode, otherwise just total
  const entryLabel = (filteredCount !== null && filteredCount !== total)
    ? `${filteredCount}&thinsp;/&thinsp;${total}`
    : total;

  const statsEl = document.getElementById('captureStats');
  if (statsEl) {
    statsEl.innerHTML =
      `<span class="cs-stat">Entries:&nbsp;<strong>${entryLabel}</strong></span>` +
      `<span class="cs-sep">·</span>` +
      `<span class="cs-stat">Hours:&nbsp;<strong>${hours.toFixed(1)}</strong></span>` +
      `<span class="cs-sep">·</span>` +
      `<span class="cs-stat"><strong>$${bill.toFixed(2)}</strong></span>` +
      `<span class="cs-sep">·</span>` +
      `<span class="cs-stat">Ready:&nbsp;<strong style="color:var(--green)">${ready}</strong></span>` +
      `<span class="cs-pipe">|</span>` +
      `<span class="cs-stat">Review:&nbsp;<strong style="color:var(--amber)">${review}</strong></span>`;
  }
}

// ── DUPLICATE DETECTION ────────────────────────────────────────────────────
function getDuplicateIds() {
  const dupeIds = new Set();
  for (let i = 0; i < stagingEntries.length; i++) {
    for (let j = i + 1; j < stagingEntries.length; j++) {
      const a = stagingEntries[i], b = stagingEntries[j];
      if (a.matter && a.matter === b.matter && a.date === b.date) {
        if (wordOverlap(a.description, b.description) >= 0.7) {
          dupeIds.add(a.id);
          dupeIds.add(b.id);
        }
      }
    }
  }
  return dupeIds;
}

// ── REVIEW ─────────────────────────────────────────────────────────────────
function renderReview() {
  const dupeIds = getDuplicateIds();
  const clioIds = getClioMatchIds();
  const grouped = {};
  for (const e of stagingEntries) {
    const key = e.matter || '__none__';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  const totalHrs  = stagingEntries.filter(e => e.type !== 'Expense').reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
  const totalBill = stagingEntries.reduce((s, e) => s + (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0), 0);
  const needsReview = stagingEntries.filter(e => e.status === 'Needs Review').length;
  const approved    = stagingEntries.filter(e => e.status === 'Approved').length;

  document.getElementById('reviewStats').innerHTML =
    `<span class="cs-stat">Entries:&nbsp;<strong>${stagingEntries.length}</strong></span>` +
    `<span class="cs-sep">·</span>` +
    `<span class="cs-stat">Hours:&nbsp;<strong>${totalHrs.toFixed(1)}</strong></span>` +
    `<span class="cs-sep">·</span>` +
    `<span class="cs-stat"><strong>$${totalBill.toFixed(2)}</strong></span>` +
    `<span class="cs-sep">·</span>` +
    `<span class="cs-stat">Approved:&nbsp;<strong style="color:var(--approved)">${approved}</strong></span>` +
    `<span class="cs-pipe">|</span>` +
    `<span class="cs-stat">Review:&nbsp;<strong style="color:var(--amber)">${needsReview}</strong></span>`;

  // Warnings
  const redWarnings   = [];
  const amberWarnings = [];

  for (const e of stagingEntries) {
    if (!e.matter) redWarnings.push(`"${(e.description || 'Untitled').substring(0, 40)}" — no matter assigned`);
    if (!e.category || e.category.toLowerCase() === 'none') redWarnings.push(`"${(e.description || 'Untitled').substring(0, 40)}" — no category set (will export as Administrative)`);
    if (e.type === 'Time' && (!e.rate || e.rate === 0)) redWarnings.push(`"${(e.description || 'Untitled').substring(0, 40)}" — $0 rate`);
    if (e.category === 'Notes — Estimated' && e.status !== 'Approved')
      amberWarnings.push(`"${(e.description || 'Untitled').substring(0, 40)}" — Notes — Estimated requires manual approval`);
    if (e.source === 'wisetime')
      amberWarnings.push(`"${(e.description || '').substring(0, 40)}" — WiseTime entry (advisory)`);
  }

  if (dupeIds.size > 0) {
    redWarnings.push(`${dupeIds.size} entries flagged as Probable Duplicate — resolve before export`);
  }

  const warnEl = document.getElementById('warningBanners');
  let banners = '';
  if (redWarnings.length) {
    banners += `<div class="warning-banner warn-red"><strong>⚠ Errors (${redWarnings.length})</strong><ul>${redWarnings.slice(0, 8).map(w => `<li>${w}</li>`).join('')}</ul></div>`;
  }
  if (amberWarnings.length) {
    banners += `<div class="warning-banner warn-amber"><strong>⚑ Advisories (${amberWarnings.length})</strong><ul>${amberWarnings.slice(0, 8).map(w => `<li>${w}</li>`).join('')}</ul></div>`;
  }
  warnEl.innerHTML = banners;

  const container = document.getElementById('reviewGroups');
  if (!stagingEntries.length) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">No entries to review — add entries in Capture</div>';
    return;
  }

  // Build a search predicate — only filter in isolation mode (Mode 2); dropdown mode leaves table unchanged
  const rq = (_searchMode === 'isolation' ? _searchQuery : '').toLowerCase().trim();
  const _matchesSearch = e =>
    !rq ||
    (e.matter      || '').toLowerCase().includes(rq) ||
    (e.client      || '').toLowerCase().includes(rq) ||
    (e.description || '').toLowerCase().includes(rq) ||
    _matchesDate(e.date, rq)                          ||
    (e.category    || '').toLowerCase().includes(rq) ||
    (e.source      || '').toLowerCase().includes(rq) ||
    (e.status      || '').toLowerCase().includes(rq);

  let reviewVisibleTotal = 0;

  const groupHtml = Object.entries(grouped).map(([key, entries]) => {
    const sortedEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    const visibleEntries = sortedEntries.filter(_matchesSearch);
    if (rq && visibleEntries.length === 0) return null; // collapse empty groups

    reviewVisibleTotal += visibleEntries.length;

    const groupHrs  = visibleEntries.filter(e => e.type !== 'Expense').reduce((s, e) => s + (parseFloat(e.duration) || 0), 0);
    const groupBill = visibleEntries.reduce((s, e) => s + (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0), 0);
    const matterLabel = key === '__none__' ? 'No Matter Assigned' : key;
    const clientLabel = entries[0]?.client || '';

    return `<div class="matter-group">
      <div class="matter-header">
        <div class="matter-label">${matterLabel}</div>
        <div style="opacity:0.7;font-size:13px">${clientLabel}</div>
        <div class="matter-stats">
          <button class="matter-approve-btn" onclick="approveMatter(${JSON.stringify(key)})" title="Approve all Ready entries in this matter">✓ Approve Ready</button>
          <span>${groupHrs.toFixed(1)} hrs</span>
          <span>$${groupBill.toFixed(2)}</span>
        </div>
      </div>
      <table style="width:100%">
        <thead><tr>
          <th style="width:110px">Date</th>
          <th>Description</th>
          <th style="width:130px">Category</th>
          <th style="width:70px">Hrs</th>
          <th style="width:80px">Billable</th>
          <th style="width:120px">Status</th>
          <th style="width:130px">Actions</th>
        </tr></thead>
        <tbody>${visibleEntries.map(e => {
          const bill = (parseFloat(e.duration) || 0) * (parseFloat(e.rate) || 0);
          const isDupe      = dupeIds.has(e.id);
          const isInClio    = clioIds.has(e.id);
          const isEst       = e.category === 'Notes — Estimated';
          const isWise      = e.source === 'wisetime';
          const isSplitEntry = e.source === 'split';
          let rowCls = e.status === 'Approved' ? 'approved' : (e.status === 'Needs Review' ? 'needs-review' : '');
          if (isDupe)              rowCls = 'duplicate';
          if (isInClio && !isDupe) rowCls = 'clio-match';
          if (isSplitEntry)        rowCls = (rowCls + ' split-row').trim();

          let statusBadge;
          if (isDupe)                           statusBadge = '<span class="badge badge-duplicate" title="Probable Duplicate — click row for details">Probable Duplicate</span>';
          else if (isInClio)                    statusBadge = '<span class="badge badge-clio" title="Baseline match — click row for details">Already in Clio</span>';
          else if (isWise)                      statusBadge = '<span class="badge badge-wisetime">WiseTime ⚑</span>';
          else if (e.status === 'Approved')     statusBadge = '<span class="badge badge-approved">Approved</span>';
          else if (e.status === 'Needs Review') statusBadge = '<span class="badge badge-review">Needs Review</span>';
          else                                  statusBadge = '<span class="badge badge-ready">Ready</span>';

          const canApprove      = !isDupe && e.status !== 'Approved';
          const isNREntry       = e.status === 'Needs Review';
          const reviewHoverable = isDupe || isNREntry || isSplitEntry;

          return `<tr class="${rowCls}" data-id="${e.id}" data-matter="${e.matter||''}" data-date="${e.date||''}"
            style="cursor:pointer"
            onclick="rowClick(event,${e.id})"
            onmouseenter="highlightConflicts(this,${reviewHoverable})"
            onmouseleave="clearConflictHighlights()">
            <td style="font-size:12px">${e.date}</td>
            <td style="font-size:13px">${e.description || '<em style="color:var(--text-muted)">No description</em>'}${isEst ? ' <span style="font-size:11px;color:var(--amber)">[Estimated]</span>' : ''}</td>
            <td style="font-size:11px;color:var(--text-muted)">${e.category}</td>
            <td>${e.type === 'Expense' ? `${Math.round(parseFloat(e.duration)||1)} qty` : `${(parseFloat(e.duration)||0).toFixed(1)}`}</td>
            <td>$${bill.toFixed(2)}</td>
            <td>${statusBadge}</td>
            <td style="display:flex;gap:4px;padding:6px 8px;flex-wrap:wrap">
              <button class="btn btn-sm${isNREntry && canApprove ? ' btn-nr-approve' : ''}"
                ${canApprove ? `onclick="${isNREntry ? `reviewApproveNR(${e.id})` : `setStatus(${e.id},'Approved')`}"` : 'disabled'}
                style="${canApprove ? 'background:var(--approved-bg);color:var(--approved);border:1px solid var(--approved-border)' : 'background:var(--s1);color:var(--tx4);border:1px solid var(--line);cursor:not-allowed;opacity:0.55'}"
                title="${canApprove ? (isNREntry ? 'Approve this Needs Review entry (click to confirm)' : 'Approve') : 'Already approved'}">✓</button>
              <button class="btn btn-sm" style="background:var(--amber-bg);color:var(--amber);border:1px solid #f0c875" onclick="setStatus(${e.id},'Needs Review')">⚑</button>
              ${isDupe ? `<button class="btn btn-sm btn-ghost" onclick="deleteEntry(${e.id})">Delete</button>` : ''}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
  });  // end groupHtml map

  if (rq && reviewVisibleTotal === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px">No entries match "${rq.replace(/</g,'&lt;')}"</div>`;
    _updateSearchUI(0, stagingEntries.length);
    return;
  }

  container.innerHTML = groupHtml.filter(Boolean).join('');
  _updateSearchUI(rq ? reviewVisibleTotal : null, stagingEntries.length);
  requestAnimationFrame(() => _applySidebarHighlight());
}

async function setStatus(id, status) {
  const e = stagingEntries.find(x => x.id === id);
  if (!e) return;
  const updated = await api('PUT', `/api/entries/${id}`, { status });
  Object.assign(e, updated);
  renderReview();
}

// Approve a Needs Review entry in the Review tab with a brief pulse before applying.
// The pulse gives the user a moment to see the action is happening — prevents misclicks.
function reviewApproveNR(id) {
  const btn = document.querySelector(`#reviewContainer tr[data-id="${id}"] .btn-nr-approve`);
  if (btn) {
    btn.classList.add('pulse-approve');
    btn.disabled = true;
    setTimeout(() => setStatus(id, 'Approved'), 400);
  } else {
    setStatus(id, 'Approved'); // fallback if button not found
  }
}

async function approveAll() {
  const toApprove = stagingEntries.filter(e => e.status === 'Ready' && e.category !== 'Notes — Estimated');
  for (const e of toApprove) {
    const updated = await api('PUT', `/api/entries/${e.id}`, { status: 'Approved' });
    Object.assign(e, updated);
  }
  renderReview();
}

// Approve all Ready entries within a single matter group.
// matterKey is the grouped key: the matter string, or '__none__' when unassigned.
async function approveMatter(matterKey) {
  const toApprove = stagingEntries.filter(e => {
    const k = e.matter || '__none__';
    return k === matterKey && e.status === 'Ready' && e.category !== 'Notes — Estimated';
  });
  if (!toApprove.length) {
    _showSimpleToast('No Ready entries to approve in this matter.');
    return;
  }
  for (const e of toApprove) {
    const updated = await api('PUT', `/api/entries/${e.id}`, { status: 'Approved' });
    Object.assign(e, updated);
  }
  renderReview();
  _showSimpleToast(`${toApprove.length} entr${toApprove.length === 1 ? 'y' : 'ies'} approved.`);
}

// ── EXPORT ─────────────────────────────────────────────────────────────────
let _previewFilter = 'all';

function setPreviewFilter(filter) {
  _previewFilter = filter;
  ['all', 'activities', 'expenses'].forEach(f => {
    const btn = document.getElementById(`prev-${f}`);
    if (btn) btn.classList.toggle('active', f === filter);
  });
  generatePreview();
}

async function generatePreview() {
  const tbody = document.getElementById('previewBody');
  const thead = document.getElementById('previewHead');
  if (!tbody || !thead) {
    console.error('[generatePreview] previewBody or previewHead element not found in DOM');
    return;
  }
  // Show loading state immediately so the user sees the click registered
  tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:16px">Loading…</td></tr>`;

  try {
    const rows  = await api('GET', `/api/export/preview?type=${_previewFilter}`);
    const isExp = _previewFilter === 'expenses';
    // Both activities (8 cols) and expenses (8 cols) have the same column count
    const cols  = 8;

    console.log(`[generatePreview] filter="${_previewFilter}" — ${rows.length} export-eligible rows (status Ready or Approved)`);

    if (!rows.length) {
      const filterLabel = _previewFilter === 'activities' ? 'activity' : _previewFilter === 'expenses' ? 'expense' : '';
      const msg = filterLabel
        ? `No ${filterLabel} entries with Ready or Approved status`
        : 'No entries with Ready or Approved status';
      tbody.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-muted);padding:16px">${msg}</td></tr>`;
      return;
    }

    // Escape HTML to prevent description/vendor text from breaking the table structure
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Convert stored ISO date (YYYY-MM-DD) → Clio MM/DD/YYYY for preview
    const fmtDate = d => { if (!d) return '—'; const [y,m,dy] = String(d).split('-'); return `${m}/${dy}/${y}`; };

    if (isExp) {
      thead.innerHTML = '<tr><th>matter</th><th>date</th><th>quantity</th><th>price</th><th>type</th><th>activity_description</th><th>vendor_name</th><th>note</th></tr>';
      tbody.innerHTML = rows.slice(0, 10).map(e => `<tr>
        <td>${esc(e.matter)}</td><td>${fmtDate(e.date)}</td>
        <td>${Math.round(parseFloat(e.duration)||1)}</td>
        <td>$${parseFloat(e.rate)||0}</td>
        <td>ExpenseEntry</td>
        <td>${esc(e.category||'Administrative')}</td>
        <td>${esc(e.vendor_name)}</td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.description)}</td>
      </tr>`).join('');
    } else {
      thead.innerHTML = '<tr><th>matter</th><th>date</th><th>quantity</th><th>price</th><th>type</th><th>activity_user</th><th>activity_description</th><th>note</th></tr>';
      tbody.innerHTML = rows.slice(0, 10).map(e => `<tr>
        <td>${esc(e.matter)}</td><td>${fmtDate(e.date)}</td>
        <td>${(parseFloat(e.duration)||0).toFixed(1)}</td>
        <td>$${parseFloat(e.rate)||0}</td>
        <td>${e.type === 'Expense' ? 'ExpenseEntry' : 'TimeEntry'}</td>
        <td>Michael Agege</td>
        <td>${esc(e.category||'Administrative')}</td>
        <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.description)}</td>
      </tr>`).join('');
    }
  } catch (err) {
    console.error('[generatePreview] error:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--red);padding:16px">Preview failed — ${err.message}</td></tr>`;
  }
}

async function validateCSV() {
  const el = document.getElementById('validationResults');
  try {
    const { count, activities, expenses, errors } = await api('GET', '/api/export/validate');
    const dupeIds   = getDuplicateIds();
    const allErrors = [...errors];
    if (dupeIds.size > 0) allErrors.push(`${dupeIds.size} Probable Duplicate entries must be resolved`);
    if (!allErrors.length) {
      el.innerHTML = `<div style="color:var(--green);font-weight:500">✓ ${count} rows ready — ${activities} activities, ${expenses} expenses</div>`;
    } else {
      el.innerHTML = `<div style="color:var(--red);font-weight:500;margin-bottom:6px">⚠ ${allErrors.length} issue(s) found:</div>
        <ul style="margin-left:16px;color:var(--red)">${allErrors.map(e => `<li>${e}</li>`).join('')}</ul>`;
    }
  } catch (e) {
    el.innerHTML = `<span style="color:var(--red)">Validation error: ${e.message}</span>`;
  }
}

async function _downloadCSVFromEndpoint(endpoint, label) {
  try {
    const res = await fetch(endpoint, { method: 'POST' });
    if (!res.ok) { const err = await res.json(); alert(err.error || `${label} export failed`); return; }
    const blob    = await res.blob();
    const cd      = res.headers.get('content-disposition') || '';
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fnMatch ? fnMatch[1] : `clio-${label}.csv`; a.click();
    URL.revokeObjectURL(url);
    refreshBanner();

    // Permanently purge any soft-deleted entries on export
    if (_deletedTray.length > 0) await _purgeDeletedTray();

    // Offer to clear the baseline after a successful export
    if (_baseline && _baseline.length > 0) {
      const fn = _baselineMeta ? _baselineMeta.filename : 'the active baseline';
      const yes = window.confirm(
        `Your billing cycle has been exported.\n\nClear the active baseline (${fn}) for this period?`
      );
      if (yes) clearBaseline();
    }
  } catch (e) {
    alert(`${label} export error: ` + e.message);
  }
}

function downloadActivities() { _downloadCSVFromEndpoint('/api/export/download-activities', 'activities'); }
function downloadExpenses()   { _downloadCSVFromEndpoint('/api/export/download-expenses',   'expenses');   }

// ── ARCHIVE ────────────────────────────────────────────────────────────────
async function renderArchive() {
  const container = document.getElementById('archiveList');
  try {
    const cycles = await api('GET', '/api/archive');
    if (!cycles.length) {
      container.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px">No exported cycles yet — complete an export to create an archive entry</div>';
      document.getElementById('arc-hours').textContent = '0.0';
      document.getElementById('arc-bill').textContent  = '$0.00';
      document.getElementById('arc-count').textContent = '0';
      return;
    }
    container.innerHTML = cycles.map(c => {
      const typeLabel = c.cycle_type === 'expenses' ? 'Expenses' : c.cycle_type === 'activities' ? 'Activities' : 'All';
      const typeBadge = c.cycle_type === 'expenses'
        ? '<span class="badge badge-wisetime" style="font-size:10px">Expenses CSV</span>'
        : '<span class="badge badge-ready" style="font-size:10px">Activities CSV</span>';
      return `
      <div class="archive-cycle">
        <div class="archive-month">${c.month_label}<br>${typeBadge}</div>
        <div class="archive-stats">
          <div class="archive-stat"><div class="label">Entries</div><div class="val">${c.entry_count}</div></div>
          <div class="archive-stat"><div class="label">Hours</div><div class="val">${(c.total_hours || 0).toFixed(1)}</div></div>
          <div class="archive-stat"><div class="label">Billable</div><div class="val">$${(c.total_billable || 0).toFixed(2)}</div></div>
          <div class="archive-stat"><div class="label">Exported</div><div class="val">${c.exported_at.replace('T', ' ').replace(/\.\d+Z?$/, '')}</div></div>
        </div>
        <a class="btn btn-ghost btn-sm" href="/api/archive/${c.id}/download">⬇ Re-download</a>
      </div>`;
    }).join('');

    const totHrs  = cycles.reduce((s, c) => s + (c.total_hours || 0), 0);
    const totBill = cycles.reduce((s, c) => s + (c.total_billable || 0), 0);
    document.getElementById('arc-hours').textContent = totHrs.toFixed(1);
    document.getElementById('arc-bill').textContent  = '$' + totBill.toFixed(2);
    document.getElementById('arc-count').textContent = cycles.length;
  } catch (e) {
    container.innerHTML = `<div style="color:var(--red);padding:20px">Failed to load archive: ${e.message}</div>`;
  }
}

// ── CAPTURE HEADER ACTIONS ─────────────────────────────────────────────────

// Lightweight info toast (non-delete, auto-dismisses after 6 s)
function _showInfoToast(message, color) {
  const area = document.getElementById('deleteToastArea');
  if (!area) return;
  const toastId = 'infoToast_' + Date.now();
  const bgMap = { green: '#2d7a4f', amber: '#b87a10', red: '#b03030', navy: '#1a3a5c' };
  const bg = bgMap[color] || bgMap.navy;
  const div = document.createElement('div');
  div.id = toastId;
  div.className = 'delete-toast';
  div.style.cssText = `background:${bg};white-space:normal;max-width:420px`;
  div.innerHTML = `<span class="toast-msg">${message}</span>
    <button class="toast-dismiss-btn" onclick="document.getElementById('${toastId}')?.remove()" title="Dismiss">×</button>`;
  area.appendChild(div);
  setTimeout(() => document.getElementById(toastId)?.remove(), 6000);
}

// Validation Pass — run all four checks and report a summary toast
function runValidationPass() {
  if (!stagingEntries.length) {
    _showInfoToast('No staging entries to validate.', 'navy');
    return;
  }
  _runValidation();
  _injectValidationBadges();
  const totalFlags   = [..._validationFlags.values()].reduce((acc, arr) => acc + arr.length, 0);
  const entryCount   = _validationFlags.size;
  if (totalFlags === 0) {
    _showInfoToast('✓ Validation pass complete — no issues found.', 'green');
  } else {
    const byType = {};
    for (const flags of _validationFlags.values()) {
      for (const f of flags) byType[f.type] = (byType[f.type] || 0) + 1;
    }
    const parts = [];
    if (byType.LONG_DESC)      parts.push(`${byType.LONG_DESC} long desc`);
    if (byType.CONF_RISK)      parts.push(`${byType.CONF_RISK} conf. risk`);
    if (byType.DAVIDSON_REVIEW) parts.push(`${byType.DAVIDSON_REVIEW} Davidson review`);
    if (byType.EST_TIME)       parts.push(`${byType.EST_TIME} est. time`);
    _showInfoToast(`Validation: ${totalFlags} flag${totalFlags !== 1 ? 's' : ''} across ${entryCount} entr${entryCount !== 1 ? 'ies' : 'y'} — ${parts.join(', ')}.`, 'amber');
  }
}

// Pure validation check used by refineNeedsReview() to gate status promotion.
// Returns the specific blocking flag type, or null if no block.
// Used by _refineHasBlockingFlag (refine gate) and sidebar Quick Approve (per-type tooltip).
function _blockingFlagType(desc, matter, category) {
  if (category === 'Notes — Estimated') return 'EST_TIME';
  const clientSurnames = _getClientSurnames();
  for (const { matter: clientMatter, surname } of clientSurnames) {
    if (clientMatter === matter) continue;
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`\\b${escaped}\\b`, 'i');
    if (rx.test(desc)) return 'CONF_RISK';
  }
  return null;
}

// Returns true when the post-refinement entry still has a BLOCKING flag (CONF_RISK or EST_TIME).
// LONG_DESC and DAVIDSON_REVIEW are advisory-only and never block promotion.
function _refineHasBlockingFlag(desc, matter, category) {
  return _blockingFlagType(desc, matter, category) !== null;
}

// Refine Needs Review — batch re-parses all NR entries through Panel A AI
async function refineNeedsReview() {
  const nrEntries = stagingEntries.filter(e => e.status === 'Needs Review');
  if (!nrEntries.length) {
    _showInfoToast('No Needs Review entries to refine.', 'navy');
    return;
  }

  const count = nrEntries.length;
  const entryWord = count !== 1 ? 'entries' : 'entry';
  if (!confirm(
    `Re-parse ${count} Needs Review ${entryWord} through the Panel A parser?\n\n` +
    `This will modify descriptions and categories on ${count} ${entryWord}. ` +
    `A 60-second undo window will be available.`
  )) return;

  // Snapshot the full field state of every NR entry BEFORE any changes
  _refineSnapshot = nrEntries.map(e => ({
    id:          e.id,
    description: e.description ?? '',
    category:    e.category    ?? '',
    matter:      e.matter      ?? '',
    client:      e.client      ?? '',
    rate:        e.rate        ?? '',
    status:      e.status      ?? '',
  }));

  const btn = document.getElementById('refineNRBtn');
  if (btn) { btn.textContent = '⟳ Refining…'; btn.disabled = true; }

  try {
    const payload = nrEntries.map(e => ({
      id:          e.id,
      description: e.description || '',
      matter:      e.matter      || '',
      date:        e.date        || '',
      duration:    e.duration    || 0.1,
    }));

    const { refined } = await api('POST', '/api/ai/refine-needs-review', { entries: payload });

    let updated  = 0;
    let promoted = 0; // entries promoted to Ready
    let heldNR   = 0; // entries AI cleared but validation blocked (kept at Needs Review)

    for (let i = 0; i < refined.length && i < nrEntries.length; i++) {
      const orig = nrEntries[i];
      const fix  = refined[i];
      if (!fix) continue;
      const patch = {};
      if (fix.description && fix.description !== orig.description) patch.description = fix.description;
      if (fix.category    && fix.category    !== orig.category)    patch.category    = fix.category;
      if (fix.matter      && fix.matter      !== orig.matter && fix.matter.trim()) {
        const m = matters.find(x => x.num === fix.matter);
        if (m) { patch.matter = fix.matter; patch.client = m.client; patch.rate = m.rate; }
      }

      // Promotion gate: AI said ready, but re-validate with post-refinement fields first.
      // CONF_RISK and EST_TIME block promotion; LONG_DESC and DAVIDSON_REVIEW do not.
      if (fix.needsReview === false) {
        const refinedDesc     = patch.description ?? orig.description ?? '';
        const refinedMatter   = patch.matter      ?? orig.matter      ?? '';
        const refinedCategory = patch.category    ?? orig.category    ?? '';
        if (_refineHasBlockingFlag(refinedDesc, refinedMatter, refinedCategory)) {
          heldNR++; // keep at Needs Review — patch.status intentionally omitted
        } else {
          patch.status = 'Ready';
          promoted++;
        }
      }

      if (!Object.keys(patch).length) continue;

      const result = await api('PUT', `/api/entries/${orig.id}`, patch);
      Object.assign(orig, result);
      updated++;
    }

    renderStagingTable();

    if (updated > 0) {
      // Build detail line for the toast
      const parts = [];
      if (promoted > 0) parts.push(`${promoted} → Ready`);
      if (heldNR  > 0) parts.push(`${heldNR} kept at Needs Review (flags remaining)`);
      const detail = parts.length ? ' · ' + parts.join(', ') : '';

      _showRefineUndoToast(
        `Refine complete — ${updated} of ${count} ${updated !== 1 ? 'entries' : 'entry'} updated.${detail}`
      );
    } else {
      _refineSnapshot = null;
      _showInfoToast(
        `Refine complete — no changes needed for ${count} ${entryWord}.`,
        'navy'
      );
    }
  } catch (err) {
    console.error('[refineNeedsReview]', err);
    _refineSnapshot = null; // discard snapshot — nothing was applied
    _showInfoToast('Refine failed: ' + err.message, 'red');
  } finally {
    if (btn) { btn.textContent = '⟳ Refine Needs Review'; btn.disabled = false; }
  }
}

// Show a persistent undo toast for the last refine operation (60-second window)
function _showRefineUndoToast(message) {
  // Dismiss any existing refine toast before showing a new one
  if (_refineUndoToastId) _dismissRefineToast(_refineUndoToastId);

  const area = document.getElementById('deleteToastArea');
  if (!area) return;

  const toastId = 'refineUndo_' + Date.now();
  _refineUndoToastId = toastId;

  const div = document.createElement('div');
  div.id = toastId;
  div.className = 'refine-undo-toast';
  div.innerHTML = `
    <span class="toast-msg" style="flex:1">${message}</span>
    <button class="toast-undo-btn" onclick="undoRefine('${toastId}')">↩ Undo Refine</button>
    <button class="toast-dismiss-btn" onclick="_dismissRefineToast('${toastId}')" title="Dismiss">×</button>
    <div class="approve-progress" style="animation-duration:60s"></div>`;
  area.appendChild(div);

  // Auto-clear after 60 s
  _refineUndoTimer = setTimeout(() => {
    _dismissRefineToast(toastId);
    _refineSnapshot    = null;
    _refineUndoToastId = null;
    _refineUndoTimer   = null;
  }, 60000);
}

// Dismiss the refine undo toast and cancel the auto-clear timer
function _dismissRefineToast(toastId) {
  document.getElementById(toastId)?.remove();
  clearTimeout(_refineUndoTimer);
  _refineUndoTimer   = null;
  _refineUndoToastId = null;
}

// Restore all entries to their pre-refine state from the snapshot
async function undoRefine(toastId) {
  const snapshot = _refineSnapshot; // capture before clearing
  if (!snapshot) return;

  // Tear down the undo UI immediately
  _dismissRefineToast(toastId);
  _refineSnapshot = null;

  let restored = 0;
  for (const snap of snapshot) {
    const patch = {
      description: snap.description,
      category:    snap.category,
      matter:      snap.matter,
      client:      snap.client,
      rate:        snap.rate,
      status:      snap.status,
    };
    try {
      const result = await api('PUT', `/api/entries/${snap.id}`, patch);
      const e = stagingEntries.find(x => x.id === snap.id);
      if (e) Object.assign(e, result);
      restored++;
    } catch (err) {
      console.error(`[undoRefine] failed to restore entry ${snap.id}:`, err);
    }
  }

  renderStagingTable();
  _showInfoToast(
    `Refine undone — ${restored} ${restored !== 1 ? 'entries' : 'entry'} restored.`,
    'navy'
  );
}

// ── AUDIT ──────────────────────────────────────────────────────────────────
// Flag sort priority — lower number = appears first in results table
const AUDIT_FLAG_PRIORITY = {
  CONFIDENTIALITY_RISK: 0,
  DUPLICATE:            1,
  SWAPPED_COLUMNS:      2,
  MISSING:              3,
  MISSING_MATTER:       3,
  RATE_MISMATCH:        4,
  RATE_ANOMALY:         4,
  SHORT_NOTE:           5,
};

function _auditBadge(type) {
  if (type === 'CONFIDENTIALITY_RISK') return '<span class="badge badge-error" style="background:#fde8e8;color:#991b1b;border:1px solid #fca5a5;font-weight:700">⚠ Confidentiality Risk</span>';
  if (type === 'DUPLICATE')            return '<span class="badge badge-duplicate">Duplicate</span>';
  if (type === 'MISSING')              return '<span class="badge badge-missing">Missing</span>';
  if (type === 'MISSING_MATTER')       return '<span class="badge badge-missing">Missing Matter</span>';
  if (type === 'RATE_MISMATCH')        return '<span class="badge badge-error">Rate Mismatch</span>';
  if (type === 'RATE_ANOMALY')         return '<span class="badge badge-error">Rate Anomaly</span>';
  if (type === 'SWAPPED_COLUMNS')      return '<span class="badge badge-swapped">Swapped Columns</span>';
  if (type === 'SHORT_NOTE')           return '<span class="badge badge-review">Short Note</span>';
  return `<span class="badge badge-review">${type}</span>`;
}

function _renderAuditTable(flags, wrapId, headerId, tableId, noIssuesMsg, sourceFile) {
  const wrapper  = document.getElementById(wrapId);
  const headerEl = document.getElementById(headerId);
  const tableEl  = document.getElementById(tableId);
  wrapper.style.display = 'block';
  if (!flags || !flags.length) {
    if (headerEl) headerEl.textContent = headerId.includes('ar') ? 'AR Audit Results — No Issues Found' : 'General Audit Results — No Issues Found';
    tableEl.innerHTML = `<div style="color:var(--green);font-weight:500;padding:14px">${noIssuesMsg}</div>`;
    return;
  }

  // Sort by severity: CONFIDENTIALITY_RISK first, then other flags by priority rank
  const sorted = [...flags].sort((a, b) => {
    const pa = AUDIT_FLAG_PRIORITY[a.type] ?? 9;
    const pb = AUDIT_FLAG_PRIORITY[b.type] ?? 9;
    return pa - pb;
  });

  if (headerEl) headerEl.textContent = `${headerEl.textContent.split('—')[0].trim()} — ${sorted.length} issue${sorted.length !== 1 ? 's' : ''} found`;
  const showSource = !!sourceFile;
  tableEl.innerHTML = `
    <div class="staging-wrap">
      <table>
        <thead><tr>
          ${showSource ? '<th style="width:160px">Source File</th>' : ''}
          <th style="width:160px">Issue Type</th>
          <th style="width:180px">Row / Entry</th>
          <th>Details</th>
          <th>Recommendation</th>
        </tr></thead>
        <tbody>${sorted.map(f => {
          const isConfidentiality = f.type === 'CONFIDENTIALITY_RISK';
          const rowStyle = isConfidentiality ? 'background:#fff5f5;border-left:3px solid #ef4444' : '';
          return `<tr class="audit-issue-row" style="${rowStyle}">
            ${showSource ? `<td style="font-size:11px;color:var(--text-muted);font-style:italic;white-space:nowrap">${sourceFile}</td>` : ''}
            <td>${_auditBadge(f.type)}</td>
            <td style="font-size:11px;font-family:monospace;white-space:pre-wrap">${f.row || '—'}</td>
            <td style="font-size:12px">${f.details || '—'}</td>
            <td style="font-size:12px;color:var(--text-muted)">${f.recommendation || '—'}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
}

// — Mode 1: AR Export Audit —
let _arAuditFile = null;

function arAuditFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  _arAuditFile = file;
  const nameEl = document.getElementById('ar-audit-filename');
  if (nameEl) nameEl.textContent = file.name;
}

async function runArAudit() {
  if (!_arAuditFile) { alert('Please select a file first.'); return; }
  const statusEl = document.getElementById('ar-audit-status');
  statusEl.innerHTML = '<span class="ai-loading"><span class="spin">⟳</span> Comparing against AR records…</span>';
  document.getElementById('arAuditResults').style.display = 'none';
  const fd = new FormData();
  fd.append('file', _arAuditFile);
  try {
    const res = await fetch('/api/audit/upload', { method: 'POST', body: fd });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || res.statusText); }
    const { flags, fileName } = await res.json();
    statusEl.innerHTML = `<span style="color:var(--green)">✓ Audit complete for <strong>${fileName}</strong></span>`;
    document.getElementById('arAuditResultsHeader').textContent = 'AR Audit Results';
    _renderAuditTable(flags, 'arAuditResults', 'arAuditResultsHeader', 'arAuditTable',
      '✓ No issues found — the uploaded file matches AR records.');
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">Audit failed: ${e.message}</span>`;
  }
}

// — Mode 2: General Invoice Audit —
let _genAuditFile = null;

function genAuditFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  _genAuditFile = file;
  const nameEl = document.getElementById('gen-audit-filename');
  if (nameEl) nameEl.textContent = file.name;
}

async function runGenAudit() {
  if (!_genAuditFile) { alert('Please select a file first.'); return; }
  const statusEl = document.getElementById('gen-audit-status');
  statusEl.innerHTML = '<span class="ai-loading"><span class="spin">\u27f3</span> Starting audit\u2026</span>';
  document.getElementById('genAuditResults').style.display = 'none';
  const fd = new FormData();
  fd.append('file', _genAuditFile);
  try {
    const res = await fetch('/api/audit/general', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }

    // Backend streams progress + result via SSE (keeps timeout/chunking fixes)
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const ev of events) {
        const line = ev.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }

        if (data.type === 'progress') {
          statusEl.innerHTML = `<span class="ai-loading"><span class="spin">\u27f3</span> ${data.msg || `Analysing batch ${data.batch} of ${data.total}\u2026`}</span>`;
        } else if (data.type === 'result') {
          statusEl.innerHTML = `<span style="color:var(--green)">\u2713 Audit complete for <strong>${data.fileName}</strong></span>`;
          document.getElementById('genAuditResultsHeader').textContent = 'General Audit Results';
          _renderAuditTable(data.flags, 'genAuditResults', 'genAuditResultsHeader', 'genAuditTable',
            '\u2713 No issues found \u2014 the file looks clean.', data.fileName);
        } else if (data.type === 'batchError') {
          statusEl.innerHTML += ` <span style="color:var(--red);font-size:11px">(batch ${data.batch} failed \u2014 partial results may be shown)</span>`;
        } else if (data.type === 'error') {
          throw new Error(data.error);
        }
      }
    }
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">Audit failed: ${e.message}</span>`;
  }
}

// ── SESSION BANNER ─────────────────────────────────────────────────────────
async function refreshBanner() {
  try {
    const { entryCount, totalBillable } = await api('GET', '/api/status');
    document.getElementById('sb-count').textContent    = entryCount;
    document.getElementById('sb-billable').textContent = '$' + totalBillable.toFixed(2);
    const now = new Date();
    document.getElementById('sb-time').textContent =
      'Last refreshed ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    document.getElementById('sb-time').textContent = 'refresh failed';
  }
}

// ── BOOT ───────────────────────────────────────────────────────────────────
init();
refreshBanner();
setInterval(refreshBanner, 30000);
