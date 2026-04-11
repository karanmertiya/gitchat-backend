import dotenv from 'dotenv';
dotenv.config();

async function runBranchTest() {
    console.log("Starting Multiverse Branch Test...");
    const userId = process.env.TEST_USER_ID;
    const API_URL = 'http://localhost:3000'; // Testing locally first!

    try {
        // 1. Initialize
        const initRes = await fetch(`${API_URL}/init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, workspace_name: "Branching Sandbox" })
        });
        const initData = await initRes.json();
        const workspaceId = initData.workspace.id;
        const mainBranchId = initData.branch.id;
        
        // 2. Establish Base Reality (Main Branch)
        console.log("\n--- MAIN BRANCH ---");
        const msg1 = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: mainBranchId, 
                prompt: "My two favorite animals are Dogs and Cats. Remember this.",
                parent_message_id: null 
            })
        }).then(res => res.json());
        console.log(`AI: ${msg1.aiResponse.trim()}`);
        const baseContextMsgId = msg1.aiMessageId; // We will branch off this!

        // 3. Create a Tangent Branch
        console.log("\n--- CREATING TANGENT BRANCH ---");
        const branchRes = await fetch(`${API_URL}/branch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                workspace_id: workspaceId, 
                name: "Bird Tangent",
                is_ephemeral: true 
            })
        });
        const branchData = await branchRes.json();
        const tangentBranchId = branchData.branch.id;
        console.log(`Created Branch: ${branchData.branch.name}`);

        // 4. Alter Reality in the Tangent
        console.log("\n--- INSIDE TANGENT BRANCH ---");
        const msg2 = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: tangentBranchId, 
                prompt: "Actually, replace Cats with Birds.",
                parent_message_id: baseContextMsgId // Pointing to the Main branch's history!
            })
        }).then(res => res.json());
        console.log(`AI: ${msg2.aiResponse.trim()}`);

        // 5. Query the Main Branch (Testing Context Isolation)
        console.log("\n--- BACK TO MAIN BRANCH ---");
        const msg3 = await fetch(`${API_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: mainBranchId, 
                prompt: "What are my two favorite animals?",
                parent_message_id: baseContextMsgId // Pointing to the same root, ignoring the tangent!
            })
        }).then(res => res.json());
        console.log(`AI: ${msg3.aiResponse.trim()}`);

    } catch (error) {
        console.error("Test Failed:", error);
    }
}

runBranchTest();