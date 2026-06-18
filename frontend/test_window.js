/* ══ Bootstrap: declare shared globals FIRST so all subsequent scripts can use them ══ */
                const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
                    ? 'http://' + location.host : '';
                let _token = localStorage.getItem('gp_student_token') || '';
                let _student = null;
                let _pendingRoll = localStorage.getItem('gp_pending_roll') || '';
                let _isRequestMode = false;
                let _instituteCode = new URLSearchParams(window.location.search).get('institute') || localStorage.getItem('gp_institute_code') || 'DEFAULT';
                if (_instituteCode && _instituteCode !== 'DEFAULT') {
                    try { localStorage.setItem('gp_institute_code', _instituteCode); } catch (_) {}
                }
            


                /* ══ Globals shared across both script blocks ══ */
                /* API_BASE, _token, _student are declared in the main block below,
                   but JS hoisting means function bodies only read them at call time — fine. */

                /* ══════════════════════════════════
                   JEE TEST PORTAL ENGINE  —  COMPLETE
                ══════════════════════════════════ */
                let _jeeQuestions = [];
                let _jeeCurrentIdx = 0;
                let _jeeAnswers = [];       // null=not visited, -1=visited unanswered, >=0=answered, array=multi
                let _jeeMarked = [];        // boolean: marked for review
                let _jeeTimerSec = 0;
                let _jeeTimerInt = null;
                let _jeeTestMeta = null;
                let _jeeStartTime = 0;
                let _jeeElapsedSec = 0;
                let _jeeScheme = true;      // true = +4/-1, false = +1/0
                let _jeeOnlineScheme = false; // true when online test has custom scheme
                let _jeeOnlineMarksCorrect = 4;
                let _jeeOnlineMarksWrong = -1;
                let _jeeReviewItems = [];   // cached for filter

                /* ── Numerical question detection (no text/images/tables in options) ── */
                function _isNumericalQ(q) {
                    if (!q) return false;
                    var opts = q.options || [];
                    var imgs = q.optionImages || [];
                    var tbls = _twGetOptionTables(q);
                    return opts.every(function (o) { return !o || String(o).trim() === ''; })
                        && imgs.every(function (i) { return !i; })
                        && tbls.every(function (t) { return !t; });
                }

                /* ── Marking scheme toggle ── */
                function jeeToggleScheme() {
                    _jeeScheme = !_jeeScheme;
                    const lbl = _jeeScheme ? '+4 / -1' : '+1 / 0';
                    const txt = _jeeScheme ? '+4 Correct · −1 Wrong · 0 Skip' : '+1 Correct · 0 Wrong · 0 Skip';
                    document.getElementById('jeeSchemeLbl').textContent = lbl;
                    document.getElementById('jeeSchemeText').textContent = txt;
                }

                /* ── Mobile palette toggle ── */
                function jeeTogglePalette() {
                    const panel = document.getElementById('jeeRightPanel');
                    const bd = document.getElementById('jeePaletteBackdrop');
                    panel.classList.toggle('open');
                    bd.classList.toggle('active');
                }

                /* ── Open portal ── */
                async function openJeePortal(chapter, lecture, meta) {
                    const token = _token;
                    if (!token) return;

                    // Online tests pass questions directly in meta.questions
                    // Star-quiz tests fetch from server
                    let questions = null;
                    let topicStr = '';

                    if (meta && meta.id && meta._isOnline) {
                        // Online test: fetch questions on-demand from dedicated endpoint (fast list + lazy load)
                        showStartLoader(meta);
                        setStartLoaderProgress(30, 'Loading questions…');
                        try {
                            const qRes = await fetch(`${API_BASE}/api/student/online-tests/${meta.id}/questions`, {
                                headers: { Authorization: `Bearer ${_token}` }
                            });
                            if (!qRes.ok) throw new Error('Failed to load questions');
                            const qData = await qRes.json();
                            questions = qData.questions || [];
                            topicStr = qData.testName || meta.testName || meta.topic || '';
                            // Use marks from the fetched data (authoritative)
                            if (typeof qData.marksCorrect === 'number') {
                                _jeeOnlineMarksCorrect = qData.marksCorrect;
                                _jeeOnlineMarksWrong = qData.marksWrong != null ? qData.marksWrong : 0;
                                _jeeOnlineScheme = true;
                            } else {
                                _jeeOnlineScheme = false;
                            }
                        } catch (e) {
                            hideStartLoader(0, 'Failed');
                            alert('Could not load test questions. Please try again.');
                            return;
                        }
                        if (!questions.length) {
                            hideStartLoader(0, 'No questions');
                            alert('No questions found in this test.');
                            return;
                        }
                        setStartLoaderProgress(100, 'Starting test…');
                        await new Promise(r => setTimeout(r, 300));
                    } else {
                        // Star-quiz test: fetch from server
                        _jeeOnlineScheme = false;
                        let res;
                        try {
                            showStartLoader(meta || { chapter, lecture, topic: '' });
                            if (Array.isArray(meta?.questions) && meta.questions.length) {
                                questions = meta.questions;
                                topicStr = meta.topic || meta.testName || '';
                            } else {
                                res = await fetch(`${API_BASE}/api/star-quiz/question/${encodeURIComponent(chapter)}/${encodeURIComponent(lecture)}`);
                                if (!res.ok) throw new Error('Not found');
                                const data = await res.json();
                                if (!data.questions || !data.questions.length) {
                                    hideStartLoader(0, 'No questions');
                                    alert('No questions in this test.');
                                    return;
                                }
                                questions = data.questions;
                                topicStr = data.topic || '';
                            }
                        } catch (e) {
                            hideStartLoader(0, 'Failed');
                            alert('Could not load test. Please try again.');
                            return;
                        }
                        setStartLoaderProgress(100, 'Starting test…');
                        await new Promise(resolve => setTimeout(resolve, 320));
                    }

                    hideStartLoader(100, 'Ready!');

                    _jeeQuestions = questions;
                    _jeeCurrentIdx = 0;
                    _jeeAnswers = new Array(_jeeQuestions.length).fill(null);
                    _jeeMarked = new Array(_jeeQuestions.length).fill(false);
                    _jeeTestMeta = { chapter: chapter || (meta?.testName || 'Test'), lecture: lecture || '', topic: topicStr, onlineTestId: meta?.id || null };
                    // Strict mode
                    window._jeeIsStrict = !!(meta?.isStrict);
                    window._jeeStrictWarnings = 0;
                    window._jeeStrictLocked = false;
                    if (window._jeeIsStrict) startStrictMonitor();
                    else stopStrictMonitor();
                    // Use teacher-set duration for online tests, else 90s/question default
                    if (meta && meta.durationMinutes) {
                        _jeeTimerSec = meta.durationMinutes * 60;
                    } else {
                        _jeeTimerSec = _jeeQuestions.length * 90;
                    }
                    _jeeStartTime = Date.now();
                    _jeeElapsedSec = 0;

                    document.getElementById('jee-portal').style.display = 'flex';
                    const infoLabel = meta && meta.id
                        ? `${meta.testName || 'Online Test'}`
                        : `${chapter} · L${lecture}${topicStr ? ' · ' + topicStr : ''}`;
                    document.getElementById('jeeTestInfo').textContent = infoLabel;

                    jeeRenderQ(0);
                    jeeRenderPalette();
                    jeeUpdateLiveTally();
                    jeeStartTimer();
                    // Block accidental refresh while test is active
                    if (typeof enableRefreshBlock === 'function') enableRefreshBlock();
                }

                /* ── Strict Mode Monitor ── */
                let _strictVisHandler = null;
                let _strictBlurHandler = null;

                function startStrictMonitor() {
                    stopStrictMonitor(); // clean up any previous
                    _strictVisHandler = function () {
                        if (document.hidden && window._jeeIsStrict && !window._jeeStrictLocked) {
                            handleStrictViolation();
                        }
                    };
                    _strictBlurHandler = function () {
                        if (window._jeeIsStrict && !window._jeeStrictLocked) {
                            handleStrictViolation();
                        }
                    };
                    document.addEventListener('visibilitychange', _strictVisHandler);
                    window.addEventListener('blur', _strictBlurHandler);
                }

                function stopStrictMonitor() {
                    if (_strictVisHandler) { document.removeEventListener('visibilitychange', _strictVisHandler); _strictVisHandler = null; }
                    if (_strictBlurHandler) { window.removeEventListener('blur', _strictBlurHandler); _strictBlurHandler = null; }
                }

                let _strictViolationCooldown = false;
                function handleStrictViolation() {
                    if (_strictViolationCooldown || window._jeeStrictLocked) return;
                    _strictViolationCooldown = true;
                    window._jeeStrictWarnings++;

                    const overlay = document.getElementById('strict-warning-overlay');
                    const icon = document.getElementById('strict-warn-icon');
                    const title = document.getElementById('strict-warn-title');
                    const body = document.getElementById('strict-warn-body');
                    const btn = document.getElementById('strict-warn-btn');

                    if (window._jeeStrictWarnings >= 3) {
                        // Lock the test
                        window._jeeStrictLocked = true;
                        stopStrictMonitor();
                        icon.textContent = '🔒';
                        title.textContent = 'Test Locked!';
                        title.style.color = '#ef4444';
                        body.innerHTML = 'You have been caught switching tabs or leaving this window <strong>3 times</strong>. Your test has been <strong style="color:#ef4444">locked and auto-submitted</strong> as per the strict test policy.';
                        btn.style.display = 'none';
                        overlay.style.display = 'flex';
                        document.getElementById('strict-warning-overlay').style.borderColor = '#ef4444';
                        document.getElementById('strict-warning-box').style.borderColor = '#ef4444';
                        document.getElementById('strict-warning-box').style.boxShadow = '0 0 60px rgba(239,68,68,0.35),0 24px 60px rgba(0,0,0,0.8)';
                        // Auto-submit after 3 seconds
                        setTimeout(() => { jeeDoSubmit(); }, 3000);
                    } else {
                        // Warning
                        const remaining = 3 - window._jeeStrictWarnings;
                        icon.textContent = '⚠️';
                        title.textContent = `Warning ${window._jeeStrictWarnings} of 2`;
                        title.style.color = '#fbbf24';
                        body.innerHTML = `You left the test window or switched to another tab.<br><br>
                            <strong style="color:#fbbf24">This is warning ${window._jeeStrictWarnings} of 2.</strong>
                            ${remaining === 1 ? '<br><span style="color:#ef4444;font-weight:700">⚠️ One more violation will permanently lock your test!</span>' : ''}`;
                        btn.style.display = 'inline-block';
                        btn.textContent = 'I Understand';
                        document.getElementById('strict-warning-box').style.borderColor = '#fbbf24';
                        document.getElementById('strict-warning-box').style.boxShadow = '0 0 60px rgba(251,191,36,0.3),0 24px 60px rgba(0,0,0,0.8)';
                        overlay.style.display = 'flex';
                    }
                    setTimeout(() => { _strictViolationCooldown = false; }, 2000);
                }

                function dismissStrictWarning() {
                    document.getElementById('strict-warning-overlay').style.display = 'none';
                }

                /* ── Timer ── */
                function jeeStartTimer() {
                    clearInterval(_jeeTimerInt);
                    jeeUpdateTimer();
                    _jeeTimerInt = setInterval(() => {
                        _jeeTimerSec--;
                        _jeeElapsedSec++;
                        if (_jeeTimerSec <= 0) { clearInterval(_jeeTimerInt); jeeDoSubmit(); return; }
                        jeeUpdateTimer();
                    }, 1000);
                }

                function jeeUpdateTimer() {
                    const h = Math.floor(_jeeTimerSec / 3600);
                    const m = Math.floor((_jeeTimerSec % 3600) / 60);
                    const s = _jeeTimerSec % 60;
                    const str = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    const el = document.getElementById('jeeTimer');
                    if (el) {
                        el.textContent = str;
                        el.style.color = _jeeTimerSec < 300 ? '#ef4444' : _jeeTimerSec < 600 ? '#fbbf24' : '#fbbf24';
                    }
                }

                /* ── Render question ── */
                function jeeRenderQ(idx) {
                    _jeeCurrentIdx = idx;

                    const q = _jeeQuestions[idx];
                    const isNumerical = _isNumericalQ(q);

                    // For numerical, don't auto-set -1; keep null until answered.
                    // For regular, keep existing behaviour.
                    if (!isNumerical && _jeeAnswers[idx] === null) _jeeAnswers[idx] = -1;

                    const ci = q.correctIndexes || [q.correctIndex || 0];
                    const ans = _jeeAnswers[idx];
                    const isMulti = q.isMultiCorrect || ci.length > 1;
                    const markedArr = Array.isArray(ans) ? ans : (ans >= 0 ? [ans] : []);

                    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
                    const optBg = (sel) => sel
                        ? (isLight ? 'rgba(29,111,216,0.08)' : 'rgba(96,200,255,0.1)')
                        : (isLight ? 'rgba(30,60,140,0.03)' : 'rgba(255,255,255,0.03)');
                    const optBorder = (sel) => sel
                        ? (isLight ? 'rgba(29,111,216,0.6)' : 'rgba(96,200,255,0.6)')
                        : (isLight ? 'rgba(30,60,140,0.15)' : 'rgba(255,255,255,0.1)');
                    const optColor = (sel) => sel
                        ? (isLight ? 'rgba(15,23,41,1)' : 'rgba(241,245,255,1)')
                        : (isLight ? 'rgba(15,23,41,0.85)' : 'rgba(241,245,255,0.85)');
                    const lblBg = (sel) => sel
                        ? (isLight ? 'rgba(29,111,216,0.15)' : 'rgba(96,200,255,0.25)')
                        : (isLight ? 'rgba(30,60,140,0.07)' : 'rgba(255,255,255,0.06)');
                    const lblColor = (sel) => sel
                        ? (isLight ? '#1d6fd8' : '#60c8ff')
                        : (isLight ? 'rgba(15,23,41,0.5)' : 'rgba(255,255,255,0.5)');
                    const qTextColor = isLight ? '#0f1729' : '#f1f5ff';
                    const subLblColor = isLight ? 'rgba(15,23,41,0.35)' : 'rgba(255,255,255,0.3)';

                    // ── Build input / options area ──
                    var answerAreaHtml = '';
                    if (isNumerical) {
                        var numVal = (ans !== null && ans !== -1) ? String(ans).replace(/,/g, '') : '';
                        var numAnswered = numVal !== '';
                        answerAreaHtml = `<div style="margin-bottom:16px">
                        <div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;color:${subLblColor};margin-bottom:11px;font-weight:700">Enter your answer:</div>
                        <div style="position:relative">
                            <input id="jee-num-input" type="text" inputmode="decimal" value="${escHtml(numVal)}"
                                placeholder="Type your answer…"
                                style="width:100%;background:${isLight ? '#fff' : 'rgba(255,255,255,0.05)'};border:2px solid ${numAnswered ? 'var(--success)' : 'var(--border)'};border-radius:12px;padding:14px 18px;color:${qTextColor};font-size:1.2rem;font-weight:600;outline:none;font-family:'JetBrains Mono',monospace;text-align:center;transition:border .15s;box-sizing:border-box"
                                onfocus="this.style.borderColor='var(--success)'"
                                onblur="this.style.borderColor=this.value.trim()?'var(--success)':'var(--border)'"
                                oninput="jeeHandleNumInput(this.value)">
                            <div style="margin-top:8px;font-size:0.78rem;color:${subLblColor}">Enter the numeric value (decimals allowed)</div>
                        </div>
                    </div>`;
                    } else {
                        const LTRS = ['A', 'B', 'C', 'D'];
                        const optImgs = Array.isArray(q.optionImages) ? q.optionImages : [];
                        const optTables = _twGetOptionTables(q);
                        const _optList = (q.options && q.options.length) ? q.options : (optTables.some(Boolean) ? [null, null, null, null] : (q.options || []));
                        var optsHtml = _optList.map((opt, oi) => {
                            const selected = markedArr.includes(oi);
                            const optImg = optImgs[oi] || null;
                            const optTbl = optTables[oi] || null;
                            const optImgHtml = optImg
                                ? `<img src="${optImg.startsWith('http') ? optImg : 'data:image/jpeg;base64,' + optImg}" style="display:block;max-width:100%;max-height:180px;object-fit:contain;border-radius:7px;margin-top:${opt ? '8px' : '2px'}">`
                                : '';
                            const optTblHtml = optTbl ? _twRenderSingleTable(optTbl) : '';
                            const optBody = optTblHtml || `${mdTablesToHtml(opt || '')}${optImgHtml}`;
                            return `<div onclick="jeeSelectOpt(${oi})" data-oi="${oi}" style="
                        padding:13px 16px;margin-bottom:9px;border-radius:11px;cursor:pointer;
                        border:1.5px solid ${optBorder(selected)};
                        background:${optBg(selected)};
                        display:flex;align-items:flex-start;gap:11px;transition:all .15s;
                        color:${optColor(selected)}
                    ">
                        <span style="width:27px;height:27px;border-radius:7px;background:${lblBg(selected)};display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;color:${lblColor(selected)};flex-shrink:0">${LTRS[oi]}</span>
                        <span style="font-size:0.88rem;line-height:1.6;padding-top:3px;flex:1;min-width:0">${optBody}</span>
                    </div>`;
                        }).join('');
                        answerAreaHtml = `<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;color:${subLblColor};margin-bottom:11px;font-weight:700">${isMulti ? 'Select ALL correct options:' : 'Select the correct option:'}</div>
                    ${optsHtml}`;
                    }

                    const _qImgSrc = q.questionImage
                        ? (q.questionImage.startsWith('http') || q.questionImage.startsWith('data:')
                            ? q.questionImage
                            : `data:image/jpeg;base64,${q.questionImage}`)
                        : null;
                    const imgHtml = _qImgSrc ? `<div style="margin-bottom:16px;border-radius:11px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);text-align:center"><img src="${_qImgSrc}" style="max-width:100%;max-height:260px;object-fit:contain;display:block;margin:0 auto"></div>` : '';

                    // Tables / matrices attached to this question
                    const _allTables = _normalizeTablesField(q.tables);
                    const _tablesAfterIntro = _allTables.filter(t => (t.position || 'after_intro') !== 'after_options');
                    const _tablesAfterOptions = _allTables.filter(t => (t.position || 'after_intro') === 'after_options');
                    const tablesIntroHtml = _tablesAfterIntro.length ? renderTablesHtml(_tablesAfterIntro) : '';
                    const tablesOptionsHtml = _tablesAfterOptions.length ? renderTablesHtml(_tablesAfterOptions) : '';

                    // Marks info badge
                    const schemeStr = _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect} / ${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4 / -1' : '+1 / 0');
                    const marksBadge = `<div style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.2);border-radius:8px;padding:4px 10px;font-size:0.72rem;color:#34d399;font-weight:700">${schemeStr}</div>`;

                    document.getElementById('jeeQArea').innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap">
                    <div style="background:linear-gradient(135deg,rgba(96,200,255,0.15),rgba(167,139,250,0.15));border:1px solid rgba(96,200,255,0.2);border-radius:9px;padding:5px 13px;font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:#60c8ff;font-weight:700">Q${idx + 1}</div>
                    ${q.subject ? `<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">${escHtml(q.subject)}</div>` : ''}
                    ${_jeeMarked[idx] ? '<div style="background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#a78bfa;font-weight:600">🔖 Marked</div>' : ''}
                    ${isMulti && !isNumerical ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">Multi-Select</div>' : ''}
                    ${isNumerical ? '<div style="background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.2);border-radius:9px;padding:4px 10px;font-size:0.72rem;color:#fbbf24;font-weight:600">Numerical</div>' : ''}
                    <div style="margin-left:auto">${marksBadge}</div>
                </div>
                <div style="font-size:0.97rem;line-height:1.8;color:${qTextColor};margin-bottom:22px;font-weight:500">${mdTablesToHtml(q.question || '')}</div>
                ${tablesIntroHtml}
                ${imgHtml}
                ${answerAreaHtml}
                ${tablesOptionsHtml}
            `;
                    // Render LaTeX in the question area
                    if (window.MathJax && window.MathJax.typesetPromise) {
                        window.MathJax.typesetPromise([document.getElementById('jeeQArea')]).catch(e => console.warn('MathJax error:', e));
                    }

                    document.getElementById('jeeQPos').textContent = `Q${idx + 1} of ${_jeeQuestions.length}`;
                    document.getElementById('jeePrevBtn').style.opacity = idx === 0 ? '0.4' : '1';
                    const nextLabel = idx === _jeeQuestions.length - 1 ? 'Save & Submit →' : 'Save & Next →';
                    document.getElementById('jeeNextBtn').textContent = nextLabel;
                    const mobileBtn = document.getElementById('jeeNextBtnMobile');
                    if (mobileBtn) mobileBtn.textContent = nextLabel;
                    const markBtn = document.getElementById('jeeMarkBtn');
                    if (markBtn) {
                        markBtn.style.background = _jeeMarked[idx] ? 'rgba(167,139,250,0.22)' : 'rgba(167,139,250,0.1)';
                        markBtn.style.color = _jeeMarked[idx] ? '#c4b5fd' : '#a78bfa';
                    }

                    jeeRenderPalette();
                    jeeUpdateLiveTally();
                }

                function jeeHandleNumInput(val) {
                    var idx = _jeeCurrentIdx;
                    var trimmed = val.replace(/[^0-9.\-]/g, '');
                    if (trimmed === '' || trimmed === '-' || trimmed === '.') {
                        _jeeAnswers[idx] = null;
                    } else {
                        _jeeAnswers[idx] = trimmed;
                    }
                    jeeRenderPalette();
                    jeeUpdateLiveTally();
                }

                function jeeSelectOpt(oi) {
                    const q = _jeeQuestions[_jeeCurrentIdx];
                    const ci = q.correctIndexes || [q.correctIndex || 0];
                    const isMulti = q.isMultiCorrect || ci.length > 1;
                    const cur = _jeeAnswers[_jeeCurrentIdx];
                    if (isMulti) {
                        let arr = Array.isArray(cur) ? [...cur] : [];
                        if (arr.includes(oi)) arr = arr.filter(x => x !== oi);
                        else arr.push(oi);
                        _jeeAnswers[_jeeCurrentIdx] = arr.length ? arr : -1;
                    } else {
                        _jeeAnswers[_jeeCurrentIdx] = cur === oi ? -1 : oi;
                    }
                    jeeRenderQ(_jeeCurrentIdx);
                }

                function jeeNav(dir) {
                    const next = _jeeCurrentIdx + dir;
                    if (next < 0 || next >= _jeeQuestions.length) {
                        if (dir > 0 && next >= _jeeQuestions.length) { jeeSubmitConfirm(); }
                        return;
                    }
                    jeeRenderQ(next);
                }

                function jeeMarkForReview() {
                    _jeeMarked[_jeeCurrentIdx] = !_jeeMarked[_jeeCurrentIdx];
                    jeeRenderQ(_jeeCurrentIdx);
                }

                function jeeClearResponse() {
                    var q = _jeeQuestions[_jeeCurrentIdx];
                    if (q && _isNumericalQ(q)) {
                        _jeeAnswers[_jeeCurrentIdx] = null;
                    } else {
                        _jeeAnswers[_jeeCurrentIdx] = -1;
                    }
                    jeeRenderQ(_jeeCurrentIdx);
                }

                function jeeRenderPalette() {
                    const pal = document.getElementById('jeeQPalette');
                    if (!pal) return;
                    pal.innerHTML = _jeeQuestions.map((q, i) => {
                        const ans = _jeeAnswers[i];
                        const marked = _jeeMarked[i];
                        const isAnswered = Array.isArray(ans) ? ans.length > 0 : ans !== null && ans !== -1;
                        const isVisited = ans !== null;
                        const isCurrent = i === _jeeCurrentIdx;
                        let bg = '#374151';
                        if (marked) bg = '#8b5cf6';
                        else if (isAnswered) bg = '#22c55e';
                        else if (isVisited) bg = '#ef4444';
                        return `<div onclick="jeeGoTo(${i})" style="
                    width:100%;aspect-ratio:1;border-radius:6px;background:${bg};
                    display:flex;align-items:center;justify-content:center;
                    font-size:0.7rem;font-weight:700;cursor:pointer;color:#fff;
                    transition:all .15s;
                    outline:${isCurrent ? '2.5px solid #60c8ff' : 'none'};
                    outline-offset:2px;
                    box-shadow:${isCurrent ? '0 0 8px rgba(96,200,255,0.4)' : 'none'};
                " onmouseover="this.style.transform='scale(1.12)'" onmouseout="this.style.transform=''">${i + 1}</div>`;
                    }).join('');
                }

                function jeeGoTo(i) {
                    // Close mobile palette if open
                    document.getElementById('jeeRightPanel').classList.remove('open');
                    document.getElementById('jeePaletteBackdrop').classList.remove('active');
                    jeeRenderQ(i);
                }

                function jeeUpdateLiveTally() {
                    const ans = document.getElementById('jeeLiveAns');
                    const skip = document.getElementById('jeeLiveSkip');
                    if (!ans) return;
                    const answered = _jeeAnswers.filter(a => Array.isArray(a) ? a.length > 0 : a !== null && a >= 0).length;
                    const skipped = _jeeAnswers.filter(a => a === -1).length;
                    ans.textContent = answered;
                    skip.textContent = _jeeAnswers.length - answered;
                    // Live wrong count is unknown without knowing correct answers; keep as —
                }

                function jeeSubmitConfirm() {
                    const answered = _jeeAnswers.filter(a => Array.isArray(a) ? a.length > 0 : a !== null && a >= 0).length;
                    const notAns = _jeeAnswers.filter(a => a === -1).length;
                    const notVis = _jeeAnswers.filter(a => a === null).length;
                    const marked = _jeeMarked.filter(Boolean).length;
                    const schemeNote = _jeeScheme ? `Marking: +4 correct, −1 wrong, 0 skipped` : `Marking: +1 correct, 0 wrong/skipped`;
                    document.getElementById('jeeSubmitInfo').innerHTML =
                        `<strong style="color:#f1f5ff">Answered:</strong> ${answered} &nbsp;
                 <strong style="color:#ef4444">Not Answered:</strong> ${notAns}<br>
                 <strong style="color:rgba(255,255,255,0.5)">Not Visited:</strong> ${notVis} &nbsp;
                 <strong style="color:#8b5cf6">Marked:</strong> ${marked}<br><br>
                 <span style="font-size:0.78rem;color:rgba(255,255,255,0.4)">${schemeNote}</span><br><br>
                 Are you sure you want to submit?`;
                    document.getElementById('jeeSubmitDlg').style.display = 'flex';
                }

                function jeeCloseDlg() {
                    document.getElementById('jeeSubmitDlg').style.display = 'none';
                }

                /* ── Grade helper ── */
                function jeeGrade(pct) {
                    if (pct >= 90) return { emoji: '🏆', label: 'Excellent!', color: '#22c55e' };
                    if (pct >= 75) return { emoji: '⭐', label: 'Great Job!', color: '#34d399' };
                    if (pct >= 60) return { emoji: '👍', label: 'Good Work', color: '#60c8ff' };
                    if (pct >= 40) return { emoji: '📚', label: 'Keep Practising', color: '#fbbf24' };
                    return { emoji: '💪', label: 'Keep Going!', color: '#ef4444' };
                }

                /* ── Format seconds to Xm Ys ── */
                function fmtTime(sec) {
                    const m = Math.floor(sec / 60), s = sec % 60;
                    return m > 0 ? `${m}m ${s}s` : `${s}s`;
                }

                /* ── Review filter state ── */
                let _resFilter = 'all';
                function jeeFilterReview(f) {
                    _resFilter = f;
                    ['all', 'correct', 'wrong', 'skipped'].forEach(k => {
                        const btn = document.getElementById('rf' + k.charAt(0).toUpperCase() + k.slice(1));
                        if (btn) btn.style.opacity = k === f ? '1' : '0.5';
                    });
                    jeeRenderReviewList();
                }

                function jeeRenderReviewList() {
                    const LTRS = ['A', 'B', 'C', 'D'];
                    const filtered = _resFilter === 'all' ? _jeeReviewItems : _jeeReviewItems.filter(r => r.status === _resFilter);
                    const list = document.getElementById('res-review-list');
                    const empty = document.getElementById('res-review-empty');
                    if (!filtered.length) {
                        list.innerHTML = '';
                        empty.style.display = 'block';
                        return;
                    }
                    empty.style.display = 'none';
                    list.innerHTML = filtered.map(({ q, ans, status, idx, ci }) => {
                        const ansArr = Array.isArray(ans) ? ans : (ans !== null && ans >= 0 ? [ans] : []);
                        const statusColor = status === 'correct' ? '#22c55e' : status === 'wrong' ? 'var(--error)' : 'var(--text-faint)';
                        const statusIcon = status === 'correct' ? '✓' : status === 'wrong' ? '✗' : '—';
                        const marksEarned = _jeeOnlineScheme
                            ? (status === 'correct' ? `+${_jeeOnlineMarksCorrect}` : status === 'wrong' ? `${_jeeOnlineMarksWrong}` : '0')
                            : (_jeeScheme
                                ? (status === 'correct' ? '+4' : status === 'wrong' ? '−1' : '0')
                                : (status === 'correct' ? '+1' : '0'));
                        const marksColor = status === 'correct' ? '#22c55e' : status === 'wrong' ? '#ef4444' : 'var(--text-faint)';
                        const solnHtml = q.solution
                            ? `<div style="margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(52,211,153,0.06);border:1px solid rgba(52,211,153,0.15);font-size:0.75rem;color:var(--text-dim);line-height:1.6"><span style="color:#34d399;font-weight:700">💡 </span>${mdTablesToHtml(q.solution)}</div>`
                            : '';

                        // ── Tables / matrices belonging to this question ──
                        // 1) Structured tables array (q.tables) rendered as HTML.
                        // 2) Markdown pipe-tables embedded inside the question text.
                        // When either is present we show the FULL question text (not the
                        // 120-char preview) so the table isn't sliced off.
                        const qFull = q.question || '';
                        const structuredTablesHtml = (Array.isArray(q.tables) && q.tables.length)
                            ? renderTablesHtml(q.tables) : '';
                        const hasMdTable = qFull.indexOf('|') !== -1 && /\n\s*\|?[\s:-]*-[\s:|-]*\n/.test('\n' + qFull + '\n');
                        const showFullQuestion = !!structuredTablesHtml || hasMdTable;
                        const qPreview = showFullQuestion
                            ? mdTablesToHtml(qFull)
                            : (qFull.substring(0, 120) + (qFull.length > 120 ? '…' : ''));
                        return `<div style="border-bottom:1px solid var(--border);padding:13px 8px;display:flex;gap:12px;align-items:flex-start">
                    <div style="background:${statusColor};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:800;color:#fff;flex-shrink:0;margin-top:2px">${statusIcon}</div>
                    <div style="flex:1;min-width:0">
                        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px">
                            <div style="font-size:0.83rem;color:var(--text-mid);font-weight:600;line-height:1.5">Q${idx + 1}: ${qPreview}</div>
                            <span style="font-size:0.78rem;font-weight:800;color:${marksColor};font-family:'JetBrains Mono',monospace;white-space:nowrap;flex-shrink:0">${marksEarned}</span>
                        </div>
                        ${structuredTablesHtml}
                        <div style="font-size:0.75rem;color:var(--text-faint);display:flex;flex-wrap:wrap;gap:12px">
                            <span>Your answer: <span style="color:${status === 'correct' ? '#22c55e' : status === 'wrong' ? '#ef4444' : 'var(--text-faint)'};font-weight:700">${_isNumericalQ(q) ? (ans !== null && ans !== -1 && String(ans).trim() !== '' ? escHtml(String(ans)) : 'Not attempted') : (ansArr.length ? ansArr.map(a => LTRS[a]).join(', ') : 'Not attempted')}</span></span>
                            <span>Correct: <span style="color:#22c55e;font-weight:700">${_isNumericalQ(q) ? escHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')) : ci.map(a => LTRS[a]).join(', ')}</span></span>
                        </div>
                        ${solnHtml}
                    </div>
                </div>`;
                    }).join('');
                    // Render LaTeX in review list
                    if (window.MathJax && window.MathJax.typesetPromise) {
                        window.MathJax.typesetPromise([list]).catch(e => console.warn('MathJax error:', e));
                    }
                }

                async function jeeDoSubmit() {
                    clearInterval(_jeeTimerInt);
                    jeeCloseDlg();
                    _jeeElapsedSec = Math.floor((Date.now() - _jeeStartTime) / 1000);

                    const chapter = _jeeTestMeta.chapter;
                    const lecture = _jeeTestMeta.lecture;

                    let correct = 0, wrong = 0, skipped = 0;
                    let marksScore = 0;
                    _jeeReviewItems = [];

                    _jeeQuestions.forEach((q, i) => {
                        const ans = _jeeAnswers[i];
                        const ci = q.correctIndexes || [q.correctIndex || 0];
                        const isNumerical = _isNumericalQ(q);
                        const ansArr = Array.isArray(ans) ? ans : (ans !== null && ans >= 0 ? [ans] : []);

                        let status = 'skipped';
                        if (q.isNoneCorrect === true) {
                            status = 'correct';
                        } else if (isNumerical) {
                            if (ans !== null && ans !== -1 && String(ans).trim() !== '') {
                                var numAnswer = parseFloat(String(ans).replace(/,/g, ''));
                                var numCorrect = parseFloat(q.numericalAnswer);
                                if (!isNaN(numAnswer) && !isNaN(numCorrect)) {
                                    status = Math.abs(numAnswer - numCorrect) < 0.001 ? 'correct' : 'wrong';
                                } else {
                                    status = 'wrong';
                                }
                            }
                        } else if (ansArr.length > 0) {
                            const ansSort = [...ansArr].sort().join(',');
                            const ciSort = [...ci].sort().join(',');
                            status = ansSort === ciSort ? 'correct' : 'wrong';
                        }

                        if (status === 'correct') { correct++; marksScore += _jeeOnlineScheme ? _jeeOnlineMarksCorrect : (_jeeScheme ? 4 : 1); }
                        else if (status === 'wrong') { wrong++; marksScore += _jeeOnlineScheme ? _jeeOnlineMarksWrong : (_jeeScheme ? -1 : 0); }
                        else skipped++;

                        _jeeReviewItems.push({ q, ans, status, idx: i, ci });
                    });

                    const total = _jeeQuestions.length;
                    const maxMarks = total * (_jeeOnlineScheme ? _jeeOnlineMarksCorrect : (_jeeScheme ? 4 : 1));
                    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
                    const grade = jeeGrade(pct);

                    // Hide portal, show result
                    // Disable refresh block once test is fully submitted
                    if (typeof disableRefreshBlock === 'function') disableRefreshBlock();
                    document.getElementById('jee-portal').style.display = 'none';
                    document.getElementById('jee-result').style.display = 'block';
                    document.getElementById('jee-result').scrollTop = 0;

                    // Header
                    document.getElementById('resultStudentName').textContent = _student ? `${_student.name} · ${_student.rollNumber}` : '';
                    document.getElementById('resultTestMeta').textContent = `${chapter}${_jeeTestMeta.topic ? ' · ' + _jeeTestMeta.topic : ''}`;

                    // Grade badge
                    document.getElementById('resultGradeBadge').innerHTML = `<span style="color:${grade.color}">${grade.emoji} ${grade.label}</span>`;

                    // Score — show marks obtained / max marks
                    document.getElementById('resultScore').textContent = `${marksScore} / ${maxMarks}`;
                    document.getElementById('resultPct').textContent = `${pct}% Accuracy`;
                    const schemeLabel = _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/−1' : '+1/0');
                    document.getElementById('resultMarksScore').textContent = `Questions: ${correct}/${total}  ·  Scheme: ${schemeLabel}`;
                    document.getElementById('resultTimeSpent').textContent = `⏱ Time spent: ${fmtTime(_jeeElapsedSec)}`;

                    // Stats
                    document.getElementById('res-correct').textContent = correct;
                    document.getElementById('res-wrong').textContent = wrong;
                    document.getElementById('res-skipped').textContent = skipped;
                    document.getElementById('res-total').textContent = total;

                    // Percentages
                    document.getElementById('res-pct-c').textContent = total ? Math.round(correct / total * 100) : 0;
                    document.getElementById('res-pct-w').textContent = total ? Math.round(wrong / total * 100) : 0;
                    document.getElementById('res-pct-s').textContent = total ? Math.round(skipped / total * 100) : 0;

                    // Performance bars
                    setTimeout(() => {
                        document.getElementById('res-bar-correct').style.width = `${total ? (correct / total * 100) : 0}%`;
                        document.getElementById('res-bar-wrong').style.width = `${total ? (wrong / total * 100) : 0}%`;
                        document.getElementById('res-bar-skip').style.width = `${total ? (skipped / total * 100) : 0}%`;
                    }, 100);

                    // Subject-wise breakdown
                    const subjects = {};
                    _jeeQuestions.forEach((q, i) => {
                        const subj = q.subject || 'General';
                        if (!subjects[subj]) subjects[subj] = { correct: 0, wrong: 0, skipped: 0, total: 0 };
                        subjects[subj].total++;
                        subjects[subj][_jeeReviewItems[i].status]++;
                    });
                    const subjectKeys = Object.keys(subjects);
                    if (subjectKeys.length > 1) {
                        document.getElementById('res-section-wrap').style.display = 'block';
                        const subjectColors = ['#60c8ff', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
                        document.getElementById('res-section-grid').innerHTML = subjectKeys.map((s, si) => {
                            const d = subjects[s];
                            const spct = d.total ? Math.round(d.correct / d.total * 100) : 0;
                            return `<div style="background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:14px;border-left:3px solid ${subjectColors[si % subjectColors.length]}">
                        <div style="font-size:0.82rem;font-weight:700;color:var(--text);margin-bottom:8px">${escHtml(s)}</div>
                        <div style="font-size:1.3rem;font-weight:800;color:${subjectColors[si % subjectColors.length]};font-family:'Syne',sans-serif">${spct}%</div>
                        <div style="font-size:0.72rem;color:var(--text-faint);margin-top:4px">${d.correct}✓  ${d.wrong}✗  ${d.skipped}—</div>
                    </div>`;
                        }).join('');
                    }


                    // Reinforce dashboard server-state when returning from the result page.
                    if (typeof loadDashboard === 'function') {
                        loadDashboard();
                    }
                    // Review list
                    document.getElementById('res-review-count').textContent = `${total} Questions`;
                    _resFilter = 'all';
                    ['All', 'Correct', 'Wrong', 'Skipped'].forEach(k => {
                        const btn = document.getElementById('rf' + k);
                        if (btn) btn.style.opacity = k === 'All' ? '1' : '0.5';
                    });
                    jeeRenderReviewList();

                    // Submit to server
                    if (_student && _token) {
                        try {
                            const selectedAnswers = _jeeQuestions.map((q, i) => {
                                const a = _jeeAnswers[i];
                                return Array.isArray(a) ? a : (a !== null && a >= 0 ? a : null);
                            });
                            await fetch(`${API_BASE}/api/submit-attempt`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    mobile: _student.rollNumber,
                                    chapter, lecture: lecture || _jeeTestMeta.onlineTestId || 'online',
                                    name: _student.name,
                                    className: _student.className,
                                    selectedAnswers,
                                    askedQuestionIndexes: _jeeQuestions.map((_, i) => i),
                                    score: correct,
                                    total,
                                    marksScore,
                                    timeTaken: _jeeElapsedSec
                                })
                            });
                        } catch (e) { console.warn('Submit error:', e); }
                    }

                    // ── Save to database (new) ──
                    if (_student) {
                        try {
                            const compactAnswers = _jeeQuestions.map((q, i) => {
                                const studentAnswer = _jeeAnswers[i];
                                return [
                                    i,
                                    Array.isArray(studentAnswer) ? studentAnswer.join(',') : (studentAnswer === null || studentAnswer === undefined ? '' : String(studentAnswer)),
                                    (_jeeReviewItems[i]?.status || 'skipped').charAt(0)
                                ];
                            });
                            const testResultPayload = {
                                mobile: _student.rollNumber,
                                chapter,
                                lecture: lecture || _jeeTestMeta.onlineTestId || 'online',
                                topic: _jeeTestMeta.topic || '',
                                correct,
                                wrong,
                                skipped,
                                total,
                                marksScore,
                                maxMarks,
                                pct,
                                grade: grade.label,
                                timeTaken: _jeeElapsedSec,
                                scheme: _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/-1' : '+1/0'),
                                studentName: _student.name,
                                studentClass: _student.className,
                                answers: compactAnswers,
                                online_test_id: _jeeTestMeta.onlineTestId || null
                            };
                            const saveResp = await fetch(`${API_BASE}/api/save-test-result`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(testResultPayload)
                            });
                            if (saveResp && saveResp.ok) {
                                // refresh dashboard stats from server
                                try {
                                    const st = await fetch(`${API_BASE}/api/student/stats/${encodeURIComponent(_student.rollNumber)}`);
                                    if (st.ok) {
                                        const stats = await st.json();
                                        const completedEl = document.getElementById('statCompleted');
                                        const avgEl = document.getElementById('statAvg');
                                        const streakTile = document.querySelectorAll('.stat-tile .stat-num')[3];
                                        if (completedEl) completedEl.textContent = stats.tests_completed || 0;
                                        if (avgEl) avgEl.textContent = (typeof stats.avg_pct === 'number') ? `${stats.avg_pct}%` : '—';
                                        if (streakTile) streakTile.textContent = stats.day_streak || 0;
                                    }
                                } catch (_) { }
                            }
                        } catch (e) { console.warn('Database save error:', e); }
                    }

                    // ── Save to local history ──
                    const historyKey = 'gp_test_history';
                    let history = [];
                    try { history = JSON.parse(localStorage.getItem(historyKey) || '[]'); } catch (_) { }
                    const attemptRecord = {
                        id: Date.now(),
                        timestamp: new Date().toISOString(),
                        student: _student ? { name: _student.name, roll: _student.rollNumber, class: _student.className } : null,
                        test: { chapter, lecture, topic: _jeeTestMeta.topic || '' },
                        result: { correct, wrong, skipped, total, marksScore, maxMarks, pct, grade: grade.label, timeTaken: _jeeElapsedSec },
                        scheme: _jeeOnlineScheme ? `+${_jeeOnlineMarksCorrect}/${_jeeOnlineMarksWrong}` : (_jeeScheme ? '+4/-1' : '+1/0'),
                        answers: _jeeQuestions.map((q, i) => ([
                            i,
                            Array.isArray(_jeeAnswers[i]) ? _jeeAnswers[i].join(',') : (_jeeAnswers[i] === null || _jeeAnswers[i] === undefined ? '' : String(_jeeAnswers[i])),
                            (_jeeReviewItems[i]?.status || 'skipped').charAt(0)
                        ])),
                        // Store questions for analysis view (especially for online/assigned tests)
                        questions: _jeeQuestions.map(q => ({
                            question: q.question || '',
                            options: q.options || [],
                            correctIndexes: q.correctIndexes || (typeof q.correctIndex === 'number' ? [q.correctIndex] : [0]),
                            solution: q.solution || q.explanation || '',
                            ...(Array.isArray(q.tables) && q.tables.length ? { tables: q.tables } : {}),
                            questionImage: null // omit large images to keep localStorage small
                        }))
                    };
                    history.unshift(attemptRecord);
                    if (history.length > 50) history = history.slice(0, 50); // keep last 50
                    localStorage.setItem(historyKey, JSON.stringify(history));

                    // ── Update dashboard stats ──
                    await updateDashboardStats();

                    // ── Render history panel ──
                    await renderResultHistory();
                }

                function jeeReturnToDashboard() {
                    if (typeof disableRefreshBlock === 'function') disableRefreshBlock();
                    document.getElementById('jee-result').style.display = 'none';
                    showScreen('dashboard');
                    loadDashboard();
                }

                /* ── Update dashboard stats from database ── */
                async function updateDashboardStats() {
                    let history = [];
                    if (_student) {
                        try {
                            const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
                            if (res.ok) history = await res.json();
                        } catch (e) { console.warn('Failed to fetch stats:', e); }
                    }

                    const completed = history.length;
                    const avgScore = completed > 0
                        ? Math.round(history.reduce((sum, h) => sum + h.result.pct, 0) / completed)
                        : null;

                    // compute day streak (consecutive days with attempts)
                    let streak = 0;
                    if (history.length) {
                        const dates = [...new Set(history.map(h => (new Date(h.timestamp)).toISOString().slice(0, 10)))].sort().reverse();
                        let cur = new Date(dates[0] + 'T00:00:00');
                        for (let d of dates) {
                            const dt = new Date(d + 'T00:00:00');
                            if (Math.abs((cur - dt) / (24 * 3600 * 1000)) <= 0.1) { streak++; cur.setDate(cur.getDate() - 1); }
                            else break;
                        }
                    }

                    // Update completed stat tile
                    const statTiles = document.querySelectorAll('.stat-tile');
                    statTiles.forEach(tile => {
                        const lbl = tile.querySelector('.stat-label');
                        const num = tile.querySelector('.stat-num');
                        if (!lbl || !num) return;
                        if (lbl.textContent === 'Completed') num.textContent = completed;
                        if (lbl.textContent === 'Avg Score' && avgScore !== null) num.textContent = `${avgScore}%`;
                    });

                    // Also update via IDs if they exist
                    const completedEl = document.getElementById('statCompleted');
                    if (completedEl) completedEl.textContent = completed;
                    const avgEl = document.getElementById('statAvg');
                    if (avgEl && avgScore !== null) avgEl.textContent = `${avgScore}%`;
                    const streakTile = document.querySelectorAll('.stat-tile .stat-num')[3];
                    if (streakTile) streakTile.textContent = streak;
                }

                function getTestHistory() {
                    try { return JSON.parse(localStorage.getItem('gp_test_history') || '[]'); } catch (_) { return []; }
                }

                async function fetchTestHistoryFromDatabase() {
                    if (!_student) return [];
                    try {
                        const response = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
                        if (!response.ok) return [];
                        return await response.json();
                    } catch (e) {
                        console.warn('Failed to fetch test history from database:', e);
                        return [];
                    }
                }

                async function renderResultHistory() {
                    const el = document.getElementById('res-history-list');
                    if (!el) return;
                    let history = [];
                    if (_student) {
                        try {
                            const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
                            if (res.ok) history = await res.json();
                        } catch (e) { console.warn('Failed to fetch history:', e); }
                    }
                    if (!history.length) {
                        el.innerHTML = '<div style="color:var(--text-faint);font-size:0.82rem;padding:8px 0">No attempts recorded yet.</div>';
                        return;
                    }
                    const gradeColor = (pct) => pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
                    el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                <thead>
                    <tr style="border-bottom:1px solid var(--border);color:var(--text-faint);text-transform:uppercase;font-size:0.68rem;letter-spacing:0.8px">
                        <th style="padding:8px 12px;text-align:left;font-weight:700">#</th>
                        <th style="padding:8px 12px;text-align:left;font-weight:700">Date & Time</th>
                        <th style="padding:8px 12px;text-align:left;font-weight:700">Test</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Score</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Marks</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Accuracy</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">C / W / S</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Time</th>
                        <th style="padding:8px 12px;text-align:center;font-weight:700">Scheme</th>
                    </tr>
                </thead>
                <tbody>
                ${history.map((h, i) => {
                        const dt = new Date(h.timestamp);
                        const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
                        const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                        const r = h.result;
                        const gc = gradeColor(r.pct);
                        return `<tr style="border-bottom:1px solid var(--border);${i === 0 ? 'background:var(--cyan-dim);' : ''}">
                        <td style="padding:10px 12px;color:var(--text-faint);font-family:'JetBrains Mono',monospace">${history.length - i}</td>
                        <td style="padding:10px 12px;color:var(--text-mid);white-space:nowrap">
                            <div style="font-weight:600">${dateStr}</div>
                            <div style="font-size:0.72rem;color:var(--text-faint)">${timeStr}</div>
                        </td>
                        <td style="padding:10px 12px;color:var(--text)">
                            <div style="font-weight:600">${escHtml(h.test.chapter)}</div>
                            <div style="font-size:0.72rem;color:var(--text-faint)">${h.test.topic ? escHtml(h.test.topic) : ''}</div>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-family:'JetBrains Mono',monospace;font-weight:700;color:var(--text)">${r.correct}/${r.total}</td>
                        <td style="padding:10px 12px;text-align:center;font-family:'JetBrains Mono',monospace;font-weight:700;color:${gc}">${r.marksScore >= 0 ? '+' : ''}${r.marksScore}</td>
                        <td style="padding:10px 12px;text-align:center">
                            <span style="font-weight:800;font-size:0.9rem;color:${gc}">${r.pct}%</span>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.78rem;font-family:'JetBrains Mono',monospace">
                            <span style="color:#22c55e">${r.correct}</span> / <span style="color:#ef4444">${r.wrong}</span> / <span style="color:var(--text-faint)">${r.skipped}</span>
                        </td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.78rem;color:var(--text-faint)">${fmtTime(r.timeTaken || 0)}</td>
                        <td style="padding:10px 12px;text-align:center;font-size:0.72rem;color:var(--text-faint);font-family:'JetBrains Mono',monospace">${h.scheme}</td>
                    </tr>`;
                    }).join('')}
                </tbody>
            </table></div>`;
                }

                // Store tests globally so click handlers can safely reference them by index
                window._cachedTests = [];
                let _pendingStartTest = null;
                let _startLoaderTimer = null;
                let _startLoaderProgress = 0;

                // Override renderTests to open JEE portal on card/button click
                window.renderTests = function (tests) {
                    window._cachedTests = tests;
                    document.getElementById('testsLoading').style.display = 'none';
                    document.getElementById('statTests').textContent = tests.length || '0';
                    document.getElementById('testPanelBadge').textContent = `${tests.length} Test${tests.length !== 1 ? 's' : ''}`;
                    const attemptedCount = tests.filter(t => t.isAttempted).length;
                    const nb = document.getElementById('navTestsBadge');
                    nb.textContent = attemptedCount;
                    nb.style.display = attemptedCount ? '' : 'none';
                    const grid = document.getElementById('testGrid');
                    if (!tests.length) { document.getElementById('testsEmpty').classList.remove('hidden'); return; }
                    grid.style.display = 'flex';
                    grid.innerHTML = tests.map((t, i) => {
                        const isOnline = !!t._isOnline;
                        const isUpcoming = isOnline && !!t.isUpcoming;
                        const isAttempted = !!t.isAttempted;
                        const attemptsExhausted = isOnline && !!t.attemptsExhausted;
                        const attemptsUsed = t.attemptsUsed || 0;
                        const maxAttempts = t.maxAttempts || 1;
                        let subtitle = '';
                        if (isOnline) {
                            const endsDate = t.endsAt ? new Date(t.endsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
                            const schemeStr = `+${t.marksCorrect || 4}/${t.marksWrong != null ? t.marksWrong : -1}`;
                            if (isUpcoming) {
                                const liveTime = t.liveAt ? new Date(t.liveAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                                const liveDate = t.liveAt ? new Date(t.liveAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
                                subtitle = `${t.questionCount || 0} Qs  ·  ${schemeStr}  ·  Goes live: ${liveDate} at ${liveTime}`;
                            } else {
                                subtitle = `${t.questionCount || 0} Qs  ·  ${schemeStr}${endsDate ? '  ·  Ends: ' + endsDate : ''}`;
                            }
                        } else {
                            const date = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                            const qCount = t.questionCount ? `${t.questionCount} Qs` : '';
                            const timeLbl = t.questionCount ? `~${Math.ceil(t.questionCount * 1.5)}min` : '';
                            subtitle = `${t.topic ? escHtml(t.topic) + '  ·  ' : ''}${qCount ? qCount + '  ·  ' : ''}${timeLbl ? timeLbl + '  ·  ' : ''}${date}`;
                        }

                        const badgeText = isUpcoming ? '⏰ Upcoming' : (attemptsExhausted ? '🔒 No Attempts Left' : (isAttempted ? `✓ ${attemptsUsed}/${maxAttempts} Done` : isOnline ? '🌐 Live' : 'Open'));
                        const badgeClass = isUpcoming ? 'badge-upcoming' : (attemptsExhausted ? 'badge-attempted' : (isAttempted ? 'badge-attempted' : isOnline ? 'badge-open' : 'badge-open'));
                        const title = isOnline ? escHtml(t.testName || 'Online Test') : `${escHtml(t.chapter)}${t.topic ? ' — ' + escHtml(t.topic) : ''}`;
                        const icon = isUpcoming ? '⏳' : (attemptsExhausted ? '🔒' : (isAttempted ? '✅' : isOnline ? '🌐' : '📖'));
                        const onlineBorder = isUpcoming ? 'border-left:3px solid var(--amber);' : (attemptsExhausted ? 'border-left:3px solid #6b7280;' : (isAttempted ? 'border-left:3px solid var(--green);' : isOnline ? 'border-left:3px solid var(--cyan);' : ''));
                        const strictTag = (t.isStrict && !isAttempted) ? `<span style="font-size:0.65rem;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.35);border-radius:20px;padding:2px 7px;color:var(--amber);font-weight:700;margin-left:4px">🛡 Strict</span>` : '';
                        return `<div class="test-card" data-tidx="${i}" style="cursor:${attemptsExhausted ? 'not-allowed' : 'pointer'};animation-delay:${i * 0.05}s;${(isAttempted || attemptsExhausted) ? 'opacity:0.75;' : ''}${onlineBorder}">
                    <span class="test-card-num">${String(i + 1).padStart(2, '0')}</span>
                    <div class="test-card-icon">${icon}</div>
                    <div class="test-card-body">
                        <div class="test-card-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">${title}${strictTag}</div>
                        <div class="test-card-sub">${subtitle}</div>
                    </div>
                    <span class="badge ${badgeClass}" data-tidx="${i}" style="cursor:pointer">${badgeText}</span>
                </div>`;
                    }).join('');
                    // Attach event listeners after rendering
                    grid.querySelectorAll('[data-tidx]').forEach(el => {
                        el.addEventListener('click', function (e) {
                            e.stopPropagation();
                            const t = window._cachedTests[parseInt(this.dataset.tidx, 10)];
                            if (t) openStartTestPopup(t);
                        });
                    });
                };

            


        // API_BASE, _token, _student, _pendingRoll, _isRequestMode
        // are declared in the bootstrap script block above — do not redeclare here

        /* ══ LOADER ══ */
        const statusMsgs = ['Connecting…', 'Authenticating…', 'Loading portal…', 'Almost ready…'];
        let sIdx = 0;
        const sEl = document.getElementById('loaderStatus');
        let sTimer = null;
        if (sEl) {
            sTimer = setInterval(() => {
                sEl.textContent = statusMsgs[Math.min(sIdx++, statusMsgs.length - 1)];
                if (sIdx >= statusMsgs.length) { clearInterval(sTimer); sTimer = null; }
            }, 380);
        }

        // Detect whether this portal is running embedded inside client.html.
        // When embedded we skip the long cosmetic loader animation so the
        // student portal opens (almost) instantly.
        const _isEmbedded = (window.parent && window.parent !== window);

        // Hide loader and boot the app — extracted so both paths call it once
        let _bootFired = false;
        async function _hideLoaderAndBoot() {
            if (_bootFired) return;
            _bootFired = true;
            if (sTimer) { clearInterval(sTimer); sTimer = null; }
            if (sEl) sEl.textContent = 'Ready ✓';
            await new Promise(r => setTimeout(r, _isEmbedded ? 0 : 180));
            const l = document.getElementById('loader');
            if (l) { l.style.opacity = '0'; setTimeout(() => l.style.display = 'none', _isEmbedded ? 200 : 600); }
            await bootApp();
        }

        // Boot as soon as the DOM is interactive instead of waiting for the full
        // `window load` event (which is delayed by the async MathJax/CDN scripts).
        // MathJax is only needed lazily when questions are rendered, so there is
        // no reason to block the whole portal on it.
        const _bootDelay = _isEmbedded ? 0 : 250; // tiny delay keeps the standalone loader visible briefly
        function _scheduleBoot() { setTimeout(_hideLoaderAndBoot, _bootDelay); }
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            _scheduleBoot();
        } else {
            document.addEventListener('DOMContentLoaded', _scheduleBoot, { once: true });
        }

        // Safety net: also fire on full load, and a hard fallback in case
        // DOMContentLoaded already passed before this script ran.
        window.addEventListener('load', () => _hideLoaderAndBoot());
        // Fallback: if nothing else fires (CDN hang), force-boot.
        setTimeout(_hideLoaderAndBoot, _isEmbedded ? 1500 : 3000);

        async function bootApp() {
            if (_token) {
                try {
                    const r = await fetch(`${API_BASE}/api/student/me`, { headers: { Authorization: `Bearer ${_token}` } });
                    if (r.ok) { _student = await r.json(); showScreen('dashboard'); loadDashboard(); return; }
                } catch (_) { }
                _token = ''; localStorage.removeItem('gp_student_token');
            }
            // If student had submitted a request, restore their pending state
            if (_pendingRoll) {
                try {
                    const r = await fetch(`${API_BASE}/api/student/check-request-status`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rollNumber: _pendingRoll })
                    });
                    const data = await r.json();
                    if (data.approved) {
                        await loginWithRoll(_pendingRoll);
                        return;
                    } else if (data.rejected) {
                        localStorage.removeItem('gp_pending_roll');
                        _pendingRoll = '';
                        showScreen('login');
                        showMsg('loginMsg', 'err', 'Your access request was rejected. Please contact your teacher.');
                        return;
                    } else if (data.pending) {
                        showPendingApprovalScreen(_pendingRoll);
                        return;
                    }
                } catch (_) {
                    showPendingApprovalScreen(_pendingRoll);
                    return;
                }
            }
            showScreen('login');
        }

        // ── History / back-button support ──────────────────────────────────────
        // Push a state entry every time we navigate so the browser back button
        // navigates within the SPA instead of leaving it.
        let _historyNavBlocked = false;

        function showScreen(name, pushHistory = true) {
            ['login', 'profile', 'dashboard', 'test-analysis', 'test-summary', 'test-detail', 'edit', 'pending'].forEach(s => {
                const el = document.getElementById(`screen-${s}`);
                if (el) el.classList.add('hidden');
            });
            const el = document.getElementById(`screen-${name}`);
            if (!el) return;
            el.classList.remove('hidden');
            el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';

            // update topbar title + sidebar state
            const titles = { login: 'Sign In', profile: 'Create Profile', dashboard: 'Dashboard', 'test-analysis': 'Test Analysis', 'test-summary': 'Test Analysis', 'test-detail': 'Test Details', edit: 'Edit Profile', pending: 'Request Sent' };
            document.getElementById('topbarTitle').textContent = titles[name] || 'Portal';

            const isLoggedIn = (name === 'dashboard' || name === 'test-analysis' || name === 'test-summary' || name === 'test-detail' || name === 'edit');
            document.getElementById('sidebarUser').classList.toggle('visible', isLoggedIn);
            document.getElementById('navEdit').style.display = isLoggedIn ? '' : 'none';
            document.getElementById('logoutSidebarBtn').style.display = isLoggedIn ? '' : 'none';

            // On auth screens (login / profile / pending) there is no menu to open,
            // so hide the topbar menu bar entirely on mobile. The <body> class is
            // used by CSS to drop the hamburger button (and topbar) on small screens.
            document.body.classList.toggle('auth-mode', !isLoggedIn);
            // Make sure the drawer can never be left open when entering an auth screen.
            if (!isLoggedIn) closeSidebar();

            // Disable Android pull-to-refresh on all logged-in screens (scrollable content).
            // Re-enable only on login/profile/pending where there is nothing to scroll.
            if (window.Android) {
                if (isLoggedIn) {
                    if (typeof window.Android.disablePullToRefresh === 'function') window.Android.disablePullToRefresh();
                } else {
                    if (typeof window.Android.enablePullToRefresh === 'function') window.Android.enablePullToRefresh();
                }
            }

            closeSidebar();

            // Push state so back button works within SPA
            if (pushHistory && !_historyNavBlocked) {
                const state = { screen: name };
                if (name === 'login' || name === 'pending' || name === 'profile') {
                    history.replaceState(state, '', window.location.pathname);
                } else {
                    history.pushState(state, '', window.location.pathname);
                }
            }
        }

        // Handle browser back / forward
        window.addEventListener('popstate', function (e) {
            const state = e.state;
            _historyNavBlocked = true;
            if (!state || !state.screen) {
                if (_student) { showScreen('dashboard', false); loadDashboard(); }
                else { showScreen('login', false); }
                _historyNavBlocked = false;
                return;
            }
            const screen = state.screen;
            if (screen === 'dashboard' && _student) {
                showScreen('dashboard', false); loadDashboard();
            } else if (screen === 'test-analysis' && _student) {
                showScreen('test-analysis', false);
                document.getElementById('topbarTitle').textContent = 'Test Analysis';
                setActiveNav('tests');
                if (window._testAnalysisData && window._testAnalysisData.length) {
                    _taRenderExisting();
                } else {
                    showTestAnalysisList(false);
                }
            } else if (screen === 'test-summary' && _student) {
                if (window._tdCurrentTestIdx != null && window._testAnalysisData) {
                    openTestDetail(window._tdCurrentTestIdx, false);
                } else {
                    showTestAnalysisList(false);
                }
            } else if (screen === 'edit' && _student) {
                showEditProfile();
            } else if (screen === 'login') {
                showScreen('login', false);
            } else {
                if (_student) { showScreen('dashboard', false); loadDashboard(); }
                else { showScreen('login', false); }
            }
            _historyNavBlocked = false;
        });

        // ── Refresh Guard — active test portal only ─────────────────────────
        let _blockRefresh = false;
        let _refreshLeaveCallback = null; // called if user chooses "Leave anyway"

        function enableRefreshBlock() {
            _blockRefresh = true;
            document.documentElement.classList.add('refresh-blocked');
            // Tell Android WebView to disable SwipeRefreshLayout during a test
            if (window.Android && typeof window.Android.disablePullToRefresh === 'function') {
                window.Android.disablePullToRefresh();
            }
        }

        function disableRefreshBlock() {
            _blockRefresh = false;
            document.documentElement.classList.remove('refresh-blocked');
            // Re-enable Android SwipeRefreshLayout once test is over
            if (window.Android && typeof window.Android.enablePullToRefresh === 'function') {
                window.Android.enablePullToRefresh();
            }
        }

        // ── Desktop: block F5 / Ctrl+R / Cmd+R ───────────────────────────────
        document.addEventListener('keydown', function (e) {
            if (!_blockRefresh) return;
            const isRefreshKey = e.key === 'F5' ||
                ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r');
            if (isRefreshKey) {
                e.preventDefault();
                e.stopPropagation();
                _showRefreshWarningPopup();
                return false;
            }
        }, true);

        // ── Desktop: beforeunload — replaced by custom popup where possible ───
        // beforeunload fires AFTER our keydown handler swallows F5/Ctrl+R,
        // so it only fires for true tab closes / address-bar navigations.
        window.addEventListener('beforeunload', function (e) {
            if (!_blockRefresh) return;
            e.preventDefault();
            e.returnValue = '';
            return '';
        });

        // ── Mobile: pull-to-refresh intercept ────────────────────────────────
        let _mobileRefreshTouchStartY = 0;
        let _mobileRefreshTouchStartX = 0;
        let _mobileRefreshPopupShown = false; // prevent re-triggering within same swipe gesture

        document.addEventListener('touchstart', function (e) {
            if (!_blockRefresh) return;
            if (e.touches.length === 1) {
                _mobileRefreshTouchStartY = e.touches[0].clientY;
                _mobileRefreshTouchStartX = e.touches[0].clientX;
                _mobileRefreshPopupShown = false; // reset per gesture
            }
        }, { passive: true });

        document.addEventListener('touchmove', function (e) {
            if (!_blockRefresh) return;
            if (e.touches.length !== 1) return;
            if (_mobileRefreshPopupShown) return; // already warned this gesture
            const dy = e.touches[0].clientY - _mobileRefreshTouchStartY;
            const dx = e.touches[0].clientX - _mobileRefreshTouchStartX;
            const portalEl = document.getElementById('jee-portal');
            const scrollTop = portalEl ? portalEl.scrollTop : window.scrollY;
            // Require a deliberate 60 px downward pull (was 10 px) before warning,
            // and only when already at the very top of the scroll container.
            if (dy > 250 && Math.abs(dy) > Math.abs(dx) * 1.5 && scrollTop <= 0) {
                e.preventDefault();
                _mobileRefreshPopupShown = true;
                _showRefreshWarningPopup();
            }
        }, { passive: false });

        // ── pagehide fallback (iOS Safari) ────────────────────────────────────
        window.addEventListener('pagehide', function () {
            if (_blockRefresh) {
                try { sessionStorage.setItem('_gpRefreshInterrupted', '1'); } catch (_) { }
            }
        });
        try { sessionStorage.removeItem('_gpRefreshInterrupted'); } catch (_) { }

        // ── Custom refresh warning popup ──────────────────────────────────────
        function _showRefreshWarningPopup() {
            const popup = document.getElementById('refreshWarningPopup');
            if (popup) {
                popup.classList.add('active');
                // Animate in
                const box = popup.querySelector('.rwp-box');
                if (box) { box.style.transform = 'scale(0.92)'; box.style.opacity = '0'; requestAnimationFrame(() => { box.style.transition = 'transform 0.22s cubic-bezier(.34,1.56,.64,1), opacity 0.18s ease'; box.style.transform = 'scale(1)'; box.style.opacity = '1'; }); }
            }
        }

        function _hideRefreshWarningPopup() {
            const popup = document.getElementById('refreshWarningPopup');
            if (popup) popup.classList.remove('active');
        }

        function _refreshWarningStay() {
            _hideRefreshWarningPopup();
        }

        function _refreshWarningLeave() {
            _hideRefreshWarningPopup();
            disableRefreshBlock();
            // Small delay so CSS transition finishes, then actually reload
            setTimeout(() => { window.location.reload(); }, 120);
        }

        /* ══ SIDEBAR MOBILE ══ */
        function toggleSidebar() {
            const sb = document.getElementById('sidebar');
            const bd = document.getElementById('sidebarBackdrop');
            sb.classList.toggle('open');
            bd.classList.toggle('active');
        }
        function closeSidebar() {
            document.getElementById('sidebar').classList.remove('open');
            document.getElementById('sidebarBackdrop').classList.remove('active');
        }

        /* ══ THEME ══ */
        function toggleTheme() {
            const html = document.documentElement;
            const isLight = html.getAttribute('data-theme') === 'light';
            html.setAttribute('data-theme', isLight ? 'dark' : 'light');
            const icon = isLight ? '🌙' : '☀️';
            document.getElementById('themeBtn').textContent = icon + ' Toggle Theme';
            document.getElementById('topbarThemeBtn').textContent = icon;
            localStorage.setItem('gp-theme', isLight ? 'dark' : 'light');
        }
        (function () {
            // Default to dark mode; only go light if user explicitly chose light
            const t = localStorage.getItem('gp-theme') || 'dark';
            document.documentElement.setAttribute('data-theme', t);
            const icon = t === 'light' ? '☀️' : '🌙';
            const b = document.getElementById('themeBtn');
            if (b) b.textContent = icon + ' Toggle Theme';
            const tb = document.getElementById('topbarThemeBtn');
            if (tb) tb.textContent = icon;
        })();

        function navDash() { if (_student) { showScreen('dashboard'); loadDashboard(); setActiveNav('dashboard'); } }

        function setActiveNav(key) {
            // keys: 'dashboard', 'tests', 'edit'
            document.querySelectorAll('.sidebar-nav-item').forEach(el => el.classList.remove('active'));
            if (key === 'dashboard') document.querySelector('.sidebar-nav-item')?.classList.add('active');
            if (key === 'tests') document.getElementById('navTests')?.classList.add('active');
            if (key === 'edit') document.getElementById('navEdit')?.classList.add('active');
        }

        /* ══ LOGOUT POPUP ══ */
        function openLogoutPopup() { document.getElementById('logoutPopup').classList.add('active'); }
        function closeLogoutPopup() { document.getElementById('logoutPopup').classList.remove('active'); }
        document.getElementById('logoutPopup').addEventListener('click', function (e) { if (e.target === this) closeLogoutPopup(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogoutPopup(); });

        function formatDuration(sec) {
            const total = Math.max(0, Number(sec) || 0);
            const h = Math.floor(total / 3600);
            const m = Math.floor((total % 3600) / 60);
            const s = total % 60;
            if (h > 0) return `${h}h ${m}m`;
            if (m > 0) return `${m}m ${s}s`;
            return `${s}s`;
        }

        function setStartLoaderProgress(pct, statusText) {
            const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));
            const fill = document.getElementById('startTestLoaderFill');
            const status = document.getElementById('startTestLoaderStatus');
            const pctEl = document.getElementById('startTestLoaderPct');
            if (fill) fill.style.width = `${clamped}%`;
            if (statusText && status) status.textContent = statusText;
            if (pctEl) pctEl.textContent = `${clamped}%`;
        }

        function openStartTestPopup(test) {
            // Block upcoming tests — show a "not live yet" popup instead
            if (test._isOnline && test.isUpcoming) {
                const liveAt = test.liveAt ? new Date(test.liveAt) : null;
                const liveTimeStr = liveAt ? liveAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
                const liveDateStr = liveAt ? liveAt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
                const title = document.getElementById('startTestPopupTitle');
                const body = document.getElementById('startTestPopupBody');
                const marks = document.getElementById('startTestMaxMarks');
                const time = document.getElementById('startTestMaxTime');
                const questions = document.getElementById('startTestQuestions');
                const scheme = document.getElementById('startTestScheme');
                if (title) title.textContent = test.testName || 'Upcoming Test';
                if (body) body.textContent = `This test is not live yet. It will be available on ${liveDateStr} at ${liveTimeStr}.`;
                if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
                const upcomingDurMin = test.durationMinutes || (test.questionCount ? Math.ceil(test.questionCount * 1.5) : 90);
                if (time) time.textContent = formatDuration(upcomingDurMin * 60);
                if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
                if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
                // Swap the "Start Test" button to disabled state
                const startBtn = document.querySelector('#startTestPopup .btn-danger-solid');
                if (startBtn) {
                    startBtn.disabled = true;
                    startBtn.textContent = '⏰ Not Live Yet';
                    startBtn.style.opacity = '0.5';
                    startBtn.style.cursor = 'not-allowed';
                }
                document.getElementById('startTestPopup').classList.add('active');
                return;
            }
            // Re-enable the button in case it was disabled from a previous upcoming test click
            const startBtn = document.querySelector('#startTestPopup .btn-danger-solid');
            if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Start Test'; startBtn.style.opacity = ''; startBtn.style.cursor = ''; }

            // Block tests where max attempts have been exhausted
            if (test._isOnline && test.attemptsExhausted) {
                const title = document.getElementById('startTestPopupTitle');
                const body = document.getElementById('startTestPopupBody');
                const marks = document.getElementById('startTestMaxMarks');
                const time = document.getElementById('startTestMaxTime');
                const questions = document.getElementById('startTestQuestions');
                const scheme = document.getElementById('startTestScheme');
                if (title) title.textContent = test.testName || 'Online Test';
                if (body) body.innerHTML = `<div style="background:rgba(239,68,68,0.10);border:1.5px solid rgba(239,68,68,0.35);border-radius:10px;padding:10px 14px;margin-top:4px;font-size:0.85rem;color:#ef4444;font-weight:600">🔒 You have used all <strong>${test.maxAttempts}</strong> attempt${test.maxAttempts !== 1 ? 's' : ''} allowed for this test.<br><span style="font-weight:400;color:rgba(239,68,68,0.8)">No more attempts are permitted.</span></div>`;
                if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
                const durMin = test.durationMinutes || (test.questionCount ? Math.ceil(test.questionCount * 1.5) : 90);
                if (time) time.textContent = formatDuration(durMin * 60);
                if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
                if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
                const exhaustedBtn = document.querySelector('#startTestPopup .btn-danger-solid');
                if (exhaustedBtn) {
                    exhaustedBtn.disabled = true;
                    exhaustedBtn.textContent = '🔒 No Attempts Left';
                    exhaustedBtn.style.opacity = '0.5';
                    exhaustedBtn.style.cursor = 'not-allowed';
                }
                document.getElementById('startTestPopup').classList.add('active');
                return;
            }

            _pendingStartTest = test;
            const title = document.getElementById('startTestPopupTitle');
            const body = document.getElementById('startTestPopupBody');
            const marks = document.getElementById('startTestMaxMarks');
            const time = document.getElementById('startTestMaxTime');
            const questions = document.getElementById('startTestQuestions');
            const scheme = document.getElementById('startTestScheme');
            if (test._isOnline) {
                if (title) title.textContent = test.testName || 'Online Test';
                const strictNote = test.isStrict
                    ? `<div style="background:rgba(251,191,36,0.12);border:1.5px solid rgba(251,191,36,0.35);border-radius:10px;padding:10px 14px;margin-top:8px;font-size:0.82rem;color:#fbbf24;font-weight:600">
                        🛡️ <strong>STRICT TEST MODE ENABLED</strong><br>
                        <span style="font-weight:400;color:rgba(251,191,36,0.8)">Tab switching or opening other apps is monitored. You will get 2 warnings before your test is locked.</span>
                       </div>`
                    : '';
                if (body) body.innerHTML = 'Read all instructions and start when ready.' + strictNote;
                if (marks) marks.textContent = test.questionCount ? `${test.questionCount * (test.marksCorrect || 4)}` : '—';
                const durMin = test.durationMinutes || (test.questionCount ? test.questionCount * 1.5 : 90);
                if (time) time.textContent = formatDuration(Math.round(durMin) * 60);
                if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
                if (scheme) scheme.textContent = `+${test.marksCorrect || 4} / ${test.marksWrong != null ? test.marksWrong : -1}`;
            } else {
                if (title) title.textContent = `${test.chapter || 'Test'}`;
                if (body) body.textContent = test.topic ? test.topic : 'Review the test details and start when ready.';
                if (marks) marks.textContent = test.maxMarks ? `${test.maxMarks}` : '—';
                if (time) time.textContent = test.maxTimeSec ? formatDuration(test.maxTimeSec) : '—';
                if (questions) questions.textContent = test.questionCount ? `${test.questionCount}` : '—';
                if (scheme) scheme.textContent = '+4 / -1';
            }
            document.getElementById('startTestPopup').classList.add('active');
        }

        function closeStartTestPopup() {
            document.getElementById('startTestPopup').classList.remove('active');
        }

        document.getElementById('startTestPopup').addEventListener('click', function (e) {
            if (e.target === this) closeStartTestPopup();
        });

        async function confirmStartSelectedTest() {
            const test = _pendingStartTest;
            if (!test) return;
            // Safety guard: block if attempts exhausted
            if (test._isOnline && test.attemptsExhausted) return;
            closeStartTestPopup();
            if (test._isOnline) {
                // Online test: pass the test object directly (has .questions array)
                await openJeePortal(null, null, test);
            } else {
                await openJeePortal(test.chapter, test.lecture, test);
            }
        }

        function showStartLoader(test, statusText = 'Loading question set…') {
            const overlay = document.getElementById('startTestLoader');
            if (!overlay) return;
            overlay.classList.add('active');
            setStartLoaderProgress(8, statusText);
            const body = document.getElementById('startTestLoaderBody');
            if (body && test) {
                body.textContent = `${test.chapter || 'Test'}${test.topic ? ' · ' + test.topic : ''}`;
            }
            if (_startLoaderTimer) clearInterval(_startLoaderTimer);
            _startLoaderProgress = 8;
            _startLoaderTimer = setInterval(() => {
                _startLoaderProgress = Math.min(92, _startLoaderProgress + (Math.random() * 7 + 3));
                setStartLoaderProgress(_startLoaderProgress, 'Loading question set…');
            }, 160);
        }

        function hideStartLoader(finalPct = 100, doneText = 'Ready!') {
            if (_startLoaderTimer) { clearInterval(_startLoaderTimer); _startLoaderTimer = null; }
            setStartLoaderProgress(finalPct, doneText);
            const overlay = document.getElementById('startTestLoader');
            if (overlay) overlay.classList.remove('active');
        }

        /* ══ AUTH ══ */
        async function verifyRoll() {
            const roll = document.getElementById('rollInput').value.trim();
            const btn = document.getElementById('loginBtn');
            document.getElementById('loginMsg').className = 'msg'; document.getElementById('loginMsg').style.display = 'none';
            if (!roll) { showMsg('loginMsg', 'err', 'Please enter your roll number.'); shake('rollInput'); return; }
            btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Checking…';
            try {
                const r = await fetch(`${API_BASE}/api/student/verify-roll`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rollNumber: roll, instituteCode: _instituteCode })
                });
                const data = await r.json();

                // Already in pending requests
                if (data.pendingApproval) {
                    _pendingRoll = roll;
                    showPendingApprovalScreen(roll);
                    return;
                }

                // Registered student — normal flow
                if (data.valid) {
                    _pendingRoll = roll;
                    if (data.profileComplete) { await loginWithRoll(roll); }
                    else { document.getElementById('profileRollTag').textContent = `📋 Roll: ${roll}`; showScreen('profile'); }
                    return;
                }

                // Not registered — let them fill profile, will become a request
                if (data.notRegistered) {
                    _pendingRoll = roll;
                    _isRequestMode = true;
                    document.getElementById('profileRollTag').textContent = `📋 Roll: ${roll}`;
                    document.getElementById('profileHeading').textContent = 'Complete Your Details';
                    document.getElementById('profileSubtext').textContent = 'Your roll number isn\'t added yet. Fill your details and your teacher will review your access request.';
                    document.getElementById('profileBtn').textContent = 'Send Access Request →';
                    showScreen('profile');
                    return;
                }

                // Fallback error
                showMsg('loginMsg', 'err', data.error || 'Roll number not found. Contact your teacher.'); shake('rollInput');
            } catch (e) { showMsg('loginMsg', 'err', 'Connection error. Please try again.'); }
            finally { btn.disabled = false; btn.textContent = 'Continue →'; }
        }

        async function loginWithRoll(roll) {
            const r = await fetch(`${API_BASE}/api/student/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rollNumber: roll, instituteCode: _instituteCode })
            });
            const data = await r.json();
            if (!r.ok) { showMsg('loginMsg', 'err', data.error || 'Login failed.'); return; }
            _token = data.token; _student = data.student;
            localStorage.setItem('gp_student_token', _token);
            showScreen('dashboard'); loadDashboard();
        }

        async function saveProfile() {
            const name = document.getElementById('pName').value.trim();
            const division = (document.getElementById('pDivision')?.value || '').trim().toUpperCase();
            const btn = document.getElementById('profileBtn');
            if (!name) { showMsg('profileMsg', 'err', 'Name is required.'); shake('pName'); return; }
            btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
            try {
                const className = document.getElementById('pClass').value.trim();
                // Store className with division combined: "12 - A" format for backend
                const classWithDiv = className && division ? `${className} - ${division}` : (className || division || '');
                const payload = {
                    rollNumber: _pendingRoll, name,
                    className: classWithDiv,
                    division: division,
                    phone: document.getElementById('pPhone').value.trim(),
                    age: document.getElementById('pAge').value.trim(),
                    dateOfBirth: document.getElementById('pDob').value.trim(),
                    instituteCode: _instituteCode
                };

                // Request mode — submit to teacher for approval
                if (_isRequestMode) {
                    const r = await fetch(`${API_BASE}/api/student/submit-request`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                    });
                    const data = await r.json();
                    if (!r.ok) { showMsg('profileMsg', 'err', data.error || 'Failed to send request.'); return; }
                    showPendingApprovalScreen(_pendingRoll);
                    return;
                }

                // Normal mode — save profile directly
                const r = await fetch(`${API_BASE}/api/student/save-profile`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
                });
                const data = await r.json();
                if (!r.ok) { showMsg('profileMsg', 'err', data.error || 'Failed to save profile.'); return; }
                _token = data.token;
                _student = {
                    rollNumber: _pendingRoll, name,
                    className: classWithDiv,
                    division: division,
                    phone: document.getElementById('pPhone').value.trim(),
                    age: document.getElementById('pAge').value.trim(),
                    dateOfBirth: document.getElementById('pDob').value.trim()
                };
                localStorage.setItem('gp_student_token', _token);
                showScreen('dashboard'); loadDashboard();
            } catch (e) { showMsg('profileMsg', 'err', 'Connection error. Please try again.'); }
            finally { btn.disabled = false; btn.textContent = _isRequestMode ? 'Send Access Request →' : 'Save & Continue →'; }
        }

        /* ══ PENDING APPROVAL ══ */
        let _approvalCheckInterval = null;

        function showPendingApprovalScreen(roll) {
            _isRequestMode = false;
            _pendingRoll = roll;
            localStorage.setItem('gp_pending_roll', roll);  // persist so refresh restores this screen
            document.getElementById('pendingRollBadge').textContent = `📋 Roll: ${roll}`;
            document.getElementById('pendingStatusText').textContent = 'Waiting for teacher approval…';
            showScreen('pending');
            // Auto-check every 15 seconds
            if (_approvalCheckInterval) clearInterval(_approvalCheckInterval);
            _approvalCheckInterval = setInterval(checkApprovalNow, 15000);
        }

        async function checkApprovalNow() {
            if (!_pendingRoll) return;
            document.getElementById('pendingStatusText').textContent = 'Checking…';
            try {
                const r = await fetch(`${API_BASE}/api/student/check-request-status`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rollNumber: _pendingRoll, instituteCode: _instituteCode })
                });
                const data = await r.json();
                if (data.approved) {
                    // Approved! Log in
                    if (_approvalCheckInterval) clearInterval(_approvalCheckInterval);
                    localStorage.removeItem('gp_pending_roll');
                    document.getElementById('pendingStatusText').textContent = '✓ Approved! Logging you in…';
                    document.getElementById('pendingSpinner').style.borderTopColor = 'var(--green)';
                    await loginWithRoll(_pendingRoll);
                } else if (data.rejected) {
                    if (_approvalCheckInterval) clearInterval(_approvalCheckInterval);
                    localStorage.removeItem('gp_pending_roll');
                    _pendingRoll = '';
                    document.getElementById('pendingStatusText').textContent = '✗ Request was rejected. Contact your teacher.';
                    document.getElementById('pendingSpinner').style.display = 'none';
                } else {
                    document.getElementById('pendingStatusText').textContent = 'Still waiting for approval…';
                }
            } catch (e) {
                document.getElementById('pendingStatusText').textContent = 'Could not check — will retry…';
            }
        }

        function goBackToLogin() {
            if (_approvalCheckInterval) clearInterval(_approvalCheckInterval);
            _approvalCheckInterval = null;
            _isRequestMode = false;
            _pendingRoll = '';
            localStorage.removeItem('gp_pending_roll');
            // Reset profile screen text back to defaults
            document.getElementById('profileHeading').textContent = 'Complete your profile';
            document.getElementById('profileSubtext').textContent = 'One-time setup — your details are saved for all future logins.';
            document.getElementById('profileBtn').textContent = 'Save & Continue →';
            showScreen('login');
        }


        function loadDashboard() {
            if (!_student) return;
            const initials = (_student.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

            // sidebar
            document.getElementById('sidebarAvatar').textContent = initials;
            document.getElementById('sidebarName').textContent = _student.name || '—';
            document.getElementById('sidebarRoll').textContent = `Roll: ${_student.rollNumber}`;

            // dash header
            const first = (_student.name || 'Student').split(' ')[0];
            document.getElementById('dashName').textContent = `Hello, ${first}! 🎯`;
            document.getElementById('dashRoll').textContent = `Roll: ${_student.rollNumber}` + (_student.className ? `  ·  ${_student.className}` : '');

            // info
            document.getElementById('infoClass').textContent = _student.className || '—';
            document.getElementById('infoPhone').textContent = _student.phone || '—';
            document.getElementById('infoDate').textContent = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

            // footer
            document.getElementById('footerRoll').textContent = `Logged in as ${_student.rollNumber}`;

            loadTests();
            loadTestHistoryDashboard();
            // Prefer server-side stats when available, fallback to local
            (async function () {
                let stats = null;
                if (_student) {
                    try {
                        const r = await fetch(`${API_BASE}/api/student/stats/${encodeURIComponent(_student.rollNumber)}`);
                        if (r.ok) stats = await r.json();
                    } catch (e) { /* ignore */ }
                }
                if (stats) {
                    const completedEl = document.getElementById('statCompleted');
                    const avgEl = document.getElementById('statAvg');
                    const streakEl = document.querySelectorAll('.stat-tile .stat-num')[3];
                    if (completedEl) completedEl.textContent = stats.tests_completed || 0;
                    if (avgEl) avgEl.textContent = (typeof stats.avg_pct === 'number') ? `${stats.avg_pct}%` : '—';
                    if (streakEl) streakEl.textContent = stats.day_streak || 0;
                } else if (typeof updateDashboardStats === 'function') await updateDashboardStats();
            })();
        }

        async function loadTests() {
            document.getElementById('testsLoading').style.display = 'block';
            document.getElementById('testGrid').style.display = 'none';
            document.getElementById('testsEmpty').classList.add('hidden');
            try {
                const headers = { Authorization: `Bearer ${_token}` };
                const [onlineResp, histResp] = await Promise.all([
                    fetch(`${API_BASE}/api/student/online-tests`, { headers }),
                    _student ? fetch(`${API_BASE}/api/test-history/${encodeURIComponent(_student.rollNumber)}`) : Promise.resolve(null)
                ]);
                const onlineTests = onlineResp.ok ? await onlineResp.json() : [];
                let history = [];
                try { if (histResp && histResp.ok) history = await histResp.json(); } catch (_) { }
                // Count how many times each online test has been attempted
                const attemptCountMap = {};
                history.filter(h => h.online_test_id != null).forEach(h => {
                    const id = Number(h.online_test_id);
                    attemptCountMap[id] = (attemptCountMap[id] || 0) + 1;
                });
                // Mark each online test with attempt info
                const markedOnline = onlineTests.map(t => {
                    const attemptsUsed = attemptCountMap[Number(t.id)] || 0;
                    const maxAttempts = Number(t.maxAttempts) || 1;
                    const attemptsExhausted = attemptsUsed >= maxAttempts;
                    return {
                        ...t,
                        _isOnline: true,
                        attemptsUsed,
                        maxAttempts,
                        attemptsExhausted,
                        isAttempted: attemptsUsed > 0
                    };
                });
                window.renderTests(markedOnline);
            } catch (e) { document.getElementById('testsLoading').innerHTML = '⚠ Failed to load tests.'; }
        }

        function _renderTestsBase(tests) {
            document.getElementById('testsLoading').style.display = 'none';
            document.getElementById('statTests').textContent = tests.length || '0';
            document.getElementById('testPanelBadge').textContent = `${tests.length} Test${tests.length !== 1 ? 's' : ''}`;
            const nb = document.getElementById('navTestsBadge');
            nb.textContent = tests.length; nb.style.display = tests.length ? '' : 'none';
            const grid = document.getElementById('testGrid');
            if (!tests.length) { document.getElementById('testsEmpty').classList.remove('hidden'); return; }
            grid.style.display = 'flex';
            grid.innerHTML = tests.map((t, i) => {
                const date = t.updatedAt ? new Date(t.updatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                return `<div class="test-card" style="animation-delay:${i * 0.05}s">
            <span class="test-card-num">${String(i + 1).padStart(2, '0')}</span>
            <div class="test-card-icon">📖</div>
            <div class="test-card-body">
                <div class="test-card-title">${escHtml(t.chapter)}</div>
                <div class="test-card-sub">${t.topic ? escHtml(t.topic) + '  ·  ' : ''}${date}</div>
            </div>
            <span class="badge badge-open">Open</span>
        </div>`;
            }).join('');
        }

        /* ══ Load Test History for Dashboard ══ */
        async function loadTestHistoryDashboard() {
            // History panel removed from dashboard; only update sidebar badge
            try {
                let history = [];
                if (_student) {
                    try {
                        const res = await fetch(`${API_BASE}/api/test-history/${_student.rollNumber}`);
                        if (res.ok) history = await res.json();
                    } catch (e) { /* ignore */ }
                }
                if (!history.length) history = getTestHistory();

                // Update sidebar Test Analysis badge with attempted count
                const nb = document.getElementById('navTestsBadge');
                nb.textContent = history.length;
                nb.style.display = history.length ? '' : 'none';
            } catch (e) {
                console.error('Error loading test history:', e);
            }
        }

        /* ══ TEST ANALYSIS: Show List of All Attempted Tests ══ */
        // ── Paginated Test Analysis (infinite scroll, 7 per page) ────────────
        // State variables for pagination
        let _taPage = 0;           // last loaded page (0 = nothing loaded yet)
        let _taTotal = 0;          // total tests on server
        let _taHasMore = false;    // whether more pages exist
        let _taLoading = false;    // guard against concurrent fetches
        const TA_PAGE_SIZE = 7;

        // Render a helper that re-shows already-loaded data without a fetch
        function _taRenderExisting() {
            setActiveNav('tests');
            document.getElementById('topbarTitle').textContent = 'Test Analysis';
            // cards already in DOM — just make sure sentinel is correct
            const sentinel = document.getElementById('taScrollSentinel');
            if (sentinel) sentinel.style.display = _taHasMore ? '' : 'none';
        }

        // Build one card HTML for a test at absolute index `idx` in _testAnalysisData
        function _taCardHtml(test, idx) {
            const ts = test.timestamp;
            const dt = new Date(ts > 1e12 ? ts : ts * 1000);
            const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const pct = test.result?.pct || 0;
            const accentColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
            const pctColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
            const correct = test.result?.correct || 0;
            const wrong = test.result?.wrong || 0;
            const skipped = test.result?.skipped || 0;
            const isOnlineTest = !test.test?.lecture || test.test?.lecture === 'online' || (test.test?.lecture && /^\d+$/.test(String(test.test.lecture)) && String(test.test.lecture).length > 10);
            const testTitle = isOnlineTest
                ? escHtml(test.test?.chapter || test.test?.topic || 'Online Test')
                : escHtml(test.test?.chapter || 'Test');
            return `<div class="ta-test-card" onclick="openTestDetail(${idx})" style="animation:fadeUp .3s var(--ease) both">
                        <div class="ta-test-accent" style="background:${accentColor}"></div>
                        <div class="ta-test-card-inner">
                            <div class="ta-test-top">
                                <div style="flex:1;min-width:0">
                                    <div class="ta-test-title">${testTitle}</div>
                                    <div class="ta-test-date">🕐 ${dateStr} at ${timeStr}${test.result?.timeTaken ? ' · ⏱ ' + formatTime(test.result.timeTaken) : ''}</div>
                                </div>
                                <div>
                                    <div class="ta-pct-badge" style="color:${pctColor}">${pct}%</div>
                                    <div class="ta-pct-label">ACCURACY</div>
                                </div>
                            </div>
                            <div class="ta-stats-row">
                                <div class="ta-stat-chip" style="background:rgba(34,197,94,0.1)">
                                    <div class="ta-stat-chip-lbl">Correct</div>
                                    <div class="ta-stat-chip-val" style="color:#22c55e">${correct}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(239,68,68,0.1)">
                                    <div class="ta-stat-chip-lbl">Wrong</div>
                                    <div class="ta-stat-chip-val" style="color:#ef4444">${wrong}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(107,114,128,0.1)">
                                    <div class="ta-stat-chip-lbl">Skipped</div>
                                    <div class="ta-stat-chip-val" style="color:var(--text-faint)">${skipped}</div>
                                </div>
                                <div class="ta-stat-chip" style="background:rgba(167,139,250,0.1)">
                                    <div class="ta-stat-chip-lbl">Marks</div>
                                    <div class="ta-stat-chip-val" style="color:#a78bfa">${test.result?.marksScore ?? test.result?.marks ?? 0}</div>
                                </div>
                            </div>
                        </div>
                    </div>`;
        }

        // Append the next page of cards to the container (without clearing it)
        async function _taLoadNextPage() {
            if (_taLoading || (!_taHasMore && _taPage > 0)) return;
            _taLoading = true;
            const container = document.getElementById('testAnalysisListContainer');
            const sentinel = document.getElementById('taScrollSentinel');
            if (sentinel) sentinel.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-faint)"><span class="spin"></span> Loading more…</div>';

            try {
                const nextPage = _taPage + 1;
                const url = `${API_BASE}/api/test-history/${encodeURIComponent(_student.rollNumber)}?page=${nextPage}&limit=${TA_PAGE_SIZE}`;
                const res = await fetch(url, { headers: { Authorization: `Bearer ${_token}` } });
                if (!res.ok) throw new Error('fetch failed');
                const json = await res.json();

                const newTests = json.data || [];
                _taTotal = json.total || _taTotal;
                _taHasMore = json.hasMore || false;
                _taPage = nextPage;

                // Append to the global cache
                if (!window._testAnalysisData) window._testAnalysisData = [];
                const startIdx = window._testAnalysisData.length;
                window._testAnalysisData.push(...newTests);

                // Update summary stats based on ALL loaded tests so far
                const allLoaded = window._testAnalysisData;
                const totalTime = allLoaded.reduce((s, t) => s + (t.result?.timeTaken || 0), 0);
                const avgAcc = allLoaded.length ? Math.round(allLoaded.reduce((s, t) => s + (t.result?.pct || 0), 0) / allLoaded.length) : 0;
                const bestAcc = allLoaded.length ? Math.max(...allLoaded.map(t => t.result?.pct || 0)) : 0;
                const sumTests = document.getElementById('taSumTests');
                const sumAvg = document.getElementById('taSumAvg');
                const sumBest = document.getElementById('taSumBest');
                const sumTime = document.getElementById('taSumTime');
                if (sumTests) sumTests.textContent = _taTotal || allLoaded.length;
                if (sumAvg) sumAvg.textContent = avgAcc + '%';
                if (sumBest) sumBest.textContent = bestAcc + '%';
                if (sumTime) sumTime.textContent = formatTime(totalTime) || '—';

                // Append cards before the sentinel
                const fragment = document.createDocumentFragment();
                newTests.forEach((test, i) => {
                    const div = document.createElement('div');
                    div.innerHTML = _taCardHtml(test, startIdx + i);
                    fragment.appendChild(div.firstElementChild);
                });
                if (sentinel) container.insertBefore(fragment, sentinel);
                else container.appendChild(fragment);

                // Update sentinel
                if (sentinel) {
                    if (_taHasMore) {
                        sentinel.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.8rem">Scroll down to load more…</div>';
                        sentinel.style.display = '';
                    } else {
                        sentinel.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.75rem;font-family:var(--font-mono)">— All ' + window._testAnalysisData.length + ' tests loaded —</div>';
                        sentinel.style.display = '';
                        if (_taObserver) { _taObserver.disconnect(); _taObserver = null; }
                    }
                }
            } catch (err) {
                console.error('_taLoadNextPage error:', err);
                if (sentinel) sentinel.innerHTML = '<div style="text-align:center;padding:16px;color:var(--error)">⚠ Failed to load. <button onclick="_taLoadNextPage()" style="background:none;border:none;color:var(--cyan);cursor:pointer;text-decoration:underline">Retry</button></div>';
            } finally {
                _taLoading = false;
            }
        }

        // IntersectionObserver that fires _taLoadNextPage when sentinel is visible
        let _taObserver = null;
        function _taSetupObserver() {
            if (_taObserver) _taObserver.disconnect();
            const sentinel = document.getElementById('taScrollSentinel');
            if (!sentinel) return;
            _taObserver = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting && _taHasMore && !_taLoading) {
                    _taLoadNextPage();
                }
            }, { threshold: 0.1 });
            _taObserver.observe(sentinel);
        }

        async function showTestAnalysisList(doPushHistory = true) {
            showScreen('test-analysis', doPushHistory);
            document.getElementById('topbarTitle').textContent = 'Test Analysis';
            setActiveNav('tests');
            const container = document.getElementById('testAnalysisListContainer');

            if (!_student || !_student.rollNumber) {
                container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">⚠ Please log in to view your test history.</div>';
                return;
            }

            // Reset pagination state for a fresh load
            _taPage = 0;
            _taTotal = 0;
            _taHasMore = true;  // assume there's at least something to load
            _taLoading = false;
            window._testAnalysisData = [];

            // Clear container and add sentinel
            container.innerHTML = '<div id="taScrollSentinel"></div>';

            // Kick off first page load
            await _taLoadNextPage();

            // If nothing came back show empty state
            if (!window._testAnalysisData.length) {
                container.innerHTML = `<div style="text-align:center;padding:60px 20px">
                    <div style="font-size:3rem;margin-bottom:16px">📋</div>
                    <div style="font-family:var(--font-head);font-size:1.1rem;font-weight:700;color:var(--text);margin-bottom:8px">No tests attempted yet</div>
                    <div style="color:var(--text-faint);font-size:0.875rem">Start your first test from the Tests section!</div>
                </div>`;
                ['taSumTests', 'taSumAvg', 'taSumBest', 'taSumTime'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
                return;
            }

            // Set up the observer after first paint
            requestAnimationFrame(_taSetupObserver);
        }

        /* ══ TEST ANALYSIS: Open Test Summary (new intermediate screen) ══ */
        async function openTestDetail(idx, doPushHistory = true) {
            const test = window._testAnalysisData?.[idx];
            if (!test) return;
            window._tdCurrentTestIdx = idx; // store for "View Questions" btn
            showScreen('test-summary', doPushHistory);
            setActiveNav('tests');
            document.getElementById('topbarTitle').textContent = 'Test Details';

            // Title & date
            const ts = test.timestamp;
            const dt = new Date(ts > 1e12 ? ts : ts * 1000);
            const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            const lectureStr = String(test.test?.lecture || '');
            const isOnlineHistoryTest = !test.test?.lecture || test.test?.lecture === 'online' || /^\d+$/.test(lectureStr) || (test.questions && test.questions.length > 0);
            const testTitle = isOnlineHistoryTest
                ? (test.test?.chapter || test.test?.topic || 'Online Test')
                : (test.test?.chapter || 'Test');

            document.getElementById('tsSummaryTitle').textContent = testTitle;
            document.getElementById('tsSummaryDate').textContent = `Attempted on ${dateStr} at ${timeStr}`;

            // Basic stats
            const correct = test.result?.correct || 0;
            const wrong = test.result?.wrong || 0;
            const skipped = test.result?.skipped || 0;
            const total = test.result?.total || 1;
            const marks = test.result?.marksScore ?? 0;
            const maxMarks = test.result?.maxMarks || (total * 4);
            const pct = test.result?.pct || 0;
            const timeTaken = test.result?.timeTaken || 0;

            // Pie chart
            renderTsPie(correct, wrong, skipped, total, pct);

            // Legend values
            const safeDiv = (a, b) => b > 0 ? Math.round(a / b * 100) : 0;
            document.getElementById('tsLegCorrect').textContent = correct;
            document.getElementById('tsLegCorrectPct').textContent = safeDiv(correct, total) + '%';
            document.getElementById('tsLegWrong').textContent = wrong;
            document.getElementById('tsLegWrongPct').textContent = safeDiv(wrong, total) + '%';
            document.getElementById('tsLegSkipped').textContent = skipped;
            document.getElementById('tsLegSkippedPct').textContent = safeDiv(skipped, total) + '%';

            // Stat cards
            document.getElementById('tsMarks').textContent = marks >= 0 ? '+' + marks : marks;
            document.getElementById('tsMarksMax').textContent = `out of ${maxMarks}`;
            document.getElementById('tsTime').textContent = timeTaken ? formatTime(timeTaken) : '—';
            document.getElementById('tsTopper').textContent = '…';
            document.getElementById('tsAvg').textContent = '…';
            document.getElementById('tsAvgAttempts').textContent = 'Loading…';

            // Bars — your score vs max
            const maxPossible = maxMarks || 1;
            setTimeout(() => {
                const youPct = Math.max(0, Math.min(100, (marks / maxPossible) * 100));
                document.getElementById('tsBarYou').style.width = youPct + '%';
                document.getElementById('tsBarYouNum').textContent = marks;
            }, 80);

            // Fetch leaderboard stats
            try {
                let url = `${API_BASE}/api/test-leaderboard?`;
                if (test.online_test_id) {
                    url += `online_test_id=${encodeURIComponent(test.online_test_id)}`;
                } else {
                    url += `chapter=${encodeURIComponent(test.test?.chapter || '')}&lecture=${encodeURIComponent(test.test?.lecture || '')}`;
                }
                const r = await fetch(url);
                if (r.ok) {
                    const lb = await r.json();
                    const topper = lb.topper ?? null;
                    const avg = lb.avg ?? null;
                    document.getElementById('tsTopper').textContent = topper !== null ? topper : '—';
                    document.getElementById('tsAvg').textContent = avg !== null ? avg : '—';
                    document.getElementById('tsAvgAttempts').textContent = lb.attempts ? `${lb.attempts} attempt${lb.attempts !== 1 ? 's' : ''}` : '—';
                    const ref = Math.max(maxMarks, topper || 0, 1);
                    setTimeout(() => {
                        document.getElementById('tsBarTopper').style.width = (Math.min(100, ((topper || 0) / ref) * 100)) + '%';
                        document.getElementById('tsBarTopperNum').textContent = topper !== null ? topper : '—';
                        document.getElementById('tsBarAvg').style.width = (Math.min(100, ((avg || 0) / ref) * 100)) + '%';
                        document.getElementById('tsBarAvgNum').textContent = avg !== null ? avg : '—';
                        document.getElementById('tsBarYou').style.width = (Math.min(100, (marks / ref) * 100)) + '%';
                    }, 200);
                }
            } catch (e) {
                document.getElementById('tsTopper').textContent = '—';
                document.getElementById('tsAvg').textContent = '—';
                document.getElementById('tsAvgAttempts').textContent = 'Unavailable';
            }
        }

        function renderTsPie(correct, wrong, skipped, total, pct) {
            const svg = document.getElementById('tsPieChart');
            // Remove old segments
            svg.querySelectorAll('.ts-seg').forEach(el => el.remove());
            const cx = 80, cy = 80, r = 60, strokeW = 22;
            const circumference = 2 * Math.PI * r;
            const data = [
                { val: correct, color: '#22c55e' },
                { val: wrong, color: '#ef4444' },
                { val: skipped, color: '#6b7280' },
            ];
            const sum = data.reduce((s, d) => s + d.val, 0) || 1;
            let offset = 0;
            const gap = circumference * 0.012; // small gap between segments

            // Insert before the text elements
            const textEls = svg.querySelectorAll('text');
            data.forEach(({ val, color }) => {
                const fraction = val / sum;
                const dash = Math.max(0, fraction * circumference - gap);
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('class', 'ts-seg');
                circle.setAttribute('cx', cx);
                circle.setAttribute('cy', cy);
                circle.setAttribute('r', r);
                circle.setAttribute('fill', 'none');
                circle.setAttribute('stroke', color);
                circle.setAttribute('stroke-width', strokeW);
                circle.setAttribute('stroke-dasharray', `${dash} ${circumference}`);
                circle.setAttribute('stroke-dashoffset', -offset * circumference);
                circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
                circle.style.transition = 'stroke-dasharray 0.8s cubic-bezier(.4,0,.2,1)';
                svg.insertBefore(circle, textEls[0]);
                offset += fraction;
            });

            // Center text
            const pctEl = document.getElementById('tsPiePct');
            const accentColor = pct >= 75 ? '#22c55e' : pct >= 50 ? '#fbbf24' : '#ef4444';
            pctEl.textContent = pct + '%';
            pctEl.setAttribute('fill', accentColor);
        }

        /* Opens the full question viewer from the summary screen */
        async function openTestDetailFromSummary() {
            const idx = window._tdCurrentTestIdx;
            if (idx === undefined) return;
            await _openTestDetailInner(idx);
        }

        /* ══ TEST ANALYSIS: Open Test Detail (Question viewer) ══ */
        async function _openTestDetailInner(idx) {
            const test = window._testAnalysisData?.[idx];
            if (!test) return;
            showScreen('test-detail');
            setActiveNav('tests');
            document.getElementById('topbarTitle').textContent = 'Test Details';

            // Robust timestamp: server stores Date.now() = ms; some older entries may be seconds
            const ts = test.timestamp;
            const dt = new Date(ts > 1e12 ? ts : ts * 1000);
            const dateStr = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            const timeStr = dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

            // Online tests: have no lecture (or lecture='online'), OR have stored questions array in the record,
            // OR their lecture is a very large numeric ID (>10 digits = ms timestamp, not a lecture number 1-999).
            // Star-quiz tests use short lecture strings like "1", "2", "10", etc.
            const lectureStr = String(test.test?.lecture || '');
            // Online tests store their DB id or the string 'online' as the lecture value.
            // Star-quiz tests always use short lecture strings like "1", "3", "10".
            // Online tests: lecture is null/empty, 'online', OR a pure integer (online_tests.id, any length).
            // Also detect via questions array already populated by server.
            const isOnlineHistoryTest = !test.test?.lecture
                || test.test?.lecture === 'online'
                || /^\d+$/.test(lectureStr)
                || (test.questions && test.questions.length > 0);
            document.getElementById('testDetailTitle').textContent = isOnlineHistoryTest
                ? (test.test?.chapter || test.test?.topic || 'Online Test')
                : `${test.test?.chapter || 'Test'}`;
            document.getElementById('testDetailAttemptTime').textContent = `Attempted on ${dateStr} at ${timeStr}`;
            document.getElementById('testDetailScore').textContent = `${test.result?.correct || 0}/${test.result?.total || 0}`;
            document.getElementById('testDetailAccuracy').textContent = `${test.result?.pct || 0}%`;
            document.getElementById('testDetailMarks').textContent = test.result?.marksScore ?? test.result?.marks ?? 0;
            document.getElementById('testDetailTime').textContent = test.result?.timeTaken ? formatTime(test.result.timeTaken) : '—';

            // Performance bars
            const total = test.result?.total || 1;
            const c = test.result?.correct || 0, w = test.result?.wrong || 0, s = test.result?.skipped || 0;
            setTimeout(() => {
                const bc = document.getElementById('tdBarCorrect'), bw = document.getElementById('tdBarWrong'), bs = document.getElementById('tdBarSkip');
                if (bc) bc.style.width = (c / total * 100) + '%';
                if (bw) bw.style.width = (w / total * 100) + '%';
            }, 100);
            const lc = document.getElementById('tdLblCorrect'), lw = document.getElementById('tdLblWrong'), ls = document.getElementById('tdLblSkip');
            if (lc) lc.textContent = `Correct (${c})`;
            if (lw) lw.textContent = `Wrong (${w})`;
            if (ls) ls.textContent = `Skipped (${s})`;

            const questionsContainer = document.getElementById('testDetailQuestions');
            const qLabel = null; // Legacy — kept for fallback paths; primary UI uses split-panel now
            // Reset state
            window._tdQuestions = [];
            window._tdCurrentFilter = 'all';
            window._tdCurrentQIdx = 0;
            // Reset palette filter buttons
            ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'].forEach(id => {
                const b = document.getElementById(id);
                if (!b) return;
                b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
            });
            ['tdrfAllL', 'tdrfCorrectL', 'tdrfWrongL', 'tdrfSkippedL'].forEach(id => {
                const b = document.getElementById(id);
                if (!b) return;
                b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
            });
            const allRfBtn = document.getElementById('tdrfAll');
            if (allRfBtn) allRfBtn.classList.add('active-all');
            const allRfBtnL = document.getElementById('tdrfAllL');
            if (allRfBtnL) allRfBtnL.classList.add('active-all');
            // Clear viewer
            const viewer = document.getElementById('tdQuestionViewer');
            if (viewer) viewer.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--text-faint)"><span class="spin"></span> Loading questions…</div>';

            try {
                questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)"><span class="spin"></span> Loading questions…</div>';

                // For online tests, questions aren't in star-quiz bank — use stored questions if available
                if (isOnlineHistoryTest) {
                    const storedQuestions = test.questions || [];
                    const rawAnswersList = test.answers || [];

                    if (!storedQuestions.length) {
                        // Old history records without stored questions — show answer summary
                        if (!rawAnswersList.length) {
                            questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">📝 No answer details available for this test.</div>';
                        } else {
                            const c = test.result?.correct || 0, w = test.result?.wrong || 0, sk = test.result?.skipped || 0, tot = test.result?.total || rawAnswersList.length;
                            questionsContainer.innerHTML = `
                                <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px">
                                    <div style="font-size:0.75rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;font-weight:700">Answer Summary (${tot} Questions)</div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px">
                                        ${rawAnswersList.map((item, i) => {
                                const sc = Array.isArray(item) ? String(item[2] || 's').charAt(0) : 's';
                                const color = sc === 'c' ? '#22c55e' : sc === 'w' ? '#ef4444' : 'var(--text-faint)';
                                const bg = sc === 'c' ? 'rgba(34,197,94,0.1)' : sc === 'w' ? 'rgba(239,68,68,0.1)' : 'var(--bg-card)';
                                const label = sc === 'c' ? '✓' : sc === 'w' ? '✗' : '—';
                                const ans = Array.isArray(item) ? String(item[1] || '').trim() : '';
                                const ansLabel = ans && ans !== '' && ans !== '-1' ? ['A', 'B', 'C', 'D'][parseInt(ans)] || ans : '';
                                return `<div style="background:${bg};border:1px solid ${color};border-radius:8px;padding:8px 6px;text-align:center">
                                                <div style="font-size:0.7rem;color:var(--text-faint)">Q${i + 1}</div>
                                                <div style="font-size:1rem;color:${color};font-weight:700">${label}</div>
                                                ${ansLabel ? `<div style="font-size:0.72rem;color:${color}">${ansLabel}</div>` : ''}
                                            </div>`;
                            }).join('')}
                                    </div>
                                </div>
                                <div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.82rem">
                                    💡 Detailed question review is only available for tests taken after the latest update.
                                </div>`;
                        }
                        if (qLabel) qLabel.textContent = `${test.result?.total || rawAnswersList.length} Questions`;
                        return;
                    }

                    // We have stored questions — render full analysis just like star-quiz tests
                    // Build answersByIndex map from raw answers
                    const answersByIndex = new Map();
                    rawAnswersList.forEach((item, fallbackIdx) => {
                        if (!item) return;
                        let qIdx = fallbackIdx, rawAnswer, rawStatus;
                        if (Array.isArray(item)) {
                            // Compact format: [idx, answer, statusChar]
                            qIdx = item[0] ?? fallbackIdx; rawAnswer = item[1]; rawStatus = item[2];
                        } else if (item && typeof item === 'object') {
                            // Object format from server: {idx, studentAnswer, status}
                            qIdx = item.idx ?? item.index ?? fallbackIdx;
                            rawAnswer = item.studentAnswer ?? item.answer ?? item.a ?? null;
                            rawStatus = item.status ?? item.s ?? '';
                        } else {
                            rawAnswer = item; rawStatus = '';
                        }
                        const sc = String(rawStatus || 's').charAt(0).toLowerCase();
                        let answerIdxs = null;
                        const raw = String(rawAnswer ?? '').trim();
                        if (raw !== '' && raw !== '-1' && raw !== 'null' && raw !== 'undefined') {
                            if (raw.includes(',')) answerIdxs = raw.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n >= 0);
                            else { const n = parseInt(raw, 10); if (!isNaN(n) && n >= 0) answerIdxs = [n]; }
                        }
                        const status = sc === 'c' ? 'correct' : sc === 'w' ? 'wrong' : (answerIdxs?.length ? 'attempted' : 'skipped');
                        answersByIndex.set(parseInt(String(qIdx), 10), { storedIdx: parseInt(String(qIdx), 10), fallbackIdx, answerIdxs, status });
                    });

                    if (qLabel) qLabel.textContent = `QUESTION REVIEW · ${storedQuestions.length} QUESTIONS`;

                    window._tdQuestions = storedQuestions.map((q, qi) => {
                        const ans = answersByIndex.get(qi) || { status: 'skipped', answerIdxs: null };
                        const isNum = _isNumericalQ(q);
                        const rawAnsIdxs = ans.answerIdxs || [];
                        const correctIdxs = Array.isArray(q.correctIndexes) ? q.correctIndexes : (typeof q.correctIndex === 'number' ? [q.correctIndex] : [0]);
                        let answerIdxs, status;
                        if (isNum) {
                            const rawAns = ans.rawAnswer || '';
                            const numAns = parseFloat(rawAns);
                            if (rawAns !== '' && !isNaN(numAns)) {
                                answerIdxs = [rawAns];
                                const numCorrect = parseFloat(q.numericalAnswer);
                                status = (!isNaN(numCorrect) && Math.abs(numAns - numCorrect) < 0.001) ? 'correct' : 'wrong';
                            } else {
                                answerIdxs = []; status = 'skipped';
                            }
                            return { q, qidx: qi, answerIdxs, correctIdxs: [String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')], status };
                        }
                        const normalizeList = arr => [...new Set((arr || []).map(v => parseInt(v, 10)).filter(v => !isNaN(v) && v >= 0))].sort((a, b) => a - b);
                        const ansNorm = normalizeList(rawAnsIdxs);
                        const corrNorm = normalizeList(correctIdxs);
                        const hasAttempt = ansNorm.length > 0;
                        status = ans.status;
                        if (!hasAttempt) { status = 'skipped'; }
                        else if (status !== 'correct' && status !== 'wrong') {
                            const same = ansNorm.length === corrNorm.length && ansNorm.every((v, i) => v === corrNorm[i]);
                            status = same ? 'correct' : 'wrong';
                        }
                        return { q, qidx: qi, answerIdxs: ansNorm, correctIdxs, status };
                    });

                    window._tdCurrentFilter = 'all';
                    window._tdCurrentQIdx = 0;
                    tdBuildPalette();
                    tdShowQuestion(0);
                    tdUpdateFilterCounts();
                    return;
                }

                const chapterParam = test.test?.chapter ? encodeURIComponent(test.test.chapter) : '_none_';
                // Normalize lecture: SQLite may return 3.0 for integer 3; strip trailing .0
                const rawLec = String(test.test?.lecture || '');
                const normLec = rawLec.match(/^\d+\.0$/) ? String(parseInt(rawLec)) : rawLec;
                const lectureParam = encodeURIComponent(normLec);
                const response = await fetch(`${API_BASE}/api/star-quiz/question/${chapterParam}/${lectureParam}`);
                if (!response.ok) {
                    if (response.status === 404) {
                        // Question bank not available, but show answer summary if we have answers
                        const rawAnswersList = test.answers || [];
                        if (!rawAnswersList.length) {
                            questionsContainer.innerHTML = `<div style="text-align:center;padding:48px 24px">
                                <div style="font-size:2.5rem;margin-bottom:14px">📭</div>
                                <div style="font-family:var(--font-head);font-size:1rem;font-weight:700;color:var(--text);margin-bottom:8px">Question bank not available</div>
                                <div style="color:var(--text-faint);font-size:0.82rem">The question set for this test may have been updated or removed. Your score and answers are still saved.</div>
                            </div>`;
                        } else {
                            // Show answer summary fallback
                            const c = test.result?.correct || 0, w = test.result?.wrong || 0, sk = test.result?.skipped || 0, tot = test.result?.total || rawAnswersList.length;
                            questionsContainer.innerHTML = `
                                <div style="background:var(--bg-input);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px">
                                    <div style="font-size:0.75rem;color:var(--text-faint);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;font-weight:700">Answer Summary (${tot} Questions)</div>
                                    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:8px">
                                        ${rawAnswersList.map((item, i) => {
                                const sc = Array.isArray(item) ? String(item[2] || 's').charAt(0) : 's';
                                const color = sc === 'c' ? '#22c55e' : sc === 'w' ? '#ef4444' : 'var(--text-faint)';
                                const bg = sc === 'c' ? 'rgba(34,197,94,0.1)' : sc === 'w' ? 'rgba(239,68,68,0.1)' : 'var(--bg-card)';
                                const label = sc === 'c' ? '✓' : sc === 'w' ? '✗' : '—';
                                const ans = Array.isArray(item) ? String(item[1] || '').trim() : '';
                                const ansLabel = ans && ans !== '' && ans !== '-1' ? ['A', 'B', 'C', 'D'][parseInt(ans)] || ans : '';
                                return `<div style="background:${bg};border:1px solid ${color};border-radius:8px;padding:8px 6px;text-align:center">
                                                <div style="font-size:0.7rem;color:var(--text-faint)">Q${i + 1}</div>
                                                <div style="font-size:1rem;color:${color};font-weight:700">${label}</div>
                                                ${ansLabel ? `<div style="font-size:0.72rem;color:${color}">${ansLabel}</div>` : ''}
                                            </div>`;
                            }).join('')}
                                    </div>
                                </div>
                                <div style="text-align:center;padding:16px;color:var(--text-faint);font-size:0.82rem">
                                    💡 The question set for this test may have been updated or removed. Your score and answers are still saved above.
                                </div>`;
                        }
                        if (qLabel) qLabel.textContent = `${test.result?.total || rawAnswersList.length} Questions`;
                        return;
                    }
                    throw new Error(`Server returned ${response.status} while fetching question bank`);
                }
                const questionPack = await response.json();
                const questions = Array.isArray(questionPack.questions) ? questionPack.questions : [];

                if (!questions.length) {
                    questionsContainer.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-faint)">No question details available for this test.</div>';
                    return;
                }

                // ══ VISIBLE DEBUG BANNER ══
                const debugBanner = document.createElement('div');
                debugBanner.id = 'td-debug-banner';
                debugBanner.style.cssText = 'background:#1a1a2e;border:1px solid #f59e0b;border-radius:8px;padding:12px 14px;margin-bottom:12px;font-family:monospace;font-size:0.72rem;color:#fbbf24;white-space:pre-wrap;word-break:break-all';
                questionsContainer.prepend(debugBanner);

                // ══ BUILD ANSWER MAP ══
                // Answers are stored as compact arrays: [questionIndex, studentAnswer, statusChar]
                // Key insight: always map by POSITION (array index) as primary strategy,
                // since the questions are fetched in the same order they were presented.
                const answersByIndex = new Map();
                const rawAnswersList = test.answers || [];

                function parseOneAnswer(item, fallbackIdx) {
                    if (item === null || item === undefined) return null;
                    let qIdx, rawAnswer, rawStatus;
                    if (Array.isArray(item)) {
                        // Compact format: [idx, answer, statusChar]
                        qIdx = item[0];
                        rawAnswer = item[1];
                        rawStatus = item[2];
                    } else if (typeof item !== 'object') {
                        // Legacy format: primitive answer value in array position order
                        qIdx = fallbackIdx;
                        rawAnswer = item;
                        rawStatus = '';
                    } else {
                        qIdx = item.idx ?? item.index ?? fallbackIdx;
                        rawAnswer = item.studentAnswer ?? item.answer ?? item.a ?? null;
                        rawStatus = item.status ?? item.s ?? 's';
                    }
                    const sc = String(rawStatus || 's').charAt(0).toLowerCase();

                    let answerIdxs = null;
                    const raw = String(rawAnswer ?? '').trim();
                    const rawForNum = raw;
                    if (raw !== '' && raw !== '-1' && raw !== 'null' && raw !== 'undefined') {
                        if (raw.includes(',')) {
                            answerIdxs = raw.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n >= 0);
                        } else {
                            const n = parseInt(raw, 10);
                            if (!isNaN(n) && n >= 0) answerIdxs = [n];
                        }
                    }
                    const status = sc === 'c'
                        ? 'correct'
                        : sc === 'w'
                            ? 'wrong'
                            : (Array.isArray(answerIdxs) && answerIdxs.length > 0 ? 'attempted' : 'skipped');
                    // Coerce stored idx to integer (handles BigInt/string)
                    const storedIdx = parseInt(String(qIdx), 10);
                    return { storedIdx, fallbackIdx, answerIdxs, status, rawAnswer: rawForNum };
                }

                // PRIMARY: map by array position (fallbackIdx). This is always reliable
                // because answers are stored in question order.
                rawAnswersList.forEach((item, fallbackIdx) => {
                    const parsed = parseOneAnswer(item, fallbackIdx);
                    if (!parsed) return;
                    answersByIndex.set(fallbackIdx, { answerIdxs: parsed.answerIdxs, status: parsed.status, rawAnswer: parsed.rawAnswer });
                });

                // SECONDARY: if stored idx differs from position, also register by storedIdx
                // so lookups work either way.
                rawAnswersList.forEach((item, fallbackIdx) => {
                    const parsed = parseOneAnswer(item, fallbackIdx);
                    if (!parsed) return;
                    if (!isNaN(parsed.storedIdx) && parsed.storedIdx !== fallbackIdx) {
                        if (!answersByIndex.has(parsed.storedIdx)) {
                            answersByIndex.set(parsed.storedIdx, { answerIdxs: parsed.answerIdxs, status: parsed.status, rawAnswer: parsed.rawAnswer });
                        }
                    }
                });

                // ══ DEBUG ══
                console.group('🔍 Answer Debug');
                console.log('raw test.answers[0..2]:', JSON.stringify(rawAnswersList.slice(0, 3)));
                console.log('map size:', answersByIndex.size, '/ questions:', questions.length);
                answersByIndex.forEach((v, k) => console.log(`  Q${k}:`, v.status, v.answerIdxs));
                console.groupEnd();

                // Update visible debug banner
                let dbgLines = 'RAW answers[0..4]: ' + JSON.stringify(rawAnswersList.slice(0, 5));
                dbgLines += '\nMap entries (' + answersByIndex.size + ' / ' + questions.length + ' questions):';
                answersByIndex.forEach((v, k) => { dbgLines += '\n  [' + k + '] status=' + v.status + ' ans=' + JSON.stringify(v.answerIdxs); });
                if (answersByIndex.size === 0) dbgLines += '\n⚠ MAP IS EMPTY — answers not parsed!';
                debugBanner.textContent = dbgLines;

                const LTRS = ['A', 'B', 'C', 'D', 'E'];

                // ══ BUILD QUESTION DATA ARRAY for split-panel viewer ══
                window._tdQuestions = questions.map((q, qidx) => {
                    const stored = answersByIndex.get(qidx) || { answerIdxs: null, status: 'skipped' };
                    const isNum = _isNumericalQ(q);
                    let answerIdxs = stored.answerIdxs || [];
                    let correctIdxs = q.correctIndexes || (q.correctIndex !== undefined ? [q.correctIndex] : [0]);
                    let status = stored.status;
                    if (isNum) {
                        // For numerical: answerIdxs holds the raw numeric string
                        const rawAns = stored.rawAnswer || '';
                        const numAns = parseFloat(rawAns);
                        if (rawAns !== '' && !isNaN(numAns)) {
                            answerIdxs = [rawAns]; // store raw string for display
                            const numCorrect = parseFloat(q.numericalAnswer);
                            if (!isNaN(numCorrect) && Math.abs(numAns - numCorrect) < 0.001) {
                                status = 'correct';
                            } else {
                                status = 'wrong';
                            }
                        } else {
                            answerIdxs = [];
                            if (status !== 'correct' && status !== 'wrong') status = 'skipped';
                        }
                        correctIdxs = [String(q.numericalAnswer ?? q.correct_answer ?? 'N/A')];
                    } else {
                        const normalizeIndexList = (arr) => [...new Set((arr || []).map(v => parseInt(v, 10)).filter(v => !isNaN(v) && v >= 0))].sort((a, b) => a - b);
                        const ansNorm = normalizeIndexList(answerIdxs);
                        const corrNorm = normalizeIndexList(correctIdxs);
                        const hasAttempt = ansNorm.length > 0;
                        if (!hasAttempt) { status = 'skipped'; }
                        else if (status !== 'correct' && status !== 'wrong') {
                            const same = ansNorm.length === corrNorm.length && ansNorm.every((v, i) => v === corrNorm[i]);
                            status = same ? 'correct' : 'wrong';
                        }
                        answerIdxs = ansNorm;
                        correctIdxs = corrNorm;
                    }
                    return { q, qidx, answerIdxs, correctIdxs, status };
                });

                // Build palette and show first question
                window._tdCurrentFilter = 'all';
                window._tdCurrentQIdx = 0;
                tdBuildPalette();
                tdShowQuestion(0);
                tdUpdateFilterCounts();

            } catch (e) {
                console.error('openTestDetail error:', e);
                questionsContainer.innerHTML = `<div style="text-align:center;padding:40px;color:var(--error)">⚠ Failed to load question details.<br><span style="font-size:0.8rem;color:var(--text-faint)">${e.message}</span></div>`;
            }
        }

        function toggleSolution(card) {
            const sol = card.querySelector('.td-solution');
            if (!sol) return;
            const hidden = sol.classList.toggle('td-solution-hidden');
            if (!hidden && window.MathJax?.typesetPromise) {
                window.MathJax.typesetPromise([sol]).catch(() => { });
            }
        }

        /* ══ SPLIT-PANEL: Palette + Navigation ══ */

        function tdGetFilteredIndices() {
            const qs = window._tdQuestions || [];
            const filter = window._tdCurrentFilter || 'all';
            return qs.map((d, i) => filter === 'all' || d.status === filter ? i : -1).filter(i => i >= 0);
        }

        function tdBuildPalette() {
            const grid = document.getElementById('tdPaletteGrid');
            if (!grid) return;
            const qs = window._tdQuestions || [];
            const filter = window._tdCurrentFilter || 'all';
            grid.innerHTML = qs.map((d, i) => {
                const palCls = d.status === 'correct' ? 'pal-correct' : d.status === 'wrong' ? 'pal-wrong' : 'pal-skipped';
                const isActive = i === window._tdCurrentQIdx ? ' pal-active' : '';
                const hidden = (filter !== 'all' && d.status !== filter) ? ' pal-hidden' : '';
                const LTRS = ['A', 'B', 'C', 'D', 'E'];
                const ansLabel = d.answerIdxs?.length ? d.answerIdxs.map(x => LTRS[x] || x).join(',') : '';
                return `<button class="td-palette-btn ${palCls}${isActive}${hidden}" onclick="tdJumpTo(${i})" title="Q${i + 1} · ${d.status}">
                    ${i + 1}
                    ${ansLabel ? `<span class="td-palette-btn-ans">${ansLabel}</span>` : ''}
                </button>`;
            }).join('');
        }

        function tdJumpTo(idx) {
            const qs = window._tdQuestions || [];
            if (idx < 0 || idx >= qs.length) return;
            window._tdCurrentQIdx = idx;
            tdShowQuestion(idx);
            tdBuildPalette();
            // Scroll palette btn into view
            const grid = document.getElementById('tdPaletteGrid');
            if (grid) {
                const btn = grid.children[idx];
                if (btn) btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        function tdNavigate(dir) {
            const filtered = tdGetFilteredIndices();
            if (!filtered.length) return;
            const curPos = filtered.indexOf(window._tdCurrentQIdx);
            let nextPos;
            if (curPos === -1) {
                nextPos = dir > 0 ? 0 : filtered.length - 1;
            } else {
                nextPos = curPos + dir;
                if (nextPos < 0) nextPos = filtered.length - 1;
                if (nextPos >= filtered.length) nextPos = 0;
            }
            tdJumpTo(filtered[nextPos]);
        }

        function tdShowQuestion(idx) {
            const viewer = document.getElementById('tdQuestionViewer');
            if (!viewer) return;
            const qs = window._tdQuestions || [];
            const d = qs[idx];
            if (!d) { viewer.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-faint)">No question data.</div>'; return; }

            const { q, qidx, answerIdxs, correctIdxs, status } = d;
            const LTRS = ['A', 'B', 'C', 'D', 'E'];
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const isCorrect = status === 'correct';
            const isWrong = status === 'wrong';
            const isSkipped = status === 'skipped';
            const statusColor = isCorrect ? '#22c55e' : isWrong ? '#ef4444' : '#6b7280';
            const statusText = isCorrect ? '✓ Correct' : isWrong ? '✗ Wrong' : '— Not Attempted';
            const statusBg = isCorrect
                ? (isLight ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.18)')
                : isWrong
                    ? (isLight ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.16)')
                    : (isLight ? 'rgba(107,114,128,0.08)' : 'rgba(107,114,128,0.1)');
            const statusBorder = isCorrect
                ? (isLight ? 'rgba(34,197,94,0.3)' : 'rgba(34,197,94,0.7)')
                : isWrong
                    ? (isLight ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.7)')
                    : 'var(--border)';

            // Update pill in left header
            const pill = document.getElementById('tdCurrentStatusPill');
            if (pill) {
                pill.textContent = statusText;
                pill.style.background = statusBg;
                pill.style.color = statusColor;
                pill.style.borderColor = statusBorder;
            }

            // Counter
            const filtered = tdGetFilteredIndices();
            const posInFiltered = filtered.indexOf(idx) + 1;
            const counter = document.getElementById('tdNavCounter');
            if (counter) counter.textContent = `Q${idx + 1} · ${posInFiltered}/${filtered.length}`;

            // Prev/Next button state
            const btnPrev = document.getElementById('tdNavPrev'), btnNext = document.getElementById('tdNavNext');
            if (btnPrev) btnPrev.disabled = filtered.length <= 1;
            if (btnNext) btnNext.disabled = filtered.length <= 1;

            // Question image
            const qImg = q.questionImage || q.image || null;
            const qImgHtml = qImg ? `<div class="td-q-img"><img src="${qImg.startsWith('http') ? qImg : 'data:image/' + getMimeType(qImg) + ';base64,' + qImg}" alt="" onerror="this.parentElement.style.display='none'"></div>` : '';

            // Tables / matrices attached to this question
            const _tdAllTables = _normalizeTablesField(q.tables);
            const _tdTablesIntro = _tdAllTables.filter(t => (t.position || 'after_intro') !== 'after_options');
            const _tdTablesOptions = _tdAllTables.filter(t => (t.position || 'after_intro') === 'after_options');
            const tdTablesIntroHtml = _tdTablesIntro.length ? renderTablesHtml(_tdTablesIntro) : '';
            const tdTablesOptionsHtml = _tdTablesOptions.length ? renderTablesHtml(_tdTablesOptions) : '';

            const isTdNumerical = _isNumericalQ(q);
            const _tdOptTables = _twGetOptionTables(q);
            const opts = (q.options && q.options.length) ? q.options : (_tdOptTables.some(Boolean) ? [null, null, null, null] : (q.options || []));
            const optsHtml = isTdNumerical ? '' : opts.map((opt, oi) => {
                const isPick = answerIdxs.includes(oi);
                const isRight = correctIdxs.includes(oi);
                let bg = 'var(--bg-input)', border = 'var(--border)', indicator = '', lblBg = 'var(--bg-input)', lblColor = 'var(--text-faint)';
                if (isRight) { bg = isLight ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.18)'; border = isLight ? 'rgba(34,197,94,0.5)' : 'rgba(34,197,94,0.85)'; indicator = '✓'; lblBg = isLight ? 'rgba(34,197,94,0.2)' : 'rgba(34,197,94,0.3)'; lblColor = '#22c55e'; }
                if (isPick && !isRight) { bg = isLight ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.18)'; border = isLight ? 'rgba(239,68,68,0.5)' : 'rgba(239,68,68,0.85)'; indicator = '✗'; lblBg = isLight ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.3)'; lblColor = '#ef4444'; }
                if (isPick && isRight) { bg = isLight ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.24)'; border = isLight ? 'rgba(34,197,94,0.6)' : '#22c55e'; indicator = '✓'; lblBg = isLight ? 'rgba(34,197,94,0.28)' : 'rgba(34,197,94,0.38)'; lblColor = '#22c55e'; }
                const optImg = q.optionImages?.[oi];
                const optImgHtml = optImg ? `<img src="${optImg.startsWith('http') ? optImg : 'data:image/jpeg;base64,' + optImg}" style="max-width:100%;max-height:100px;object-fit:contain;margin-top:6px;border-radius:5px;display:block" onerror="this.style.display='none'">` : '';
                const optTbl = _tdOptTables[oi] || null;
                const optBody = optTbl ? _twRenderSingleTable(optTbl) : `${mdTablesToHtml(opt || '')}${optImgHtml}`;
                return `<div class="td-opt" style="background:${bg};border-color:${border}">
                    <span class="td-opt-lbl" style="background:${lblBg};color:${lblColor}">${LTRS[oi]}</span>
                    <span class="td-opt-text">${optBody}</span>
                    ${indicator ? `<span style="font-weight:700;color:${isRight ? '#22c55e' : '#ef4444'};flex-shrink:0;font-size:1rem">${indicator}</span>` : ''}
                </div>`;
            }).join('');

            const yourAnsText = isTdNumerical
                ? (answerIdxs.length ? escHtml(String(answerIdxs[0])) : 'Not Attempted')
                : (answerIdxs.length ? answerIdxs.map(i => LTRS[i] || i).join(', ') : 'Not Attempted');
            const correctAnsText = isTdNumerical
                ? escHtml(String(q.numericalAnswer ?? q.correct_answer ?? 'N/A'))
                : correctIdxs.map(i => LTRS[i] || i).join(', ');
            const yourAnsColor = isSkipped ? 'var(--text-faint)' : isCorrect ? '#22c55e' : '#ef4444';

            // Solution — always visible (no tap needed)
            const solutionItems = Array.isArray(q.solutions) && q.solutions.length ? q.solutions
                : (q.solution ? [{ text: String(q.solution) }] : []);
            const hasSolution = solutionItems.some(s => s && (s.text || s.image));
            const solInnerHtml = hasSolution ? solutionItems.filter(Boolean).map(s => {
                const solText = s.text ? `<div class="td-solution-text">${escHtml(normalizeSolutionForDisplay(s.text))}</div>` : '';
                const solImg = s.image ? `<img src="${s.image.startsWith('http') ? s.image : 'data:image/' + getMimeType(s.image) + ';base64,' + s.image}" style="max-width:100%;border-radius:8px;margin-top:8px;display:block" onerror="this.style.display='none'">` : '';
                return solText + solImg;
            }).join('') : '';
            const solutionBlock = hasSolution
                ? `<div class="td-solution-block">
                    <div class="td-solution-label">💡 SOLUTION</div>
                    ${solInnerHtml}
                   </div>`
                : '';

            // Subject chip
            const subjectChip = q.subject ? `<span class="td-q-subject-chip">${escHtml(q.subject)}</span>` : '';

            viewer.innerHTML = `
                <div class="td-q-number">
                    Q${qidx + 1} of ${qs.length}
                    ${subjectChip}
                </div>
                <div class="td-q-text">${mdTablesToHtml(q.question || 'N/A')}</div>
                ${tdTablesIntroHtml}
                ${qImgHtml}
                <div style="margin:16px 0">${optsHtml || (isTdNumerical ? '<div style="padding:20px;text-align:center;background:rgba(251,191,36,0.08);border:1.5px dashed rgba(251,191,36,0.3);border-radius:12px;color:var(--text-faint);font-size:0.9rem">🔢 Numerical answer question</div>' : '')}</div>
                ${tdTablesOptionsHtml}
                <div class="td-ans-grid">
                    <div class="td-ans-box" style="background:var(--bg-input);border:1px solid var(--border)">
                        <div class="td-ans-box-lbl">Your Answer</div>
                        <div class="td-ans-box-val" style="color:${yourAnsColor}">${yourAnsText}</div>
                    </div>
                    <div class="td-ans-box" style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.25);border-left:3px solid #22c55e">
                        <div class="td-ans-box-lbl">Correct Answer</div>
                        <div class="td-ans-box-val" style="color:#22c55e">${correctAnsText}</div>
                    </div>
                </div>
                ${solutionBlock}
            `;

            // MathJax typeset
            if (window.MathJax?.typesetPromise) {
                window.MathJax.typesetPromise([viewer]).catch(() => { });
            }
            // Scroll left panel to top
            viewer.scrollTop = 0;
        }

        function tdUpdateFilterCounts() {
            const qs = window._tdQuestions || [];
            const total = qs.length;
            const correct = qs.filter(d => d.status === 'correct').length;
            const wrong = qs.filter(d => d.status === 'wrong').length;
            const skipped = qs.filter(d => d.status === 'skipped').length;
            const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
            // Right panel counts
            el('tdrfAllCount', total);
            el('tdrfCorrectCount', correct);
            el('tdrfWrongCount', wrong);
            el('tdrfSkippedCount', skipped);
            // Left panel filter bar counts
            el('tdrfAllCountL', total);
            el('tdrfCorrectCountL', correct);
            el('tdrfWrongCountL', wrong);
            el('tdrfSkippedCountL', skipped);
        }

        // Sync active state on left panel filter buttons
        function syncFilterBtns(filter) {
            ['tdrfAllL', 'tdrfCorrectL', 'tdrfWrongL', 'tdrfSkippedL'].forEach(id => {
                const b = document.getElementById(id);
                if (!b) return;
                b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
            });
            const classMap = { all: 'active-all', correct: 'active-correct', wrong: 'active-wrong', skipped: 'active-skipped' };
            const targetId = { all: 'tdrfAllL', correct: 'tdrfCorrectL', wrong: 'tdrfWrongL', skipped: 'tdrfSkippedL' };
            const btn = document.getElementById(targetId[filter]);
            if (btn) btn.classList.add(classMap[filter] || 'active-all');
        }

        function setTdPaletteFilter(filter, btn) {
            window._tdCurrentFilter = filter;
            // Update right panel button styles
            ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'].forEach(id => {
                const b = document.getElementById(id);
                if (!b) return;
                b.classList.remove('active-all', 'active-correct', 'active-wrong', 'active-skipped');
            });
            const classMap = { all: 'active-all', correct: 'active-correct', wrong: 'active-wrong', skipped: 'active-skipped' };
            // Only add class if btn is one of the right panel buttons
            const rightIds = ['tdrfAll', 'tdrfCorrect', 'tdrfWrong', 'tdrfSkipped'];
            if (btn && rightIds.includes(btn.id)) {
                btn.classList.add(classMap[filter] || 'active-all');
            } else {
                // btn is from left panel — still update right panel
                const rightMap = { all: 'tdrfAll', correct: 'tdrfCorrect', wrong: 'tdrfWrong', skipped: 'tdrfSkipped' };
                const rb = document.getElementById(rightMap[filter]);
                if (rb) rb.classList.add(classMap[filter] || 'active-all');
            }
            // Always sync left panel buttons
            syncFilterBtns(filter);

            // Re-build palette (palette buttons will show/hide based on filter)
            tdBuildPalette();

            // Navigate to first visible question in new filter
            const filtered = tdGetFilteredIndices();
            if (filtered.length > 0) {
                // If current q is in filter keep it, else jump to first
                if (!filtered.includes(window._tdCurrentQIdx)) {
                    window._tdCurrentQIdx = filtered[0];
                    tdShowQuestion(filtered[0]);
                }
                const counter = document.getElementById('tdNavCounter');
                if (counter) {
                    const pos = filtered.indexOf(window._tdCurrentQIdx) + 1;
                    counter.textContent = `Q${window._tdCurrentQIdx + 1} · ${pos}/${filtered.length}`;
                }
            }
        }

        // Keep legacy setTdFilter for any residual callers
        function setTdFilter(filter, btn) { setTdPaletteFilter(filter, btn); }

        function normalizeSolutionForDisplay(text) {
            return String(text || '').replace(/\\n/g, '\n').trim();
        }

        function getMimeType(b64) {
            if (!b64) return 'jpeg';
            if (b64.startsWith('/9j/')) return 'jpeg';
            if (b64.startsWith('iVBORw')) return 'png';
            if (b64.startsWith('R0lGOD')) return 'gif';
            return 'jpeg';
        }

        /* Helper functions for test analysis */
        function formatStudentAnswer(ans) {
            if (ans === null || ans === undefined) return 'Not Attempted';
            if (ans === -1) return 'Not Answered';
            if (Array.isArray(ans)) {
                return ans.length === 0 ? 'Not Answered' : ans.map(i => String.fromCharCode(65 + i)).join(', ');
            }
            if (typeof ans === 'string' && ans.includes(',')) {
                return ans.split(',').map(v => String.fromCharCode(65 + Number(v.trim()))).join(', ');
            }
            if (typeof ans === 'string' && ans.trim() === '') return 'Not Attempted';
            return String.fromCharCode(65 + ans);
        }

        function formatCorrectAnswer(indices) {
            if (!Array.isArray(indices)) return String.fromCharCode(65 + indices);
            return indices.map(i => String.fromCharCode(65 + i)).join(', ');
        }

        function formatTime(sec) {
            if (!sec) return '—';
            const hours = Math.floor(sec / 3600);
            const mins = Math.floor((sec % 3600) / 60);
            const secs = sec % 60;
            if (hours > 0) return `${hours}h ${mins}m`;
            if (mins > 0) return `${mins}m ${secs}s`;
            return `${secs}s`;
        }

        /* ══ EDIT PROFILE ══ */
        function showEditProfile() {
            if (!_student) return;
            document.getElementById('eName').value = _student.name || '';
            // Prefer explicit division property; if missing, try to parse from className like "12 - A"
            let classVal = _student.className || '';
            let divVal = _student.division || '';
            if (!divVal && classVal && classVal.includes('-')) {
                const parts = classVal.split('-').map(s => s.trim());
                if (parts.length > 1) {
                    divVal = parts.pop();
                    classVal = parts.join(' - ');
                }
            }
            document.getElementById('eClass').value = classVal || '';
            document.getElementById('eDivision').value = divVal || '';
            document.getElementById('ePhone').value = _student.phone || '';
            document.getElementById('eAge').value = _student.age || '';
            document.getElementById('eDob').value = _student.dateOfBirth || '';
            document.getElementById('editMsg').className = 'msg'; document.getElementById('editMsg').style.display = 'none';
            showScreen('edit');
            setActiveNav('edit');
        }

        async function updateProfile() {
            const name = document.getElementById('eName').value.trim();
            const btn = document.getElementById('editBtn');
            if (!name) { showMsg('editMsg', 'err', 'Name is required.'); shake('eName'); return; }
            btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
            try {
                const rawClass = document.getElementById('eClass').value.trim();
                const division = (document.getElementById('eDivision')?.value || '').trim().toUpperCase();
                const classWithDiv = rawClass && division ? `${rawClass} - ${division}` : (rawClass || division || '');
                const r = await fetch(`${API_BASE}/api/student/update-profile`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_token}` },
                    body: JSON.stringify({
                        name,
                        className: classWithDiv,
                        division: division,
                        phone: document.getElementById('ePhone').value.trim(),
                        age: document.getElementById('eAge').value.trim(),
                        dateOfBirth: document.getElementById('eDob').value.trim()
                    })
                });
                const data = await r.json();
                if (!r.ok) { showMsg('editMsg', 'err', data.error || 'Failed to update.'); return; }
                _student.name = name;
                _student.className = classWithDiv;
                _student.division = division;
                _student.phone = document.getElementById('ePhone').value.trim();
                _student.age = document.getElementById('eAge').value.trim();
                _student.dateOfBirth = document.getElementById('eDob').value.trim();
                showMsg('editMsg', 'ok', 'Profile updated!');
                setTimeout(() => { showScreen('dashboard'); loadDashboard(); }, 900);
            } catch (e) { showMsg('editMsg', 'err', 'Connection error.'); }
            finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
        }

        /* ══ BACK TO ROLE CHOOSER (student / teacher login selection) ══ */
        // The login screen "← Back" button returns the user to the parent app's
        // role-chooser page (Student / Teacher). When this portal is embedded as
        // an <iframe> inside client.html we signal the parent via postMessage;
        // otherwise we just stay on / reset the login screen.
        function backToRoleChooser() {
            // Clear any half-entered login state.
            _token = ''; _student = null;
            try {
                localStorage.removeItem('gp_student_token');
                localStorage.removeItem('gp_pending_roll');
                localStorage.removeItem('gp_active_role');
            } catch (_) { }
            const ri = document.getElementById('rollInput');
            if (ri) ri.value = '';

            if (window.parent && window.parent !== window) {
                try { window.parent.postMessage({ type: 'gp-student-logout' }, '*'); return; }
                catch (_) { /* fall through */ }
            }
            // Standalone fallback — just show the login screen.
            showScreen('login');
        }

        /* ══ LOGOUT ══ */
        async function doLogout() {
            closeLogoutPopup();
            try { await fetch(`${API_BASE}/api/student/logout`, { method: 'POST', headers: { Authorization: `Bearer ${_token}` } }); } catch (_) { }
            _token = ''; _student = null;
            localStorage.removeItem('gp_student_token');
            localStorage.removeItem('gp_pending_roll');
            document.getElementById('rollInput').value = '';

            // When this portal is embedded inside client.html (an <iframe>),
            // logging out should return the user to the role-chooser page of the
            // parent app — NOT to this portal's own student login screen.
            if (window.parent && window.parent !== window) {
                try { window.parent.postMessage({ type: 'gp-student-logout' }, '*'); return; }
                catch (_) { /* fall through to local logout if messaging fails */ }
            }
            showScreen('login');
        }

        /* ══ UTILS ══ */
        function showMsg(id, type, text) { const el = document.getElementById(id); el.className = `msg ${type}`; el.textContent = text; }
        function shake(id) { const el = document.getElementById(id); if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); }
        function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

        /* ══════════════════════════════════════════════════════════════════
           TABLE / MATRIX RENDERING
           Questions may carry a `tables` array. Each table:
             { position, headers: string[], rows: string[][], caption? }
           Cell text can contain inline $...$ LaTeX — escaped here and typeset
           by MathJax when typesetPromise() runs on the enclosing container.
        ══════════════════════════════════════════════════════════════════ */
        // A table cell may be a plain string OR an image-cell object
        // { text, image, imageNeeded }. _twNormCell keeps image cells intact.
        function _twIsImgCell(c) {
            return c && typeof c === 'object' && !Array.isArray(c) && ('image' in c || c.imageNeeded === true || c.image_needed === true);
        }
        function _twNormCell(c) {
            if (_twIsImgCell(c)) {
                return { text: String(c.text ?? c.caption ?? ''), image: c.image != null ? String(c.image) : null };
            }
            return String(c ?? '');
        }
        function _twCellImgSrc(img) {
            if (!img) return '';
            if (img.startsWith('http') || img.startsWith('data:')) return img;
            const mime = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : img.startsWith('R0lGOD') ? 'image/gif' : 'image/jpeg';
            return `data:${mime};base64,${img}`;
        }
        function _twRenderCell(c) {
            if (c && typeof c === 'object' && !Array.isArray(c)) {
                if (c.image) {
                    const cap = c.text ? `<div style="font-size:0.7rem;opacity:0.7;margin-top:2px">${escHtml(c.text)}</div>` : '';
                    return `<img src="${_twCellImgSrc(String(c.image))}" style="max-width:130px;max-height:100px;object-fit:contain;display:block;margin:0 auto;border-radius:4px">${cap}`;
                }
                return escHtml(String(c.text || ''));
            }
            return escHtml(c ?? '');
        }
        function _normalizeTablesField(tables) {
            if (!tables) return [];
            const arr = Array.isArray(tables) ? tables : [tables];
            const out = [];
            arr.forEach(t => {
                if (!t || typeof t !== 'object') return;
                const headers = Array.isArray(t.headers) ? t.headers.map(h => _twNormCell(h)) : [];
                const rows = Array.isArray(t.rows)
                    ? t.rows.filter(r => Array.isArray(r)).map(r => r.map(c => _twNormCell(c)))
                    : [];
                if (!headers.length && !rows.length) return;
                const obj = {
                    position: (typeof t.position === 'string' && t.position.trim()) ? t.position.trim() : 'after_intro',
                    headers, rows
                };
                if (t.caption && String(t.caption).trim()) obj.caption = String(t.caption).trim();
                out.push(obj);
            });
            return out;
        }

        // Render ONE table object (used for per-option tables).
        function _twRenderSingleTable(t) {
            const list = _normalizeTablesField([t]);
            if (!list.length) return '';
            return renderTablesHtml(list);
        }
        // Per-option tables: read q.optionTables[oi] or tables with position option_x.
        const _TW_OPT_POS = { option_a: 0, option_b: 1, option_c: 2, option_d: 3, option_1: 0, option_2: 1, option_3: 2, option_4: 3 };
        function _twGetOptionTables(q) {
            const out = [null, null, null, null];
            if (q && Array.isArray(q.optionTables)) {
                for (let i = 0; i < 4; i++) if (q.optionTables[i]) out[i] = q.optionTables[i];
            }
            const raw = q && q.tables ? (Array.isArray(q.tables) ? q.tables : [q.tables]) : [];
            raw.forEach(t => {
                if (!t || typeof t !== 'object') return;
                const pos = String(t.position || '').trim().toLowerCase();
                if (Object.prototype.hasOwnProperty.call(_TW_OPT_POS, pos)) {
                    const slot = _TW_OPT_POS[pos];
                    if (!out[slot]) out[slot] = t;
                }
            });
            return out;
        }

        // Returns an HTML string for one or more tables. Call MathJax typeset on
        // the container afterwards so inline math inside cells gets rendered.
        function renderTablesHtml(tables) {
            const list = _normalizeTablesField(tables);
            if (!list.length) return '';
            return list.map(tbl => {
                let colCount = (tbl.headers || []).length;
                (tbl.rows || []).forEach(r => { colCount = Math.max(colCount, r.length); });
                if (!colCount) return '';
                let html = `<div class="q-data-table-wrap"><table class="q-data-table">`;
                if (tbl.headers && tbl.headers.length) {
                    html += `<thead><tr>`;
                    for (let c = 0; c < colCount; c++) {
                        html += `<th>${_twRenderCell(tbl.headers[c] ?? '')}</th>`;
                    }
                    html += `</tr></thead>`;
                }
                html += `<tbody>`;
                (tbl.rows || []).forEach(r => {
                    html += `<tr>`;
                    for (let c = 0; c < colCount; c++) {
                        html += `<td>${_twRenderCell(r[c] ?? '')}</td>`;
                    }
                    html += `</tr>`;
                });
                html += `</tbody></table>`;
                if (tbl.caption) html += `<div class="q-data-table-caption">${escHtml(tbl.caption)}</div>`;
                html += `</div>`;
                return html;
            }).join('');
        }

        /* ══════════════════════════════════════════════════════════════════
           MARKDOWN PIPE-TABLE RENDERING
           AI-extracted questions frequently embed tables/matrices directly in
           the question text, option text or solution text as GitHub-style
           markdown pipe tables, e.g.

               | List I | List II |
               | --- | --- |
               | A | 1 |
               | B | 2 |

           These were previously dumped verbatim via innerHTML and showed up as
           raw "| ... |" text. mdTablesToHtml() finds such blocks anywhere in a
           string and converts them into the same styled .q-data-table markup
           used for structured tables, leaving all surrounding text untouched.
           Inline $...$ LaTeX inside cells is preserved so MathJax can typeset
           it when typesetPromise() runs on the container.
        ══════════════════════════════════════════════════════════════════ */
        function _looksLikeMdTableRow(line) {
            const t = line.trim();
            // Must contain at least one pipe and not be a code fence
            return t.indexOf('|') !== -1 && t.length > 0;
        }
        function _isMdSeparatorRow(line) {
            // e.g. | --- | :---: | --- |  (dashes, optional colons, pipes, spaces)
            const t = line.trim().replace(/^\||\|$/g, '');
            if (t.indexOf('-') === -1) return false;
            return /^[\s|:-]+$/.test(line.trim()) && /-/.test(line);
        }
        function _splitMdRow(line) {
            let t = line.trim();
            // Strip a single leading/trailing pipe (so we don't get empty edge cells)
            if (t.startsWith('|')) t = t.slice(1);
            if (t.endsWith('|')) t = t.slice(0, -1);
            // Split on pipes that are NOT escaped (\|)
            const cells = [];
            let cur = '';
            for (let i = 0; i < t.length; i++) {
                const ch = t[i];
                if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
                if (ch === '|') { cells.push(cur); cur = ''; continue; }
                cur += ch;
            }
            cells.push(cur);
            return cells.map(c => c.trim());
        }
        // Build one HTML table from header cells + body rows (already split).
        function _mdTableToHtml(headerCells, bodyRows) {
            let colCount = headerCells.length;
            bodyRows.forEach(r => { colCount = Math.max(colCount, r.length); });
            if (!colCount) return '';
            let html = `<div class="q-data-table-wrap"><table class="q-data-table">`;
            if (headerCells.length) {
                html += `<thead><tr>`;
                for (let c = 0; c < colCount; c++) html += `<th>${escHtml(headerCells[c] ?? '')}</th>`;
                html += `</tr></thead>`;
            }
            html += `<tbody>`;
            bodyRows.forEach(r => {
                html += `<tr>`;
                for (let c = 0; c < colCount; c++) html += `<td>${escHtml(r[c] ?? '')}</td>`;
                html += `</tr>`;
            });
            html += `</tbody></table></div>`;
            return html;
        }
        // Scan a block of text and replace every markdown table with HTML.
        // Non-table text is returned unchanged (NOT escaped) so existing inline
        // HTML / LaTeX in the surrounding content keeps working as before.
        function mdTablesToHtml(text) {
            if (text == null) return '';
            const src = String(text);
            if (src.indexOf('|') === -1) return src; // fast path: no tables possible
            const lines = src.split(/\r?\n/);
            const out = [];
            let i = 0;
            while (i < lines.length) {
                const line = lines[i];
                const next = lines[i + 1];
                // A markdown table = a header row, then a separator row, then >=1 body rows
                if (next !== undefined && _looksLikeMdTableRow(line) && line.indexOf('|') !== -1 && _isMdSeparatorRow(next)) {
                    const headerCells = _splitMdRow(line);
                    const bodyRows = [];
                    let j = i + 2;
                    while (j < lines.length && lines[j].trim().indexOf('|') !== -1 && lines[j].trim() !== '') {
                        bodyRows.push(_splitMdRow(lines[j]));
                        j++;
                    }
                    out.push(_mdTableToHtml(headerCells, bodyRows));
                    i = j;
                    continue;
                }
                out.push(line);
                i++;
            }
            return out.join('\n');
        }
