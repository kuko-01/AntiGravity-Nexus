import { GoogleGenAI } from "@google/genai";
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config();

// Fix Credentials for Vertex AI
const credentialsPath = path.resolve(__dirname, 'gcp-credentials.json');
if (fs.existsSync(credentialsPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    console.log(`[Setup] Credentials set to: ${credentialsPath}`);
} else {
    console.warn(`[Setup] Warning: gcp-credentials.json not found at ${credentialsPath}`);
}

async function main() {
    console.log("\n=== Checking AI Studio (API Key) Models ===");
    try {
        if (process.env.GEMINI_API_KEY) {
            const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
            console.log("Listing AI Studio models...");
            const response = await ai.models.list();
            // console.log("Raw response keys:", Object.keys(response));

            // Handle different possible structures (some SDK versions return array directly, some { models: [] }, some { active_models: [] }?)
            let modelsList: any[] = [];
            if (Array.isArray(response)) modelsList = response;
            else if (Array.isArray((response as any).models)) modelsList = (response as any).models;
            else {
                console.log("Unknown structure:", JSON.stringify(response, null, 2));
            }

            if (modelsList.length > 0) {
                modelsList.slice(0, 10).forEach((m: any) => console.log(`[AI Studio] ${m.name} (${m.displayName})`));
                console.log(`... and ${modelsList.length - 10} more.`);
            } else {
                console.log("[AI Studio] No models found or empty list.");
            }
        } else {
            console.log("No GEMINI_API_KEY found.");
        }
    } catch (e: any) {
        console.error("AI Studio Error:", e.message);
    }

    console.log("\n=== Checking Vertex AI Models ===");
    try {
        if (process.env.GCP_PROJECT_ID) {
            const ai = new GoogleGenAI({
                vertexai: true,
                project: process.env.GCP_PROJECT_ID,
                location: process.env.GCP_LOCATION || 'us-central1'
            });
            console.log(`Listing Vertex AI models for ${process.env.GCP_PROJECT_ID} in ${process.env.GCP_LOCATION}...`);
            const response = await ai.models.list();

            let modelsList: any[] = [];
            if (Array.isArray(response)) modelsList = response;
            else if (Array.isArray((response as any).models)) modelsList = (response as any).models;
            else {
                console.log("Unknown structure:", JSON.stringify(response, null, 2));
            }

            for (const m of modelsList) {
                // Filter for image/gemini relevant ones to avoid spamming 100s of legacy models
                if (m.name.includes('gemini') || m.name.includes('imagen')) {
                    console.log(`[Vertex AI] ${m.name}`);
                }
            }
        } else {
            console.log("No GCP_PROJECT_ID found.");
        }
    } catch (e: any) {
        console.error("Vertex AI Error:", e.message);
    }
}

main();
