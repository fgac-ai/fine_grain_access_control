import { execSync } from 'child_process';
const token = execSync('gh auth token').toString().trim();
const response = await fetch(`https://api.github.com/repos/fgac-ai/fine_grain_access_control/commits/main/status`, {
headers: { Authorization: `Bearer ${token}` }
});
const status = await response.json();
console.log(status.state);
if (status.statuses && status.statuses.length > 0) {
  const vercelStatus = status.statuses.find(s => s.context.includes('vercel'));
  if (vercelStatus) console.log(vercelStatus.description, vercelStatus.target_url);
}
