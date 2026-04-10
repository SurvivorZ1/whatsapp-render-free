require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const cors = require('cors');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const APP_TOKEN = process.env.APP_TOKEN || 'change-this-token';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const MONGODB_URI = process.env.MONGODB_URI || '';
const BOT_DEFAULT_PROMPT = process.env.BOT_DEFAULT_PROMPT || 'Eres un asistente profesional de WhatsApp. Responde en español claro, breve y útil. Si te faltan datos, dilo con honestidad y ofrece seguimiento humano.';
const REPLY_COOLDOWN_MS = Number(process.env.REPLY_COOLDOWN_MS || 6000);
const IGNORE_GROUPS = String(process.env.IGNORE_GROUPS || 'true') === 'true';
const IGNORE_STATUS = String(process.env.IGNORE_STATUS || 'true') === 'true';
const HEADLESS = String(process.env.HEADLESS || 'true') !== 'false';
const REMOTE_BACKUP_INTERVAL_MS = Math.max(Number(process.env.REMOTE_BACKUP_INTERVAL_MS || 300000), 60000);
const TEMP_AUTH_DIR = path.resolve(process.env.TEMP_AUTH_DIR || './tmp-auth');
const HISTORY_LIMIT = Math.max(Number(process.env.HISTORY_LIMIT || 250), 50);

const clients = new Map();
const lastReplies = new Map();
let mongoStore = null;

const agentSchema = new mongoose.Schema({
  sessionId: { type: String, unique: true, index: true, required: true },
  label: { type: String, default: '' },
  prompt: { type: String, default: BOT_DEFAULT_PROMPT },
  active: { type: Boolean, default: true },
  number: { type: String, default: null },
  connected: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  sessionId: { type: String, index: true, required: true },
  at: { type: Date, default: Date.now, index: true },
  direction: { type: String, enum: ['in', 'out'], required: true },
  from: String,
  to: String,
  name: String,
  text: String
});

const Agent = mongoose.model('Agent', agentSchema);
const MessageLog = mongoose.model('MessageLog', messageSchema);

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function nowIso() {
  return new Date().toISOString();
}

function sanitizeSessionId(input) {
  return String(input || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function authMiddleware(req, res, next) {
  if (
    req.path === '/health' ||
    req.path === '/' ||
    req.path === '/index.html' ||
    req.path === '/app' ||
    req.path.startsWith('/socket.io') ||
    req.path.startsWith('/styles.css') ||
    req.path.startsWith('/app.js')
  ) {
    return next();
  }

  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const headerToken = req.headers['x-api-key'];
  const token = bearer || headerToken;

  if (!APP_TOKEN || token === APP_TOKEN) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

app.use(authMiddleware);

function getRuntimeState(sessionId) {
  return clients.get(sessionId) || null;
}

async function getOrCreateAgent(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId) throw new Error('sessionId inválido');

  let doc = await Agent.findOne({ sessionId: safeId });
  if (!doc) {
    doc = await Agent.create({
      sessionId: safeId,
      label: safeId,
      prompt: BOT_DEFAULT_PROMPT,
      active: true,
      connected: false
    });
  }
  return doc;
}

async function updateAgent(sessionId, patch) {
  const safeId = sanitizeSessionId(sessionId);
  const defaults = {
    label: safeId,
    prompt: BOT_DEFAULT_PROMPT,
    active: true
  };
  const set = {
    sessionId: safeId,
    updatedAt: new Date(),
    ...defaults,
    ...patch
  };
  delete set._id;
  return Agent.findOneAndUpdate(
    { sessionId: safeId },
    { $set: set, $setOnInsert: { createdAt: new Date() } },
    { new: true, upsert: true }
  );
}

async function appendMessage(sessionId, item) {
  const safeId = sanitizeSessionId(sessionId);
  await MessageLog.create({ sessionId: safeId, ...item, at: item.at ? new Date(item.at) : new Date() });

  const count = await MessageLog.countDocuments({ sessionId: safeId });
  if (count > HISTORY_LIMIT) {
    const extra = count - HISTORY_LIMIT;
    const oldDocs = await MessageLog.find({ sessionId: safeId }).sort({ at: 1, _id: 1 }).limit(extra).select('_id');
    if (oldDocs.length) {
      await MessageLog.deleteMany({ _id: { $in: oldDocs.map((d) => d._id) } });
    }
  }
}

async function getRecentMessages(sessionId, limit = 10) {
  const safeId = sanitizeSessionId(sessionId);
  const docs = await MessageLog.find({ sessionId: safeId }).sort({ at: -1 }).limit(limit).lean();
  return docs.reverse();
}

async function getHistory(sessionId, limit = 60) {
  const safeId = sanitizeSessionId(sessionId);
  const docs = await MessageLog.find({ sessionId: safeId }).sort({ at: -1 }).limit(Math.min(limit, HISTORY_LIMIT)).lean();
  return docs.reverse().map((doc) => ({
    ...doc,
    at: new Date(doc.at).toISOString()
  }));
}

async function createClientSummary(sessionId) {
  const agent = await getOrCreateAgent(sessionId);
  const state = getRuntimeState(sessionId);
  return {
    sessionId: agent.sessionId,
    label: agent.label || agent.sessionId,
    number: agent.number || null,
    prompt: agent.prompt || BOT_DEFAULT_PROMPT,
    active: agent.active !== false,
    connected: Boolean(state?.ready),
    hasQr: Boolean(state?.qrDataUrl),
    status: state?.status || (agent.connected ? 'ready' : 'idle'),
    lastError: state?.lastError || null,
    updatedAt: agent.updatedAt ? new Date(agent.updatedAt).toISOString() : null,
    qrDataUrl: state?.qrDataUrl || null
  };
}

function buildPuppeteerOptions() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote'
  ];

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  return {
    headless: HEADLESS,
    args,
    executablePath
  };
}

