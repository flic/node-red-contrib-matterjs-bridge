'use strict';

const { attributeToMsg, nodeEventToMsg, topicMatches } = require('../lib/normalize');
const { buildInventory, formatModel } = require('../lib/inventory');

module.exports = function (RED) {
    function matterjsIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);
        node.format = config.format || 'hal2';
        node.topicFilter = String(config.topicFilter || '').trim();
        node.nodeIdFilter = String(config.nodeIdFilter || '').trim();
        node.errorOutput = !!config.errorOutput;
        // Opt-in: publish per-node metadata (model, ipv6, serial, …) on the reserved hal2
        // `matter/<id>/_meta` topic so downstream hal2 Things surface it. Enable on exactly one
        // matterjs-in feeding the Things. Technology mapping stays here; hal2 stores it generically.
        node.emitMeta = !!config.emitMeta;

        if (!node.controller) {
            node.status({ fill: 'red', shape: 'ring', text: 'no controller' });
            return;
        }

        // Build one synthetic `_meta` message per node (bulk-replace: object payload replaces the
        // whole metadata set on the Thing, so keys that disappear are pruned). Debounced.
        let metaTimer = null;
        function emitMetaNow() {
            metaTimer = null;
            buildInventory(node.controller, { readMissingNetwork: true }).then((inv) => {
                for (const e of inv) {
                    if (node.nodeIdFilter && String(e.node_id) !== node.nodeIdFilter) continue;
                    // hal2 merges this object into the Thing's metadata; null values prune stale
                    // keys (so a device that loses e.g. its IPv4 clears that key on next emit).
                    const meta = {
                        source: 'matter',
                        transport: e.transport || null,
                        model: formatModel(e),
                        vendor: e.vendor || null,
                        product: e.product || null,
                        part_number: e.part_number || null,
                        serial: e.serial || null,
                        firmware: e.firmware || null,
                        hardware: e.hardware || null,
                        ipv6: (e.ipv6 && e.ipv6.length) ? e.ipv6.join(', ') : null,
                        ipv4: (e.ipv4 && e.ipv4.length) ? e.ipv4.join(', ') : null,
                    };
                    const msg = {
                        topic: `matter/${e.node_id}/_meta`,
                        payload: meta,
                        matter: { nodeId: e.node_id, kind: 'meta' },
                    };
                    if (node.errorOutput) node.send([msg, null]); else node.send(msg);
                }
            }).catch(() => { /* non-fatal */ });
        }
        function scheduleMetaEmit(delay) {
            if (!node.emitMeta) return;
            if (metaTimer) return;
            metaTimer = setTimeout(emitMetaNow, delay || 1500);
        }

        function shouldEmit(envelope) {
            if (node.nodeIdFilter && String(envelope.matter.nodeId) !== node.nodeIdFilter) return false;
            if (node.topicFilter && !topicMatches(envelope.topic, node.topicFilter)) return false;
            return true;
        }

        const onAttribute = (ev) => {
            let msg;
            if (node.format === 'raw') {
                msg = { payload: ev };
            } else {
                msg = attributeToMsg(ev);
                if (!shouldEmit(msg)) return;
            }
            if (node.errorOutput) node.send([msg, null]);
            else node.send(msg);
        };

        const onNodeEvent = (ev) => {
            let msg;
            if (node.format === 'raw') {
                msg = { payload: ev };
            } else {
                msg = nodeEventToMsg(ev);
                if (!shouldEmit(msg)) return;
            }
            if (node.errorOutput) node.send([msg, null]);
            else node.send(msg);
        };

        const onStatus = (s) => {
            try { node.status(s); } catch (_) {}
            // Re-publish metadata once the controller (re)connects — cache is freshly populated.
            if (s && s.text === 'connected') scheduleMetaEmit(2500);
        };

        const onNodesChanged = () => scheduleMetaEmit(1500);

        const onError = (errPayload) => {
            if (!node.errorOutput) return;
            const errMsg = {
                topic: 'matter/_error',
                payload: errPayload,
            };
            try { node.send([null, errMsg]); } catch (_) {}
        };

        node.controller.on('matter:attribute', onAttribute);
        node.controller.on('matter:nodeevent', onNodeEvent);
        node.controller.on('matter:status', onStatus);
        node.controller.on('matter:error', onError);
        node.controller.on('matter:node_added', onNodesChanged);
        node.controller.on('matter:node_updated', onNodesChanged);

        node.on('close', function () {
            node.controller.removeListener('matter:attribute', onAttribute);
            node.controller.removeListener('matter:nodeevent', onNodeEvent);
            node.controller.removeListener('matter:status', onStatus);
            node.controller.removeListener('matter:error', onError);
            node.controller.removeListener('matter:node_added', onNodesChanged);
            node.controller.removeListener('matter:node_updated', onNodesChanged);
            if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsIn', matterjsIn);
};
