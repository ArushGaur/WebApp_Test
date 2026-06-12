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
   DATETIME PICKER ROUTINES  (custom overlay — works on all browsers)
   ═══════════════════════════════════════════════════════════ */

var _dtPickerField = null; // 'live' | 'ends'

function openDtPicker(field) {
    _dtPickerField = field;
    const hiddenInput = document.getElementById(`ot-${field}-at`);
    const existingVal = hiddenInput ? hiddenInput.value : '';

    // Build the custom picker box content
    const overlay = document.getElementById('dt-picker-overlay');
    const box     = document.getElementById('dt-picker-box');
    if (!overlay || !box) {
        // Fallback: show native input if custom overlay not present
        if (hiddenInput) {
            hiddenInput.style.cssText = 'position:static;opacity:1;pointer-events:auto;width:100%;padding:10px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:9px;color:var(--text);font-size:0.9rem;outline:none;';
            if (typeof hiddenInput.showPicker === 'function') {
                try { hiddenInput.showPicker(); } catch(e) {}
            }
        }
        return;
    }

    const label = field === 'live' ? '📅 Goes Live At' : '⏰ Last Attempt By';
    const accentColor = field === 'live' ? 'var(--success)' : 'var(--error)';

    // Split existing value into date and time parts
    let defaultDate = '', defaultTime = '08:00';
    if (existingVal) {
        const parts = existingVal.split('T');
        defaultDate = parts[0] || '';
        defaultTime = parts[1] ? parts[1].slice(0, 5) : '08:00';
    } else {
        // default to tomorrow
        const tomorrow = new Date(Date.now() + 86400000);
        defaultDate = tomorrow.toISOString().slice(0, 10);
    }

    box.innerHTML = `
        <div style="padding:20px 22px 16px;border-bottom:1px solid var(--border)">
            <div style="font-size:1rem;font-weight:800;color:var(--text);margin-bottom:2px">${label}</div>
            <div style="font-size:0.75rem;color:var(--text-muted)">Pick a date and time</div>
        </div>
        <div style="padding:18px 22px;display:flex;flex-direction:column;gap:14px">
            <div>
                <label style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:7px">📅 Date</label>
                <input id="_dt_date_input" type="date" value="${defaultDate}"
                    style="width:100%;padding:10px 14px;background:var(--bg-input);border:1.5px solid ${accentColor};border-radius:9px;color:var(--text);font-size:0.95rem;outline:none;font-family:inherit;box-sizing:border-box">
            </div>
            <div>
                <label style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:7px">⏰ Time</label>
                <input id="_dt_time_input" type="time" value="${defaultTime}"
                    style="width:100%;padding:10px 14px;background:var(--bg-input);border:1.5px solid ${accentColor};border-radius:9px;color:var(--text);font-size:0.95rem;outline:none;font-family:inherit;box-sizing:border-box">
            </div>
            <div style="display:flex;gap:10px;margin-top:4px">
                <button onclick="_dtPickerCancel()"
                    style="flex:1;padding:11px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:9px;color:var(--text);cursor:pointer;font-size:0.88rem;font-weight:700;font-family:inherit">
                    Cancel
                </button>
                <button onclick="_dtPickerConfirm()"
                    style="flex:2;padding:11px;background:linear-gradient(135deg,var(--accent),var(--accent-2));border:none;border-radius:9px;color:#fff;cursor:pointer;font-size:0.88rem;font-weight:800;font-family:inherit">
                    ✓ Confirm
                </button>
            </div>
        </div>`;

    overlay.style.display = 'flex';
    // Animate in
    setTimeout(() => { overlay.style.opacity = '1'; }, 10);
}

function _dtPickerConfirm() {
    const dateVal = document.getElementById('_dt_date_input')?.value;
    const timeVal = document.getElementById('_dt_time_input')?.value || '00:00';
    if (!dateVal) { _dtPickerCancel(); return; }

    const combined = `${dateVal}T${timeVal}`;
    const hiddenInput = document.getElementById(`ot-${_dtPickerField}-at`);
    if (hiddenInput) {
        hiddenInput.value = combined;
        // Fire change event so otUpdateScheduleGap picks it up
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    _dtPickerClose();
}

function _dtPickerCancel() {
    _dtPickerClose();
}

function _dtPickerClose() {
    const overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 200);
    _dtPickerField = null;
}

// Close on overlay backdrop click
document.addEventListener('click', function(e) {
    const overlay = document.getElementById('dt-picker-overlay');
    if (overlay && e.target === overlay) _dtPickerClose();
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
    if (modal) { modal.style.display = 'none'; }
    // Also reset strict mode and selected students for next open
    _otStrictEnabled = false;
    _updateStrictLabel();
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
