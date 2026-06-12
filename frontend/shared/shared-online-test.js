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
function openDtPicker(field) {
    const input = document.getElementById(`ot-${field}-at`);
    if (!input) return;
    if (typeof input.showPicker === 'function') input.showPicker();
    input.focus();
}

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
