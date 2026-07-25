// =============================================================================
// server/server.js
// Express static server + WebSocket bridge for the browser UI.
//   npm run web    →  http://localhost:4317
// =============================================================================
'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createBridge } = require('../core/bridge');
const paths = require('../core/paths');

const PORT = process.env.PORT || 4317;
// Loopback only. The bridge runs git commands against any path on this machine,
// so the UI must not be reachable from the network. This also keeps Windows from
// raising a firewall prompt on first launch.
const HOST = '127.0.0.1';
const FRONTEND = paths.assetDir('frontend');

const app = express();
app.use(express.static(FRONTEND));
// Serve the documentation folder so the in-app Help button can open the guide.
app.use('/docs', express.static(paths.assetDir('docs')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const client = (req && req.socket && req.socket.remoteAddress) || null;
  const bridge = createBridge(send, { transport: 'web', client });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }
    bridge.handle(msg);
  });

  ws.on('close', () => bridge.dispose());
  send({ type: 'hello', transport: 'web' });
});

server.listen(PORT, HOST, () => {
  /* eslint-disable no-console */
  console.log('');
  console.log('  Cherry-Pick Studio (web) running:');
  console.log(`    →  http://localhost:${PORT}`);
  console.log('');
  console.log('  Press Ctrl+C to stop.');
});
