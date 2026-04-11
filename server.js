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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 1. Initialize
app.post('/init', async (req, res) => {
    try {
        const { user_id, workspace_name } = req.body;
        const { data: existingWs, error: findWsError } = await supabase.from('workspaces').select('*').eq('created_by', user_id).eq('name', workspace_name).limit(1).maybeSingle(); 
        let currentWorkspace = existingWs;

        if (!currentWorkspace) {
            const { data: newWs, error: createWsError } = await supabase.from('workspaces').insert([{ name: workspace_name, created_by: user_id }]).select().single();
            if (createWsError) throw createWsError;
            currentWorkspace = newWs;
        }

        const { data: existingBranch, error: findBrError } = await supabase.from('branches').select('*').eq('workspace_id', currentWorkspace.id).eq('name', 'main').limit(1).maybeSingle();
        let currentBranch = existingBranch;

        if (!currentBranch) {
            const { data: newBr, error: createBrError } = await supabase.from('branches').insert([{ workspace_id: currentWorkspace.id, name: 'main' }]).select().single();
            if (createBrError) throw createBrError;
            currentBranch = newBr;
        }
        res.json({ success: true, workspace: currentWorkspace, branch: currentBranch });
    } catch (error) {
        console.error("Init Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Branching (NOW WITH ANCHOR COMMITS)
app.post('/branch', async (req, res) => {
    try {
        const { workspace_id, name, is_ephemeral, parent_message_id } = req.body;
        const { data: branch, error } = await supabase.from('branches').insert([{ workspace_id, name: name || 'New Branch', is_ephemeral: is_ephemeral || false }]).select().single();
        if (error) throw error;

        // The Fix: Anchor the new branch to the timeline so context is never lost
        if (parent_message_id) {
            await supabase.from('messages').insert([{ 
                branch_id: branch.id, 
                sender_type: 'system', 
                content: `🌱 Timeline diverged: #${branch.name}`, 
                parent_message_id: parent_message_id 
            }]);
        }
        res.json({ success: true, branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Toggle Ephemeral
app.patch('/branch/toggle', async (req, res) => {
    try {
        const { branch_id } = req.body;
        const { data: branch, error } = await supabase.from('branches').update({ is_ephemeral: false }).eq('id', branch_id).select().single();
        if (error) throw error;
        res.json({ success: true, message: "Branch is now permanent", branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Merge Branch
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

        const mergePrompt = `You are a Git-Merge agent. Summarize the following timeline into 2 concise sentences of conclusions/decisions made.\n\nTimeline:\n${historyText}`;
        let mergeSummary = "";
        try {
            const completion = await groq.chat.completions.create({ messages: [{ role: "user", content: mergePrompt }], model: "llama-3.1-8b-instant" });
            mergeSummary = completion.choices[0]?.message?.content || "Branch merged successfully.";
        } catch (e) {
            mergeSummary = "Branch merged successfully.";
        }

        const { data: systemMsg, error } = await supabase.from('messages').insert([{ branch_id: target_branch_id, sender_type: 'system', content: `🔗 MERGE COMMIT: ${mergeSummary}`, parent_message_id: parent_message_id_in_target }]).select().single();
        if (error) throw error;
        res.json({ success: true, mergeSummary: systemMsg.content, injectedMessageId: systemMsg.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Chat Endpoint (NOW WITH CONTEXT SANITIZER)
app.post('/chat', async (req, res) => {
    try {
        const { branch_id, prompt, parent_message_id } = req.body;

        const { data: userMessage, error: userMsgError } = await supabase.from('messages').insert([{ branch_id, sender_type: 'user', content: prompt, parent_message_id: parent_message_id || null }]).select().single();
        if (userMsgError) throw userMsgError;

        let rawHistory = [];
        let currentParentId = parent_message_id;
        while (currentParentId) {
            const { data: parentMsg, error } = await supabase.from('messages').select('content, sender_type, parent_message_id').eq('id', currentParentId).single();
            if (error || !parentMsg) break;
            rawHistory.unshift({ role: parentMsg.sender_type === 'ai' ? 'model' : 'user', parts: [{ text: parentMsg.content }] });
            currentParentId = parentMsg.parent_message_id;
        }

        // Fix: Gemini crashes if roles don't strictly alternate. Collapse consecutive user/system messages.
        let history = [];
        let lastRole = null;
        for (let msg of rawHistory) {
            if (msg.role !== lastRole) {
                history.push(msg);
                lastRole = msg.role;
            } else {
                history[history.length - 1].parts[0].text += `\n\n[System Notation]: ${msg.parts[0].text}`;
            }
        }

        let aiResponse = "";
        try {
            const chat = model.startChat({ history: history });
            const result = await chat.sendMessage(prompt);
            aiResponse = result.response.text();
        } catch (geminiError) {
            console.warn("⚠️ Gemini chat failed, tagging in Groq:", geminiError.message);
            const groqMessages = history.map(msg => ({ role: msg.role === 'model' ? 'assistant' : 'user', content: msg.parts[0].text }));
            groqMessages.push({ role: 'user', content: prompt });
            const completion = await groq.chat.completions.create({ messages: groqMessages, model: "llama-3.1-8b-instant" });
            aiResponse = completion.choices[0]?.message?.content || "Sorry, both brains are currently offline!";
        }

        const { data: aiMessage, error: aiMsgError } = await supabase.from('messages').insert([{ branch_id, sender_type: 'ai', content: aiResponse, parent_message_id: userMessage.id }]).select().single();
        if (aiMsgError) throw aiMsgError;

        res.json({ success: true, userMessageId: userMessage.id, aiMessageId: aiMessage.id, aiResponse: aiMessage.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Get all branches
app.get('/branches/:workspace_id', async (req, res) => {
    try {
        const { data: branches, error } = await supabase.from('branches').select('*').eq('workspace_id', req.params.workspace_id).order('created_at', { ascending: true });
        if (error) throw error;
        res.json({ success: true, branches });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Get messages
app.get('/messages/:branch_id', async (req, res) => {
    try {
        const { data: latestMsg, error: latestErr } = await supabase.from('messages').select('id').eq('branch_id', req.params.branch_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
        let history = [];
        if (latestMsg) {
            let currentId = latestMsg.id;
            while (currentId) {
                const { data: msg } = await supabase.from('messages').select('*').eq('id', currentId).single();
                if (!msg) break;
                history.unshift({ id: msg.id, role: msg.sender_type === 'ai' || msg.sender_type === 'system' ? (msg.sender_type === 'system' ? 'system' : 'ai') : 'user', content: msg.content, parent_message_id: msg.parent_message_id });
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