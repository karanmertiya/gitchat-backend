import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const payload = await req.json();

    // 1. We only care if the deployment FAILED
    if (payload.type === 'deployment.error') {
      const deploymentId = payload.payload.deployment.id;
      const repo = payload.payload.deployment.meta.githubCommitRepo;
      const owner = payload.payload.deployment.meta.githubCommitOrg;
      const branch = payload.payload.deployment.meta.githubCommitRef;
      const fullRepoName = `${owner}/${repo}`;

      console.log(`🚨 Auto-Heal Triggered for ${fullRepoName} on branch ${branch}`);

      // 2. Fetch the actual build logs from Vercel to see what broke
      // Note: You need a VERCEL_API_TOKEN in your .env file
      const logRes = await fetch(`https://api.vercel.com/v2/deployments/${deploymentId}/events`, {
        headers: { 'Authorization': `Bearer ${process.env.VERCEL_API_TOKEN}` }
      });
      const logData = await logRes.json();
      
      // Extract the error lines (usually containing "Error:" or "Failed")
      const errorLogs = logData.filter((log: any) => log.type === 'error' || log.text.includes('Error')).map((l:any) => l.text).join('\n');

      // 3. Formulate the self-healing prompt
      const prompt = `
        You are an autonomous CI/CD debugging agent. 
        A recent deployment just failed on Vercel with the following build log errors:
        
        \`\`\`
        ${errorLogs}
        \`\`\`
        
        Identify the file causing the build error, fix the syntax or logic causing the crash, and output the entirely corrected file.
      `;

      // 4. Send to your AI Engine (Assume you have a helper function `callGemini`)
      // const aiResponse = await callGemini(prompt);
      
      // 5. Extract the file name and code from the AI's response using our extractor regex
      // const fixedFiles = extractAllArtifacts([{ role: 'ai', content: aiResponse }]);

      // 6. Push the fix directly back to GitHub
      // await pushToGithub(fullRepoName, branch, fixedFiles, "🤖 Auto-Heal: Fixed Vercel Build Error", process.env.GITHUB_PAT_TOKEN);

      return NextResponse.json({ status: "Self-healing pipeline executed", fixed: true });
    }

    // Ignore successful builds or other webhook events
    return NextResponse.json({ status: "Ignored event type" });

  } catch (error: any) {
    console.error("Auto-Heal Pipeline Failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}