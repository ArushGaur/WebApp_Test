const express = require("express");
const router = express.Router();
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { rateLimit, resolveStudentInstituteId, sessionInstituteId, getDefaultInstituteId } = require("../middleware/auth");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion, resolveQuestionKeys } = require("../utils/questions");
const { isCorrect, normalizeQuestionRow } = helpers;
const crypto = require("crypto");
function genToken() {
    return crypto.randomBytes(32).toString("hex");
}

router.post("/api/check-attempt", async (req, res) => {
	try {
		const { mobile, chapter, lecture } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		// Use star_quiz_questions as the student portal source
		const sqRow = await db.execute({ sql: "SELECT updated_at FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!sqRow.rows.length) return res.json({ allowed: false, time: 0 });
		const q = { updatedAt: sqRow.rows[0].updated_at || 0 };

		const result = await db.execute({
			sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1",
			args: [mobile, lecture],
		});

		if (!result.rows.length) return res.json({ allowed: true, time: 0 });

		const lastTime = result.rows[0].time || 0;
		if (lastTime >= (q.updatedAt || 0)) return res.json({ allowed: false, time: lastTime });
		return res.json({ allowed: true, time: lastTime });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/student-register", async (req, res) => {
	try {
		const { name, mobile, place, className, chapter, lecture, instituteCode } = req.body || {};
		if (!name || !mobile || !lecture) return res.status(400).json({ error: "Missing" });

		const instId = await resolveStudentInstituteId({ mobile, instituteCode });
		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, time, institute_id)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, time=excluded.time, institute_id=excluded.institute_id`,
			args: [mobile, lecture, name, place || "", className || "", chapter || null, Date.now(), instId],
		});

		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.post("/api/submit-attempt", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const { mobile, chapter, lecture, selectedAnswers, askedQuestionIndexes, name, place, className, cheatFlag } = req.body || {};
		if (!mobile || !lecture) return res.status(400).json({ error: "Missing" });

		// Use star_quiz_questions as the student portal source
		const sqRow = await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!sqRow.rows.length) return res.status(404).json({ error: "Not found" });
		const q = normalizeQuestionRow(sqRow.rows[0]);

		const lastResult = await db.execute({
			sql: "SELECT time FROM attempts WHERE mobile = ? AND lecture = ? ORDER BY time DESC LIMIT 1",
			args: [mobile, lecture],
		});
		if (lastResult.rows.length && (lastResult.rows[0].time || 0) >= (q.updatedAt || 0)) {
			return res.json({ allowed: false });
		}

		const validSourceIndexes = Array.isArray(askedQuestionIndexes)
			? askedQuestionIndexes
				.map((idx) => Number(idx))
				.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < q.questions.length)
			: [];

		const questionsForScoring = validSourceIndexes.length
			? validSourceIndexes.map((idx) => q.questions[idx]).filter(Boolean)
			: q.questions;

		const answers = Array.isArray(selectedAnswers) ? selectedAnswers : [];
		let correctCount = 0;
		answers.forEach((ans, i) => {
			if (isCorrect(questionsForScoring[i], ans)) correctCount++;
		});

		const now = Date.now();
		const instId = await resolveStudentInstituteId({ mobile, instituteCode: req.body?.instituteCode });
		await db.execute({
			sql: "INSERT INTO attempts (mobile, chapter, lecture, time, institute_id) VALUES (?, ?, ?, ?, ?)",
			args: [mobile, chapter || null, lecture, now, instId],
		});

		await db.execute({
			sql: `INSERT INTO students (mobile, lecture, name, place, class_name, chapter, answers_json, correct_count, total_questions, time, cheat_flag, institute_id)
				  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				  ON CONFLICT(mobile, lecture) DO UPDATE SET
					name=excluded.name, place=excluded.place, class_name=excluded.class_name,
					chapter=excluded.chapter, answers_json=excluded.answers_json,
					correct_count=excluded.correct_count, total_questions=excluded.total_questions, time=excluded.time,
					institute_id=excluded.institute_id,
					cheat_flag=MAX(students.cheat_flag, excluded.cheat_flag)`,
			args: [
				mobile,
				lecture,
				name || "",
				place || "",
				className || "",
				chapter || null,
				JSON.stringify(answers),
				correctCount,
				questionsForScoring.length,
				now,
				cheatFlag ? 1 : 0,
				instId,
			],
		});

		res.json({ success: true, correctCount, totalQuestions: questionsForScoring.length });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Save test result to database
router.post("/api/save-test-result", async (req, res) => {
	try {
		const {
			mobile,
			chapter,
			lecture,
			topic,
			correct,
			wrong,
			skipped,
			total,
			marksScore,
			maxMarks,
			pct,
			grade,
			timeTaken,
			scheme,
			studentName,
			studentClass,
			answers,
			online_test_id
		} = req.body || {};

		const compactAnswers = Array.isArray(answers)
			? answers.map((item, index) => {
				let sourceIdx = index;
				let answerValue = null;
				let statusRaw = "";

				if (Array.isArray(item)) {
					// Preferred compact format from frontend: [idx, answer, statusChar]
					sourceIdx = Number.isFinite(Number(item[0])) ? Number(item[0]) : index;
					answerValue = item[1] ?? null;
					statusRaw = item[2] ?? "";
				} else if (item && typeof item === "object") {
					// Object format compatibility: { idx, studentAnswer, status }
					sourceIdx = Number.isFinite(Number(item.idx)) ? Number(item.idx) : index;
					answerValue = item.studentAnswer ?? item.a ?? item.answer ?? null;
					statusRaw = item.status ?? item.s ?? "";
				} else if (item !== null && item !== undefined) {
					// Primitive compatibility: [0,1,-1,...]
					answerValue = item;
				}

				const compactAnswer = Array.isArray(answerValue)
					? answerValue.join(",")
					: answerValue === null || answerValue === undefined || String(answerValue).trim() === ""
						? ""
						: String(answerValue);

				let statusValue = String(statusRaw || "").charAt(0).toLowerCase();
				if (!["c", "w", "s"].includes(statusValue)) {
					const low = compactAnswer.trim().toLowerCase();
					statusValue = (low === "" || low === "-1" || low === "null" || low === "undefined") ? "s" : "a";
				}

				return [sourceIdx, compactAnswer, statusValue];
			})
			: [];

		if (!mobile) {
			return res.status(400).json({ error: "Missing mobile" });
		}

		const timestamp = Date.now();
		// If marksScore missing or null, compute from scheme and correct/wrong
		let computedMarks = Number(marksScore);
		if (!Number.isFinite(computedMarks)) computedMarks = null;
		const schemeStr = String(scheme || '+1/0');
		if (computedMarks === null) {
			// parse scheme like '+4/-1' or '+1/0'
			let pos = 1, neg = 0;
			try {
				const m = schemeStr.match(/([+-]?\d+)\/?([+-]?\d+)?/);
				if (m) {
					pos = Number(m[1]) || 1;
					// negative penalty may be represented as -1 or 0
					neg = Number(m[2]) || 0;
				}
			} catch (_) { pos = 1; neg = 0; }
			computedMarks = (Number(correct) || 0) * pos - (Number(wrong) || 0) * Math.abs(neg);
		}

		// Parse online_test_id if provided
		const testId = Number.isFinite(Number(online_test_id)) ? Number(online_test_id) : null;

		await db.execute({
			sql: `INSERT INTO test_history (
				mobile, chapter, lecture, topic, correct_count, wrong_count, skipped_count,
				total_questions, marks_score, max_marks, accuracy_pct, grade, time_taken,
				scheme, timestamp, student_name, student_class, answers_json, online_test_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				mobile,
				chapter || null,
				lecture,
				topic || "",
				correct || 0,
				wrong || 0,
				skipped || 0,
				total || 0,
				computedMarks || 0,
				(total || 0) * (Number(schemeStr.match(/([+-]?\d+)/)?.[1]) || 1),
				pct || 0,
				grade || "",
				timeTaken || 0,
				schemeStr || "+1/0",
				timestamp,
				studentName || "",
				studentClass || "",
				JSON.stringify(compactAnswers),
				testId
			]
		});

		// Update aggregated student stats: tests_completed, avg_pct, day_streak
		try {
			const statRows = await db.execute({ sql: "SELECT COUNT(*) as cnt, AVG(accuracy_pct) as avgpct FROM test_history WHERE mobile = ?", args: [mobile] });
			const cnt = (statRows.rows[0] && statRows.rows[0].cnt) ? Number(statRows.rows[0].cnt) : 0;
			const avgpct = (statRows.rows[0] && statRows.rows[0].avgpct) ? Math.round(Number(statRows.rows[0].avgpct)) : 0;

			// compute day streak from distinct dates of attempts (descending)
			const datesRes = await db.execute({ sql: "SELECT DISTINCT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') as d FROM test_history WHERE mobile = ? ORDER BY d DESC LIMIT 30", args: [mobile] });
			const dates = datesRes.rows.map(r => r.d).filter(Boolean);
			let streak = 0;
			if (dates.length) {
				const today = new Date(dates[0] + 'T00:00:00');
				let cur = new Date(today);
				for (let i = 0; i < dates.length; i++) {
					const d = new Date(dates[i] + 'T00:00:00');
					if (Math.abs((cur - d) / (24 * 3600 * 1000)) <= 0.1) {
						streak++;
						cur.setDate(cur.getDate() - 1);
					} else break;
				}
			}

			await db.execute({
				sql: `INSERT INTO student_stats (mobile, tests_completed, avg_pct, day_streak, last_test, updated_at)
					  VALUES (?, ?, ?, ?, ?, ?)
					  ON CONFLICT(mobile) DO UPDATE SET
						tests_completed = excluded.tests_completed,
						avg_pct = excluded.avg_pct,
						day_streak = excluded.day_streak,
						last_test = excluded.last_test,
						updated_at = excluded.updated_at`,
				args: [mobile, cnt, avgpct, streak, timestamp, Date.now()]
			});
		} catch (e) {
			console.warn('Failed to update student_stats:', e.message || e);
		}

		res.json({ success: true, timestamp });
	} catch (e) {
		console.error("Save test result error:", e);
		res.status(500).json({ error: e.message || "Failed to save test result" });
	}
});

