// Global variables for Student Picker and Online Test configuration
var _spAllStudents = [];
var _spSelectedRolls = new Set();
var _spDrillClass = null;
var _spDrillSection = null;
var _spOnConfirm = null;

var _otSelectedRolls = [];
var _otStrictEnabled = false;

// Fallback helper functions
var _otEscapeHtml = window.escapeHtml || function(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

var _otEscapeForOnclickString = window.escapeForOnclickString || function(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'");
};

/* ═══════════════════════════════════════════════════════════
   DATETIME PICKER ROUTINES
   ═══════════════════════════════════════════════════════════ */

var _dtField = null;      // 'live' | 'ends'
var _dtYear  = null;
var _dtMonth = null;      // 0-based
var _dtSelY  = null;
var _dtSelM  = null;
var _dtSelD  = null;
var _dtSelH  = null;
var _dtSelMin = null;

function openDtPicker(field) {
    _dtField = field;
    // Pre-fill from existing hidden value if any
    const existing = document.getElementById(`ot-${field}-at`)?.value;
    const base = existing ? new Date(existing) : new Date();
    _dtYear  = base.getFullYear();
    _dtMonth = base.getMonth();
    if (existing && !isNaN(base)) {
        _dtSelY   = base.getFullYear();
        _dtSelM   = base.getMonth();
        _dtSelD   = base.getDate();
        _dtSelH   = base.getHours();
        _dtSelMin = base.getMinutes();
    } else {
        _dtSelY = _dtSelM = _dtSelD = _dtSelH = _dtSelMin = null;
    }
    _dtRender();
    const overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });
}

function _dtClose() {
    const overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 200);
    _dtField = null;
}

function _dtRender() {
    const box = document.getElementById('dt-picker-box');
    if (!box) return;
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    const DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const today  = new Date();
    const firstDay = new Date(_dtYear, _dtMonth, 1).getDay();
    const daysInMonth = new Date(_dtYear, _dtMonth + 1, 0).getDate();

    // Build calendar grid
    let cells = '';
    // Day headers
    cells += DAYS.map(d => `<div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-align:center;padding:4px 0">${d}</div>`).join('');
    // Empty lead cells
    for (let i = 0; i < firstDay; i++) cells += '<div></div>';
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
        const isSelected = (_dtSelY === _dtYear && _dtSelM === _dtMonth && _dtSelD === d);
        const isToday    = (today.getFullYear() === _dtYear && today.getMonth() === _dtMonth && today.getDate() === d);
        const bg    = isSelected ? 'var(--accent)' : isToday ? 'rgba(86,169,255,0.13)' : 'transparent';
        const col   = isSelected ? '#fff' : 'var(--text)';
        const fw    = (isSelected || isToday) ? '700' : '400';
        const bord  = isToday && !isSelected ? '1.5px solid var(--accent)' : '1.5px solid transparent';
        cells += `<div onclick="_dtPickDay(${d})" style="text-align:center;padding:7px 2px;border-radius:8px;cursor:pointer;font-size:0.85rem;background:${bg};color:${col};font-weight:${fw};border:${bord};transition:background .12s" onmouseover="if(!${isSelected})this.style.background='rgba(86,169,255,0.18)'" onmouseout="this.style.background='${bg}'">${d}</div>`;
    }

    // Time pickers
    const hVal  = _dtSelH  !== null ? String(_dtSelH).padStart(2,'0')  : '--';
    const mVal  = _dtSelMin !== null ? String(_dtSelMin).padStart(2,'0') : '--';

    // Hour options
    let hOpts = '';
    for (let h = 0; h < 24; h++) {
        const label = String(h).padStart(2,'0');
        const sel   = _dtSelH === h;
        hOpts += `<option value="${h}" ${sel ? 'selected' : ''}>${label}</option>`;
    }
    // Minute options (every 5 min)
    let mOpts = '';
    for (let m = 0; m < 60; m += 5) {
        const label = String(m).padStart(2,'0');
        const sel   = _dtSelMin !== null && Math.round(_dtSelMin/5)*5 % 60 === m;
        mOpts += `<option value="${m}" ${sel ? 'selected' : ''}>${label}</option>`;
    }

    const canConfirm = (_dtSelY !== null && _dtSelD !== null && _dtSelH !== null && _dtSelMin !== null);
    const fieldLabel = _dtField === 'live' ? '🟢 Goes Live At' : '🔴 Last Attempt By';

    box.innerHTML = `
      <div style="padding:16px 18px 10px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:0.85rem;font-weight:700;color:var(--text)">${fieldLabel}</span>
          <button onclick="_dtClose()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:7px;width:26px;height:26px;cursor:pointer;color:var(--text-muted);font-size:0.85rem;display:flex;align-items:center;justify-content:center" onmouseover="this.style.background='rgba(255,107,107,0.15)';this.style.color='#ff6b6b'" onmouseout="this.style.background='rgba(255,255,255,0.06)';this.style.color='var(--text-muted)'">✕</button>
        </div>
      </div>
      <div style="padding:14px 16px">
        <!-- Month navigation -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <button onclick="_dtPrevMonth()" style="background:var(--bg-input);border:1.5px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text);font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all .13s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">‹</button>
          <span style="font-size:0.9rem;font-weight:700;color:var(--text)">${MONTHS[_dtMonth]} ${_dtYear}</span>
          <button onclick="_dtNextMonth()" style="background:var(--bg-input);border:1.5px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text);font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all .13s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">›</button>
        </div>
        <!-- Calendar grid -->
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:14px">
          ${cells}
        </div>
        <!-- Time row -->
        <div style="display:flex;align-items:center;gap:8px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:14px">
          <span style="font-size:0.85rem;color:var(--text-muted);flex-shrink:0">⏰ Time</span>
          <select onchange="_dtSetHour(this.value)" style="flex:1;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;color:var(--text);font-size:0.88rem;font-family:inherit;outline:none;cursor:pointer">${hOpts}</select>
          <span style="color:var(--text-muted);font-weight:700">:</span>
          <select onchange="_dtSetMin(this.value)" style="flex:1;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;color:var(--text);font-size:0.88rem;font-family:inherit;outline:none;cursor:pointer">${mOpts}</select>
        </div>
        <!-- Confirm button -->
        <button onclick="_dtConfirm()" ${canConfirm ? '' : 'disabled'} style="width:100%;padding:10px;background:${canConfirm ? 'linear-gradient(135deg,var(--accent),var(--accent-2))' : 'var(--bg-input)'};border:none;border-radius:10px;color:${canConfirm ? '#fff' : 'var(--text-muted)'};font-size:0.88rem;font-weight:700;font-family:inherit;cursor:${canConfirm ? 'pointer' : 'not-allowed'};transition:all .15s;box-shadow:${canConfirm ? '0 4px 14px rgba(86,169,255,0.25)' : 'none'}">
          ${canConfirm ? '✅ Confirm' : 'Select a date & time'}
        </button>
      </div>`;
}

