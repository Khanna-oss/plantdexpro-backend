require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');

const app = express();

// --- Middleware ---
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// --- Configuration ---
const PLANT_KEY = (process.env.PLANT_ID_KEY || process.env.Plant_net_api || '').trim();
const YOUTUBE_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

// --- Helper: Get High-Quality Wiki Image ---
async function getWikiImage(query) {
    if (!query) return null;
    try {
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
        const response = await axios.get(url);
        if (response.data?.thumbnail?.source) {
            return response.data.thumbnail.source;
        }
    } catch (e) {
        // Ignore wiki errors
    }
    return null;
}

// --- Helper: Identify using Pl@ntNet ---
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

// --- Helper: Identify using Plant.id ---
async function identifyWithPlantId(base64Image) {
    const url = 'https://api.plant.id/v2/identify';
    const response = await axios.post(url, {
        images: [base64Image], 
        modifiers: ["crops_fast", "similar_images"],
        plant_details: ["common_names", "url", "wiki_description", "taxonomy"]
    }, {
        headers: { 'Api-Key': PLANT_KEY, 'Content-Type': 'application/json' },
    });

    const suggestion = response.data.suggestions?.[0];
    if (!suggestion) throw new Error("No match found.");

    return {
        plantName: suggestion.plant_name,
        scientificName: suggestion.plant_details?.scientific_name,
        probability: suggestion.probability,
        apiImage: suggestion.similar_images?.[0]?.url || null
    };
}

app.post('/api/identify-plant', async (req, res) => {
  try {
    const { image } = req.body; 
    if (!image) return res.status(400).json({ error: 'No image data' });

    // 1. ID Plant
    let plantData;
    try {
        if (PLANT_KEY.startsWith('2')) {
             plantData = await identifyWithPlantNet(image);
        } else {
             plantData = await identifyWithPlantId(image);
        }
    } catch (err) {
        return res.status(500).json({ error: 'Identification API failed. Check Key.' });
    }

    // 2. Safety Analysis (Gemini)
    let safetyData = { isEdible: false, toxicParts: [], safetyWarnings: [], description: "" };
    try {
        const prompt = `Analyze "${plantData.plantName}". Return strictly valid JSON (no markdown): {"isEdible": boolean, "edibleParts": ["string"], "toxicParts": ["string"], "safetyWarnings": ["string"], "description": "2 sentences."}`;
        const geminiResp = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: { responseMimeType: "application/json" }
        });
        const text = geminiResp.text.replace(/```json|```/g, '').trim();
        safetyData = JSON.parse(text);
    } catch (e) {
        safetyData.description = "Safety info unavailable.";
    }

    // 3. Videos & Layer 2 Image (YouTube Thumbnail)
    let videos = [];
    let videoContext = safetyData.isEdible ? "recipes" : "uses";
    let youtubeImage = null;
    
    if (YOUTUBE_KEY && plantData.plantName) {
        const q = safetyData.isEdible 
            ? `how to cook ${plantData.plantName} recipe`
            : `amazing uses of ${plantData.plantName} plant care`;
            
        try {
            const yt = await axios.get(YOUTUBE_API_URL, {
                params: { part: 'snippet', maxResults: 3, q: q, type: 'video', key: YOUTUBE_KEY }
            });
            
            if (yt.data.items && yt.data.items.length > 0) {
                // Layer 2: Use the high-res thumbnail from the top video
                youtubeImage = yt.data.items[0].snippet.thumbnails.high?.url || yt.data.items[0].snippet.thumbnails.medium?.url;
                
                videos = yt.data.items.map(i => ({
                    title: i.snippet.title,
                    channel: i.snippet.channelTitle,
                    link: `https://www.youtube.com/watch?v=${i.id.videoId}`,
                    thumbnail: i.snippet.thumbnails.medium.url
                }));
            }
        } catch (e) { console.log("YouTube error"); }
    }

    // 4. Layer 1 Image (Wiki)
    const wikiImage = await getWikiImage(plantData.scientificName) || await getWikiImage(plantData.plantName);

    res.json({
        plants: [{
            id: Date.now(),
            ...plantData,
            // Pass all layers to frontend for intelligent fallback
            imageUrl: wikiImage,      
            youtubeImage: youtubeImage,
            apiImage: plantData.apiImage,
            videos,
            videoContext,
            ...safetyData
        }]
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server Error' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));