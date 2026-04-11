import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// 1. Initialize
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

// 2. Branching
app.post('/branch', async (req, res) => {
    try {
        const { workspace_id, name, is_ephemeral } = req.body;
        const { data: branch, error } = await supabase.from('branches').insert([{ workspace_id, name: name || 'New Branch', is_ephemeral: is_ephemeral || false }]).select().single();
        if (error) throw error;
        res.json({ success: true, branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Toggle Ephemeral (Make Permanent)
app.patch('/branch/toggle', async (req, res) => {
    try {
        const { branch_id } = req.body;
        const { data: branch, error } = await supabase
            .from('branches')
            .update({ is_ephemeral: false })
            .eq('id', branch_id)
            .select()
            .single();
        if (error) throw error;
        res.json({ success: true, message: "Branch is now permanent", branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Merge Branch (The AI Auto-Summary)
app.post('/merge', async (req, res) => {
    try {
        const { source_branch_id, target_branch_id, latest_message_id_in_source, parent_message_id_in_target } = req.body;

        // Step A: Read the source branch history
        let historyText = "";
        let currentId = latest_message_id_in_source;
        while (currentId) {
            const { data: msg } = await supabase.from('messages').select('content, sender_type, parent_message_id').eq('id', currentId).single();
            if (!msg) break;
            historyText = `[${msg.sender_type.toUpperCase()}]: ${msg.content}\n\n` + historyText;
            currentId = msg.parent_message_id;
        }

        // Step B: Ask AI to summarize the tangent
        const mergePrompt = `You are a Git-Merge agent for an AI chat app. Read the following conversational tangent and write a concise, 2-sentence summary of the final conclusion or decision made. \n\nTangent History:\n${historyText}`;
        const result = await model.generateContent(mergePrompt);
        const mergeSummary = result.response.text();

        // Step C: Inject summary into the target branch (Main) as a system message
        const { data: systemMsg, error } = await supabase
            .from('messages')
            .insert([{ 
                branch_id: target_branch_id, 
                sender_type: 'system', 
                content: `MERGE COMMIT: ${mergeSummary}`, 
                parent_message_id: parent_message_id_in_target 
            }])
            .select()
            .single();
        
        if (error) throw error;
        res.json({ success: true, mergeSummary: systemMsg.content, injectedMessageId: systemMsg.id });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Chat Endpoint (Unchanged from our working version)
app.post('/chat', async (req, res) => {
    try {
        const { branch_id, prompt, parent_message_id } = req.body;

        const { data: userMessage, error: userMsgError } = await supabase.from('messages').insert([{ branch_id, sender_type: 'user', content: prompt, parent_message_id: parent_message_id || null }]).select().single();
        if (userMsgError) throw userMsgError;

        let history = [];
        let currentParentId = parent_message_id;
        while (currentParentId) {
            const { data: parentMsg, error } = await supabase.from('messages').select('content, sender_type, parent_message_id').eq('id', currentParentId).single();
            if (error || !parentMsg) break;
            history.unshift({ role: parentMsg.sender_type === 'ai' ? 'model' : 'user', parts: [{ text: parentMsg.content }] });
            currentParentId = parentMsg.parent_message_id;
        }

        const chat = model.startChat({ history: history });
        const result = await chat.sendMessage(prompt);
        const aiResponse = result.response.text();

        const { data: aiMessage, error: aiMsgError } = await supabase.from('messages').insert([{ branch_id, sender_type: 'ai', content: aiResponse, parent_message_id: userMessage.id }]).select().single();
        if (aiMsgError) throw aiMsgError;

        res.json({ success: true, userMessageId: userMessage.id, aiMessageId: aiMessage.id, aiResponse: aiMessage.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Git-Chat API running on http://localhost:${PORT}`));
