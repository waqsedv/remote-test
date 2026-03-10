const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { SERVER_URL } = require('../config');

// --- UI helpers ---
function setStatus(state, text) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  dot.className = `status-dot ${state}`;
  txt.textContent = text;
}

function addLog(msg) {
  const log = document.getElementById('log');
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  log.innerHTML += `<div>[${time}] ${msg}</div>`;
  log.scrollTop = log.scrollHeight;
}

function minimize() { ipcRenderer.send('app-minimize'); }
function quit()     { ipcRenderer.send('app-quit'); }

// Expose pour les boutons HTML
window.minimize = minimize;
window.quit     = quit;

// --- WebRTC config ---
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let socket;
let peerConnections = {}; // controllerId -> RTCPeerConnection
let screenStream = null;

// --- Capture d'écran ---
async function getScreenStream() {
  const sources = await ipcRenderer.invoke('get-screen-sources');
  if (!sources || sources.length === 0) throw new Error('Aucun écran trouvé');

  const source = sources[0]; // Écran principal
  addLog(`Capture: ${source.name}`);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 15
      }
    }
  });

  return stream;
}

// --- Créer une connexion WebRTC avec un controller ---
async function createPeerConnection(controllerId) {
  if (!screenStream) {
    screenStream = await getScreenStream();
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[controllerId] = pc;

  // Ajouter le flux écran
  screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

  // Relayer les ICE candidates via le serveur
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', { to: controllerId, signal: { type: 'ice', candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    addLog(`WebRTC [${controllerId.slice(-6)}]: ${state}`);

    if (state === 'connected') {
      setStatus('connected', 'Contrôleur connecté');
      document.getElementById('controllerId').textContent = `ID: ${controllerId.slice(-8)}`;
    } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
      setStatus('connecting', 'En attente de connexion...');
      document.getElementById('controllerId').textContent = '';
      delete peerConnections[controllerId];
    }
  };

  // Créer l'offre WebRTC
  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);

  socket.emit('signal', { to: controllerId, signal: { type: 'offer', sdp: offer } });
  addLog(`Offre WebRTC envoyée à ${controllerId.slice(-6)}`);

  return pc;
}

// --- Connexion Socket.io ---
function connect() {
  addLog(`Connexion à ${SERVER_URL}...`);
  setStatus('connecting', 'Connexion au serveur...');

  socket = io(SERVER_URL, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000
  });

  socket.on('connect', () => {
    addLog('Connecté au serveur. Enregistrement...');
    socket.emit('agent:register');
  });

  socket.on('agent:registered', (sessionId) => {
    const el = document.getElementById('sessionId');
    el.textContent = sessionId;
    el.classList.remove('loading');
    setStatus('connecting', 'En attente de connexion...');
    addLog(`Enregistré — Code: ${sessionId}`);
  });

  // Un controller veut se connecter
  socket.on('controller:joined', async (controllerId) => {
    addLog(`Controller entrant: ${controllerId.slice(-6)}`);
    setStatus('connecting', 'Établissement WebRTC...');
    try {
      await createPeerConnection(controllerId);
    } catch (err) {
      addLog(`Erreur WebRTC: ${err.message}`);
      setStatus('error', 'Erreur de connexion');
    }
  });

  // Recevoir les signaux WebRTC (ICE answer)
  socket.on('signal', async ({ from, signal }) => {
    const pc = peerConnections[from];
    if (!pc) return;

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice' && signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  });

  // Recevoir et exécuter les événements input
  socket.on('input', (event) => {
    ipcRenderer.send('execute-input', event);
  });

  socket.on('controller:left', (controllerId) => {
    const pc = peerConnections[controllerId];
    if (pc) { pc.close(); delete peerConnections[controllerId]; }
    setStatus('connecting', 'En attente de connexion...');
    document.getElementById('controllerId').textContent = '';
    addLog(`Controller déconnecté: ${controllerId.slice(-6)}`);
  });

  socket.on('disconnect', () => {
    setStatus('error', 'Déconnecté du serveur');
    const el = document.getElementById('sessionId');
    el.textContent = '------';
    el.classList.add('loading');
    addLog('Déconnecté. Reconnexion...');
  });

  socket.on('connect_error', (err) => {
    setStatus('error', 'Serveur inaccessible');
    addLog(`Erreur: ${err.message}`);
  });
}

// Démarrage
connect();
