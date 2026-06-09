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
                    const parsed = JSON.parse(raw);
                    dispatchTapped(parsed, emitter);
                }
            } catch (e) {
                // Non-JSON or non-event payloads (command responses etc.) — ignore quietly,
                // they will be handled by the upstream client.
            }
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

    bridge.deviceCommand = (nodeId, endpoint, cluster, command, payload) =>
        client.deviceCommand(nodeId, endpoint, cluster, command, payload);

    bridge.readAttribute = (nodeId, endpoint, cluster, attribute) =>
        client.readAttribute(nodeId, endpoint, cluster, attribute);

    bridge.writeAttribute = (nodeId, endpoint, cluster, attribute, value) =>
        client.writeAttribute(nodeId, endpoint, cluster, attribute, value);

    bridge.commissionWithCode = (code, networkOnly) =>
        client.commissionWithCode(code, networkOnly);

    Object.defineProperty(bridge, 'nodes', { get: () => client.nodes });
    Object.defineProperty(bridge, 'serverInfo', { get: () => client.serverInfo });

    return bridge;
}

module.exports = { createBridge };
