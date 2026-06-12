const express = require("express");
const router = express.Router();
const multer = require("multer");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireOwner, loginRateLimit, recordLoginFailure, loginFailMap } = require("../middleware/auth");
const { safeCompare, verifyPasscode, hashPasscode, normalizeStudentRow, normalizeQuestionRow } = helpers;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "dev-admin-passcode-please-change";

// GET  /api/owner/institutes          — list all institutes with student counts
router.get("/api/owner/institutes", requireOwner, async (req, res) => {
	try {
		const rows = await db.execute(`SELECT * FROM institutes ORDER BY created_at DESC`);
		// Attach per-institute student counts
		const results = await Promise.all(rows.rows.map(async (inst) => {
			let studentCount = 0;
			try {
				const sc = await db.execute({ sql: "SELECT COUNT(*) AS cnt FROM registered_students WHERE institute_id = ?", args: [inst.id] });
				studentCount = Number(sc.rows[0]?.cnt || 0);
			} catch (_) { }
			let perms = {};
			try { perms = JSON.parse(inst.permissions_json || "{}"); } catch (_) { }
			return {
				id: inst.id,
				code: inst.code,
				name: inst.name,
				logo_url: inst.logo_url || "",
				permissions: perms,
				plan_expires_at: inst.plan_expires_at,
				status: inst.status,
				created_at: inst.created_at,
				student_count: studentCount,
			};
		}));
		res.json(results);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to list institutes" });
	}
});

