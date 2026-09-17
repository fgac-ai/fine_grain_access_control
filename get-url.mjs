import { execSync } from 'child_process';
const token = execSync('gh auth token').toString().trim();
const prNumber = '14';
const response = await fetch(`https://api.github.com/repos/fgac-ai/fine_grain_access_control/pulls/${prNumber}`, {
headers: { Authorization: `Bearer ${token}` }
});
const pr = await response.json();
const commentsRes = await fetch(`https://api.github.com/repos/fgac-ai/fine_grain_access_control/issues/${prNumber}/comments`, {
headers: { Authorization: `Bearer ${token}` }
});
const comments = await commentsRes.json();
console.log(JSON.stringify(comments.map(c => c.body).join('\n')));