function _dtPrevMonth() {
    _dtMonth--;
    if (_dtMonth < 0) { _dtMonth = 11; _dtYear--; }
    _dtRender();
}
function _dtNextMonth() {
    _dtMonth++;
    if (_dtMonth > 11) { _dtMonth = 0; _dtYear++; }
    _dtRender();
}
function _dtPickDay(d) {
    _dtSelY = _dtYear; _dtSelM = _dtMonth; _dtSelD = d;
    // Default time to 09:00 if not yet set
    if (_dtSelH === null)   _dtSelH   = 9;
    if (_dtSelMin === null) _dtSelMin = 0;
    _dtRender();
}
function _dtSetHour(v)  { _dtSelH   = parseInt(v, 10); _dtRender(); }
function _dtSetMin(v)   { _dtSelMin = parseInt(v, 10); _dtRender(); }

function _dtConfirm() {
    if (_dtSelY === null || _dtSelD === null || _dtSelH === null || _dtSelMin === null) return;
    const dt = new Date(_dtSelY, _dtSelM, _dtSelD, _dtSelH, _dtSelMin);
    // Store as ISO string in the hidden input
    const iso = `${_dtSelY}-${String(_dtSelM+1).padStart(2,'0')}-${String(_dtSelD).padStart(2,'0')}T${String(_dtSelH).padStart(2,'0')}:${String(_dtSelMin).padStart(2,'0')}`;
    const hidden = document.getElementById(`ot-${_dtField}-at`);
    if (hidden) { hidden.value = iso; hidden.dispatchEvent(new Event('change', {bubbles:true})); }
    _dtClose();
}

