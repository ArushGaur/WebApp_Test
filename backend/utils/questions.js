const { db } = require("../config/db");
const { normalizeQuestionRow } = require("./helpers");

let questionCache = {};

async function loadQuestions() {
	const result = await db.execute("SELECT * FROM questions");
	questionCache = {};
	for (const row of result.rows) {
		const n = normalizeQuestionRow(row);
		if (n && Array.isArray(n.questions)) {
			questionCache[`${n.chapter || ""}::${n.lecture}`] = n;
		}
	}
	console.log(`Loaded ${Object.keys(questionCache).length} question sets into cache`);
}

async function refreshCache(chapter, lecture) {
	let result;
	if (chapter) {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
	} else {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
	}

	if (!result.rows.length) {
		delete questionCache[`${chapter || ""}::${lecture}`];
		return;
	}

	const n = normalizeQuestionRow(result.rows[0]);
	questionCache[`${chapter || ""}::${lecture}`] = n;
}

async function rebuildYearIndex(rowId, questions) {
	try {
		await db.execute({ sql: "DELETE FROM question_years WHERE row_id = ?", args: [rowId] });
		for (let i = 0; i < questions.length; i++) {
			const year = questions[i]?.year ? String(questions[i].year).trim() : null;
			if (year) {
				await db.execute({
					sql: "INSERT INTO question_years (row_id, year, question_index) VALUES (?, ?, ?)",
					args: [rowId, year, i]
				});
			}
		}
	} catch (e) {
		console.warn(`[rebuildYearIndex] row ${rowId}:`, e.message);
	}
}

async function findQuestion(chapter, lecture) {
	const key = `${chapter || ""}::${lecture}`;
	if (questionCache[key]) return questionCache[key];

	let result;
	if (chapter) {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE chapter = ? AND lecture = ? LIMIT 1", args: [chapter, lecture] });
	} else {
		result = await db.execute({ sql: "SELECT * FROM questions WHERE (chapter IS NULL OR chapter = '') AND lecture = ? LIMIT 1", args: [lecture] });
	}

	if (!result.rows.length) return null;
	const n = normalizeQuestionRow(result.rows[0]);
	questionCache[key] = n;
	return n;
}

module.exports = {
	loadQuestions,
	refreshCache,
	rebuildYearIndex,
	findQuestion,
	getQuestionCache: () => questionCache
};
