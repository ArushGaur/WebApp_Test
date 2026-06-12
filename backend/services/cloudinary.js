const cloudinary = require("cloudinary").v2;
const { getMime } = require("../utils/helpers");

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadImageToCloudinary(base64String) {
	if (!base64String) return null;
	if (String(base64String).startsWith("http://") || String(base64String).startsWith("https://")) return base64String;
	if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
		return base64String;
	}

	try {
		const dataUri = String(base64String).startsWith("data:")
			? base64String
			: `data:${getMime(base64String)};base64,${base64String}`;
		const uploaded = await cloudinary.uploader.upload(dataUri, { folder: "grip_physics" });
		return uploaded.secure_url;
	} catch (e) {
		console.warn("Cloudinary upload failed, storing base64 instead:", e.message);
		return base64String;
	}
}

async function uploadQuestionImages(questions) {
	return Promise.all(
		questions.map(async (q) => {
			const next = { ...q };
			if (Array.isArray(next.questionImages)) {
				next.questionImages = await Promise.all(next.questionImages.map((img) => uploadImageToCloudinary(img)));
				next.questionImage = next.questionImages[0] || next.questionImage || null;
			} else if (next.questionImage) {
				next.questionImage = await uploadImageToCloudinary(next.questionImage);
				next.questionImages = next.questionImage ? [next.questionImage] : [];
			}
			if (Array.isArray(next.optionImages)) {
				next.optionImages = await Promise.all(next.optionImages.map((img) => uploadImageToCloudinary(img)));
			}
			if (Array.isArray(next.solutions)) {
				next.solutions = await Promise.all(next.solutions.map(async (sol) => {
					if (!sol || typeof sol !== "object") return sol;
					const nextSol = { ...sol };
					if (Array.isArray(nextSol.images)) {
						nextSol.images = await Promise.all(nextSol.images.map((img) => uploadImageToCloudinary(img)));
						nextSol.image = nextSol.images[0] || nextSol.image || null;
					} else if (nextSol.image) {
						nextSol.image = await uploadImageToCloudinary(nextSol.image);
						nextSol.images = nextSol.image ? [nextSol.image] : [];
					}
					return nextSol;
				}));
			}
			return next;
		})
	);
}

module.exports = {
	cloudinary,
	uploadImageToCloudinary,
	uploadQuestionImages,
};
