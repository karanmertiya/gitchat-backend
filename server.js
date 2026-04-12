import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import pdfParse from 'pdf-parse'; // 🔥 NEW: PDF Parsing Engine

dotenv.config();

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '50mb' })); // Increased to 50mb for large PDFs and Images

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) console.error("🚨 CRITICAL: Missing Supabase Keys!");

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.post('/init', async (req, res) => {
    try {
        const { user_id, workspace_name, join_id } = req.body;
        let currentWorkspace;

        if (!user_id) throw new Error("Missing user_id from frontend.");

        if (join_id) {
            const { data: joinedWs, error: joinErr } = await supabase.from('workspaces').select('*').eq('id', join_id).maybeSingle();
            if (joinErr) throw joinErr;
            if (joinedWs) currentWorkspace = joinedWs;
        }

        if (!currentWorkspace) {
            const { data: existingWs, error: existErr } = await supabase.from('workspaces').select('*').eq('created_by', user_id).eq('name', workspace_name).limit(1).maybeSingle();
            if (existErr) throw existErr;
            
            if (existingWs) {
                currentWorkspace = existingWs;
            } else {
                const { data: newWs, error: createWsError } = await supabase.from('workspaces').insert([{ name: workspace_name, created_by: user_id }]).select().single();
                if (createWsError) throw new Error(`Database Insert Failed: ${createWsError.message}`);
                currentWorkspace = newWs;
            }
        }

        const { data: existingBranch, error: branchErr } = await supabase.from('branches').select('*').eq('workspace_id', currentWorkspace.id).eq('name', 'main').limit(1).maybeSingle();
        if (branchErr) throw branchErr;
        
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

app.post('/branch', async (req, res) => {
    try {
        const { workspace_id, name, is_ephemeral, parent_message_id, parent_branch_id } = req.body;
        
        const { data: branch, error: brError } = await supabase.from('branches').insert([{ 
            workspace_id, name: name || 'New Branch', is_ephemeral: is_ephemeral || false, parent_branch_id: parent_branch_id || null 
        }]).select().single();
        if (brError) throw brError;

        let systemMsgId = null;
        if (parent_message_id) {
            let ancestors = [];
            let currentId = parent_message_id;
            while (currentId) {
                const { data: msg } = await supabase.from('messages').select('*').eq('id', currentId).single();
                if (!msg) break;
                ancestors.unshift(msg); 
                currentId = msg.parent_message_id;
            }

            let previousId = null;
            for (let msg of ancestors) {
                const { data: copyMsg, error: copyErr } = await supabase.from('messages').insert([{
                    branch_id: branch.id, sender_type: msg.sender_type, content: msg.content, parent_message_id: previousId 
                }]).select().single();
                if (copyErr) throw copyErr;
                previousId = copyMsg.id;
            }

            const { data: sysMsg, error: sysErr } = await supabase.from('messages').insert([{ 
                branch_id: branch.id, sender_type: 'system', content: `🌱 Timeline diverged: #${branch.name}`, parent_message_id: previousId 
            }]).select().single();
            if (sysErr) throw sysErr;
            if(sysMsg) systemMsgId = sysMsg.id;
        }
        res.json({ success: true, branch, systemMsgId });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/branch/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('branches').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/branch/toggle', async (req, res) => {
    try {
        const { branch_id } = req.body;
        const { data: branch, error } = await supabase.from('branches').update({ is_ephemeral: false }).eq('id', branch_id).select().single();
        if (error) throw error;
        res.json({ success: true, branch });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/merge', async (req, res) => {
    try {
        const { source_branch_id, target_branch_id, latest_message_id_in_source, parent_message_id_in_target, frontendHistory } = req.body;
        
        let actualTargetParentId = parent_message_id_in_target;
        if (!actualTargetParentId) {
            const { data: targetMsgs } = await supabase.from('messages').select('id').eq('branch_id', target_branch_id).order('created_at', { ascending: false }).limit(1);
            if (targetMsgs && targetMsgs.length > 0) actualTargetParentId = targetMsgs[0].id;
        }

        let historyText = "";
        if (frontendHistory && Array.isArray(frontendHistory)) {
            historyText = frontendHistory.filter(m => m.role !== 'system' && m.id !== 'temp').map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
        }

        const mergePrompt = `You are a Git-Merge compiler agent. Extract the final, functional code, core decisions, or ultimate conclusion from this tangent timeline. Do not narrate. Output only the absolute final state or code to be merged back into main.\n\nTimeline:\n${historyText}`;
        let mergeSummary = "";
        try {
            const completion = await groq.chat.completions.create({ messages: [{ role: "user", content: mergePrompt }], model: "llama-3.1-8b-instant" });
            mergeSummary = completion.choices[0]?.message?.content || "Branch merged successfully.";
        } catch (e) {
            mergeSummary = "Branch merged successfully.";
        }

        const { data: systemMsg, error: mrgErr } = await supabase.from('messages').insert([{ 
            branch_id: target_branch_id, sender_type: 'system', content: `🚀 SQUASH & MERGE COMPLETE\n\n${mergeSummary}`, parent_message_id: actualTargetParentId 
        }]).select().single();
        if (mrgErr) throw mrgErr;
        
        res.json({ success: true, mergeSummary: systemMsg.content, injectedMessageId: systemMsg.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
    try {
        const { branch_id, prompt, parent_message_id, frontendHistory, attachments } = req.body;
        let finalPromptText = prompt;
        let geminiParts = [];

        // 🔥 MULTIMODAL ENGINE: Process incoming attachments
        if (attachments && attachments.length > 0) {
            for (const file of attachments) {
                const base64Data = file.base64.split(',')[1]; // Strip the data URL prefix
                const buffer = Buffer.from(base64Data, 'base64');

                if (file.type === 'application/pdf') {
                    // Crack open the PDF and extract text
                    const pdfData = await pdfParse(buffer);
                    finalPromptText += `\n\n[Content of PDF: ${file.name}]\n${pdfData.text}`;
                } 
                else if (file.type.startsWith('image/')) {
                    // Send images natively to Gemini's visual cortex
                    geminiParts.push({
                        inlineData: { data: base64Data, mimeType: file.type }
                    });
                } 
                else {
                    // Standard text/code files
                    const textContent = buffer.toString('utf-8');
                    finalPromptText += `\n\n[Attached File: ${file.name}]\n\`\`\`\n${textContent}\n\`\`\``;
                }
            }
        }

        // Add the compiled text to the parts array
        geminiParts.unshift({ text: finalPromptText });

        const { data: userMessage } = await supabase.from('messages').insert([{ 
            branch_id, sender_type: 'user', content: finalPromptText, parent_message_id: parent_message_id || null 
        }]).select().single();

        let rawHistory = [];
        if (frontendHistory && Array.isArray(frontendHistory)) {
            rawHistory = frontendHistory.filter(m => m.role !== 'system' && m.id !== 'temp').map(m => ({ role: m.role === 'ai' ? 'model' : 'user', content: m.content }));
        }
        let history = [];
        for (let msg of rawHistory) {
            if (history.length === 0) {
                history.push({ role: msg.role, parts: [{ text: msg.content }] });
            } else {
                let lastMsg = history[history.length - 1];
                if (lastMsg.role === msg.role) lastMsg.parts[0].text += `\n\n${msg.content}`;
                else history.push({ role: msg.role, parts: [{ text: msg.content }] });
            }
        }

        if (history.length > 0 && history[0].role === 'model') history.unshift({ role: 'user', parts: [{ text: 'Here is the context:' }] });
        if (history.length > 0 && history[history.length - 1].role === 'user') history.push({ role: 'model', parts: [{ text: 'Understood. Waiting for your next instruction.' }] });
        let aiResponse = "";
        try {
            const chat = model.startChat({ history: history });
            // Send the multimodal parts (Text + Images) to Gemini
            const result = await chat.sendMessage(geminiParts);
            aiResponse = result.response.text();
        } catch (geminiError) {
            console.error("Gemini Error:", geminiError);
            aiResponse = "I encountered an error processing your attachments or request. Make sure your files aren't too massive!";
        }

        const { data: aiMessage } = await supabase.from('messages').insert([{ 
            branch_id, sender_type: 'ai', content: aiResponse, parent_message_id: userMessage.id 
        }]).select().single();
        res.json({ success: true, userMessageId: userMessage.id, aiMessageId: aiMessage.id, aiResponse: aiMessage.content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/chitchat', async (req, res) => {
    try {
        const { workspace_id, user_name, prompt, history } = req.body;
        
        // 1. Immediately log the human's message
        const { error: chatErr } = await supabase.from('chitchat_messages').insert([{ workspace_id, sender_name: user_name, role: 'user', content: prompt }]);
        if (chatErr) throw chatErr;

        // 2. If Gemini is tagged, safely process it without the strict history crash
        if (prompt.includes('@gemini')) {
            const cleanPrompt = prompt.replace('@gemini', '').trim();
            let aiRes = "";
            
            try {
                // Convert messy multiplayer history into a flat context string so Gemini doesn't crash
                const contextStr = history ? history.map(h => `${h.role === 'model' ? 'Gemini' : 'User'}: ${h.parts[0].text}`).join('\n') : "";
                const fullPrompt = `Here is the recent chat room context:\n${contextStr}\n\nA user just asked you: "${cleanPrompt}"\n\nProvide a helpful, concise response.`;
                
                const result = await model.generateContent(fullPrompt);
                aiRes = result.response.text();
            } catch (geminiError) {
                console.error("Gemini Chitchat Error, falling back to Groq:", geminiError.message);
                const completion = await groq.chat.completions.create({ messages: [{ role: "user", content: cleanPrompt }], model: "llama-3.1-8b-instant" });
                aiRes = completion.choices[0]?.message?.content || "I'm having trouble thinking right now!";
            }
            
            await supabase.from('chitchat_messages').insert([{ workspace_id, sender_name: 'Gemini', role: 'ai', content: aiRes }]);
            res.json({ success: true, response: aiRes });
        } else {
            res.json({ success: true });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/chitchat/:workspace_id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('chitchat_messages').select('*').eq('workspace_id', req.params.workspace_id).order('created_at', { ascending: true });
        if (error) throw error;
        res.json({ success: true, messages: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/branches/:workspace_id', async (req, res) => {
    try {
        const { data: branches, error } = await supabase.from('branches').select('*').eq('workspace_id', req.params.workspace_id).order('created_at', { ascending: true });
        if (error) throw error;
        res.json({ success: true, branches });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/messages/:branch_id', async (req, res) => {
    try {
        const { data: latestMsg } = await supabase.from('messages').select('id').eq('branch_id', req.params.branch_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
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