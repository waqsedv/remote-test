const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { SERVER_URL } = require('../config');

// --- Contrôles fenêtre ---
function minimize() { ipcRenderer.send('app-minimize'); }
function maximize() { ipcRenderer.send('app-maximize'); }
function quit()     { ipcRenderer.send('app-quit'); }
window.minimize = minimize;
window.maximize = maximize;
window.quit     = quit;

// --- État global ---
let socket;
let pc;               // RTCPeerConnection
let agentId;          // socket.id de l'agent distant
let connected = false;
let fpsCounter = 0;
let lastFpsTime = Date.now();

// --- UI helpers ---
function setTitleStatus(state, text) {
  document.getElementById('tlStatusDot').className = `status-dot ${state}`;
  document.getElementById('tlStatusText').textContent = text;
}

function addLog(msg, type = 'info') {
  const box = document.getElementById('logBox');
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${time}] ${msg}`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function showOverlay(text) {
  document.getElementById('viewerOverlay').classList.add('visible');
  document.getElementById('overlayText').textContent = text;
}
function hideOverlay() {
  document.getElementById('viewerOverlay').classList.remove('visible');
}

function showVideo() {
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('remoteVideo').classList.add('visible');
  document.getElementById('toolbar').classList.add('visible');
  document.getElementById('sessionInfo').style.display = 'block';
  hideOverlay();
}

function resetVideo() {
  document.getElementById('placeholder').style.display = 'flex';
  document.getElementById('remoteVideo').classList.remove('visible');
  document.getElementById('toolbar').classList.remove('visible');
  document.getElementById('sessionInfo').style.display = 'none';
  document.getElementById('remoteVideo').srcObject = null;
  hideOverlay();
}

function setConnectUI(isConnected) {
  connected = isConnected;
  document.getElementById('connectForm').style.display   = isConnected ? 'none'  : 'block';
  document.getElementById('disconnectArea').style.display = isConnected ? 'block' : 'none';
}

// --- WebRTC config ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// --- Connexion à une borne ---
window.connectToSession = function () {
  const input = document.getElementById('sessionInput');
  const code = input.value.trim().replace(/\D/g, '');

  if (code.length !== 6) {
    addLog('Code invalide — 6 chiffres requis', 'warn');
    input.focus();
    return;
  }

  if (!socket || !socket.connected) {
    addLog('Non connecté au serveur', 'error');
    return;
  }

  addLog(`Connexion à la borne ${code}...`);
  showOverlay('Connexion en cours...');
  document.getElementById('sessionInput').disabled = true;
  document.getElementById('btnConnect').disabled = true;

  socket.emit('controller:join', code);
  document.getElementById('infoCode').textContent = code;
};

// --- Déconnexion ---
window.disconnect = function () {
  if (pc) { pc.close(); pc = null; }
  agentId = null;
  setConnectUI(false);
  setTitleStatus('', 'Non connecté');
  resetVideo();
  document.getElementById('sessionInput').disabled = false;
  document.getElementById('btnConnect').disabled = false;
  document.getElementById('sessionInput').value = '';
  addLog('Déconnecté de la borne', 'warn');
};

// --- Créer la connexion WebRTC (côté controller = answerer) ---
function createPeerConnection(fromId) {
  if (pc) { pc.close(); }

  agentId = fromId;
  pc = new RTCPeerConnection(RTC_CONFIG);

  // Réception du flux vidéo
  pc.ontrack = (event) => {
    addLog('Flux vidéo reçu', 'ok');
    const video = document.getElementById('remoteVideo');
    video.srcObject = event.streams[0];
    video.onloadedmetadata = () => {
      showVideo();
      setConnectUI(true);
      setTitleStatus('connected', `Connecté — borne ${document.getElementById('sessionInput').value || document.getElementById('infoCode').textContent}`);
      addLog('Affichage actif', 'ok');
      updateResolutionInfo(video);
      startFpsCounter(event.streams[0]);
    };
    video.focus();
  };

  // Relayer les ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', { to: agentId, signal: { type: 'ice', candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    addLog(`WebRTC: ${state}`);

    if (state === 'failed' || state === 'disconnected') {
      setTitleStatus('error', 'Connexion perdue');
      addLog('Connexion WebRTC perdue', 'error');
    }
  };

  pc.oniceconnectionstatechange = () => {
    document.getElementById('infoWebrtc').textContent = pc.iceConnectionState;
    document.getElementById('infoWebrtc').className =
      pc.iceConnectionState === 'connected' ? 'info-value good' : 'info-value';
  };
}

// --- Afficher résolution ---
function updateResolutionInfo(video) {
  const update = () => {
    if (video.videoWidth) {
      document.getElementById('infoRes').textContent = `${video.videoWidth}×${video.videoHeight}`;
    }
  };
  update();
  video.addEventListener('resize', update);
}

// --- Compteur FPS ---
function startFpsCounter(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return;

  setInterval(() => {
    if (!pc) return;
    pc.getStats(track).then(stats => {
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const fps = Math.round(report.framesPerSecond || 0);
          document.getElementById('infoFps').textContent = `${fps} fps`;

          // Qualité (0-30fps = 0-100%)
          const q = Math.min(100, (fps / 30) * 100);
          const fill = document.getElementById('qualityFill');
          fill.style.width = `${q}%`;
          fill.style.background = q > 60 ? '#48bb78' : q > 30 ? '#ecc94b' : '#fc4a4a';
        }
      });
    }).catch(() => {});
  }, 2000);
}

// --- Capture et envoi des événements input ---
function setupInputCapture() {
  const video = document.getElementById('remoteVideo');

  function getRelCoords(e) {
    const rect = video.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height))
    };
  }

  function sendInput(event) {
    if (!socket || !connected) return;
    socket.emit('input', event);
  }

  // Curseur distant
  const cursor = document.getElementById('remoteCursor');

  // Throttle mousemove (max 30/s)
  let lastMove = 0;
  video.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < 33) return; // ~30fps
    lastMove = now;

    const { x, y } = getRelCoords(e);
    cursor.style.display = 'block';
    cursor.style.left = `${e.clientX - video.getBoundingClientRect().left}px`;
    cursor.style.top  = `${e.clientY - video.getBoundingClientRect().top}px`;
    sendInput({ type: 'mousemove', x, y });
  });

  video.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
  });

  video.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const { x, y } = getRelCoords(e);
    sendInput({ type: 'mousedown', x, y, button: e.button });
  });

  video.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const { x, y } = getRelCoords(e);
    sendInput({ type: 'mouseup', x, y, button: e.button });
  });

  video.addEventListener('click', (e) => {
    e.preventDefault();
    const { x, y } = getRelCoords(e);
    sendInput({ type: 'click', x, y, button: e.button });
  });

  video.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const { x, y } = getRelCoords(e);
    sendInput({ type: 'dblclick', x, y });
  });

  video.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = getRelCoords(e);
    sendInput({ type: 'contextmenu', x, y });
  });

  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    sendInput({ type: 'wheel', deltaY: e.deltaY, deltaX: e.deltaX });
  }, { passive: false });

  // Clavier — intercepter seulement quand la vidéo a le focus
  video.addEventListener('keydown', (e) => {
    e.preventDefault();
    sendInput({ type: 'keydown', keyCode: e.keyCode, key: e.key });
  });

  video.addEventListener('keyup', (e) => {
    e.preventDefault();
    sendInput({ type: 'keyup', keyCode: e.keyCode, key: e.key });
  });

  // Clic sur la vidéo = donner le focus
  video.addEventListener('click', () => video.focus());
}

// --- Connexion Socket.io au serveur de signalisation ---
function connectToServer() {
  addLog(`Connexion au serveur: ${SERVER_URL}`);
  setTitleStatus('connecting', 'Connexion serveur...');

  socket = io(SERVER_URL, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000
  });

  socket.on('connect', () => {
    addLog('Serveur connecté', 'ok');
    setTitleStatus('', 'Prêt');
  });

  // L'agent nous a répondu: "controller:joined" — l'agent va envoyer une offre WebRTC
  // On attend le signal 'offer' de l'agent

  socket.on('signal', async ({ from, signal }) => {
    if (signal.type === 'offer') {
      addLog('Offre WebRTC reçue. Connexion...', 'ok');
      showOverlay('Établissement WebRTC...');

      createPeerConnection(from);

      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('signal', { to: from, signal: { type: 'answer', sdp: answer } });
      addLog('Réponse WebRTC envoyée');

    } else if (signal.type === 'ice' && signal.candidate) {
      if (pc) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      }
    }
  });

  socket.on('join:error', (msg) => {
    addLog(`Erreur: ${msg}`, 'error');
    hideOverlay();
    document.getElementById('sessionInput').disabled = false;
    document.getElementById('btnConnect').disabled = false;
    setTitleStatus('error', msg);
  });

  socket.on('agent:disconnected', () => {
    addLog('La borne s\'est déconnectée', 'warn');
    setTitleStatus('error', 'Borne déconnectée');
    resetVideo();
    setConnectUI(false);
    document.getElementById('sessionInput').disabled = false;
    document.getElementById('btnConnect').disabled = false;
    if (pc) { pc.close(); pc = null; }
  });

  socket.on('disconnect', () => {
    addLog('Serveur déconnecté. Reconnexion...', 'warn');
    setTitleStatus('error', 'Serveur déconnecté');
  });

  socket.on('connect_error', (err) => {
    addLog(`Serveur inaccessible: ${err.message}`, 'error');
    setTitleStatus('error', 'Serveur inaccessible');
  });
}

// --- Filtre numérique sur le champ code ---
document.getElementById('sessionInput').addEventListener('input', function () {
  this.value = this.value.replace(/\D/g, '').slice(0, 6);
});

document.getElementById('sessionInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.connectToSession();
});

// --- Démarrage ---
setupInputCapture();
connectToServer();
