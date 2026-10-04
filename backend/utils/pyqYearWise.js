const { db } = require("../config/db");

/**
 * ─────────────────────────────────────────────────────────────────────────
 * pyq_year_wise — SUBJECT + YEAR denormalized PYQ index
 *
 * `pyq_questions` is organised for CHAPTER/TOPIC browsing (its hot index is
 * (chapter, topic)). Paper-wise search asks a completely different question:
 * "give me every question of <exam> <year>", optionally narrowed by subject or
 * question type. Answering that from the chapter-wise table means scanning and
 * JSON-parsing rows that the paper view then throws away.
 *
 * `pyq_year_wise` stores the SAME questions keyed by (subject, year) — plus a
 * derived `exam` column — with question_type promoted to a real indexed column
 * so the paper-wise filters are pure index lookups and never parse a blob just
 * to count.
 *
 * It is a derived table: `pyq_questions` remains the source of truth. Every
 * write that touches a PYQ row mirrors into here (see utils/questionTables.js),
 * and `rebuildYearWise()` can regenerate it from scratch at any time.
 *
 * All mirror calls are best-effort: a failure here must never break the write
 * to the real question bank.
 * ─────────────────────────────────────────────────────────────────────────
 */

const YEAR_TABLE = "pyq_year_wise";
const PAPER_EXAMS = ["JEE Mains", "JEE Advanced", "NEET"];

// Exact match only — returns null when the string names no known exam, so
// callers can tell "unknown" apart from "defaulted".
function normalizeExamStrict(e) {
	const s = String(e || "").trim().toLowerCase();
	if (!s) return null;
	if (s.includes("advanced") || s === "jee_advanced" || s === "jeeadv") return "JEE Advanced";
	if (s.includes("neet")) return "NEET";
	if (s.includes("jee") || s.includes("main")) return "JEE Mains";
	return null;
}

// Where a question goes when nothing identifies its exam. Overridable so a
// NEET-first workspace can flip the default without a code change.
const DEFAULT_EXAM = normalizeExamStrict(process.env.DEFAULT_PYQ_EXAM) || "JEE Mains";

// Normalize any incoming exam string to one of PAPER_EXAMS.
function normalizeExam(e) {
	return normalizeExamStrict(e) || DEFAULT_EXAM;
}

// Biology is NEET-only; every other subject is shared between JEE and NEET,
// so the subject alone cannot identify the exam. The old rule here mapped
// "not Maths" → NEET, which filed every JEE Physics/Chemistry question under
// NEET. Now only a real signal decides, and anything unknown falls back to
// DEFAULT_EXAM instead of being guessed from the subject.
function examForSubject(subject, examHint) {
	const hinted = normalizeExamStrict(examHint);
	if (hinted) return hinted;
	const s = String(subject || "").trim().toLowerCase();
	if (s === "biology" || s === "botany" || s === "zoology") return "NEET";
	return DEFAULT_EXAM;
}

function str(v) {
	return v == null ? "" : String(v).trim();
}

// Pull the exam hint + question type out of a stored raw_json blob.
function readRaw(rawJson) {
	let q = {};
	try { q = JSON.parse(rawJson || "{}") || {}; } catch { q = {}; }
	return q;
}

function typeOf(row, raw) {
	const t = row.question_type || raw.question_type || raw.questionType || "MCQ";
	return String(t).trim().toUpperCase() || "MCQ";
}

function paperKey(exam, year, month, day, shift, questionType) {
	return [normalizeExam(exam), str(year), str(month), str(day), str(shift), String(questionType || "MCQ").toUpperCase()].join("|||");
}

function rawWithId(row) {
	const raw = readRaw(row.raw_json);
	return { ...raw, _pyq_id: row.id };
}

async function readSourceRows() {
	const result = await db.execute(`SELECT id, subject, year, month, day, shift, question_number, question_type, raw_json, created_at, updated_at FROM pyq_questions WHERE year IS NOT NULL AND year != ''`);
	return result.rows;
}

function groupSourceRows(rows) {
	const groups = new Map();
	for (const row of rows) {
		const raw = readRaw(row.raw_json);
		const exam = examForSubject(row.subject, row.exam || raw._exam || raw.exam || raw.examName || raw.exam_name || "");
		const questionType = typeOf(row, raw);
		const key = paperKey(exam, row.year, row.month, row.day, row.shift, questionType);
		if (!groups.has(key)) groups.set(key, { exam, year: str(row.year), month: str(row.month), day: str(row.day), shift: str(row.shift), questionType, rows: [] });
		groups.get(key).rows.push(row);
	}
	return groups;
}

