
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
app.use(express.json({ limit: '10mb' }));

// --- Configuration & Key Cleaning ---
// We use .trim() to remove accidental spaces
const PLANT_KEY = (process.env.PLANT_ID_KEY || process.env.Plant_net_api || '').trim();
const YOUTUBE_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';

// --- Startup Check ---
console.log("--- API Key Status ---");
console.log(`Plant Key:    ${PLANT_KEY ? 'Loaded (' + PLANT_KEY.substring(0,5) + '...)' : 'MISSING'}`);
console.log(`YouTube Key:  ${YOUTUBE_KEY ? 'Loaded' : 'MISSING'}`);
console.log(`Gemini Key:   ${GEMINI_KEY ? 'Loaded' : 'MISSING'}`);
console.log("----------------------");

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

// --- Helper: Identify using Pl@ntNet (For keys starting with '2a' or '2b') ---
async function identifyWithPlantNet(base64Image, apiKey) {
    console.log("   -> Detected Pl@ntNet Key. Using Pl@ntNet API...");
    const form = new FormData();
    const buffer = Buffer.from(base64Image, 'base64');
    form.append('images', buffer, 'image.jpg');
    
    // Pl@ntNet requires 'organs' param, usually 'auto' works or 'leaf'
    form.append('organs', 'auto'); 

    const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${apiKey}`;
    
    const response = await axios.post(url, form, {
        headers: form.getHeaders()
    });

    // Normalize response to match our app structure
    const bestMatch = response.data.results[0];
    return {
        plantName: bestMatch.species.commonNames[0] || bestMatch.species.scientificNameWithoutAuthor,
        scientificName: bestMatch.species.scientificNameWithoutAuthor,
        probability: bestMatch.score,
        refImage: bestMatch.images?.[0]?.url?.m // medium size url
    };
}

// --- Helper: Identify using Plant.id (For other keys) ---
async function identifyWithPlantId(base64Image, apiKey) {
    console.log("   -> Detected Plant.id Key. Using Plant.id API...");
    const url = 'https://api.plant.id/v2/identify';
    const response = await axios.post(url, {
        images: [base64Image], 
        modifiers: ["crops_fast", "similar_images"],
        plant_details: ["common_names", "url", "wiki_description", "taxonomy"]
    }, {
        headers: {
            'Api-Key': apiKey,
            'Content-Type': 'application/json',
        },
    });

    const suggestion = response.data.suggestions?.[0];
    if (!suggestion) throw new Error("No suggestion found");

    return {
        plantName: suggestion.plant_name,
        scientificName: suggestion.plant_details?.scientific_name,
        probability: suggestion.probability,
        refImage: suggestion.similar_images?.[0]?.url
    };
}

app.post('/api/identify-plant', async (req, res) => {
  try {
    const { image } = req.body; 
    if (!image) return res.status(400).json({ error: 'Image data required' });

    // --- Step 1: Identification Strategy Switch ---
    console.log('1. Identifying Plant...');
    let plantData;

    try {
        if (PLANT_KEY.startsWith('2a') || PLANT_KEY.startsWith('2b')) {
            // Pl@ntNet Key Format
            plantData = await identifyWithPlantNet(image, PLANT_KEY);
        } else {
            // Default to Plant.id
            plantData = await identifyWithPlantId(image, PLANT_KEY);
        }
        console.log(`   > Identified: ${plantData.plantName}`);
    } catch (apiError) {
        console.error("   ! ID API Error:", apiError.response?.data || apiError.message);
        // If specialized API fails, try to fallback to Gemini Vision directly?
        // For now, return error to let user know key/service failed.
        return res.status(500).json({ error: 'Identification API failed. Please check your API Key service provider.' });
    }

    // --- Step 2: Gemini Safety Analysis ---
    console.log('2. Analysis & Safety...');
    let safetyData = {};
    try {
        const safetyPrompt = `
          Analyze the plant "${plantData.plantName}" (Scientific: ${plantData.scientificName}).
          Return valid JSON:
          {
            "isEdible": boolean,
            "edibleParts": ["string"],
            "toxicParts": ["string"],
            "safetyWarnings": ["string"],
            "description": "string"
          }
        `;

        const geminiResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: safetyPrompt,
          config: { responseMimeType: "application/json" }
        });
        
        safetyData = JSON.parse(geminiResponse.text || "{}");
    } catch (geminiError) {
        console.error("   ! Gemini Error:", geminiError.message);
        safetyData = { isEdible: false, description: "Safety info unavailable." };
    }

    // --- Step 3: YouTube Recipes ---
    let videos = [];
    if (safetyData.isEdible && YOUTUBE_KEY) {
        console.log('3. Fetching Recipes...');
        try {
            const ytResponse = await axios.get(YOUTUBE_API_URL, {
                params: {
                    part: 'snippet',
                    maxResults: 3,
                    q: `how to cook ${plantData.plantName} recipe`,
                    type: 'video',
                    key: YOUTUBE_KEY
                }
            });
            videos = ytResponse.data.items.map(item => ({
                title: item.snippet.title,
                channel: item.snippet.channelTitle,
                link: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                thumbnail: item.snippet.thumbnails.medium.url
            }));
        } catch (ytError) {
            console.error("   ! YouTube Error:", ytError.message);
        }
    }

    // --- Response ---
    const result = {
      id: Date.now(),
      commonName: plantData.plantName,
      scientificName: plantData.scientificName,
      confidenceScore: plantData.probability,
      imageUrl: plantData.refImage, 
      videos: videos,
      ...safetyData
    };

    res.json({ plants: [result] });

  } catch (error) {
    console.error('SERVER ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🌿 PlantDexPro Server running on port ${PORT}`);
});
