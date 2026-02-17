const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Создать комнату
  socket.on('createRoom', (game, cb) => {
    const code = genCode();
    rooms[code] = {
      game,
      players: [{ id: socket.id, name: 'Игрок 1', score: 0 }],
      state: { word: null, drawerIndex: 0, round: 0 },
      host: socket.id
    };
    socket.join(code);
    socket.roomCode = code;
    cb(code);
  });

  // Войти в комнату
  socket.on('joinRoom', (code, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'Комната не найдена' });
    if (room.players.length >= 4) return cb({ error: 'Комната полная' });
    const idx = room.players.length;
    room.players.push({ id: socket.id, name: 'Игрок ' + (idx + 1), score: 0 });
    socket.join(code);
    socket.roomCode = code;
    cb({
      game: room.game,
      playerIndex: idx,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
    io.to(code).emit('playerJoined', {
      count: room.players.length,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  });

  // === DRAW: Хост нажал Начать ===
  socket.on('drawGameStart', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.id !== room.host) return;

    room.state.drawerIndex = 0;
    room.state.round = 0;
    room.state.word = null;

    const drawer = room.players[0];
    io.to(code).emit('drawGameStarted', {
      drawerIndex: 0,
      drawerId: drawer.id,
      drawerName: drawer.name,
      round: 1,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  });

  // === DRAW: Установить слово ===
  socket.on('setWord', (word) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.state.word = word;
    const hint = word[0] + ' _'.repeat(word.length - 1);
    socket.to(code).emit('wordHint', hint);
    io.to(code).emit('roundStart', {
      drawerIndex: room.state.drawerIndex,
      drawerId: room.players[room.state.drawerIndex].id,
      drawerName: room.players[room.state.drawerIndex].name,
      round: room.state.round + 1,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  });

  // === DRAW: Сообщение в чат / проверка ответа ===
  socket.on('chatMsg', (msg) => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    const playerName = playerIdx >= 0 ? room.players[playerIdx].name : 'Игрок';

    if (room.state.word &&
        msg.toLowerCase().trim() === room.state.word.toLowerCase().trim()) {
      if (playerIdx >= 0) room.players[playerIdx].score += 10;
      const di = room.state.drawerIndex;
      if (di < room.players.length) room.players[di].score += 5;

      io.to(code).emit('correctGuess', {
        name: playerName,
        word: room.state.word,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });

      room.state.word = null;

      setTimeout(() => {
        if (!rooms[code]) return;
        nextRound(code);
      }, 4000);
    } else {
      io.to(code).emit('chatMsg', { name: playerName, msg });
    }
  });

  // === DRAW: Рисование ===
  socket.on('drawLine', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('drawLine', data);
  });
  socket.on('clearCanvas', () => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('clearCanvas');
  });

  // === SNAKE ===
  socket.on('snakeUpdate', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('snakeUpdate', { id: socket.id, ...data });
  });
  socket.on('snakeStart', () => {
    if (socket.roomCode) io.to(socket.roomCode).emit('snakeStart');
  });

  // === PONG ===
  socket.on('pongMove', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('pongMove', data);
  });
  socket.on('pongBall', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('pongBall', data);
  });
  socket.on('pongScore', (data) => {
    if (socket.roomCode) io.to(socket.roomCode).emit('pongScore', data);
  });

  // === DISCONNECT ===
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      const room = rooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(code).emit('playerLeft', {
        count: room.players.length,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      if (room.players.length === 0) {
        delete rooms[code];
      }
    }
  });
});

function nextRound(code) {
  const room = rooms[code];
  if (!room || room.players.length < 2) return;

  room.state.round++;
  room.state.drawerIndex = room.state.round % room.players.length;
  room.state.word = null;

  const drawer = room.players[room.state.drawerIndex];

  io.to(code).emit('nextRound', {
    drawerIndex: room.state.drawerIndex,
    drawerId: drawer.id,
    drawerName: drawer.name,
    round: room.state.round + 1,
    players: room.players.map(p => ({ name: p.name, score: p.score }))
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
