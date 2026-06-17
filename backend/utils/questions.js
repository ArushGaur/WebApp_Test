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

async function resolveQuestionKeys(keys) {
	if (!Array.isArray(keys) || !keys.length) return [];
	const groups = {};
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i];
		const gk = `${k.chapter || ""}::${k.lecture}`;
		if (!groups[gk]) groups[gk] = [];
		groups[gk].push(i);
	}
	const result = new Array(keys.length);
	for (const gk of Object.keys(groups)) {
		const sep = gk.indexOf("::");
		const chapter = sep > 0 ? gk.slice(0, sep) : "";
		const lecture = gk.slice(sep + 2);
		const qSet = await findQuestion(chapter, lecture);
		if (!qSet || !Array.isArray(qSet.questions)) continue;
		for (const idx of groups[gk]) {
			const qIdx = keys[idx].questionIndex;
			if (Number.isInteger(qIdx) && qIdx >= 0 && qIdx < qSet.questions.length) {
				result[idx] = qSet.questions[qIdx];
			}
		}
	}
	return result.filter(Boolean);
}

module.exports = {
	loadQuestions,
	refreshCache,
	rebuildYearIndex,
	findQuestion,
	resolveQuestionKeys,
	getQuestionCache: () => questionCache
};
