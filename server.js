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

// --- Configuration & Key Cleaning ---
const PLANT_KEY = (process.env.PLANT_ID_KEY || process.env.Plant_net_api || '').trim();
const YOUTUBE_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';

// --- Startup Check ---
console.log("--- API Key Status ---");
console.log(`Plant Key:    ${PLANT_KEY ? 'Loaded' : 'MISSING'}`);
console.log(`YouTube Key:  ${YOUTUBE_KEY ? 'Loaded' : 'MISSING'}`);
console.log(`Gemini Key:   ${GEMINI_KEY ? 'Loaded' : 'MISSING'}`);
console.log("----------------------");

const ai = new GoogleGenAI({ apiKey: GEMINI_KEY });

// --- Helper: Get High-Quality Wiki Image ---
async function getWikiImage(query) {
    if (!query) return null;
    try {
        // Wikipedia REST API
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`;
        const response = await axios.get(url);
        if (response.data?.thumbnail?.source) {
            return response.data.thumbnail.source;
        }
    } catch (e) {
        // Silent fail
    }
    return null;
}

// Intelligent Image Fetcher
async function getBestPlantImage(scientificName, commonName) {
    // 1. Try Scientific Name (Most Accurate)
    let img = await getWikiImage(scientificName);
    if (img) return img;

    // 2. Try Common Name
    if (commonName) {
        img = await getWikiImage(commonName);
        if (img) return img;
    }

    // 3. Try Genus only (Fallback for rare species)
    if (scientificName) {
        const genus = scientificName.split(' ')[0];
        if (genus && genus !== scientificName) {
             img = await getWikiImage(genus);
             if (img) return img;
        }
    }

    return null;
}

// --- Helper: Identify using Pl@ntNet ---
async function identifyWithPlantNet(base64Image) {
    console.log("   -> Mode: Pl@ntNet API");
    const form = new FormData();
    const buffer = Buffer.from(base64Image, 'base64');
    form.append('images', buffer, 'image.jpg');
    form.append('organs', 'auto'); 

    const url = `https://my-api.plantnet.org/v2/identify/all?api-key=${PLANT_KEY}`;
    const response = await axios.post(url, form, { headers: form.getHeaders() });

    const bestMatch = response.data.results[0];
    if (!bestMatch) throw new Error("No plant identified by Pl@ntNet");

    return {
        plantName: bestMatch.species.commonNames[0] || bestMatch.species.scientificNameWithoutAuthor,
        scientificName: bestMatch.species.scientificNameWithoutAuthor,
        probability: bestMatch.score,
        apiImage: bestMatch.images && bestMatch.images.length > 0 ? bestMatch.images[0].url.m : null
    };
}

// --- Helper: Identify using Plant.id ---
async function identifyWithPlantId(base64Image) {
    console.log("   -> Mode: Plant.id API");
    const url = 'https://api.plant.id/v2/identify';
    const response = await axios.post(url, {
        images: [base64Image], 
        modifiers: ["crops_fast", "similar_images"],
        plant_details: ["common_names", "url", "wiki_description", "taxonomy"]
    }, {
        headers: { 'Api-Key': PLANT_KEY, 'Content-Type': 'application/json' },
    });

    const suggestion = response.data.suggestions?.[0];
    if (!suggestion) throw new Error("No suggestion found from Plant.id");

    return {
        plantName: suggestion.plant_name,
        scientificName: suggestion.plant_details?.scientific_name,
        probability: suggestion.probability,
        apiImage: suggestion.similar_images?.[0]?.url
    };
}

app.post('/api/identify-plant', async (req, res) => {
  try {
    const { image } = req.body; 
    if (!image) return res.status(400).json({ error: 'Image data required' });

    // 1. Identify
    console.log('1. Identifying Plant...');
    let plantData;

    try {
        if (PLANT_KEY.startsWith('2a') || PLANT_KEY.startsWith('2b')) {
            plantData = await identifyWithPlantNet(image);
        } else {
            plantData = await identifyWithPlantId(image);
        }
        console.log(`   > Found: ${plantData.plantName}`);
    } catch (apiError) {
        console.error("   ! ID API Error:", apiError.response?.data || apiError.message);
        return res.status(500).json({ error: 'Identification failed. Check API Key or Quota.' });
    }

    // 1.5 Get Best Image (Wiki -> Genus -> API)
    const wikiImage = await getBestPlantImage(plantData.scientificName, plantData.plantName);
    const finalDisplayImage = wikiImage || plantData.apiImage;

    // 2. Gemini Safety Analysis
    console.log('2. Safety Check...');
    let safetyData = { isEdible: false, toxicParts: [], safetyWarnings: [], description: "", funFact: "" };
    
    try {
        const safetyPrompt = `
          Analyze the plant "${plantData.plantName}" (Scientific: ${plantData.scientificName}).
          Return strict JSON (no markdown):
          {
            "isEdible": boolean,
            "edibleParts": ["string"],
            "toxicParts": ["string"],
            "safetyWarnings": ["string"],
            "description": "Brief 2 sentence description.",
            "funFact": "A short, interesting fun fact about this plant."
          }
        `;

        const geminiResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: safetyPrompt,
          config: { responseMimeType: "application/json" }
        });
        
        const text = geminiResponse.text;
        if (text) {
            const cleanJson = text.replace(/```json|```/g, '').trim();
            safetyData = JSON.parse(cleanJson);
        }
    } catch (geminiError) {
        console.error("   ! Gemini Error:", geminiError.message);
        safetyData.description = `Identified as ${plantData.plantName}. Safety info unavailable.`;
    }

    // 3. YouTube Contextual Search
    let videos = [];
    let videoContext = safetyData.isEdible ? "recipes" : "uses";
    let youtubeImage = null; // Layer 2 fallback

    if (YOUTUBE_KEY && plantData.plantName) {
        const searchTerm = safetyData.isEdible 
            ? `how to cook ${plantData.plantName} recipe`
            : `${plantData.plantName} plant benefits and care`;
            
        console.log(`3. Finding Videos (${searchTerm})...`);
        try {
            const ytResponse = await axios.get(YOUTUBE_API_URL, {
                params: {
                    part: 'snippet',
                    maxResults: 3,
                    q: searchTerm,
                    type: 'video',
                    key: YOUTUBE_KEY
                }
            });
            
            if (ytResponse.data.items && ytResponse.data.items.length > 0) {
                // Grab high-res thumbnail from first video as fallback
                youtubeImage = ytResponse.data.items[0].snippet.thumbnails.high?.url || ytResponse.data.items[0].snippet.thumbnails.medium?.url;

                videos = ytResponse.data.items.map(item => ({
                    title: item.snippet.title,
                    channel: item.snippet.channelTitle,
                    link: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                    thumbnail: item.snippet.thumbnails.medium.url
                }));
            }
        } catch (ytError) {
            console.error("   ! YouTube Error:", ytError.message);
        }
    }

    const result = {
      id: Date.now(),
      commonName: plantData.plantName,
      scientificName: plantData.scientificName,
      confidenceScore: plantData.probability,
      imageUrl: finalDisplayImage, 
      youtubeImage: youtubeImage, // Sent to frontend for Layer 2 fallback
      apiImage: plantData.apiImage, // Sent for Layer 3 fallback
      videos: videos,
      videoContext: videoContext,
      ...safetyData
    };

    res.json({ plants: [result] });

  } catch (error) {
    console.error('SERVER FATAL:', error.message);
    res.status(500).json({ error: 'Internal Server Error: ' + error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🌿 PlantDexPro Server running on port ${PORT}`);
});