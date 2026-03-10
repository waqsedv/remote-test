const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e8 // 100MB pour les gros frames
});

// sessions[sessionId] = { agentId: socketId }
const sessions = {};

function generateSessionId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: Object.keys(sessions).length }));

io.on('connection', (socket) => {
  console.log('[+] Connexion:', socket.id);

  // --- AGENT ---
  socket.on('agent:register', () => {
    let sessionId = generateSessionId();
    // Eviter les collisions
    while (sessions[sessionId]) sessionId = generateSessionId();

    sessions[sessionId] = { agentId: socket.id };
    socket.sessionId = sessionId;
    socket.role = 'agent';
    socket.join(sessionId);

    socket.emit('agent:registered', sessionId);
    console.log(`[Agent] Enregistré: ${sessionId}`);
  });

  // --- CONTROLLER ---
  socket.on('controller:join', (sessionId) => {
    const session = sessions[sessionId];
    if (!session) {
      socket.emit('join:error', 'Session introuvable. Vérifiez le code.');
      return;
    }

    socket.sessionId = sessionId;
    socket.role = 'controller';
    socket.join(sessionId);

    // Informer l'agent qu'un controller veut se connecter
    io.to(session.agentId).emit('controller:joined', socket.id);
    console.log(`[Controller] Rejoint: ${sessionId}`);
  });

  // --- SIGNALISATION WebRTC (relay) ---
  socket.on('signal', ({ to, signal }) => {
    io.to(to).emit('signal', { from: socket.id, signal });
  });

  // --- ÉVÉNEMENTS INPUT (controller → agent) ---
  socket.on('input', (event) => {
    if (socket.role !== 'controller') return;
    const session = sessions[socket.sessionId];
    if (session) {
      io.to(session.agentId).emit('input', event);
    }
  });

  // --- DÉCONNEXION ---
  socket.on('disconnect', () => {
    console.log('[-] Déconnexion:', socket.id, `(${socket.role || 'inconnu'})`);

    if (socket.role === 'agent' && socket.sessionId) {
      delete sessions[socket.sessionId];
      io.to(socket.sessionId).emit('agent:disconnected');
      console.log(`[Agent] Session fermée: ${socket.sessionId}`);
    } else if (socket.role === 'controller' && socket.sessionId) {
      const session = sessions[socket.sessionId];
      if (session) {
        io.to(session.agentId).emit('controller:left', socket.id);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur de signalisation actif sur le port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health\n`);
});
