'use strict';

const { attributeToMsg, nodeEventToMsg, aliveToMsg, topicMatches, unwrapNode } = require('../lib/normalize');
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

        // Live online/offline propagation: matterjs-server flips a node's `available` and pushes
        // node_updated → nodes_changed. We diff against last-known availability per node and emit an
        // `_alive` message per endpoint only on transition (and once on first sight, to seed hal2 at
        // startup without a manual resync). Mirrors the endpoint enumeration of the discover `resync`.
        const lastAvail = new Map();
        function emitAliveChanges() {
            if (node.format === 'raw') return; // `_alive` is a hal2-format concept
            const b = node.controller.getBridge && node.controller.getBridge();
            if (!b || !b.nodes) return;
            for (const key of Object.keys(b.nodes)) {
                const flat = unwrapNode(b.nodes[key]);
                if (!flat) continue;
                const nodeId = flat.node_id;
                if (node.nodeIdFilter && String(nodeId) !== node.nodeIdFilter) continue;
                const available = !!flat.available;
                if (lastAvail.get(nodeId) === available) continue; // no change
                lastAvail.set(nodeId, available);
                const attrs = flat.attributes;
                const eps = new Set();
                for (const k of Object.keys(attrs)) {
                    const m = k.match(/^(\d+)\/29\/0$/);
                    if (m && Number(m[1]) !== 0) eps.add(Number(m[1]));
                }
                if (!eps.size) eps.add(1); // fallback so offline is still signalled
                for (const ep of eps) {
                    const msg = aliveToMsg(nodeId, ep, available);
                    if (!shouldEmit(msg)) continue;
                    if (node.errorOutput) node.send([msg, null]); else node.send(msg);
                }
            }
        }
        let aliveSeedTimer = null;
        function scheduleAliveSeed(delay) {
            if (aliveSeedTimer) return;
            aliveSeedTimer = setTimeout(() => { aliveSeedTimer = null; emitAliveChanges(); }, delay || 1500);
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
            // Re-publish metadata + re-seed alive state once the controller (re)connects — the
            // cache is freshly populated by startListening (slightly delayed so it has settled).
            if (s && s.text === 'connected') { scheduleMetaEmit(2500); scheduleAliveSeed(1500); }
        };

        const onNodesChanged = () => { scheduleMetaEmit(1500); emitAliveChanges(); };

        // A decommissioned node never flips `available` — it just vanishes from the cache — so
        // signal offline explicitly, or downstream Things stay on their last known state forever.
        const onNodeRemoved = (removed) => {
            const nodeId = (removed && typeof removed === 'object') ? removed.node_id : Number(removed);
            if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) return;
            lastAvail.delete(nodeId);
            if (node.format === 'raw') return; // `_alive` is a hal2-format concept
            // The tap dispatches before the upstream client processes the message, so the cache
            // usually still holds the node — enumerate its endpoints while we can.
            const eps = new Set();
            const b = node.controller.getBridge && node.controller.getBridge();
            const mn = b && b.nodes && (b.nodes[nodeId] || b.nodes[String(nodeId)]);
            const flat = unwrapNode(mn, nodeId);
            if (flat) {
                for (const k of Object.keys(flat.attributes)) {
                    const m = k.match(/^(\d+)\/29\/0$/);
                    if (m && Number(m[1]) !== 0) eps.add(Number(m[1]));
                }
            }
            if (!eps.size) eps.add(1); // fallback so offline is still signalled
            for (const ep of eps) {
                const msg = aliveToMsg(nodeId, ep, false);
                if (!shouldEmit(msg)) continue;
                if (node.errorOutput) node.send([msg, null]); else node.send(msg);
            }
        };

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
        node.controller.on('matter:node_removed', onNodeRemoved);
        node.controller.on('matter:nodes_changed', onNodesChanged);

        // Initial emit: if the controller is already connected when this node starts (e.g. you just
        // redeployed), onStatus('connected') won't fire again — so kick off an emit ourselves once
        // the bridge cache is populated. Alive seeding runs regardless of the metadata opt-in.
        {
            const b = node.controller.getBridge && node.controller.getBridge();
            if (b && b.nodes && Object.keys(b.nodes).length) {
                if (node.emitMeta) scheduleMetaEmit(3000);
                scheduleAliveSeed(2000);
            }
        }

        node.on('close', function () {
            node.controller.removeListener('matter:attribute', onAttribute);
            node.controller.removeListener('matter:nodeevent', onNodeEvent);
            node.controller.removeListener('matter:status', onStatus);
            node.controller.removeListener('matter:error', onError);
            node.controller.removeListener('matter:node_added', onNodesChanged);
            node.controller.removeListener('matter:node_updated', onNodesChanged);
            node.controller.removeListener('matter:node_removed', onNodeRemoved);
            node.controller.removeListener('matter:nodes_changed', onNodesChanged);
            if (metaTimer) { clearTimeout(metaTimer); metaTimer = null; }
            if (aliveSeedTimer) { clearTimeout(aliveSeedTimer); aliveSeedTimer = null; }
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsIn', matterjsIn);
};