function expandIndexRows(rows, { questionType, subject } = {}) {
	const out = [];
	for (const row of rows) {
		let questions = [];
		try { questions = JSON.parse(row.raw_json || "[]"); } catch { questions = []; }
		if (!Array.isArray(questions)) continue;
		for (const raw of questions) {
			const q = raw && typeof raw === "object" ? raw : {};
			if (questionType && typeOf({}, q) !== String(questionType).trim().toUpperCase()) continue;
			if (subject && str(q.subject) !== str(subject)) continue;
			out.push({
				pyq_id: q._pyq_id,
				subject: str(q.subject), year: row.year, exam: row.exam,
				month: row.month, day: row.day, shift: row.shift,
				question_number: q.question_number ?? q.questionNumber ?? null,
				question_type: row.question_type,
				chapter: str(q.chapter), topic: str(q.topic), raw_json: JSON.stringify(q),
			});
		}
	}
	return out;
}

/**
 * Make sure a `papers` registry row exists for (exam, year) and return its id.
 * The papers table keeps owning the stable numeric ids the panels navigate by;
 * only the QUESTIONS moved into pyq_year_wise.
 */
async function ensurePaperRow(exam, year) {
	const ex = normalizeExam(exam);
	const yr = str(year) || "Regular";
	const existing = await db.execute({
		sql: "SELECT id FROM papers WHERE exam = ? AND year = ? LIMIT 1",
		args: [ex, yr],
	});
	if (existing.rows.length) return existing.rows[0].id;
	const now = Date.now();
	await db.execute({
		sql: "INSERT INTO papers (exam, year, label, questions_json, question_count, created_at, updated_at) VALUES (?, ?, ?, '[]', 0, ?, ?)",
		args: [ex, yr, `${ex} ${yr}`, now, now],
	});
	const created = await db.execute({
		sql: "SELECT id FROM papers WHERE exam = ? AND year = ? LIMIT 1",
		args: [ex, yr],
	});
	return created.rows.length ? created.rows[0].id : null;
}

async function syncPaperQuestions(exam, year) {
	const ex = normalizeExam(exam);
	const yr = str(year);
	if (!yr) return;
	const sourceRows = (await readSourceRows()).filter((row) => {
		const raw = readRaw(row.raw_json);
		return str(row.year) === yr && examForSubject(row.subject, raw._exam || raw.exam || raw.examName || raw.exam_name || "") === ex;
	});
	sourceRows.sort((a, b) => (String(a.subject || '').localeCompare(String(b.subject || ''))) || (Number(a.question_number) || Number.MAX_SAFE_INTEGER) - (Number(b.question_number) || Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id));
	const questions = sourceRows.map(rawWithId);
	await ensurePaperRow(ex, yr);
	await db.execute({
		sql: "UPDATE papers SET questions_json = ?, question_count = ?, updated_at = ? WHERE exam = ? AND year = ?",
		args: [JSON.stringify(questions), questions.length, Date.now(), ex, yr],
	});
}

/**
 * Mirror ONE pyq_questions row into pyq_year_wise (insert or replace).
 * `row` is the normalized shape used by questionTables.insertQuestion.
 * Rows without a year are ignored — they aren't PYQ.
 */
async function syncPyqRow(id, row = {}) {
	const year = str(row.year);
	if (!year || id == null) return;
	await rebuildYearWise();
}

/** Drop one question from the index (by its pyq_questions id). */
async function removePyqRow(id) {
	if (id == null) return 0;
	await rebuildYearWise();
	return 1;
}

/**
 * Apply the same WHERE clause used against the question tables.
 * Safe for chapter/topic/subject-scoped deletes — those columns all exist here.
 */
async function removeWhere(whereSql, args = []) {
	await rebuildYearWise();
	return 0;
}

/** Apply the same SET/WHERE used for chapter/topic renames. */
async function updateWhere(setSql, setArgs = [], whereSql = "TRUE", whereArgs = []) {
	await rebuildYearWise();
	return 0;
}

/**
 * Regenerate the whole index from `pyq_questions`, then make sure a papers
 * registry row exists for every (exam, year) found and for the three rolling
 * "Regular" buckets. Idempotent — safe to run on every boot.
 */
