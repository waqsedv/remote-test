/**
 * InputSimulator — simule souris et clavier sur Windows via un processus PowerShell persistant.
 * Ne nécessite aucun module natif Node.js.
 */
const { spawn } = require('child_process');

const INIT_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IS {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void LeftDown(int x, int y) { SetCursorPos(x, y); mouse_event(0x0002, 0, 0, 0, 0); }
    public static void LeftUp(int x, int y)   { SetCursorPos(x, y); mouse_event(0x0004, 0, 0, 0, 0); }
    public static void LeftClick(int x, int y) { SetCursorPos(x, y); mouse_event(0x0002, 0, 0, 0, 0); mouse_event(0x0004, 0, 0, 0, 0); }
    public static void LeftDblClick(int x, int y) { LeftClick(x, y); System.Threading.Thread.Sleep(50); LeftClick(x, y); }

    public static void RightDown(int x, int y) { SetCursorPos(x, y); mouse_event(0x0008, 0, 0, 0, 0); }
    public static void RightUp(int x, int y)   { SetCursorPos(x, y); mouse_event(0x0010, 0, 0, 0, 0); }
    public static void RightClick(int x, int y) { SetCursorPos(x, y); mouse_event(0x0008, 0, 0, 0, 0); mouse_event(0x0010, 0, 0, 0, 0); }

    public static void Scroll(int delta) { mouse_event(0x0800, 0, 0, (uint)delta, 0); }

    public static void KeyDown(byte vk) { keybd_event(vk, 0, 0x0000, 0); }
    public static void KeyUp(byte vk)   { keybd_event(vk, 0, 0x0002, 0); }
    public static void KeyPress(byte vk) { KeyDown(vk); System.Threading.Thread.Sleep(30); KeyUp(vk); }
}
"@
Write-Output "READY"
`;

class InputSimulator {
  constructor() {
    this.ready = false;
    this.queue = [];
    this.ps = null;

    if (process.platform === 'win32') {
      this._start();
    } else {
      console.log('[InputSimulator] Non-Windows: simulation désactivée');
    }
  }

  _start() {
    this.ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-NoExit', '-Command', '-'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ps.stdout.on('data', (data) => {
      if (data.toString().includes('READY')) {
        console.log('[InputSimulator] Prêt');
        this.ready = true;
        this.queue.forEach(cmd => this._exec(cmd));
        this.queue = [];
      }
    });

    this.ps.stderr.on('data', (d) => console.error('[InputSimulator Error]', d.toString()));

    this.ps.on('exit', (code) => {
      console.warn(`[InputSimulator] PowerShell fermé (code ${code}). Redémarrage...`);
      this.ready = false;
      setTimeout(() => this._start(), 1000);
    });

    this.ps.stdin.write(INIT_SCRIPT + '\n');
  }

  _exec(cmd) {
    if (!this.ps || !this.ready) {
      this.queue.push(cmd);
      return;
    }
    try {
      this.ps.stdin.write(cmd + '\n');
    } catch (e) {
      console.error('[InputSimulator] Erreur écriture:', e.message);
    }
  }

  // --- API publique ---
  moveMouse(x, y)          { this._exec(`[IS]::Move(${x}, ${y})`); }
  leftClick(x, y)          { this._exec(`[IS]::LeftClick(${x}, ${y})`); }
  leftDblClick(x, y)       { this._exec(`[IS]::LeftDblClick(${x}, ${y})`); }
  leftDown(x, y)           { this._exec(`[IS]::LeftDown(${x}, ${y})`); }
  leftUp(x, y)             { this._exec(`[IS]::LeftUp(${x}, ${y})`); }
  rightClick(x, y)         { this._exec(`[IS]::RightClick(${x}, ${y})`); }
  scroll(delta)            { this._exec(`[IS]::Scroll(${delta})`); }
  keyDown(vkCode)          { this._exec(`[IS]::KeyDown(${vkCode})`); }
  keyUp(vkCode)            { this._exec(`[IS]::KeyUp(${vkCode})`); }
  keyPress(vkCode)         { this._exec(`[IS]::KeyPress(${vkCode})`); }

  // Traite un événement input reçu du controller
  handleEvent(event, screenW, screenH) {
    if (!event) return;

    const ax = event.x != null ? Math.round(event.x * screenW) : 0;
    const ay = event.y != null ? Math.round(event.y * screenH) : 0;

    switch (event.type) {
      case 'mousemove':   this.moveMouse(ax, ay); break;
      case 'mousedown':
        if (event.button === 2) this.rightClick(ax, ay);
        else this.leftDown(ax, ay);
        break;
      case 'mouseup':
        if (event.button !== 2) this.leftUp(ax, ay);
        break;
      case 'click':       this.leftClick(ax, ay); break;
      case 'dblclick':    this.leftDblClick(ax, ay); break;
      case 'contextmenu': this.rightClick(ax, ay); break;
      case 'wheel':       this.scroll(-Math.round(event.deltaY * 3)); break;
      case 'keydown':     this.keyDown(event.keyCode); break;
      case 'keyup':       this.keyUp(event.keyCode); break;
    }
  }

  destroy() {
    if (this.ps) {
      this.ps.kill();
      this.ps = null;
    }
  }
}

module.exports = InputSimulator;
