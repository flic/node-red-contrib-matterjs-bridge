'use strict';

const { createBridge } = require('../lib/matter-client');
const { loadTemplates, buildShapeIndex } = require('../lib/templates');

module.exports = function (RED) {
    function matterController(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name;
        node.url = config.url || '${MATTER_WS_URL}';
        node.templatesDir = config.templatesDir || '';
        node.polls = Array.isArray(config.polls) ? config.polls : [];
        node.reconnectDelayMs = 5000;

        // Resolve env-substitution on url
        node.resolvedUrl = (() => {
            const m = String(node.url).match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
            if (m) return process.env[m[1]] || '';
            return node.url;
        })();

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
                node.error('Failed to create matter bridge: ' + e.message);
                setStatus('red', 'ring', 'load failed');
                scheduleReconnect();
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
            bridge.on('error', (e) => node.error('matter bridge error: ' + (e && e.message ? e.message : String(e))));
            bridge.on('connected', () => {
                setStatus('green', 'dot', 'connected');
                startPolling();
            });
            bridge.on('disconnected', () => {
                setStatus('yellow', 'ring', 'disconnected');
                stopPolling();
                scheduleReconnect();
            });

            setStatus('yellow', 'ring', 'connecting');
            try {
                await bridge.start();
            } catch (e) {
                node.error('start_listening failed: ' + e.message);
                setStatus('red', 'ring', 'connect failed');
                scheduleReconnect();
            }
        }

        function scheduleReconnect() {
            if (shuttingDown) return;
            if (reconnectTimer) return;
            reconnectTimer = setTimeout(async () => {
                reconnectTimer = null;
                try { bridge && bridge.stop && bridge.stop(); } catch (_) {}
                bridge = null;
                await start();
            }, node.reconnectDelayMs);
        }

        function startPolling() {
            stopPolling();
            for (const p of node.polls) {
                const cluster = Number(p.cluster);
                const attribute = Number(p.attribute);
                const intervalMs = Number(p.intervalSeconds || 60) * 1000;
                if (!isFinite(cluster) || !isFinite(attribute) || !isFinite(intervalMs) || intervalMs < 5000) continue;
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
            for (const key of Object.keys(nodes)) {
                const matterNode = nodes[key];
                if (!matterNode || !matterNode.available) continue;
                const nodeId = matterNode.node_id || matterNode.data?.node_id || Number(key);
                const attrs = matterNode.attributes || matterNode.data?.attributes || {};
                if (scope && String(nodeId) !== scope) continue;
                // Find all endpoints on this node that expose this cluster
                const eps = new Set();
                for (const k of Object.keys(attrs)) {
                    const m = k.match(new RegExp(`^(\\d+)\\/${cluster}\\/`));
                    if (m) eps.add(Number(m[1]));
                }
                for (const ep of eps) {
                    try {
                        const v = await bridge.readAttribute(nodeId, ep, cluster, attribute);
                        // Synthesise the attribute_changed event for downstream listeners
                        node.emit('matter:attribute', { nodeId, endpoint: ep, cluster, attribute, value: v });
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
            try { bridge && bridge.stop && bridge.stop(); } catch (_) {}
            bridge = null;
            done && done();
        });

        // Kick off async start (non-blocking)
        start().catch(e => node.error('matterController start failed: ' + e.message));
    }

    RED.nodes.registerType('matterController', matterController);
};
