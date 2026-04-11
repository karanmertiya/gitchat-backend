import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';

dotenv.config();

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Primary Engine: Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Backup Engine: Groq (The speed demon with the crazy free tier)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 1. Initialize (Find or Create)
app.post('/init', async (req, res) => {
    try {
        const { user_id, workspace_name } = req.body;

        // 1. Try to find an existing workspace for this user
        let { data: workspace } = await supabase
            .from('workspaces')
            .select('*')
            .eq('created_by', user_id)
            .eq('name', workspace_name)
            .single();

        // 2. If it doesn't exist, create it
        if (!workspace) {
            const { data: newWs, error: wsError } = await supabase
                .from('workspaces')
                .insert([{ name: workspace_name, created_by: user_id }])
                .select()
                .single();
            if (wsError) throw wsError;
            workspace = newWs;
        }

        // 3. Try to find the 'main' branch for this workspace
        let { data: branch } = await supabase
            .from('branches')
            .select('*')
            .eq('workspace_id', workspace.id)
            .eq('name', 'main')
            .single();

        // 4. If main branch doesn't exist, create it
        if (!branch) {
            const { data: newBr, error: brError } = await supabase
                .from('branches')
                .insert([{ workspace_id: workspace.id, name: 'main' }])
                .select()
                .single();
            if (brError) throw brError;
            branch = newBr;
        }

        res.json({ success: true, workspace, branch });
    } catch (error) {
        console.error("Init Error:", error);
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

// 4. Merge Branch (With Groq Fallback)
app.post('/merge', async (req, res) => {
    try {
        const { source_branch_id, target_branch_id, latest_message_id_in_source, parent_message_id_in_target } = req.body;

        let historyText = "";
        let currentId = latest_message_id_in_source;
        while (currentId) {
            const { data: msg } = await supabase.from('messages').select('content, sender_type, parent_message_id').eq('id', currentId).single();
            if (!msg) break;
            historyText = `[${msg.sender_type.toUpperCase()}]: ${msg.content}\n\n` + historyText;
            currentId = msg.parent_message_id;
        }

        const mergePrompt = `You are a Git-Merge agent for an AI chat app. Read the following conversational tangent and write a concise, 2-sentence summary of the final conclusion or decision made. \n\nTangent History:\n${historyText}`;
        
        let mergeSummary = "";
        try {
            // Attempt 1: Gemini
            const result = await model.generateContent(mergePrompt);
            mergeSummary = result.response.text();
        } catch (geminiError) {
            console.warn("⚠️ Gemini merge failed, tagging in Groq:", geminiError.message);
            // Attempt 2: Groq Fallback
            const completion = await groq.chat.completions.create({
                messages: [{ role: "user", content: mergePrompt }],
                model: "llama-3.1-8b-instant", // Updated model
            });
            mergeSummary = completion.choices[0]?.message?.content || "Branch merged successfully.";
        }

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

// 5. Chat Endpoint (With Groq Fallback)
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

        let aiResponse = "";
        try {
            // Attempt 1: Gemini
            const chat = model.startChat({ history: history });
            const result = await chat.sendMessage(prompt);
            aiResponse = result.response.text();
        } catch (geminiError) {
            console.warn("⚠️ Gemini chat failed, tagging in Groq:", geminiError.message);
            
            // Attempt 2: Groq Fallback! Translate Gemini's format into Groq's format
            const groqMessages = history.map(msg => ({
                role: msg.role === 'model' ? 'assistant' : 'user',
                content: msg.parts[0].text
            }));
            groqMessages.push({ role: 'user', content: prompt });

            const completion = await groq.chat.completions.create({
                messages: groqMessages,
                model: "llama-3.1-8b-instant", // Updated model
            });
            aiResponse = completion.choices[0]?.message?.content || "Sorry, both brains are currently offline!";
        }

        const { data: aiMessage, error: aiMsgError } = await supabase.from('messages').insert([{ branch_id, sender_type: 'ai', content: aiResponse, parent_message_id: userMessage.id }]).select().single();
        if (aiMsgError) throw aiMsgError;

        res.json({ success: true, userMessageId: userMessage.id, aiMessageId: aiMessage.id, aiResponse: aiMessage.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Get all branches for a workspace
app.get('/branches/:workspace_id', async (req, res) => {
    try {
        const { data: branches, error } = await supabase
            .from('branches')
            .select('*')
            .eq('workspace_id', req.params.workspace_id)
            .order('created_at', { ascending: true });
        
        if (error) throw error;
        res.json({ success: true, branches });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Get message history for a specific branch
app.get('/messages/:branch_id', async (req, res) => {
    try {
        const { data: latestMsg, error: latestErr } = await supabase
            .from('messages')
            .select('id')
            .eq('branch_id', req.params.branch_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (latestErr && latestErr.code !== 'PGRST116') throw latestErr;

        let history = [];
        if (latestMsg) {
            let currentId = latestMsg.id;
            while (currentId) {
                const { data: msg } = await supabase
                    .from('messages')
                    .select('*')
                    .eq('id', currentId)
                    .single();
                
                if (!msg) break;
                history.unshift({
                    id: msg.id,
                    role: msg.sender_type === 'ai' || msg.sender_type === 'system' ? 'ai' : 'user',
                    content: msg.content,
                    parent_message_id: msg.parent_message_id
                });
                currentId = msg.parent_message_id;
            }
        }
        res.json({ success: true, messages: history });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Git-Chat API running on http://localhost:${PORT}`));