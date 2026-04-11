import dotenv from 'dotenv';
dotenv.config();

async function listAvailableModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("❌ No API key found in .env");
        return;
    }

    try {
        console.log("Fetching available models from Google...");
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        if (data.error) {
            console.error("API Error:", data.error.message);
            return;
        }

        console.log("\n✅ Available Models for Text Generation:\n");
        
        // Filter for models that actually support chat/text generation
        const textModels = data.models.filter(model => 
            model.supportedGenerationMethods.includes("generateContent")
        );

        textModels.forEach(model => {
            console.log(`- Model Name: ${model.name.replace('models/', '')}`);
            console.log(`  Description: ${model.description}\n`);
        });

        console.log("👉 Pick one of the 'Model Names' above and use it in your server.js");

    } catch (error) {
        console.error("Network Error:", error.message);
    }
}

listAvailableModels();