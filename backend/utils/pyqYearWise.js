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

// Normalize any incoming exam string to one of PAPER_EXAMS.
function normalizeExam(e) {
	const s = String(e || "").trim().toLowerCase();
	if (s.includes("advanced") || s === "jee_advanced") return "JEE Advanced";
	if (s.includes("neet")) return "NEET";
	if (s.includes("jee") || s.includes("main")) return "JEE Mains";
	return "NEET";
}

// PYQ data mapping: Maths → JEE Mains, all other subjects → NEET.
// An explicit exam tag on the question (raw_json.exam) always wins.
function examForSubject(subject, examHint) {
	if (examHint) return normalizeExam(examHint);
	const s = String(subject || "").trim().toLowerCase();
	if (s === "maths" || s === "math" || s === "mathematics") return "JEE Mains";
	return "NEET";
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

/**
 * Mirror ONE pyq_questions row into pyq_year_wise (insert or replace).
 * `row` is the normalized shape used by questionTables.insertQuestion.
 * Rows without a year are ignored — they aren't PYQ.
 */
async function syncPyqRow(id, row = {}) {
	const year = str(row.year);
	if (!year || id == null) return;
	const raw = readRaw(row.raw_json);
	const subject = str(row.subject);
	const exam = examForSubject(subject, raw.exam || raw.examName || raw.exam_name || "");
	const now = Date.now();

	// Replace-on-write: one row per pyq_questions.id, so re-saving a question
	// can never leave a stale duplicate behind in the index.
	await db.execute({ sql: `DELETE FROM ${YEAR_TABLE} WHERE pyq_id = ?`, args: [id] });
	await db.execute({
		sql: `INSERT INTO ${YEAR_TABLE}
			(pyq_id, subject, year, exam, month, day, shift, question_number,
			 question_type, chapter, topic, raw_json, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			id, subject, year, exam,
			str(row.month), str(row.day), str(row.shift),
			Number.isInteger(row.question_number) ? row.question_number : null,
			typeOf(row, raw), str(row.chapter), str(row.topic),
			row.raw_json || "{}",
			Number(row.created_at) || now, Number(row.updated_at) || now,
		],
	});
	await ensurePaperRow(exam, year);
}

/** Drop one question from the index (by its pyq_questions id). */
async function removePyqRow(id) {
	if (id == null) return 0;
	const res = await db.execute({ sql: `DELETE FROM ${YEAR_TABLE} WHERE pyq_id = ?`, args: [id] });
	return res.rowsAffected || 0;
}

/**
 * Apply the same WHERE clause used against the question tables.
 * Safe for chapter/topic/subject-scoped deletes — those columns all exist here.
 */
async function removeWhere(whereSql, args = []) {
	const res = await db.execute({
		sql: `DELETE FROM ${YEAR_TABLE} WHERE ${whereSql}`,
		args: [...args],
	});
	return res.rowsAffected || 0;
}

/** Apply the same SET/WHERE used for chapter/topic renames. */
async function updateWhere(setSql, setArgs = [], whereSql = "TRUE", whereArgs = []) {
	const res = await db.execute({
		sql: `UPDATE ${YEAR_TABLE} SET ${setSql} WHERE ${whereSql}`,
		args: [...setArgs, ...whereArgs],
	});
	return res.rowsAffected || 0;
}

/**
 * Regenerate the whole index from `pyq_questions`, then make sure a papers
 * registry row exists for every (exam, year) found and for the three rolling
 * "Regular" buckets. Idempotent — safe to run on every boot.
 */
async function rebuildYearWise() {
	const result = await db.execute(
		`SELECT id, subject, unit, chapter, topic, year, month, day, shift,
		        question_number, question_type, raw_json, created_at, updated_at
		   FROM pyq_questions
		  WHERE year IS NOT NULL AND year != ''`
	);

	await db.execute(`DELETE FROM ${YEAR_TABLE}`);

	const pairs = new Set();
	let inserted = 0;
	for (const row of result.rows) {
		const year = str(row.year);
		if (!year) continue;
		const raw = readRaw(row.raw_json);
		const subject = str(row.subject);
		const exam = examForSubject(subject, raw.exam || raw.examName || raw.exam_name || "");
		await db.execute({
			sql: `INSERT INTO ${YEAR_TABLE}
				(pyq_id, subject, year, exam, month, day, shift, question_number,
				 question_type, chapter, topic, raw_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				row.id, subject, year, exam,
				str(row.month), str(row.day), str(row.shift),
				Number.isInteger(row.question_number) ? row.question_number : null,
				typeOf(row, raw), str(row.chapter), str(row.topic),
				row.raw_json || "{}",
				Number(row.created_at) || 0, Number(row.updated_at) || 0,
			],
		});
		pairs.add(`${exam}|||${year}`);
		inserted++;
	}

	for (const key of pairs) {
		const [exam, year] = key.split("|||");
		await ensurePaperRow(exam, year);
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
	if (subject) { where.push("subject = ?"); args.push(String(subject).trim()); }
	const result = await db.execute({
		sql: `SELECT exam, year, COUNT(*) AS count FROM ${YEAR_TABLE}
		      ${where.length ? "WHERE " + where.join(" AND ") : ""}
		      GROUP BY exam, year`,
		args,
	});
	const map = new Map();
	for (const r of result.rows) map.set(`${r.exam}|||${r.year}`, Number(r.count) || 0);
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
	if (subject) { where.push("subject = ?"); args.push(String(subject).trim()); }
	const result = await db.execute({
		sql: `SELECT pyq_id, subject, year, exam, month, day, shift, question_number,
		             question_type, chapter, topic, raw_json
		        FROM ${YEAR_TABLE}
		       WHERE ${where.join(" AND ")}
		       ORDER BY subject, question_number NULLS LAST, pyq_id`,
		args,
	});
	return result.rows;
}

/** Distinct subjects present for a paper — powers the subject chips. */
async function paperSubjects({ exam, year } = {}) {
	const result = await db.execute({
		sql: `SELECT subject, COUNT(*) AS count FROM ${YEAR_TABLE}
		      WHERE exam = ? AND year = ? AND subject != ''
		      GROUP BY subject ORDER BY subject`,
		args: [normalizeExam(exam), str(year)],
	});
	return result.rows.map((r) => ({ subject: r.subject, count: Number(r.count) || 0 }));
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
	ensurePaperRow,
	syncPyqRow,
	removePyqRow,
	removeWhere,
	updateWhere,
	rebuildYearWise,
	paperCounts,
	paperQuestions,
	paperSubjects,
	isEmpty,
};
