const express = require("express");
const router = express.Router();
const fs = require("fs");
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const PDFDocument = require("pdfkit");
const JSZip = require("jszip");
const { db } = require("../config/db");
const helpers = require("../utils/helpers");
const { requireAdmin } = require("../middleware/auth");
const { loadQuestions, refreshCache, rebuildYearIndex, findQuestion } = require("../utils/questions");

const {
    Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
    AlignmentType, HeadingLevel, BorderStyle, WidthType, ShadingType,
    VerticalAlign, PageNumber, Header, Footer, PageBreak, LevelFormat, TabStopType
} = require("docx");

let latexToOMML = null;
try {
    ({ latexToOMML } = require("latex-to-omml"));
} catch (e) {}

async function resolveImageBuffer(imgSrc) {
	if (!imgSrc) return null;
	try {
		if (imgSrc.startsWith("http://") || imgSrc.startsWith("https://")) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
			try {
				const r = await fetch(imgSrc, { signal: controller.signal });
				clearTimeout(timeout);
				if (!r.ok) {
					console.warn(`[resolveImageBuffer] HTTP ${r.status} for: ${imgSrc}`);
					return null;
				}
				const ab = await r.arrayBuffer();
				return Buffer.from(ab);
			} catch (fetchErr) {
				clearTimeout(timeout);
				console.warn(`[resolveImageBuffer] fetch failed for: ${imgSrc} —`, fetchErr.message);
				return null;
			}
		}
		// strip data-uri prefix if present
		const b64 = imgSrc.replace(/^data:[^;]+;base64,/, "");
		return Buffer.from(b64, "base64");
	} catch (e) {
		console.warn(`[resolveImageBuffer] error:`, e.message);
		return null;
	}
}

function imgType(src) {
	if (!src) return "jpg";
	if (src.startsWith("data:image/png") || src.includes("iVBOR")) return "png";
	if (src.startsWith("data:image/gif") || src.includes("R0lGOD")) return "gif";
	if (src.startsWith("data:image/webp")) return "jpg"; // fallback
	// Handle URLs: detect extension from path
	try {
		const pathname = new URL(src).pathname.toLowerCase();
		if (pathname.endsWith(".png")) return "png";
		if (pathname.endsWith(".gif")) return "gif";
		if (pathname.endsWith(".webp")) return "jpg"; // fallback
	} catch { }
	return "jpg";
}

// Decode HTML entities that may be stored in question text from AI extraction.
function decodeHtmlEntities(s) {
	return String(s || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function normalizePaperQuestions(selectedQuestions) {
	return (Array.isArray(selectedQuestions) ? selectedQuestions : []).map((item, index) => {
		const source = item && typeof item === "object" ? item : {};
		const questionSource = source.q && typeof source.q === "object" ? source.q : source;
		const options = Array.isArray(questionSource.options)
			? questionSource.options
			: [questionSource.option_a, questionSource.option_b, questionSource.option_c, questionSource.option_d];
		const normalizedOptions = options.map((opt) => decodeHtmlEntities(String(opt ?? "")));
		const correctIndexes = Array.isArray(questionSource.correctIndexes) && questionSource.correctIndexes.length
			? questionSource.correctIndexes
			: [typeof questionSource.correctIndex === "number" ? questionSource.correctIndex : 0];

		return {
			chapter: String(source.chapter ?? questionSource.chapter ?? "").trim(),
			topic: String(source.topic ?? questionSource.topic ?? "").trim(),
			lecture: String(source.lecture ?? questionSource.lecture ?? "").trim(),
			qNum: Number.isInteger(source.qNum) ? source.qNum : (index + 1),
			questionIndex: source.questionIndex,
			q: {
				...questionSource,
				question: decodeHtmlEntities(String(questionSource.question ?? "")),
				options: normalizedOptions,
				correctIndexes: correctIndexes
					.map((n) => parseInt(n, 10))
					.filter((n) => Number.isInteger(n) && n >= 0 && n < 4),
				questionImage: questionSource.questionImage ?? null,
				optionImages: Array.isArray(questionSource.optionImages) ? questionSource.optionImages.slice(0, 4) : [],
				solutions: Array.isArray(questionSource.solutions) ? questionSource.solutions.map(sol => ({
					...sol,
					text: decodeHtmlEntities(String(sol.text || "")),
					content: decodeHtmlEntities(String(sol.content || "")),
				})) : [],
			},
		};
	});
}

/**
 * Decode common HTML entities and trim. Shared by table + question builders.
 */
function docxStripMath(s) {
	return String(s || "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, "\"")
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.trim();
}

// Detect an image-cell object { text, image, imageNeeded } inside a table cell.
function isDocxImageCell(c) {
	return c && typeof c === "object" && !Array.isArray(c) &&
		("image" in c || c.imageNeeded === true || c.image_needed === true);
}

/**
 * Build the children (Paragraphs) for a single table cell. A cell may be a
 * plain string OR an image-cell object { text, image }. When the cell carries
 * an image, the image is embedded (resolved via resolveImageBuffer) with an
 * optional caption underneath. Returns an array of Paragraph elements.
 */
async function buildTableCellChildren(cell, isHeader, fontSize) {
	if (isDocxImageCell(cell)) {
		const children = [];
		const buf = cell.image ? await resolveImageBuffer(
			String(cell.image).startsWith("data:") || String(cell.image).startsWith("http")
				? String(cell.image) : `data:image/jpeg;base64,${cell.image}`
		) : null;
		if (buf) {
			children.push(new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: 20, after: cell.text ? 0 : 20 },
				children: [new ImageRun({ data: buf, transformation: { width: 90, height: 70 }, type: imgType(String(cell.image)) })],
			}));
		}
		const capText = docxStripMath(cell.text || "");
		if (capText || !buf) {
			children.push(new Paragraph({
				alignment: AlignmentType.CENTER,
				spacing: { before: buf ? 0 : 20, after: 20 },
				children: [new TextRun({ text: capText || (buf ? "" : "[image]"), bold: !!isHeader, font: "Arial", size: fontSize })],
			}));
		}
		return children.length ? children : [new Paragraph({ children: [] })];
	}
	return [new Paragraph({
		alignment: AlignmentType.CENTER,
		spacing: { before: 20, after: 20 },
		children: [new TextRun({ text: docxStripMath(cell || ""), bold: !!isHeader, font: "Arial", size: fontSize })],
	})];
}

/**
 * Build a docx Table element from a { headers, rows, caption } table object.
 * Inline $...$ math inside cells is preserved as text so the OMML post-processor
 * can convert it. Cells may be image-cell objects (embedded as pictures).
 * Returns an array of docx elements (optional caption + table + spacer).
 * `opts.compact` renders a tighter table for use inside an answer option.
 */
