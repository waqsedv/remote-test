const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const InputSimulator = require('./input-simulator');

let mainWindow;
let inputSimulator;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 500,
    resizable: false,
    frame: false,
    transparent: false,
    alwaysOnTop: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
    icon: path.join(__dirname, 'assets', 'icon.ico')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ouvrir DevTools en développement
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (inputSimulator) inputSimulator.destroy();
  });
}

app.whenReady().then(() => {
  inputSimulator = new InputSimulator();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

// Fournir les sources d'écran au renderer
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 }
  });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

// Fournir les dimensions de l'écran principal
ipcMain.handle('get-screen-size', () => {
  const primary = screen.getPrimaryDisplay();
  return {
    width: primary.bounds.width,
    height: primary.bounds.height,
    scaleFactor: primary.scaleFactor
  };
});

// Exécuter un événement input reçu du controller
ipcMain.on('execute-input', (_, event) => {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.bounds;
  inputSimulator.handleEvent(event, width, height);
});

// Fermer l'app depuis le renderer
ipcMain.on('app-quit', () => {
  app.quit();
});

// Minimiser depuis le renderer
ipcMain.on('app-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
