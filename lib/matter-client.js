'use strict';

// Factory + facade for @matter-server/ws-client.
//
// The upstream MatterClient is ESM-only and fires only generic "nodes_changed"
// events — no per-attribute deltas. We need the per-attribute info to emit
// topic-shaped Node-RED msgs.
//
// Solution: intercept the WebSocket's 'message' listener at registration time
// (via a wrapped WS factory). Each incoming message gets parsed and re-emitted
// as a typed event on our own EventEmitter BEFORE being passed to MatterClient's
// internal handler, so MatterClient's state cache stays intact and we get
// per-attribute deltas as a side channel.

const { EventEmitter } = require('events');

// @matter-server/ws-client (through at least 1.1.0) logs every WS frame and every event via
// console.debug with no off switch, which floods the Node-RED log (especially metered devices).
// Filter out just those two known-noisy prefixes; all other console.debug output is preserved.
// Installed once per process.
(function silenceMatterWsDebug() {
    if (console.__hal2MatterWsDebugFiltered) { return; }
    const orig = (console.debug || console.log).bind(console);
    console.debug = function (first) {
        if (first === 'WebSocket OnMessage' || first === 'Incoming event') { return; }
        return orig.apply(null, arguments);
    };
    console.__hal2MatterWsDebugFiltered = true;
})();

let _matterClientModule = null;

async function loadMatterClientModule() {
    if (_matterClientModule === null) {
        _matterClientModule = await import('@matter-server/ws-client');
    }
    return _matterClientModule;
}

let _wsCtor = null;
async function loadWebSocketCtor() {
    if (_wsCtor) return _wsCtor;
    if (typeof globalThis.WebSocket === 'function') {
        _wsCtor = globalThis.WebSocket;
        return _wsCtor;
    }
    const wsMod = await import('ws');
    _wsCtor = wsMod.WebSocket || wsMod.default;
    return _wsCtor;
}

function tapWebSocket(rawWs, emitter) {
    const origAdd = rawWs.addEventListener.bind(rawWs);
    rawWs.addEventListener = function (type, listener, options) {
        if (type !== 'message') return origAdd(type, listener, options);
        const wrapped = (event) => {
            try {
                const raw = (typeof event.data === 'string')
                    ? event.data
                    : (event.data && typeof event.data.toString === 'function' ? event.data.toString() : null);
                if (raw) {
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch (parseErr) {
                        // Surface as 'error' but only when the payload looks like it was meant
                        // to be an event (starts with `{`). Suppress for empty/control frames.
                        if (raw.trim().startsWith('{')) {
                            emitter.emit('error', Object.assign(new Error('ws parse: ' + parseErr.message), {
                                source: 'ws_parse',
                                preview: String(raw).slice(0, 200),
                            }));
                        }
                        return listener(event);
                    }
                    try {
                        dispatchTapped(parsed, emitter);
                    } catch (dispatchErr) {
                        emitter.emit('error', Object.assign(dispatchErr, { source: 'dispatch' }));
                    }
                }
            } catch (_) { /* unreachable */ }
            return listener(event);
        };
        return origAdd(type, wrapped, options);
    };
    return rawWs;
}

function dispatchTapped(parsed, emitter) {
    if (!parsed || typeof parsed !== 'object') return;
    if (!parsed.event) return; // command response, not an event

    switch (parsed.event) {
        case 'attribute_updated': {
            const data = parsed.data;
            if (!Array.isArray(data) || data.length < 3) return;
            const [nodeId, path, value] = data;
            const parts = String(path).split('/');
            if (parts.length < 3) return;
            const [endpoint, cluster, attribute] = parts;
            emitter.emit('attribute_changed', {
                nodeId,
                endpoint: Number(endpoint),
                cluster: Number(cluster),
                attribute: Number(attribute),
                value,
            });
            return;
        }
        case 'node_event': {
            const d = parsed.data;
            if (!d || typeof d !== 'object') return;
            emitter.emit('node_event', d);
            return;
        }
        case 'node_added':
        case 'node_removed':
        case 'node_updated':
            if (parsed.data) emitter.emit(parsed.event, parsed.data);
            return;
        default:
            emitter.emit('raw_event', parsed);
            return;
    }
}

/**
 * Build a MatterBridge facade — wraps the official MatterClient and exposes:
 *   .start()                 — connect + start_listening
 *   .stop()                  — disconnect
 *   .deviceCommand(...)      — proxy
 *   .readAttribute(...)      — proxy
 *   .writeAttribute(...)     — proxy
 *   .commissionWithCode(...) — proxy
 *   .nodes                   — getter for client.nodes
 *   .serverInfo              — getter for client.serverInfo
 *   .on('attribute_changed', listener)
 *   .on('node_event'|'node_added'|'node_removed'|'node_updated', listener)
 *   .on('connected'|'disconnected'|'server_info', listener)
 *   .on('error', listener)
 *
 * The facade is itself an EventEmitter.
 */
async function createBridge(url) {
    if (typeof url !== 'string' || !url) throw new Error('createBridge: url required');

    const mod = await loadMatterClientModule();
    const MatterClient = mod.MatterClient;
    if (typeof MatterClient !== 'function') {
        throw new Error('Could not load MatterClient from @matter-server/ws-client');
    }
    const WebSocketCtor = await loadWebSocketCtor();

    const bridge = new EventEmitter();
    bridge.url = url;
    bridge._started = false;
    bridge._stopped = false;

    // WS factory taps the message listener for per-attribute deltas
    const wsFactory = (wsUrl) => {
        const rawWs = new WebSocketCtor(wsUrl);
        return tapWebSocket(rawWs, bridge);
    };

    const client = new MatterClient(url, wsFactory);
    bridge._client = client;

    // Forward upstream events
    if (typeof client.addEventListener === 'function') {
        client.addEventListener('nodes_changed', () => bridge.emit('nodes_changed'));
        client.addEventListener('server_info_updated', () => bridge.emit('server_info', client.serverInfo));
        client.addEventListener('connection_lost', () => bridge.emit('disconnected'));
        if (mod.MatterClient && client.addEventListener.length >= 2) {
            // Some versions also expose server_shutdown
            try { client.addEventListener('server_shutdown', () => bridge.emit('disconnected')); } catch (_) {}
        }
    }

    bridge.start = async function () {
        if (bridge._started) return;
        bridge._started = true;
        try {
            await client.startListening();
            bridge.emit('connected');
        } catch (e) {
            bridge._started = false;
            bridge.emit('error', e);
            throw e;
        }
    };

    bridge.stop = function () {
        if (bridge._stopped) return;
        bridge._stopped = true;
        try { client.disconnect && client.disconnect(); } catch (_) {}
    };

    // Wrap each upstream method so any rejection is also broadcast on the bridge
    // (callers still get the rejection — this is an additional side-channel for
    // controller-side logging / matter:error fan-out).
    function wrapCall(source, fn) {
        return async function (...args) {
            try {
                return await fn.apply(client, args);
            } catch (e) {
                try { bridge.emit('error', Object.assign(e, { source })); } catch (_) {}
                throw e;
            }
        };
    }

    bridge.deviceCommand = wrapCall('device_command', client.deviceCommand);
    bridge.readAttribute = wrapCall('read_attribute', client.readAttribute);
    bridge.writeAttribute = wrapCall('write_attribute', client.writeAttribute);
    bridge.commissionWithCode = wrapCall('commission', client.commissionWithCode);

    Object.defineProperty(bridge, 'nodes', { get: () => client.nodes });
    Object.defineProperty(bridge, 'serverInfo', { get: () => client.serverInfo });

    return bridge;
}

module.exports = { createBridge };