async function buildTableElement(tbl, opts = {}) {
	const elements = [];
	if (!tbl || typeof tbl !== "object") return elements;
	const compact = !!opts.compact;
	const fontSize = compact ? 18 : 20;
	const headers = Array.isArray(tbl.headers) ? tbl.headers : [];
	const rows = Array.isArray(tbl.rows) ? tbl.rows.filter((r) => Array.isArray(r)) : [];
	if (!headers.length && !rows.length) return elements;

	// Determine column count from the widest row / header.
	let colCount = headers.length;
	for (const r of rows) colCount = Math.max(colCount, r.length);
	if (colCount === 0) return elements;

	const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
	const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

	const makeCell = async (content, isHeader) => new TableCell({
		borders: cellBorders,
		verticalAlign: VerticalAlign.CENTER,
		shading: isHeader ? { fill: "E8E8F0", type: ShadingType.CLEAR, color: "auto" } : undefined,
		margins: { top: 40, bottom: 40, left: 80, right: 80 },
		children: await buildTableCellChildren(content, isHeader, fontSize),
	});

	const docxRows = [];
	if (headers.length) {
		const cells = [];
		for (let c = 0; c < colCount; c++) cells.push(await makeCell(headers[c] ?? "", true));
		docxRows.push(new TableRow({ tableHeader: true, children: cells }));
	}
	for (const r of rows) {
		const cells = [];
		for (let c = 0; c < colCount; c++) cells.push(await makeCell(r[c] ?? "", false));
		docxRows.push(new TableRow({ children: cells }));
	}

	if (tbl.caption) {
		elements.push(new Paragraph({
			spacing: { before: 80, after: 40 },
			children: [new TextRun({ text: docxStripMath(tbl.caption), italics: true, font: "Arial", size: fontSize, color: "555555" })],
		}));
	}

	elements.push(new Table({
		width: { size: compact ? 96 : 100, type: WidthType.PERCENTAGE },
		borders: {
			top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder,
			insideH: cellBorder, insideV: cellBorder,
		},
		rows: docxRows,
	}));
	// Trailing spacer so following content isn't glued to the table.
	elements.push(new Paragraph({ spacing: { before: 0, after: compact ? 40 : 80 }, children: [] }));
	return elements;
}

/**
 * Build a list of docx Paragraph / ImageRun elements from a question object.
 * Returns an array of Paragraph objects.
 */