// POST /api/owner/institutes          — create a new institute
router.post("/api/owner/institutes", requireOwner, upload.single("logo"), async (req, res) => {
	try {
		const { name, code, passcode, teacherPasscode, permissions, plan_expires_at } = req.body || {};
		if (!name || !code || !passcode) return res.status(400).json({ error: "name, code, and passcode are required" });

		const upperCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
		if (!upperCode) return res.status(400).json({ error: "Invalid institute code" });

		// Check uniqueness
		const exists = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ?", args: [upperCode] });
		if (exists.rows.length) return res.status(409).json({ error: "Institute code already exists" });

		// Upload logo if provided
		let logo_url = "";
		if (req.file) {
			try {
				const b64 = req.file.buffer.toString("base64");
				const dataURI = `data:${req.file.mimetype};base64,${b64}`;
				const uploaded = await cloudinary.uploader.upload(dataURI, {
					folder: "institute_logos",
					public_id: `inst_${upperCode}`,
					overwrite: true,
				});
				logo_url = uploaded.secure_url;
			} catch (e) { console.warn("[institute logo upload]", e.message); }
		}

		let permsObj = { onlineTests: true, starQuiz: true, paperGenerator: true, questionBank: true };
		if (permissions) { try { permsObj = { ...permsObj, ...JSON.parse(permissions) }; } catch (_) { } }

		const expiry = plan_expires_at ? Number(plan_expires_at) : 0;
		const now = Date.now();
		const hash = hashPasscode(passcode);
		const teacherHash = teacherPasscode ? hashPasscode(teacherPasscode) : hash;

		const ins = await db.execute({
			sql: `INSERT INTO institutes (code, name, logo_url, passcode_hash, teacher_passcode_hash, permissions_json, plan_expires_at, status, created_at)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
			args: [upperCode, String(name).trim(), logo_url, hash, teacherHash, JSON.stringify(permsObj), expiry, now],
		});

		res.json({ ok: true, id: Number(ins.lastInsertRowid), code: upperCode, name: String(name).trim(), logo_url });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to create institute" });
	}
});

// PUT /api/owner/institutes/:id       — update an institute (name, logo, permissions, status, expiry, passcode)
router.put("/api/owner/institutes/:id", requireOwner, upload.single("logo"), async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });

		const existing = await db.execute({ sql: "SELECT * FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		const inst = existing.rows[0];

		const { name, passcode, teacherPasscode, permissions, plan_expires_at, status } = req.body || {};

		let logo_url = inst.logo_url || "";
		if (req.file) {
			try {
				const b64 = req.file.buffer.toString("base64");
				const dataURI = `data:${req.file.mimetype};base64,${b64}`;
				const uploaded = await cloudinary.uploader.upload(dataURI, {
					folder: "institute_logos",
					public_id: `inst_${inst.code}`,
					overwrite: true,
				});
				logo_url = uploaded.secure_url;
			} catch (e) { console.warn("[institute logo upload]", e.message); }
		}

		let permsObj = {};
		try { permsObj = JSON.parse(inst.permissions_json || "{}"); } catch (_) { }
		if (permissions) { try { permsObj = { ...permsObj, ...JSON.parse(permissions) }; } catch (_) { } }

		const newName = name ? String(name).trim() : inst.name;
		const newStatus = status || inst.status;
		const newExpiry = plan_expires_at !== undefined ? Number(plan_expires_at) : inst.plan_expires_at;
		const newHash = passcode ? hashPasscode(passcode) : inst.passcode_hash;
		const newTeacherHash = teacherPasscode ? hashPasscode(teacherPasscode) : (inst.teacher_passcode_hash || inst.passcode_hash);

		await db.execute({
			sql: `UPDATE institutes SET name=?, logo_url=?, passcode_hash=?, teacher_passcode_hash=?, permissions_json=?, plan_expires_at=?, status=? WHERE id=?`,
			args: [newName, logo_url, newHash, newTeacherHash, JSON.stringify(permsObj), newExpiry, newStatus, id],
		});

		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to update institute" });
	}
});

// DELETE /api/owner/institutes/:id    — delete an institute (does NOT delete student data; sets status=deleted)
router.delete("/api/owner/institutes/:id", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!id) return res.status(400).json({ error: "Invalid id" });

		const existing = await db.execute({ sql: "SELECT code FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		if (existing.rows[0].code === "DEFAULT") return res.status(400).json({ error: "Cannot delete the Default Institute" });

		// Soft-delete: mark as deleted so student data remains intact
		await db.execute({ sql: "UPDATE institutes SET status = 'deleted' WHERE id = ?", args: [id] });
		res.json({ ok: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to delete institute" });
	}
});

// POST /api/owner/institutes/:id/suspend  — toggle suspend/active
router.post("/api/owner/institutes/:id/suspend", requireOwner, async (req, res) => {
	try {
		const id = Number(req.params.id);
		const existing = await db.execute({ sql: "SELECT status, code FROM institutes WHERE id = ?", args: [id] });
		if (!existing.rows.length) return res.status(404).json({ error: "Institute not found" });
		const { status, code } = existing.rows[0];
		if (code === "DEFAULT") return res.status(400).json({ error: "Cannot suspend the Default Institute" });
		const newStatus = status === "suspended" ? "active" : "suspended";
		await db.execute({ sql: "UPDATE institutes SET status = ? WHERE id = ?", args: [newStatus, id] });
		res.json({ ok: true, status: newStatus });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── Owner login / logout (separate from admin login) ─────────────────────────
// The owner uses the same ADMIN_PASSCODE but gets req.session.ownerAdmin=true
// instead of req.session.admin, so teacher sessions cannot access owner routes.
router.post("/api/owner/login", loginRateLimit, (req, res) => {
	if (!safeCompare(req.body?.passcode || "", ADMIN_PASSCODE)) {
		recordLoginFailure(req.ip);
		return res.status(401).json({ error: "Invalid passcode" });
	}
	loginFailMap.delete(req.ip);
	req.session.regenerate((err) => {
		if (err) return res.status(500).json({ error: "Session error" });
		req.session.ownerAdmin = true;
		req.session.admin = true; // also set admin flag so existing admin routes work for owner
		req.session.loginTime = Date.now();
		req.session.save((saveErr) => {
			if (saveErr) return res.status(500).json({ error: "Session save error" });
			res.json({ ok: true });
		});
	});
});

// ── OWNER logout ──────────────────────────────────────────────────────────────
// Owner has its own cookie (`grip.owner.sid`), completely separate from the
// client session. We can safely destroy it without affecting the client.
router.post("/api/owner/logout", (req, res) => {
	if (req.session) {
		return req.session.destroy(() => res.json({ ok: true }));
	}
	res.json({ ok: true });
});

router.get("/api/owner/me", (req, res) => {
	if (req.session?.ownerAdmin) return res.json({ loggedIn: true });
	res.json({ loggedIn: false });
});

// ══════════════════════════════════════════════════════════════════════════════
// OWNER — PER-INSTITUTE DATA VIEWS
// These mirror the /api/admin/* data endpoints but accept an explicit
// ?instituteId=<id> query param instead of relying on sessionInstituteId().
// This lets the owner dashboard view any institute's data without needing to
// be logged into that institute's client session.
// All routes require requireOwner (ownerAdmin session flag).
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/owner/institutes/:id/students
router.get("/api/owner/institutes/:id/students", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT * FROM students WHERE institute_id = ? ORDER BY time DESC",
			args: [instId],
		});
		res.json(result.rows.map(normalizeStudentRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/registered-students
router.get("/api/owner/institutes/:id/registered-students", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT * FROM registered_students WHERE institute_id = ? ORDER BY created_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			rollNumber: r.roll_number,
			name: r.name || "",
			className: r.class_name || "",
			phone: r.phone || "",
			age: r.age || "",
			dateOfBirth: r.date_of_birth || "",
			profileComplete: !!r.profile_complete,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/online-tests
router.get("/api/owner/institutes/:id/online-tests", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, question_count FROM online_tests WHERE institute_id = ? ORDER BY created_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			testName: r.test_name,
			marksCorrect: r.marks_correct,
			marksWrong: r.marks_wrong,
			liveAt: r.live_at,
			endsAt: r.ends_at,
			questionCount: r.question_count || 0,
			assignedRolls: (() => { try { return JSON.parse(r.assigned_rolls || "[]"); } catch { return []; } })(),
			createdAt: r.created_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/institutes/:id/test-history
router.get("/api/owner/institutes/:id/test-history", requireOwner, async (req, res) => {
	try {
		const instId = Number(req.params.id);
		if (!instId) return res.status(400).json({ error: "Invalid institute id" });
		const result = await db.execute({
			sql: "SELECT * FROM test_history WHERE institute_id = ? ORDER BY timestamp DESC LIMIT 500",
			args: [instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ══════════════════════════════════════════════════════════════════════════════
// OWNER — GLOBAL (cross-institute) DATA VIEWS
// These power the owner dashboard's Applications panel + KPI cards. Unlike the
// /api/admin/* counterparts (which are scoped to a single institute), these
// return data across EVERY institute so the owner has a global picture.
// All routes require requireOwner (ownerAdmin session flag).
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/owner/students  — every student attempt across all institutes
router.get("/api/owner/students", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM students ORDER BY time DESC");
		const rows = result.rows.map(r => {
			const n = (typeof normalizeStudentRow === "function") ? normalizeStudentRow(r) : r;
			// Attach institute_id so the UI can group/filter by institute if desired.
			if (n && r.institute_id != null) n.institute_id = r.institute_id;
			return n;
		}).filter(Boolean);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to list students" });
	}
});

// GET /api/owner/registered-students  — every registered student across all institutes
router.get("/api/owner/registered-students", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM registered_students ORDER BY created_at DESC");
		res.json(result.rows.map(r => ({
			id: r.id,
			rollNumber: r.roll_number,
			name: r.name || "",
			className: r.class_name || "",
			phone: r.phone || "",
			age: r.age || "",
			dateOfBirth: r.date_of_birth || "",
			profileComplete: !!r.profile_complete,
			instituteId: r.institute_id,
			createdAt: r.created_at,
			updatedAt: r.updated_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/chapters  — every distinct chapter across all institutes (questions table is global)
router.get("/api/owner/chapters", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ''");
		const chapters = result.rows.map(r => r.chapter).filter(Boolean).sort();
		res.json(chapters);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/questions  — every question (questions table is global, no institute scoping needed)
router.get("/api/owner/questions", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		const rows = result.rows.map(r => (typeof normalizeQuestionRow === "function") ? normalizeQuestionRow(r) : r).filter(Boolean);
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET /api/owner/student-requests  — every pending student-account request across all institutes
router.get("/api/owner/student-requests", requireOwner, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM student_requests WHERE COALESCE(status, 'pending') = 'pending' ORDER BY created_at DESC");
		res.json(result.rows);
	} catch (e) {
		// Table may not exist on older deployments — degrade gracefully so the
		// owner dashboard's badge query never breaks the UI.
		res.json([]);
	}
});

module.exports = router;