async function askOpenAI({ systemPrompt, userMessage, contactName, sessionId }) {
  if (!OPENAI_API_KEY) {
    throw new Error('Falta OPENAI_API_KEY');
  }

  const recent = await getRecentMessages(sessionId, 10);
  const history = recent
    .map((m) => `${m.direction === 'in' ? 'Cliente' : 'Bot'}: ${m.text}`)
    .join('\n');

  const input = [
    `Nombre del contacto: ${contactName || 'No disponible'}`,
    history ? `Historial reciente:\n${history}` : '',
    `Mensaje actual del cliente: ${userMessage}`,
    'Responde listo para enviar por WhatsApp. No uses markdown ni listas innecesarias. Si falta contexto, dilo con honestidad.'
  ].filter(Boolean).join('\n\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input,
      store: false
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || 'Error consultando OpenAI');
  }

  const text = String(data.output_text || '').trim();
  if (text) return text;

  const fallback = (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (!fallback) throw new Error('No se pudo leer la respuesta del modelo');
  return fallback;
}

async function handleIncomingMessage(sessionId, message) {
  const agent = await getOrCreateAgent(sessionId);

  if (message.fromMe) return;
  if (IGNORE_STATUS && message.from === 'status@broadcast') return;
  if (IGNORE_GROUPS && message.from.endsWith('@g.us')) return;

  const body = String(message.body || '').trim();
  const chat = await message.getChat();
  const contact = await message.getContact();
  const contactName = contact.pushname || contact.name || contact.number || message.from;

  if (!body) {
    await appendMessage(sessionId, {
      direction: 'in',
      from: message.from,
      name: contactName,
      text: `[${message.type || 'mensaje sin texto'}]`
    });
    return;
  }

  await appendMessage(sessionId, {
    direction: 'in',
    from: message.from,
    name: contactName,
    text: body
  });

  io.emit('new_message', {
    sessionId,
    from: message.from,
    name: contactName,
    body,
    at: nowIso()
  });

  if (agent.active === false) return;

  const replyKey = `${sessionId}:${message.from}`;
  const lastReplyAt = lastReplies.get(replyKey) || 0;
  if (Date.now() - lastReplyAt < REPLY_COOLDOWN_MS) return;
  lastReplies.set(replyKey, Date.now());

  try {
    await chat.sendStateTyping();
  } catch {}

  try {
    const reply = await askOpenAI({
      systemPrompt: agent.prompt || BOT_DEFAULT_PROMPT,
      userMessage: body,
      contactName,
      sessionId
    });

    await message.reply(reply);
    await appendMessage(sessionId, {
      direction: 'out',
      to: message.from,
      name: contactName,
      text: reply
    });

    io.emit('bot_reply', {
      sessionId,
      to: message.from,
      name: contactName,
      reply,
      at: nowIso()
    });
  } catch (error) {
    const fallback = 'Tuvimos un problema técnico momentáneo. En breve un asesor puede darte seguimiento.';
    await appendMessage(sessionId, {
      direction: 'out',
      to: message.from,
      name: contactName,
      text: `[ERROR GPT] ${error.message}`
    });

    try {
      await message.reply(fallback);
    } catch {}

    const state = getRuntimeState(sessionId);
    if (state) {
      state.lastError = error.message;
      state.status = 'error';
    }

    io.emit('session_error', {
      sessionId,
      error: error.message
    });
  }
}

