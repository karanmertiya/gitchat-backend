import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { repo, token } = await req.json();
    
    if (!repo) return NextResponse.json({ error: "Repository name is required" }, { status: 400 });

    const headers: any = { 
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'DialogTree-App'
    };
    if (token) headers['Authorization'] = `token ${token}`;

    // 1. Get the default branch
    const repoRes = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!repoRes.ok) throw new Error("Failed to fetch repository. Check repo name and token.");
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch;

    // 2. Get the entire file tree recursively
    const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, { headers });
    const treeData = await treeRes.json();

    // 3. Filter for code files (ignore images, videos, node_modules, etc.)
    const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.html', '.css', '.json', '.md'];
    const filesToFetch = treeData.tree.filter((item: any) => 
      item.type === 'blob' && 
      !item.path.includes('node_modules') && 
      !item.path.includes('.next') &&
      codeExtensions.some(ext => item.path.endsWith(ext))
    ).slice(0, 50); // Limit to 50 files for safety to avoid rate-limiting

    // 4. Fetch the actual content of each file
    const files = [];
    for (const item of filesToFetch) {
        const fileRes = await fetch(item.url, { headers });
        const fileData = await fileRes.json();
        // GitHub returns file content in Base64
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        files.push({ path: item.path, content });
    }

    return NextResponse.json({ files });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}