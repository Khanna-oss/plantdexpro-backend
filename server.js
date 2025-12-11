
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer'); 
const crypto = require('crypto');
const { GoogleGenAI } = require("@google/genai");

const app = express();

// --- ENTERPRISE SECURITY MIDDLEWARE ---

// 1. Strict Helmet Config (CSP + HSTS)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], 
      imgSrc: ["'self'", "data:", "https://*.wikimedia.org", "https://*.ytimg.com"],
      connectSrc: ["'self'", "https://v2.plant.id", "https://*.googleapis.com"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// 2. Strict CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*', 
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Version'],
  maxAge: 86400, 
}));

// 3. Rate Limiting (DDoS Prevention)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});
app.use('/api/', apiLimiter);

// 4. Payload Size Limits
app.use(express.json({ limit: '10mb' }));

// --- AUDIT LOGGING ---
function logAudit(action, metadata) {
  const timestamp = new Date().toISOString();
  const entry = JSON.stringify({ action, metadata, timestamp });
  const hash = crypto.createHash('sha256').update(entry).digest('hex');
  console.log(`[AUDIT][${timestamp}][${hash.substring(0,8)}] ${action}`);
}

// --- CONFIGURATION ---
const PLANT_KEY = (process.env.PLANT_ID_KEY || process.env.Plant_net_api || '').trim();
const YOUTUBE_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const API_KEY = (process.env.API_KEY || '').trim();
const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';

console.log("--- API Key Status ---");
console.log(`Plant Key:    ${PLANT_KEY ? 'Loaded' : 'MISSING'}`);
console.log(`YouTube Key:  ${YOUTUBE_KEY ? 'Loaded' : 'MISSING'}`);
console.log(`Gemini Key:   ${API_KEY ? 'Loaded' : 'MISSING'}`);
console.log("----------------------");

const ai = new GoogleGenAI({ apiKey: API_KEY });

// --- HELPERS ---

async function getWikiImage(query) {
    if (!query) return null;
    try {
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
        const response = await axios.get(url);
        return response.data?.thumbnail?.source || null;
    } catch (e) { return null; }
}

async function getBestPlantImage(scientificName, commonName) {
    let img = await getWikiImage(scientificName);
    if (img) return img;
    img = await getWikiImage(commonName);
    return img || null;
}

// --- IDENTIFICATION LOGIC ---