// Fetch test history for a student
router.get("/api/test-history/:mobile", async (req, res) => {
	try {
		const { mobile } = req.params || {};
		if (!mobile) {
			return res.status(400).json({ error: "Missing mobile" });
		}

		// Pagination support: ?page=1&limit=7  (defaults: page=1, limit=100 for backwards compat)
		const page = Math.max(1, parseInt(req.query.page || "1", 10));
		const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "100", 10)));
		const offset = (page - 1) * limit;

		// Also return total count so the client knows when to stop
		const countResult = await db.execute({
			sql: "SELECT COUNT(*) as cnt FROM test_history WHERE mobile = ?",
			args: [mobile]
		});
		const totalCount = Number(countResult.rows[0]?.cnt || 0);

		const result = await db.execute({
			sql: "SELECT * FROM test_history WHERE mobile = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?",
			args: [mobile, limit, offset]
		});

		const history = result.rows.map(row => {
			let questions = [];

			// If this test was an online test, fetch questions from online_tests table
			if (row.online_test_id && Number.isFinite(Number(row.online_test_id))) {
				// Fetch from online_tests table (sync approach - we'll handle this with Promise.all below)
				// For now, mark that we need to fetch it
				questions = []; // Will be populated below
			}

			return {
				id: row.id,
				timestamp: row.timestamp,
				student: {
					name: row.student_name,
					roll: mobile,
					class: row.student_class
				},
				test: {
					chapter: row.chapter || "",
					lecture: row.lecture,
					topic: row.topic || ""
				},
				result: {
					correct: row.correct_count,
					wrong: row.wrong_count,
					skipped: row.skipped_count,
					total: row.total_questions,
					marksScore: row.marks_score,
					maxMarks: row.max_marks,
					pct: row.accuracy_pct,
					grade: row.grade,
					timeTaken: row.time_taken
				},
				scheme: row.scheme,
				online_test_id: row.online_test_id,
				questions: questions,
				answers: (() => {
					try {
						const parsed = JSON.parse(row.answers_json || "[]");
						return Array.isArray(parsed)
							? parsed.map((item, idx) => {
								if (Array.isArray(item)) {
									const [qIndex, studentAnswer, status] = item;
									return {
										idx: Number.isFinite(Number(qIndex)) ? Number(qIndex) : idx,
										studentAnswer: studentAnswer === "" ? null : String(studentAnswer),
										status: status || "s"
									};
								}
								if (item !== null && item !== undefined && typeof item !== "object") {
									const raw = String(item).trim();
									const skipped = raw === "" || raw === "-1" || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined";
									return {
										idx,
										studentAnswer: skipped ? null : raw,
										status: skipped ? "s" : "a"
									};
								}
								return {
									idx: Number.isFinite(Number(item?.idx)) ? Number(item.idx) : idx,
									studentAnswer: item?.studentAnswer ?? item?.answer ?? item?.a ?? null,
									status: (() => {
										const explicit = item?.status || item?.s;
										if (explicit) return explicit;
										const ans = item?.studentAnswer ?? item?.answer ?? item?.a;
										if (ans === null || ans === undefined) return "s";
										const raw = String(ans).trim().toLowerCase();
										return raw === "" || raw === "-1" || raw === "null" || raw === "undefined" ? "s" : "a";
									})()
								};
							})
							: [];
					} catch { return []; }
				})(),
				_raw_row: row // Keep raw row for processing below
			};
		});

		// Fetch questions for online tests — resolve via question_keys_json (no duplication)
		const historyWithQuestions = await Promise.all(history.map(async (item) => {
			if (item.online_test_id && Number.isFinite(Number(item.online_test_id))) {
				try {
					const qResult = await db.execute({
						sql: "SELECT question_keys_json, questions_json FROM online_tests WHERE id = ? LIMIT 1",
						args: [item.online_test_id]
					});
					if (qResult.rows.length > 0) {
						const r = qResult.rows[0];
						try {
							// Prefer question_keys_json (new format — no duplication)
							const keys = JSON.parse(r.question_keys_json || "[]");
							if (Array.isArray(keys) && keys.length) {
								const resolved = await resolveQuestionKeys(keys);
								if (resolved.length) {
									item.questions = resolved;
								}
							} else {
								// Legacy: full questions stored in questions_json
								const storedQs = JSON.parse(r.questions_json || "[]");
								if (Array.isArray(storedQs) && storedQs.length) {
									item.questions = storedQs.map(q => ({
										...q,
										question: q.question || "",
										options: Array.isArray(q.options) ? q.options : [],
										correctIndexes: Array.isArray(q.correctIndexes) ? q.correctIndexes : (typeof q.correctIndex === "number" ? [q.correctIndex] : [0]),
										solution: q.solution || q.explanation || q.sol || "",
										subject: q.subject || "",
										questionImage: q.questionImage || q.image || q.qImage || null,
										optionImages: q.optionImages || q.optImgs || null
									}));
								}
							}
						} catch { /* ignore parse errors */ }
					}
				} catch (e) {
					console.warn(`Failed to fetch questions for online_test_id ${item.online_test_id}:`, e.message);
				}
			}

			// Remove temporary _raw_row property
			delete item._raw_row;
			return item;
		}));

		// If paginated request (?page= or ?limit= provided), return wrapper object
		// Otherwise fall back to plain array for backward compatibility
		if (req.query.page || req.query.limit) {
			return res.json({
				data: historyWithQuestions,
				page,
				limit,
				total: totalCount,
				hasMore: offset + historyWithQuestions.length < totalCount
			});
		}
		return res.json(historyWithQuestions);
	} catch (e) {
		console.error("GET /api/test-history/:mobile error:", e.message);
		return res.status(500).json({ error: e.message });
	}
});