async function rebuildYearWise() {
	const sourceRows = await readSourceRows();
	await db.execute(`DELETE FROM ${YEAR_TABLE}`);

	const groups = groupSourceRows(sourceRows);
	const pairs = new Set();
	let inserted = 0;
	for (const group of groups.values()) {
		const questions = [...group.rows].sort((a, b) => (Number(a.question_number) || Number.MAX_SAFE_INTEGER) - (Number(b.question_number) || Number.MAX_SAFE_INTEGER) || Number(a.id) - Number(b.id)).map(rawWithId);
		const now = Date.now();
		await db.execute({
			sql: `INSERT INTO ${YEAR_TABLE}
				(exam, year, month, day, shift, question_type, question_count, raw_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [group.exam, group.year, group.month, group.day, group.shift, group.questionType, questions.length, JSON.stringify(questions), now, now],
		});
		pairs.add(`${group.exam}|||${group.year}`);
		inserted += questions.length;
	}

	for (const key of pairs) {
		const [exam, year] = key.split("|||");
		await ensurePaperRow(exam, year);
		await syncPaperQuestions(exam, year);
	}
	for (const ex of PAPER_EXAMS) await ensurePaperRow(ex, "Regular");

	// Drop registry rows for papers that no longer have any questions.
	await db.execute(
		`DELETE FROM papers WHERE year != 'Regular'
		   AND NOT EXISTS (SELECT 1 FROM ${YEAR_TABLE} y WHERE y.exam = papers.exam AND y.year = papers.year)`
	);

	return { papers: pairs.size, questions: inserted };
}

/**
 * Per-(exam, year) counts straight off the index — one grouped index scan,
 * no JSON parsing. `question_type` and `subject` narrow it without changing
 * the access path.
 */
async function paperCounts({ exam, question_type, subject } = {}) {
	const where = [];
	const args = [];
	if (exam) { where.push("exam = ?"); args.push(normalizeExam(exam)); }
	if (question_type) { where.push("upper(question_type) = ?"); args.push(String(question_type).trim().toUpperCase()); }
	const result = await db.execute({
		sql: `SELECT exam, year, SUM(question_count) AS count FROM ${YEAR_TABLE}
		      ${where.length ? "WHERE " + where.join(" AND ") : ""}
		      GROUP BY exam, year`,
		args,
	});
	const map = new Map();
	if (subject) {
		const expanded = expandIndexRows(result.rows, { subject });
		for (const q of expanded) map.set(`${q.exam}|||${q.year}`, (map.get(`${q.exam}|||${q.year}`) || 0) + 1);
	} else {
		for (const r of result.rows) map.set(`${r.exam}|||${r.year}`, Number(r.count) || 0);
	}
	return map;
}

/**
 * Every question of one paper (exam + year), ordered the way a real paper
 * reads: subject, then question number. Hits idx_pyq_yw_exam_year directly.
 */
async function paperQuestions({ exam, year, question_type, subject } = {}) {
	const where = ["exam = ?", "year = ?"];
	const args = [normalizeExam(exam), str(year)];
	if (question_type) { where.push("upper(question_type) = ?"); args.push(String(question_type).trim().toUpperCase()); }
	const result = await db.execute({ sql: `SELECT exam, year, month, day, shift, question_type, raw_json FROM ${YEAR_TABLE} WHERE ${where.join(" AND ")}`, args });
	return expandIndexRows(result.rows, { questionType: question_type, subject });
}

/** Distinct subjects present for a paper — powers the subject chips. */
async function paperSubjects({ exam, year } = {}) {
	const result = await db.execute({ sql: `SELECT exam, year, raw_json FROM ${YEAR_TABLE} WHERE exam = ? AND year = ?`, args: [normalizeExam(exam), str(year)] });
	const counts = new Map();
	for (const q of expandIndexRows(result.rows)) counts.set(q.subject, (counts.get(q.subject) || 0) + 1);
	return [...counts.entries()].filter(([subject]) => subject).sort((a, b) => a[0].localeCompare(b[0])).map(([subject, count]) => ({ subject, count }));
}

// ── Composite-key helpers (paper → month/day/shift drill-down) ──────────

/** Delimiter used to encode (exam, year, month, day, shift) into one string. */
const COMPOSITE_SEP = "||";

function compositeKey(exam, year, month, day, shift) {
	return [exam, year, month, day, shift].join(COMPOSITE_SEP);
}

function parseCompositeKey(key) {
	const parts = String(key || "").split(COMPOSITE_SEP);
	return {
		exam: parts[0] || "",
		year: parts[1] || "",
		month: parts[2] || "",
		day: parts[3] || "",
		shift: parts[4] || "",
	};
}

/**
 * Fine-grained paper group counts: one row per (exam, year, month, day, shift).
 * Cards from the paper-wise view show every JEE shift on every date separately
 * instead of one card per year.
 */
async function paperGroupCounts({ exam, question_type } = {}) {
	const where = [];
	const args = [];
	if (exam) { where.push("exam = ?"); args.push(normalizeExam(exam)); }
	if (question_type) { where.push("upper(question_type) = ?"); args.push(String(question_type).trim().toUpperCase()); }
	const result = await db.execute({
		sql: `SELECT exam, year, month, day, shift, SUM(question_count) AS count FROM ${YEAR_TABLE}
		      ${where.length ? "WHERE " + where.join(" AND ") : ""}
		      GROUP BY exam, year, month, day, shift
		      ORDER BY exam, year DESC NULLS LAST, month DESC NULLS LAST, day DESC NULLS LAST, shift NULLS LAST`,
		args,
	});
	return result.rows.map((r) => ({
		exam: r.exam,
		year: r.year,
		month: str(r.month),
		day: str(r.day),
		shift: str(r.shift),
		count: Number(r.count) || 0,
		id: compositeKey(r.exam, r.year, str(r.month), str(r.day), str(r.shift)),
		label: [r.year, str(r.month), str(r.day), str(r.shift)].filter(Boolean).join(" · "),
	}));
}

/**
 * Every question for a fine-grained paper group (exam + year + month + day + shift).
 * month/day/shift may be empty strings for papers that don't carry that metadata.
 */
async function paperGroupQuestions({ exam, year, month, day, shift, question_type, subject } = {}) {
	const where = ["exam = ?", "year = ?"];
	const args = [normalizeExam(exam), str(year)];
	if (month !== undefined && month !== null) { where.push("month = ?"); args.push(str(month)); }
	if (day !== undefined && day !== null) { where.push("day = ?"); args.push(str(day)); }
	if (shift !== undefined && shift !== null) { where.push("shift = ?"); args.push(str(shift)); }
	if (question_type) { where.push("upper(question_type) = ?"); args.push(String(question_type).trim().toUpperCase()); }
	if (subject) { where.push("subject = ?"); args.push(String(subject).trim()); }
	const result = await db.execute({ sql: `SELECT exam, year, month, day, shift, question_type, raw_json FROM ${YEAR_TABLE} WHERE ${where.join(" AND ")}`, args });
	return expandIndexRows(result.rows, { questionType: question_type, subject });
}

/** Subjects present in a fine-grained paper group. */
async function paperGroupSubjects({ exam, year, month, day, shift } = {}) {
	const where = ["exam = ?", "year = ?"];
	const args = [normalizeExam(exam), str(year)];
	if (month !== undefined && month !== null) { where.push("month = ?"); args.push(str(month)); }
	if (day !== undefined && day !== null) { where.push("day = ?"); args.push(str(day)); }
	if (shift !== undefined && shift !== null) { where.push("shift = ?"); args.push(str(shift)); }
	const result = await db.execute({ sql: `SELECT exam, year, month, day, shift, raw_json FROM ${YEAR_TABLE} WHERE ${where.join(" AND ")}`, args });
	const counts = new Map();
	for (const q of expandIndexRows(result.rows)) counts.set(q.subject, (counts.get(q.subject) || 0) + 1);
	return [...counts.entries()].filter(([subject]) => subject).sort((a, b) => a[0].localeCompare(b[0])).map(([subject, count]) => ({ subject, count }));
}

/** True when the index has no rows (used to auto-rebuild on boot). */
async function isEmpty() {
	const r = await db.execute(`SELECT COUNT(*) AS c FROM ${YEAR_TABLE}`);
	return (Number(r.rows[0]?.c) || 0) === 0;
}

module.exports = {
	YEAR_TABLE,
	PAPER_EXAMS,
	normalizeExam,
	examForSubject,
	compositeKey,
	parseCompositeKey,
	ensurePaperRow,
	syncPyqRow,
	removePyqRow,
	removeWhere,
	updateWhere,
	rebuildYearWise,
	paperCounts,
	paperQuestions,
	paperSubjects,
	paperGroupCounts,
	paperGroupQuestions,
	paperGroupSubjects,
	isEmpty,
};
