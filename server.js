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

  // === DRAW ===
  socket.on('setWord', (word) => {
    if (!socket.roomCode || !rooms[socket.roomCode]) return;
    const room = rooms[socket.roomCode];
    room.state.word = word;
    const hint = word[0] + ' _'.repeat(word.length - 1);
    // Отправить подсказку всем КРОМЕ рисующего
    socket.to(socket.roomCode).emit('wordHint', hint);
    io.to(socket.roomCode).emit('roundStart', {
      drawerIndex: room.state.drawerIndex,
      drawerId: room.players[room.state.drawerIndex].id,
      drawerName: room.players[room.state.drawerIndex].name,
      round: room.state.round + 1
    });
  });

  socket.on('chatMsg', (msg) => {
    if (!socket.roomCode || !rooms[socket.roomCode]) return;
    const room = rooms[socket.roomCode];
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    const playerName = playerIdx >= 0 ? room.players[playerIdx].name : 'Игрок';

    // Проверка угадал ли
    if (room.state.word &&
        msg.toLowerCase().trim() === room.state.word.toLowerCase().trim()) {
      // Начислить очки
      if (playerIdx >= 0) room.players[playerIdx].score += 10;
      // Рисующему тоже очки
      const di = room.state.drawerIndex;
      if (di < room.players.length) room.players[di].score += 5;

      io.to(socket.roomCode).emit('correctGuess', {
        name: playerName,
        word: room.state.word,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });

      room.state.word = null;

      // Следующий раунд через 4 секунды
      setTimeout(() => {
        if (!rooms[socket.roomCode]) return;
        nextRound(socket.roomCode);
      }, 4000);
    } else {
      io.to(socket.roomCode).emit('chatMsg', {
        name: playerName,
        msg
      });
    }
  });

  socket.on('drawLine', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('drawLine', data);
  });

  socket.on('clearCanvas', () => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('clearCanvas');
  });

  // === SNAKE ===
  socket.on('snakeUpdate', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('snakeUpdate', { id: socket.id, ...data });
    }
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
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(socket.roomCode).emit('playerLeft', {
        count: room.players.length,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      if (room.players.length === 0) {
        delete rooms[socket.roomCode];
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
  console.log(`Server running on port ${PORT}`);
});
