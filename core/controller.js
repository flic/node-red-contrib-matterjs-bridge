'use strict';

const { createBridge } = require('../lib/matter-client');
const { loadTemplates, buildShapeIndex } = require('../lib/templates');
const { buildInventory } = require('../lib/inventory');
const { unwrapNode } = require('../lib/normalize');

module.exports = function (RED) {
    function matterjsController(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        // Every matterjs-in registers ~7 listeners here; with 10+ in-nodes on one controller the
        // default EventEmitter cap (10 per event name) triggers MaxListenersExceededWarning.
        node.setMaxListeners(0);

        node.name = config.name;
        node.url = config.url || '${MATTER_WS_URL}';
        node.templatesDir = config.templatesDir || '';
        node.polls = Array.isArray(config.polls) ? config.polls : [];
        // Exponential backoff for reconnect (base, factor, cap). Reset on connected.
        const RECONNECT_BASE_MS = 2000;
        const RECONNECT_FACTOR = 2;
        const RECONNECT_CAP_MS = 60000;
        let reconnectDelayMs = RECONNECT_BASE_MS;

        // Resolve env-substitution on url. Supports both whole-string (`${MATTER_WS_URL}`) and
        // inline (`ws://${MATTER_HOST}:5580/ws`) references; unset vars resolve to ''.
        node.resolvedUrl = String(node.url).replace(
            /\$\{([A-Z_][A-Z0-9_]*)\}/gi,
            (_, name) => process.env[name] || ''
        );

        // Load templates synchronously at setup
        try {
            node.templates = loadTemplates(node.templatesDir || null);
            node.shapeIndex = buildShapeIndex(node.templates);
        } catch (e) {
            node.error('Failed to load templates: ' + e.message);
            node.templates = new Map();
            node.shapeIndex = new Map();
        }

        let bridge = null;
        let pollHandles = [];
        let reconnectTimer = null;
        let shuttingDown = false;

        function setStatus(fill, shape, text) {
            try { node.emit('matter:status', { fill, shape, text }); } catch (_) {}
        }

        function emitError(type, err, source) {
            const message = (err && err.message) ? err.message : String(err);
            const payload = {
                type,
                source: source || (err && err.source) || 'controller',
                message,
                ts: new Date().toISOString(),
            };
            try { node.emit('matter:error', payload); } catch (_) {}
            try { node.error(`[${payload.source}] ${message}`); } catch (_) {}
        }

        async function start() {
            if (shuttingDown) return;
            if (!node.resolvedUrl) {
                node.error('No WS URL configured (set in node or via MATTER_WS_URL env)');
                setStatus('red', 'ring', 'no url');
                return;
            }
            try {
                bridge = await createBridge(node.resolvedUrl);
            } catch (e) {
                emitError('bridge_create_failed', e, 'controller');
                setStatus('red', 'ring', 'load failed');
                scheduleReconnect();
                return;
            }
            // The node may have been closed while createBridge was in flight — the close handler
            // saw bridge === null and couldn't stop it, so clean up here instead of leaking the WS.
            if (shuttingDown) {
                try { bridge.stop && bridge.stop(); } catch (_) {}
                bridge = null;
                return;
            }

            // Forward bridge events to Node-RED EventEmitter on this config node
            bridge.on('attribute_changed', (ev) => node.emit('matter:attribute', ev));
            bridge.on('node_event', (ev) => node.emit('matter:nodeevent', ev));
            bridge.on('node_added', (data) => node.emit('matter:node_added', data));
            bridge.on('node_removed', (data) => node.emit('matter:node_removed', data));
            bridge.on('node_updated', (data) => node.emit('matter:node_updated', data));
            bridge.on('nodes_changed', () => node.emit('matter:nodes_changed'));
            bridge.on('server_info', (info) => node.emit('matter:server', info));
            bridge.on('error', (e) => emitError('bridge_error', e, e && e.source));
            bridge.on('connected', () => {
                setStatus('green', 'dot', 'connected');
                // Dedicated lifecycle event — consumers must not have to sniff status text.
                try { node.emit('matter:connected'); } catch (_) {}
                reconnectDelayMs = RECONNECT_BASE_MS; // reset backoff on successful connect
                startPolling();
            });
            bridge.on('disconnected', () => {
                setStatus('yellow', 'ring', 'disconnected');
                stopPolling();
                emitError('disconnected', new Error('WS connection lost'), 'connection');
                scheduleReconnect();
            });

            setStatus('yellow', 'ring', 'connecting');
            try {
                await bridge.start();
            } catch (e) {
                emitError('start_listening_failed', e, 'controller');
                setStatus('red', 'ring', 'connect failed');
                scheduleReconnect();
            }
        }

        function scheduleReconnect() {
            if (shuttingDown) return;
            if (reconnectTimer) return;
            const delay = reconnectDelayMs;
            setStatus('yellow', 'ring', `reconnect in ${Math.round(delay / 1000)}s`);
            node.log(`matterjs controller: scheduling reconnect in ${delay}ms`);
            reconnectTimer = setTimeout(async () => {
                reconnectTimer = null;
                // Detach our listeners before stopping: disconnect() can make the old client emit
                // connection_lost, and a stale 'disconnected' handler would schedule yet another
                // reconnect that tears down the fresh bridge start() is about to create.
                try {
                    if (bridge) {
                        bridge.removeAllListeners();
                        bridge.stop && bridge.stop();
                    }
                } catch (_) {}
                bridge = null;
                await start();
            }, delay);
            // Bump for next attempt, capped
            reconnectDelayMs = Math.min(reconnectDelayMs * RECONNECT_FACTOR, RECONNECT_CAP_MS);
        }

        function startPolling() {
            stopPolling();
            for (const p of node.polls) {
                const cluster = Number(p.cluster);
                const attribute = Number(p.attribute);
                const intervalMs = Number(p.intervalSeconds || 60) * 1000;
                if (!isFinite(cluster) || !isFinite(attribute) || !isFinite(intervalMs) || intervalMs < 5000) {
                    node.warn(`matterjs controller: skipping invalid poll config ${JSON.stringify(p)} (cluster/attribute must be numeric, interval >= 5s)`);
                    continue;
                }
                const scope = String(p.scopeFilter || '').trim();
                const handle = setInterval(() => pollOnce(cluster, attribute, scope), intervalMs);
                pollHandles.push(handle);
            }
        }

        function stopPolling() {
            for (const h of pollHandles) clearInterval(h);
            pollHandles = [];
        }

        async function pollOnce(cluster, attribute, scope) {
            if (!bridge) return;
            const nodes = bridge.nodes || {};
            const epRe = new RegExp(`^(\\d+)/${cluster}/`);
            for (const key of Object.keys(nodes)) {
                const flat = unwrapNode(nodes[key], key);
                if (!flat || !flat.available) continue;
                const nodeId = flat.node_id;
                const attrs = flat.attributes;
                if (scope && String(nodeId) !== scope) continue;
                // Find all endpoints on this node that expose this cluster
                const eps = new Set();
                for (const k of Object.keys(attrs)) {
                    const m = k.match(epRe);
                    if (m) eps.add(Number(m[1]));
                }
                for (const ep of eps) {
                    try {
                        // readAttribute(nodeId, "ep/cluster/attr") -> { "ep/cluster/attr": value }
                        const path = `${ep}/${cluster}/${attribute}`;
                        const rec = await bridge.readAttribute(nodeId, path);
                        const value = (rec && typeof rec === 'object') ? rec[path] : rec;
                        // Synthesise the attribute_changed event for downstream listeners
                        node.emit('matter:attribute', { nodeId, endpoint: ep, cluster, attribute, value });
                    } catch (e) {
                        // Per-attribute polling errors are non-fatal; just log.
                        node.debug(`poll ${nodeId}/${ep}/${cluster}/${attribute} failed: ${e.message}`);
                    }
                }
            }
        }

        // Expose helpers for runtime nodes
        node.getBridge = () => bridge;
        node.getTemplates = () => node.templates;
        node.getShapeIndex = () => node.shapeIndex;

        node.on('close', function (done) {
            shuttingDown = true;
            stopPolling();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            try {
                if (bridge) {
                    bridge.removeAllListeners();
                    bridge.stop && bridge.stop();
                }
            } catch (_) {}
            bridge = null;
            done && done();
        });

        // Kick off async start (non-blocking)
        start().catch(e => node.error('matterjsController start failed: ' + e.message));
    }

    RED.nodes.registerType('matterjsController', matterjsController);

    // Device inventory for the editor sidebar (and ad-hoc inspection). Backs the "Matter Devices"
    // sidebar tab in controller.html. ?readNetwork=true reads 0/51/0 on demand for missing IPv6.
    RED.httpAdmin.get('/matterjs-bridge/:id/inventory', RED.auth.needsPermission('flows.read'), async function (req, res) {
        const controller = RED.nodes.getNode(req.params.id);
        if (!controller || controller.type !== 'matterjsController') {
            res.status(404).json({ error: 'controller not found' });
            return;
        }
        try {
            const inventory = await buildInventory(controller, { readMissingNetwork: req.query.readNetwork === 'true' });
            res.json(inventory);
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
    });
};