// ── PUBLIC: Get leaderboard stats for a test (topper + avg marks) ────────────
router.get('/api/test-leaderboard', async (req, res) => {
	try {
		const { chapter, lecture, online_test_id } = req.query;
		let rows;
		if (online_test_id && Number.isFinite(Number(online_test_id))) {
			rows = await db.execute({
				sql: 'SELECT marks_score, accuracy_pct FROM test_history WHERE online_test_id = ?',
				args: [Number(online_test_id)]
			});
		} else if (lecture) {
			rows = await db.execute({
				sql: 'SELECT marks_score, accuracy_pct FROM test_history WHERE chapter = ? AND lecture = ?',
				args: [chapter || null, String(lecture)]
			});
		} else {
			return res.status(400).json({ error: 'chapter+lecture or online_test_id required' });
		}
		if (!rows.rows.length) return res.json({ topper: null, avg: null, attempts: 0 });
		const scores = rows.rows.map(r => Number(r.marks_score) || 0);
		const topper = Math.max(...scores);
		const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
		const avgAcc = Math.round(rows.rows.reduce((s, r) => s + (Number(r.accuracy_pct) || 0), 0) / rows.rows.length);
		res.json({ topper, avg, avgAcc, attempts: rows.rows.length });
	} catch (e) {
		res.status(500).json({ error: e.message || 'Failed' });
	}
});


