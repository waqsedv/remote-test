const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8
});

// agents[socketId] = { id, name, connectedAt }
const agents = {};

function getAgentsList() {
  return Object.values(agents).map(a => ({
    id: a.id,
    name: a.name,
    connectedAt: a.connectedAt
  }));
}

function broadcastAgentsList() {
  io.emit('agents:list', getAgentsList());
}

app.get('/health', (req, res) =>
  res.json({ status: 'ok', agents: Object.keys(agents).length })
);

io.on('connection', (socket) => {
  console.log('[+] Connexion:', socket.id);

  // ── AGENT ──
  socket.on('agent:register', ({ name } = {}) => {
    socket.role = 'agent';
    agents[socket.id] = {
      id: socket.id,
      name: name || `Agent-${socket.id.slice(-6)}`,
      connectedAt: Date.now()
    };
    socket.emit('agent:registered');
    broadcastAgentsList();
    console.log(`[Agent] Enregistré: ${agents[socket.id].name}`);
  });

  // ── CONTROLLER ──
  socket.on('controller:register', () => {
    socket.role = 'controller';
    socket.emit('agents:list', getAgentsList());
    console.log(`[Controller] Enregistré: ${socket.id.slice(-6)}`);
  });

  // Controller veut se connecter à un agent spécifique
  socket.on('controller:connect', (agentId) => {
    if (!agents[agentId]) {
      socket.emit('connect:error', { agentId, msg: 'Agent non disponible' });
      return;
    }
    io.to(agentId).emit('controller:joined', socket.id);
    console.log(`[Controller] ${socket.id.slice(-6)} → ${agents[agentId].name}`);
  });

  // Controller se déconnecte d'un agent
  socket.on('controller:disconnect', (agentId) => {
    io.to(agentId).emit('controller:left', socket.id);
  });

  // ── SIGNALISATION WebRTC (relay direct par socket ID) ──
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // ── INPUT: controller → agent spécifique ──
  socket.on('input', ({ to, event }) => {
    if (socket.role !== 'controller') return;
    io.to(to).emit('input', event);
  });

  // ── COMMANDE macro: controller → agent ──
  socket.on('command', ({ to, cmd }) => {
    if (socket.role !== 'controller') return;
    io.to(to).emit('command', cmd);
  });

  // ── RÉSULTAT commande: agent → controller ──
  socket.on('command:result', ({ cmd, data }) => {
    // Relayer à tous les controllers
    io.emit('command:result', { agentId: socket.id, cmd, data });
  });

  // ── DÉCONNEXION ──
  socket.on('disconnect', () => {
    console.log('[-] Déconnexion:', socket.id, `(${socket.role || '?'})`);
    if (socket.role === 'agent') {
      const name = agents[socket.id]?.name;
      delete agents[socket.id];
      broadcastAgentsList();
      io.emit('agent:offline', socket.id);
      console.log(`[Agent] Hors ligne: ${name}`);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur actif sur le port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
