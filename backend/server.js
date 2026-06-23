process.on('unhandledRejection', (err) => {
	console.error('Unhandled Rejection:', err);
});

const express = require("express");
const cors = require("cors");
const path = require("path");

// Scoped modules
const { db, initDB } = require("./config/db");
const { loadQuestions } = require("./utils/questions");
const helpers = require("./utils/helpers");
const { hashPasscode } = helpers;

const {
	clientSession,
	ownerSession,
	setDefaultInstituteId,
} = require("./middleware/auth");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);

const TEACHER_PASSCODE = process.env.TEACHER_PASSCODE || "dev-teacher-passcode-please-change";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

const allowedOrigins = [
	"https://webapptest-4h742.sevalla.app",
	"https://web-app-test-ivory.vercel.app",
	"http://localhost:3000",
	"http://localhost:8080",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:8080",
];
if (process.env.FRONTEND_URL) {
	allowedOrigins.push(process.env.FRONTEND_URL);
}


app.use(cors({
	origin: (origin, cb) => {
		if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
		return cb(null, false);
	},
	credentials: true,
	methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "X-Session-Type"],
	exposedHeaders: ["set-cookie"],
	maxAge: 86400,
}));

app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

// Route each request to the correct session middleware based on the path
// or the X-Session-Type header (set by the owner page for shared /api/admin/* calls).
app.use((req, res, next) => {
	const isOwner =
		(req.path && req.path.startsWith("/api/owner")) ||
		req.headers["x-session-type"] === "owner";
	if (isOwner) {
		return ownerSession(req, res, next);
	}
	return clientSession(req, res, next);
});

app.use((req, res, next) => {
	console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("X-XSS-Protection", "1; mode=block");
	res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	next();
});

// Import and mount modular routers
const authRouter = require("./routes/auth");
const ownerRouter = require("./routes/owner");
const studentRouter = require("./routes/student");
const extractRouter = require("./routes/extract");
const paperRouter = require("./routes/paper");
const adminRouter = require("./routes/admin");

app.use(authRouter);
app.use(ownerRouter);
app.use(studentRouter);
app.use(extractRouter);
app.use(paperRouter);
app.use(adminRouter);

app.use((req, res) => {
	res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
	console.error("Unhandled error:", err);
	res.status(500).json({ error: "Internal server error" });
});

// Initialize DB and startup server
initDB(TEACHER_PASSCODE, hashPasscode)
	.then((defInstId) => {
		setDefaultInstituteId(defInstId);
		return loadQuestions();
	})
	.then(() => {
		app.listen(PORT, () => {
			console.log(`Server on port ${PORT}`);
			console.log("GROQ_API_KEY:", GROQ_API_KEY ? "set" : "MISSING");
			console.log("TURSO_DATABASE_URL:", process.env.TURSO_DATABASE_URL ? "set" : "MISSING");
			console.log("Cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "configured" : "MISSING");
		});
	})
	.catch((e) => {
		console.error("FATAL: DB init failed:", e);
		process.exit(1);
	});