const token = prompt('Pega tu APP_TOKEN para administrar el bot');
const apiHeaders = token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };

const socket = io();
let sessions = [];
let currentSession = null;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...apiHeaders
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Error en API');
  return data;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderSessions() {
  const list = $('sessionList');
  if (!sessions.length) {
    list.innerHTML = '<div class="muted">No hay sesiones todavía.</div>';
    return;
  }

  list.innerHTML = sessions.map((s) => `
    <div class="session-item ${currentSession === s.sessionId ? 'active' : ''}" data-id="${s.sessionId}">
      <strong>${escapeHtml(s.label || s.sessionId)}</strong><br>
      <small>${escapeHtml(s.number || s.sessionId)}</small><br>
      <span class="badge ${s.connected ? 'online' : 'offline'}">${s.connected ? 'Conectado' : s.status || 'Desconectado'}</span>
    </div>
  `).join('');

  document.querySelectorAll('.session-item').forEach((item) => {
    item.addEventListener('click', () => selectSession(item.dataset.id));
  });
}

function updateTopBar(session) {
  $('currentTitle').textContent = session ? (session.label || session.sessionId) : 'Selecciona una sesión';
  $('statusText').textContent = session ? `${session.connected ? 'Conectado' : 'Estado'}: ${session.status || 'desconocido'}${session.number ? ` · ${session.number}` : ''}` : 'Sin sesión activa';
  $('btnSave').disabled = !session;
  $('btnSend').disabled = !session;
  $('btnRestart').disabled = !session;
  $('btnLogout').disabled = !session;
  $('btnLoadHistory').disabled = !session;
}

async function loadSessions() {
  sessions = await api('/api/agents');
  renderSessions();
  if (currentSession) {
    const session = sessions.find((s) => s.sessionId === currentSession);
    if (session) fillAgentForm(session);
  }
}

function fillAgentForm(session) {
  currentSession = session.sessionId;
  $('agentLabel').value = session.label || '';
  $('promptEditor').value = session.prompt || '';
  $('activeToggle').checked = session.active !== false;
  updateTopBar(session);
  renderSessions();
  loadHistory();
}

function selectSession(sessionId) {
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (session) fillAgentForm(session);
}

async function loadHistory() {
  if (!currentSession) return;
  const history = await api(`/api/agents/${encodeURIComponent(currentSession)}/history?limit=60`);
  const log = $('messageLog');
  if (!history.length) {
    log.className = 'message-log empty';
    log.textContent = 'No hay mensajes en esta sesión.';
    return;
  }
  log.className = 'message-log';
  log.innerHTML = history.map((m) => `
    <div class="bubble ${m.direction === 'in' ? 'in' : 'out'}">
      <span class="meta">${escapeHtml(m.name || m.from || m.to || '')} · ${new Date(m.at).toLocaleString()}</span>
      ${escapeHtml(m.text || '')}
    </div>
  `).join('');
  log.scrollTop = log.scrollHeight;
}

function showQr(dataUrl) {
  $('qrImg').src = dataUrl;
  $('qrBox').classList.remove('hidden');
}

function hideQr() {
  $('qrBox').classList.add('hidden');
  $('qrImg').removeAttribute('src');
}

$('btnCreate').addEventListener('click', async () => {
  const sessionId = $('newSessionId').value.trim();
  const label = $('newSessionLabel').value.trim();
  if (!sessionId) return alert('Escribe un ID de sesión');
  try {
    await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId, label })
    });
    await loadSessions();
    alert('Sesión creada. Espera el QR.');
  } catch (error) {
    alert(error.message);
  }
});

$('btnSave').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    await api(`/api/agents/${encodeURIComponent(currentSession)}`, {
      method: 'POST',
      body: JSON.stringify({
        label: $('agentLabel').value,
        prompt: $('promptEditor').value,
        active: $('activeToggle').checked
      })
    });
    await loadSessions();
    alert('Cambios guardados');
  } catch (error) {
    alert(error.message);
  }
});

$('btnSend').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    await api('/api/send-message', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: currentSession,
        number: $('manualNumber').value,
        message: $('manualMessage').value
      })
    });
    $('manualMessage').value = '';
    await loadHistory();
    alert('Mensaje enviado');
  } catch (error) {
    alert(error.message);
  }
});

$('btnRestart').addEventListener('click', async () => {
  if (!currentSession) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(currentSession)}/restart`, { method: 'POST' });
    await loadSessions();
    alert('Sesión reiniciada');
  } catch (error) {
    alert(error.message);
  }
});

$('btnLogout').addEventListener('click', async () => {
  if (!currentSession) return;
  if (!confirm('Esto desvincula la sesión y obliga a escanear QR de nuevo. ¿Continuar?')) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(currentSession)}/logout`, { method: 'POST' });
    await loadSessions();
    hideQr();
    alert('Sesión cerrada');
  } catch (error) {
    alert(error.message);
  }
});

$('btnReload').addEventListener('click', loadSessions);
$('btnLoadHistory').addEventListener('click', loadHistory);

socket.on('qr', (data) => {
  if (data.sessionId === $('newSessionId').value.trim() || data.sessionId === currentSession) {
    showQr(data.qrDataUrl);
  }
  loadSessions().catch(() => {});
});

socket.on('session_ready', async ({ sessionId }) => {
  hideQr();
  await loadSessions();
  if (!currentSession) selectSession(sessionId);
});

socket.on('session_disconnected', loadSessions);
socket.on('session_error', loadSessions);
socket.on('new_message', ({ sessionId }) => {
  if (sessionId === currentSession) loadHistory().catch(() => {});
});
socket.on('bot_reply', ({ sessionId }) => {
  if (sessionId === currentSession) loadHistory().catch(() => {});
});
socket.on('manual_message_sent', ({ sessionId }) => {
  if (sessionId === currentSession) loadHistory().catch(() => {});
});

loadSessions().catch((error) => {
  alert(`No se pudo cargar el panel: ${error.message}`);
});
