import express from 'express';
import fs from 'fs';
import path from 'path';

const PORT = Number(process.env.PORT || 18888);
const ORCH_API_TOKEN = process.env.ORCH_API_TOKEN || '';
const DATA_FILE = process.env.DATA_FILE || './data/queue.json';
const TG_NOTIFY_ENABLED = String(process.env.TG_NOTIFY_ENABLED || 'false').toLowerCase() === 'true';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const TG_DEDUPE_TTL_MS = Number(process.env.TG_DEDUPE_TTL_MS || 15000);

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

const dedupeMap = new Map();
function isDuplicate(eventKey, ttlMs) {
  const now = Date.now();
  const prev = dedupeMap.get(eventKey);
  dedupeMap.set(eventKey, now);
  if (!prev) return false;
  return (now - prev) < ttlMs;
}

async function notifyTelegram(ev) {
  if (!TG_NOTIFY_ENABLED || !TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const key = `${ev.taskId}:${ev.status}:${ev.phase || 'other'}:${ev.message || ''}`;
  if (isDuplicate(key, TG_DEDUPE_TTL_MS)) return;

  const statusIcon = {
    claimed: '🟡',
    started: '🔎',
    progress: '⚙️',
    completed: '✅',
    failed: '❌',
    timeout: '⏱️',
    rejected: '🚫'
  };
  const phaseIcon = {
    pull: '📥',
    plan: '🗺️',
    validate: '🧪',
    git: '🌿',
    claude: '🤖',
    report: '🧾',
    push: '🚀',
    pr: '🔗'
  };

  const icon = (['completed', 'failed', 'timeout', 'rejected'].includes(ev.status)
    ? statusIcon[ev.status]
    : phaseIcon[ev.phase] || statusIcon[ev.status]) || 'ℹ️';

  const statusRu = {
    claimed: 'задача принята',
    started: 'задача стартовала',
    progress: 'выполнение',
    completed: 'задача выполнена',
    failed: 'ошибка выполнения',
    timeout: 'таймаут выполнения',
    rejected: 'задача отклонена'
  }[ev.status] || ev.status;

  const phaseRu = {
    pull: 'получение задачи',
    plan: 'план выполнения',
    validate: 'валидация',
    git: 'git-операции',
    claude: 'работа Claude',
    push: 'публикация',
    pr: 'создание PR',
    report: 'отчёт'
  }[ev.phase] || (ev.phase || 'этап');

  const meta = [];
  if (ev.meta?.durationMs != null) meta.push(`время: ${Math.round(Number(ev.meta.durationMs)/100)/10}с`);
  if (ev.meta?.exitCode != null) meta.push(`код выхода: ${ev.meta.exitCode}`);

  const text = [
    `${icon} ${ev.taskId}`,
    `${statusRu} (${phaseRu})`,
    ev.message || '',
    meta.join(' · ')
  ].filter(Boolean).join('\n');

  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TG_CHAT_ID,
    text,
    disable_web_page_preview: true
  };

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('[orch-api] telegram notify failed', r.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn('[orch-api] telegram notify error', e?.message || String(e));
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const ok = h.startsWith('Bearer ') && h.slice(7) === ORCH_API_TOKEN;
  if (!ok) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'orch-api', version: '0.3.0' });
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
    result: null,
    events: [],
    question: null,
    options: null,
    pendingAnswer: null,
    needsInputAt: null
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

  const answer = task.pendingAnswer || null;
  task.pendingAnswer = null;
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
      contextSnippets: task.contextSnippets || [],
      pendingAnswer: answer,
      question: task.question || null,
      options: task.options || null
    }
  });
});

app.post('/api/worker/event', auth, (req, res) => {
  const { workerId, taskId, status, phase, message, meta, ts } = req.body || {};
  if (!workerId || !taskId || !status) {
    return res.status(400).json({ ok: false, error: 'workerId, taskId, status required' });
  }

  const allowed = new Set(['claimed', 'started', 'progress', 'keepalive', 'completed', 'failed', 'timeout', 'rejected']);
  if (!allowed.has(status)) return res.status(400).json({ ok: false, error: 'invalid status' });

  const db = loadStore();
  const task = db.tasks.find(x => x.taskId === taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });

  const msg = String(message || '').slice(0, 1000);
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push({
    workerId,
    status,
    phase: phase || 'other',
    message: msg,
    meta: meta || {},
    ts: ts || new Date().toISOString(),
    receivedAt: new Date().toISOString()
  });
  saveStore(db);

  if (status !== 'keepalive') {
    notifyTelegram({
      taskId,
      workerId,
      status,
      phase: phase || 'other',
      message: msg,
      meta: meta || {},
      ts: ts || new Date().toISOString()
    });
  }

  res.json({ ok: true });
});

app.post('/api/task/resume', auth, (req, res) => {
  const { taskId, answer, answeredBy } = req.body || {};
  if (!taskId || !answer) {
    return res.status(400).json({ ok: false, error: 'taskId and answer required' });
  }

  const db = loadStore();
  const task = db.tasks.find(x => x.taskId === taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });
  if (task.status !== 'needs_input') {
    return res.status(409).json({ ok: false, error: `task status must be needs_input, got ${task.status}` });
  }

  task.pendingAnswer = String(answer);
  task.status = 'queued';
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push({
    workerId: answeredBy || 'operator',
    status: 'resumed',
    phase: 'report',
    message: 'resume answer received',
    meta: {},
    ts: new Date().toISOString(),
    receivedAt: new Date().toISOString()
  });
  saveStore(db);

  res.json({ ok: true, taskId, status: 'queued' });
});

app.post('/api/worker/result', auth, (req, res) => {
  const { workerId, taskId, status, output, meta, question, options, context } = req.body || {};
  if (!workerId || !taskId || !status) {
    return res.status(400).json({ ok: false, error: 'workerId, taskId, status required' });
  }

  const allowed = new Set(['completed', 'failed', 'timeout', 'rejected', 'needs_input']);
  if (!allowed.has(status)) return res.status(400).json({ ok: false, error: 'invalid status' });

  const db = loadStore();
  const task = db.tasks.find(x => x.taskId === taskId);
  if (!task) return res.status(404).json({ ok: false, error: 'task not found' });

  let finalStatus = status;
  if (status === 'needs_input') {
    const q = typeof question === 'string' ? question.trim() : '';
    const opts = Array.isArray(options) ? options.filter(Boolean) : [];
    const hasStructuredQuestion = q.length >= 8;
    const hasStructuredOptions = opts.length > 0;

    // Guardrail: some workers may accidentally mark successful runs as needs_input
    // by scraping random text fragments. Keep needs_input only when there is a
    // meaningful question payload.
    if (!hasStructuredQuestion && !hasStructuredOptions) {
      finalStatus = Number(meta?.exitCode) === 0 ? 'completed' : 'failed';
    }

    if (finalStatus === 'needs_input') {
      task.needsInputAt = new Date().toISOString();
      task.question = q || null;
      task.options = hasStructuredOptions ? opts : null;
      task.result = { workerId, status: finalStatus, output: output || {}, meta: meta || {}, context: context || null };
    }
  }

  if (finalStatus !== 'needs_input') {
    task.finishedAt = new Date().toISOString();
    task.question = null;
    task.options = null;
    task.needsInputAt = null;
    task.result = { workerId, status: finalStatus, output: output || {}, meta: meta || {} };
  }

  task.status = finalStatus;
  saveStore(db);

  res.json({ ok: true, taskId, status: finalStatus });
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
