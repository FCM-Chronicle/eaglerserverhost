const WebSocket = require('ws');
const express = require('express');
const mc = require('minecraft-protocol');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Express 서버 설정 (Render용)
const app = express();

// JSON 파싱 미들웨어
app.use(express.json());
app.use(express.static('public'));

// 플레이어 관리
const players = new Map();
const worlds = new Map();
let wss = null;

// 기본 월드 생성
worlds.set('overworld', {
  name: 'overworld',
  spawn: { x: 0, y: 64, z: 0 },
  players: new Set()
});

// 메인 상태 API
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Minecraft 1.12.2 WebSocket Server',
    players: players.size,
    uptime: Math.floor(process.uptime())
  });
});

// 서버 시작 API
app.post('/api/start', (req, res) => {
  try {
    if (!wss) {
      startWebSocketServer();
    }
    res.json({ success: true, message: '서버가 시작되었습니다' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 서버 중지 API  
app.post('/api/stop', (req, res) => {
  try {
    if (wss) {
      // 모든 연결 종료
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'server_shutdown',
            message: '서버가 관리자에 의해 중지되었습니다'
          }));
          client.close();
        }
      });
    }
    res.json({ success: true, message: '서버가 중지되었습니다' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`HTTP 서버가 포트 ${PORT}에서 실행 중입니다`);
  console.log(`호스팅 패널: https://eaglerserverhost.onrender.com`);
});

// WebSocket 서버 시작 함수
function startWebSocketServer() {
  if (wss) {
    console.log('WebSocket 서버가 이미 실행 중입니다');
    return;
  }

  // Render에서는 HTTP와 같은 포트 사용
  wss = new WebSocket.Server({ 
    port: PORT + 1,
    path: '/ws'
  });

  console.log(`마인크래프트 웹소켓 서버가 포트 ${PORT + 1}에서 시작되었습니다`);

  wss.on('connection', handleWebSocketConnection);
}

function handleWebSocketConnection(ws) {
  console.log('새로운 WebSocket 연결이 설정되었습니다');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const handler = packetHandlers[data.type];
      
      if (handler) {
        handler(ws, data);
      } else {
        console.log(`알 수 없는 패킷 타입: ${data.type}`);
      }
    } catch (error) {
      console.error('메시지 처리 오류:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: '잘못된 메시지 형식입니다'
      }));
    }
  });

  ws.on('close', () => {
    if (ws.playerId) {
      const player = players.get(ws.playerId);
      if (player) {
        // 플레이어 연결 해제 처리
        player.connected = false;
        worlds.get(player.world).players.delete(ws.playerId);
        
        // 다른 플레이어들에게 알림
        broadcastToWorld(player.world, {
          type: 'player_leave',
          playerId: ws.playerId,
          username: player.username
        });

        players.delete(ws.playerId);
        console.log(`플레이어 ${player.username}가 연결을 해제했습니다`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket 오류:', error);
  });
}

// 패킷 처리 함수들
const packetHandlers = {
  // 관리자 연결 (호스팅 패널용)
  admin_connect: (ws, data) => {
    ws.isAdmin = true;
    console.log('관리자 패널이 연결되었습니다');
    
    // 현재 플레이어 목록 전송
    const playerList = Array.from(players.values()).map(p => ({
      id: p.id,
      username: p.username,
      x: p.x, y: p.y, z: p.z
    }));
    
    ws.send(JSON.stringify({
      type: 'admin_update',
      players: playerList
    }));
  },

  // 로그인 처리
  login: (ws, data) => {
    const { username, version } = data;
    
    if (version !== '1.12.2') {
      ws.send(JSON.stringify({
        type: 'error',
        message: '1.12.2 버전만 지원됩니다'
      }));
      return;
    }

    const playerId = uuidv4();
    const player = {
      id: playerId,
      username: username,
      ws: ws,
      x: 0, y: 64, z: 0,
      world: 'overworld',
      health: 20,
      food: 20,
      connected: true
    };

    players.set(playerId, player);
    worlds.get('overworld').players.add(playerId);
    ws.playerId = playerId;

    // 로그인 성공 응답
    ws.send(JSON.stringify({
      type: 'login_success',
      playerId: playerId,
      spawn: worlds.get('overworld').spawn
    }));

    // 다른 플레이어들에게 새 플레이어 알림
    broadcastToWorld('overworld', {
      type: 'player_join',
      player: {
        id: playerId,
        username: username,
        x: 0, y: 64, z: 0
      }
    }, playerId);

    // 기존 플레이어 목록 전송
    const existingPlayers = Array.from(worlds.get('overworld').players)
      .filter(id => id !== playerId)
      .map(id => {
        const p = players.get(id);
        return {
          id: p.id,
          username: p.username,
          x: p.x, y: p.y, z: p.z
        };
      });

    ws.send(JSON.stringify({
      type: 'existing_players',
      players: existingPlayers
    }));

    console.log(`플레이어 ${username} (${playerId})가 접속했습니다`);
  },

  // 플레이어 이동
  move: (ws, data) => {
    const player = players.get(ws.playerId);
    if (!player) return;

    player.x = data.x;
    player.y = data.y;
    player.z = data.z;

    // 다른 플레이어들에게 이동 정보 전송
    broadcastToWorld(player.world, {
      type: 'player_move',
      playerId: player.id,
      x: data.x,
      y: data.y,
      z: data.z
    }, player.id);
  },

  // 블록 배치/파괴
  block_action: (ws, data) => {
    const player = players.get(ws.playerId);
    if (!player) return;

    // 다른 플레이어들에게 블록 변경 정보 전송
    broadcastToWorld(player.world, {
      type: 'block_update',
      x: data.x,
      y: data.y,
      z: data.z,
      blockId: data.blockId,
      action: data.action, // 'place' 또는 'break'
      playerId: player.id
    }, player.id);
  },

  // 채팅 메시지
  chat: (ws, data) => {
    const player = players.get(ws.playerId);
    if (!player) return;

    const message = {
      type: 'chat',
      username: player.username,
      message: data.message,
      timestamp: Date.now()
    };

    // 모든 플레이어에게 채팅 메시지 전송
    broadcastToWorld(player.world, message);
    console.log(`[채팅] ${player.username}: ${data.message}`);
  },

  // 핑/퐁 (연결 유지)
  ping: (ws, data) => {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
};

// 월드 내 플레이어들에게 브로드캐스트
function broadcastToWorld(worldName, message, excludePlayerId = null) {
  const world = worlds.get(worldName);
  if (!world) return;

  world.players.forEach(playerId => {
    if (playerId === excludePlayerId) return;
    
    const player = players.get(playerId);
    if (player && player.connected && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  });
  
  // 관리자들에게도 전송
  if (wss) {
    wss.clients.forEach(client => {
      if (client.isAdmin && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
  }
}

// 서버 상태 모니터링
setInterval(() => {
  if (wss && players.size > 0) {
    console.log(`현재 접속자: ${players.size}명`);
  }
}, 60000); // 1분마다

// 비활성 연결 정리
setInterval(() => {
  if (wss) {
    players.forEach((player, playerId) => {
      if (player.ws.readyState !== WebSocket.OPEN) {
        players.delete(playerId);
        worlds.get(player.world).players.delete(playerId);
      }
    });
  }
}, 30000); // 30초마다

console.log('마인크래프트 1.12.2 웹소켓 서버가 준비되었습니다!');
console.log('호스팅 패널에서 서버를 시작할 수 있습니다');

// 서버 시작 시 자동으로 WebSocket 서버도 시작
startWebSocketServer();

// 우아한 종료 처리
process.on('SIGTERM', () => {
  console.log('서버 종료 중...');
  if (wss) {
    players.forEach(player => {
      if (player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: 'server_shutdown',
          message: '서버가 종료됩니다'
        }));
        player.ws.close();
      }
    });
  }
  process.exit(0);
});
