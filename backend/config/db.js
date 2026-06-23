const { createClient } = require("@libsql/client");

const _raw = createClient({
	url: process.env.TURSO_DATABASE_URL || "file:local.db",
	authToken: process.env.TURSO_AUTH_TOKEN || "",
});

async function _retry(fn, retries = 3) {
	for (let i = 0; i < retries; i++) {
		try { return await fn(); } catch (err) {
			const isSocket = err?.cause?.code === 'UND_ERR_SOCKET'
				|| err?.message?.includes('other side closed')
				|| err?.message?.includes('socket hang up');
			if (isSocket && i < retries - 1) {
				await new Promise(r => setTimeout(r, 500 * (i + 1)));
				continue;
			}
			throw err;
		}
	}
}

const db = new Proxy(_raw, {
	get(t, p) {
		const v = Reflect.get(t, p);
		if (typeof v !== 'function') return v;
		if (p !== 'execute' && p !== 'executeMultiple') return v.bind(t);
		return (...a) => _retry(() => v.apply(t, a));
	}
});

async function initDB(TEACHER_PASSCODE, hashPasscode) {
	await db.executeMultiple(`
		CREATE TABLE IF NOT EXISTS questions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chapter TEXT,
			lecture TEXT NOT NULL,
			topic TEXT DEFAULT '',
			questions_json TEXT NOT NULL DEFAULT '[]',
			updated_at INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_questions_chapter_lecture ON questions(chapter, lecture);
		CREATE INDEX IF NOT EXISTS idx_questions_lecture ON questions(lecture);

		-- NEW NORMALIZED QUESTION BANK — one row per question (not per topic).
		-- subject/chapter/topic/year are real, indexed columns so both
		-- chapter+topic browsing AND subject+year ("paper-wise") search are
		-- fast at 300k+ rows. Everything else a question needs (text, options,
		-- images, tables, correctIndexes, solution, etc.) lives in raw_json,
		-- in exactly the shape normalizeQuestion() in utils/helpers.js
		-- already produces — so no other code needs to change its data model.
		-- The OLD 'questions' table above is left untouched; migrate-to-v2.js
		-- reads from it once to populate this table, then you can drop the
		-- old table + question_years yourself once you've verified everything.
		CREATE TABLE IF NOT EXISTS questions_v2 (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			subject TEXT NOT NULL DEFAULT '',
			unit TEXT DEFAULT '',
			chapter TEXT DEFAULT '',
			topic TEXT DEFAULT '',
			year TEXT DEFAULT '',
			month TEXT DEFAULT '',
			day TEXT DEFAULT '',
			shift TEXT DEFAULT '',
			question_number INTEGER,
			question_type TEXT DEFAULT 'MCQ',
			raw_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER DEFAULT 0,
			updated_at INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_q2_chapter_topic ON questions_v2(chapter, topic);
		CREATE INDEX IF NOT EXISTS idx_q2_subject_year ON questions_v2(subject, year);
		CREATE INDEX IF NOT EXISTS idx_q2_chapter ON questions_v2(chapter);
		CREATE INDEX IF NOT EXISTS idx_q2_subject ON questions_v2(subject);
		CREATE INDEX IF NOT EXISTS idx_q2_year ON questions_v2(year);

		CREATE TABLE IF NOT EXISTS students (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mobile TEXT NOT NULL,
			lecture TEXT NOT NULL,
			name TEXT,
			place TEXT,
			class_name TEXT,
			chapter TEXT,
			answers_json TEXT DEFAULT '[]',
			correct_count INTEGER DEFAULT 0,
			total_questions INTEGER DEFAULT 0,
			time INTEGER DEFAULT 0,
			cheat_flag INTEGER DEFAULT 0,
			UNIQUE(mobile, lecture)
		);
		CREATE INDEX IF NOT EXISTS idx_students_mobile_lecture ON students(mobile, lecture);

		CREATE TABLE IF NOT EXISTS attempts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mobile TEXT NOT NULL,
			chapter TEXT,
			lecture TEXT NOT NULL,
			time INTEGER DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_attempts_mobile_lecture ON attempts(mobile, lecture);

		CREATE TABLE IF NOT EXISTS sessions (
			sid TEXT PRIMARY KEY,
			data TEXT NOT NULL,
			expires INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS star_quiz_questions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			chapter TEXT NOT NULL,
			lecture TEXT NOT NULL,
			topic TEXT DEFAULT '',
			questions_json TEXT NOT NULL DEFAULT '[]',
			updated_at INTEGER DEFAULT 0,
			access_code TEXT DEFAULT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_sqq_chapter_lecture ON star_quiz_questions(chapter, lecture);

		CREATE TABLE IF NOT EXISTS test_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			mobile TEXT NOT NULL,
			chapter TEXT,
			lecture TEXT NOT NULL,
			topic TEXT DEFAULT '',
			correct_count INTEGER DEFAULT 0,
			wrong_count INTEGER DEFAULT 0,
			skipped_count INTEGER DEFAULT 0,
			total_questions INTEGER DEFAULT 0,
			marks_score INTEGER DEFAULT 0,
			max_marks INTEGER DEFAULT 0,
			accuracy_pct INTEGER DEFAULT 0,
			grade TEXT DEFAULT '',
			time_taken INTEGER DEFAULT 0,
			scheme TEXT DEFAULT '+1/0',
			timestamp INTEGER DEFAULT 0,
			student_name TEXT DEFAULT '',
			student_class TEXT DEFAULT '',
			answers_json TEXT DEFAULT '[]'
		);
		CREATE INDEX IF NOT EXISTS idx_test_history_mobile ON test_history(mobile);
		CREATE INDEX IF NOT EXISTS idx_test_history_mobile_timestamp ON test_history(mobile, timestamp DESC);

		CREATE TABLE IF NOT EXISTS student_stats (
			mobile TEXT PRIMARY KEY,
			tests_completed INTEGER DEFAULT 0,
			avg_pct INTEGER DEFAULT 0,
			day_streak INTEGER DEFAULT 0,
			last_test INTEGER DEFAULT 0,
			updated_at INTEGER DEFAULT 0
		);
	`);
	// Add access_code column if it doesn't exist (safe migration)
	try {
		await db.execute("ALTER TABLE star_quiz_questions ADD COLUMN access_code TEXT DEFAULT NULL");
	} catch (_) { /* column already exists */ }
	// Add cheat_flag column if it does not exist (safe migration)
	try {
		await db.execute("ALTER TABLE students ADD COLUMN cheat_flag INTEGER DEFAULT 0");
	} catch (_) { /* already exists */ }
	// Create paper_templates table for persistent multi-template storage
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS paper_templates (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			docx_base64 TEXT NOT NULL,
			created_at INTEGER DEFAULT 0
		)`);
	} catch (_) { /* already exists */ }
	// Add institute_id column for per-institute template isolation
	try {
		await db.execute("ALTER TABLE paper_templates ADD COLUMN institute_id INTEGER DEFAULT NULL");
	} catch (_) { /* column already exists */ }
	// Create registered_students table — admin adds roll numbers, students fill details
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS registered_students (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_number TEXT NOT NULL UNIQUE,
			name TEXT DEFAULT '',
			class_name TEXT DEFAULT '',
			phone TEXT DEFAULT '',
			age TEXT DEFAULT '',
			date_of_birth TEXT DEFAULT '',
			profile_complete INTEGER DEFAULT 0,
			created_at INTEGER DEFAULT 0,
			updated_at INTEGER DEFAULT 0
		)`);
	} catch (_) { /* already exists */ }
	// student_sessions table — lightweight token store for student auth.
	// institute_id is added so a student session is bound to a specific institute
	// (two institutes can now reuse the same roll number without collision).
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS student_sessions (
			token TEXT PRIMARY KEY,
			roll_number TEXT NOT NULL,
			institute_id INTEGER DEFAULT NULL,
			expires INTEGER NOT NULL
		)`);
	} catch (_) { }
	// Safe migration if the column was missing from an older deploy.
	try { await db.execute("ALTER TABLE student_sessions ADD COLUMN institute_id INTEGER DEFAULT NULL"); } catch (_) { }
	// student_requests table — students not yet approved by admin
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS student_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_number TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL DEFAULT '',
			class_name TEXT DEFAULT '',
			phone TEXT DEFAULT '',
			age TEXT DEFAULT '',
			date_of_birth TEXT DEFAULT '',
			requested_at INTEGER DEFAULT 0
		)`);
	} catch (_) { }

	// online_tests table — admin-assigned tests with question keys + metadata
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS online_tests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			test_name TEXT NOT NULL DEFAULT 'Online Test',
			questions_json TEXT NOT NULL DEFAULT '[]',
			question_keys_json TEXT NOT NULL DEFAULT '[]',
			marks_correct INTEGER NOT NULL DEFAULT 4,
			marks_wrong INTEGER NOT NULL DEFAULT -1,
			live_at INTEGER DEFAULT 0,
			ends_at INTEGER DEFAULT 0,
			assigned_rolls TEXT NOT NULL DEFAULT '[]',
			created_at INTEGER DEFAULT 0
		)`);
	} catch (_) { }

	// Safe migrations for registered_students
	for (const col of [
		"ALTER TABLE registered_students ADD COLUMN name TEXT DEFAULT ''",
		"ALTER TABLE registered_students ADD COLUMN class_name TEXT DEFAULT ''",
		"ALTER TABLE registered_students ADD COLUMN phone TEXT DEFAULT ''",
		"ALTER TABLE registered_students ADD COLUMN age TEXT DEFAULT ''",
		"ALTER TABLE registered_students ADD COLUMN date_of_birth TEXT DEFAULT ''",
		"ALTER TABLE registered_students ADD COLUMN profile_complete INTEGER DEFAULT 0",
		"ALTER TABLE registered_students ADD COLUMN updated_at INTEGER DEFAULT 0",
	]) { try { await db.execute(col); } catch (_) { } }

	// Safe migrations for test_history table
	for (const col of [
		"ALTER TABLE test_history ADD COLUMN mobile TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN chapter TEXT DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN lecture TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN topic TEXT DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN correct_count INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN wrong_count INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN skipped_count INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN total_questions INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN marks_score INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN max_marks INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN accuracy_pct INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN grade TEXT DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN time_taken INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN scheme TEXT DEFAULT '+1/0'",
		"ALTER TABLE test_history ADD COLUMN timestamp INTEGER DEFAULT 0",
		"ALTER TABLE test_history ADD COLUMN student_name TEXT DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN student_class TEXT DEFAULT ''",
		"ALTER TABLE test_history ADD COLUMN answers_json TEXT DEFAULT '[]'",
		"ALTER TABLE test_history ADD COLUMN questions_json TEXT DEFAULT '[]'",
		"ALTER TABLE test_history ADD COLUMN online_test_id INTEGER DEFAULT NULL",
	]) { try { await db.execute(col); } catch (_) { } }
	// Add year column to questions table (safe migration)
	try { await db.execute("ALTER TABLE questions ADD COLUMN year TEXT DEFAULT NULL"); } catch (_) { /* already exists */ }
	// Migration: drop year column — year is now read from individual question objects in questions_json
	try { await db.execute("UPDATE questions SET year = NULL WHERE year IS NOT NULL"); } catch (_) { /* ignore */ }

	// ── question_years index table ────────────────────────────────────────────
	// Allows instant year-based lookups without scanning questions_json blobs.
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS question_years (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			row_id INTEGER NOT NULL,
			year TEXT NOT NULL,
			question_index INTEGER NOT NULL
		)`);
		await db.execute("CREATE INDEX IF NOT EXISTS idx_qy_row_id ON question_years(row_id)");
		await db.execute("CREATE INDEX IF NOT EXISTS idx_qy_year ON question_years(year)");
	} catch (_) { /* already exists */ }

	// ── Backfill question_years from existing questions rows ──────────────────
	try {
		const existingCount = await db.execute("SELECT COUNT(*) as cnt FROM question_years");
		if (!existingCount.rows[0]?.cnt) {
			console.log("[backfill] Populating question_years index...");
			const allRows = await db.execute("SELECT id, questions_json FROM questions");
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
				} catch (_) { /* skip corrupted row */ }
			}
			console.log(`[backfill] question_years: indexed ${indexed} questions`);
		}
	} catch (e) {
		console.warn("[backfill] question_years backfill failed:", e.message);
	}

	// Safe migrations for online_tests table
	for (const col of [
		"ALTER TABLE online_tests ADD COLUMN duration_minutes INTEGER DEFAULT 90",
		"ALTER TABLE online_tests ADD COLUMN question_count INTEGER DEFAULT 0",
		"ALTER TABLE online_tests ADD COLUMN question_keys_json TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE online_tests ADD COLUMN max_attempts INTEGER DEFAULT 1",
		"ALTER TABLE online_tests ADD COLUMN is_strict INTEGER DEFAULT 0"
	]) { try { await db.execute(col); } catch (_) { } }
	// Backfill question_count for existing rows
	try {
		const rows = await db.execute("SELECT id, question_keys_json, questions_json FROM online_tests WHERE question_count = 0 OR question_count IS NULL");
		for (const r of rows.rows) {
			try {
				// Prefer question_keys_json length; fall back to questions_json
				let count = 0;
				const keys = JSON.parse(r.question_keys_json || "[]");
				if (Array.isArray(keys) && keys.length) {
					count = keys.length;
				} else {
					const qs = JSON.parse(r.questions_json || "[]");
					if (Array.isArray(qs)) count = qs.length;
				}
				if (count) {
					await db.execute({ sql: "UPDATE online_tests SET question_count = ? WHERE id = ?", args: [count, r.id] });
				}
			} catch { /* skip */ }
		}
	} catch { /* ignore backfill errors */ }

	// ──────────────────────────────────────────────────────────────────────────
	// MULTI-INSTITUTE (multi-client) SUPPORT
	// Each institute is a separate client/tenant. All student data is scoped to an
	// institute via an institute_id column. A "Default Institute" (code DEFAULT)
	// owns every pre-existing row so legacy data keeps working.
	// ──────────────────────────────────────────────────────────────────────────
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS institutes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			code TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			logo_url TEXT DEFAULT '',
			passcode_hash TEXT NOT NULL DEFAULT '',
			permissions_json TEXT NOT NULL DEFAULT '{}',
			plan_expires_at INTEGER DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'active',
			created_at INTEGER DEFAULT 0
		)`);
		await db.execute("CREATE INDEX IF NOT EXISTS idx_institutes_code ON institutes(code)");
	} catch (_) { /* already exists */ }

	// Safe migrations: add teacher_passcode_hash column to institutes table if missing,
	// and backfill it with passcode_hash.
	try {
		await db.execute(`ALTER TABLE institutes ADD COLUMN teacher_passcode_hash TEXT DEFAULT ''`);
	} catch (_) { /* column already exists */ }
	try {
		await db.execute(`UPDATE institutes SET teacher_passcode_hash = passcode_hash WHERE teacher_passcode_hash IS NULL OR teacher_passcode_hash = ''`);
	} catch (_) { /* already backfilled */ }

	// Ensure the Default Institute exists (code DEFAULT). Its passcode mirrors the
	// legacy TEACHER_PASSCODE so existing client.html logins keep working.
	let defaultInstituteId = null;
	try {
		const existing = await db.execute({ sql: "SELECT id FROM institutes WHERE code = ?", args: ["DEFAULT"] });
		if (existing.rows.length) {
			defaultInstituteId = existing.rows[0].id;
		} else {
			const now = Date.now();
			const defPerms = JSON.stringify({ onlineTests: true, starQuiz: true, paperGenerator: true, questionBank: true });
			const ins = await db.execute({
				sql: `INSERT INTO institutes (code, name, logo_url, passcode_hash, teacher_passcode_hash, permissions_json, plan_expires_at, status, created_at)
				      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: ["DEFAULT", "Grip Physics", "", hashPasscode(TEACHER_PASSCODE), hashPasscode(TEACHER_PASSCODE), defPerms, 0, "active", now],
			});
			defaultInstituteId = Number(ins.lastInsertRowid);
		}
	} catch (e) {
		console.warn("[institutes] default institute setup failed:", e.message);
	}

	// Add institute_id column to every student-data table (safe migration), then
	// backfill any NULL/0 rows to the Default Institute.
	const instituteScopedTables = [
		"students", "attempts", "test_history", "student_stats",
		"registered_students", "student_requests", "student_sessions", "online_tests",
	];
	for (const tbl of instituteScopedTables) {
		try { await db.execute(`ALTER TABLE ${tbl} ADD COLUMN institute_id INTEGER DEFAULT NULL`); } catch (_) { /* exists */ }
	}
	if (defaultInstituteId) {
		for (const tbl of instituteScopedTables) {
			try {
				await db.execute({
					sql: `UPDATE ${tbl} SET institute_id = ? WHERE institute_id IS NULL OR institute_id = 0`,
					args: [defaultInstituteId],
				});
			} catch (e) { console.warn(`[institutes] backfill ${tbl} failed:`, e.message); }
		}
		// Helpful indexes for institute-scoped lookups
		for (const tbl of instituteScopedTables) {
			try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_${tbl}_institute ON ${tbl}(institute_id)`); } catch (_) { }
		}
	}

	// ── Per-institute roll-number uniqueness ────────────────────────────────────
	// The original schema declared `roll_number TEXT NOT NULL UNIQUE` which made
	// roll numbers globally unique. That broke multi-tenant use: two institutes
	// could not reuse the same roll number even though they're isolated tenants.
	//
	// We rebuild the table dropping the column-level UNIQUE constraint and add a
	// composite UNIQUE INDEX on (roll_number, institute_id) so each institute has
	// its own roll-number namespace.
	async function rebuildForPerInstituteRolls(tableName) {
		try {
			// Detect whether the current table still has the global UNIQUE on roll_number.
			const info = await db.execute(`PRAGMA table_info(${tableName})`);
			if (!info.rows.length) return;
			// Look at the CREATE statement to decide whether a rebuild is needed.
			const ddlR = await db.execute({
				sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
				args: [tableName],
			});
			const ddl = (ddlR.rows[0]?.sql || "").toString();
			// If the original column-level UNIQUE is gone we have nothing to do.
			const needsRebuild = /roll_number\s+TEXT[^,]*UNIQUE/i.test(ddl);
			if (!needsRebuild) {
				// Just make sure the composite unique index exists.
				try { await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${tableName}_roll_inst ON ${tableName}(roll_number, institute_id)`); } catch (_) { }
				return;
			}
			console.log(`[migrate] Rebuilding ${tableName} to drop global UNIQUE(roll_number)…`);

			const cols = info.rows.map(r => r.name);
			const colList = cols.join(", ");

			// Build a new CREATE TABLE without the UNIQUE on roll_number, but
			// preserve the rest of the columns and their types.
			const colDefs = info.rows.map(r => {
				const name = r.name;
				const type = r.type || "";
				const notnull = r.notnull ? " NOT NULL" : "";
				const dflt = (r.dflt_value !== null && r.dflt_value !== undefined) ? ` DEFAULT ${r.dflt_value}` : "";
				const pk = r.pk ? " PRIMARY KEY AUTOINCREMENT" : "";
				return `${name} ${type}${pk}${notnull}${dflt}`;
			}).join(", ");

			await db.execute("BEGIN");
			try {
				await db.execute(`CREATE TABLE ${tableName}_new (${colDefs})`);
				await db.execute(`INSERT INTO ${tableName}_new (${colList}) SELECT ${colList} FROM ${tableName}`);
				await db.execute(`DROP TABLE ${tableName}`);
				await db.execute(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);
				await db.execute("COMMIT");
			} catch (e) {
				try { await db.execute("ROLLBACK"); } catch (_) { }
				throw e;
			}

			// Re-create the institute index + composite unique index.
			try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_${tableName}_institute ON ${tableName}(institute_id)`); } catch (_) { }
			try { await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS ux_${tableName}_roll_inst ON ${tableName}(roll_number, institute_id)`); } catch (_) { }
			console.log(`[migrate] ${tableName} rebuilt — roll numbers are now unique per institute.`);
		} catch (e) {
			console.warn(`[migrate] rebuild ${tableName} failed:`, e.message);
		}
	}
	await rebuildForPerInstituteRolls("registered_students");
	await rebuildForPerInstituteRolls("student_requests");

	// ── Classes & Batches for Attendance ────────────────────────────────────
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS classes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			institute_id INTEGER DEFAULT NULL,
			created_at INTEGER DEFAULT 0
		)`);
	} catch (_) { /* already exists */ }
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS batches (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			class_id INTEGER NOT NULL,
			institute_id INTEGER DEFAULT NULL,
			created_at INTEGER DEFAULT 0
		)`);
	} catch (_) { /* already exists */ }
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS attendance (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			class_id INTEGER NOT NULL,
			batch_id INTEGER DEFAULT NULL,
			roll_number TEXT NOT NULL,
			date TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'present',
			institute_id INTEGER DEFAULT NULL,
			marked_by TEXT DEFAULT '',
			marked_at INTEGER DEFAULT 0,
			UNIQUE(roll_number, date)
		)`);
	} catch (_) { /* already exists */ }
	try {
		await db.execute(`CREATE TABLE IF NOT EXISTS notifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			roll_number TEXT NOT NULL,
			message TEXT NOT NULL,
			type TEXT DEFAULT 'attendance',
			is_read INTEGER DEFAULT 0,
			institute_id INTEGER DEFAULT NULL,
			created_at INTEGER DEFAULT 0
		)`);
	} catch (_) { /* already exists */ }
	// Safe migrations for registered_students: add batch_id
	try { await db.execute("ALTER TABLE registered_students ADD COLUMN batch_id INTEGER DEFAULT NULL"); } catch (_) { }

	// Institute-scoped indexes for new tables
	for (const tbl of ["classes", "batches", "attendance", "notifications"]) {
		try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_${tbl}_institute ON ${tbl}(institute_id)`); } catch (_) { }
	}
	try { await db.execute("CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)"); } catch (_) { }
	try { await db.execute("CREATE INDEX IF NOT EXISTS idx_notifications_roll ON notifications(roll_number, is_read)"); } catch (_) { }

	console.log("Turso DB initialized");
	return defaultInstituteId;
}

module.exports = {
	db,
	initDB,
};