# FastFood Remote — Contrôle à distance des bornes

Système de contrôle à distance style AnyDesk pour bornes de commande FastFood.

## Architecture

```
[Serveur de signalisation]  ← déployé sur un VPS
        ↕ WebSocket
[Agent .exe]  ←──── WebRTC ────→  [Controller Mac/Win]
(sur la borne)                       (votre machine)
```

## 3 composants

| Composant | Description | Où déployer |
|-----------|-------------|-------------|
| `server/` | Serveur de signalisation Socket.io | VPS / Railway / Render |
| `agent/`  | Agent installé sur la borne | Windows (kiosk) |
| `controller/` | App de contrôle | Mac ou Windows (vous) |

---

## 1. Serveur de signalisation

```bash
cd server
npm install
npm start          # port 3000
```

**Déploiement en production (Railway / Render) :**
- Pointer le repo sur `server/`
- Variable d'env : `PORT=3000`
- Récupérer l'URL publique (ex: `https://fastfood-signal.railway.app`)

---

## 2. Configurer l'URL du serveur

Dans `agent/config.js` et `controller/config.js`, remplacez :
```js
SERVER_URL: 'http://localhost:3000'
// → par votre URL publique :
SERVER_URL: 'https://fastfood-signal.railway.app'
```

---

## 3. Controller (votre machine Mac/Windows)

```bash
cd controller
npm install
npm start                  # développement
npm run build:mac          # → dist/*.dmg
npm run build:win          # → dist/*.exe
```

---

## 4. Agent (borne Windows)

> ⚠️ L'agent doit être **compilé sur Windows** (ou via GitHub Actions).

**Sur une machine Windows :**
```bash
cd agent
npm install
npm run build:win          # → dist/FastFood Agent Setup.exe
                           # → dist/FastFood Agent.exe (portable)
```

**Depuis Mac avec Docker :**
```bash
cd agent
docker run --rm -v "$(pwd):/project" -w /project \
  electronuserland/builder:wine \
  npm run build:win
```

---

## Utilisation

1. Lancer l'**agent** sur la borne → un **code à 6 chiffres** s'affiche
2. Ouvrir le **controller** sur votre machine
3. Saisir le code et cliquer **Se connecter**
4. L'écran de la borne s'affiche → vous contrôlez souris + clavier à distance

---

## Raccourcis controller

| Action | Raccourci |
|--------|-----------|
| Clic | Clic gauche sur la vidéo |
| Clic droit | Clic droit sur la vidéo |
| Double-clic | Double-clic sur la vidéo |
| Scroll | Molette sur la vidéo |
| Clavier | Taper directement (vidéo focalisée) |
| Libérer focus | `Esc` |

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `3000` | Port du serveur |
| `SERVER_URL` | `http://localhost:3000` | URL du serveur (agent + controller) |
| `NODE_ENV` | - | `development` pour ouvrir DevTools |
