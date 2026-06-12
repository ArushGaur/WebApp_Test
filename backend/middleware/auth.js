const session = require("express-session");
const { db } = require("../config/db");

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-session-secret-minimum-32-chars";

class TursoSessionStore extends session.Store {
	async get(sid, cb) {
		try {
			const result = await db.execute({ sql: "SELECT data, expires FROM sessions WHERE sid = ?", args: [sid] });
			if (!result.rows.length) return cb(null, null);
			const row = result.rows[0];
			if (Date.now() > row.expires) {
				await db.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
				return cb(null, null);
			}
			cb(null, JSON.parse(row.data));
		} catch (e) {
			cb(e);
		}
	}

	async set(sid, sess, cb) {
		try {
			const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 60 * 60 * 1000;
			await db.execute({
				sql: `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
					  ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
				args: [sid, JSON.stringify(sess), expires],
			});
			cb(null);
		} catch (e) {
			cb(e);
		}
	}

	async destroy(sid, cb) {
		try {
			const dbInstance = require("../config/db").db; // safeguard imports if needed
			await dbInstance.execute({ sql: "DELETE FROM sessions WHERE sid = ?", args: [sid] });
			cb(null);
		} catch (e) {
			cb(e);
		}
	}
}

const sharedSessionStore = new TursoSessionStore();

// ── Client session ────────────────────────────────────────────────────────────
// Cookie `grip.client.sid` — used by institute / teacher / admin logins.
// The owner has a completely separate cookie (`grip.owner.sid`) so the two
// sessions never interfere with each other.
const clientSession = session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	proxy: true,
	name: "grip.client.sid",
	store: sharedSessionStore,
	cookie: {
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		httpOnly: true,
		maxAge: 8 * 60 * 60 * 1000,
		path: "/",
	},
});

// ── Separate owner session ────────────────────────────────────────────────────
// The owner gets its OWN cookie (`grip.owner.sid`) so that owner and client
// sessions are fully isolated. Logging in/out on one page never affects the
// other, even in the same browser.
const ownerSession = session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	proxy: true,
	name: "grip.owner.sid",
	store: sharedSessionStore,
	cookie: {
		secure: process.env.NODE_ENV === "production",
		sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
		httpOnly: true,
		maxAge: 8 * 60 * 60 * 1000,
		path: "/",
	},
});

const rateLimitMap = new Map();
const loginFailMap = new Map();

function rateLimit(windowMs, max) {
	return (req, res, next) => {
		const key = `${req.ip}:${req.path}`;
		const now = Date.now();
		const arr = (rateLimitMap.get(key) || []).filter((t) => t > now - windowMs);
		arr.push(now);
		rateLimitMap.set(key, arr);
		if (arr.length > max) {
			return res.status(429).json({ error: "Too many requests. Try again later." });
		}
		next();
	};
}

function loginRateLimit(req, res, next) {
	const ip = req.ip;
	const now = Date.now();
	const WINDOW = 15 * 60 * 1000;
	const LOCKOUT = 60 * 60 * 1000;
	const MAX = 5;

	const entries = (loginFailMap.get(ip) || []).filter((t) => t > now - LOCKOUT);
	loginFailMap.set(ip, entries);

	const recent = entries.filter((t) => t > now - WINDOW);
	if (recent.length >= MAX) {
		const oldest = recent[0] || now;
		const waitMin = Math.ceil((oldest + LOCKOUT - now) / 60000);
		return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.max(waitMin, 1)} minute(s).` });
	}
	next();
}

function recordLoginFailure(ip) {
	const arr = loginFailMap.get(ip) || [];
	arr.push(Date.now());
	loginFailMap.set(ip, arr);
}

function sessionInstituteId(req) {
	const id = req?.session?.institute_id;
	if (id && Number.isInteger(Number(id))) return Number(id);
	return null;
}

let cachedDefaultInstituteId = null;

function setDefaultInstituteId(id) {
	cachedDefaultInstituteId = id;
}

async function getDefaultInstituteId() {
	if (cachedDefaultInstituteId) return cachedDefaultInstituteId;
	try {
		const r = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: ["DEFAULT"] });
		if (r.rows.length) {
			cachedDefaultInstituteId = r.rows[0].id;
			return cachedDefaultInstituteId;
		}
	} catch (e) {
		console.warn("Failed to fetch default institute ID from DB:", e.message);
	}
	return null;
}

async function resolveStudentInstituteId({ rollNumber, mobile, instituteCode } = {}) {
	if (instituteCode) {
		try {
			const r = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [String(instituteCode).trim().toUpperCase()] });
			if (r.rows.length) return r.rows[0].id;
		} catch (_) { }
	}
	const key = String(rollNumber || mobile || "").trim();
	if (key) {
		try {
			const r = await db.execute({ sql: "SELECT institute_id FROM registered_students WHERE roll_number = ? LIMIT 1", args: [key] });
			if (r.rows.length && r.rows[0].institute_id) return r.rows[0].institute_id;
		} catch (_) { }
	}
	return getDefaultInstituteId();
}

async function getInstituteById(id) {
	if (!id) return null;
	try {
		const r = await db.execute({ sql: "SELECT * FROM institutes WHERE id = ? LIMIT 1", args: [Number(id)] });
		return r.rows[0] || null;
	} catch {
		return null;
	}
}

// ── requireAdmin ──────────────────────────────────────────────────────────────
// Accepts a regular admin/teacher session (req.session.admin === true).
// Owners live on their own cookie (grip.owner.sid) and a separate set of
// /api/owner/* endpoints, so they DO NOT pass through requireAdmin. Any data
// the owner needs (students, chapters, questions, …) should come from the
// matching /api/owner/* endpoint.
function requireAdmin(req, res, next) {
	if (!req.session?.admin) {
		return res.status(403).json({ error: "Unauthorized" });
	}
	next();
}

setInterval(() => {
	const cutoff = Date.now() - 60 * 60 * 1000;
	for (const [k, v] of rateLimitMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) rateLimitMap.delete(k);
		else rateLimitMap.set(k, kept);
	}
	for (const [k, v] of loginFailMap.entries()) {
		const kept = v.filter((t) => t > cutoff);
		if (!kept.length) loginFailMap.delete(k);
		else loginFailMap.set(k, kept);
	}
	db.execute({ sql: "DELETE FROM sessions WHERE expires < ?", args: [Date.now()] }).catch(() => { });
}, 10 * 60 * 1000);

function requireOwner(req, res, next) {
	if (!req.session?.ownerAdmin) return res.status(403).json({ error: "Owner access required" });
	next();
}

module.exports = {
	clientSession,
	ownerSession,
	rateLimit,
	loginRateLimit,
	recordLoginFailure,
	sessionInstituteId,
	setDefaultInstituteId,
	getDefaultInstituteId,
	resolveStudentInstituteId,
	getInstituteById,
	requireAdmin,
	requireOwner,
	rateLimitMap,
	loginFailMap,
};
