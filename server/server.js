// =============================================================================
// server/server.js
// Express static server + WebSocket bridge for the browser UI.
//
// Exposes start({port}) rather than listening on require, because the packaged
// desktop app starts this in-process for --web mode and needs to choose the port
// (and be told which one the OS handed out). Running this file directly still
// behaves exactly as before:
//   npm run web    →  http://localhost:4317
// =============================================================================
'use strict';

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { createBridge } = require('../core/bridge');
const paths = require('../core/paths');

const DEFAULT_PORT = 4317;
// Loopback only. The bridge runs git commands against any path on this machine,
// so the UI must not be reachable from the network. This also keeps Windows from
// raising a firewall prompt on first launch.
const HOST = '127.0.0.1';

function buildApp() {
  const app = express();
  app.use(express.static(paths.assetDir('frontend')));
  // Serve the documentation folder so the in-app Help button can open the guide.
  app.use('/docs', express.static(paths.assetDir('docs')));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

function attachBridge(wss) {
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
}

/**
 * Start the web UI.
 * @param {{port?: number}} opts  port 0 asks the OS for any free port.
 * @returns {Promise<{server: http.Server, wss: WebSocketServer, port: number}>}
 *          `port` is the port actually bound, which matters when 0 was requested.
 */
function start({ port } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(buildApp());
    const wss = new WebSocketServer({ server, path: '/ws' });
    attachBridge(wss);

    let settled = false;   // startup finished, one way or the other
    let up = false;        // startup SUCCEEDED — later errors are runtime ones
    const onError = (err) => {
      if (up) {
        /* eslint-disable-next-line no-console */
        console.error(`  Web server error: ${err.message}`);
        return;
      }
      if (settled) return; // the sibling emitter already rejected this failure
      settled = true;
      try { wss.close(); } catch (_) {}
      try { server.close(); } catch (_) {}
      reject(err);
    };
    server.once('error', onError);
    // ws mirrors the http server's 'error' onto ITSELF, so a port clash arrives
    // on both emitters. Without this listener that becomes an unhandled 'error'
    // event, which kills the process instead of rejecting — in the packaged app
    // the --web window would vanish rather than show the problem.
    wss.on('error', onError);

    // Note: `port` may legitimately be 0, so this cannot use `port || DEFAULT`.
    server.listen(port == null ? DEFAULT_PORT : port, HOST, () => {
      settled = true;
      up = true;
      resolve({ server, wss, port: server.address().port });
    });
  });
}

module.exports = { start, HOST, DEFAULT_PORT };

// Direct launch (npm run web / studio.ps1) — unchanged behaviour.
if (require.main === module) {
  const requested = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  start({ port: requested }).then(
    ({ port }) => {
      /* eslint-disable no-console */
      console.log('');
      console.log('  Cherry-Pick Studio (web) running:');
      console.log(`    →  http://localhost:${port}`);
      console.log('');
      console.log('  Press Ctrl+C to stop.');
    },
    (err) => {
      console.error(`  Could not start on port ${requested}: ${err.message}`);
      process.exit(1);
    }
  );
}
