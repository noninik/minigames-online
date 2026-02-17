const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// === Комнаты ===
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
      players: [socket.id],
      state: {},
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
    room.players.push(socket.id);
    socket.join(code);
    socket.roomCode = code;
    cb({ game: room.game, playerIndex: room.players.length - 1 });
    io.to(code).emit('playerJoined', room.players.length);
  });

  // === SNAKE ===
  socket.on('snakeUpdate', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('snakeUpdate', {
        id: socket.id,
        ...data
      });
    }
  });

  socket.on('snakeStart', () => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('snakeStart');
    }
  });

  // === PONG ===
  socket.on('pongMove', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('pongMove', data);
    }
  });

  socket.on('pongBall', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('pongBall', data);
    }
  });

  socket.on('pongScore', (data) => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('pongScore', data);
    }
  });

  // === DRAW ===
  socket.on('drawLine', (data) => {
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('drawLine', data);
    }
  });

  socket.on('clearCanvas', () => {
    if (socket.roomCode) {
      io.to(socket.roomCode).emit('clearCanvas');
    }
  });

  socket.on('chatMsg', (msg) => {
    if (socket.roomCode) {
      const room = rooms[socket.roomCode];
      if (room && room.state.word &&
          msg.toLowerCase().trim() === room.state.word.toLowerCase()) {
        io.to(socket.roomCode).emit('correctGuess', {
          id: socket.id,
          word: room.state.word
        });
        room.state.word = null;
      } else {
        io.to(socket.roomCode).emit('chatMsg', {
          id: socket.id,
          msg
        });
      }
    }
  });

  socket.on('setWord', (word) => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      rooms[socket.roomCode].state.word = word;
      const hint = word[0] + ' _'.repeat(word.length - 1);
      socket.to(socket.roomCode).emit('wordHint', hint);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      room.players = room.players.filter(p => p !== socket.id);
      io.to(socket.roomCode).emit('playerLeft', room.players.length);
      if (room.players.length === 0) {
        delete rooms[socket.roomCode];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