async function initSession(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId) throw new Error('sessionId inválido');

  const existing = clients.get(safeId);
  if (existing?.initializing || existing?.ready || existing?.client) {
    return createClientSummary(safeId);
  }

  await getOrCreateAgent(safeId);

  const state = {
    status: 'initializing',
    ready: false,
    qrDataUrl: null,
    lastError: null,
    initializing: true,
    client: null
  };
  clients.set(safeId, state);

  const client = new Client({
    authStrategy: new RemoteAuth({
      store: mongoStore,
      clientId: safeId,
      backupSyncIntervalMs: REMOTE_BACKUP_INTERVAL_MS,
      dataPath: TEMP_AUTH_DIR
    }),
    takeoverOnConflict: 0,
    puppeteer: buildPuppeteerOptions()
  });

  state.client = client;

  client.on('qr', async (qr) => {
    state.status = 'awaiting_qr';
    state.qrDataUrl = await QRCode.toDataURL(qr);
    io.emit('qr', { sessionId: safeId, qrDataUrl: state.qrDataUrl });
  });

  client.on('authenticated', () => {
    state.status = 'authenticated';
    state.lastError = null;
  });

  client.on('auth_failure', async (msg) => {
    state.status = 'auth_failure';
    state.lastError = msg || 'Fallo de autenticación';
    await updateAgent(safeId, { connected: false });
    io.emit('session_error', { sessionId: safeId, error: state.lastError });
  });

  client.on('ready', async () => {
    state.ready = true;
    state.initializing = false;
    state.status = 'ready';
    state.qrDataUrl = null;
    state.lastError = null;

    const info = client.info || {};
    await updateAgent(safeId, {
      number: info?.wid?.user || null,
      connected: true
    });

    io.emit('session_ready', {
      sessionId: safeId,
      number: info?.wid?.user || null
    });
  });

  client.on('remote_session_saved', () => {
    io.emit('session_saved', { sessionId: safeId, at: nowIso() });
  });

  client.on('disconnected', async (reason) => {
    state.ready = false;
    state.initializing = false;
    state.status = 'disconnected';
    state.lastError = String(reason || 'Sesión desconectada');
    await updateAgent(safeId, { connected: false });
    io.emit('session_disconnected', {
      sessionId: safeId,
      reason: state.lastError
    });
  });

  client.on('message', (message) => {
    handleIncomingMessage(safeId, message).catch((error) => {
      console.error(`[${safeId}] error procesando mensaje`, error);
    });
  });

  try {
    await client.initialize();
  } catch (error) {
    state.initializing = false;
    state.status = 'error';
    state.lastError = error.message;
    throw error;
  }

  return createClientSummary(safeId);
}

async function logoutSession(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  const state = clients.get(safeId);

  if (state?.client) {
    try { await state.client.logout(); } catch {}
    try { await state.client.destroy(); } catch {}
  }

  clients.delete(safeId);
  if (mongoStore) {
    try {
      await mongoStore.delete({ session: `RemoteAuth-${safeId}` });
    } catch {}
  }

  await updateAgent(safeId, { connected: false, number: null });
  return createClientSummary(safeId);
}

