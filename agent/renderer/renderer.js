const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { SERVER_URL } = require('../config');

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

let socket;
let peerConnections = {}; // controllerId → RTCPeerConnection
let screenStream = null;

function updateStatus(text) {
  const controllers = Object.keys(peerConnections).length;
  ipcRenderer.send('status-update', { text, controllers });
}

// ── Capture d'écran ──
async function getScreenStream() {
  const sources = await ipcRenderer.invoke('get-screen-sources');
  if (!sources || sources.length === 0) throw new Error('Aucun écran trouvé');

  const source = sources[0];
  return await navigator.mediaDevices.getUserMedia({
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
}

// ── Connexion WebRTC avec un controller ──
async function createPeerConnection(controllerId) {
  if (!screenStream) {
    screenStream = await getScreenStream();
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[controllerId] = pc;

  screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', { to: controllerId, signal: { type: 'ice', candidate } });
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    const count = Object.keys(peerConnections).length;

    if (state === 'connected') {
      updateStatus(count > 1 ? `${count} contrôleurs connectés` : 'Contrôlé');
    } else if (['disconnected', 'failed', 'closed'].includes(state)) {
      delete peerConnections[controllerId];
      const remaining = Object.keys(peerConnections).length;
      updateStatus(remaining > 0 ? `${remaining} contrôleur(s)` : 'En attente');
    }
  };

  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: controllerId, signal: { type: 'offer', sdp: offer } });

  return pc;
}

// ── Socket.io ──
async function connect() {
  const hostname = await ipcRenderer.invoke('get-hostname');

  updateStatus('Connexion au serveur...');

  socket = io(SERVER_URL, {
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000
  });

  socket.on('connect', () => {
    socket.emit('agent:register', { name: hostname });
  });

  socket.on('agent:registered', () => {
    updateStatus('En attente de connexion');
  });

  socket.on('controller:joined', async (controllerId) => {
    updateStatus('Établissement WebRTC...');
    try {
      await createPeerConnection(controllerId);
    } catch (err) {
      updateStatus(`Erreur: ${err.message}`);
    }
  });

  socket.on('signal', async ({ from, signal }) => {
    const pc = peerConnections[from];
    if (!pc) return;

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'ice' && signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
    }
  });

  socket.on('input', (event) => {
    ipcRenderer.send('execute-input', event);
  });

  socket.on('controller:left', (controllerId) => {
    const pc = peerConnections[controllerId];
    if (pc) { pc.close(); delete peerConnections[controllerId]; }
    const remaining = Object.keys(peerConnections).length;
    updateStatus(remaining > 0 ? `${remaining} contrôleur(s)` : 'En attente');
  });

  socket.on('disconnect', () => updateStatus('Déconnecté — reconnexion...'));
  socket.on('connect_error', () => updateStatus('Serveur inaccessible'));
}

connect();
