console.log("CLIENT_JS_VERSION: DEBUG_BUILD_v3");
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
        // Drawer navigation: attendance gets a dedicated path (forces the
        // section active directly); everything else goes through the
        // shared showSection() defined below in this same file.
        function drawerNav(name) {
            console.log("[nav] drawerNav called with:", name);
            if (name === "attendance") {
                navAttendance();
                return;
            }
            closeMobileDrawer();
            if (typeof showSection === "function") showSection(name);
        }

        function navAttendance() {
            console.log("[nav] navAttendance() called — forcing attendance section directly");
            // Force attendance section active directly (shared showSection may be overridden)
            document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            const sec = document.getElementById("section-attendance");
            const nav = document.getElementById("nav-attendance");
            if (sec) sec.classList.add("active");
            if (nav) nav.classList.add("active");
            // Close mobile drawer if open
            if (typeof closeMobileDrawer === "function") closeMobileDrawer();
            const dateInput = document.getElementById("att-date");
            if (dateInput && !dateInput.value) _attSetDateValue(getTodayStr(), false);
            history.pushState({ type: "section", name: "attendance" }, "", "");
            attLoadAndRenderStudents();
        }

        function showSection(name, push = true) {
            console.log("[nav] showSection called with name:", name);
            if (typeof _attCloseCalendar === "function") _attCloseCalendar();
            document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            const sec = document.getElementById(`section-${name}`);
            const nav = document.getElementById(`nav-${name}`);
            console.log("[nav] section element found:", !!sec, "| nav element found:", !!nav);
            if (sec) sec.classList.add("active");
            if (nav) nav.classList.add("active");
            if (name === "attendance") {
                console.log("[nav] attendance branch hit — calling attLoadAndRenderStudents()");
                const dateInput = document.getElementById("att-date");
                if (dateInput && !dateInput.value) _attSetDateValue(getTodayStr(), false);
                attLoadAndRenderStudents();
            }
            // drawerNav('attendance') also lands here — handled above
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
           ATTENDANCE — Class Cards → Section Cards → Student list (with checkboxes)
        ══════════════════════════════════════════════════════════════════ */
        let _attStudents = [];
        let _attFilteredStudents = [];
        let _attExistingRecords = {};
        let _attSelectedRolls = new Set();
        let _attView = "classes"; // "classes" | "sections" | "list"
        let _attCurrentClass = null;
        let _attCurrentSection = null;

        function getTodayStr() {
            const d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        }

        // ── attendance can only be marked/edited for TODAY. Past dates are
        //    view-only; future dates can't be selected at all. ──────────────
        function _attSelectedDateIso() {
            const hidden = document.getElementById("att-date");
            return (hidden && hidden.value) ? hidden.value : getTodayStr();
        }
        function _attIsEditableDate() {
            return _attSelectedDateIso() === getTodayStr();
        }
        function _attIsFutureDate(iso) {
            return iso > getTodayStr();
        }

        /* ── custom date picker ────────────────────────────────────────────
           Replaces the native <input type="date"> with a click-anywhere
           popup calendar. The ISO value (yyyy-mm-dd) lives in the hidden
           #att-date input; the visible label shows dd-mm-yyyy.          */
        let _attCalViewYear  = null;
        let _attCalViewMonth = null; // 0-indexed

        function _attSetDateValue(isoStr, triggerChange) {
            const hidden = document.getElementById("att-date");
            const label  = document.getElementById("att-date-label");
            if (hidden) hidden.value = isoStr;
            if (label) {
                const [y, m, d] = isoStr.split("-");
                label.textContent = `${d}-${m}-${y}`;
            }
            if (triggerChange) attOnDateChange();
        }

        // The popup is a single persistent node appended directly to <body>.
        // Appending it to body (rather than nesting it inside the repeatedly
        // re-rendered #att-cards-wrap) means it's immune to any transformed/
        // overflow ancestor that would otherwise break `position:fixed`
        // coordinates, and a very high z-index keeps it above the bulk
        // action bar at the bottom of the student list.
        function _attGetCalendarPopup() {
            let popup = document.getElementById("att-cal-popup");
            if (!popup) {
                popup = document.createElement("div");
                popup.id = "att-cal-popup";
                popup.style.cssText = "display:none;position:fixed;z-index:99999;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,0.28);padding:14px;width:260px;max-width:calc(100vw - 24px)";
                document.body.appendChild(popup);
            }
            return popup;
        }

        function _attCloseCalendar() {
            const popup = document.getElementById("att-cal-popup");
            if (popup) popup.style.display = "none";
            document.removeEventListener("click", _attCalOutsideClick);
            window.removeEventListener("resize", _attRepositionOpenCalendar);
        }

        function attToggleCalendar(e) {
            if (e) e.stopPropagation();
            const popup = _attGetCalendarPopup();
            const wrap  = document.getElementById("att-date-wrap");
            if (!popup || !wrap) return;
            const isOpen = popup.style.display !== "none";
            if (isOpen) { _attCloseCalendar(); return; }
            const hidden = document.getElementById("att-date");
            const base = (hidden && hidden.value) ? hidden.value : getTodayStr();
            const [y, m] = base.split("-").map(Number);
            _attCalViewYear  = y;
            _attCalViewMonth = m - 1;
            _attRenderCalendar();
            popup.style.display = "block";
            _attPositionCalendar(wrap, popup);
            // close when clicking outside
            setTimeout(() => {
                document.addEventListener("click", _attCalOutsideClick);
                window.addEventListener("resize", _attRepositionOpenCalendar);
            }, 0);
        }

        // Clamp the fixed-position popup so it always stays fully on-screen,
        // regardless of viewport width (fixes mobile overflow/cropping).
        function _attPositionCalendar(wrap, popup) {
            const margin = 12;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const popW = Math.min(260, vw - margin * 2);
            popup.style.width = popW + "px";
            const rect = wrap.getBoundingClientRect();

            // Align left edge with the wrap element; fallback to right-align if it overflows
            let left = rect.left;
            if (left + popW > vw - margin) left = vw - margin - popW;
            if (left < margin) left = margin;

            // Measure real height now that popup is visible (display:block was set before this call)
            const popH = popup.offsetHeight || 320;
            let top = rect.bottom + 6;
            if (top + popH > vh - margin) {
                top = rect.top - popH - 6;
                if (top < margin) top = margin;
            }

            popup.style.left = left + "px";
            popup.style.top  = top + "px";
        }

        function _attRepositionOpenCalendar() {
            const popup = document.getElementById("att-cal-popup");
            const wrap  = document.getElementById("att-date-wrap");
            if (!popup || !wrap || popup.style.display === "none") return;
            _attPositionCalendar(wrap, popup);
        }

        function _attCalOutsideClick(e) {
            const wrap  = document.getElementById("att-date-wrap");
            const popup = document.getElementById("att-cal-popup");
            if (!popup || popup.style.display === "none") {
                document.removeEventListener("click", _attCalOutsideClick);
                window.removeEventListener("resize", _attRepositionOpenCalendar);
                return;
            }
            if (popup.contains(e.target)) return;
            if (wrap && !wrap.contains(e.target)) {
                _attCloseCalendar();
            }
        }

        function _attCalNav(delta) {
            _attCalViewMonth += delta;
            if (_attCalViewMonth < 0) { _attCalViewMonth = 11; _attCalViewYear--; }
            if (_attCalViewMonth > 11) { _attCalViewMonth = 0; _attCalViewYear++; }
            _attRenderCalendar();
            // Month length can change (28-31 days), which changes popup
            // height — reposition so it stays anchored under the pill.
            const wrap = document.getElementById("att-date-wrap");
            const popup = document.getElementById("att-cal-popup");
            if (wrap && popup) _attPositionCalendar(wrap, popup);
        }

        function _attRenderCalendar() {
            const popup = _attGetCalendarPopup();
            if (!popup) return;
            const hidden  = document.getElementById("att-date");
            const selIso  = hidden ? hidden.value : "";
            const todayIso = getTodayStr();

            const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
            const y = _attCalViewYear, m = _attCalViewMonth;
            const firstDow   = new Date(y, m, 1).getDay();
            const daysInMonth = new Date(y, m + 1, 0).getDate();

            let cells = "";
            for (let i = 0; i < firstDow; i++) cells += `<div></div>`;
            for (let day = 1; day <= daysInMonth; day++) {
                const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                const isSel   = iso === selIso;
                const isToday = iso === todayIso;
                const isFuture = iso > todayIso;
                let bg = "transparent", color = "var(--text)", fw = "500", border = "1.5px solid transparent";
                if (isSel)        { bg = "var(--accent)"; color = "#fff"; fw = "700"; }
                else if (isToday) { border = "1.5px solid var(--accent)"; fw = "700"; }
                if (isFuture) {
                    cells += `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:0.82rem;font-weight:500;color:var(--text-muted);opacity:0.35;cursor:not-allowed">${day}</div>`;
                    continue;
                }
                cells += `<div onclick="event.stopPropagation();_attPickDate('${iso}')"
                    style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;font-size:0.82rem;font-weight:${fw};color:${color};background:${bg};border:${border};transition:background 0.12s"
                    onmouseover="if('${isSel}'!=='true')this.style.background='var(--bg-input)'"
                    onmouseout="if('${isSel}'!=='true')this.style.background='${bg}'">${day}</div>`;
            }

            popup.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
                    <button onclick="event.stopPropagation();_attCalNav(-1)" style="background:none;border:none;cursor:pointer;font-size:1rem;color:var(--text);padding:4px 8px;border-radius:6px" onmouseover="this.style.background='var(--bg-input)'" onmouseout="this.style.background='none'">‹</button>
                    <div style="font-weight:700;font-size:0.86rem;color:var(--text)">${monthNames[m]} ${y}</div>
                    <button onclick="event.stopPropagation();_attCalNav(1)" style="background:none;border:none;cursor:pointer;font-size:1rem;color:var(--text);padding:4px 8px;border-radius:6px" onmouseover="this.style.background='var(--bg-input)'" onmouseout="this.style.background='none'">›</button>
                </div>
                <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px">
                    ${["S","M","T","W","T","F","S"].map(d => `<div style="text-align:center;font-size:0.68rem;font-weight:700;color:var(--text-muted)">${d}</div>`).join("")}
                </div>
                <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">${cells}</div>
                <div style="margin-top:10px;text-align:center">
                    <button onclick="event.stopPropagation();_attPickDate('${todayIso}')"
                        style="font-size:0.76rem;font-weight:600;color:var(--accent);background:none;border:none;cursor:pointer">Today</button>
                </div>`;
        }

        function _attPickDate(iso) {
            if (_attIsFutureDate(iso)) return;
            _attSetDateValue(iso, true);
            _attCloseCalendar();
        }

        // ── date changed: reload records for new date, stay on current view ──
        async function attOnDateChange() {
            await _attLoadRecords();
            if (_attView === "sections" && _attCurrentClass) {
                _attShowSectionCards(_attCurrentClass);
            } else if (_attView === "list" && _attCurrentClass && _attCurrentSection) {
                _attShowStudentList(_attCurrentClass, _attCurrentSection);
            } else {
                _attShowClassCards();
            }
        }

        // ── top-level entry point called by navAttendance ──────────────────
        function _attEnsureCardsWrap() {
            let wrap = document.getElementById("att-cards-wrap");
            if (wrap) return wrap;

            const section = document.getElementById("section-attendance");
            if (!section) return null;

            // Insert right after the page-header, before the search toolbar
            const header = section.querySelector(".page-header");
            wrap = document.createElement("div");
            wrap.id = "att-cards-wrap";
            wrap.style.marginBottom = "20px";

            if (header && header.nextSibling) {
                header.parentNode.insertBefore(wrap, header.nextSibling);
            } else if (header) {
                header.parentNode.appendChild(wrap);
            } else {
                section.insertBefore(wrap, section.firstChild);
            }
            console.log("[attendance] auto-created #att-cards-wrap");
            return wrap;
        }

        async function attLoadAndRenderStudents() {
            console.log("[attendance] attLoadAndRenderStudents() called");
            const dateInput = document.getElementById("att-date");
            if (!dateInput) { console.warn("[attendance] #att-date not found"); return; }
            if (!dateInput.value) _attSetDateValue(getTodayStr(), false);

            // Auto-create the cards container if the HTML hasn't been updated with it yet.
            _attEnsureCardsWrap();

            const loadingEl = document.getElementById("att-loading");
            if (loadingEl) loadingEl.style.display = "block";

            try {
                const r = await fetch(`${API_BASE}/api/admin/attendance/students`, { credentials:"include", cache:"no-store" });
                if (!r.ok) throw new Error(`Failed to load students (${r.status})`);
                _attStudents = await r.json();
                console.log("[attendance] students loaded:", _attStudents.length);
            } catch(e) {
                console.error("[attendance] load error:", e);
                if (loadingEl) loadingEl.style.display = "none";
                showErrorModal(e.message || "Failed to load students");
                return;
            }

            if (loadingEl) loadingEl.style.display = "none";

            // Load today's existing records
            await _attLoadRecords();
            // Show class cards view
            _attShowClassCards();
        }

        async function _attLoadRecords() {
            const dateInput = document.getElementById("att-date");
            const date = dateInput ? dateInput.value : getTodayStr();
            _attExistingRecords = {};
            try {
                const rr = await fetch(`${API_BASE}/api/admin/attendance/records?date=${date}`, { credentials:"include", cache:"no-store" });
                if (rr.ok) {
                    const recs = await rr.json();
                    recs.forEach(rec => { _attExistingRecords[rec.roll_number] = rec.status; });
                }
            } catch(_) {}
        }

        // ── group helpers ──────────────────────────────────────────────────
        // Splits a raw class string like "Class 10 - A" / "10-A" / "Class 12"
        // into { base: "10", section: "A" } (section is "" if none present).
        function _attParseClassSection(raw) {
            const str = (raw || "").trim();
            if (!str) return { base: "Unspecified", section: "" };
            // Match "<anything> - <section>" or "<anything>-<section>" at the end
            const m = str.match(/^(.*?)\s*-\s*([A-Za-z0-9]+)\s*$/);
            if (m) {
                return { base: m[1].trim(), section: m[2].trim() };
            }
            return { base: str, section: "" };
        }

        function _attGroupByClass() {
            const map = {};
            _attStudents.forEach(s => {
                const raw = s.class_name || s.class || "Unspecified";
                const { base } = _attParseClassSection(raw);
                if (!map[base]) map[base] = [];
                map[base].push(s);
            });
            return map;
        }

        function _attGroupBySection(students) {
            const map = {};
            students.forEach(s => {
                const raw = s.class_name || s.class || "";
                const { section } = _attParseClassSection(raw);
                const explicitSec = (s.section || s.batch_name || "").trim();
                const sec = explicitSec || section || "General";
                if (!map[sec]) map[sec] = [];
                map[sec].push(s);
            });
            return map;
        }

        // ── small ring showing present/total proportion on a card ───────────
        function _attRingSvg(present, total, color) {
            const pct = total > 0 ? present / total : 0;
            const r = 17, c = 2 * Math.PI * r;
            const dash = c * pct;
            return `<svg class="att-card-ring" width="44" height="44" viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--border)" stroke-width="4"/>
                <circle cx="22" cy="22" r="${r}" fill="none" stroke="${color}" stroke-width="4"
                    stroke-dasharray="${dash} ${c - dash}" stroke-linecap="round"
                    transform="rotate(-90 22 22)"/>
                <text x="22" y="26" text-anchor="middle" font-size="11" font-weight="800" fill="var(--text)" font-family="'Outfit',sans-serif">${present}/${total}</text>
            </svg>`;
        }

        const ATT_CAP_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 5-10 5L2 8l10-5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
        const ATT_FOLDER_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;

        // ── LEVEL 1 : Class Cards ──────────────────────────────────────────
        function _attShowClassCards() {
            _attCloseCalendar();
            _attView = "classes";
            _attCurrentClass = null;
            _attCurrentSection = null;

            const wrap = document.getElementById("att-cards-wrap");
            if (!wrap) return;

            const byClass = _attGroupByClass();
            const classes = Object.keys(byClass).sort();
            const colors  = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6"];

            // Hide flat table elements, show cards
            _attToggleFlatUI(false);

            if (!classes.length) {
                wrap.innerHTML = `
                    ${_attDateWidgetHtml()}
                    <div class="att-empty-state">
                        <div class="att-empty-icon">${ATT_CAP_ICON}</div>
                        <h3>No students found</h3>
                        <p>Add students to the portal first.</p>
                    </div>`;
                _attSyncDateLabel();
                return;
            }

            wrap.innerHTML = `
                ${_attDateWidgetHtml()}
                <div class="att-eyebrow">Class Cards <span class="att-eyebrow-count">${classes.length}</span></div>
                <div class="att-card-grid">
                    ${classes.map((cls, i) => {
                        const studs   = byClass[cls];
                        const color   = colors[i % colors.length];
                        const present = studs.filter(s => _attExistingRecords[s.roll_number] === "present").length;
                        const marked  = studs.filter(s => _attExistingRecords[s.roll_number]).length;
                        let statusHtml = `<span class="att-card-status none">Not marked yet</span>`;
                        if (marked > 0 && marked === studs.length) statusHtml = `<span class="att-card-status done">All marked</span>`;
                        else if (marked > 0) statusHtml = `<span class="att-card-status partial">${marked}/${studs.length} marked</span>`;
                        return `<div class="att-card" style="--card-color:${color}" tabindex="0" role="button"
                            onclick="_attShowSectionCards('${cls.replace(/'/g,"\\'")}')"
                            onkeydown="if(event.key==='Enter')this.click()">
                            <div class="att-card-top">
                                <div class="att-card-icon">${ATT_CAP_ICON}</div>
                                ${marked > 0 ? _attRingSvg(present, studs.length, color) : ""}
                            </div>
                            <div class="att-card-title">${cls}</div>
                            <div class="att-card-sub">${studs.length} Student${studs.length !== 1 ? "s" : ""}</div>
                            ${statusHtml}
                        </div>`;
                    }).join("")}
                </div>`;
            _attSyncDateLabel();
        }

        // ── shared markup for the date-picker widget shown above the class cards ──
        function _attDateWidgetHtml() {
            return `<div style="display:flex;justify-content:flex-start;margin-bottom:18px">
                <div class="att-marking-date" id="att-date-wrap" onclick="attToggleCalendar(event)" style="position:relative">
                    <div id="att-date-display" class="att-date-pill">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                        <span id="att-date-label">--/--/----</span>
                        <svg class="att-date-cal-icon" width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </div>
                </div>
            </div>`;
        }

        // ── keep the visible date label in sync with the hidden #att-date value ──
        function _attSyncDateLabel() {
            const hidden = document.getElementById("att-date");
            const label  = document.getElementById("att-date-label");
            if (hidden && hidden.value && label) {
                const [y, m, d] = hidden.value.split("-");
                label.textContent = `${d}-${m}-${y}`;
            }
        }

        // ── LEVEL 2 : Section Cards ────────────────────────────────────────
        function _attShowSectionCards(className) {
            _attCloseCalendar();
            _attView = "sections";
            _attCurrentClass   = className;
            _attCurrentSection = null;

            const wrap = document.getElementById("att-cards-wrap");
            if (!wrap) return;

            const byClass   = _attGroupByClass();
            const students  = byClass[className] || [];
            const bySection = _attGroupBySection(students);
            const sections  = Object.keys(bySection).sort();
            const colors    = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#14b8a6"];

            _attToggleFlatUI(false);

            wrap.innerHTML = `
                ${_attDateWidgetHtml()}
                <div class="att-breadcrumb">
                    <button class="att-back-btn" onclick="_attShowClassCards()">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        Classes
                    </button>
                    <span class="att-crumb-trail"><span class="att-crumb-sep">/</span><span class="att-crumb-current">${className}</span><span class="att-crumb-sep">·</span>${sections.length} Section${sections.length !== 1 ? "s" : ""}</span>
                </div>
                <div class="att-card-grid">
                    ${sections.map((sec, i) => {
                        const studs   = bySection[sec];
                        const color   = colors[i % colors.length];
                        const present = studs.filter(s => _attExistingRecords[s.roll_number] === "present").length;
                        const marked  = studs.filter(s => _attExistingRecords[s.roll_number]).length;
                        let statusHtml = `<span class="att-card-status none">Not marked yet</span>`;
                        if (marked > 0 && marked === studs.length) statusHtml = `<span class="att-card-status done">All marked</span>`;
                        else if (marked > 0) statusHtml = `<span class="att-card-status partial">${marked}/${studs.length} marked</span>`;
                        return `<div class="att-card" style="--card-color:${color}" tabindex="0" role="button"
                            onclick="_attShowStudentList('${className.replace(/'/g,"\\'")}','${sec.replace(/'/g,"\\'")}' )"
                            onkeydown="if(event.key==='Enter')this.click()">
                            <div class="att-card-top">
                                <div class="att-card-icon">${ATT_FOLDER_ICON}</div>
                                ${marked > 0 ? _attRingSvg(present, studs.length, color) : ""}
                            </div>
                            <div class="att-card-title">Section ${sec}</div>
                            <div class="att-card-sub">${studs.length} Student${studs.length !== 1 ? "s" : ""}</div>
                            ${statusHtml}
                        </div>`;
                    }).join("")}
                </div>`;
            _attSyncDateLabel();
        }

        // ══════════════════════════════════════════════════════════════════
        // LEVEL 3 : Student list — flat list with 3-way Present/Late/Absent.
        // Redesigned to match the reference UI. Still fully wired to the real
        // backend (/api/admin/attendance/{records,mark}). Setting a status on a
        // student auto-saves immediately (no separate "mark" step needed).
        // The card system (class cards → section cards) above is unchanged.
        // ══════════════════════════════════════════════════════════════════

        // Per-roll status for the currently-shown list. Mirrors _attExistingRecords
        // but is the live working copy for this section's list view.
        let _attListStatus = {};   // { roll_number: "present" | "late" | "absent" }
        let _attLastSaved  = null; // timestamp of last successful save (for "Last saved" line)

        const MONTH_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const WEEKDAY_FULL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        const WEEKDAY_ABBR = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
        const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

        function _attIsoToDate(iso) {
            const [y, m, d] = (iso || getTodayStr()).split("-").map(Number);
            return new Date(y, (m || 1) - 1, d || 1);
        }
        function _attDateToIso(dt) {
            return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
        }
        function _attAddDays(iso, delta) {
            const dt = _attIsoToDate(iso);
            dt.setDate(dt.getDate() + delta);
            return _attDateToIso(dt);
        }

        function _attShowStudentList(className, section) {
            _attCloseCalendar();
            _attView = "list";
            _attCurrentClass   = className;
            _attCurrentSection = section;

            const wrap = document.getElementById("att-cards-wrap");
            if (!wrap) return;

            const byClass   = _attGroupByClass();
            const students  = byClass[className] || [];
            const bySection = _attGroupBySection(students);
            _attFilteredStudents = bySection[section] || [];

            // Seed the working status map from whatever the backend already has.
            _attListStatus = {};
            _attFilteredStudents.forEach(s => {
                const r = s.roll_number;
                if (r && _attExistingRecords[r]) _attListStatus[r] = _attExistingRecords[r];
            });

            // Hide the legacy flat table/toolbar/bulk-bar — this redesigned view
            // renders its own panel inside #att-cards-wrap.
            _attToggleFlatUI(false);

            wrap.innerHTML = _attBuildListView(className, section);
            _attBindDayStrip();
            _attRenderStudentTable();
        }

        // Build the entire student-list view markup (header → day strip → date row
        // → stat cards → students panel).
        function _attBuildListView(className, section) {
            const iso       = _attSelectedDateIso();
            const dateObj   = _attIsoToDate(iso);
            const total     = _attFilteredStudents.length;
            const present   = _attCountStatus("present");
            const late      = _attCountStatus("late");
            const absent    = _attCountStatus("absent");
            const marked    = present + late + absent;
            const pctPresent = total > 0 ? Math.round(((present + late) / total) * 100) : 0;
            const isEditable = _attIsEditableDate();

            const eyebrow = `${className} · Section ${section}`;
            const longDate = `${WEEKDAY_FULL[dateObj.getDay()]}, ${dateObj.getDate()} ${MONTH_FULL[dateObj.getMonth()]} ${dateObj.getFullYear()}`;

            return `
            <section class="attx" aria-label="Attendance for ${eyebrow}">
                <header class="attx-head">
                    <div class="attx-head-left">
                        <button class="attx-crumb-back" onclick="_attShowSectionCards('${className.replace(/'/g,"\\'")}' )" aria-label="Back to sections">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div>
                            <div class="attx-eyebrow"><span class="attx-eyebrow-dot"></span>${eyebrow.toUpperCase()}</div>
                            <h1 class="attx-title">Attendance</h1>
                            <p class="attx-subtitle" id="attx-subtitle">${pctPresent}% present · ${marked}/${total} marked</p>
                        </div>
                    </div>
                    <div class="attx-markbulk-wrap ${isEditable ? "" : "is-disabled"}">
                        <div class="attx-status-selector" id="attx-status-selector">
                            <button class="attx-status-opt is-sel" data-status="present" onclick="attSelectBulkStatus(this,'present')" ${isEditable ? "" : "disabled"}>
                                <span class="attx-status-dot present"></span>Present
                            </button>
                            <button class="attx-status-opt" data-status="late" onclick="attSelectBulkStatus(this,'late')" ${isEditable ? "" : "disabled"}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Late
                            </button>
                            <button class="attx-status-opt" data-status="absent" onclick="attSelectBulkStatus(this,'absent')" ${isEditable ? "" : "disabled"}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>Absent
                            </button>
                        </div>
                        <button class="attx-markall ${isEditable ? "" : "is-disabled"}" id="attx-markall" onclick="attMarkAllBulk()" ${isEditable ? "" : "disabled"}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            Mark Attendance
                        </button>
                    </div>
                </header>

                ${_attDayStripHtml(iso)}

                <div class="attx-daterow">
                    <div class="attx-daterow-left">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M3 9h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
                        <span>${longDate}</span>
                    </div>
                    <div class="attx-saved" id="attx-saved">${_attSavedLabel()}</div>
                </div>

                <div class="attx-stats" id="attx-stats">
                    ${_attStatCardsHtml(total, present, late, absent, pctPresent)}
                </div>

                <section class="attx-panel">
                    <div class="attx-panel-head">
                        <h2 class="attx-panel-title">Students <span class="attx-panel-count">(${total})</span></h2>
                        <div class="attx-legend">
                            <span class="attx-legend-item"><span class="attx-legend-dot present"></span>Present</span>
                            <span class="attx-legend-item"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Late</span>
                            <span class="attx-legend-item"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>Absent</span>
                        </div>
                    </div>
                    <div class="attx-thead">
                        <span>Student</span>
                        <span class="attx-thead-status">Status</span>
                    </div>
                    <div class="attx-rows" id="attx-rows"></div>
                    <div class="attx-empty" id="attx-empty" style="display:none">
                        <div class="attx-empty-icon">${ATT_CAP_ICON}</div>
                        <h3>No students found</h3>
                        <p>No students in this section yet.</p>
                    </div>
                </section>
            </section>`;
        }

        function _attCountStatus(status) {
            return _attFilteredStudents.filter(s => s.roll_number && _attListStatus[s.roll_number] === status).length;
        }

        function _attSavedLabel() {
            if (!_attLastSaved) return `<span class="attx-saved-muted">Not saved yet</span>`;
            const secs = Math.round((Date.now() - _attLastSaved) / 1000);
            let txt = "just now";
            if (secs >= 60) { const m = Math.floor(secs/60); txt = m + (m === 1 ? " min ago" : " mins ago"); }
            return `Last saved ${txt} <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="var(--success)"/><path d="M8 12.5l2.5 2.5L16 9" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        }

        // ── horizontal day / week strip ────────────────────────────────────
        function _attDayStripHtml(selectedIso) {
            const todayIso = getTodayStr();
            // Center the selected day; show 3 before + selected + 3 after (7 cols).
            const days = [];
            for (let i = -3; i <= 3; i++) days.push(_attAddDays(selectedIso, i));

            const cols = days.map(iso => {
                const dt = _attIsoToDate(iso);
                const isSel    = iso === selectedIso;
                const isFuture = iso > todayIso;
                const isToday  = iso === todayIso;
                const hasMark  = !!_attExistingRecords[iso]; // not per-day but kept for dot; see below
                // Dot indicator: show a small dot when that date has saved records.
                // We can't cheaply know per-date totals here, so show a subtle dot
                // for past/today dates that are not the selected one.
                const showDot = !isSel && !isFuture;
                return `
                <button class="attx-day ${isSel ? "is-sel" : ""} ${isFuture ? "is-future" : ""}"
                    ${isFuture ? "disabled" : `data-iso="${iso}"`}
                    aria-label="${WEEKDAY_FULL[dt.getDay()]} ${dt.getDate()}">
                    <span class="attx-day-wd">${WEEKDAY_ABBR[dt.getDay()]}</span>
                    <span class="attx-day-num">${dt.getDate()}</span>
                    ${isSel ? `<span class="attx-day-mon">${MONTH_ABBR[dt.getMonth()]} ${dt.getFullYear()}</span>` : (showDot ? `<span class="attx-day-dot"></span>` : `<span class="attx-day-dot-gap"></span>`)}
                </button>`;
            }).join("");

            return `
            <div class="attx-daystrip">
                <button class="attx-day-nav" id="attx-day-prev" aria-label="Previous week">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <div class="attx-days">${cols}</div>
                <button class="attx-day-nav" id="attx-day-next" aria-label="Next week">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
            </div>`;
        }

        function _attBindDayStrip() {
            const wrap = document.getElementById("att-cards-wrap");
            if (!wrap) return;
            wrap.querySelectorAll(".attx-day[data-iso]").forEach(btn => {
                btn.addEventListener("click", () => _attGoToDate(btn.getAttribute("data-iso")));
            });
            const prev = document.getElementById("attx-day-prev");
            const next = document.getElementById("attx-day-next");
            if (prev) prev.addEventListener("click", () => _attGoToDate(_attAddDays(_attSelectedDateIso(), -7)));
            if (next) next.addEventListener("click", () => {
                const target = _attAddDays(_attSelectedDateIso(), 7);
                if (!_attIsFutureDate(target)) _attGoToDate(target);
                else _attGoToDate(getTodayStr());
            });
        }

        async function _attGoToDate(iso) {
            if (!iso || _attIsFutureDate(iso)) return;
            _attSetDateValue(iso, false);
            await _attLoadRecords();
            // Re-render the list for the new date (stays in list view).
            _attShowStudentList(_attCurrentClass, _attCurrentSection);
        }

        // ── stat cards ─────────────────────────────────────────────────────
        function _attStatCardsHtml(total, present, late, absent, pctPresent) {
            // mini bar chart (decorative; reflects nothing sensitive — shows a
            // light "last 14 days" trend bar pattern)
            const bars = [];
            for (let i = 0; i < 14; i++) {
                const h = 30 + ((i * 37 + 11) % 60);
                const strong = i % 3 === 0;
                bars.push(`<span class="attx-bar ${strong ? "strong" : ""}" style="height:${h}%"></span>`);
            }
            const presentCard = `
                <div class="attx-stat attx-stat--plain">
                    <div class="attx-stat-top">
                        <span class="attx-stat-label">Present</span>
                        <span class="attx-stat-ic present"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                    </div>
                    <div class="attx-stat-main"><span class="attx-stat-num present">${pctPresent}%</span></div>
                    <div class="attx-stat-sub">${present + late} student${(present+late)!==1?"s":""} present</div>
                </div>`;
            return `
                <div class="attx-stat attx-stat--plain">
                    <div class="attx-stat-top">
                        <span class="attx-stat-label">Total Students</span>
                        <span class="attx-stat-ic neutral"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="17" cy="8.5" r="2.6" stroke="currentColor" stroke-width="1.7"/><path d="M16 14.2c2.6.2 4.5 2.1 4.5 4.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span>
                    </div>
                    <div class="attx-stat-main"><span class="attx-stat-num">${total}</span></div>
                    <div class="attx-stat-sub">All enrolled students</div>
                </div>
                ${presentCard}
                <div class="attx-stat attx-stat--absent">
                    <div class="attx-stat-top">
                        <span class="attx-stat-label">Absent</span>
                        <span class="attx-stat-ic absent"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M16 8l4 4M20 8l-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
                    </div>
                    <div class="attx-stat-main"><span class="attx-stat-num absent">${absent}</span></div>
                    <div class="attx-stat-sub">${absent} student${absent!==1?"s":""} absent</div>
                </div>
                <div class="attx-stat attx-stat--chart">
                    <div class="attx-stat-top">
                        <span class="attx-stat-label">Last 14 days</span>
                        <span class="attx-stat-ic chart"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 20V10M9 20V5M14 20v-7M19 20V8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg></span>
                    </div>
                    <div class="attx-bars">${bars.join("")}</div>
                    <div class="attx-stat-sub">Average ${present+late}/${total}</div>
                </div>`;
        }

        // ── student rows with 3-way status pills ───────────────────────────
        function _attRenderStudentTable() {
            const rowsEl  = document.getElementById("attx-rows");
            const emptyEl = document.getElementById("attx-empty");
            if (!rowsEl) return;

            const isEditable = _attIsEditableDate();

            if (!_attFilteredStudents.length) {
                rowsEl.innerHTML = "";
                if (emptyEl) emptyEl.style.display = "block";
                return;
            }
            if (emptyEl) emptyEl.style.display = "none";

            rowsEl.innerHTML = _attFilteredStudents.map(s => {
                const roll   = s.roll_number || "";
                const name   = s.name || roll || "—";
                const status = _attListStatus[roll] || "";
                const color  = _attAvatarColor(roll || name);
                const safeRoll = roll.replace(/'/g,"\\'");

                function pill(kind, label, svg) {
                    const active = status === kind;
                    const dis = isEditable ? "" : "disabled";
                    return `<button class="attx-pill attx-pill--${kind} ${active ? "is-active" : ""}" ${dis}
                        onclick="attSetStatus('${safeRoll}','${kind}')" aria-pressed="${active}">
                        ${svg}<span>${label}</span></button>`;
                }
                const presentPill = pill("present","Present",`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
                const latePill    = pill("late","Late",`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="M12 8v4l3 2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
                const absentPill  = pill("absent","Absent",`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`);

                return `<div class="attx-row" data-roll="${roll}">
                    <div class="attx-row-student">
                        <span class="attx-avatar" style="--avatar-color:${color}">${_attInitials(name)}</span>
                        <span class="attx-row-info">
                            <span class="attx-row-name">${name}</span>
                            <span class="attx-row-roll">${roll || "—"}</span>
                        </span>
                    </div>
                    <div class="attx-row-status">${presentPill}${latePill}${absentPill}</div>
                </div>`;
            }).join("");
        }

        function _attInitials(name) {
            const parts = (name || "").trim().split(/\s+/).filter(Boolean);
            if (!parts.length) return "?";
            if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        }

        const ATT_AVATAR_COLORS = ["#10b981","#14b8a6","#3b82f6","#8b5cf6","#f59e0b","#ec4899","#6366f1","#0ea5e9"];
        function _attAvatarColor(seed) {
            let h = 0;
            for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
            return ATT_AVATAR_COLORS[h % ATT_AVATAR_COLORS.length];
        }

        // ── refresh the header subtitle, stat cards & saved-line in place ───
        function _attRefreshSummary() {
            const total   = _attFilteredStudents.length;
            const present = _attCountStatus("present");
            const late    = _attCountStatus("late");
            const absent  = _attCountStatus("absent");
            const marked  = present + late + absent;
            const pct     = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

            const sub = document.getElementById("attx-subtitle");
            if (sub) sub.textContent = `${pct}% present · ${marked}/${total} marked`;
            const stats = document.getElementById("attx-stats");
            if (stats) stats.innerHTML = _attStatCardsHtml(total, present, late, absent, pct);
            const saved = document.getElementById("attx-saved");
            if (saved) saved.innerHTML = _attSavedLabel();
        }

        // ── set a single student's status → auto-saves to backend ──────────
        async function attSetStatus(roll, status) {
            if (!roll) return;
            if (!_attIsEditableDate()) {
                showErrorModal("Attendance can only be marked for today. Past dates are view-only.");
                return;
            }
            // Toggle off if tapping the already-active status → "unmark".
            const current = _attListStatus[roll];
            const next = current === status ? "" : status;

            // Optimistic UI update.
            if (next) _attListStatus[roll] = next; else delete _attListStatus[roll];
            _attRenderStudentTable();
            _attRefreshSummary();

            try {
                await _attSaveStatus(roll, next);
                _attExistingRecords[roll] = next || undefined;
                if (!next) delete _attExistingRecords[roll];
                _attLastSaved = Date.now();
                const saved = document.getElementById("attx-saved");
                if (saved) saved.innerHTML = _attSavedLabel();
            } catch (e) {
                // Roll back on failure.
                if (current) _attListStatus[roll] = current; else delete _attListStatus[roll];
                _attRenderStudentTable();
                _attRefreshSummary();
                showErrorModal(e.message || "Failed to save attendance");
            }
        }

        // Resolve the class_id for the current class (cached per list view).
        let _attResolvedClassId = null;
        let _attResolvedClassName = null;
        async function _attGetClassId() {
            if (_attResolvedClassId !== null && _attResolvedClassName === _attCurrentClass) return _attResolvedClassId;
            let class_id = 0;
            try {
                const cr = await fetch(`${API_BASE}/api/admin/classes`, { credentials: "include", cache: "no-store" });
                if (cr.ok) {
                    const classes = await cr.json();
                    const match = classes.find(c => c.name === _attCurrentClass);
                    if (match) class_id = match.id;
                }
            } catch (_) {}
            _attResolvedClassId = class_id;
            _attResolvedClassName = _attCurrentClass;
            return class_id;
        }

        // Persist a single status to the backend mark endpoint.
        async function _attSaveStatus(roll, status) {
            const date = _attSelectedDateIso();
            const class_id = await _attGetClassId();
            // When un-setting, mark as "absent" fallback is NOT desired; the backend
            // has no "delete" — so we send an explicit status. If "" (unmark), we
            // simply send absent? No — to keep semantics clean we send the status
            // and treat empty as a no-op delete by sending status "unmarked".
            const sendStatus = status || "unmarked";
            const r = await fetch(`${API_BASE}/api/admin/attendance/mark`, {
                method: "POST", credentials: "include", cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ class_id, batch_id: null, date, roll_numbers: [roll], status: sendStatus }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || "Failed to save");
        }

        // ── Bulk status selector (Present / Late / Absent) ──────────────────
        let _attBulkStatus = "present";

        function attSelectBulkStatus(btn, status) {
            _attBulkStatus = status;
            const opts = document.querySelectorAll(".attx-status-opt");
            opts.forEach(o => o.classList.remove("is-sel"));
            if (btn) btn.classList.add("is-sel");
        }

        // ── "Mark Attendance" — sets everyone to the chosen status + saves ──
        async function attMarkAllBulk() {
            if (!_attIsEditableDate()) {
                showErrorModal("Attendance can only be marked for today. Past dates are view-only.");
                return;
            }
            if (!_attFilteredStudents.length) { showErrorModal("No students to mark."); return; }

            const status = _attBulkStatus || "present";
            const rolls = _attFilteredStudents.map(s => s.roll_number).filter(Boolean);
            const prev = { ..._attListStatus };

            rolls.forEach(r => { _attListStatus[r] = status; });
            _attRenderStudentTable();
            _attRefreshSummary();

            const btn = document.getElementById("attx-markall");
            if (btn) btn.disabled = true;

            try {
                const date = _attSelectedDateIso();
                const class_id = await _attGetClassId();
                const r = await fetch(`${API_BASE}/api/admin/attendance/mark`, {
                    method: "POST", credentials: "include", cache: "no-store",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ class_id, batch_id: null, date, roll_numbers: rolls, status }),
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.error || "Failed");
                rolls.forEach(rl => { _attExistingRecords[rl] = status; });
                _attLastSaved = Date.now();
                const saved = document.getElementById("attx-saved");
                if (saved) saved.innerHTML = _attSavedLabel();
            } catch (e) {
                _attListStatus = prev;
                _attRenderStudentTable();
                _attRefreshSummary();
                showErrorModal(e.message || "Failed to mark attendance");
            } finally {
                if (btn) btn.disabled = !_attIsEditableDate();
            }
        }

        // kept for backward-compat (legacy bulk bar still references this)
        async function attMarkAllPresent() { _attBulkStatus = "present"; await attMarkAllBulk(); }

        // ── show/hide legacy flat table UI (kept so card views still work) ──
        function _attToggleFlatUI(show) {
            const tableWrap = document.getElementById("att-student-table");
            const searchEl  = document.getElementById("att-search");
            const statsBar  = document.querySelector("#section-attendance .stu-stats-bar");
            const bulkBar   = document.getElementById("att-bulk-bar");
            const loadingEl = document.getElementById("att-loading");
            const emptyEl   = document.getElementById("att-empty");
            // The redesigned list renders its own panel, so the legacy flat
            // table & bulk-bar stay hidden at all times now.
            if (tableWrap && tableWrap.parentElement) tableWrap.parentElement.style.display = "none";
            if (searchEl && searchEl.closest(".stu-toolbar")) searchEl.closest(".stu-toolbar").style.display = "none";
            if (statsBar) statsBar.style.display = "none";
            if (bulkBar) bulkBar.style.display = "none";
            if (loadingEl) loadingEl.style.display = "none";
            if (emptyEl) emptyEl.style.display = "none";
        }

        // ── filter (search within list view) ──────────────────────────────
        function attFilterStudents(query) {
            if (_attView !== "list") return;
            const q         = (query || "").toLowerCase().trim();
            const byClass   = _attGroupByClass();
            const students  = byClass[_attCurrentClass] || [];
            const bySection = _attGroupBySection(students);
            _attFilteredStudents = (bySection[_attCurrentSection] || []).filter(s => {
                if (q && !(s.name||"").toLowerCase().includes(q) && !(s.roll_number||"").toLowerCase().includes(q)) return false;
                return true;
            });
            _attRenderStudentTable();
            _attRefreshSummary();
        }


        // Backward-compat: the legacy hidden bulk-bar button still references
        // attMarkSelected(). That bar is permanently hidden in the redesigned
        // list view, but keep a safe alias so a stray call can't throw.
        function attMarkSelected() { attMarkAllPresent(); }

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
            } catch (e) { showErrorModal(e.message); }
        }

        async function deleteClass(id) {
            if (!confirm("Delete this class and all its batches?")) return;
            try {
                await fetch(`${API_BASE}/api/admin/classes/${id}`, { method: "DELETE", credentials: "include" });
                await renderManageClasses();
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
