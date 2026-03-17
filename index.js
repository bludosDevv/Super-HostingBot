'use strict';

const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const config = require('./settings.json');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server: SocketIOServer } = require('socket.io');

let mineflayerViewer = null;
try {
  ({ mineflayer: mineflayerViewer } = require('prismarine-viewer'));
} catch (e) {
  console.log('[Viewer] prismarine-viewer is not installed. Live first-person view is disabled.');
}

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false
};

const viewerState = {
  enabled: Boolean(mineflayerViewer),
  port: Number(process.env.VIEWER_PORT || 3001),
  running: false
};

const remoteControlState = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
  yaw: 0,
  pitch: 0,
  lastInputAt: 0
};

// Health check endpoint for monitoring
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${config.name} Remote Dashboard</title>
      <style>
        :root { color-scheme: dark; --bg:#070b14; --card:#111827; --muted:#94a3b8; --accent:#2dd4bf; }
        * { box-sizing: border-box; }
        body { margin:0; font-family: Inter, Segoe UI, sans-serif; background: radial-gradient(circle at top, #0f172a, var(--bg)); color:#f8fafc; }
        .wrap { max-width: 1150px; margin: 0 auto; padding: 16px; }
        .top { display:grid; gap:10px; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); margin-bottom:14px; }
        .card { background: rgba(17,24,39,.95); border:1px solid #1f2937; border-radius:14px; padding:12px 14px; }
        .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
        .value { color:var(--accent); font-weight:700; font-size:18px; margin-top:6px; }
        .viewer { border-radius: 14px; overflow: hidden; border:1px solid #1f2937; background:#000; min-height: 320px; }
        .viewer iframe { width:100%; height:min(65vh,700px); border:0; }
        .viewer-fallback { padding: 20px; color: #cbd5e1; }
        .controls { margin-top: 12px; display:flex; gap:10px; flex-wrap:wrap; }
        button { background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:10px; padding:10px 12px; cursor:pointer; }
        .mobile-controls { margin-top: 16px; display:none; justify-content:space-between; align-items:flex-end; gap:16px; }
        .stick { width:130px; height:130px; border-radius:50%; background:#0f172a; border:1px solid #334155; position:relative; touch-action:none; }
        .knob { width:52px; height:52px; border-radius:50%; background:var(--accent); position:absolute; left:39px; top:39px; opacity:.9; }
        .hint { margin-top:8px; color:var(--muted); font-size:13px; }
        @media (max-width: 900px) {
          .mobile-controls { display:flex; }
          .hint-desktop { display:none; }
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h2>🎮 ${config.name} - Live Control</h2>
        <div class="top">
          <div class="card"><div class="label">Status</div><div id="status" class="value">Connecting...</div></div>
          <div class="card"><div class="label">Uptime</div><div id="uptime" class="value">0h 0m 0s</div></div>
          <div class="card"><div class="label">Coords</div><div id="coords" class="value">-</div></div>
          <div class="card"><div class="label">Server</div><div class="value">${config.server.ip}:${config.server.port}</div></div>
        </div>

        <div class="viewer" id="viewer">
          <iframe id="viewer-frame" src="/viewer" allowfullscreen></iframe>
        </div>

        <div class="controls">
          <button id="jump-btn">Jump</button>
          <button id="sneak-btn">Sneak</button>
          <button id="sprint-btn">Sprint</button>
          <a href="/tutorial"><button>Setup Guide</button></a>
        </div>

        <div class="hint hint-desktop">PC: Click the page then use WASD + Space + Shift. Move mouse to look around.</div>
        <div class="hint">Mobile: use left joystick to move and right joystick to look around.</div>

        <div class="mobile-controls">
          <div>
            <div class="stick" id="move-stick"><div class="knob" id="move-knob"></div></div>
            <div class="hint">Move</div>
          </div>
          <div>
            <div class="stick" id="look-stick"><div class="knob" id="look-knob"></div></div>
            <div class="hint">Look</div>
          </div>
        </div>
      </div>

      <script src="/socket.io/socket.io.js"></script>
      <script>
        const socket = io();
        const pressed = new Set();
        const statusEl = document.getElementById('status');
        const uptimeEl = document.getElementById('uptime');
        const coordsEl = document.getElementById('coords');

        function fmt(sec){ const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60; return h + 'h ' + m + 'm ' + s + 's'; }
        function sendControls(extra={}) {
          socket.emit('control:update', {
            forward: pressed.has('KeyW'), back: pressed.has('KeyS'), left: pressed.has('KeyA'), right: pressed.has('KeyD'),
            jump: pressed.has('Space'), sprint: pressed.has('ControlLeft') || pressed.has('ControlRight'),
            sneak: pressed.has('ShiftLeft') || pressed.has('ShiftRight'), ...extra
          });
        }

        window.addEventListener('keydown', (e) => { if (!e.repeat) { pressed.add(e.code); sendControls(); } });
        window.addEventListener('keyup', (e) => { pressed.delete(e.code); sendControls(); });
        document.getElementById('jump-btn').addEventListener('pointerdown', ()=>{ pressed.add('Space'); sendControls(); });
        document.getElementById('jump-btn').addEventListener('pointerup', ()=>{ pressed.delete('Space'); sendControls(); });
        document.getElementById('sneak-btn').addEventListener('pointerdown', ()=>{ pressed.add('ShiftLeft'); sendControls(); });
        document.getElementById('sneak-btn').addEventListener('pointerup', ()=>{ pressed.delete('ShiftLeft'); sendControls(); });
        document.getElementById('sprint-btn').addEventListener('pointerdown', ()=>{ pressed.add('ControlLeft'); sendControls(); });
        document.getElementById('sprint-btn').addEventListener('pointerup', ()=>{ pressed.delete('ControlLeft'); sendControls(); });

        let mouseCaptured = false;
        document.body.addEventListener('click', async () => {
          if (document.pointerLockElement !== document.body) {
            await document.body.requestPointerLock();
          }
        });
        document.addEventListener('pointerlockchange', () => { mouseCaptured = document.pointerLockElement === document.body; });
        document.addEventListener('mousemove', (e) => {
          if (!mouseCaptured) return;
          socket.emit('control:look', { dx: e.movementX || 0, dy: e.movementY || 0 });
        });

        async function refresh() {
          try {
            const r = await fetch('/health');
            const d = await r.json();
            statusEl.textContent = d.status === 'connected' ? 'Online' : 'Reconnecting';
            uptimeEl.textContent = fmt(d.uptime);
            coordsEl.textContent = d.coords ? (Math.floor(d.coords.x) + ', ' + Math.floor(d.coords.y) + ', ' + Math.floor(d.coords.z)) : '-';
            const frame = document.getElementById('viewer-frame');
            if (d.viewer && d.viewer.running && frame.getAttribute('src') !== '/viewer') frame.setAttribute('src', '/viewer');
          } catch (_) {}
        }
        setInterval(refresh, 2500); refresh();

        function bindStick(stickId, knobId, handler){
          const stick = document.getElementById(stickId); const knob = document.getElementById(knobId);
          const center = {x:65,y:65}; const max = 38; let active = false;
          const setPos=(x,y)=>{ knob.style.left=(center.x+x-26)+'px'; knob.style.top=(center.y+y-26)+'px'; };
          const onMove=(clientX,clientY)=>{
            const rect=stick.getBoundingClientRect(); let dx=clientX-(rect.left+center.x); let dy=clientY-(rect.top+center.y);
            const dist=Math.hypot(dx,dy); if(dist>max){ dx=(dx/dist)*max; dy=(dy/dist)*max; }
            setPos(dx,dy); handler(dx/max,dy/max);
          };
          const reset=()=>{ setPos(0,0); handler(0,0); active=false; };
          stick.addEventListener('pointerdown',(e)=>{ active=true; stick.setPointerCapture(e.pointerId); onMove(e.clientX,e.clientY); });
          stick.addEventListener('pointermove',(e)=>{ if(active) onMove(e.clientX,e.clientY); });
          stick.addEventListener('pointerup',reset); stick.addEventListener('pointercancel',reset);
          setPos(0,0);
        }

        bindStick('move-stick','move-knob',(x,y)=>{
          socket.emit('control:update',{ forward:y < -0.25, back:y > 0.25, left:x < -0.25, right:x > 0.25 });
        });
        bindStick('look-stick','look-knob',(x,y)=>{ socket.emit('control:look',{ dx:x*8, dy:y*8 }); });
      </script>
    </body>
  </html>`);
});

app.get('/viewer', (req, res) => {
  if (!viewerState.enabled) {
    return res.status(200).send('<h3 style="font-family:sans-serif">Viewer dependency missing. Run npm install and restart.</h3>');
  }
  if (!viewerState.running) {
    return res.status(200).send('<h3 style="font-family:sans-serif">Viewer will start after the bot joins the server.</h3>');
  }
  return res.redirect(`http://${req.hostname}:${viewerState.port}/`);
});

app.get('/tutorial', (req, res) => {
  res.send(`
  < html >
      <head>
        <title>${config.name} - Setup Guide</title>
        <style>
          body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #cbd5e1; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.6; }
          h1, h2 { color: #2dd4bf; }
          h1 { border-bottom: 2px solid #334155; padding-bottom: 10px; }
          .card { background: #1e293b; padding: 25px; border-radius: 12px; margin-bottom: 20px; border: 1px solid #334155; }
          a { color: #38bdf8; text-decoration: none; }
          code { background: #334155; padding: 2px 6px; border-radius: 4px; color: #e2e8f0; font-family: monospace; }
          .btn-home { display: inline-block; margin-bottom: 20px; padding: 8px 16px; background: #334155; color: white; border-radius: 6px; text-decoration: none; }
        </style>
      </head>
      <body>
        <a href="/" class="btn-home">Back to Dashboard</a>
        <h1>Setup Guide (Under 15 Minutes)</h1>
        <div class="card">
          <h2>Step 1: Configure Aternos</h2>
          <ol>
            <li>Go to <strong>Aternos</strong>.</li>
            <li>Install <strong>Paper/Bukkit</strong> software.</li>
            <li>Enable <strong>Cracked</strong> mode (Green Switch).</li>
            <li>Install Plugins: <code>ViaVersion</code>, <code>ViaBackwards</code>, <code>ViaRewind</code>.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Step 2: GitHub Setup</h2>
          <ol>
            <li>Download this code as ZIP and extract.</li>
            <li>Edit <code>settings.json</code> with your IP/Port.</li>
            <li>Upload all files to a new <strong>GitHub Repository</strong>.</li>
          </ol>
        </div>
        <div class="card">
          <h2>Step 3: Render (Free 24/7 Hosting)</h2>
          <ol>
            <li>Go to <a href="https://render.com" target="_blank">Render.com</a> and create a Web Service.</li>
            <li>Connect your GitHub.</li>
            <li>Build Command: <code>npm install</code></li>
            <li>Start Command: <code>npm start</code></li>
            <li><strong>Magic:</strong> The bot automatically pings itself to stay awake!</li>
          </ol>
        </div>
        <p style="text-align: center; margin-top: 40px; color: #64748b;">AFK Bot Dashboard</p>
      </body>
    </html >
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    viewer: {
      enabled: viewerState.enabled,
      running: viewerState.running,
      port: viewerState.port
    },
    remoteControl: {
      active: remoteControlActive(),
      users: io ? io.engine.clientsCount : 0
    }
  });
});

app.get('/ping', (req, res) => res.send('pong'));

// FIX: handle port conflict gracefully - try next port if taken
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server started on port ${server.address().port} `);
});

const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

io.on('connection', (socket) => {
  socket.on('control:update', (payload = {}) => {
    remoteControlState.forward = Boolean(payload.forward);
    remoteControlState.back = Boolean(payload.back);
    remoteControlState.left = Boolean(payload.left);
    remoteControlState.right = Boolean(payload.right);
    remoteControlState.jump = Boolean(payload.jump);
    remoteControlState.sprint = Boolean(payload.sprint);
    remoteControlState.sneak = Boolean(payload.sneak);
    remoteControlState.lastInputAt = Date.now();
    applyRemoteControls();
  });

  socket.on('control:look', (payload = {}) => {
    const dx = Number(payload.dx) || 0;
    const dy = Number(payload.dy) || 0;
    remoteControlState.yaw += dx * 0.0022;
    remoteControlState.pitch += dy * 0.0022;
    const maxPitch = Math.PI / 2 - 0.01;
    remoteControlState.pitch = Math.max(-maxPitch, Math.min(maxPitch, remoteControlState.pitch));
    remoteControlState.lastInputAt = Date.now();
    applyRemoteControls();
  });

  socket.on('disconnect', () => {
    if (io.engine.clientsCount === 0) {
      resetRemoteControls();
    }
  });
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallbackPort = PORT + 1;
    console.log(`[Server] Port ${PORT} in use - trying port ${fallbackPort} `);
    server.listen(fallbackPort, '0.0.0.0');
  } else {
    console.log(`[Server] HTTP server error: ${err.message} `);
  }
});


function remoteControlActive() {
  return Date.now() - remoteControlState.lastInputAt < 6000;
}

function resetRemoteControls() {
  remoteControlState.forward = false;
  remoteControlState.back = false;
  remoteControlState.left = false;
  remoteControlState.right = false;
  remoteControlState.jump = false;
  remoteControlState.sprint = false;
  remoteControlState.sneak = false;
  remoteControlState.lastInputAt = 0;
  applyRemoteControls();
}

function applyRemoteControls() {
  if (!bot || !botState.connected || typeof bot.setControlState !== 'function') return;
  try {
    bot.setControlState('forward', remoteControlState.forward);
    bot.setControlState('back', remoteControlState.back);
    bot.setControlState('left', remoteControlState.left);
    bot.setControlState('right', remoteControlState.right);
    bot.setControlState('jump', remoteControlState.jump);
    bot.setControlState('sprint', remoteControlState.sprint);
    bot.setControlState('sneak', remoteControlState.sneak);

    if (remoteControlActive()) {
      bot.look(remoteControlState.yaw, remoteControlState.pitch, true);
      botState.lastActivity = Date.now();
    }
  } catch (e) {
    console.log('[RemoteControl] Error applying controls:', e.message);
  }
}

function startViewerIfEnabled() {
  if (!mineflayerViewer || viewerState.running || !bot) return;
  try {
    mineflayerViewer(bot, {
      port: viewerState.port,
      firstPerson: true,
      viewDistance: 6
    });
    viewerState.running = true;
    console.log(`[Viewer] First-person viewer started on port ${viewerState.port}`);
  } catch (e) {
    console.log(`[Viewer] Failed to start viewer: ${e.message}`);
  }
}

// FIX: only one definition of formatUptime
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s} s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// FIX: only ping if RENDER_EXTERNAL_URL is set (skip useless localhost ping)
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    console.log('[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled (running locally)');
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith('https') ? https : http;
    protocol.get(`${renderUrl}/ping`, (res) => {
      // Silent success
    }).on('error', (err) => {
      console.log(`[KeepAlive] Self-ping failed: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);
  console.log('[KeepAlive] Self-ping system started (every 10 min)');
}

startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  console.log(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT CREATION WITH RECONNECTION LOGIC
// ============================================================
// ============================================================
// RECONNECTION & TIMEOUT MANAGEMENT
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

// FIX: Discord rate limiting - track last send time
let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000; // min 5s between webhook calls

function clearAllIntervals() {
  console.log(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    console.log(`[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`);
    return throttleDelay;
  }

  // FIX: read auto-reconnect-delay from settings as base delay
  const baseDelay = config.utils['auto-reconnect-delay'] || 3000;
  const maxDelay = config.utils['max-reconnect-delay'] || 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

function createBot() {
  if (isReconnecting) {
    console.log('[Bot] Already reconnecting, skipping...');
    return;
  }

  // Cleanup previous bot properly to avoid ghost bots
  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      console.log('[Cleanup] Error ending previous bot:', e.message);
    }
    bot = null;
  }

  console.log(`[Bot] Creating bot instance...`);
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    // FIX: use version:false to auto-detect server version so the bot can join any server.
    // If the user explicitly sets a version in settings.json it is still respected.
    const botVersion = config.server.version && config.server.version.trim() !== '' ? config.server.version : false;
    bot = mineflayer.createBot({
      username: config['bot-account'].username,
      password: config['bot-account'].password || undefined,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000
    });

    bot.loadPlugin(pathfinder);

    // FIX: connection timeout - end the old bot before reconnecting to avoid ghost bots
    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received');
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) { /* ignore */ }
        bot = null;
        scheduleReconnect();
      }
    }, 150000); // 150s - Aternos servers can take 90-120s to finish spawning a player

    // FIX: guard against spawn firing twice (can happen on some servers)
    let spawnHandled = false;

    bot.once('spawn', () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      console.log(`[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`);
      if (config.discord && config.discord.events && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      // FIX: use bot.version (auto-detected) instead of config value so minecraft-data always matches
      const mcData = require('minecraft-data')(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove);
      startViewerIfEnabled();
      remoteControlState.yaw = bot.entity.yaw || 0;
      remoteControlState.pitch = bot.entity.pitch || 0;
      addInterval(() => {
        if (remoteControlActive()) {
          applyRemoteControls();
        }
      }, 90);

      // Attempt creative mode (only works if bot has OP and enabled in settings)
      setTimeout(() => {
        if (bot && botState.connected && config.server['try-creative']) {
          bot.chat('/gamemode creative');
          console.log('[INFO] Attempted to set creative mode (requires OP)');
        }
      }, 3000);

      bot.on('messagestr', (message) => {
        if (
          message.includes('commands.gamemode.success.self') ||
          message.includes('Set own game mode to Creative Mode')
        ) {
          console.log('[INFO] Bot is now in Creative Mode.');
        }
      });
    });

    // FIX: 'kicked' fires before 'end'. Remove the scheduleReconnect from 'kicked'
    // so that 'end' is the single source of reconnect truth, preventing double-trigger.
    bot.on('kicked', (reason) => {
      // FIX: stringify reason if it's an object to make it readable in logs
      const kickReason = typeof reason === 'object' ? JSON.stringify(reason) : reason;
      console.log(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      botState.errors.push({ type: 'kicked', reason: kickReason, time: Date.now() });
      clearAllIntervals();
      resetRemoteControls();

      const reasonStr = String(kickReason).toLowerCase();
      if (reasonStr.includes('throttl') || reasonStr.includes('wait before reconnect') || reasonStr.includes('too fast')) {
        console.log('[Bot] Throttle kick detected - will use extended reconnect delay');
        botState.wasThrottled = true;
      }

      if (config.discord && config.discord.events && config.discord.events.disconnect) {
        sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
      }
      // NOTE: do NOT call scheduleReconnect() here - 'end' will fire right after 'kicked' and handle it
    });

    // FIX: 'end' is the single reconnect trigger
    bot.on('end', (reason) => {
      console.log(`[Bot] Disconnected: ${reason || 'Unknown reason'}`);
      botState.connected = false;
      clearAllIntervals();
      resetRemoteControls();
      spawnHandled = false; // reset for next connection

      if (config.discord && config.discord.events && config.discord.events.disconnect) {
        sendDiscordWebhook(`[-] **Disconnected**: ${reason || 'Unknown'}`, 0xf87171);
      }

      // ALWAYS reconnect — bot must never leave the server
      scheduleReconnect();
    });

    bot.on('error', (err) => {
      const msg = err.message || '';
      console.log(`[Bot] Error: ${msg}`);
      botState.errors.push({ type: 'error', message: msg, time: Date.now() });
      // Don't reconnect on error - let 'end' event handle it
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();

  // FIX: don't stack reconnect if already waiting
  if (isReconnecting) {
    console.log('[Bot] Reconnect already scheduled, skipping duplicate.');
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  console.log('[Modules] Initializing all modules...');

  // ---------- AUTO AUTH (REACTIVE) ----------
  if (config.utils['auto-auth'] && config.utils['auto-auth'].enabled) {
    const password = config.utils['auto-auth'].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === 'register') {
        bot.chat(`/register ${password} ${password}`);
        console.log('[Auth] Detected register prompt - sent /register');
      } else {
        bot.chat(`/login ${password}`);
        console.log('[Auth] Detected login prompt - sent /login');
      }
    };

    bot.on('messagestr', (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (msg.includes('/register') || msg.includes('register ') || msg.includes('지정된 비밀번호')) {
        tryAuth('register');
      } else if (msg.includes('/login') || msg.includes('login ') || msg.includes('로그인')) {
        tryAuth('login');
      }
    });

    // Failsafe: if no prompt after 10s, try login anyway
    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        console.log('[Auth] No prompt detected after 10s, sending /login as failsafe');
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  // ---------- CHAT MESSAGES ----------
  if (config.utils['chat-messages'] && config.utils['chat-messages'].enabled) {
    const messages = config.utils['chat-messages'].messages;
    if (config.utils['chat-messages'].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils['chat-messages']['repeat-delay'] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => { if (bot && botState.connected) bot.chat(msg); }, idx * 1000);
      });
    }
  }

  // ---------- MOVE TO POSITION ----------
  // FIX: only use position goal if circle-walk is NOT enabled (they fight over pathfinder)
  if (config.position && config.position.enabled && !(config.movement && config.movement['circle-walk'] && config.movement['circle-walk'].enabled)) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    console.log('[Position] Navigating to configured position...');
  }

  // ---------- ANTI-AFK ----------
  if (config.utils['anti-afk'] && config.utils['anti-afk'].enabled) {
    // Arm swinging
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.swingArm(); } catch (e) { }
    }, 10000 + Math.floor(Math.random() * 50000));

    // Hotbar cycling
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try {
        const slot = Math.floor(Math.random() * 9);
        bot.setQuickBarSlot(slot);
      } catch (e) { }
    }, 30000 + Math.floor(Math.random() * 90000));

    // Teabagging
    addInterval(() => {
      if (!bot || !botState.connected || typeof bot.setControlState !== 'function') return;
      if (Math.random() > 0.9) {
        let count = 2 + Math.floor(Math.random() * 4);
        const doTeabag = () => {
          if (count <= 0 || !bot || typeof bot.setControlState !== 'function') return;
          try {
            bot.setControlState('sneak', true);
            setTimeout(() => {
              if (bot && typeof bot.setControlState === 'function') bot.setControlState('sneak', false);
              count--;
              setTimeout(doTeabag, 150);
            }, 150);
          } catch (e) { }
        };
        doTeabag();
      }
    }, 120000 + Math.floor(Math.random() * 180000));

    // FIX: micro-walk only when circle-walk is NOT running, to avoid interrupting pathfinder
    if (!(config.movement && config.movement['circle-walk'] && config.movement['circle-walk'].enabled)) {
      addInterval(() => {
        if (!bot || !botState.connected || typeof bot.setControlState !== 'function') return;
        try {
          const yaw = Math.random() * Math.PI * 2;
          bot.look(yaw, 0, true);
          bot.setControlState('forward', true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === 'function') bot.setControlState('forward', false);
          }, 500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) {
          console.log('[AntiAFK] Walk error:', e.message);
        }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (config.utils['anti-afk'].sneak) {
      try {
        if (typeof bot.setControlState === 'function') bot.setControlState('sneak', true);
      } catch (e) { }
    }
  }

  // ---------- MOVEMENT MODULES ----------
  // FIX: check top-level movement.enabled flag
  if (config.movement && config.movement.enabled !== false) {
    // FIX: circle-walk and random-jump both jump - only run one jumping mechanism
    // random-jump is skipped if anti-afk jump is handled elsewhere; we only use random-jump here
    if (config.movement['circle-walk'] && config.movement['circle-walk'].enabled) {
      startCircleWalk(bot, defaultMove);
    }
    // FIX: only run random-jump if circle-walk is NOT running (circle-walk also keeps bot moving)
    if (config.movement['random-jump'] && config.movement['random-jump'].enabled && !(config.movement['circle-walk'] && config.movement['circle-walk'].enabled)) {
      startRandomJump(bot);
    }
    if (config.movement['look-around'] && config.movement['look-around'].enabled) {
      startLookAround(bot);
    }
  }

  // ---------- CUSTOM MODULES ----------
  // FIX: avoidMobs AND combatModule conflict - if combat is enabled, don't run avoidMobs at the same time
  if (config.modules.avoidMobs && !config.modules.combat) {
    avoidMobs(bot);
  }
  if (config.modules.combat) {
    combatModule(bot, mcData);
  }
  if (config.modules.beds) {
    bedModule(bot, mcData);
  }
  if (config.modules.chat) {
    chatModule(bot);
  }

  console.log('[Modules] All modules initialized!');
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement['circle-walk'].radius;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[CircleWalk] Error:', e.message);
    }
  }, config.movement['circle-walk'].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== 'function') return;
    try {
      bot.setControlState('jump', true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === 'function') bot.setControlState('jump', false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[RandomJump] Error:', e.message);
    }
  }, config.movement['random-jump'].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = (Math.random() * Math.PI / 2) - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      console.log('[LookAround] Error:', e.message);
    }
  }, config.movement['look-around'].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================

// Avoid mobs/players
// FIX: e.username only exists on players; use e.name for mobs - now handled properly
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== 'function') return;
    try {
      const entities = Object.values(bot.entities).filter(e =>
        e.type === 'mob' || (e.type === 'player' && e.username !== bot.username)
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState('back', true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === 'function') bot.setControlState('back', false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      console.log('[AvoidMobs] Error:', e.message);
    }
  }, 2000);
}

// Combat module
// FIX: attack cooldown for 1.9+ (600ms minimum between attacks)
// FIX: lock onto a target for multiple ticks instead of randomly switching every tick
// FIX: autoEat - use i.foodPoints directly (mineflayer item property) instead of broken mcData lookup
function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  // FIX: use physicsTick (not the deprecated physicTick)
  bot.on('physicsTick', () => {
    if (!bot || !botState.connected) return;
    if (!config.combat['attack-mobs']) return;

    const now = Date.now();
    // FIX: 1.9+ attack cooldown - respect at least 600ms between swings
    if (now - lastAttackTime < 620) return;

    try {
      // FIX: only pick a new target if current one is gone or lock expired
      if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id] && lockedTarget.position) {
        const dist = bot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      // Pick a new target
      const mobs = Object.values(bot.entities).filter(e =>
        e.type === 'mob' && e.position &&
        bot.entity.position.distanceTo(e.position) < 4
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000; // stick to same mob for 3 seconds
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      console.log('[Combat] Error:', e.message);
    }
  });

  // FIX: autoEat - check foodPoints property on the item directly (works reliably)
  bot.on('health', () => {
    if (!config.combat['auto-eat']) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find(i => i.foodPoints && i.foodPoints > 0);
        if (food) {
          bot.equip(food, 'hand')
            .then(() => bot.consume())
            .catch(e => console.log('[AutoEat] Error:', e.message));
        }
      }
    } catch (e) {
      console.log('[AutoEat] Error:', e.message);
    }
  });
}

// Bed module
// FIX: bot.isSleeping can be stale; use a local isTryingToSleep guard to prevent double-sleep errors
// FIX: place-night was false in default settings - documentation note added
function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds['place-night']) return; // FIX: check flag (was always skipping before)

    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500;

      // FIX: use local guard instead of stale bot.isSleeping
      if (isNight && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: block => block.name.includes('bed'),
          maxDistance: 8
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock);
            console.log('[Bed] Sleeping...');
          } catch (e) {
            // Can't sleep - maybe not night enough or monsters nearby
          } finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      console.log('[Bed] Error:', e.message);
    }
  }, 10000);
}

// Chat module
// FIX: wire up discord.events.chat flag
function chatModule(bot) {
  bot.on('chat', (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      // FIX: send chat events to Discord if enabled
      if (config.discord && config.discord.enabled && config.discord.events && config.discord.events.chat) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes('hello') || lowerMsg.includes('hi')) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith('!tp ')) {
          const target = message.split(' ')[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      console.log('[Chat] Error:', e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  if (!bot || !botState.connected) {
    console.log('[Console] Bot not connected');
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith('say ')) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith('cmd ')) {
    bot.chat('/' + trimmed.slice(4));
  } else if (trimmed === 'status') {
    console.log(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// FIX: use Buffer.byteLength for Content-Length (handles non-ASCII usernames correctly)
// FIX: rate limiting to avoid spam when bot is flapping
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord || !config.discord.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;

  // FIX: Discord rate limiting - skip if sent too recently
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    console.log('[Discord] Rate limited - skipping webhook');
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith('https') ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [{
      description: content,
      color: color,
      timestamp: new Date().toISOString(),
      footer: { text: 'Slobos AFK Bot' }
    }]
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // FIX: use Buffer.byteLength instead of payload.length - handles non-ASCII (e.g. usernames with accents/emoji)
      'Content-Length': Buffer.byteLength(payload, 'utf8')
    }
  };

  const req = protocol.request(options, (res) => {
    // Silent success
  });

  req.on('error', (e) => {
    console.log(`[Discord] Error sending webhook: ${e.message}`);
  });

  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// FIX: guard against uncaughtException stacking reconnects when isReconnecting is already true
// ============================================================
process.on('uncaughtException', (err) => {
  const msg = err.message || 'Unknown';
  console.log(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: 'uncaught', message: msg, time: Date.now() });

  // Cap errors array to prevent memory leak over long uptimes
  if (botState.errors.length > 100) {
    botState.errors = botState.errors.slice(-50);
  }

  const isNetworkError = msg.includes('PartialReadError') || msg.includes('ECONNRESET') ||
    msg.includes('EPIPE') || msg.includes('ETIMEDOUT') || msg.includes('timed out') ||
    msg.includes('write after end') || msg.includes('This socket has been ended');

  if (isNetworkError) {
    console.log('[FATAL] Known network/protocol error - recovering gracefully...');
  }

  // ALWAYS recover — bot must never stay disconnected
  clearAllIntervals();
  botState.connected = false;

  // FIX: reset isReconnecting if it was stuck, then schedule reconnect
  if (isReconnecting) {
    console.log('[FATAL] isReconnecting was stuck - resetting before crash recovery');
    isReconnecting = false;
    // BUG FIX: was referencing non-existent 'reconnectTimeout' — correct name is 'reconnectTimeoutId'
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(() => {
    scheduleReconnect();
  }, isNetworkError ? 5000 : 10000);
});

process.on('unhandledRejection', (reason) => {
  console.log(`[FATAL] Unhandled Rejection: ${reason}`);
  botState.errors.push({ type: 'rejection', message: String(reason), time: Date.now() });
});

process.on('SIGTERM', () => {
  console.log('[System] SIGTERM received — ignoring, bot will stay alive.');
});

process.on('SIGINT', () => {
  console.log('[System] SIGINT received — ignoring, bot will stay alive.');
});

// ============================================================
// START THE BOT
// ============================================================
console.log('='.repeat(50));
console.log('  Minecraft AFK Bot v2.5 - Bug-Fixed Edition');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log(`Version: ${config.server.version}`);
console.log(`Auto-Reconnect: ${config.utils['auto-reconnect'] ? 'Enabled' : 'Disabled'}`);
console.log('='.repeat(50));

createBot();