// Close picker when clicking outside the box
document.addEventListener('click', function(e) {
    const overlay = document.getElementById('dt-picker-overlay');
    const box     = document.getElementById('dt-picker-box');
    if (overlay && overlay.style.display === 'flex' && box && !box.contains(e.target)) {
        // Only close if the click was on the overlay backdrop, not on the display trigger
        const liveDisplay = document.getElementById('ot-live-display');
        const endsDisplay = document.getElementById('ot-ends-display');
        if (e.target === overlay || (liveDisplay && !liveDisplay.contains(e.target) && endsDisplay && !endsDisplay.contains(e.target) && !box.contains(e.target) && e.target.closest('#dt-picker-overlay'))) {
            _dtClose();
        }
    }
});

function _otFmtDt(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
        d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function otUpdateScheduleGap() {
    const lv = document.getElementById('ot-live-at')?.value;
    const ev = document.getElementById('ot-ends-at')?.value;
    const gap = document.getElementById('ot-schedule-gap');
    const lp = document.getElementById('ot-live-preview');
    const ep = document.getElementById('ot-ends-preview');
    const lText = document.getElementById('ot-live-display-text');
    const eText = document.getElementById('ot-ends-display-text');

    if (lText) lText.textContent = lv ? _otFmtDt(lv) : 'Select date & time';
    if (eText) eText.textContent = ev ? _otFmtDt(ev) : 'Select date & time';
    if (lp) lp.textContent = _otFmtDt(lv);
    if (ep) ep.textContent = _otFmtDt(ev);
    if (!gap) return;
    if (!lv || !ev) { gap.style.display = 'none'; return; }
    const diff = new Date(ev) - new Date(lv);
    if (diff <= 0) { 
        gap.style.display = 'block'; 
        gap.textContent = '⚠ End time must be after start time'; 
        gap.style.color = 'var(--error)'; 
        return; 
    }
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    let s = '🗓 Window: ';
    if (days) s += `${days}d `;
    if (hrs) s += `${hrs}h `;
    if (mins) s += `${mins}m`;
    gap.textContent = s.trim() || '< 1 minute';
    gap.style.color = 'var(--accent)';
    gap.style.display = 'block';
}

// Support alias expected by choosePaperType
function _otUpdateScheduleGap() {
    otUpdateScheduleGap();
}

function otUpdateDurPreview() {
    const durationInput = document.getElementById('ot-duration');
    const preview = document.getElementById('ot-dur-preview');
    if (!durationInput || !preview) return;
    const minutes = Math.max(5, parseInt(durationInput.value || '0', 10) || 0);
    preview.textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ''} duration` : `${minutes} minute${minutes === 1 ? '' : 's'} duration`;
}

document.addEventListener('change', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});

document.addEventListener('input', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});

/* ═══════════════════════════════════════════════════════════
   STRICT MODE ROUTINES
   ═══════════════════════════════════════════════════════════ */
function _updateStrictLabel() {
    const toggle = document.getElementById('ot-strict-toggle');
    const thumb = document.getElementById('ot-strict-thumb');
    const text = document.getElementById('ot-strict-text');
    if (toggle) {
        toggle.style.background = _otStrictEnabled ? 'var(--success)' : 'rgba(255,255,255,0.1)';
        toggle.style.borderColor = _otStrictEnabled ? 'var(--success)' : 'var(--border)';
    }
    if (thumb) {
        thumb.style.transform = _otStrictEnabled ? 'translateX(16px)' : 'translateX(0)';
        thumb.style.background = _otStrictEnabled ? '#fff' : 'var(--text-muted)';
    }
    if (text) text.textContent = _otStrictEnabled ? 'Strict Mode On' : 'Disabled';
}

function toggleStrictMode() {
    _otStrictEnabled = !_otStrictEnabled;
    _updateStrictLabel();
}

/* ═══════════════════════════════════════════════════════════
   STUDENT PICKER MODAL ROUTINES
   ═══════════════════════════════════════════════════════════ */
function openStudentPicker(initialRolls = []) {
    _spAllStudents = Array.isArray(allStudents) ? allStudents : [];
    _spSelectedRolls = new Set(initialRolls);
    _spDrillClass = null;
    _spDrillSection = null;

    const modal = document.getElementById('student-picker-modal');
    if (modal) modal.style.display = 'flex';

    if (typeof _spRender === 'function') {
        _spRender();
    }
}

function closeStudentPicker() {
    const modal = document.getElementById('student-picker-modal');
    if (modal) modal.style.display = 'none';
}

function confirmStudentSelection() {
    if (typeof _spOnConfirm === 'function') {
        _spOnConfirm([..._spSelectedRolls]);
    }
    closeStudentPicker();
}

function openStudentPickerForOnlineTest() {
    _spOnConfirm = function (rolls) {
        _otSelectedRolls = rolls;
        _otUpdateAssignedSummary();
    };
    openStudentPicker(_otSelectedRolls);
}

function _otUpdateAssignedSummary() {
    const el = document.getElementById('ot-assigned-summary');
    if (!el) return;
    if (!_otSelectedRolls.length) {
        el.innerHTML = 'No students selected yet.';
        return;
    }
    el.innerHTML = `<span style="color:var(--success);font-weight:700">${_otSelectedRolls.length} student${_otSelectedRolls.length !== 1 ? 's' : ''} selected</span>
    <span style="color:var(--text-muted);margin-left:6px;font-size:0.78rem">${_otSelectedRolls.slice(0, 8).join(', ')}${_otSelectedRolls.length > 8 ? ` …+${_otSelectedRolls.length - 8} more` : ''}</span>`;
}

function closeOnlineTestDetails() {
    const modal = document.getElementById('online-test-details-modal');
    if (modal) modal.style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════
   ASSIGN ONLINE TEST SUBMISSION (BASKET PATH)
   ═══════════════════════════════════════════════════════════ */
async function assignOnlineTest() {
    const testName = document.getElementById('ot-name')?.value.trim();
    if (!testName) {
        showOtError('Please enter a test name.');
        return;
    }

    const marksCorrect = parseInt(document.getElementById('ot-marks-correct')?.value, 10) || 4;
    const marksWrong = parseInt(document.getElementById('ot-marks-wrong')?.value, 10) || -1;
    const liveAtVal = document.getElementById('ot-live-at')?.value;
    const endsAtVal = document.getElementById('ot-ends-at')?.value;
    const durationMinutes = parseInt(document.getElementById('ot-duration')?.value, 10) || 90;
    const maxAttempts = parseInt(document.getElementById('ot-max-attempts')?.value, 10) || 1;
    const isStrict = !!_otStrictEnabled;

    if (!liveAtVal || !endsAtVal) {
        showOtError('Please select both start and end date/time.');
        return;
    }
    const liveAt = new Date(liveAtVal).getTime();
    const endsAt = new Date(endsAtVal).getTime();

    if (endsAt <= liveAt) {
        showOtError('End time must be after start time.');
        return;
    }

    if (!_otSelectedRolls.length) {
        showOtError('Please select at least one student.');
        return;
    }

    if (typeof paperBasket === 'undefined' || !paperBasket || !paperBasket.size) {
        showOtError('Your question basket is empty.');
        return;
    }

    const questionKeys = [...paperBasket.values()].map(item => ({
        chapter: item.chapter === '(No Chapter)' ? '' : (item.chapter || ''),
        lecture: item.lecture,
        questionIndex: item.questionIndex
    }));

    const assignBtn = document.getElementById('ot-assign-btn');
    if (assignBtn) {
        assignBtn.disabled = true;
        assignBtn.textContent = '⏳ Assigning…';
    }

    showOtError(''); // Clear any previous error

    try {
        const resp = await fetch(`${API_BASE}/api/admin/online-tests`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                testName,
                questionKeys,
                marksCorrect,
                marksWrong,
                liveAt,
                endsAt,
                durationMinutes,
                assignedRolls: _otSelectedRolls,
                maxAttempts,
                isStrict
            })
        });

        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'Failed to assign online test');

        closeOnlineTestDetails();
        
        // Reset basket
        if (typeof clearPaperBasket === 'function') {
            clearPaperBasket();
        }

        if (typeof showToast === 'function') {
            showToast(`✅ Online test assigned to ${_otSelectedRolls.length} student${_otSelectedRolls.length !== 1 ? 's' : ''}!`, 'success');
        } else if (typeof showSuccessModal === 'function') {
            showSuccessModal('Success', `Online test assigned to ${_otSelectedRolls.length} students.`);
        } else {
            alert('Online test assigned successfully.');
        }
    } catch (err) {
        showOtError(err.message || 'Failed to assign online test');
    } finally {
        if (assignBtn) {
            assignBtn.disabled = false;
            assignBtn.textContent = '🚀 Assign Test';
        }
    }
}

function showOtError(msg) {
    const errEl = document.getElementById('ot-error');
    if (!errEl) return;
    if (msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
    } else {
        errEl.style.display = 'none';
    }
}
