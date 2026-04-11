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

// 1. Initialize a new Workspace and Main Branch
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

// 2. Create a New Branch (The Git Checkout)
app.post('/branch', async (req, res) => {
    try {
        const { workspace_id, name, is_ephemeral } = req.body;
        
        // We just create a new branch record. The message tree handles the actual history!
        const { data: branch, error } = await supabase
            .from('branches')
            .insert([{ 
                workspace_id, 
                name: name || 'New Branch',
                is_ephemeral: is_ephemeral || false 
            }])
            .select()
            .single();

        if (error) throw error;
        res.json({ success: true, branch });
    } catch (error) {
        console.error("Branch Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// 3. Chat Endpoint (With Tree-Climbing Context Memory)
app.post('/chat', async (req, res) => {
    try {
        const { branch_id, prompt, parent_message_id } = req.body;

        const { data: userMessage, error: userMsgError } = await supabase
            .from('messages')
            .insert([{ branch_id, sender_type: 'user', content: prompt, parent_message_id: parent_message_id || null }])
            .select()
            .single();
        if (userMsgError) throw userMsgError;

        let history = [];
        let currentParentId = parent_message_id;

        console.log(`\n[DEBUG] Incoming Prompt: "${prompt}"`);

        while (currentParentId) {
            const { data: parentMsg, error } = await supabase
                .from('messages')
                .select('content, sender_type, parent_message_id')
                .eq('id', currentParentId)
                .single();

            if (error || !parentMsg) break;

            history.unshift({
                role: parentMsg.sender_type === 'ai' ? 'model' : 'user',
                parts: [{ text: parentMsg.content }]
            });

            currentParentId = parentMsg.parent_message_id;
        }

        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(prompt);
        const aiResponse = result.response.text();

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
