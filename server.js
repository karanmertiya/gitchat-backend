import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

app.post('/init', async (req, res) => {
    try {
        const { user_id, workspace_name } = req.body;
        const { data: workspace, error: wsError } = await supabase.from('workspaces').insert([{ name: workspace_name, created_by: user_id }]).select().single();
        if (wsError) throw wsError;
        const { data: branch, error: brError } = await supabase.from('branches').insert([{ workspace_id: workspace.id, name: 'main' }]).select().single();
        if (brError) throw brError;
        res.json({ success: true, workspace, branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { branch_id, prompt, parent_message_id } = req.body;

        // Step A: Save the User's Message
        const { data: userMessage, error: userMsgError } = await supabase
            .from('messages')
            .insert([{ branch_id, sender_type: 'user', content: prompt, parent_message_id: parent_message_id || null }])
            .select()
            .single();
        if (userMsgError) throw userMsgError;

        // Step B: Climb the Tree
        let history = [];
        let currentParentId = parent_message_id;
        
        console.log(`\n[DEBUG] ----------------------------------`);
        console.log(`[DEBUG] Incoming Prompt: "${prompt}"`);
        console.log(`[DEBUG] Starting tree climb from parent ID: ${currentParentId}`);

        while (currentParentId) {
            const { data: parentMsg, error } = await supabase
                .from('messages')
                .select('content, sender_type, parent_message_id')
                .eq('id', currentParentId)
                .single();

            if (error) {
                console.error(`[DEBUG] ❌ Supabase Error fetching message ${currentParentId}:`, error.message);
                break;
            }
            if (!parentMsg) {
                console.log(`[DEBUG] ⚠️ Message ${currentParentId} not found in DB.`);
                break;
            }

            console.log(`[DEBUG] ✅ Found ancestor: Role [${parentMsg.sender_type}], Content Preview [${parentMsg.content.substring(0, 20)}...]`);

            history.unshift({
                role: parentMsg.sender_type === 'ai' ? 'model' : 'user',
                parts: [{ text: parentMsg.content }]
            });

            currentParentId = parentMsg.parent_message_id;
        }

        console.log(`[DEBUG] Final History Array Length: ${history.length}`);
        console.log(`[DEBUG] ----------------------------------\n`);

        // Step C: Call Gemini
        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(prompt);
        const aiResponse = result.response.text();

        // Step D: Save the AI's Message
        const { data: aiMessage, error: aiMsgError } = await supabase
            .from('messages')
            .insert([{ branch_id, sender_type: 'ai', content: aiResponse, parent_message_id: userMessage.id }])
            .select()
            .single();
        if (aiMsgError) throw aiMsgError;

        res.json({ success: true, userMessageId: userMessage.id, aiMessageId: aiMessage.id, aiResponse: aiMessage.content });

    } catch (error) {
        console.error("Chat Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Git-Chat API running on http://localhost:${PORT}`);
});