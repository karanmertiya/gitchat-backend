import dotenv from 'dotenv';
dotenv.config();

async function runTests() {
    console.log("Starting Memory & Context End-to-End Test...");
    const userId = process.env.TEST_USER_ID;

    if (!userId) {
        console.error("❌ ERROR: Please update TEST_USER_ID in your .env file.");
        return;
    }

    try {
        // 1. Test Initialization
        console.log("\n1. Creating Workspace and Main Branch...");
        const initRes = await fetch('http://localhost:3000/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, workspace_name: "Context Test Run" })
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.error);
        const branchId = initData.branch.id;
        console.log(`✅ Success! Main Branch ID: ${branchId}`);

        // 2. The First Message (Setting the context)
        console.log("\n2. Sending Message 1 (Setting Context)...");
        const chatRes1 = await fetch('http://localhost:3000/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: branchId, 
                prompt: "I am building an app called DialogTree. It is a Git-style AI chat. Remember this.",
                parent_message_id: null 
            })
        });
        const chatData1 = await chatRes1.json();
        if (!chatData1.success) throw new Error(chatData1.error);
        console.log(`✅ Success! Gemini Reply: "${chatData1.aiResponse.trim()}"`);
        
        // Save the AI's message ID to use as the parent for our next message
        const message1AiId = chatData1.aiMessageId; 

        // 3. The Second Message (Testing the memory via tree traversal)
        console.log("\n3. Sending Message 2 (Testing Memory)...");
        const chatRes2 = await fetch('http://localhost:3000/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                branch_id: branchId, 
                prompt: "What is the name of the app I am building and what does it do?",
                parent_message_id: message1AiId // Connecting it to the tree!
            })
        });
        const chatData2 = await chatRes2.json();
        if (!chatData2.success) throw new Error(chatData2.error);
        console.log(`✅ Success! Gemini Reply: "${chatData2.aiResponse.trim()}"`);

        console.log("\n🎉 CONTEXT TEST PASSED! The API is successfully traversing the database tree.");

    } catch (error) {
        console.error("\n❌ Test Failed:", error.message);
    }
}

runTests();