async function buildQuestionParagraphs(q, qNum, mode, opts = {}) {
	// mode: 'question' | 'answerkey' | 'solution'
	const LETTERS = ["A", "B", "C", "D"];
	const paragraphs = [];
	const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
	const borders = { top: border, bottom: border, left: border, right: border };

	// Decode HTML entities that may be stored in the database, then pass text through.
	// $...$ LaTeX is converted to OMML by the post-processor.
	function stripMath(s) {
		return String(s || "")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, "\"")
			.replace(/&apos;/g, "'")
			.replace(/&#39;/g, "'")
			.replace(/&nbsp;/g, " ")
			.trim();
	}

	const questionText = stripMath(q.question || "");
	const isNoneCorrect = q.isNoneCorrect === true;
	const isInteger = String(q.questionType || q.question_type || "").toUpperCase() === "INTEGER"
		|| (q.numericalAnswer !== undefined && q.numericalAnswer !== null);
	const correctIndexes = Array.isArray(q.correctIndexes) && q.correctIndexes.length
		? q.correctIndexes : (isNoneCorrect || isInteger ? [] : [typeof q.correctIndex === "number" ? q.correctIndex : 0]);
	// Human-readable answer label: "None" for none-correct, numeric for INTEGER,
	// otherwise the comma-separated option letters.
	const answerLabel = isNoneCorrect
		? "None (no correct option)"
		: isInteger
			? String(q.numericalAnswer ?? q.correct_answer ?? "")
			: correctIndexes.map(i => LETTERS[i] || "?").join(", ");

	if (mode === "answerkey") {
		// Just one line: Q1. A
		paragraphs.push(new Paragraph({
			spacing: { before: 60, after: 60 },
			children: [
				new TextRun({ text: `Q${qNum}.  `, bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: answerLabel, bold: true, color: isNoneCorrect ? "b06a00" : "1a6b1a", font: "Arial", size: 22 }),
			]
		}));
		return paragraphs;
	}

	if (mode === "solution") {
		// Only show question number and answer key — no question text or image
		const correctLetters = answerLabel;
		paragraphs.push(new Paragraph({
			spacing: { before: 180, after: 40 },
			children: [
				new TextRun({ text: `Q${qNum}.  `, bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: "Answer: ", bold: true, font: "Arial", size: 22 }),
				new TextRun({ text: correctLetters, bold: true, color: "1a6b1a", font: "Arial", size: 22 }),
			]
		}));

		// Solution steps if available
		if (Array.isArray(q.solutions) && q.solutions.length > 0) {
			paragraphs.push(new Paragraph({
				spacing: { before: 40, after: 20 },
				children: [new TextRun({ text: "Solution:", bold: true, underline: {}, font: "Arial", size: 22 })]
			}));
			for (const sol of q.solutions) {
				// Render solution text (supports both sol.text and sol.content)
				const solText = stripMath(sol.content || sol.text || "");
				if (solText) {
					paragraphs.push(new Paragraph({
						spacing: { before: 20, after: 20 },
						indent: { left: 360 },
						children: [new TextRun({ text: solText, font: "Arial", size: 22 })]
					}));
				}
				// Render solution image — supports sol.src (legacy) and sol.image (API response field)
				const imgSrc = sol.src || sol.image || null;
				if (imgSrc) {
					const buf = await resolveImageBuffer(
						imgSrc.startsWith("data:") || imgSrc.startsWith("http") ? imgSrc
							: `data:image/jpeg;base64,${imgSrc}`
					);
					if (buf) {
						paragraphs.push(new Paragraph({
							spacing: { before: 40, after: 40 },
							alignment: AlignmentType.CENTER,
							children: [new ImageRun({ data: buf, transformation: { width: 280, height: 160 }, type: imgType(imgSrc) })]
						}));
					}
				}
			}
		}

		// Divider
		paragraphs.push(new Paragraph({
			spacing: { before: 120, after: 0 },
			border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD", space: 1 } },
			children: []
		}));
		return paragraphs;
	}

	// mode === 'question'
	// Layout:
	//  1. Question text  → full-width paragraph, ALWAYS outside any table
	//  2. Options + image → invisible borderless 2-col table:
	//       Left cell (68%)  — option rows only
	//       Right cell (32%) — question image, centred, ~130×100 pt
	//  3. No image → option paragraphs pushed directly (full width, no table)

	// ── Resolve question image buffer ─────────────────────────────────────────
	const options = Array.isArray(q.options) ? q.options : [];
	const optionImages = Array.isArray(q.optionImages) ? q.optionImages : [];
	// Per-option tables (e.g. NEET "match the following" options). When present,
	// each option is rendered as its own mini-table instead of a text run.
	const optionTables = Array.isArray(q.optionTables) ? q.optionTables : [];
	const hasOptionTables = !!q.hasOptionTables && optionTables.some(t => t && typeof t === "object" && ((Array.isArray(t.headers) && t.headers.length) || (Array.isArray(t.rows) && t.rows.length)));
	const hasAnyOptImg = optionImages.some(img => !!img);
	const allOptsShort = !hasOptionTables && !hasAnyOptImg && options.every(o => stripMath(o || "").length <= 35);

	let qImgBuf = null;
	let qImgType = "jpg";
	if (q.questionImage) {
		qImgBuf = await resolveImageBuffer(q.questionImage);
		qImgType = imgType(q.questionImage);
	}

	// ── 1. Question text — always full-width, outside any table ──────────────
	paragraphs.push(new Paragraph({
		spacing: { before: 200, after: 80 },
		children: [
			new TextRun({ text: `Q${qNum}. `, bold: true, font: "Arial", size: 22 }),
			new TextRun({ text: questionText, font: "Arial", size: 22 }),
		],
	}));

	// ── 1b. Render data tables/matrices that belong after the intro text ─────
	const qTables = Array.isArray(q.tables) ? q.tables : [];
	const tablesAfterIntro = qTables.filter(t => (t?.position || "after_intro") !== "after_options");
	const tablesAfterOptions = qTables.filter(t => (t?.position || "after_intro") === "after_options");
	for (const tbl of tablesAfterIntro) {
		paragraphs.push(...(await buildTableElement(tbl)));
	}

	// ── 2. Build options-only paragraphs ──────────────────────────────────────
	// Tab stop: narrower when image present so options don't overflow under it.
	// 3700 DXA ≈ midpoint of 68% left cell | 4873 DXA ≈ midpoint of full-width
	const tabPos = qImgBuf ? 3700 : 4873;
	const optionParas = [];

	if (hasOptionTables) {
		// Each option (A/B/C/D) is its own mini-table. Render a bold label line
		// followed by the option's table (or its text/image fallback) one per row.
		for (let oi = 0; oi < 4; oi++) {
			const optTbl = optionTables[oi];
			const hasTbl = optTbl && typeof optTbl === "object" && ((Array.isArray(optTbl.headers) && optTbl.headers.length) || (Array.isArray(optTbl.rows) && optTbl.rows.length));
			// Label line: "(A)"
			optionParas.push(new Paragraph({
				spacing: { before: 60, after: 20 },
				children: [new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 })],
			}));
			if (hasTbl) {
				optionParas.push(...(await buildTableElement(optTbl, { compact: true })));
			} else if (optionImages[oi]) {
				const ob = await resolveImageBuffer(optionImages[oi]);
				if (ob) {
					optionParas.push(new Paragraph({
						spacing: { before: 0, after: 40 },
						children: [new ImageRun({ data: ob, transformation: { width: 150, height: 85 }, type: imgType(optionImages[oi]) })],
					}));
				}
			} else {
				optionParas.push(new Paragraph({
					spacing: { before: 0, after: 40 },
					children: [new TextRun({ text: stripMath(options[oi] || ""), font: "Arial", size: 22 })],
				}));
			}
		}
	} else if (allOptsShort) {
		// A + B on row 1, C + D on row 2
		for (let oi = 0; oi < 4; oi += 2) {
			const textA = stripMath(options[oi] || "");
			const textB = stripMath(options[oi + 1] || "");
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				tabStops: [{ type: TabStopType.LEFT, position: tabPos }],
				children: [
					new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: textA, font: "Arial", size: 22 }),
					new TextRun({ text: `\t  (${LETTERS[oi + 1]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: textB, font: "Arial", size: 22 }),
				],
			}));
		}
	} else if (hasAnyOptImg) {
		// Option images → 2 images per line (A & B on row 1, C & D on row 2)
		// Pre-resolve all option image buffers so we can lay them out two-per-row.
		const optImgBufs = [];
		for (let oi = 0; oi < 4; oi++) {
			const optImg = optionImages[oi] || null;
			optImgBufs[oi] = optImg ? { buf: await resolveImageBuffer(optImg), type: imgType(optImg) } : null;
		}
		// Two-per-line layout uses a tab stop to separate the left/right columns.
		const imgTabPos = qImgBuf ? 3700 : 4873;
		for (let oi = 0; oi < 4; oi += 2) {
			const rowChildren = [];
			// Left column (option oi)
			rowChildren.push(new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }));
			if (optImgBufs[oi] && optImgBufs[oi].buf) {
				rowChildren.push(new ImageRun({ data: optImgBufs[oi].buf, transformation: { width: 150, height: 85 }, type: optImgBufs[oi].type }));
			} else {
				rowChildren.push(new TextRun({ text: stripMath(options[oi] || ""), font: "Arial", size: 22 }));
			}
			// Tab → right column (option oi+1)
			rowChildren.push(new TextRun({ text: `\t  (${LETTERS[oi + 1]})  `, bold: true, font: "Arial", size: 22 }));
			if (optImgBufs[oi + 1] && optImgBufs[oi + 1].buf) {
				rowChildren.push(new ImageRun({ data: optImgBufs[oi + 1].buf, transformation: { width: 150, height: 85 }, type: optImgBufs[oi + 1].type }));
			} else {
				rowChildren.push(new TextRun({ text: stripMath(options[oi + 1] || ""), font: "Arial", size: 22 }));
			}
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				tabStops: [{ type: TabStopType.LEFT, position: imgTabPos }],
				children: rowChildren,
			}));
		}
	} else {
		// One option per line (long text only)
		for (let oi = 0; oi < 4; oi++) {
			const optText = stripMath(options[oi] || "");
			optionParas.push(new Paragraph({
				spacing: { before: 40, after: 40 },
				children: [
					new TextRun({ text: `  (${LETTERS[oi]})  `, bold: true, font: "Arial", size: 22 }),
					new TextRun({ text: optText, font: "Arial", size: 22 }),
				],
			}));
		}
	}

	// ── 3. Combine options + image ────────────────────────────────────────────
	if (qImgBuf) {
		// Use BorderStyle.NIL (w:nil) — the correct OOXML way to truly suppress all borders.
		// BorderStyle.NONE still renders as a hairline in some Word/LibreOffice versions.
		const noBorder = { style: BorderStyle.NIL, size: 0, color: "auto" };
		const noBorders = {
			top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
			insideH: noBorder, insideV: noBorder,
		};

		paragraphs.push(new Table({
			width: { size: 100, type: WidthType.PERCENTAGE },
			borders: {
				top: noBorder,
				bottom: noBorder,
				left: noBorder,
				right: noBorder,
				insideH: noBorder,
				insideV: noBorder,
			},
			rows: [
				new TableRow({
					children: [
						// Left cell — options only (68%)
						new TableCell({
							width: { size: 68, type: WidthType.PERCENTAGE },
							borders: noBorders,
							verticalAlign: VerticalAlign.TOP,
							margins: { top: 0, bottom: 0, left: 0, right: 100 },
							children: optionParas,
						}),
						// Right cell — question image, centred vertically (32%)
						new TableCell({
							width: { size: 32, type: WidthType.PERCENTAGE },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 40, bottom: 0, left: 60, right: 0 },
							children: [
								new Paragraph({
									spacing: { before: 0, after: 0 },
									alignment: AlignmentType.CENTER,
									children: [
										new ImageRun({
											data: qImgBuf,
											type: qImgType,
											transformation: { width: 130, height: 100 },
										}),
									],
								}),
							],
						}),
					],
				}),
			],
		}));
	} else {
		// No image — plain full-width option paragraphs
		paragraphs.push(...optionParas);
	}

	// ── 4. Render any tables explicitly positioned after the options ─────────
	for (const tbl of tablesAfterOptions) {
		paragraphs.push(...(await buildTableElement(tbl)));
	}

	return paragraphs;
}

/**
 * Build a full DOCX document for the given mode.
 * questions: array of { chapter, topic, lecture, qNum, q }
 * headerMeta: { subject, chapter, testType, class: className } — user-provided header fields
 */
async function buildPaperDoc(selectedQuestions, mode, title, headerMeta = {}) {
	const allParas = [];
	const subject = String(headerMeta.subject || '').trim();
	const chapter = String(headerMeta.chapter || '').trim();
	const testType = String(headerMeta.testType || '').trim();
	const className = String(headerMeta.class || '').trim();

	const noBorders = {
		top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
		right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
	};

	if (subject || chapter || testType) {
		// Rich header using a two-column table:
		//   Left column  → CLASS X (top-left)
		//   Right column → Subject / [Chapter] / Test Type (centered)
		// Build centre-column paragraphs
		const centreParas = [];
		if (subject) {
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 40 },
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: subject.toUpperCase(), bold: true, font: "Arial", size: 30, color: "1a1a2e" })]
			}));
		}
		if (chapter) {
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 40 },
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: `[ ${chapter.toUpperCase()} ]`, bold: true, font: "Arial", size: 28, color: "1a1a2e", underline: {} })]
			}));
		}
		if (testType) {
			centreParas.push(new Paragraph({
				spacing: { before: 0, after: 0 },
				alignment: AlignmentType.CENTER,
				children: [new TextRun({ text: testType.toUpperCase(), bold: true, font: "Arial", size: 32, color: "1a1a2e" })]
			}));
		}
		if (!centreParas.length) {
			centreParas.push(new Paragraph({ children: [] }));
		}

		// Left column: CLASS label (only if provided)
		const leftParas = className
			? [
				new Paragraph({
					spacing: { before: 0, after: 0 },
					alignment: AlignmentType.LEFT,
					children: [new TextRun({ text: `CLASS ${className.toUpperCase()}`, bold: true, font: "Arial", size: 26, color: "1a1a2e" })]
				})
			]
			: [new Paragraph({ children: [] })];

		// Render as a borderless 2-column table so CLASS sits top-left while title is centred
		allParas.push(new Table({
			width: { size: 100, type: WidthType.PERCENTAGE },
			borders: {
				top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				insideH: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
				insideV: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
			},
			rows: [
				new TableRow({
					children: [
						// Left cell — CLASS label (20% width)
						new TableCell({
							width: { size: 20, type: WidthType.PERCENTAGE },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 80, bottom: 80, left: 0, right: 0 },
							children: leftParas,
						}),
						// Centre cell — subject / chapter / test-type (60%)
						new TableCell({
							width: { size: 60, type: WidthType.PERCENTAGE },
							borders: noBorders,
							verticalAlign: VerticalAlign.CENTER,
							margins: { top: 80, bottom: 80, left: 0, right: 0 },
							children: centreParas,
						}),
						// Right cell — empty placeholder (20%)
						new TableCell({
							width: { size: 20, type: WidthType.PERCENTAGE },
							borders: noBorders,
							children: [new Paragraph({ children: [] })],
						}),
					],
				}),
			],
		}));
		// small gap after the header table
		allParas.push(new Paragraph({ spacing: { before: 0, after: 60 }, children: [] }));
	} else {
		// Fallback: plain title (original behaviour)
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 360 },
			alignment: AlignmentType.CENTER,
			children: [new TextRun({ text: title, bold: true, font: "Arial", size: 36, color: "1a1a2e" })]
		}));
	}

	// Date line + student name line
	allParas.push(new Paragraph({
		spacing: { before: 0, after: subject || chapter || testType ? 120 : 480 },
		alignment: AlignmentType.CENTER,
		children: [new TextRun({ text: `Date: _______________   Total Questions: ${selectedQuestions.length}`, font: "Arial", size: 22, color: "555555" })]
	}));
	if (subject || chapter || testType) {
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 360 },
			children: [new TextRun({ text: "NAME OF STUDENT ________________________________", font: "Arial", size: 22, bold: true, color: "1a1a2e" })]
		}));
	}

	if (mode === "answerkey") {
		// Two-column layout for answer key
		allParas.push(new Paragraph({
			spacing: { before: 0, after: 240 },
			children: [new TextRun({ text: "Answer Key", bold: true, font: "Arial", size: 28, underline: {} })]
		}));
		for (const item of selectedQuestions) {
			const paras = await buildQuestionParagraphs(item.q, item.qNum, "answerkey");
			allParas.push(...paras);
		}
	} else {
		// No topic headings — questions are listed directly without any topic name.
		for (const item of selectedQuestions) {
			const paras = await buildQuestionParagraphs(item.q, item.qNum, mode);
			allParas.push(...paras);
		}
	}

	const doc = new Document({
		sections: [{
			properties: {
				page: {
					size: { width: 11906, height: 16838 }, // A4 in twips (matches LibreOffice PDF output)
					margin: { top: 720, right: 720, bottom: 720, left: 720 }
				}
			},
			children: allParas
		}]
	});

	return Packer.toBuffer(doc);
}

function resolveLibreOfficeBin() {
    if (process.platform === "win32") {
        const paths = [
            "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
            "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    }
    return "soffice";
}

/**
 * Post-process a generated DOCX:
 *  1. Convert all $...$ LaTeX in text to proper OMML Word equations
 *  2. Optionally merge a template DOCX (headers, footers, styles)
 *
 * This implementation stays entirely in Node so it works in the container
 * and on Windows without relying on a local Python runtime.
 */
function extractTextFromRun(runXml) {
	const texts = [...String(runXml || "").matchAll(/<w:t[^>]*>(.*?)<\/w:t>/gs)].map((m) => m[1]);
	return texts.join("");
}

function extractRprFromRun(runXml) {
	const match = String(runXml || "").match(/<w:rPr>(.*?)<\/w:rPr>/s);
	return match ? match[0] : "";
}

function splitMath(text) {
	const parts = [];
	const source = String(text || "");
	let i = 0;
	while (i < source.length) {
		if (source.slice(i, i + 2) === "$$") {
			const end = source.indexOf("$$", i + 2);
			if (end !== -1) {
				parts.push({ isMath: true, content: source.slice(i + 2, end), display: true });
				i = end + 2;
				continue;
			}
		}
		if (source[i] === "$") {
			const end = source.indexOf("$", i + 1);
			if (end !== -1 && end > i + 1) {
				parts.push({ isMath: true, content: source.slice(i + 1, end), display: false });
				i = end + 1;
				continue;
			}
		}
		let j = i;
		while (j < source.length && source[j] !== "$") j++;
		if (j > i) parts.push({ isMath: false, content: source.slice(i, j), display: false });
		i = j;
	}
	return parts.length ? parts : [{ isMath: false, content: source, display: false }];
}

// Convert LaTeX to safe plain-text XML run when OMML conversion fails.
function latexFallbackRun(src) {
	const readable = String(src || "")
		.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
		.replace(/\\sqrt\{([^{}]*)\}/g, '\u221a($1)')
		.replace(/\\left\(/g, '(').replace(/\\right\)/g, ')')
		.replace(/\\left\[/g, '[').replace(/\\right\]/g, ']')
		.replace(/\\text\{([^{}]*)\}/g, '$1')
		.replace(/\\([a-zA-Z]+)\{([^{}]*)\}/g, '$1($2)')
		.replace(/\\([a-zA-Z]+)/g, '$1')
		.replace(/[\{\}]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.trim();
	const spaceAttr = readable.startsWith(' ') || readable.endsWith(' ') ? ' xml:space="preserve"' : '';
	return `<w:r><w:t${spaceAttr}>${readable}</w:t></w:r>`;
}

async function latexToOmmlWrapped(latex, displayMode = false) {
	const src = String(latex || "");
	if (typeof latexToOMML !== "function") {
		return latexFallbackRun(src);
	}
	const hasAlignmentEnv = /\\begin\{(?:aligned|array|matrix|cases|align|alignedat)\}/i.test(src);
	const primarySrc = !hasAlignmentEnv && src.includes("&")
		? src.replace(/(?<!\\)&/g, "\\&")
		: src;
	// Sanitize OMML output: fix bare & characters inside <m:t> tags that break Word's XML parser
	function sanitizeOmml(omml) {
		// 1. Remove namespace declarations from <m:oMath> since they are already declared at the document level
		let clean = String(omml || "")
			.replace(/<m:oMath\b[^>]*>/g, '<m:oMath>')
			.replace(/<\/m:oMath>/g, '</m:oMath>');

		// 2. Strip any attributes (like xml:space) from <m:t> elements which violate Word's strict math schema
		clean = clean.replace(/<m:t\b[^>]*>/g, '<m:t>');

		// 3. Fix unescaped & inside text content tags (m:t and w:t)
		return clean.replace(/(<(?:m|w):t[^>]*>)([\s\S]*?)(<\/(?:m|w):t>)/g, (match, open, content, close) => {
			// Re-escape & that isn't already part of an entity
			const fixed = content.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#)/g, '&amp;');
			return open + fixed + close;
		});
	}

	try {
		const omml = await latexToOMML(primarySrc, { displayMode });
		return sanitizeOmml(omml);
	} catch (err) {
		const hasAmp = src.includes("&");
		const msg = String(err && err.message ? err.message : err).toLowerCase();

		if (hasAmp || msg.includes('misplaced &')) {
			try {
				const wrapped = `\\begin{aligned}${src}\\end{aligned}`;
				return sanitizeOmml(await latexToOMML(wrapped, { displayMode }));
			} catch (e2) { }

			try {
				const escaped = src.replace(/&/g, '\\&');
				return sanitizeOmml(await latexToOMML(escaped, { displayMode }));
			} catch (e3) { }

			try {
				const matrixed = `\\begin{matrix}${src}\\end{matrix}`;
				return sanitizeOmml(await latexToOMML(matrixed, { displayMode }));
			} catch (e4) {
				console.warn('[latexToOmmlWrapped] fallbacks failed:', e4 && e4.message ? e4.message : e4);
			}
		}

		return latexFallbackRun(src);
	}
}

async function processParagraph(paraXml) {
	if (!String(paraXml || "").includes("$")) return paraXml;

	const pOpen = String(paraXml).match(/<w:p\b[^>]*>/);
	const pOpenTag = pOpen ? pOpen[0] : "<w:p>";
	const inner = String(paraXml).slice(pOpenTag.length, -6);
	const runs = [...inner.matchAll(/<w:r\b[^>]*>.*?<\/w:r>/gs)];
	if (!runs.length) return paraXml;

	const allText = runs.map((r) => extractTextFromRun(r[0])).join("");
	if (!allText.includes("$")) return paraXml;

	// Build a character-position → run-rPr map so each non-math text fragment
	// keeps the formatting of the ORIGINAL run it came from. Previously the very
	// first run's rPr (e.g. the bold "Q1." label) was forced onto every fragment,
	// which made entire questions appear bold whenever they contained $math$.
	const runTexts = [];
	const rprByPos = []; // rprByPos[i] = rPr string that applies to character i of mergedText
	let firstRpr = "";
	for (const r of runs) {
		const t = extractTextFromRun(r[0]);
		const rpr = extractRprFromRun(r[0]);
		if (!firstRpr) firstRpr = rpr;
		runTexts.push(t);
		for (let k = 0; k < t.length; k++) rprByPos.push(rpr);
	}

	const mergedText = runTexts.join("");
	const parts = splitMath(mergedText);
	if (!parts.some((part) => part.isMath)) return paraXml;

	// Encode raw XML text-node content once without double-encoding existing entities.
	function encodeRunText(s) {
		return String(s)
			.replace(/&amp;/g, "___AMP___").replace(/&lt;/g, "___LT___").replace(/&gt;/g, "___GT___").replace(/&quot;/g, "___QUOT___").replace(/&apos;/g, "___APOS___")
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
			.replace(/___AMP___/g, "&amp;").replace(/___LT___/g, "&lt;").replace(/___GT___/g, "&gt;").replace(/___QUOT___/g, "&quot;").replace(/___APOS___/g, "&apos;");
	}

	let newRunsXml = "";
	let cursor = 0; // position within mergedText
	for (const part of parts) {
		const partContent = String(part.content || "");
		const partLen = partContent.length;
		if (!partContent) { cursor += partLen; continue; }
		if (part.isMath) {
			const innerOmml = await latexToOmmlWrapped(part.content, part.display);
			newRunsXml += innerOmml;
		} else {
			// A non-math fragment can span several original runs with DIFFERENT formatting
			// (e.g. the bold "Q1." run immediately followed by the normal question-text run).
			// Walk the fragment character-by-character and start a new <w:r> whenever the
			// underlying run's rPr changes, so each piece keeps its original formatting.
			let segStart = 0;
			for (let k = 1; k <= partLen; k++) {
				const prevRpr = rprByPos[cursor + k - 1] !== undefined ? rprByPos[cursor + k - 1] : firstRpr;
				const curRpr = k < partLen && rprByPos[cursor + k] !== undefined ? rprByPos[cursor + k] : null;
				if (k === partLen || curRpr !== prevRpr) {
					const segText = partContent.slice(segStart, k);
					const spaceAttr = segText.startsWith(" ") || segText.endsWith(" ") ? ' xml:space="preserve"' : "";
					newRunsXml += `<w:r>${prevRpr}<w:t${spaceAttr}>${encodeRunText(segText)}</w:t></w:r>`;
					segStart = k;
				}
			}
		}
		cursor += partLen;
	}

	const firstRunStart = runs[0].index;
	const lastRunEnd = runs[runs.length - 1].index + runs[runs.length - 1][0].length;
	return pOpenTag + inner.slice(0, firstRunStart) + newRunsXml + inner.slice(lastRunEnd) + "</w:p>";
}

async function processDocxXml(docXml) {
	const matches = [...String(docXml || "").matchAll(/<w:p\b[^>]*>.*?<\/w:p>/gs)];
	if (!matches.length) return docXml;

	let result = "";
	let lastIndex = 0;
	for (const match of matches) {
		result += docXml.slice(lastIndex, match.index);
		result += await processParagraph(match[0]);
		lastIndex = match.index + match[0].length;
	}
	result += docXml.slice(lastIndex);
	return result;
}

function decodeXml(text) {
	return String(text || "")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

async function zipToEntries(buffer) {
	const zip = await JSZip.loadAsync(buffer);
	const entries = {};
	for (const [name, file] of Object.entries(zip.files)) {
		if (file.dir) continue;
		entries[name] = await file.async("nodebuffer");
	}
	return entries;
}

async function entriesToZipBuffer(entries) {
	const zip = new JSZip();
	for (const [name, data] of Object.entries(entries)) {
		zip.file(name, data);
	}
	return zip.generateAsync({
		type: "nodebuffer",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});
}

async function mergeWithTemplate(genEntries, tplEntries) {
	const merged = { ...genEntries };

	for (const name of [
		"word/styles.xml",
		"word/settings.xml",
		"word/fontTable.xml",
		"word/theme/theme1.xml",
		"word/theme/theme2.xml",
		"word/webSettings.xml",
	]) {
		if (tplEntries[name]) merged[name] = tplEntries[name];
	}

	for (const [name, data] of Object.entries(tplEntries)) {
		if (name.startsWith("word/header") || name.startsWith("word/footer") || name.startsWith("word/media/")) {
			merged[name] = data;
		}
	}

	const relsKey = "word/_rels/document.xml.rels";
	let idRemap = {};
	if (tplEntries[relsKey] && merged[relsKey]) {
		let tplRelsXml = tplEntries[relsKey].toString("utf8");
		let genRelsXml = merged[relsKey].toString("utf8");
		const genUsedIds = new Set([...genRelsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1])));
		let nextFree = Math.max(0, ...genUsedIds) + 1;
		const keepTypes = ["header", "footer", "image", "Image", "Header", "Footer"];
		const tplRels = tplRelsXml.match(/<Relationship\b[^>]*\/>/g) || [];
		const newRelTags = [];

		for (let relTag of tplRels) {
			const typeMatch = relTag.match(/Type="([^"]+)"/);
			const idMatch = relTag.match(/Id="([^"]+)"/);
			if (!typeMatch || !idMatch) continue;
			if (!keepTypes.some((k) => typeMatch[1].includes(k))) continue;

			const oldId = idMatch[1];
			const numMatch = oldId.match(/^rId(\d+)$/);
			if (numMatch && genUsedIds.has(Number(numMatch[1]))) {
				const newId = `rId${nextFree++}`;
				idRemap[oldId] = newId;
				relTag = relTag.replace(`Id="${oldId}"`, `Id="${newId}"`);
			} else if (numMatch) {
				genUsedIds.add(Number(numMatch[1]));
			}
			newRelTags.push(relTag);
		}

		if (newRelTags.length) {
			genRelsXml = genRelsXml.replace('</Relationships>', () => `\n${newRelTags.join('\n')}\n</Relationships>`);
			merged[relsKey] = Buffer.from(genRelsXml, 'utf8');
		}

		if (Object.keys(idRemap).length) {
			for (const name of Object.keys(merged)) {
				if (!name.startsWith("word/header") && !name.startsWith("word/footer")) continue;
				let xml = merged[name].toString('utf8');
				for (const [oldId, newId] of Object.entries(idRemap)) {
					xml = xml.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
					xml = xml.replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`);
				}
				merged[name] = Buffer.from(xml, 'utf8');
			}
		}
	}

	for (const [name, data] of Object.entries(tplEntries)) {
		if (/word\/_rels\/(header|footer)\d*\.xml\.rels$/.test(name)) merged[name] = data;
	}

	if (tplEntries["word/document.xml"] && merged["word/document.xml"]) {
		let tplDoc = tplEntries["word/document.xml"].toString('utf8');
		let genDoc = merged["word/document.xml"].toString('utf8');

		const tplSecprMatch = tplDoc.match(/<w:sectPr\b.*?<\/w:sectPr>/s);
		if (tplSecprMatch) {
			let tplSecpr = tplSecprMatch[0];
			if (Object.keys(idRemap || {}).length) {
				for (const [oldId, newId] of Object.entries(idRemap)) {
					tplSecpr = tplSecpr.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
				}
			}
			if (/<w:sectPr\b/.test(genDoc)) {
				genDoc = genDoc.replace(/<w:sectPr\b.*?<\/w:sectPr>/s, () => tplSecpr);
			} else {
				genDoc = genDoc.replace('</w:body>', () => `${tplSecpr}\n</w:body>`);
			}
			merged["word/document.xml"] = Buffer.from(genDoc, 'utf8');
		}
	}

	if (tplEntries["word/document.xml"] && merged["word/document.xml"]) {
		let tplDoc = tplEntries["word/document.xml"].toString('utf8');
		let genDoc = merged["word/document.xml"].toString('utf8');
		const bodyMatch = tplDoc.match(/<w:body>(.*?)<\/w:body>/s);
		if (bodyMatch) {
			let tplBodyNoSecpr = bodyMatch[1].replace(/<w:sectPr\b.*?<\/w:sectPr>/s, '').trim();
			const hasRealContent = /<w:t[^>]*>[^<]+<\/w:t>/.test(tplBodyNoSecpr);
			if (hasRealContent && tplBodyNoSecpr) {
				const genBodyMatch = genDoc.match(/<w:body>(.*?)<\/w:body>/s);
				if (genBodyMatch) {
					const genBodyContent = genBodyMatch[1];
					const paras = [...genBodyContent.matchAll(/<w:p\b/g)];
					let skipEnd = 0;
					if (paras.length >= 2) {
						skipEnd = paras[2] ? paras[2].index : genBodyContent.length;
						const first3Text = genBodyContent.slice(0, Math.min(skipEnd + 300, genBodyContent.length));
						if (first3Text.includes('Answer Key') && paras.length >= 3) {
							skipEnd = paras[3] ? paras[3].index : genBodyContent.length;
						}
					}
					let genBodyRest = skipEnd ? genBodyContent.slice(skipEnd) : genBodyContent;
					if (Object.keys(idRemap || {}).length) {
						for (const [oldId, newId] of Object.entries(idRemap)) {
							tplBodyNoSecpr = tplBodyNoSecpr.replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`);
							tplBodyNoSecpr = tplBodyNoSecpr.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
						}
					}
					const newBody = `${tplBodyNoSecpr}\n${genBodyRest}`;
					genDoc = genDoc.replace(genBodyMatch[0], () => `<w:body>${newBody}</w:body>`);
					merged["word/document.xml"] = Buffer.from(genDoc, 'utf8');
				}
			}
		}
	}

	const ctKey = "[Content_Types].xml";
	if (tplEntries[ctKey] && merged[ctKey]) {
		const tplCt = tplEntries[ctKey].toString('utf8');
		let genCt = merged[ctKey].toString('utf8');
		const genParts = new Set([...genCt.matchAll(/PartName="([^"]+)"/g)].map((m) => m[1]));
		const genExts = new Set([...genCt.matchAll(/Extension="([^"]+)"/g)].map((m) => m[1]));
		const newItems = [];
		for (const ov of tplCt.match(/<Override\b[^>]*\/>/g) || []) {
			const pnMatch = ov.match(/PartName="([^"]+)"/);
			if (pnMatch && !genParts.has(pnMatch[1])) {
				newItems.push(ov);
				genParts.add(pnMatch[1]);
			}
		}
		for (const dv of tplCt.match(/<Default\b[^>]*\/>/g) || []) {
			const extMatch = dv.match(/Extension="([^"]+)"/);
			if (extMatch && !genExts.has(extMatch[1])) {
				newItems.push(dv);
				genExts.add(extMatch[1]);
			}
		}
		if (newItems.length) {
			genCt = genCt.replace('</Types>', () => `\n${newItems.join('\n')}\n</Types>`);
			merged[ctKey] = Buffer.from(genCt, 'utf8');
		}
	}

	return merged;
}

async function postProcessDocx(generatedBuf, templateBase64) {
	console.log("[postProcessDocx] START — node converter");
	try {
		// Always run LaTeX→OMML conversion regardless of whether a template is used,
		// so equations render correctly in both the Word download and PDF export.
		let entries = await zipToEntries(generatedBuf);

		if (entries["word/document.xml"]) {
			let docXml = entries["word/document.xml"].toString("utf8");
			docXml = await processDocxXml(docXml);
			if (docXml.includes("m:oMath") && !docXml.includes('xmlns:m=')) {
				docXml = docXml.replace('<w:document ', () => '<w:document xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ', 1);
			}
			entries["word/document.xml"] = Buffer.from(docXml, "utf8");
		}

		if (templateBase64) {
			const tplEntries = await zipToEntries(Buffer.from(templateBase64, "base64"));
			entries = await mergeWithTemplate(entries, tplEntries);
		}

		const output = await entriesToZipBuffer(entries);
		console.log(`[postProcessDocx] SUCCESS — output size: ${output.length} bytes`);
		return output;
	} catch (e) {
		console.error("postProcessDocx failed:", e.message);
		return generatedBuf;
	}
}

// Keep the old name as an alias for backward compatibility
const mergeDocxWithTemplate = (buf, tplB64) => postProcessDocx(buf, tplB64);




// POST /api/admin/generate-paper
// Body: { questions: [...], paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId? }
// Returns: JSON with base64-encoded buffers for question, answerkey, solution docx
router.post("/api/admin/generate-paper", requireAdmin, async (req, res) => {
	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = req.body || {};
		if (!Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "No questions provided" });
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		// Build raw DOCX buffers
		let [qBuf, akBuf, solBuf] = await Promise.all([
			buildPaperDoc(normalizedQuestions, "question", title, headerMeta),
			buildPaperDoc(normalizedQuestions, "answerkey", `${title} – Answer Key`, headerMeta),
			buildPaperDoc(normalizedQuestions, "solution", `${title} – Solutions`, headerMeta),
		]);

		// Fetch template if requested
		let tplBase64 = null;
		if (templateId) {
			const tplRow = await db.execute({ sql: "SELECT docx_base64 FROM paper_templates WHERE id = ?", args: [Number(templateId)] });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}

		// Post-process: convert $LaTeX$ → OMML Word equations + apply template
		// Always runs so equations are always rendered properly
		[qBuf, akBuf, solBuf] = await Promise.all([
			postProcessDocx(qBuf, tplBase64),
			postProcessDocx(akBuf, tplBase64),
			postProcessDocx(solBuf, tplBase64),
		]);

		res.json({
			success: true,
			files: {
				questionPaper: qBuf.toString("base64"),
				answerKey: akBuf.toString("base64"),
				solutions: solBuf.toString("base64"),
			}
		});
	} catch (e) {
		console.error("generate-paper error:", e);
		res.status(500).json({ error: e.message || "Failed to generate paper" });
	}
});

// ══════════════════════════════════════════════════════════════════════════
//  PDF GENERATION — convert DOCX → PDF via LibreOffice headless
// ══════════════════════════════════════════════════════════════════════════

/**
 * Convert a DOCX Buffer to a PDF Buffer using LibreOffice headless.
 * This preserves equations (OMML), template styles, images, and layout
 * exactly as they appear in the Word document.
 * @param {Buffer} docxBuffer - The DOCX file contents
 * @returns {Promise<Buffer>} - The PDF file contents
 */
/**
 * Resolve the LibreOffice binary. Tries PATH names and common absolute
 * install locations so it works on Ubuntu/Debian, macOS, and custom installs.
 */
function resolveLibreOfficeBin() {
	const candidates = [
		"libreoffice",
		"soffice",
		"/usr/bin/libreoffice",
		"/usr/bin/soffice",
		"/usr/lib/libreoffice/program/soffice",
		"/opt/libreoffice/program/soffice",
		"/opt/libreoffice7.6/program/soffice",
		"/opt/libreoffice24.2/program/soffice",
		"/snap/bin/libreoffice",
		"/Applications/LibreOffice.app/Contents/MacOS/soffice",
	];
	for (const bin of candidates) {
		try {
			if (!bin.startsWith("/") || fs.existsSync(bin)) return bin;
		} catch (_) { /* skip */ }
	}
	return null;
}

async function docxToPdf(docxBuffer) {
	return new Promise((resolve, reject) => {
		const bin = resolveLibreOfficeBin();
		if (!bin) {
			return reject(new Error(
				"LibreOffice is not installed on this server. " +
				"Add `apt-get install -y libreoffice` to your Dockerfile or build script."
			));
		}

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lo-paper-"));
		const docxPath = path.join(tmpDir, "paper.docx");
		const pdfPath = path.join(tmpDir, "paper.pdf");

		try {
			fs.writeFileSync(docxPath, docxBuffer);
		} catch (writeErr) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
			return reject(new Error("Failed to write temporary DOCX: " + writeErr.message));
		}

		// Each LibreOffice instance needs a fully isolated user profile directory.
		// Without this, parallel instances share the same profile and lock each other
		// out, causing "source file could not be loaded" errors on the 2nd and 3rd call.
		// -env:UserInstallation gives each run its own profile; HOME is also set as a
		// fallback for the javaldx warning in containers.
		const loProfile = fs.mkdtempSync(path.join(os.tmpdir(), "lo-profile-"));

		execFile(
			bin,
			[
				"--headless", "--norestore", "--nofirststartwizard",
				`-env:UserInstallation=file://${loProfile}`,
				"--convert-to", "pdf", "--outdir", tmpDir, docxPath,
			],
			{ timeout: 60000, env: { ...process.env, HOME: loProfile } },
			(err, stdout, stderr) => {
				// Clean up isolated profile dir
				try { fs.rmSync(loProfile, { recursive: true, force: true }); } catch (_) { }

				// LibreOffice writes harmless warnings to stderr (e.g. "failed to launch
				// javaldx") which cause execFile to set err even on success.
				// Check whether the PDF was actually produced — that is the real signal.
				const pdfExists = fs.existsSync(pdfPath);
				if (!pdfExists) {
					try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
					const reason = (err && err.message) || stderr || stdout || "unknown reason";
					return reject(new Error("LibreOffice conversion failed: " + reason));
				}
				try {
					const pdfBuffer = fs.readFileSync(pdfPath);
					fs.rmSync(tmpDir, { recursive: true, force: true });
					resolve(pdfBuffer);
				} catch (readErr) {
					try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
					reject(readErr);
				}
			}
		);
	});
}


// POST /api/admin/generate-paper-pdf
// Body: { questions: [...], paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId? }
// Returns: JSON with base64-encoded PDF buffers converted from the DOCX files.
// Strategy: build the same high-quality DOCX files (with OMML equations and
// template applied) that the Word download uses, then convert each one to PDF
// via LibreOffice headless — so the PDF looks identical to the Word document.
router.post("/api/admin/generate-paper-pdf", requireAdmin, async (req, res) => {
	try {
		const { questions, paperTitle, paperSubject, paperChapter, paperTestType, paperClass, templateId } = req.body || {};
		if (!Array.isArray(questions) || !questions.length) {
			return res.status(400).json({ error: "No questions provided" });
		}

		const title = String(paperTitle || "Question Paper").trim();
		const headerMeta = {
			subject: String(paperSubject || '').trim(),
			chapter: String(paperChapter || '').trim(),
			testType: String(paperTestType || '').trim(),
			class: String(paperClass || '').trim(),
		};
		const normalizedQuestions = normalizePaperQuestions(questions);

		// Step 1: Build DOCX buffers (same as the Word download path)
		let [qBuf, akBuf, solBuf] = await Promise.all([
			buildPaperDoc(normalizedQuestions, "question", title, headerMeta),
			buildPaperDoc(normalizedQuestions, "answerkey", `${title} \u2013 Answer Key`, headerMeta),
			buildPaperDoc(normalizedQuestions, "solution", `${title} \u2013 Solutions`, headerMeta),
		]);

		// Step 2: Apply LaTeX→OMML conversion and template (same post-processing as Word)
		let tplBase64 = null;
		if (templateId) {
			const tplRow = await db.execute({ sql: "SELECT docx_base64 FROM paper_templates WHERE id = ?", args: [Number(templateId)] });
			if (tplRow.rows.length) tplBase64 = tplRow.rows[0].docx_base64;
		}
		[qBuf, akBuf, solBuf] = await Promise.all([
			postProcessDocx(qBuf, tplBase64),
			postProcessDocx(akBuf, tplBase64),
			postProcessDocx(solBuf, tplBase64),
		]);

		// Step 3: Convert each DOCX → PDF using LibreOffice headless.
		// Run sequentially — parallel LibreOffice instances can still conflict on
		// shared system resources even with isolated profiles, causing "source file
		// could not be loaded" on containers.
		const qPdf = await docxToPdf(qBuf);
		const akPdf = await docxToPdf(akBuf);
		const solPdf = await docxToPdf(solBuf);

		res.json({
			success: true,
			files: {
				questionPaper: qPdf.toString("base64"),
				answerKey: akPdf.toString("base64"),
				solutions: solPdf.toString("base64"),
			}
		});
	} catch (e) {
		console.error("generate-paper-pdf error:", e);
		res.status(500).json({ error: e.message || "Failed to generate PDF" });
	}
});

/* ──────────────────────────────────────────────────────────────────────────
   STAR QUIZ API ROUTES
   ────────────────────────────────────────────────────────────────────── */

// GET all STAR Quiz questions

module.exports = router;
