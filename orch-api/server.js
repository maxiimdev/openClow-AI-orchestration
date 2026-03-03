import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 18888);
const ORCH_API_TOKEN = process.env.ORCH_API_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || './data/queue.json';

if (!ORCH_API_TOKEN) {
  console.error('[orch-api] ORCH_API_TOKEN is required');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function ensureStore() {
  const abs = path.resolve(DATA_FILE);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(abs)) {
    fs.writeFileSync(abs, JSON.stringify({ tasks: [] }, null, 2));
  }
  return abs;
}
const STORE = ensureStore();

function loadStore() {
  return JSON.parse(fs.readFileSync(STORE, 'utf-8'));
}
function saveStore(data) {
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const ok = h.startsWith('Bearer ') && h.slice(7) === ORCH_API_TOKEN;
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'orch-api', version: '0.1.0' });
});

app.post('/api/enqueue', auth, (req, res) => {
  const t = req.body || {};
  if (!t.taskId || !t.mode || !t.scope?.repoPath || !t.scope?.branch || !t.instructions) {
    return res.status(400).json({ ok: false, error: 'invalid payload' });
  }
  const db = loadStore();
  if (db.tasks.some(x => x.taskId === t.taskId)) {
    return res.status(409).json({ ok: false, error: 'task already exists' });
  }
  db.tasks.push({
    ...t,
    status: 'queued',
    createdAt: new Date().toISOString(),
    claimedAt: null,
    claimedBy: null,
    result: null
  });
  saveStore(db);
  res.json({ ok: true, status: 'queued', taskId: t.taskId });
});

app.post('/api/worker/pull', auth, (req, res) => {
  const workerId = req.body?.workerId;
  if (!workerId) return res.status(400).json({ ok: false, error: 'workerId required' });

  const db = loadStore();
  const task = db.tasks.find(x => x.status === 'queued');
  if (!task) return res.json({ ok: true, task: null });

  task.status = 'claimed';
  task.claimedAt = new Date().toISOString();
  task.claimedBy = workerId;
  saveStore(db);

  res.json({
    ok: true,
    task: {
      taskId: task.taskId,
      mode: task.mode,
      scope: task.scope,
      summary: task.summary,
      instructions: task.instructions,
      constraints: task.constraints || [],
      contextSnippets: task.contextSnippets || []
    }
  });
});

app.post('/api/worker/result', auth, (req, res) => {
  const { workerId, taskId, status, output, meta } = req.body || {};
  if (!workerId || !taskId || !status) {
    return res.status(400).json({ ok: false, error: 'workerId, taskId, status required' });
  }

  const allowed = new Set(['completed', 'failed', 'timeout', 'rejected']);
  if (!allowed.has(status)) return res.status(400).json({ ok: false, error: 'invalid status' });

  const db = loadStore();
  const task = db.tasks.find(x => x.taskId === taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });

  task.status = status;
  task.finishedAt = new Date().toISOString();
  task.result = { workerId, status, output: output || {}, meta: meta || {} };
  saveStore(db);

  res.json({ ok: true, taskId, status });
});

app.get('/api/task/:taskId', auth, (req, res) => {
  const db = loadStore();
  const task = db.tasks.find(x => x.taskId === req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });
  res.json({ ok: true, task });
});

app.listen(PORT, () => {
  console.log(`[orch-api] listening on :${PORT}`);
});
