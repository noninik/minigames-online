const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

// ===== ХРАНИЛИЩЕ КОМНАТ =====
const rooms = {};

// ===== УТИЛИТЫ =====

// Генерация кода комнаты без похожих символов (O/0, I/1, l)
function genCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Валидация кода комнаты
function isValidRoomCode(code) {
  return /^[A-Z2-9]{6}$/.test(code);
}

// Очистка имени от XSS и пробелов
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return null;
  return name.replace(/[<>\"'&]/g, '').trim().slice(0, 15);
}

// Rate limiting: защита от спама событиями
const rateLimits = new Map();
function checkRateLimit(socketId, action, maxCalls = 20, windowMs = 1000) {
  const key = `${socketId}:${action}`;
  const now = Date.now();
  const record = rateLimits.get(key) || { count: 0, start: now };
  
  if (now - record.start > windowMs) {
    record.count = 1;
    record.start = now;
  } else {
    record.count++;
  }
  
  rateLimits.set(key, record);
  
  // Авто-очистка старых записей
  if (record.count > maxCalls * 2) {
    setTimeout(() => rateLimits.delete(key), windowMs * 2);
  }
  
  return record.count <= maxCalls;
}

// Очистка неактивных комнат каждые 5 минут
setInterval(() => {
  for (const code in rooms) {
    const room = rooms[code];
    if (room.players.length === 0 && room.lastActive < Date.now() - 600000) {
      delete rooms[code];
      console.log(`🧹 Удалена пустая комната: ${code}`);
    }
  }
}, 300000);

// ===== SOCKET.IO =====

io.on('connection', (socket) => {
  console.log(`🔗 Подключён: ${socket.id}`);

  // --- Создание комнаты ---
  socket.on('createRoom', (game, cb) => {
    try {
      if (typeof game !== 'string' || !['draw', 'snake', 'pong'].includes(game)) {
        return cb && cb({ error: 'Неподдерживаемая игра' });
      }
      
      const code = genCode();
      const playerName = 'Игрок 1'; // можно расширить: принимать имя от клиента
      
      rooms[code] = {
        game,
        players: [{ id: socket.id, name: playerName, score: 0 }],
        state: { word: null, drawerIndex: 0, round: 0 },
        host: socket.id,
        createdAt: Date.now(),
        lastActive: Date.now()
      };
      
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = playerName;
      
      console.log(`🏠 Создана комната ${code} (${game})`);
      cb && cb(code);
    } catch (err) {
      console.error('❌ Ошибка createRoom:', err);
      cb && cb({ error: 'Внутренняя ошибка сервера' });
    }
  });

  // --- Вход в комнату ---
  socket.on('joinRoom', (code, playerName, cb) => {
    try {
      // Валидация входных данных
      if (!isValidRoomCode(code)) {
        return cb && cb({ error: 'Неверный формат кода (6 букв/цифр)' });
      }
      
      const safeName = sanitizeName(playerName);
      if (!safeName || safeName.length < 2) {
        return cb && cb({ error: 'Имя должно быть 2-15 символов' });
      }
      
      const room = rooms[code];
      if (!room) return cb && cb({ error: 'Комната не найдена' });
      if (room.players.length >= 4) return cb && cb({ error: 'Комната полная' });
      
      // Проверка на дубликат имени
      if (room.players.some(p => p.name.toLowerCase() === safeName.toLowerCase())) {
        return cb && cb({ error: 'Такое имя уже занято' });
      }
      
      const idx = room.players.length;
      room.players.push({ id: socket.id, name: safeName, score: 0 });
      room.lastActive = Date.now();
      
      socket.join(code);
      socket.roomCode = code;
      socket.playerName = safeName;
      
      // Ответ подключившемуся
      cb && cb({
        game: room.game,
        playerIndex: idx,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      
      // Уведомление остальным
      io.to(code).emit('playerJoined', {
        name: safeName,
        count: room.players.length,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      
      console.log(`👤 ${safeName} вошёл в ${code}`);
    } catch (err) {
      console.error('❌ Ошибка joinRoom:', err);
      cb && cb({ error: 'Ошибка при входе' });
    }
  });

  // --- DRAW: Старт игры ---
  socket.on('drawGameStart', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    
    if (socket.id !== room.host) {
      return socket.emit('error', { msg: 'Только хост может начать игру' });
    }
    
    room.state.drawerIndex = 0;
    room.state.round = 0;
    room.state.word = null;
    room.lastActive = Date.now();
    
    const drawer = room.players[0];
    io.to(code).emit('drawGameStarted', {
      drawerIndex: 0,
      drawerId: drawer.id,
      drawerName: drawer.name,
      round: 1,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  });

  // --- DRAW: Установка слова ---
  socket.on('setWord', (word) => {
    if (!checkRateLimit(socket.id, 'setWord', 3, 5000)) return; // макс 3 раза за 5 сек
    
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    
    // Только рисующий может установить слово
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.state.drawerIndex) return;
    
    if (typeof word !== 'string' || word.trim().length < 2) return;
    
    room.state.word = word.trim();
    room.lastActive = Date.now();
    
    const hint = word[0] + ' _'.repeat(word.length - 1);
    socket.to(code).emit('wordHint', hint);
    
    io.to(code).emit('roundStart', {
      drawerIndex: room.state.drawerIndex,
      drawerId: room.players[room.state.drawerIndex]?.id,
      drawerName: room.players[room.state.drawerIndex]?.name,
      round: room.state.round + 1,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
  });

  // --- DRAW: Чат / угадывание ---
  socket.on('chatMsg', (msg) => {
    if (!checkRateLimit(socket.id, 'chatMsg', 10, 1000)) return;
    
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.lastActive = Date.now();
    
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    const playerName = playerIdx >= 0 ? room.players[playerIdx].name : 'Игрок';
    
    // Проверка на правильный ответ
    if (room.state.word && 
        typeof msg === 'string' &&
        msg.toLowerCase().trim() === room.state.word.toLowerCase().trim()) {
      
      // Награда угадавшему
      if (playerIdx >= 0) room.players[playerIdx].score += 10;
      
      // Награда рисующему
      const di = room.state.drawerIndex;
      if (di < room.players.length) room.players[di].score += 5;
      
      io.to(code).emit('correctGuess', {
        name: playerName,
        word: room.state.word,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      
      room.state.word = null;
      
      // Следующий раунд с задержкой
      setTimeout(() => {
        if (rooms[code]) nextRound(code);
      }, 4000);
      
    } else {
      // Обычное сообщение в чат
      io.to(code).emit('chatMsg', { name: playerName, msg: String(msg).slice(0, 200) });
    }
  });

  // --- DRAW: Рисование (с rate limit) ---
  socket.on('drawLine', (data) => {
    if (!checkRateLimit(socket.id, 'drawLine', 50, 1000)) return; // макс 50 линий/сек
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('drawLine', {
        from: data?.from,
        to: data?.to,
        color: data?.color,
        sz: data?.sz
      });
    }
  });
  
  socket.on('clearCanvas', () => {
    if (!checkRateLimit(socket.id, 'clearCanvas', 5, 2000)) return;
    if (socket.roomCode) socket.to(socket.roomCode).emit('clearCanvas');
  });

  // --- SNAKE ---
  socket.on('snakeUpdate', (data) => {
    if (!checkRateLimit(socket.id, 'snakeUpdate', 30, 1000)) return;
    if (socket.roomCode) {
      socket.to(socket.roomCode).emit('snakeUpdate', { 
        id: socket.id, 
        x: data?.x, 
        y: data?.y, 
        dir: data?.dir 
      });
    }
  });
  
  socket.on('snakeStart', () => {
    if (socket.roomCode) io.to(socket.roomCode).emit('snakeStart');
  });

  // --- PONG ---
  socket.on('pongMove', (data) => {
    if (!checkRateLimit(socket.id, 'pongMove', 60, 1000)) return;
    if (socket.roomCode) socket.to(socket.roomCode).emit('pongMove', {
      y: data?.y,
      player: data?.player
    });
  });
  
  socket.on('pongBall', (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('pongBall', {
      x: data?.x,
      y: data?.y,
      vx: data?.vx,
      vy: data?.vy
    });
  });
  
  socket.on('pongScore', (data) => {
    if (socket.roomCode) io.to(socket.roomCode).emit('pongScore', {
      left: data?.left,
      right: data?.right
    });
  });

  // --- ОТКЛЮЧЕНИЕ ---
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      const room = rooms[code];
      const leftName = room.players.find(p => p.id === socket.id)?.name;
      
      room.players = room.players.filter(p => p.id !== socket.id);
      
      io.to(code).emit('playerLeft', {
        name: leftName,
        count: room.players.length,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
      
      // Если хост ушёл — передаём хост первому оставшемуся
      if (socket.id === room.host && room.players.length > 0) {
        room.host = room.players[0].id;
        io.to(code).emit('hostChanged', { newHost: room.players[0].name });
      }
      
      // Удаляем пустую комнату
      if (room.players.length === 0) {
        delete rooms[code];
        console.log(`🗑️ Удалена комната: ${code}`);
      } else {
        console.log(`👋 ${leftName} покинул ${code}`);
      }
    }
  });

  // --- ОБРАБОТКА НЕИЗВЕСТНЫХ СОБЫТИЙ ---
  socket.onAny((event, ...args) => {
    console.warn(`⚠️ Неизвестное событие: ${event}`);
  });
});

// ===== ЛОГИКА СЛЕДУЮЩЕГО РАУНДА (DRAW) =====
function nextRound(code) {
  const room = rooms[code];
  if (!room || room.players.length < 2) return;
  
  room.state.round++;
  room.state.drawerIndex = room.state.round % room.players.length;
  room.state.word = null;
  
  const drawer = room.players[room.state.drawerIndex];
  if (!drawer) return;
  
  io.to(code).emit('nextRound', {
    drawerIndex: room.state.drawerIndex,
    drawerId: drawer.id,
    drawerName: drawer.name,
    round: room.state.round + 1,
    players: room.players.map(p => ({ name: p.name, score: p.score }))
  });
}

// ===== ЗАПУСК СЕРВЕРА =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGINT', () => {
  console.log('\n🛑 Завершение работы...');
  for (const code in rooms) {
    io.to(code).emit('serverShutdown');
  }
  server.close(() => {
    console.log('✅ Сервер остановлен');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('💥 Необработанная ошибка:', err);
});
