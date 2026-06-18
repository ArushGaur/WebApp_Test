/* ══════════════════════════════════════════════════════════════════
           SESSION / AUTH
           NEW FLOW:
             1. Page loads → check institute session.
                • No session  → show LOGIN overlay (Institute ID + passcode).
                • Has session → show ROLE chooser (Teacher / Student).
             2. Successful login → show ROLE chooser.
             3. Teacher  → enterDashboard() (full admin/teacher UI).
                Student → openStudentPortal() — embedded iframe; the iframe
                          inherits the parent's institute via instituteCode.
             4. The role chooser also has a "Sign in as a different institute"
                button that logs out and returns to step 1.
        ══════════════════════════════════════════════════════════════════ */

        // Cache the active institute (set after login or session-restore).
        let __activeInstitute = null;

        (async function checkSession() {
            const loginOverlay = document.getElementById("loginOverlay");
            const roleOverlay = document.getElementById("roleOverlay");

            // Saved role (used to decide which screen to land on after refresh).
            let savedRole = null;
            try { savedRole = localStorage.getItem("gp_active_role"); } catch (_) { }

            try {
                console.log("Checking session at:", `${API_BASE}/api/institute/me`);
                const r = await fetch(`${API_BASE}/api/institute/me`, { credentials: "include", cache: "no-store" });
                console.log("Session check status:", r.status);
                if (r.ok) {
                    const instData = await r.json();
                    if (instData && instData.name) {
                        console.log("Session valid — institute:", instData.name);
                        __activeInstitute = instData;
                        try { localStorage.setItem("gp_institute_code", instData.code || ""); } catch (_) { }

                        // Apply branding so the role chooser shows the right institute.
                        applyInstituteBranding(instData);
                        updateRoleChooserHeader(instData);
                        if (loginOverlay) loginOverlay.style.display = "none";

                        // If the user was inside the dashboard / student portal,
                        // restore that screen. Otherwise show the role chooser.
                        if (savedRole === "teacher") {
                            if (instData.isAdmin) {
                                // Pre-fetch students in parallel
                                try {
                                    const sr = await fetch(`${API_BASE}/api/admin/students`, { credentials: "include", cache: "no-store" });
                                    if (sr.ok) { allStudents = await sr.json(); }
                                } catch (_) { }
                                if (roleOverlay) roleOverlay.style.display = "none";
                                document.getElementById("sidebar").classList.remove("hidden");
                                document.getElementById("mainContent").classList.remove("hidden");
                                renderDashboardData();
                                loadChaptersAdmin();
                                loadQuestionsAdmin();
                                if (typeof refreshTemplates === "function") refreshTemplates().catch(() => {});
                                history.replaceState({ type: "section", name: "dashboard" }, "", "");
                                return;
                            } else {
                                try { localStorage.removeItem("gp_active_role"); } catch (_) { }
                            }
                        }
                        if (savedRole === "student") {
                            // Re-open the student portal directly.
                            if (roleOverlay) roleOverlay.style.display = "none";
                            selectRole("student");
                            return;
                        }
                        // Default: show role chooser.
                        if (roleOverlay) roleOverlay.style.display = "flex";
                        return;
                    }
                }
            } catch (e) {
                console.log("Session check failed:", e.message, "- showing login screen");
            }

            // No active institute session → show LOGIN first (NOT the role chooser).
            try { localStorage.removeItem("gp_active_role"); } catch (_) { }
            __activeInstitute = null;
            if (roleOverlay) roleOverlay.style.display = "none";
            if (loginOverlay) loginOverlay.style.display = "flex";
        })();

        // Teacher Passcode Modal functions
        function toggleTeacherPasscodeVisibility(btn) {
            const input = document.getElementById("teacherPasscode");
            if (input) {
                if (input.type === "password") {
                    input.type = "text";
                    btn.textContent = "🙈";
                } else {
                    input.type = "password";
                    btn.textContent = "👁️";
                }
            }
        }

        function closeTeacherPasscodeModal() {
            const modal = document.getElementById("teacherPasscodeModal");
            if (modal) modal.style.display = "none";
            const input = document.getElementById("teacherPasscode");
            if (input) input.value = "";
            const err = document.getElementById("teacherPasscodeError");
            if (err) err.style.display = "none";
        }

        async function submitTeacherPasscode() {
            const pInput = document.getElementById("teacherPasscode");
            const passcode = pInput ? pInput.value.trim() : "";
            const errEl = document.getElementById("teacherPasscodeError");
            const wrapEl = document.getElementById("teacherPasscodeWrap");

            if (errEl) errEl.style.display = "none";

            if (!passcode) {
                if (errEl) {
                    errEl.textContent = "Please enter a passcode.";
                    errEl.style.display = "block";
                }
                if (wrapEl) {
                    wrapEl.classList.add("login-field-error");
                    setTimeout(() => wrapEl.classList.remove("login-field-error"), 400);
                }
                return;
            }

            try {
                const r = await fetch(`${API_BASE}/api/institute/teacher-login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    cache: "no-store",
                    body: JSON.stringify({ passcode })
                });
                const data = await r.json().catch(() => null);

                if (!r.ok) {
                    if (errEl) {
                        errEl.textContent = data?.error || "Incorrect passcode.";
                        errEl.style.display = "block";
                    }
                    if (wrapEl) {
                        wrapEl.classList.add("login-field-error");
                        setTimeout(() => wrapEl.classList.remove("login-field-error"), 400);
                    }
                    return;
                }

                // Successfully authenticated!
                try { localStorage.setItem("gp_active_role", "teacher"); } catch (_) { }
                if (__activeInstitute) {
                    __activeInstitute.isAdmin = true;
                }
                
                closeTeacherPasscodeModal();

                const roleOverlay = document.getElementById("roleOverlay");
                if (roleOverlay) roleOverlay.style.display = "none";
                document.getElementById("sidebar").classList.remove("hidden");
                document.getElementById("mainContent").classList.remove("hidden");
                enterDashboard();

            } catch (e) {
                if (errEl) {
                    errEl.textContent = "Network error. Please try again.";
                    errEl.style.display = "block";
                }
            }
        }

        // Updates the small institute name/code shown in the role-chooser footer.
        function updateRoleChooserHeader(instData) {
            try {
                const nameEl = document.getElementById("roleFooterInstName");
                const codeEl = document.getElementById("roleFooterInstCode");
                if (nameEl && instData?.name) nameEl.textContent = instData.name;
                if (codeEl) codeEl.textContent = instData?.code ? `ID: ${instData.code}` : "";
                // The sub-line on the role card explains what the user is doing.
                const sub = document.querySelector("#roleOverlay .login-brand-sub");
                if (sub) sub.textContent = instData?.name
                    ? `Signed in to ${instData.name} — choose how you want to continue`
                    : "Choose how you want to continue";
            } catch (_) { /* non-fatal */ }
        }

        // Logs out of the current institute and returns to the LOGIN screen so
        // the user can sign in with a different Institute ID + passcode.
        async function switchInstitute() {
            try {
                await fetch(`${API_BASE}/api/institute/logout`, { method: "POST", credentials: "include", cache: "no-store" });
            } catch (_) { /* ignore network errors — still clear UI state */ }
            try { localStorage.removeItem("gp_active_role"); } catch (_) { }
            try { localStorage.removeItem("gp_institute_code"); } catch (_) { }
            __activeInstitute = null;
            // Hide everything that requires an institute session.
            const roleOverlay = document.getElementById("roleOverlay");
            const loginOverlay = document.getElementById("loginOverlay");
            const studentPortal = document.getElementById("studentPortal");
            const sidebar = document.getElementById("sidebar");
            const main = document.getElementById("mainContent");
            if (roleOverlay) roleOverlay.style.display = "none";
            if (studentPortal) studentPortal.style.display = "none";
            if (sidebar) sidebar.classList.add("hidden");
            if (main) main.classList.add("hidden");
            // Clear & reveal the login form.
            const code = document.getElementById("instituteCode");
            const pc = document.getElementById("passcode");
            if (code) code.value = "";
            if (pc) pc.value = "";
            if (loginOverlay) loginOverlay.style.display = "flex";
            setTimeout(() => { const f = document.getElementById("instituteCode"); if (f) f.focus(); }, 50);
        }

        async function enterDashboard(skipStudents = false) {
            // Hide login, show dashboard (idempotent — safe to call even if already visible)
            const overlay = document.getElementById("loginOverlay");
            if (overlay) overlay.style.display = "none";
            // Also hide the role chooser & student portal (e.g. on session auto-restore)
            const roleOverlay = document.getElementById("roleOverlay");
            if (roleOverlay) roleOverlay.style.display = "none";
            const studentPortal = document.getElementById("studentPortal");
            if (studentPortal) studentPortal.style.display = "none";
            document.getElementById("sidebar").classList.remove("hidden");
            document.getElementById("mainContent").classList.remove("hidden");

            // Fetch institute branding and apply it (async, doesn't block dashboard load)
            fetchAndApplyInstituteBranding();

            // Load all data (skip students fetch if already loaded by checkSession).
            // NOTE: loadDashboard() was removed for the client build, so when we need
            // a fresh student list we fetch it directly here instead of calling it.
            if (!skipStudents) {
                try {
                    const r = await fetch(`${API_BASE}/api/admin/students`, { credentials: "include", cache: "no-store" });
                    if (r.ok) { allStudents = await r.json(); }
                } catch (e) { console.warn("students fetch failed:", e.message); }
            }
            renderDashboardData();
            await loadChaptersAdmin();
            await loadQuestionsAdmin();

            // The initial page-load template fetch can run before the session is
            // authenticated (→ 401 → empty list). Re-fetch now that we're logged in
            // so the autogenerate / paper-generate template choosers are populated.
            if (typeof refreshTemplates === "function") { refreshTemplates().catch(() => {}); }

            history.replaceState({ type: "section", name: "dashboard" }, "", "");
        }


        /* ══════════════════════════════════════════════════════════════════
           INSTITUTE BRANDING
        ══════════════════════════════════════════════════════════════════ */
        async function fetchAndApplyInstituteBranding() {
            try {
                const r = await fetch(`${API_BASE}/api/institute/me`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                const data = await r.json();
                if (!data || !data.name) return;
                applyInstituteBranding(data);
            } catch (e) {
                console.warn("[branding] fetchAndApplyInstituteBranding failed:", e.message);
            }
        }

        function applyInstituteBranding(data) {
            const name = data.name || "Grip Physics";
            const logoUrl = data.logoUrl || data.logo_url || "";
            const permissions = data.permissions || {};

            // Update page title
            document.title = `${name} — Client`;

            // Sidebar logo text
            const sidebarLogoText = document.querySelector(".sidebar-logo-text h3");
            if (sidebarLogoText) sidebarLogoText.textContent = name;

            // Sidebar logo icon — replace SVG with institute logo if available
            const sidebarLogoIcon = document.querySelector(".sidebar-logo-icon");
            if (sidebarLogoIcon && logoUrl) {
                sidebarLogoIcon.innerHTML = `<img src="${logoUrl}" alt="${name} logo"
                    style="width:36px;height:36px;border-radius:8px;object-fit:cover"
                    onerror="this.style.display='none'">`;
            }

            // Role selector (roleOverlay) brand name
            const roleBrandName = document.querySelector("#roleOverlay .login-brand-name");
            if (roleBrandName) roleBrandName.textContent = name;

            // Login overlay brand names (there may be two atoms)
            document.querySelectorAll("#loginOverlay .login-brand-name").forEach(el => { el.textContent = name; });

            // Footer copyright texts
            document.querySelectorAll(".login-footer span").forEach(el => {
                if (el.textContent.includes("Grip Physics") || el.textContent.includes("© 20")) {
                    el.textContent = `${name} © ${new Date().getFullYear()}`;
                }
            });

            // Swap atom icon with logo on login screens if logo present
            if (logoUrl) {
                document.querySelectorAll(".login-atom-icon").forEach(el => {
                    el.innerHTML = `<img src="${logoUrl}" alt="${name}"
                        style="width:54px;height:54px;border-radius:12px;object-fit:cover"
                        onerror="this.style.display='none'">`;
                });
            }

            // Apply permission-based hiding
            if (permissions.questionBank === false) {
                document.querySelectorAll("#nav-manageQuestions, #section-manageQuestions, #drawer-manageQuestions").forEach(el => {
                    if (el) el.style.display = "none";
                });
            }
            if (permissions.onlineTests === false) {
                // Hide online tests UI if present
                document.querySelectorAll('[data-perm="onlineTests"]').forEach(el => { if (el) el.style.display = "none"; });
            }
            if (permissions.starQuiz === false) {
                document.querySelectorAll("#nav-starQuiz, #section-starQuiz, #drawer-starQuiz").forEach(el => {
                    if (el) el.style.display = "none";
                });
            }

            console.log("[branding] Applied institute branding:", name);
        }

        function renderDashboardData() {
            // The dashboard section is disabled/commented-out on the client build.
            // Guard every DOM access so a missing element never throws and aborts
            // the subsequent loadChaptersAdmin() / loadQuestionsAdmin() calls.
            try {
                const wa = allStudents.filter(s => (s.answers && s.answers.length > 0) || typeof s.correctCount === "number");
                const tc = wa.reduce((sum, x) => sum + (x.correctCount || 0), 0);
                const tw = wa.reduce((sum, x) => sum + ((x.totalQuestions || 0) - (x.correctCount || 0)), 0);
                const lecs = new Set(allStudents.map(s => `${s.chapter}::${s.lecture}`));

                const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
                setText("stat-total", allStudents.length);
                setText("stat-correct", tc);
                setText("stat-wrong", tw);
                setText("stat-lectures", lecs.size);

                const totalQ = tc + tw;
                const accuracy = totalQ > 0 ? Math.round((tc / totalQ) * 100) : 0;
                const accEl = document.getElementById("accuracyPercent");
                const accBar = document.getElementById("accuracyBar");
                if (accEl) accEl.textContent = accuracy + '%';
                if (accBar) accBar.style.width = accuracy + '%';
                setText("sidebar-correct", tc);
                setText("sidebar-wrong", tw);

                if (typeof renderRecentActivity === "function") renderRecentActivity(wa.slice(-5).reverse());
                if (typeof renderChapterBreakdown === "function") renderChapterBreakdown();
                _chartData = wa;
                if (typeof buildChart === "function" && document.getElementById("performanceChart")) buildChart(wa);

                console.log("Dashboard data rendered successfully!");
            } catch (err) {
                console.warn("renderDashboardData skipped (dashboard UI disabled):", err.message);
            }
        }


        /* ══════════════════════════════════════════════════════════════════
           ROLE SELECTION  (Teacher vs Student)
           Called AFTER the institute is already authenticated. The institute
           session lives in the parent cookie; we pass the institute code to
           the student iframe via a query param so it knows which institute it
           belongs to.
        ══════════════════════════════════════════════════════════════════ */
        function selectRole(role) {
            const roleOverlay = document.getElementById("roleOverlay");
            if (role === "teacher") {
                if (__activeInstitute && __activeInstitute.isAdmin) {
                    try { localStorage.setItem("gp_active_role", "teacher"); } catch (_) { }
                    if (roleOverlay) roleOverlay.style.display = "none";
                    document.getElementById("sidebar").classList.remove("hidden");
                    document.getElementById("mainContent").classList.remove("hidden");
                    enterDashboard();
                } else {
                    const modal = document.getElementById("teacherPasscodeModal");
                    if (modal) modal.style.display = "flex";
                    setTimeout(() => {
                        const input = document.getElementById("teacherPasscode");
                        if (input) input.focus();
                    }, 50);
                }
            } else if (role === "student") {
                // Persist the choice so a page refresh keeps us in the student
                // portal instead of re-prompting teacher/student.
                try { localStorage.setItem("gp_active_role", "student"); } catch (_) { }
                if (roleOverlay) roleOverlay.style.display = "none";
                const portal = document.getElementById("studentPortal");
                const frame = document.getElementById("studentFrame");
                // Pass the active institute code to the embedded student portal
                // so all /api/student/* calls it makes are institute-scoped.
                // Order of preference:
                //   1. __activeInstitute.code (just set by checkSession/login)
                //   2. localStorage fallback
                //   3. the value typed in the login form (oUUID-less refresh)
                let instCode = "";
                try { instCode = __activeInstitute?.code || localStorage.getItem("gp_institute_code") || ""; } catch (_) { }
                if (!instCode) {
                    const el = document.getElementById("instituteCode");
                    if (el && el.value) instCode = String(el.value).trim().toUpperCase();
                }
                const target = instCode
                    ? `test_window.html?institute=${encodeURIComponent(instCode)}`
                    : "test_window.html";
                if (frame && (!frame.src || frame.src === "about:blank" || frame.dataset.loaded !== "1" || frame.dataset.inst !== instCode)) {
                    frame.src = target;
                    frame.dataset.loaded = "1";
                    frame.dataset.inst = instCode;
                }
                if (portal) portal.style.display = "block";
            }
        }


        /* ══════════════════════════════════════════════════════════════════
           STUDENT PORTAL ↔ PARENT messaging
           The embedded test_window.html posts a message when the student logs
           out. We then tear down the portal and return to the role chooser
           (NOT the student login screen).
        ══════════════════════════════════════════════════════════════════ */
        function exitStudentPortal() {
            // Forget the student role so refresh shows the chooser again.
            // NOTE: we deliberately do NOT clear gp_institute_code — the user
            // is still signed into the institute; they just left the student
            // portal and should land back on the role chooser.
            try { localStorage.removeItem("gp_active_role"); } catch (_) { }
            const portal = document.getElementById("studentPortal");
            const frame = document.getElementById("studentFrame");
            if (portal) portal.style.display = "none";
            // Reset the iframe so a fresh login starts next time the student
            // role is chosen (prevents stale state / lingering session).
            if (frame) {
                frame.src = "about:blank";
                frame.dataset.loaded = "0";
                frame.dataset.inst = "";
            }
            const overlay = document.getElementById("loginOverlay");
            if (overlay) overlay.style.display = "none";
            const roleOverlay = document.getElementById("roleOverlay");
            if (roleOverlay) roleOverlay.style.display = "flex";
        }

        window.addEventListener("message", function (ev) {
            // Only act on our own portal's logout signal.
            const d = ev && ev.data;
            if (d && d.type === "gp-student-logout") {
                exitStudentPortal();
            }
        });

        function backToRole() {
            // Hide both login & student portal, show the role chooser again.
            const overlay = document.getElementById("loginOverlay");
            if (overlay) overlay.style.display = "none";
            const portal = document.getElementById("studentPortal");
            if (portal) portal.style.display = "none";
            const roleOverlay = document.getElementById("roleOverlay");
            if (roleOverlay) roleOverlay.style.display = "flex";
        }

        function togglePasscodeVisibility(btn) {
            const input = document.getElementById("passcode");
            const showIcon = btn.querySelector('.eye-show');
            const hideIcon = btn.querySelector('.eye-hide');
            if (input.type === 'password') {
                input.type = 'text';
                showIcon.style.display = 'none';
                hideIcon.style.display = '';
            } else {
                input.type = 'password';
                showIcon.style.display = '';
                hideIcon.style.display = 'none';
            }
        }

        async function login() {
            const p = document.getElementById("passcode").value.trim();
            const code = (document.getElementById("instituteCode")?.value || "DEFAULT").trim().toUpperCase() || "DEFAULT";
            const e = document.getElementById("loginError");
            const btn = document.getElementById("loginSubmitBtn");
            const fieldWrap = document.getElementById("loginFieldWrap");
            const instWrap = document.getElementById("loginInstFieldWrap");
            e.style.display = "none";
            if (!code) {
                e.textContent = "Please enter your Institute ID.";
                e.style.display = "block";
                instWrap?.classList.add("login-field-error");
                setTimeout(() => instWrap?.classList.remove("login-field-error"), 400);
                return;
            }
            if (!p) {
                e.textContent = "Please enter a passcode.";
                e.style.display = "block";
                fieldWrap.classList.add("login-field-error");
                setTimeout(() => fieldWrap.classList.remove("login-field-error"), 400);
                return;
            }

            // Show spinner immediately
            if (btn) {
                btn.querySelector('.login-btn-text').style.display = 'none';
                btn.querySelector('.login-btn-spinner').style.display = '';
                btn.disabled = true;
            }

            try {
                // Use the institute login endpoint (code + passcode)
                const url = `${API_BASE}/api/institute/login`;
                const r = await fetch(url, {
                    method: "POST",
                    credentials: "include",
                    cache: "no-store",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ code, passcode: p })
                });
                const data = await r.json().catch(() => null);

                if (!r.ok) {
                    if (btn) {
                        btn.querySelector('.login-btn-text').style.display = '';
                        btn.querySelector('.login-btn-spinner').style.display = 'none';
                        btn.disabled = false;
                    }
                    e.textContent = data?.error || `Login failed (${r.status}).`;
                    e.style.display = "block";
                    fieldWrap.classList.add("login-field-error");
                    setTimeout(() => fieldWrap.classList.remove("login-field-error"), 400);
                    return;
                }

                // ✅ Auth OK — DON'T choose a role yet. Show the role chooser
                // so the user can pick Teacher or Student. The chooser already
                // displays the active institute's branding.
                try { localStorage.removeItem("gp_active_role"); } catch (_) { }
                try { localStorage.setItem("gp_institute_code", code); } catch (_) { }
                document.getElementById("passcode").value = "";
                document.getElementById("loginOverlay").style.display = "none";

                // Restore the submit button to its idle state so a re-show is clean.
                if (btn) {
                    btn.querySelector('.login-btn-text').style.display = '';
                    btn.querySelector('.login-btn-spinner').style.display = 'none';
                    btn.disabled = false;
                }

                // Pull the institute branding (name + logo) so the role chooser
                // can confirm to the user which institute they signed into.
                try {
                    const meR = await fetch(`${API_BASE}/api/institute/me`, { credentials: "include", cache: "no-store" });
                    if (meR.ok) {
                        const instData = await meR.json();
                        __activeInstitute = instData;
                        applyInstituteBranding(instData);
                        updateRoleChooserHeader(instData);
                    } else {
                        __activeInstitute = { code };
                        updateRoleChooserHeader({ code, name: "" });
                    }
                } catch (_) {
                    __activeInstitute = { code };
                    updateRoleChooserHeader({ code, name: "" });
                }

                // Show the role chooser.
                const roleOverlay = document.getElementById("roleOverlay");
                if (roleOverlay) roleOverlay.style.display = "flex";
                return;

            } catch (err) {
                console.error("Login error:", err);
                if (btn) {
                    btn.querySelector('.login-btn-text').style.display = '';
                    btn.querySelector('.login-btn-spinner').style.display = 'none';
                    btn.disabled = false;
                }
                e.textContent = "Connection error. Is the server running?";
                e.style.display = "block";
            }
        }

        function confirmLogout() { closeMobileDrawer(); openModal('logoutModal'); }

        async function doLogout() {
            closeModal('logoutModal');
            await fetch(`${API_BASE}/api/institute/logout`, { method: "POST", credentials: "include", cache: "no-store" });
            document.getElementById("passcode").value = "";
            // Forget the active role so the reload lands on the role chooser.
            try { localStorage.removeItem("gp_active_role"); } catch (_) { }
            try { localStorage.removeItem("gp_institute_code"); } catch (_) { }
            location.reload();
        }


        /* ══════════════════════════════════════════════════════════════════
           NAVIGATION
        ══════════════════════════════════════════════════════════════════ */
        function navAttendance() {
            document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            const sec = document.getElementById("section-attendance");
            const nav = document.getElementById("nav-attendance");
            if (sec) sec.classList.add("active");
            if (nav) nav.classList.add("active");
            const dateInput = document.getElementById("att-date");
            if (dateInput && !dateInput.value) dateInput.value = getTodayStr();
            loadAttendanceClasses();
            history.pushState({ type: "section", name: "attendance" }, "", "");
        }

        function showSection(name, push = true) {
            document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            const sec = document.getElementById(`section-${name}`);
            const nav = document.getElementById(`nav-${name}`);
            if (sec) sec.classList.add("active");
            if (nav) nav.classList.add("active");
            if (name === "attendance") {
                const dateInput = document.getElementById("att-date");
                if (dateInput && !dateInput.value) dateInput.value = getTodayStr();
                loadAttendanceClasses();
            }
            if (name === "students") {
                loadRegisteredStudents();
                // Refresh request badge count
                fetch(`${API_BASE}/api/admin/student-requests`, { credentials: 'include', cache: 'no-store' })
                    .then(r => r.json()).then(data => updateRequestsBadge(data.length)).catch(() => { });
            }
            if (name === "applications") {
                populateStudentChapterFilter();
                filterStudents('');
                setStudentView(studentViewMode);
            }
            if (name === "manageQuestions") { showSubjectView(); renderSubjectCards(allQuestions); }
            if (name === "starQuiz" && push) { sqShowChapterView(false); loadStarQuizData().then(() => { if (document.getElementById("sq-chapter-view").style.display !== "none") sqRenderChapters(_sqAllQuestions); }); }
            else if (name === "starQuiz" && !push) { loadStarQuizData().then(() => sqRenderChapters(_sqAllQuestions)); }
            if (push) history.pushState({ type: "section", name }, "", "");
        }

        function showChapterViewH() { showChapterView(); history.pushState({ type: "mqChapter" }, "", ""); }
        function showLectureViewH(ch) { showLectureViewForChapter(ch); history.pushState({ type: "mqLecture", chapter: ch }, "", ""); }
        function showQuestionViewH(idx, sqIdx) { showQuestionView(idx, sqIdx); history.pushState({ type: "mqQuestion", idx, sqIdx }, "", ""); }

        window.addEventListener("popstate", e => {
            const s = e.state;
            if (!s) return;
            if (s.type === "section") { showSection(s.name, false); return; }
            if (s.type === "mqChapter") { showChapterView(); return; }
            if (s.type === "mqPaper") { if (s.paper) showPaperQuestions(s.paper, false); else showChapterView(); return; }
            if (s.type === "mqLecture") { if (s.chapter) showLectureViewForChapter(s.chapter); else showChapterView(); return; }
            if (s.type === "mqQuestion") { if (typeof s.idx === "number") showQuestionView(s.idx, s.sqIdx); else showLectureView(); return; }
            // Star Quiz sub-navigation
            if (s.type === "sqChapter") { sqShowChapterView(false); return; }
            if (s.type === "sqLecture") { if (s.chapter) { _sqCurrentChapter = s.chapter; sqShowLectureView(false); } else { sqShowChapterView(false); } return; }
            if (s.type === "sqQuestionCards") { if (s.chapter && s.lecture) { sqShowQuestionCards(s.chapter, s.lecture, false); } else { sqShowLectureView(false); } return; }
        });


        /* ══════════════════════════════════════════════════════════════════
           DASHBOARD
        ══════════════════════════════════════════════════════════════════ */
        async function loadDashboard() {
            console.log("=== LOAD DASHBOARD ===");
            try {
                const url = `${API_BASE}/api/admin/students`;
                console.log("Fetching:", url);
                const r = await fetch(url, { credentials: "include" });
                console.log("Dashboard API status:", r.status);
                if (r.status === 403) {
                    console.log("Not authorized - session issue - trying renderDashboardData");
                    return;
                }
                if (!r.ok) { console.log("API error:", r.status); return; }
                const data = await r.json();
                console.log("Raw API response:", data);
                allStudents = data;
                console.log("Students loaded:", allStudents.length);
                renderDashboardData();
            } catch (e) { console.error("Dashboard error:", e); }
        }

        async function refreshDashboard() {
            const btn = document.getElementById('dashRefreshBtn');
            const icon = document.getElementById('refreshIcon');
            btn.disabled = true;
            btn.style.opacity = '0.7';
            icon.style.animation = 'spin 0.6s linear infinite';
            try {
                await Promise.all([loadDashboard(), loadChaptersAdmin(), loadQuestionsAdmin()]);
            } finally {
                icon.style.animation = '';
                btn.disabled = false;
                btn.style.opacity = '1';
                // Brief success flash
                btn.style.borderColor = 'var(--success)';
                btn.style.color = 'var(--success)';
                setTimeout(() => { btn.style.borderColor = ''; btn.style.color = ''; }, 1200);
            }
        }

        function renderRecentActivity(activities) {
            const container = document.getElementById("recentActivityList");
            if (!container) return;
            if (!activities.length) {
                container.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-muted)">No recent activity</div>';
                return;
            }
            container.innerHTML = activities.map(s => {
                const pct = s.totalQuestions ? Math.round((s.correctCount / s.totalQuestions) * 100) : 0;
                const initials = getInitials(s.name);
                const scoreClass = pct >= 70 ? 'high' : pct >= 40 ? 'med' : 'low';
                const cheatTag = s.cheatFlag ? `<span style="margin-left:5px;padding:1px 7px;border-radius:50px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.5);color:#f87171;font-size:0.68rem;font-weight:700">⚠️ CHEATING</span>` : "";
                return `<div class="recent-item" style="${s.cheatFlag ? 'border-left:3px solid #f87171;padding-left:10px' : ''}">
                    <div class="recent-avatar" style="${s.cheatFlag ? 'background:rgba(239,68,68,0.3)' : ''}">${initials}</div>
                    <div class="recent-info">
                        <div class="recent-name">${s.name || 'Unknown'}${cheatTag}</div>
                        <div class="recent-meta">${s.chapter || 'Unknown'} • Lecture ${s.lecture || '?'}</div>
                    </div>
                    <div class="recent-score ${scoreClass}">${pct}%</div>
                </div>`;
            }).join('');
        }

        function renderChapterBreakdown() {
            const container = document.getElementById("chapterBreakdownList");
            if (!container) return;
            const chapters = {};
            allStudents.forEach(s => {
                if (!chapters[s.chapter]) chapters[s.chapter] = { count: 0, students: new Set() };
                chapters[s.chapter].count++;
                chapters[s.chapter].students.add(s.mobile);
            });
            const sorted = Object.entries(chapters).sort((a, b) => b[1].count - a[1].count);
            const icons = ["⚡", "🔥", "🌊", "🔭", "⚗️", "🧲", "🔬", "🌡️", "🌍", "💡", "🪐"];
            container.innerHTML = sorted.slice(0, 6).map(([name, data], i) => `
                <div class="chapter-item">
                    <span class="chapter-item-icon">${icons[i % icons.length]}</span>
                    <span class="chapter-item-name">${name}</span>
                    <span class="chapter-item-count">${data.students.size}</span>
                    </div>
                </div>
            `).join('') || '<div style="text-align:center;padding:20px;color:var(--text-muted)">No chapters yet</div>';
        }

        function buildChart(data) {
            const m = {};
            data.forEach(s => {
                const k = `${s.chapter || "?"}/L${s.lecture}`;
                if (!m[k]) m[k] = { c: 0, w: 0 };
                m[k].c += s.correctCount || 0;
                m[k].w += ((s.totalQuestions || 0) - (s.correctCount || 0));
            });
            const labels = Object.keys(m).sort(), cs = labels.map(k => m[k].c), ws = labels.map(k => m[k].w);
            const ctx = document.getElementById("lectureChart");
            if (window._chart) window._chart.destroy();
            const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
            const tc = isDark ? "#e4e8ff" : "#374151";
            const gc = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.07)";
            window._chart = new Chart(ctx, {
                type: "bar",
                data: { labels, datasets: [{ label: "Correct", data: cs, backgroundColor: "rgba(6,214,160,0.72)", borderRadius: 5 }, { label: "Wrong", data: ws, backgroundColor: "rgba(242,92,92,0.72)", borderRadius: 5 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: tc, font: { family: "Outfit" } } } }, scales: { x: { ticks: { color: tc, font: { family: "Outfit", size: 10 } }, grid: { color: gc } }, y: { beginAtZero: true, ticks: { color: tc, font: { family: "Outfit" } }, grid: { color: gc } } } }
            });
        }

        function populateDrillChapters() {
            const chs = [...new Set(allStudents.map(s => s.chapter).filter(Boolean))].sort();
            const sel = document.getElementById("drillChapter");
            if (sel) sel.innerHTML = '<option value="">— All —</option>' + chs.map(c => `<option value="${c}">${c}</option>`).join("");
        }

        function loadDrillLectures() {
            const ch = document.getElementById("drillChapter")?.value || '';
            const lecs = [...new Set(allStudents.filter(s => !ch || s.chapter === ch).map(s => s.lecture).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
            const sel = document.getElementById("drillLecture");
            if (sel) sel.innerHTML = '<option value="">— Select —</option>' + lecs.map(l => `<option value="${l}">Lecture ${l}</option>`).join("");
            const results = document.getElementById("drillResults");
            if (results) results.style.display = "none";
        }

        function loadDrillData() {
            const ch = document.getElementById("drillChapter")?.value || '';
            const lec = document.getElementById("drillLecture")?.value || '';
            const results = document.getElementById("drillResults");
            if (!results) return;
            if (!lec) { results.style.display = "none"; return; }
            const f = allStudents.filter(s => ((s.answers && s.answers.length > 0) || typeof s.correctCount === "number") && s.lecture === lec && (!ch || s.chapter === ch));
            const tc = f.reduce((sum, x) => sum + (x.correctCount || 0), 0);
            const tw = f.reduce((sum, x) => sum + ((x.totalQuestions || 0) - (x.correctCount || 0)), 0);
            document.getElementById("drillStats").innerHTML = `<div class="stat-card"><div class="stat-icon">👥</div><div class="stat-num">${f.length}</div><div class="stat-label">Attempted</div></div><div class="stat-card"><div class="stat-icon">✅</div><div class="stat-num">${tc}</div><div class="stat-label">Correct</div></div><div class="stat-card"><div class="stat-icon">❌</div><div class="stat-num">${tw}</div><div class="stat-label">Wrong</div></div>`;
            const tbody = document.querySelector("#drillTable tbody");
            if (tbody) {
                tbody.innerHTML = "";
                f.forEach(student => {
                    const pct = student.totalQuestions ? Math.round((student.correctCount / student.totalQuestions) * 100) : 0;
                    const cheatBadge = student.cheatFlag ? `<span style="display:inline-block;margin-left:6px;padding:2px 8px;border-radius:50px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.5);color:#f87171;font-size:0.7rem;font-weight:700;letter-spacing:0.03em">⚠️ CHEATING</span>` : "";
                    tbody.insertAdjacentHTML("beforeend", `<tr style="${student.cheatFlag ? 'background:rgba(239,68,68,0.07)' : ''}"><td>${student.name || "—"}${cheatBadge}</td><td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">${student.mobile}</td><td>${student.correctCount || 0}</td><td>${student.totalQuestions || 0}</td><td><span class="badge-pill ${pct >= 50 ? "ok" : "wrong"}">${pct}%</span></td></tr>`);
                });
            }
            results.style.display = "block";
        }

        /* ══════════════════════════════════════════════════════════════════
           ATTENDANCE
        ══════════════════════════════════════════════════════════════════ */
        let _attClasses = [];
        let _attBatches = [];
        let _attStudents = [];

        function getTodayStr() {
            const d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }

        async function loadAttendanceClasses() {
            try {
                const r = await fetch(`${API_BASE}/api/admin/classes`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                _attClasses = await r.json();
                const sel = document.getElementById("att-class-select");
                if (!sel) return;
                sel.innerHTML = '<option value="">— Select Class —</option>' + _attClasses.map(c =>
                    `<option value="${c.id}">${c.name}</option>`
                ).join("");
            } catch (_) {}
        }

        async function onAttClassChange() {
            const classId = document.getElementById("att-class-select")?.value;
            const batchSel = document.getElementById("att-batch-select");
            if (!batchSel) return;
            batchSel.innerHTML = '<option value="">— All Batches —</option>';
            if (!classId) return;
            try {
                const r = await fetch(`${API_BASE}/api/admin/classes/${classId}/batches`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                _attBatches = await r.json();
                batchSel.innerHTML = '<option value="">— All Batches —</option>' + _attBatches.map(b =>
                    `<option value="${b.id}">${b.name}</option>`
                ).join("");
            } catch (_) {}
        }

        function onAttBatchChange() {}

        async function loadAttendanceStudents() {
            const classId = document.getElementById("att-class-select")?.value;
            if (!classId) { showErrorModal("Please select a class first."); return; }
            const batchId = document.getElementById("att-batch-select")?.value || "";
            const dateInput = document.getElementById("att-date");
            if (!dateInput.value) {
                dateInput.value = getTodayStr();
            }
            const date = dateInput.value;

            document.getElementById("att-loading").style.display = "block";
            document.getElementById("att-student-section").style.display = "none";

            try {
                const params = new URLSearchParams({ class_id: classId });
                if (batchId) params.set("batch_id", batchId);
                const r = await fetch(`${API_BASE}/api/admin/attendance/students?${params}`, { credentials: "include", cache: "no-store" });
                if (!r.ok) throw new Error("Failed to load students");
                _attStudents = await r.json();

                // Also load today's attendance records to show existing status
                let records = {};
                try {
                    const rr = await fetch(`${API_BASE}/api/admin/attendance/records?class_id=${classId}${batchId ? '&batch_id=' + batchId : ''}&date=${date}`, { credentials: "include", cache: "no-store" });
                    if (rr.ok) {
                        const recs = await rr.json();
                        recs.forEach(rec => { records[rec.roll_number] = rec.status; });
                    }
                } catch (_) {}

                renderAttendanceStudents(records);
            } catch (e) {
                showErrorModal(e.message || "Failed to load students");
            } finally {
                document.getElementById("att-loading").style.display = "none";
            }
        }

        function renderAttendanceStudents(existingRecords) {
            const tbody = document.getElementById("att-student-tbody");
            const section = document.getElementById("att-student-section");
            const empty = document.getElementById("att-empty");
            if (!tbody) return;

            if (!_attStudents.length) {
                section.style.display = "none";
                empty.style.display = "block";
                return;
            }

            empty.style.display = "none";
            section.style.display = "block";

            tbody.innerHTML = _attStudents.map(s => {
                const existingStatus = existingRecords[s.roll_number] || "";
                const statusBadge = existingStatus
                    ? `<span class="badge-pill ${existingStatus === 'present' ? 'ok' : existingStatus === 'late' ? 'warn' : 'wrong'}">${existingStatus.charAt(0).toUpperCase() + existingStatus.slice(1)}</span>`
                    : '<span style="color:var(--text-muted);font-size:0.78rem">Not marked</span>';
                return `<tr>
                    <td><input type="checkbox" class="att-student-cb" data-roll="${s.roll_number}" ${existingStatus ? 'checked' : ''}></td>
                    <td style="font-family:'JetBrains Mono',monospace;font-size:0.8rem">${s.roll_number}</td>
                    <td>${s.name || '—'}</td>
                    <td>${statusBadge}</td>
                </tr>`;
            }).join("");

            document.getElementById("att-stat-total").textContent = _attStudents.length;
            updateAttCounts();
            loadAttendanceHistory();
        }

        function updateAttCounts() {
            const cbs = document.querySelectorAll(".att-student-cb:checked");
            document.getElementById("att-stat-selected").textContent = cbs.length;
            const presentCount = _attStudents.filter(s => {
                const cb = document.querySelector(`.att-student-cb[data-roll="${s.roll_number}"]`);
                return cb && cb.checked;
            }).length;
            document.getElementById("att-stat-present").textContent = presentCount;
        }

        function attToggleSelectAll() {
            const allCb = document.getElementById("att-select-all");
            document.querySelectorAll(".att-student-cb").forEach(cb => cb.checked = allCb.checked);
            updateAttCounts();
        }

        async function markAttendance() {
            const classId = document.getElementById("att-class-select")?.value;
            const batchId = document.getElementById("att-batch-select")?.value || "";
            const date = document.getElementById("att-date")?.value || getTodayStr();
            const status = document.getElementById("att-mark-status")?.value || "present";

            const selected = [];
            document.querySelectorAll(".att-student-cb:checked").forEach(cb => selected.push(cb.dataset.roll));

            if (!selected.length) { showErrorModal("Please select at least one student."); return; }

            try {
                const r = await fetch(`${API_BASE}/api/admin/attendance/mark`, {
                    method: "POST",
                    credentials: "include",
                    cache: "no-store",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        class_id: Number(classId),
                        batch_id: batchId ? Number(batchId) : null,
                        date,
                        roll_numbers: selected,
                        status,
                    }),
                });
                const data = await r.json();
                if (!r.ok) throw new Error(data.error || "Failed");
                // Reload to show updated status
                await loadAttendanceStudents();
            } catch (e) {
                showErrorModal(e.message || "Failed to mark attendance");
            }
        }

        async function loadAttendanceHistory() {
            const classId = document.getElementById("att-class-select")?.value;
            const batchId = document.getElementById("att-batch-select")?.value || "";
            const date = document.getElementById("att-date")?.value || getTodayStr();
            const section = document.getElementById("att-history-section");
            if (!section) return;

            try {
                const params = new URLSearchParams({ class_id: classId, date });
                if (batchId) params.set("batch_id", batchId);
                const r = await fetch(`${API_BASE}/api/admin/attendance/records?${params}`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                const records = await r.json();
                if (!records.length) { section.style.display = "none"; return; }

                section.style.display = "block";
                const list = document.getElementById("att-history-list");
                const present = records.filter(r => r.status === "present").length;
                const absent = records.filter(r => r.status === "absent").length;
                const late = records.filter(r => r.status === "late").length;
                const leave = records.filter(r => r.status === "leave").length;

                list.innerHTML = `
                    <div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap">
                        <span style="font-size:0.82rem">✅ Present: <strong>${present}</strong></span>
                        <span style="font-size:0.82rem">❌ Absent: <strong>${absent}</strong></span>
                        <span style="font-size:0.82rem">⏰ Late: <strong>${late}</strong></span>
                        <span style="font-size:0.82rem">📋 Leave: <strong>${leave}</strong></span>
                        <span style="font-size:0.82rem">👥 Total: <strong>${records.length}</strong></span>
                    </div>
                    <div style="max-height:200px;overflow-y:auto;font-size:0.82rem">
                        ${records.map(r => `
                            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border)">
                                <span>${r.roll_number} — ${r.student_name || ''}</span>
                                <span class="badge-pill ${r.status === 'present' ? 'ok' : r.status === 'late' ? 'warn' : 'wrong'}">${r.status}</span>
                            </div>
                        `).join("")}
                    </div>
                `;
            } catch (_) { section.style.display = "none"; }
        }

        // ── Manage Classes Modal ───────────────────────────────────────
        async function openManageClassesModal() {
            openModal("manageClassesModal");
            await renderManageClasses();
        }

        async function renderManageClasses() {
            const container = document.getElementById("mc-class-list");
            if (!container) return;
            try {
                const r = await fetch(`${API_BASE}/api/admin/classes`, { credentials: "include", cache: "no-store" });
                if (!r.ok) return;
                const classes = await r.json();
                if (!classes.length) {
                    container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:0.84rem">No classes yet. Add one below.</div>';
                    return;
                }
                let html = "";
                for (const cls of classes) {
                    let batches = [];
                    try {
                        const br = await fetch(`${API_BASE}/api/admin/classes/${cls.id}/batches`, { credentials: "include", cache: "no-store" });
                        if (br.ok) batches = await br.json();
                    } catch (_) {}
                    html += `<div class="mc-class-item">
                        <div class="mc-class-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
                            <strong style="font-size:0.88rem">${cls.name}</strong>
                            <div style="display:flex;gap:6px">
                                <button class="btn btn-ghost" onclick="openAddBatchModal(${cls.id}, '${cls.name}')" style="padding:5px 10px;font-size:0.78rem">➕ Batch</button>
                                <button class="btn btn-danger" onclick="deleteClass(${cls.id})" style="padding:5px 10px;font-size:0.78rem">🗑</button>
                            </div>
                        </div>
                        <div style="padding:4px 0 4px 12px;font-size:0.8rem">
                            ${batches.length ? batches.map(b =>
                                `<span style="display:inline-flex;align-items:center;gap:4px;margin:3px 4px;padding:3px 10px;background:var(--bg-input);border-radius:20px;font-size:0.76rem">
                                    ${b.name}
                                    <span onclick="deleteBatch(${b.id})" style="cursor:pointer;opacity:0.6;margin-left:2px">✕</span>
                                </span>`
                            ).join("") : '<span style="color:var(--text-muted)">No batches</span>'}
                        </div>
                    </div>`;
                }
                container.innerHTML = html;
            } catch (_) { container.innerHTML = '<div style="color:var(--error)">Failed to load classes</div>'; }
        }

        async function addNewClass() {
            const input = document.getElementById("mc-new-class-name");
            const name = input?.value.trim();
            if (!name) return;
            try {
                const r = await fetch(`${API_BASE}/api/admin/classes`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name }),
                });
                const data = await r.json();
                if (!r.ok) throw new Error(data.error || "Failed");
                input.value = "";
                await renderManageClasses();
                await loadAttendanceClasses();
            } catch (e) { showErrorModal(e.message); }
        }

        async function deleteClass(id) {
            if (!confirm("Delete this class and all its batches?")) return;
            try {
                await fetch(`${API_BASE}/api/admin/classes/${id}`, { method: "DELETE", credentials: "include" });
                await renderManageClasses();
                await loadAttendanceClasses();
            } catch (_) {}
        }

        let _addBatchClassId = null;

        function openAddBatchModal(classId, className) {
            _addBatchClassId = classId;
            document.getElementById("addBatchModalTitle").textContent = `➕ Add Batch to ${className}`;
            document.getElementById("ab-new-batch-name").value = "";
            openModal("addBatchModal");
        }

        async function addNewBatch() {
            const name = document.getElementById("ab-new-batch-name")?.value.trim();
            if (!name || !_addBatchClassId) return;
            try {
                const r = await fetch(`${API_BASE}/api/admin/classes/${_addBatchClassId}/batches`, {
                    method: "POST",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name }),
                });
                const data = await r.json();
                if (!r.ok) throw new Error(data.error || "Failed");
                closeModal("addBatchModal");
                await renderManageClasses();
            } catch (e) { showErrorModal(e.message); }
        }

        async function deleteBatch(id) {
            if (!confirm("Delete this batch?")) return;
            try {
                await fetch(`${API_BASE}/api/admin/batches/${id}`, { method: "DELETE", credentials: "include" });
                await renderManageClasses();
            } catch (_) {}
        }

        // Attendance section is handled inside showSection() above
