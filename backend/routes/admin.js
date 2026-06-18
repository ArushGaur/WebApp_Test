const express = require("express");
const router = express.Router();
const multer = require("multer");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireAdmin, sessionInstituteId, getDefaultInstituteId } = require("../middleware/auth");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion, getQuestionCache } = require("../utils/questions");
const { normalizeQuestionRow, normalizeQuestion, normalizeStudentRow, parseCorrectIndexesFromQuestion, validateImageRegion } = helpers;
const { uploadQuestionImages } = require("../services/cloudinary");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

function extractYearFromQuestions(questions) {
	for (const q of (questions || [])) {
		const y = q?.year ? String(q.year).trim() : null;
		if (y) return y;
	}
	return null;
}

router.get("/api/chapters", async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM questions WHERE chapter IS NOT NULL AND chapter != ''");
		const chapters = result.rows.map((r) => r.chapter).filter(Boolean).sort();
		res.json(chapters);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/lectures/:chapter", async (req, res) => {
	try {
		const chapter = req.params.chapter;
		const result = await db.execute({ sql: "SELECT lecture FROM questions WHERE chapter = ?", args: [chapter] });
		const lectures = result.rows.map((r) => r.lecture).filter(Boolean).sort((a, b) => Number(a) - Number(b));
		res.json(lectures);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/question/:chapter/:lecture", async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const chapter = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const q = await findQuestion(chapter, lecture);
		if (!q) return res.status(404).json({ error: "Lecture not found" });
		res.json(q);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.post("/api/admin/add-question", requireAdmin, async (req, res) => {
	try {
		let { chapter, lecture, topic, questions, replace } = req.body || {};
		if (!lecture || !Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "Missing" });
		}

		questions = questions.map(normalizeQuestion);
		questions = await uploadQuestionImages(questions);

		let existing;
		if (chapter) {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
			existing = r.rows[0] || null;
		} else {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
			existing = r.rows[0] || null;
		}

		if (existing) {
			const oldQs = replace ? [] : (() => {
				try { return JSON.parse(existing.questions_json || "[]"); } catch { return []; }
			})();
			const merged = [...oldQs, ...questions];
			await db.execute({
				sql: "UPDATE questions SET questions_json = ?, topic = ?, updated_at = ? WHERE id = ?",
				args: [JSON.stringify(merged), topic || existing.topic || "", Date.now(), existing.id],
			});
			await rebuildYearIndex(existing.id, merged);
			await refreshCache(chapter || null, lecture);
			return res.json({ success: true, added: questions.length, total: merged.length });
		}

		const insertResult = await db.execute({
			sql: "INSERT INTO questions (chapter, lecture, topic, questions_json, updated_at) VALUES (?, ?, ?, ?, ?)",
			args: [chapter || null, lecture || "", topic || "", JSON.stringify(questions), Date.now()],
		});
		const newId = insertResult.lastInsertRowid ? Number(insertResult.lastInsertRowid) : null;
		if (newId) await rebuildYearIndex(newId, questions);
		await refreshCache(chapter || null, lecture);
		res.json({ success: true, added: questions.length, total: questions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/admin/students", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM students WHERE institute_id = ? ORDER BY time DESC",
			args: [instId],
		});
		res.json(result.rows.map(normalizeStudentRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Mark all answers as incorrect for a student flagged for cheating
router.post("/api/admin/student/:id/mark-cheater", requireAdmin, async (req, res) => {
	try {
		const id = req.params.id;
		if (!id) return res.status(400).json({ error: "Student ID required." });

		// Fetch the student row — scoped to this institute so an institute can't
		// modify another institute's student records.
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({ sql: "SELECT * FROM students WHERE id = ? AND institute_id = ?", args: [id, instId] });
		const row = result.rows[0];
		if (!row) return res.status(404).json({ error: "Student not found." });

		// Parse answers and set all to an invalid value so none match correct answers
		let answers = [];
		try { answers = JSON.parse(row.answers_json || "[]"); } catch { answers = []; }
		// Replace every answer with -1 (guaranteed wrong for any question)
		const nullifiedAnswers = answers.map(() => -1);

		await db.execute({
			sql: "UPDATE students SET correct_count = 0, answers_json = ?, cheat_flag = 1 WHERE id = ? AND institute_id = ?",
			args: [JSON.stringify(nullifiedAnswers), id, instId],
		});

		res.json({ success: true, message: "All answers marked as incorrect and cheating flag set." });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/admin/questions", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		res.json(result.rows.map(normalizeQuestionRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Lightweight metadata-only endpoint — no questions_json, fast for 20k questions
router.get("/api/admin/questions-meta", requireAdmin, async (req, res) => {
	try {
		// Get all row metadata + question count from the year index
		// For rows with no years, count is 0 from index but actual may be higher.
		// We use a separate fast count query using JSON array length.
		const result = await db.execute(
			`SELECT q.id, q.chapter, q.lecture, q.topic, q.updated_at,
		        json_extract(q.questions_json, '$[0].subject') AS subject,
			        COUNT(qy.id) AS indexed_count
			 FROM questions q
			 LEFT JOIN question_years qy ON qy.row_id = q.id
			 GROUP BY q.id
			 ORDER BY q.chapter, CAST(q.lecture AS REAL)`
		);

		// Also get actual question counts via a fast trick:
		// json_array_length is available in SQLite/Turso
		const countResult = await db.execute(
			"SELECT id, json_array_length(questions_json) AS qcount FROM questions"
		);
		const countMap = {};
		for (const r of countResult.rows) countMap[r.id] = Number(r.qcount) || 0;

		const rows = result.rows.map(row => ({
			_id: row.id,
			chapter: row.chapter || null,
			lecture: row.lecture,
			topic: row.topic || "",
			subject: row.subject || null,
			updatedAt: row.updated_at || 0,
			questionCount: countMap[row.id] ?? Number(row.indexed_count) ?? 0,
			questions: null,     // not loaded — signals lazy-loadable
			_metaOnly: true,
		}));
		res.json(rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Fetch a single question row by id — used for on-demand loading
router.get("/api/admin/question-row/:id", requireAdmin, async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
		const result = await db.execute({ sql: "SELECT * FROM questions WHERE id = ? LIMIT 1", args: [id] });
		if (!result.rows.length) return res.status(404).json({ error: "Not found" });
		res.json(normalizeQuestionRow(result.rows[0]));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Fetch all rows for a chapter — used when user opens a chapter (lazy load)
router.get("/api/admin/questions-for-chapter/:chapter", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		let result;
		if (chapter === "_none_" || chapter === "") {
			result = await db.execute("SELECT * FROM questions WHERE chapter IS NULL OR chapter = ''");
		} else {
			result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ?", args: [chapter] });
		}
		res.json(result.rows.map(normalizeQuestionRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const rawLecture = decodeURIComponent(req.params.lecture || "");
		const lecture = rawLecture === "_none_" ? "" : rawLecture;
		// Fetch the row id before deleting so we can clean question_years
		let toDelete;
		if (chapter && chapter !== "_none_") {
			toDelete = await db.execute({ sql: "SELECT id FROM questions WHERE lecture = ? AND chapter = ?", args: [lecture, chapter] });
		} else {
			toDelete = await db.execute({ sql: "SELECT id FROM questions WHERE lecture = ? AND (chapter IS NULL OR chapter = '')", args: [lecture] });
		}
		for (const r of toDelete.rows) {
			await db.execute({ sql: "DELETE FROM question_years WHERE row_id = ?", args: [r.id] });
		}
		// Fix: use precise chapter match to avoid deleting from unrelated chapters
		if (chapter && chapter !== "_none_") {
			await db.execute({
				sql: "DELETE FROM questions WHERE lecture = ? AND chapter = ?",
				args: [lecture, chapter],
			});
		} else {
			await db.execute({
				sql: "DELETE FROM questions WHERE lecture = ? AND (chapter IS NULL OR chapter = '')",
				args: [lecture],
			});
		}
		delete getQuestionCache()[`${chapter === "_none_" ? "" : chapter}::${lecture}`];
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.put("/api/admin/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const rawLecture = decodeURIComponent(req.params.lecture || "");
		const lecture = rawLecture === "_none_" ? "" : rawLecture;
		const { chapter, topic, questions } = req.body || {};

		if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions array is required." });

		const chapterForMatch = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const chapterForSave = (chapter === "_none_" || chapter === "") ? null : (chapter ?? chapterForMatch);

		let existing;
		if (chapterForMatch) {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapterForMatch, lecture] });
			existing = r.rows[0] || null;
		} else {
			const r = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
			existing = r.rows[0] || null;
		}

		if (!existing) return res.status(404).json({ error: "Lecture not found." });

		// Manual edit: preserve raw text so removing $ delimiters is honoured.
		let normalizedQuestions = questions.map((q) => normalizeQuestion(q, { preserveRaw: true }));
		normalizedQuestions = await uploadQuestionImages(normalizedQuestions);
		await db.execute({
			sql: "UPDATE questions SET chapter = ?, topic = ?, questions_json = ?, updated_at = ? WHERE id = ?",
			args: [chapterForSave, topic || existing.topic || "", JSON.stringify(normalizedQuestions), Date.now(), existing.id],
		});

		await rebuildYearIndex(existing.id, normalizedQuestions);
		await refreshCache(chapterForSave, lecture);
		res.json({ success: true, updated: normalizedQuestions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/mass-delete", requireAdmin, async (req, res) => {
	try {
		const items = Array.isArray(req.body?.items) ? req.body.items : [];
		console.log("[admin] mass-delete request - items:", items.length, JSON.stringify(items).slice(0, 2000));
		if (!items.length) return res.status(400).json({ error: "No items" });
		let deleted = 0;
		for (const it of items) {
			const chapter = it?.chapter || null;
			const lecture = it?.lecture;
			if (lecture == null) continue;
			// Clean year index before deleting rows
			let toDelete;
			if (chapter) {
				toDelete = await db.execute({ sql: "SELECT id FROM questions WHERE lecture = ? AND chapter = ?", args: [lecture, chapter] });
			} else {
				toDelete = await db.execute({ sql: "SELECT id FROM questions WHERE lecture = ? AND (chapter IS NULL OR chapter = '')", args: [lecture] });
			}
			for (const r of toDelete.rows) {
				await db.execute({ sql: "DELETE FROM question_years WHERE row_id = ?", args: [r.id] });
			}
			// Use separate query paths — SQL NULL = NULL is always false, so chapter = ? with null never matches
			if (chapter) {
				await db.execute({
					sql: "DELETE FROM questions WHERE lecture = ? AND chapter = ?",
					args: [lecture, chapter],
				});
			} else {
				await db.execute({
					sql: "DELETE FROM questions WHERE lecture = ? AND (chapter IS NULL OR chapter = '')",
					args: [lecture],
				});
			}
			delete getQuestionCache()[`${chapter || ""}::${lecture}`];
			deleted++;
		}
		res.json({ success: true, deleted });
	} catch (e) {
		console.error("[admin] mass-delete error:", e && e.stack ? e.stack : e);
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/rename-chapter", requireAdmin, async (req, res) => {
	try {
		const { oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new chapter name." });

		const qr = await db.execute({ sql: "UPDATE questions SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const sr = await db.execute({ sql: "UPDATE students SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const ar = await db.execute({ sql: "UPDATE attempts SET chapter = ? WHERE chapter = ?", args: [newName, oldName] });
		const total = (qr.rowsAffected || 0) + (sr.rowsAffected || 0) + (ar.rowsAffected || 0);
		if (!total) return res.status(404).json({ error: "Chapter not found." });

		await loadQuestions();
		res.json({
			success: true,
			updated: {
				questions: qr.rowsAffected || 0,
				students: sr.rowsAffected || 0,
				attempts: ar.rowsAffected || 0,
				total,
			},
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/rename-topic", requireAdmin, async (req, res) => {
	try {
		const { chapter, oldName, newName } = req.body || {};
		if (!oldName || !newName) return res.status(400).json({ error: "Missing old or new topic name." });
		let result;
		if (chapter) {
			result = await db.execute({ sql: "UPDATE questions SET topic = ? WHERE topic = ? AND chapter = ?", args: [newName, oldName, chapter] });
		} else {
			result = await db.execute({ sql: "UPDATE questions SET topic = ? WHERE topic = ?", args: [newName, oldName] });
		}
		if (!result.rowsAffected) return res.status(404).json({ error: "Topic not found." });
		await loadQuestions();
		res.json({ success: true, updated: result.rowsAffected });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── NEW: Year index endpoints ──────────────────────────────────────────────
// Returns [{year, count}] sorted descending — no JSON parsing, instant.
//
// COUNT(DISTINCT row_id || ':' || question_index) guards against duplicate
// index rows (same question indexed more than once) inflating the per-year
// number. The authoritative per-question count for a year is still produced by
// /api/admin/questions-by-year (which reads the live questions_json), so even
// if this fast count drifts slightly the paper view itself stays correct and
// self-heals the index on open.
router.get("/api/admin/year-counts", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute(
			"SELECT year, COUNT(DISTINCT row_id || ':' || question_index) as count FROM question_years GROUP BY year ORDER BY year DESC"
		);
		res.json(result.rows.map(r => ({ year: r.year, count: Number(r.count) })));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Returns all questions belonging to a specific year.
// Only loads rows that actually contain a question from that year.
//
// IMPORTANT — why this no longer trusts qy.question_index blindly:
// The old implementation returned exactly one question per question_years row,
// picked by allQs[qy.question_index]. Whenever a lecture's questions_json was
// later edited (questions inserted / removed / reordered) without a perfectly
// matching reindex, that cached index pointed at the wrong array slot — or at
// nothing — so the paper-wise view showed an arbitrary subset (e.g. 0, 2 or 5
// questions) instead of the real count. We now treat questions_json as the
// source of truth: for every row the year-index says contains this year, we
// re-scan the live array and return EVERY question whose own `year` matches.
// The index is still used purely as a fast pre-filter so we don't parse all
// rows. We also opportunistically self-heal the question_years rows so future
// requests stay consistent.
router.get("/api/admin/questions-by-year/:year", requireAdmin, async (req, res) => {
	try {
		const year = decodeURIComponent(req.params.year || "").trim();
		if (!year) return res.status(400).json({ error: "Year required" });

		// Distinct rows the index believes contain this year (fast pre-filter).
		const result = await db.execute({
			sql: `SELECT DISTINCT q.id, q.chapter, q.lecture, q.topic, q.questions_json
			      FROM questions q
			      JOIN question_years qy ON qy.row_id = q.id
			      WHERE qy.year = ?
			      ORDER BY q.chapter, q.lecture`,
			args: [year]
		});

		const questions = [];
		const rowsNeedingReindex = [];

		for (const row of result.rows) {
			let allQs = [];
			try { allQs = JSON.parse(row.questions_json || "[]"); } catch { allQs = []; }
			if (!Array.isArray(allQs)) continue;

			let matchedInRow = 0;
			for (let qi = 0; qi < allQs.length; qi++) {
				const raw = allQs[qi];
				if (!raw) continue;
				const qYear = raw.year != null ? String(raw.year).trim() : "";
				if (qYear !== year) continue;
				const q = normalizeQuestion(raw, { preserveRaw: true });
				if (!q) continue;
				matchedInRow++;
				questions.push({
					rowId: row.id,
					chapter: row.chapter || null,
					lecture: row.lecture,
					topic: row.topic || "",
					questionIndex: qi,
					question: q
				});
			}

			// If the index disagreed with the live array (row matched by the
			// index but no question in it actually carries this year), flag it
			// so we can drop the stale index rows below.
			if (matchedInRow === 0) rowsNeedingReindex.push(row.id);
		}

		// Self-heal: rebuild the year index for any rows whose live questions_json
		// no longer agrees with question_years. Best-effort — never blocks the
		// response, and only touches rows we actually detected as stale.
		if (rowsNeedingReindex.length && typeof rebuildYearIndex === "function") {
			for (const rowId of rowsNeedingReindex) {
				try {
					const r = await db.execute({ sql: "SELECT questions_json FROM questions WHERE id = ? LIMIT 1", args: [rowId] });
					let liveQs = [];
					try { liveQs = JSON.parse(r.rows[0]?.questions_json || "[]"); } catch { liveQs = []; }
					await rebuildYearIndex(rowId, Array.isArray(liveQs) ? liveQs : []);
				} catch (_) { /* non-fatal */ }
			}
		}

		res.json({ year, count: questions.length, questions });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Trigger a manual full reindex of question_years (admin utility / recovery)
router.post("/api/admin/rebuild-year-index", requireAdmin, async (req, res) => {
	try {
		const allRows = await db.execute("SELECT id, questions_json FROM questions");
		await db.execute("DELETE FROM question_years");
		let indexed = 0;
		for (const row of allRows.rows) {
			try {
				const questions = JSON.parse(row.questions_json || "[]");
				if (!Array.isArray(questions)) continue;
				for (let i = 0; i < questions.length; i++) {
					const year = questions[i]?.year ? String(questions[i].year).trim() : null;
					if (year) {
						await db.execute({
							sql: "INSERT INTO question_years (row_id, year, question_index) VALUES (?, ?, ?)",
							args: [row.id, year, i]
						});
						indexed++;
					}
				}
			} catch (_) { }
		}
		res.json({ success: true, indexed, rows: allRows.rows.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/reload-cache", requireAdmin, async (req, res) => {
	try {
		await loadQuestions();
		res.json({ success: true, cached: Object.keys(getQuestionCache()).length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/admin/migrate", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		const all = result.rows.map(normalizeQuestionRow);
		const corrupted = all.filter((x) => !Array.isArray(x.questions));
		res.json({
			total: all.length,
			corrupted: corrupted.length,
			corruptedLectures: corrupted.map((q) => ({ lecture: q.lecture, chapter: q.chapter, _id: q._id })),
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/migrate", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM questions");
		const corruptedIds = result.rows
			.filter((row) => {
				try {
					const q = JSON.parse(row.questions_json || "[]");
					return !Array.isArray(q);
				} catch {
					return true;
				}
			})
			.map((row) => row.id);

		for (const id of corruptedIds) {
			await db.execute({ sql: "DELETE FROM questions WHERE id = ?", args: [id] });
		}

		await loadQuestions();
		res.json({
			success: true,
			deleted: corruptedIds.length,
			message: corruptedIds.length ? `Deleted ${corruptedIds.length} corrupted record(s).` : "No corrupted records found.",
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


/* ─────────────────────────────────────────────────────────────────────────────
   NEW POWERFUL EXTRACT ROUTE  v2
   ─────────────────────────────────────────────────────────────────────────────
   Architecture:
   1. PARALLEL primary extraction  – every image sent to Groq simultaneously
   2. COUNT VERIFICATION           – AI counts visible question numbers per image
   3. TARGETED RECOVERY            – only re-query images where count < expected
   4. CROSS-IMAGE BOUNDARY MERGE   – detect & stitch split questions at page edges
   5. ANSWER-KEY MERGE             – overlay correct answers from key image/text
   6. RICH DEDUP + NUMBER SORT     – eliminate duplicates, sort by question number
   7. FINAL NORMALISATION          – normalise math, fill empty options, validate
───────────────────────────────────────────────────────────────────────────── */

router.post("/api/admin/pyq-tag-questions", requireAdmin, async (req, res) => {
	try {
		const { questions } = req.body || {};
		if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "questions array required" });
		if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set" });

		const TAG_SYSTEM = `You are a JEE Main syllabus expert. Tag each numbered MCQ question with the best matching unit, chapter and topic from this syllabus:

${JEE_SYLLABUS_CONTEXT}

OUTPUT: ONLY a valid JSON array — no markdown, no explanation. Each element: {"unit":"UNIT N — NAME","chapter":"Exact Chapter Name","topic":"Specific Topic"}. Array length MUST equal input count exactly. Use \General\ if truly unsure.`;

		const BATCH_SIZE = 10;
		const allTags = [];
		for (let i = 0; i < questions.length; i += BATCH_SIZE) {
			const batch = questions.slice(i, i + BATCH_SIZE);
			const prompt = batch.map((q, idx) => (idx + 1) + ". " + String(q).slice(0, 350)).join("\n");
			try {
				const raw = await callGroq([], TAG_SYSTEM, prompt, 2000, 0.0);
				const clean = raw.replace(/```json|```/g, "").trim();
				const parsed = JSON.parse(clean);
				if (Array.isArray(parsed)) allTags.push(...parsed);
				else batch.forEach(() => allTags.push({ unit: "", chapter: "General", topic: "" }));
			} catch (bErr) {
				console.warn("[pyq-tag] batch failed:", bErr.message);
				batch.forEach(() => allTags.push({ unit: "", chapter: "General", topic: "" }));
			}
		}
		res.json({ tags: allTags });
	} catch (e) {
		console.error("/api/admin/pyq-tag-questions error:", e);
		res.status(500).json({ error: e.message || "Tagging failed" });
	}
});

/* ──────────────────────────────────────────────────────────────────────────
   BULK PDF EXTRACT — NVIDIA NIM (Llama 3.2 Vision) reads every page, streams NDJSON back
   ────────────────────────────────────────────────────────────────────────── */

const JEE_CHAPTER_MAP = {
	Physics: {
		"Units, Dimensions and Measurements": ["dimension", "dimensional formula", "significant figures", "error propagation", "SI unit", "fundamental unit", "derived unit", "dimensional analysis"],
		"Motion in One Dimension": ["equations of motion", "free fall", "displacement", "speed", "velocity", "acceleration", "graph of motion", "kinematics"],
		"Motion in Two Dimensions": ["projectile", "relative velocity", "vector resolution", "two dimension"],
		"Laws of Motion": ["newton", "friction", "circular motion dynamics", "pulley", "pseudo force", "inertia"],
		"Work, Power and Energy": ["work done", "kinetic energy", "potential energy", "conservation of energy", "power", "work-energy"],
		"Center of Mass and Collision": ["center of mass", "momentum", "impulse", "elastic collision", "inelastic collision"],
		"Rotational Motion": ["torque", "angular momentum", "moment of inertia", "rolling", "rotational"],
		"Gravitation": ["gravitation", "escape velocity", "satellite", "kepler", "orbital"],
		"Mechanical Properties of Solids": ["stress", "strain", "elasticity", "young modulus", "young's modulus"],
		"Mechanical Properties of Fluids": ["surface tension", "viscosity", "bernoulli", "fluid pressure", "streamline"],
		"Thermal Properties of Matter": ["thermal expansion", "calorimetry", "heat transfer", "specific heat", "latent heat"],
		"Kinetic Theory of Gases": ["ideal gas", "degrees of freedom", "rms speed", "kinetic theory", "mean free path"],
		"Thermodynamics": ["carnot", "isothermal", "adiabatic", "first law", "second law", "entropy", "thermodynamics"],
		"Simple Harmonic Motion (SHM)": ["simple harmonic", "shm", "spring constant", "pendulum", "time period", "oscillation"],
		"Waves": ["sound wave", "doppler", "standing wave", "resonance", "wave speed", "superposition"],
		"Electric Charges and Fields": ["coulomb", "electric field", "electric flux", "gauss law", "charge distribution"],
		"Electrostatic Potential and Capacitance": ["electric potential", "capacitor", "capacitance", "energy stored", "dielectric"],
		"Current Electricity": ["drift velocity", "ohm", "kirchhoff", "wheatstone", "potentiometer", "resistance", "resistivity"],
		"Moving Charges and Magnetism": ["lorentz", "biot-savart", "ampere", "cyclotron", "magnetic field", "solenoid"],
		"Magnetism and Matter": ["magnetic dipole", "earth magnetism", "paramagnetic", "diamagnetic", "ferromagnetic"],
		"Electromagnetic Induction": ["faraday", "lenz", "eddy current", "self inductance", "mutual inductance", "flux"],
		"Alternating Current": ["rms value", "lcr", "resonance", "transformer", "alternating current", "impedance", "reactance"],
		"Electromagnetic Waves": ["maxwell", "em spectrum", "electromagnetic wave", "speed of light"],
		"Ray Optics": ["reflection", "refraction", "mirror formula", "lens formula", "prism", "optical instrument", "snell"],
		"Wave Optics": ["interference", "diffraction", "polarisation", "ydse", "young", "fringe width", "coherent"],
		"Dual Nature of Radiation and Matter": ["photoelectric", "de broglie", "photon", "work function", "stopping potential"],
		"Atoms": ["rutherford", "bohr", "hydrogen spectrum", "atomic model", "energy level", "orbit"],
		"Nuclei": ["radioactivity", "binding energy", "nuclear reaction", "half life", "decay constant"],
		"Semiconductor Electronics": ["pn junction", "diode", "transistor", "logic gate", "zener", "semiconductor", "truth table"],
	},
	Chemistry: {
		"Some Basic Concepts of Chemistry": ["mole concept", "stoichiometry", "molarity", "molality", "normality", "equivalent"],
		"Atomic Structure": ["bohr model", "quantum number", "electronic configuration", "orbital", "aufbau", "hund"],
		"States of Matter": ["gas law", "ideal gas", "van der waals", "kinetic theory of gas", "compressibility"],
		"Thermodynamics": ["enthalpy", "entropy", "gibbs", "hess", "thermodynamics", "spontaneity", "bond enthalpy"],
		"Equilibrium": ["equilibrium constant", "kp", "kc", "ionic equilibrium", "buffer", "henderson"],
		"Redox Reactions": ["oxidation number", "redox", "balancing", "half reaction", "oxidation state"],
		"Solutions": ["colligative", "raoult", "depression in freezing", "elevation in boiling", "osmotic pressure"],
		"Electrochemistry": ["electrolysis", "nernst", "conductance", "cell potential", "electrode", "faraday"],
		"Chemical Kinetics": ["rate law", "order of reaction", "arrhenius", "rate constant", "half life kinetics"],
		"Surface Chemistry": ["adsorption", "catalysis", "colloid", "micelle", "emulsion", "tyndall"],
		"Classification of Elements and Periodicity": ["periodic table", "periodic trend", "ionisation energy", "electron affinity", "electronegativity"],
		"Chemical Bonding and Molecular Structure": ["ionic bond", "covalent bond", "hybridization", "vsepr", "mot", "sigma bond", "pi bond", "bond order"],
		"Hydrogen": ["hydride", "water", "hydrogen peroxide", "heavy water"],
		"s-Block Elements": ["alkali metal", "alkaline earth", "sodium", "potassium", "calcium", "magnesium", "lithium"],
		"p-Block Elements": ["group 13", "group 14", "group 15", "group 16", "group 17", "group 18", "halogen", "noble gas", "phosphorus", "sulphur", "nitrogen", "boron", "silicon"],
		"d and f Block Elements": ["transition element", "lanthanide", "actinide", "d-block", "f-block", "chromium", "iron", "copper", "zinc"],
		"Coordination Compounds": ["ligand", "werner", "coordination", "complex", "cfse", "spectrochemical"],
		"Metallurgy": ["extraction", "refining", "ore", "smelting", "roasting", "calcination"],
		"Environmental Chemistry": ["pollution", "smog", "ozone", "greenhouse", "acid rain"],
		"General Organic Chemistry (GOC)": ["inductive effect", "resonance effect", "hyperconjugation", "carbocation", "carbanion", "free radical"],
		"Hydrocarbons": ["alkane", "alkene", "alkyne", "benzene", "aromatic", "markovnikov"],
		"Haloalkanes and Haloarenes": ["haloalkane", "haloarene", "sn1", "sn2", "e1", "e2", "elimination"],
		"Alcohols, Phenols and Ethers": ["alcohol", "phenol", "ether", "dehydration", "lucas", "victor meyer"],
		"Aldehydes and Ketones": ["aldehyde", "ketone", "nucleophilic addition", "cannizzaro", "aldol", "fehling", "tollens"],
		"Carboxylic Acids": ["carboxylic acid", "ester", "amide", "acylation", "esterification", "saponification"],
		"Amines": ["amine", "basicity of amine", "diazotisation", "coupling reaction", "gabriel", "hofmann"],
		"Biomolecules": ["carbohydrate", "protein", "dna", "rna", "amino acid", "enzyme", "glucose"],
		"Polymers": ["polymerisation", "polymer", "monomer", "nylon", "teflon", "rubber", "bakelite"],
		"Chemistry in Everyday Life": ["drug", "antibiotic", "analgesic", "disinfectant", "detergent"],
		"Practical Chemistry": ["salt analysis", "titration", "functional group test", "iodoform", "lassaigne"],
	},
	Mathematics: {
		"Sets, Relations and Functions": ["set", "relation", "function", "inverse function", "domain", "range", "bijection"],
		"Inverse Trigonometric Functions": ["arcsin", "arccos", "arctan", "principal value", "inverse trig"],
		"Complex Numbers and Quadratic Equations": ["complex number", "quadratic", "argand", "modulus", "argument", "conjugate", "roots of unity"],
		"Matrices": ["matrix", "matrices", "transpose", "symmetric matrix", "skew symmetric", "orthogonal"],
		"Determinants": ["determinant", "adjugate", "adjoint", "cramer", "singular matrix"],
		"Permutations and Combinations": ["permutation", "combination", "factorial", "derangement", "circular arrangement"],
		"Binomial Theorem": ["binomial theorem", "binomial expansion", "general term", "middle term", "binomial coefficient"],
		"Sequence and Series": ["arithmetic progression", "geometric progression", "harmonic progression", "ap", "gp", "hp", "arithmetico-geometric"],
		"Mathematical Induction": ["mathematical induction", "principle of induction"],
		"Probability": ["probability", "conditional probability", "bayes theorem", "binomial distribution", "random variable"],
		"Statistics": ["mean", "variance", "standard deviation", "median", "mode", "coefficient of variation"],
		"Mathematical Reasoning": ["truth table", "tautology", "contradiction", "converse", "contrapositive", "biconditional"],
		"Trigonometric Ratios and Identities": ["compound angle", "product to sum", "sum to product", "multiple angle", "submultiple", "trigonometric identit"],
		"Trigonometric Equations": ["trigonometric equation", "general solution", "principal solution"],
		"Straight Lines": ["slope", "intercept", "angle between lines", "distance from point", "equation of line"],
		"Pair of Straight Lines": ["pair of lines", "homogeneous equation", "combined equation"],
		"Circle": ["circle", "tangent to circle", "chord of contact", "radical axis", "director circle"],
		"Parabola": ["parabola", "focus", "directrix", "latus rectum", "tangent to parabola", "normal to parabola"],
		"Ellipse": ["ellipse", "eccentricity", "semi-major", "semi-minor", "tangent to ellipse"],
		"Hyperbola": ["hyperbola", "asymptote", "rectangular hyperbola", "conjugate hyperbola"],
		"Limits": ["limit", "l'hopital", "standard limit", "sandwich theorem", "infinite limit"],
		"Continuity and Differentiability": ["continuity", "differentiability", "continuous function", "intermediate value"],
		"Methods of Differentiation": ["chain rule", "implicit differentiation", "logarithmic differentiation", "parametric"],
		"Applications of Derivatives": ["maxima", "minima", "tangent", "normal", "rate of change", "increasing", "decreasing", "rolle", "lagrange", "mean value theorem"],
		"Indefinite Integrals": ["indefinite integral", "antiderivative", "substitution", "partial fraction", "integration by parts"],
		"Definite Integrals": ["definite integral", "area under curve", "properties of definite integral", "newton-leibniz"],
		"Differential Equations": ["differential equation", "variable separable", "linear differential", "homogeneous differential", "bernoulli"],
		"Vector Algebra": ["dot product", "cross product", "scalar triple", "vector triple", "collinear vector", "coplanar"],
		"Three Dimensional Geometry": ["direction cosine", "direction ratio", "skew lines", "shortest distance", "equation of plane", "equation of line in 3d"],
		"Linear Programming": ["linear programming", "constraint", "objective function", "feasible region", "corner point"],
	},
};

function predictChapterBulk(subject, questionText) {
	const text = (questionText || "").toLowerCase();
	const map = JEE_CHAPTER_MAP[subject] || {};
	let best = "General", bestScore = 0;
	for (const [chapter, keywords] of Object.entries(map)) {
		let score = 0;
		for (const kw of keywords) { if (text.includes(kw.toLowerCase())) score++; }
		if (score > bestScore) { bestScore = score; best = chapter; }
	}
	return best;
}

const BULK_PAGE_PROMPT = `You are extracting questions from a JEE Main exam PDF page image.

PAPER FORMAT:
- Two-column layout. Left: question number, question text, options (1)(2)(3)(4), "Ans.(X)". Right: "Sol." + solution.
- Three subjects in order: MATHEMATICS → PHYSICS → CHEMISTRY (each marked by bold section header).
- Section A: MCQ (4 options, one correct). Section B: Numerical/integer answer (no options).
- Question numbers are continuous across subjects (e.g. Math Q1-25, Physics Q26-50, Chem Q51-75).

EXTRACT every question visible. Return ONLY a JSON array (no markdown, no explanation):
[{"questionNumber":1,"subject":"Mathematics","section":"A","questionText":"full question with math in $...$","options":["(1) text","(2) text","(3) text","(4) text"],"correctAnswer":"3","correctIndexes":[2],"solutionText":"full step-by-step solution with LaTeX math","hasQuestionImage":false}]

RULES:
1. Wrap ALL math in $...$. E.g. $\\frac{a}{b}$, $\\sqrt{x^2+1}$, $x^2+y^2=r^2$
2. Chemical formulas: H$_2$O, Fe$_3$O$_4$, CO$_2$ etc.
3. Section B (no options): options:[], correctIndexes:[], correctAnswer: the integer shown.
4. correctIndexes: option (1)->[0], (2)->[1], (3)->[2], (4)->[3].
5. Subject header (MATHEMATICS/PHYSICS/CHEMISTRY) applies to all questions below it on that page.
6. Tables in options: render as markdown table inside the option string.
7. Include cut-off questions with what is visible.
8. DO NOT skip any question. If page has no questions (title/instructions page), return [].
9. ALWAYS include solutionText — extract the full solution shown next to each question. Preserve all steps.
10. correctAnswer must be the option number (1-4) for Section A, or the numerical value for Section B.`;

const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Canvas factory for pdfjs-dist Node.js rendering ──
const nodeCanvasFactory = {
	create(width, height) {
		const canvas = createCanvas(width, height);
		return { canvas, context: canvas.getContext('2d') };
	},
	reset(canvasAndContext, width, height) {
		canvasAndContext.canvas.width = width;
		canvasAndContext.canvas.height = height;
	},
	destroy(canvasAndContext) {
		canvasAndContext.canvas = null;
		canvasAndContext.context = null;
	}
};

// ── Parse JSON array from LLM response text ──
function parseLLMJSON(raw) {
	if (!raw) return { questions: [], hadContent: false };
	let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
	const hadContent = s.length > 0;
	const start = s.indexOf("[");
	const end = s.lastIndexOf("]");
	if (start === -1 || end === -1 || end < start) return { questions: [], hadContent };
	s = s.slice(start, end + 1);
	try { return { questions: JSON.parse(s), hadContent }; }
	catch {
		// Try fixing trailing commas
		s = s.replace(/,(\s*[}\]])/g, "$1");
		try { return { questions: JSON.parse(s), hadContent }; }
		catch (e2) {
			console.error("[bulk-pdf-extract] LLM JSON parse failed:", e2.message, "| Sample:", s.slice(0, 300));
			return { questions: [], hadContent };
		}
	}
}


router.get("/api/admin/paper-templates", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req);
		const queryInstId = req.query.instituteId ? Number(req.query.instituteId) : null;
		let rows;
		if (queryInstId) {
			const result = await db.execute({
				sql: "SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id WHERE pt.institute_id = ? ORDER BY pt.created_at DESC",
				args: [queryInstId]
			});
			rows = result.rows;
		} else if (instId) {
			const result = await db.execute({
				sql: "SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id WHERE pt.institute_id = ? ORDER BY pt.created_at DESC",
				args: [instId]
			});
			rows = result.rows;
		} else {
			const result = await db.execute("SELECT pt.id, pt.name, pt.created_at, pt.institute_id, i.name AS institute_name FROM paper_templates pt LEFT JOIN institutes i ON pt.institute_id = i.id ORDER BY pt.created_at DESC");
			rows = result.rows;
		}
		res.json(rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, instituteId: r.institute_id, instituteName: r.institute_name || null })));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// POST upload a new template
router.post("/api/admin/paper-templates", requireAdmin, upload.single("template"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "No file uploaded" });
		if (!req.file.originalname.endsWith(".docx")) return res.status(400).json({ error: "Only .docx templates are supported" });
		const name = req.body.name || req.file.originalname.replace(/\.docx$/i, "");
		const base64 = req.file.buffer.toString("base64");
		const sessionInstId = sessionInstituteId(req);
		const instId = req.body.instituteId ? Number(req.body.instituteId) : (sessionInstId || null);
		const result = await db.execute({
			sql: "INSERT INTO paper_templates (name, docx_base64, created_at, institute_id) VALUES (?, ?, ?, ?)",
			args: [name, base64, Date.now(), instId]
		});
		res.json({ success: true, id: Number(result.lastInsertRowid), name, instituteId: instId });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed to upload template" });
	}
});

// DELETE a template by id

router.delete("/api/admin/paper-templates/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req);
		if (instId) {
			await db.execute({ sql: "DELETE FROM paper_templates WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		} else {
			await db.execute({ sql: "DELETE FROM paper_templates WHERE id = ?", args: [Number(req.params.id)] });
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// PATCH rename a template
router.patch("/api/admin/paper-templates/:id", requireAdmin, async (req, res) => {
	try {
		const { name } = req.body || {};
		if (!name) return res.status(400).json({ error: "name required" });
		const instId = sessionInstituteId(req);
		if (instId) {
			await db.execute({ sql: "UPDATE paper_templates SET name = ? WHERE id = ? AND institute_id = ?", args: [name, Number(req.params.id), instId] });
		} else {
			await db.execute({ sql: "UPDATE paper_templates SET name = ? WHERE id = ?", args: [name, Number(req.params.id)] });
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.get("/api/admin/star-quiz/questions", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT * FROM star_quiz_questions ORDER BY chapter, CAST(lecture AS INTEGER)");
		res.json(result.rows.map(normalizeQuestionRow));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// GET chapters for STAR Quiz
router.get("/api/admin/star-quiz/chapters", requireAdmin, async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM star_quiz_questions WHERE chapter IS NOT NULL AND chapter != '' ORDER BY chapter");
		res.json(result.rows.map(r => r.chapter));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// POST add STAR Quiz questions
router.post("/api/admin/star-quiz/add-question", requireAdmin, async (req, res) => {
	try {
		let { chapter, lecture, topic, questions, replace } = req.body || {};
		if (!chapter || !lecture || !Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "Missing chapter, lecture, or questions" });
		}
		// When replace=true this request originates from a manual edit (the editor
		// deletes the old lecture and re-inserts it after changing chapter/lecture),
		// so preserve raw text and do not re-wrap deliberately un-wrapped equations.
		const _nq = (q) => normalizeQuestion(q, replace ? { preserveRaw: true } : undefined);
		questions = questions.map(_nq);
		questions = await uploadQuestionImages(questions);

		const r = await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		const existing = r.rows[0] || null;

		if (existing) {
			const oldQs = replace ? [] : (() => { try { return JSON.parse(existing.questions_json || "[]"); } catch { return []; } })();
			const merged = [...oldQs, ...questions];
			await db.execute({ sql: "UPDATE star_quiz_questions SET questions_json = ?, topic = ?, updated_at = ? WHERE id = ?", args: [JSON.stringify(merged), topic || existing.topic || "", Date.now(), existing.id] });
			return res.json({ success: true, added: questions.length, total: merged.length });
		}

		await db.execute({ sql: "INSERT INTO star_quiz_questions (chapter, lecture, topic, questions_json, updated_at, access_code) VALUES (?, ?, ?, ?, ?, ?)", args: [chapter, lecture, topic || "", JSON.stringify(questions), Date.now(), null] });
		res.json({ success: true, added: questions.length, total: questions.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// DELETE a STAR Quiz question set
router.delete("/api/admin/star-quiz/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		await db.execute({ sql: "DELETE FROM star_quiz_questions WHERE chapter = ? AND lecture = ?", args: [chapter, lecture] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// PUT update a STAR Quiz question set
router.put("/api/admin/star-quiz/question/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const { topic, questions } = req.body || {};
		if (!Array.isArray(questions)) return res.status(400).json({ error: "Questions array required" });

		// Manual edit: preserve raw text so removing $ delimiters is honoured.
		let normalized = questions.map((q) => normalizeQuestion(q, { preserveRaw: true }));
		normalized = await uploadQuestionImages(normalized);
		await db.execute({ sql: "UPDATE star_quiz_questions SET questions_json = ?, topic = ?, updated_at = ? WHERE chapter = ? AND lecture = ?", args: [JSON.stringify(normalized), topic || "", Date.now(), chapter, lecture] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: Set access code for a star quiz lecture ───────────────────────────
router.post("/api/admin/star-quiz/set-code/:chapter/:lecture", requireAdmin, async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		const { accessCode } = req.body || {};
		// Allow null/empty to clear the code
		if (accessCode === null || accessCode === "" || accessCode === undefined) {
			await db.execute({ sql: "UPDATE star_quiz_questions SET access_code = NULL WHERE chapter = ? AND lecture = ?", args: [chapter, lecture] });
			return res.json({ success: true, accessCode: null });
		}
		if (!/^[0-9]{4}$/.test(String(accessCode))) {
			return res.status(400).json({ error: "Access code must be exactly 4 digits" });
		}
		// Check uniqueness across other lectures
		const existing = await db.execute({ sql: "SELECT chapter, lecture FROM star_quiz_questions WHERE access_code = ? AND NOT (chapter = ? AND lecture = ?)", args: [accessCode, chapter, lecture] });
		if (existing.rows.length) {
			return res.status(409).json({ error: "This code is already used by another lecture" });
		}
		await db.execute({ sql: "UPDATE star_quiz_questions SET access_code = ? WHERE chapter = ? AND lecture = ?", args: [accessCode, chapter, lecture] });
		res.json({ success: true, accessCode });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: create / assign an online test ────────────────────────────────────
router.post("/api/admin/online-tests", requireAdmin, async (req, res) => {
	try {
		const { testName, questionKeys, questions, marksCorrect, marksWrong, liveAt, endsAt, durationMinutes, assignedRolls, maxAttempts, isStrict } = req.body || {};

		// Accept either questionKeys (new format) or questions (legacy full objects)
		const keys = Array.isArray(questionKeys) && questionKeys.length ? questionKeys : null;
		const legacyQuestions = Array.isArray(questions) && questions.length ? questions : null;

		if (!keys && !legacyQuestions)
			return res.status(400).json({ error: "questionKeys array required" });

		const qCount = keys ? keys.length : legacyQuestions.length;
		const now = Date.now();
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());

		const result = await db.execute({
			sql: `INSERT INTO online_tests (test_name, institute_id, question_keys_json, questions_json, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, duration_minutes, question_count, max_attempts, is_strict)
			      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				String(testName || "Online Test").trim(),
				instId,
				JSON.stringify(keys || []),
				// questions_json kept for backward-compat — empty if keys provided, else legacy data
				keys ? "[]" : JSON.stringify(legacyQuestions),
				Number(marksCorrect) || 4,
				Number(marksWrong) || -1,
				Number(liveAt) || now,
				Number(endsAt) || (now + 7 * 24 * 60 * 60 * 1000),
				JSON.stringify(Array.isArray(assignedRolls) ? assignedRolls : []),
				now,
				Number(durationMinutes) || 90,
				qCount,
				Number(maxAttempts) || 1,
				isStrict ? 1 : 0,
			],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: list all online tests ─────────────────────────────────────────────
router.get("/api/admin/online-tests", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at FROM online_tests WHERE institute_id = ? ORDER BY created_at DESC",
			args: [instId],
		});
		res.json(result.rows.map(r => ({
			id: r.id,
			testName: r.test_name,
			marksCorrect: r.marks_correct,
			marksWrong: r.marks_wrong,
			liveAt: r.live_at,
			endsAt: r.ends_at,
			assignedRolls: (() => { try { return JSON.parse(r.assigned_rolls || "[]"); } catch { return []; } })(),
			createdAt: r.created_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: delete an online test ─────────────────────────────────────────────
router.delete("/api/admin/online-tests/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({ sql: "DELETE FROM online_tests WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: add one or multiple roll numbers ──────────────────────────────────
router.post("/api/admin/registered-students/add", requireAdmin, async (req, res) => {
	try {
		const raw = req.body?.rollNumbers; // string (comma/newline separated) or array
		let rolls = [];
		if (Array.isArray(raw)) {
			rolls = raw.map(r => String(r).trim()).filter(Boolean);
		} else {
			rolls = String(raw || "").split(/[\n,]+/).map(r => r.trim()).filter(Boolean);
		}
		if (!rolls.length) return res.status(400).json({ error: "No roll numbers provided" });
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const now = Date.now();
		let added = 0, skipped = 0;
		for (const roll of rolls) {
			try {
				await db.execute({
					sql: "INSERT INTO registered_students (roll_number, institute_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
					args: [roll, instId, now, now],
				});
				added++;
			} catch (_) { skipped++; } // UNIQUE constraint → already exists
		}
		res.json({ success: true, added, skipped });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: list all registered students ─────────────────────────────────────
router.get("/api/admin/registered-students", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
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

// ── ADMIN: delete a registered student by id ────────────────────────────────
router.delete("/api/admin/registered-students/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({ sql: "DELETE FROM registered_students WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── ADMIN: list all pending student requests ─────────────────────────────────
router.get("/api/admin/student-requests", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM student_requests WHERE institute_id = ? ORDER BY requested_at DESC",
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
			requestedAt: r.requested_at,
		})));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: approve a student request (move to registered_students) ───────────
router.post("/api/admin/student-requests/:id/approve", requireAdmin, async (req, res) => {
	try {
		const id = Number(req.params.id);
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({ sql: "SELECT * FROM student_requests WHERE id = ? AND institute_id = ?", args: [id, instId] });
		if (!result.rows.length) return res.status(404).json({ error: "Request not found" });
		const r = result.rows[0];
		const now = Date.now();
		// Insert into registered_students with profile already complete, carrying
		// the institute_id forward so the approved student belongs to this institute.
		try {
			await db.execute({
				sql: `INSERT INTO registered_students (roll_number, institute_id, name, class_name, phone, age, date_of_birth, profile_complete, created_at, updated_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				args: [r.roll_number, instId, r.name, r.class_name, r.phone, r.age, r.date_of_birth, now, now],
			});
		} catch (_) {
			// Already exists — update with profile details
			await db.execute({
				sql: `UPDATE registered_students SET institute_id=?, name=?, class_name=?, phone=?, age=?, date_of_birth=?, profile_complete=1, updated_at=? WHERE roll_number=?`,
				args: [instId, r.name, r.class_name, r.phone, r.age, r.date_of_birth, now, r.roll_number],
			});
		}
		// Remove from requests
		await db.execute({ sql: "DELETE FROM student_requests WHERE id = ?", args: [id] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ADMIN: reject a student request (delete from requests) ───────────────────
router.delete("/api/admin/student-requests/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({ sql: "DELETE FROM student_requests WHERE id = ? AND institute_id = ?", args: [Number(req.params.id), instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── Debug: list available Gemini models for the configured API key ──
router.get("/api/admin/gemini-models", requireAdmin, async (req, res) => {
	if (!GEMINI_API_KEY) return res.status(400).json({ error: "GEMINI_API_KEY not set" });
	try {
		const results = {};
		for (const apiVer of ["v1", "v1beta"]) {
			const r = await fetch(
				`https://generativelanguage.googleapis.com/${apiVer}/models?key=${GEMINI_API_KEY}`
			);
			const data = await r.json().catch(() => ({}));
			results[apiVer] = r.ok
				? (data.models || []).map(m => m.name)
				: data?.error?.message || `HTTP ${r.status}`;
		}
		res.json(results);
	} catch (e) {
		res.status(500).json({ error: e.message });
	}
});

// ── ATTENDANCE: Classes ──────────────────────────────────────────────
router.get("/api/admin/classes", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const result = await db.execute({
			sql: "SELECT * FROM classes WHERE institute_id = ? ORDER BY name",
			args: [instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/classes", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { name } = req.body || {};
		if (!name || !name.trim()) return res.status(400).json({ error: "Class name required" });
		const result = await db.execute({
			sql: "INSERT INTO classes (name, institute_id, created_at) VALUES (?, ?, ?)",
			args: [name.trim(), instId, Date.now()],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/classes/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		await db.execute({ sql: "DELETE FROM batches WHERE class_id = ? AND institute_id = ?", args: [classId, instId] });
		await db.execute({ sql: "DELETE FROM classes WHERE id = ? AND institute_id = ?", args: [classId, instId] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Batches ──────────────────────────────────────────────
router.get("/api/admin/classes/:id/batches", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		const result = await db.execute({
			sql: "SELECT * FROM batches WHERE class_id = ? AND institute_id = ? ORDER BY name",
			args: [classId, instId],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/classes/:id/batches", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const classId = Number(req.params.id);
		const { name } = req.body || {};
		if (!name || !name.trim()) return res.status(400).json({ error: "Batch name required" });
		const result = await db.execute({
			sql: "INSERT INTO batches (name, class_id, institute_id, created_at) VALUES (?, ?, ?, ?)",
			args: [name.trim(), classId, instId, Date.now()],
		});
		res.json({ success: true, id: Number(result.lastInsertRowid) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.delete("/api/admin/batches/:id", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		await db.execute({
			sql: "DELETE FROM batches WHERE id = ? AND institute_id = ?",
			args: [Number(req.params.id), instId],
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Students by class/batch ──────────────────────────────
router.get("/api/admin/attendance/students", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id } = req.query;
		let sql = "SELECT roll_number, name, class_name, batch_id FROM registered_students WHERE institute_id = ? AND profile_complete = 1";
		const args = [instId];
		if (class_id) {
			sql += " AND class_name = (SELECT name FROM classes WHERE id = ?)";
			args.push(Number(class_id));
		}
		if (batch_id) {
			sql += " AND batch_id = ?";
			args.push(Number(batch_id));
		}
		sql += " ORDER BY name";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Mark attendance ──────────────────────────────────────
router.post("/api/admin/attendance/mark", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id, date, roll_numbers, status } = req.body || {};
		if (!class_id || !date || !Array.isArray(roll_numbers) || !roll_numbers.length) {
			return res.status(400).json({ error: "class_id, date, and roll_numbers required" });
		}
		const attStatus = status || "present";
		const now = Date.now();
		let marked = 0;
		for (const roll of roll_numbers) {
			await db.execute({
				sql: `INSERT INTO attendance (class_id, batch_id, roll_number, date, status, institute_id, marked_by, marked_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				      ON CONFLICT(roll_number, date) DO UPDATE SET status = ?, marked_at = ?`,
				args: [Number(class_id), batch_id ? Number(batch_id) : null, roll, date, attStatus, instId, "", now, attStatus, now],
			});
			// Create in-app notification for each student
			await db.execute({
				sql: "INSERT INTO notifications (roll_number, message, type, institute_id, created_at) VALUES (?, ?, ?, ?, ?)",
				args: [roll, `Your attendance has been marked as ${attStatus} for ${date}.`, "attendance", instId, now],
			});
			marked++;
		}
		res.json({ success: true, marked });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Get records for a date ───────────────────────────────
router.get("/api/admin/attendance/records", requireAdmin, async (req, res) => {
	try {
		const instId = sessionInstituteId(req) || (await getDefaultInstituteId());
		const { class_id, batch_id, date } = req.query;
		let sql = "SELECT a.*, rs.name as student_name FROM attendance a LEFT JOIN registered_students rs ON a.roll_number = rs.roll_number AND rs.institute_id = ? WHERE a.institute_id = ?";
		const args = [instId, instId];
		if (class_id) {
			sql += " AND a.class_id = ?";
			args.push(Number(class_id));
		}
		if (batch_id) {
			sql += " AND a.batch_id = ?";
			args.push(Number(batch_id));
		}
		if (date) {
			sql += " AND a.date = ?";
			args.push(date);
		}
		sql += " ORDER BY a.roll_number";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── ATTENDANCE: Get records for a student (for calendar view) ────────
router.get("/api/admin/attendance/student/:roll", async (req, res) => {
	try {
		const roll = req.params.roll;
		const { month, year } = req.query;
		let sql = "SELECT date, status FROM attendance WHERE roll_number = ?";
		const args = [roll];
		if (month && year) {
			const m = String(month).padStart(2, "0");
			sql += " AND date LIKE ?";
			args.push(`${year}-${m}-%`);
		} else if (year) {
			sql += " AND date LIKE ?";
			args.push(`${year}-%`);
		}
		sql += " ORDER BY date DESC";
		const result = await db.execute({ sql, args });
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── NOTIFICATIONS: Get unread for a student ──────────────────────────
router.get("/api/admin/notifications/:roll", async (req, res) => {
	try {
		const roll = req.params.roll;
		const result = await db.execute({
			sql: "SELECT * FROM notifications WHERE roll_number = ? AND is_read = 0 ORDER BY created_at DESC LIMIT 50",
			args: [roll],
		});
		res.json(result.rows);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/admin/notifications/read", async (req, res) => {
	try {
		const { ids } = req.body || {};
		if (!Array.isArray(ids) || !ids.length) return res.json({ success: true });
		await db.execute({
			sql: `UPDATE notifications SET is_read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
			args: ids,
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

module.exports = router;
