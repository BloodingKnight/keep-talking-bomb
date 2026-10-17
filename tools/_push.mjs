// 一次性：把当前工作区（git 已跟踪的文件）推成 main 上的新 commit。
// 沙箱里 github.com:443 不通，只能走 api.github.com 的 Git Data API。
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.BOMB_GH_TOKEN;
const OWNER = 'BloodingKnight';
const REPO = 'keep-talking-bomb';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = 'main';
const WHO = { name: 'BloodingKnight', email: '4345077+BloodingKnight@users.noreply.github.com' };

const H = {
  authorization: `Bearer ${TOKEN}`,
  'user-agent': 'bomb-push',
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'x-github-api-version': '2022-11-28',
};

const files = fs
  .readFileSync('tools/_files.txt', 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);
console.log('files:', files.length);

const ref = await (await fetch(`${API}/git/ref/heads/${BRANCH}`, { headers: H })).json();
const parent = ref.object.sha;

const tree = [];
for (const rel of files) {
  const res = await fetch(`${API}/git/blobs`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ content: fs.readFileSync(rel).toString('base64'), encoding: 'base64' }),
  });
  const blob = await res.json();
  if (!res.ok) {
    console.error('blob fail', rel, res.status, JSON.stringify(blob).slice(0, 200));
    process.exit(1);
  }
  tree.push({ path: rel.split(path.sep).join('/'), mode: '100644', type: 'blob', sha: blob.sha });
}

const treeRes = await fetch(`${API}/git/trees`, { method: 'POST', headers: H, body: JSON.stringify({ tree }) });
const newTree = await treeRes.json();
if (!treeRes.ok) {
  console.error('tree failed:', treeRes.status, JSON.stringify(newTree).slice(0, 600));
  process.exit(1);
}
const message =
  process.env.BOMB_COMMIT_MESSAGE ||
  'feat: 邀请二维码 + 无控制台单文件 exe + Tauri 桌面壳（CI 构建）';

const commitRes = await fetch(`${API}/git/commits`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ message, tree: newTree.sha, parents: [parent], author: WHO, committer: WHO }),
});
const commit = await commitRes.json();
if (!commitRes.ok) {
  console.error('commit failed:', commitRes.status, JSON.stringify(commit).slice(0, 600));
  process.exit(1);
}
const patched = await fetch(`${API}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  headers: H,
  body: JSON.stringify({ sha: commit.sha, force: true }),
});
console.log('pushed:', commit.sha.slice(0, 7), '| ref:', patched.status, '| parent:', parent.slice(0, 7));

const t = await (await fetch(`${API}/git/trees/${BRANCH}?recursive=1`, { headers: H })).json();
const remote = t.tree.filter((x) => x.type === 'blob').map((x) => x.path);
console.log('remote blobs:', remote.length);
console.log('has workflow:', remote.includes('.github/workflows/tauri-windows.yml'));
console.log('has tauri main.rs:', remote.includes('src-tauri/src/main.rs'));
const stray = remote.filter((p) => /^dist\/|^\.build\/|bundle-assets|^src-tauri\/target|manual-text/.test(p));
console.log('stray:', stray.length ? stray.slice(0, 5).join(', ') : 'none');
