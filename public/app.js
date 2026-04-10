let sessions = [];
let current = null;

const $ = (id) => document.getElementById(id);

function token() {
  return localStorage.getItem('APP_TOKEN') || '';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[m]));
}

async function api(path, method = 'GET', payload = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token()}`
  };

  const res = await fetch(path, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : null
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}

function setQrStatus(text, cls = 'muted') {
  $('qrStatus').className = 'statusbox ' + cls;
  $('qrStatus').textContent = text;
}

async function loadSessions() {
  sessions = await api('/api/agents');
  $('sessionList').innerHTML = sessions.length
    ? sessions.map((s) => `
      <div class="item ${current === s.sessionId ? 'active' : ''}" data-id="${s.sessionId}">
        <strong>${esc(s.label || s.sessionId)}</strong><br>
        <span class="muted">${esc(s.number || s.sessionId)}</span><br>
        <span class="muted">${esc(s.connected ? 'Conectado' : (s.status || 'Desconectado'))}</span>
      </div>
    `).join('')
    : '<div class="muted">No hay sesiones.</div>';

  document.querySelectorAll('.item').forEach((el) => {
    el.onclick = () => selectSession(el.dataset.id);
  });

  if (current) {
    const s = sessions.find((x) => x.sessionId === current);
    if (s) fill(s);
  }
}

function fill(s) {
  current = s.sessionId;
  $('title').textContent = s.label || s.sessionId;
  $('status').textContent =
    `${s.connected ? 'Conectado' : 'Estado'}: ${s.status || 'desconocido'} ${s.number ? '· ' + s.number : ''}`;

  $('agentLabel').value = s.label || '';
  $('prompt').value = s.prompt || '';
  $('active').checked = s.active !== false;

  $('saveBtn').disabled = false;
  $('sendBtn').disabled = false;
  $('restartBtn').disabled = false;
  $('logoutBtn').disabled = false;

  loadHistory();
}

function selectSession(id) {
  const s = sessions.find((x) => x.sessionId === id);
  if (s) fill(s);
}

async function loadHistory() {
  if (!current) return;
  const history = await api(`/api/agents/${encodeURIComponent(current)}/history?limit=60`);
  $('log').innerHTML = history.length
    ? history.map((m) => `
      <div class="bubble ${m.direction === 'in' ? 'in' : 'out'}">
        <small>${esc(m.name || m.from || m.to || '')} · ${new Date(m.at).toLocaleString()}</small><br>
        ${esc(m.text || '')}
      </div>
    `).join('')
    : 'Sin mensajes aún.';

  $('log').scrollTop = $('log').scrollHeight;
}

async function getSession(sessionId) {
  return api(`/api/agents/${encodeURIComponent(sessionId)}`);
}

async function pollQr(sessionId) {
  $('qrBox').style.display = 'none';
  setQrStatus('Esperando generación de QR...', 'warn');

  const maxTries = 60;

  for (let i = 0; i < maxTries; i++) {
    try {
      const s = await getSession(sessionId);

      if (s.lastError) {
        setQrStatus(`Error de sesión: ${s.lastError}`, 'err');
        return;
      }

      if (s.connected) {
        $('qrBox').style.display = 'none';
        setQrStatus('La sesión ya quedó conectada.', 'ok');
        await loadSessions();
        return;
      }

      if (s.qrDataUrl) {
        $('qrImg').src = s.qrDataUrl;
        $('qrBox').style.display = 'block';
        setQrStatus('QR generado correctamente. Escanéalo con WhatsApp Business.', 'ok');
        await loadSessions();
        return;
      }

      const extra = s.loadingPercent != null
        ? ` (${s.loadingPercent}% ${s.loadingMessage || ''})`
        : '';
      setQrStatus(`Esperando QR... Estado actual: ${s.status || 'desconocido'}${extra}`, 'warn');
    } catch (e) {
      setQrStatus(`Error consultando la sesión: ${e.message}`, 'err');
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  setQrStatus('No llegó el QR a tiempo. Reinicia la sesión o revisa logs de Render.', 'err');
}

$('saveTokenBtn').onclick = async () => {
  localStorage.setItem('APP_TOKEN', $('tokenInput').value.trim());
  alert('Token guardado');
};

$('reloadBtn').onclick = () => loadSessions();

$('createSessionBtn').onclick = async () => {
  try {
    const sessionId = $('newSessionId').value.trim();
    if (!sessionId) {
      alert('Escribe un ID de sesión');
      return;
    }

    await api('/api/sessions', 'POST', {
      sessionId,
      label: $('newSessionLabel').value
    });

    setQrStatus('Sesión creada. Voy a consultar el QR...', 'warn');
    await loadSessions();
    await pollQr(sessionId);
  } catch (e) {
    setQrStatus(`Error al crear sesión: ${e.message}`, 'err');
    alert(e.message);
  }
};

$('saveBtn').onclick = async () => {
  try {
    await api(`/api/agents/${encodeURIComponent(current)}`, 'POST', {
      sessionId: current,
      label: $('agentLabel').value,
      prompt: $('prompt').value,
      active: $('active').checked
    });
    await loadSessions();
    alert('Guardado');
  } catch (e) {
    alert(e.message);
  }
};

$('sendBtn').onclick = async () => {
  try {
    await api('/api/send-message', 'POST', {
      sessionId: current,
      number: $('number').value,
      message: $('message').value
    });
    $('message').value = '';
    await loadHistory();
    alert('Mensaje enviado');
  } catch (e) {
    alert(e.message);
  }
};

$('restartBtn').onclick = async () => {
  try {
    await api(`/api/sessions/${encodeURIComponent(current)}/restart`, 'POST', {});
    setQrStatus('Sesión reiniciada. Buscando QR...', 'warn');
    await loadSessions();
    await pollQr(current);
  } catch (e) {
    alert(e.message);
  }
};

$('logoutBtn').onclick = async () => {
  if (!confirm('Se cerrará la sesión de WhatsApp y habrá que escanear QR otra vez.')) return;

  try {
    await api(`/api/sessions/${encodeURIComponent(current)}/logout`, 'POST', {});
    $('qrBox').style.display = 'none';
    setQrStatus('Sesión cerrada.', 'warn');
    await loadSessions();
    alert('Sesión cerrada');
  } catch (e) {
    alert(e.message);
  }
};

$('tokenInput').value = token();
loadSessions().catch(() => {});