// Extract the year from the first question that has one
function extractYearFromQuestions(questions) {
	if (!Array.isArray(questions)) return null;
	for (const q of questions) {
		if (q?.year && String(q.year).trim()) return String(q.year).trim();
	}
	return null;
}


// ── PUBLIC STAR QUIZ ROUTES (Student Portal) ─────────────────────────────────

router.get("/api/star-quiz/chapters", async (req, res) => {
	try {
		const result = await db.execute("SELECT DISTINCT chapter FROM star_quiz_questions WHERE chapter IS NOT NULL AND chapter != '' ORDER BY chapter");
		res.json(result.rows.map(r => r.chapter));
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/star-quiz/lectures/:chapter", async (req, res) => {
	try {
		const chapter = decodeURIComponent(req.params.chapter || "");
		const result = await db.execute({ sql: "SELECT lecture FROM star_quiz_questions WHERE chapter = ? ORDER BY CAST(lecture AS INTEGER)", args: [chapter] });
		const lectures = result.rows.map(r => String(r.lecture)).filter(Boolean);
		res.json(lectures);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

router.get("/api/star-quiz/question/:chapter/:lecture", async (req, res) => {
	try {
		const rawChapter = decodeURIComponent(req.params.chapter || "");
		const lecture = decodeURIComponent(req.params.lecture || "");
		// "_none_" or empty string means no chapter (stored as NULL or "" in DB)
		const chapter = (rawChapter === "_none_" || rawChapter === "") ? null : rawChapter;
		const result = chapter
			? await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] })
			: await db.execute({ sql: "SELECT * FROM star_quiz_questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
		if (!result.rows.length) return res.status(404).json({ error: "Not found" });
		const normalized = normalizeQuestionRow(result.rows[0]);
		const { accessCode, ...safeData } = normalized; // never expose the code to client
		res.json(safeData);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// Validate access code (student submits code, server checks)
router.post("/api/star-quiz/verify-code", async (req, res) => {
	try {
		const { chapter, lecture, code } = req.body || {};
		if (!chapter || !lecture || !code) return res.status(400).json({ error: "Missing fields" });
		const result = await db.execute({ sql: "SELECT access_code FROM star_quiz_questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
		if (!result.rows.length) return res.status(404).json({ error: "Lecture not found" });
		const stored = result.rows[0].access_code;
		if (!stored) return res.json({ valid: true }); // no code set = open
		res.json({ valid: String(stored) === String(code) });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

/* ══════════════════════════════════════════════════════════════════════════
   REGISTERED STUDENTS — Admin manages roll numbers; students self-register
══════════════════════════════════════════════════════════════════════════ */

// Helper: generate a simple random token

// ── STUDENT: get online tests assigned to me (fast — no questions_json in list) ──
router.get("/api/student/online-tests", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		const roll = row.roll_number;
		const now = Date.now();
		// Fetch metadata only — skip the heavy questions_json column for the list
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, created_at, duration_minutes, question_count, max_attempts, is_strict FROM online_tests WHERE ends_at >= ? ORDER BY created_at DESC",
			args: [now],
		});
		const tests = result.rows
			.filter(r => {
				try {
					const rolls = JSON.parse(r.assigned_rolls || "[]");
					return rolls.includes(roll);
				} catch { return false; }
			})
			.map(r => ({
				id: r.id,
				testName: r.test_name,
				marksCorrect: r.marks_correct,
				marksWrong: r.marks_wrong,
				liveAt: r.live_at,
				endsAt: r.ends_at,
				isUpcoming: r.live_at > now,
				durationMinutes: r.duration_minutes || 90,
				questionCount: r.question_count || 0,
				maxAttempts: r.max_attempts || 1,
				isStrict: !!(r.is_strict),
				// questions are NOT sent here — fetched separately when student starts test
			}));
		res.json(tests);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: fetch questions for a specific online test (called at test start) ─
router.get("/api/student/online-tests/:id/questions", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		const roll = row.roll_number;
		const testId = Number(req.params.id);
		if (!Number.isFinite(testId)) return res.status(400).json({ error: "Invalid test id" });
		const now = Date.now();
		const result = await db.execute({
			sql: "SELECT id, test_name, marks_correct, marks_wrong, live_at, ends_at, assigned_rolls, duration_minutes, question_keys_json, questions_json, max_attempts, is_strict FROM online_tests WHERE id = ? AND ends_at >= ? LIMIT 1",
			args: [testId, now],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Test not found or expired" });
		const r = result.rows[0];
		// Verify this student is assigned
		try {
			const rolls = JSON.parse(r.assigned_rolls || "[]");
			if (!rolls.includes(roll)) return res.status(403).json({ error: "Not assigned to this test" });
		} catch { return res.status(403).json({ error: "Not assigned" }); }
		// Block questions if test hasn't started yet
		if (r.live_at > now) return res.status(403).json({ error: "Test not live yet" });

		// Resolve questions: prefer question_keys_json (no duplication); fall back to questions_json (legacy)
		let questions = [];
		try {
			const keys = JSON.parse(r.question_keys_json || "[]");
			if (Array.isArray(keys) && keys.length) {
				questions = await resolveQuestionKeys(keys);
			} else {
				// Legacy: full questions stored directly
				questions = JSON.parse(r.questions_json || "[]");
			}
		} catch { questions = []; }

		res.json({
			id: r.id,
			testName: r.test_name,
			marksCorrect: r.marks_correct,
			marksWrong: r.marks_wrong,
			durationMinutes: r.duration_minutes || 90,
			maxAttempts: r.max_attempts || 1,
			isStrict: !!(r.is_strict),
			questions,
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

function genToken() {
	return crypto.randomBytes(32).toString("hex");
}

// Helper: get student from token sent in Authorization header.
// Now also resolves the student's institute_id so callers can scope queries.
async function getStudentFromToken(req) {
	const auth = req.headers["authorization"] || "";
	const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	if (!token) return null;
	const now = Date.now();
	const result = await db.execute({
		sql: "SELECT roll_number, institute_id FROM student_sessions WHERE token = ? AND expires > ?",
		args: [token, now],
	});
	if (!result.rows.length) return null;
	const roll = result.rows[0].roll_number;
	const sessionInstId = result.rows[0].institute_id || null;
	// Prefer institute-scoped lookup when the session has one bound; fall back
	// to a generic lookup only if the session predates the migration.
	let stu;
	if (sessionInstId) {
		stu = await db.execute({
			sql: "SELECT * FROM registered_students WHERE roll_number = ? AND institute_id = ? LIMIT 1",
			args: [roll, sessionInstId],
		});
	} else {
		stu = await db.execute({ sql: "SELECT * FROM registered_students WHERE roll_number = ? LIMIT 1", args: [roll] });
	}
	return stu.rows[0] || null;
}


// ── STUDENT: verify roll number (step 1 of login) ───────────────────────────
// Institute-scoped: the student app MUST pass instituteCode so we look the
// roll up only inside that institute. This lets two institutes reuse the
// same roll number without collisions.
router.post("/api/student/verify-roll", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const instituteCode = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!instituteCode) return res.status(400).json({ error: "Institute is required" });

		// Resolve the institute id from the supplied code.
		const instR = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [instituteCode] });
		if (!instR.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = instR.rows[0].id;

		// Check registered_students inside this institute only.
		const result = await db.execute({
			sql: "SELECT id, profile_complete FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (result.rows.length) {
			return res.json({ valid: true, profileComplete: !!result.rows[0].profile_complete });
		}

		// Check if already in pending requests for this institute.
		const req2 = await db.execute({
			sql: "SELECT id FROM student_requests WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (req2.rows.length) {
			return res.json({ valid: false, pendingApproval: true });
		}

		// Not registered and no pending request — allow them to fill profile (will become a request)
		return res.json({ valid: false, notRegistered: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: submit access request (for unregistered students) ──────────────
router.post("/api/student/submit-request", rateLimit(60 * 1000, 5), async (req, res) => {
	try {
		const { rollNumber, name, className, phone, age, dateOfBirth, instituteCode } = req.body || {};
		if (!rollNumber || !name) return res.status(400).json({ error: "Roll number and name are required" });
		const roll = String(rollNumber).trim();

		// Institute is now REQUIRED — every student request must belong to one.
		const codeStr = String(instituteCode || "").trim().toUpperCase();
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });
		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		// If already registered in this institute, reject (should use normal save-profile)
		const existing = await db.execute({
			sql: "SELECT id FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (existing.rows.length) return res.status(409).json({ error: "This roll number is already registered. Please log in normally." });

		const now = Date.now();
		try {
			await db.execute({
				sql: `INSERT INTO student_requests (roll_number, institute_id, name, class_name, phone, age, date_of_birth, requested_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [roll, instId, String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
					String(age || "").trim(), String(dateOfBirth || "").trim(), now],
			});
		} catch (_) {
			// UNIQUE constraint on (roll_number, institute_id) — update existing.
			await db.execute({
				sql: `UPDATE student_requests SET name=?, class_name=?, phone=?, age=?, date_of_birth=?, requested_at=? WHERE roll_number=? AND institute_id=?`,
				args: [String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
					String(age || "").trim(), String(dateOfBirth || "").trim(), now, roll, instId],
			});
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


// ── STUDENT: check request status (for pending approval screen) ──────────────
// Institute-scoped: same roll number can exist in two institutes, so we must
// know which one to check.
router.post("/api/student/check-request-status", rateLimit(60 * 1000, 20), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const codeStr = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		// Check if now approved (in registered_students with profile_complete)
		const reg = await db.execute({
			sql: "SELECT id, profile_complete FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (reg.rows.length && reg.rows[0].profile_complete) {
			return res.json({ approved: true });
		}

		// Check still pending
		const pending = await db.execute({
			sql: "SELECT id FROM student_requests WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (pending.rows.length) return res.json({ approved: false, pending: true });

		// Neither — was rejected
		return res.json({ approved: false, pending: false, rejected: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


router.post("/api/student/save-profile", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const { rollNumber, name, className, phone, age, dateOfBirth, instituteCode } = req.body || {};
		if (!rollNumber || !name) return res.status(400).json({ error: "Roll number and name are required" });
		const codeStr = String(instituteCode || "").trim().toUpperCase();
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		const roll = String(rollNumber).trim();
		const check = await db.execute({
			sql: "SELECT id FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (!check.rows.length) return res.status(404).json({ error: "Roll number not registered in this institute" });
		const now = Date.now();
		await db.execute({
			sql: `UPDATE registered_students SET name=?, class_name=?, phone=?, age=?, date_of_birth=?, profile_complete=1, updated_at=?
			      WHERE roll_number=? AND institute_id=?`,
			args: [String(name).trim(), String(className || "").trim(), String(phone || "").trim(),
			String(age || "").trim(), String(dateOfBirth || "").trim(), now, roll, instId],
		});
		// Create a session token valid for 30 days (bound to this institute)
		const token = genToken();
		const expires = now + 30 * 24 * 60 * 60 * 1000;
		await db.execute({
			sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
			args: [token, roll, instId, expires],
		});
		res.json({ success: true, token });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: login with existing profile (roll number + institute) ──────────
// Institute-scoped: the student app must pass instituteCode so two institutes
// can reuse the same roll number without ambiguity.
router.post("/api/student/login", rateLimit(60 * 1000, 10), async (req, res) => {
	try {
		const roll = String(req.body?.rollNumber || "").trim();
		const codeStr = String(req.body?.instituteCode || "").trim().toUpperCase();
		if (!roll) return res.status(400).json({ error: "Roll number required" });
		if (!codeStr) return res.status(400).json({ error: "Institute is required" });

		const ir = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ? LIMIT 1", args: [codeStr] });
		if (!ir.rows.length) return res.status(404).json({ error: "Institute not found" });
		const instId = ir.rows[0].id;

		const result = await db.execute({
			sql: "SELECT * FROM registered_students WHERE roll_number = ? AND institute_id = ?",
			args: [roll, instId],
		});
		if (!result.rows.length) return res.status(404).json({ error: "Roll number not found in this institute" });
		const row = result.rows[0];
		if (!row.profile_complete) return res.json({ needsProfile: true });
		const token = genToken();
		const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
		await db.execute({
			sql: "INSERT INTO student_sessions (token, roll_number, institute_id, expires) VALUES (?, ?, ?, ?)",
			args: [token, roll, instId, expires],
		});
		res.json({
			success: true, token,
			student: { rollNumber: row.roll_number, name: row.name, className: row.class_name, phone: row.phone, age: row.age, dateOfBirth: row.date_of_birth },
		});
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: get own profile ─────────────────────────────────────────────────
router.get("/api/student/me", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		res.json({ rollNumber: row.roll_number, name: row.name, className: row.class_name, phone: row.phone, age: row.age, dateOfBirth: row.date_of_birth });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: update own profile ──────────────────────────────────────────────
router.post("/api/student/update-profile", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		const { name, className, phone, age, dateOfBirth } = req.body || {};
		if (!name) return res.status(400).json({ error: "Name is required" });
		await db.execute({
			sql: "UPDATE registered_students SET name=?, class_name=?, phone=?, age=?, date_of_birth=?, updated_at=? WHERE roll_number=?",
			args: [String(name).trim(), String(className || "").trim(), String(phone || "").trim(), String(age || "").trim(), String(dateOfBirth || "").trim(), Date.now(), row.roll_number],
		});
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: logout ───────────────────────────────────────────────────────────
router.post("/api/student/logout", async (req, res) => {
	try {
		const auth = req.headers["authorization"] || "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
		if (token) await db.execute({ sql: "DELETE FROM student_sessions WHERE token = ?", args: [token] });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});

// ── STUDENT: get assigned tests (star quiz sets) ────────────────────────────
router.get("/api/student/assigned-tests", async (req, res) => {
	try {
		const row = await getStudentFromToken(req);
		if (!row) return res.status(401).json({ error: "Not authenticated" });
		const attemptsResult = await db.execute({
			sql: "SELECT chapter, lecture FROM test_history WHERE mobile = ?",
			args: [row.roll_number]
		});
		const attemptedSet = new Set(attemptsResult.rows.map(r => `${r.chapter || ''}||${r.lecture || ''}`));
		// Return all available star quiz sets with light metadata for the start popup
		const result = await db.execute("SELECT chapter, lecture, topic, updated_at, questions_json FROM star_quiz_questions ORDER BY chapter, CAST(lecture AS INTEGER)");
		const tests = result.rows.map(r => ({
			chapter: r.chapter,
			lecture: r.lecture,
			topic: r.topic || "",
			updatedAt: r.updated_at,
			isAttempted: attemptedSet.has(`${r.chapter || ''}||${r.lecture || ''}`),
			questionCount: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return Array.isArray(q) ? q.length : 0;
				} catch {
					return 0;
				}
			})(),
			maxMarks: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return (Array.isArray(q) ? q.length : 0) * 4;
				} catch {
					return 0;
				}
			})(),
			maxTimeSec: (() => {
				try {
					const q = JSON.parse(r.questions_json || '[]');
					return (Array.isArray(q) ? q.length : 0) * 90;
				} catch {
					return 0;
				}
			})(),
		}));
		res.json(tests);
	} catch (e) {
		res.status(500).json({ error: e.message || "Failed" });
	}
});


module.exports = router;
