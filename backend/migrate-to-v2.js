/**
 * One-off migration: old `questions` table (one row per chapter+lecture,
 * questions_json = array of all questions) → new `questions_v2` table
 * (one row per question, with subject/chapter/topic/year as real columns).
 *
 * USAGE:
 *   cd backend
 *   node migrate-to-v2.js
 *
 * Safe to re-run: it always starts by wiping questions_v2 and rebuilding
 * it from the old `questions` table, so the old table is never modified
 * and you can re-run this as many times as you like while testing.
 *
 * Requires the `questions_v2` table to already exist — i.e. you've started
 * the server at least once after adding the new CREATE TABLE block to
 * config/db.js (see db.js.patch.txt), or run that DDL manually first.
 */

const { db } = require("./config/db");
const { normalizeQuestion } = require("./utils/helpers");

// A question's `chapter` field (per your AI extraction JSON, e.g.
// "Classification of Elements and Periodicity") tells us which subject
// it belongs to via its `unit`/`subject` field already present on each
// extracted question (your sample JSON has "subject":"Chemistry" on every
// question). We trust that field first; if it's missing we fall back to
// the OLD row's chapter-derived guess... but since you said subject was
// never tracked as a column before, in practice every question SHOULD
// already carry its own `subject` from the AI extraction. We log any
// question missing it so you can spot-check after migration.

async function main() {
	console.log("[migrate] Wiping questions_v2 …");
	await db.execute("DELETE FROM questions_v2");

	console.log("[migrate] Reading old `questions` table …");
	const result = await db.execute("SELECT * FROM questions");
	console.log(`[migrate] ${result.rows.length} old rows (chapter+lecture groups) found.`);

	let totalInserted = 0;
	let missingSubject = 0;
	const missingSubjectSamples = [];

	for (const row of result.rows) {
		let parsed = [];
		try {
			parsed = JSON.parse(row.questions_json || "[]");
		} catch (e) {
			console.warn(`[migrate] row id=${row.id} (chapter="${row.chapter}", lecture="${row.lecture}") has corrupted questions_json — skipped.`);
			continue;
		}
		if (!Array.isArray(parsed)) continue;

		const now = Date.now();
		for (let i = 0; i < parsed.length; i++) {
			const raw = parsed[i];
			if (!raw || typeof raw !== "object") continue;

			// Normalize through the SAME function admin.js/extract.js already use,
			// so raw_json ends up in exactly the shape every route expects to read.
			const normalized = normalizeQuestion(raw, { preserveRaw: true });

			const subject = String(raw.subject || normalized.subject || "").trim();
			if (!subject) {
				missingSubject++;
				if (missingSubjectSamples.length < 10) {
					missingSubjectSamples.push({ rowId: row.id, chapter: row.chapter, index: i });
				}
			}

			const chapter = String(row.chapter || raw.chapter || "").trim();
			const topic = String(row.topic || raw.topic || "").trim();
			const unit = String(raw.unit || normalized.unit || "").trim();
			const year = raw.year != null ? String(raw.year).trim() : "";
			const month = raw.month != null ? String(raw.month).trim() : "";
			const day = raw.day != null ? String(raw.day).trim() : "";
			const shift = raw.shift != null ? String(raw.shift).trim() : "";
			const questionNumber = Number.isInteger(raw.questionNumber)
				? raw.questionNumber
				: (Number.isInteger(raw.question_number) ? raw.question_number : null);
			const questionType = String(raw.questionType || raw.question_type || "MCQ").trim() || "MCQ";

			await db.execute({
				sql: `INSERT INTO questions_v2
					(subject, unit, chapter, topic, year, month, day, shift,
					 question_number, question_type, raw_json, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					subject, unit, chapter, topic, year, month, day, shift,
					questionNumber, questionType, JSON.stringify(normalized),
					row.updated_at || now, now,
				],
			});
			totalInserted++;
		}

		if (totalInserted % 5000 < parsed.length) {
			console.log(`[migrate] … ${totalInserted} questions inserted so far`);
		}
	}

	console.log(`[migrate] Done. Inserted ${totalInserted} questions into questions_v2.`);
	if (missingSubject) {
		console.warn(`[migrate] WARNING: ${missingSubject} question(s) had no subject field. Samples:`, missingSubjectSamples);
		console.warn(`[migrate] These rows have subject = '' in questions_v2 — you'll want to backfill them (e.g. via rename-chapter style bulk UPDATE, or by re-tagging via /api/admin/pyq-tag-questions logic) before relying on subject-based search for them.`);
	}

	process.exit(0);
}

main().catch((e) => {
	console.error("[migrate] FATAL:", e);
	process.exit(1);
});
