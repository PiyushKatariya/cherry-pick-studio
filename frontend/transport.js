// =============================================================================
// frontend/transport.js
// One API over two transports:
//   - Electron : window.cps (IPC, exposed by preload.js)
//   - Browser  : WebSocket to /ws
// Both deliver responses and streamed events through the same inbound channel.
// =============================================================================
(function () {
  'use strict';

  const handlers = {}; // type -> [cb]
  const pending = {}; // id -> { resolve, reject }
  let seq = 0;
  let rawSend = null;
  let ready = null; // promise resolved once connected

  function dispatch(obj) {
    if (obj.type === 'result') {
      const p = pending[obj.id];
      if (p) {
        delete pending[obj.id];
        if (obj.ok) p.resolve(obj.data);
        else p.reject(new Error(obj.error || 'Request failed'));
      }
      return;
    }
    const list = handlers[obj.type] || [];
    for (const cb of list) cb(obj);
  }

  function on(type, cb) {
    (handlers[type] = handlers[type] || []).push(cb);
  }

  // Fire a command that expects a { type:'result' } reply.
  function request(cmd, params) {
    const id = 'r' + ++seq;
    const msg = Object.assign({ cmd, id }, params || {});
    return new Promise((resolve, reject) => {
      pending[id] = { resolve, reject };
      rawSend(msg);
    });
  }

  // Fire-and-forget (e.g. answering an await).
  function fire(cmd, params) {
    rawSend(Object.assign({ cmd }, params || {}));
  }

  function init() {
    if (ready) return ready;
    if (window.cps && window.cps.isElectron) {
      rawSend = (obj) => window.cps.send(obj);
      window.cps.onEvent(dispatch);
      ready = Promise.resolve('electron');
    } else {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      rawSend = (obj) => ws.send(JSON.stringify(obj));
      ws.addEventListener('message', (ev) => {
        try {
          dispatch(JSON.parse(ev.data));
        } catch (_) {}
      });
      ready = new Promise((resolve) => {
        ws.addEventListener('open', () => resolve('web'));
      });
    }
    return ready;
  }

  async function pickFolder() {
    if (window.cps && window.cps.pickFolder) return window.cps.pickFolder();
    return null; // browser cannot open a native folder picker
  }

  window.Transport = { init, on, request, fire, pickFolder, isElectron: !!(window.cps && window.cps.isElectron) };
})();