async function sendManualMessage(sessionId, number, text) {
  const safeId = sanitizeSessionId(sessionId);
  const state = clients.get(safeId);
  if (!state?.client || !state.ready) {
    throw new Error('La sesión no está conectada');
  }

  const normalized = String(number || '').replace(/\D/g, '');
  if (!normalized) throw new Error('Número inválido');

  const chatId = normalized.includes('@c.us') ? normalized : `${normalized}@c.us`;
  const body = String(text || '').trim();
  if (!body) throw new Error('Mensaje vacío');

  await state.client.sendMessage(chatId, body);
  await appendMessage(safeId, {
    direction: 'out',
    to: normalized,
    name: normalized,
    text: body
  });

  io.emit('manual_message_sent', {
    sessionId: safeId,
    to: normalized,
    body,
    at: nowIso()
  });
}

app.get('/health', async (req, res) => {
  res.json({
    ok: true,
    appUrl: APP_URL,
    model: OPENAI_MODEL,
    mongoConnected: mongoose.connection.readyState === 1,
    runtimeSessions: clients.size,
    timestamp: nowIso()
  });
});

app.get('/api/agents', async (req, res) => {
  try {
    const docs = await Agent.find({}).sort({ sessionId: 1 }).lean();
    const runtimeOnly = [...clients.keys()].filter((id) => !docs.find((d) => d.sessionId === id));
    const allIds = [...docs.map((d) => d.sessionId), ...runtimeOnly];
    const summaries = [];
    for (const sessionId of allIds) summaries.push(await createClientSummary(sessionId));
    res.json(summaries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:sessionId', async (req, res) => {
  try {
    const summary = await createClientSummary(req.params.sessionId);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agents/:sessionId/history', async (req, res) => {
  try {
    const history = await getHistory(req.params.sessionId, Number(req.query.limit || 60));
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.body.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });

    const patch = {};
    if (typeof req.body.label !== 'undefined') patch.label = String(req.body.label || sessionId).trim();
    if (typeof req.body.prompt !== 'undefined') patch.prompt = String(req.body.prompt || BOT_DEFAULT_PROMPT);
    if (typeof req.body.active !== 'undefined') patch.active = Boolean(req.body.active);
    await updateAgent(sessionId, patch);

    const summary = await initSession(sessionId);
    res.json({ success: true, session: summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agents/:sessionId', async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const patch = {};
    if (typeof req.body.label !== 'undefined') patch.label = String(req.body.label || sessionId).trim();
    if (typeof req.body.prompt !== 'undefined') patch.prompt = String(req.body.prompt || BOT_DEFAULT_PROMPT);
    if (typeof req.body.active !== 'undefined') patch.active = Boolean(req.body.active);

    await updateAgent(sessionId, patch);
    res.json({ success: true, agent: await createClientSummary(sessionId) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/restart', async (req, res) => {
  try {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const state = clients.get(sessionId);
    if (state?.client) {
      try { await state.client.destroy(); } catch {}
      clients.delete(sessionId);
    }
    const summary = await initSession(sessionId);
    res.json({ success: true, session: summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/:sessionId/logout', async (req, res) => {
  try {
    const summary = await logoutSession(req.params.sessionId);
    res.json({ success: true, session: summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { sessionId, number, message } = req.body;
    if (!sessionId || !number || !message) {
      return res.status(400).json({ error: 'sessionId, number y message son requeridos' });
    }
    await sendManualMessage(sessionId, number, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function bootstrap() {
  if (!MONGODB_URI) {
    throw new Error('Falta MONGODB_URI. Para Render free necesitas MongoDB Atlas para guardar sesiones y configuración.');
  }

  await ensureDir(TEMP_AUTH_DIR);
  await mongoose.connect(MONGODB_URI);
  mongoStore = new MongoStore({ mongoose });

  const storedAgents = await Agent.find({}).select('sessionId').lean();
  for (const agent of storedAgents) {
    initSession(agent.sessionId).catch((error) => {
      console.error(`No se pudo restaurar la sesión ${agent.sessionId}:`, error.message);
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor listo en ${APP_URL}`);
  });
}

bootstrap().catch((error) => {
  console.error('Error fatal al iniciar', error);
  process.exit(1);
});
