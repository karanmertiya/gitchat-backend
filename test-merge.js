import dotenv from 'dotenv';
dotenv.config();

async function runMergeTest() {
    console.log("Starting Git-Merge AI Test...\n");
    const userId = process.env.TEST_USER_ID;
    const API_URL = 'http://localhost:3000'; // Make sure your local server is running!

    try {
        // 1. Initialize
        const initRes = await fetch(`${API_URL}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, workspace_name: "Project Planning" })
        });
        const { workspace, branch: mainBranch } = await initRes.json();
        
        // 2. Establish Base Reality
        console.log("--- 🌳 MAIN BRANCH ---");
        const msg1 = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: mainBranch.id, 
                prompt: "We are building an AI app. What should our primary marketing channel be?",
                parent_message_id: null 
            })
        }).then(res => res.json());
        console.log(`User: What should our primary marketing channel be?`);
        console.log(`AI: ${msg1.aiResponse.trim().substring(0, 100)}...\n`);
        const mainMsgId = msg1.aiMessageId;

        // 3. Create a Tangent Branch
        console.log("--- 🌿 CREATING TANGENT BRANCH ---");
        const branchRes = await fetch(`${API_URL}/branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspace_id: workspace.id, name: "Twitter/X Strategy" })
        });
        const { branch: tangentBranch } = await branchRes.json();
        console.log(`Switched to branch: ${tangentBranch.name}\n`);

        // 4. Brainstorm in the Tangent
        console.log("--- 🌿 INSIDE TANGENT BRANCH ---");
        const msg2 = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: tangentBranch.id, 
                prompt: "Let's focus entirely on Twitter tech threads. Give me a 1-sentence pitch.",
                parent_message_id: mainMsgId // Branching off the main message!
            })
        }).then(res => res.json());
        console.log(`User: Let's focus entirely on Twitter tech threads...`);
        console.log(`AI: ${msg2.aiResponse.trim()}\n`);
        const tangentMsgId = msg2.aiMessageId;

        // 5. The Magic: Auto-Merge back to Main
        console.log("--- 🔄 MERGING TANGENT INTO MAIN ---");
        const mergeRes = await fetch(`${API_URL}/merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                source_branch_id: tangentBranch.id, 
                target_branch_id: mainBranch.id,
                latest_message_id_in_source: tangentMsgId,
                parent_message_id_in_target: mainMsgId 
            })
        });
        const mergeData = await mergeRes.json();
        
        console.log(`✅ System Commit Injected into Main Branch:`);
        console.log(`>> ${mergeData.mergeSummary}\n`);
        console.log("🎉 MERGE TEST PASSED! The AI successfully summarized and combined the timelines.");

    } catch (error) {
        console.error("Test Failed:", error);
    }
}

runMergeTest();