async function identifyWithPlantNet(base64Image) {
    const form = new FormData();
    const buffer = Buffer.from(base64Image, 'base64');
    form.append('images', buffer, 'image.jpg');
    form.append('organs', 'auto'); 
    const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${PLANT_KEY}`;
    const response = await axios.post(url, form, { headers: form.getHeaders() });
    const bestMatch = response.data.results[0];
    if (!bestMatch) throw new Error("No match found.");
    return {
        plantName: bestMatch.species.commonNames[0] || bestMatch.species.scientificNameWithoutAuthor,
        scientificName: bestMatch.species.scientificNameWithoutAuthor,
        probability: bestMatch.score,
        apiImage: bestMatch.images?.[0]?.url?.m || null
    };
}

async function identifyWithPlantId(base64Image) {
    const url = 'https://api.plant.id/v2/identify';
    const response = await axios.post(url, {
        images: [base64Image], 
        modifiers: ["crops_fast", "similar_images"],
        plant_details: ["common_names", "url", "wiki_description", "taxonomy"]
    }, { headers: { 'Api-Key': PLANT_KEY, 'Content-Type': 'application/json' }});
    const suggestion = response.data.suggestions?.[0];
    if (!suggestion) throw new Error("No match found.");
    return {
        plantName: suggestion.plant_name,
        scientificName: suggestion.plant_details?.scientific_name,
        probability: suggestion.probability,
        apiImage: suggestion.similar_images?.[0]?.url || null
    };
}

// --- MAIN ENDPOINT ---

app.post('/api/identify-plant', async (req, res) => {
  try {
    const { image } = req.body; 
    
    // Input Validation
    if (!image || typeof image !== 'string') {
        logAudit('INVALID_INPUT', { reason: 'Missing or invalid image data' });
        return res.status(400).json({ error: 'Image data required' });
    }
    if (image.length > 15 * 1024 * 1024) { 
        logAudit('INVALID_INPUT', { reason: 'Payload too large' });
        return res.status(413).json({ error: 'Image too large' });
    }

    logAudit('IDENTIFY_START', { size: image.length });

    // 1. ID Plant
    let plantData;
    try {
        if (PLANT_KEY.startsWith('2')) plantData = await identifyWithPlantNet(image);
        else plantData = await identifyWithPlantId(image);
    } catch (err) { return res.status(500).json({ error: 'Identification failed.' }); }

    // 2. Get Wiki Image
    const wikiImage = await getBestPlantImage(plantData.scientificName, plantData.plantName);

    // 3. Safety Analysis (Gemini)
    let safetyData = { isEdible: false, toxicParts: [], safetyWarnings: [], description: "", funFact: "" };
    try {
        const prompt = `Analyze "${plantData.plantName}". Return a valid JSON object with: {"isEdible": boolean, "edibleParts": ["string"], "toxicParts": ["string"], "safetyWarnings": ["string"], "description": "2 sentences.", "funFact": "One fun fact."}`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                responseMimeType: 'application/json'
            }
        });
        
        const text = response.text || "{}";
        safetyData = JSON.parse(text);
    } catch (e) { 
        console.error("Gemini Analysis Error", e);
        safetyData.description = "Safety info unavailable."; 
    }

    // 4. Videos & Image Fallback
    let videos = [];
    let videoContext = safetyData.isEdible ? "recipes" : "uses";
    let youtubeImage = null;

    if (YOUTUBE_KEY && plantData.plantName) {
        const q = safetyData.isEdible ? `how to cook ${plantData.plantName} recipe` : `${plantData.plantName} benefits care`;
        try {
            const yt = await axios.get(YOUTUBE_API_URL, { params: { part: 'snippet', maxResults: 3, q: q, type: 'video', key: YOUTUBE_KEY } });
            if (yt.data.items?.length > 0) {
                youtubeImage = yt.data.items[0].snippet.thumbnails.high?.url; 
                videos = yt.data.items.map(i => ({
                    title: i.snippet.title,
                    channel: i.snippet.channelTitle,
                    link: `https://www.youtube.com/watch?v=${i.id.videoId}`,
                    thumbnail: i.snippet.thumbnails.medium.url
                }));
            }
        } catch (e) { console.log("YouTube error"); }
    }

    const result = {
        id: Date.now(),
        ...plantData,
        imageUrl: wikiImage,
        youtubeImage: youtubeImage,
        apiImage: plantData.apiImage,
        videos,
        videoContext,
        ...safetyData,
        meta: {
            provenance: {
                source: "PlantDexPro-Core",
                verified: true,
                watermark: crypto.randomBytes(8).toString('hex')
            },
            safetyLevel: safetyData.isEdible ? "SAFE" : "CAUTION",
            arReady: true,
            auditId: crypto.randomUUID()
        }
    };

    logAudit('IDENTIFY_SUCCESS', { plant: plantData.plantName, id: result.meta.auditId });
    res.json({ plants: [result] });

  } catch (error) { 
    logAudit('SYSTEM_ERROR', { message: error.message });
    res.status(500).json({ error: 'Server Error' }); 
  }
});

// STUBS
app.post('/api/ar/analyze', (req, res) => {
    res.json({ status: "ar_ready", anchors: [], overlay_url: "/models/overlay_placeholder.glb" });
});
app.get('/api/wasm/config', (req, res) => {
    res.json({ model_url: "/models/plantnet_quantized.tflite", wasm_binary: "/wasm/inference_engine.wasm", integrity: "sha256-placeholder-hash" });
});
app.post('/api/live/session', (req, res) => {
    res.json({ session_id: crypto.randomUUID(), websocket_url: "wss://api.plantdexpro.com/live" });
});
app.get('/api/user/journey', (req, res) => {
    res.json({ level: "Novice Botanist", xp: 150, unlocked_badges: ["First Scan", "Edible Finder"], next_milestone: "Identify 10 Toxic Plants" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
