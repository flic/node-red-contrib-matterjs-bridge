'use strict';

const crypto = require('crypto');
const { computeShape, extractIdentity } = require('../lib/shape');
const { buildInventory } = require('../lib/inventory');
const { attributeToMsg, aliveToMsg } = require('../lib/normalize');

const VALID_FORMATS = new Set(['hal2', 'summary', 'node', 'inventory', 'resync']);

function genId(prefix) {
    return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function buildThingTypeNode(template, baseLibIdMap) {
    // baseLibIdMap: Map<fnName, generatedId> — shared across items so refs resolve.

    function resolveLibId(library, name) {
        const existing = baseLibIdMap.get(name);
        if (existing) return existing;
        const id = genId('lib');
        baseLibIdMap.set(name, id);
        const fn = library.find(f => f.name === name);
        return fn ? id : null;
    }

    const ingressLib = (template.functions && template.functions.ingress) || [];
    const egressLib = (template.functions && template.functions.egress) || [];

    // Build local library arrays
    const ingressList = ingressLib.map(f => {
        const id = baseLibIdMap.get(f.name) || genId('lib');
        baseLibIdMap.set(f.name, id);
        return { id, name: f.name, fn: f.fn };
    });
    const egressList = egressLib.map(f => {
        const id = baseLibIdMap.get(f.name) || genId('lib');
        baseLibIdMap.set(f.name, id);
        return { id, name: f.name, fn: f.fn };
    });

    // Build items
    const items = (template.items || []).map(it => {
        const ep = it.endpoint;
        const cluster = it.cluster;
        const attr = it.attr;
        const filterValue = it.filterValue || `/${cluster}/${attr}`;
        const matchType = it.filterMatchType || 'StrEnd';
        const ingressId = it.ingress ? resolveLibId(ingressLib, it.ingress) : null;
        const egressId = it.egress ? resolveLibId(egressLib, it.egress) : null;
        const obj = {
            name: it.name,
            id: it.id,
            topicFilters: Array.isArray(it.topicFilters)
                ? it.topicFilters
                : [{ field: 'topic', matchType, value: filterValue }],
            topicFilterMode: it.topicFilterMode || (Array.isArray(it.topicFilters) && it.topicFilters.length > 1 ? 'or' : 'and'),
            topicSuffix: it.egress ? `./${ep}/${cluster}/${attr}` : '',
            type: it.readOnly ? 'status' : 'both',
            haType: it.haType || '',
            ingress: ingressId,
            egress: egressId,
            notes: it.notes || `Endpoint ${ep}, cluster ${cluster} attribute ${attr}`,
            output: '1',
            history: it.history === undefined ? true : !!it.history,
            historyAllUpdates: false,
        };
        if (it.readOnly) obj.readOnly = true;
        return obj;
    });

    // Always add Alive item bound to the controller's synthetic /_alive/0 topic
    const aliveIngressId = resolveLibId(ingressLib, 'Pass-through');
    items.push({
        name: 'Alive',
        id: '1',
        topicFilters: [{ field: 'topic', matchType: 'StrEnd', value: '/_alive/0' }],
        topicFilterMode: 'and',
        topicSuffix: '',
        readOnly: true,
        type: 'status',
        ingress: aliveIngressId,
        egress: '',
    });
    // Make sure Pass-through ends up in the local library if it wasn't already
    if (aliveIngressId && !ingressList.find(f => f.id === aliveIngressId)) {
        ingressList.push({ id: aliveIngressId, name: 'Pass-through', fn: 'return msg.payload;' });
    }

    return {
        id: template.id,
        type: 'hal2ThingType',
        name: template.name,
        contextStore: 'filesystem',
        nodestatus: template.nodestatus || '',
        nodestatusType: 'str',
        statusFn: "return '';",
        items,
        attributes: [],
        ingress: ingressList,
        egress: egressList,
        thingStatus: true,
        thingCommand: true,
        thingOutput: true,
        hbCheck: true,
        hbType: 'lwt',
        hbTTL: '',
        hbLWT: aliveIngressId,
        hbFilters: [{ field: 'topic', matchType: 'StrEnd', value: '/_alive/0' }],
        hbFilterMode: 'and',
        hbFilterVal: '',
        hbFilterType: '',
        hbPropVal: 'payload',
        hbPropType: 'msg',
        filterFunction: '0',
        outputs: '1',
    };
}

function buildThingNode(matterNode, template, eventHandlerId, shape) {
    const nodeId = matterNode.node_id;
    const ident = extractIdentity(matterNode);
    const name = [ident.vendorName, ident.productName].filter(Boolean).join(' ').trim() || `Matter ${nodeId}`;
    return {
        id: `matter_thing_${nodeId}`,
        type: 'hal2Thing',
        eventHandler: eventHandlerId || '',
        thingType: template.id,
        name,
        attributes: [],
        topicFilters: [{ field: 'topic', matchType: 'mqtt', value: `matter/${nodeId}/#` }],
        topicFilter: '',
        topicFilterType: '',
        topicPrefix: `matter/${nodeId}`,
        notes: `Auto-genererad ${new Date().toISOString()}. shape=${shape}.`,
        outputs: 1,
        wires: [[]],
    };
}

function resolveEventHandlerId(RED, explicitId) {
    if (explicitId) return explicitId;
    let found = '';
    try {
        RED.nodes.eachNode(function (n) {
            if (!found && n && n.type === 'hal2EventHandler') found = n.id;
        });
    } catch (_) { /* eachNode unavailable — fall through */ }
    return found;
}

/**
 * Resolve a filter expression to a Matter nodeId string, or null for "match all".
 *  - undefined/null/empty → null (no filter)
 *  - numeric string ("48") → returned as-is
 *  - "last" (case-insensitive) → nodeId with max date_commissioned in bridge cache
 *  - anything else → null + warn
 */
function resolveFilter(node, bridge, raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).trim();
    if (s === '') return null;
    if (/^\d+$/.test(s)) return s;
    if (s.toLowerCase() === 'last') {
        const nodes = bridge && bridge.nodes;
        if (!nodes) return null;
        let bestId = null;
        let bestTs = -Infinity;
        for (const key of Object.keys(nodes)) {
            const data = (nodes[key] && nodes[key].data) || nodes[key];
            if (!data || typeof data.node_id !== 'number') continue;
            const ts = data.date_commissioned ? Date.parse(data.date_commissioned) : NaN;
            if (Number.isFinite(ts) && ts > bestTs) {
                bestTs = ts;
                bestId = String(data.node_id);
            }
        }
        if (bestId == null) {
            node.warn('discover: no commissioned nodes for "last"');
            return null;
        }
        return bestId;
    }
    node.warn('discover: unrecognized filter value: ' + JSON.stringify(raw));
    return null;
}

/**
 * Resolve filter from (msg.nodeId | numeric msg.payload | string msg.payload "last"/"42" | config.filter).
 * Returns { value: string|null, source: 'msg.nodeId'|'msg.payload'|'config'|'none' }.
 */
function pickFilterRaw(node, msg) {
    if (msg.nodeId !== undefined && msg.nodeId !== null && msg.nodeId !== '') {
        return { raw: msg.nodeId, source: 'msg.nodeId' };
    }
    if (typeof msg.payload === 'number' && Number.isFinite(msg.payload)) {
        return { raw: msg.payload, source: 'msg.payload' };
    }
    if (typeof msg.payload === 'string') {
        const s = msg.payload.trim();
        if (/^\d+$/.test(s) || s.toLowerCase() === 'last') {
            return { raw: s, source: 'msg.payload' };
        }
    }
    if (node.filter) return { raw: node.filter, source: 'config' };
    return { raw: null, source: 'none' };
}

module.exports = function (RED) {
    function matterjsDiscover(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);
        node.format = config.format || 'hal2';
        node.eventHandlerId = String(config.eventHandlerId || '').trim();
        node.filter = String(config.filter || '').trim();

        if (!node.controller) {
            node.status({ fill: 'red', shape: 'ring', text: 'no controller' });
            return;
        }

        node.on('input', async function (msg, send, done) {
            const bridge = node.controller.getBridge();
            if (!bridge || !bridge.nodes) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'no nodes cache' });
                done && done(new Error('matter bridge not ready or empty'));
                return;
            }

            // msg-based config overrides (everything except name/controller)
            let effectiveFormat = node.format;
            if (typeof msg.format === 'string' && VALID_FORMATS.has(msg.format)) {
                effectiveFormat = msg.format;
            } else if (msg.format !== undefined) {
                node.warn('discover: ignoring invalid msg.format ' + JSON.stringify(msg.format));
            }

            // Inventory: flat list of every node (vendor/model/part/fw + IPv6). Reuses the shared
            // builder; set msg.readNetwork to read 0/51/0 on demand for nodes missing it in cache.
            if (effectiveFormat === 'inventory') {
                try {
                    const inventory = await buildInventory(node.controller, { readMissingNetwork: !!msg.readNetwork });
                    msg.payload = inventory;
                    node.status({ fill: 'green', shape: 'dot', text: `inventory — ${inventory.length} nodes` });
                    send(msg);
                    done && done();
                } catch (e) {
                    node.status({ fill: 'red', shape: 'ring', text: 'inventory failed' });
                    done && done(e);
                }
                return;
            }

            let effectiveEhConfig = node.eventHandlerId;
            if (typeof msg.eventHandlerId === 'string' && msg.eventHandlerId !== '') {
                effectiveEhConfig = msg.eventHandlerId.trim();
            }

            // Filter (msg.nodeId > msg.payload numeric/"last" > config.filter), supports "last"
            const picked = pickFilterRaw(node, msg);
            const effectiveFilter = resolveFilter(node, bridge, picked.raw);

            // Resync: replay the current node cache as hal2-format messages (alive + attribute
            // values), re-seeding downstream Things. Mirrors the old "inject get_nodes" trick.
            // Honours the node-id filter above; wire this node's output into your Things' stream.
            if (effectiveFormat === 'resync') {
                const replay = [];
                for (const key of Object.keys(bridge.nodes)) {
                    const data = bridge.nodes[key] && (bridge.nodes[key].data || bridge.nodes[key]);
                    if (!data || typeof data.node_id !== 'number') continue;
                    const nodeId = data.node_id;
                    if (effectiveFilter && String(nodeId) !== effectiveFilter) continue;
                    const attrs = data.attributes || {};
                    const available = !!data.available;
                    const eps = new Set();
                    for (const k of Object.keys(attrs)) {
                        const m = k.match(/^(\d+)\/29\/0$/);
                        if (m && Number(m[1]) !== 0) eps.add(Number(m[1]));
                    }
                    for (const ep of eps) replay.push(aliveToMsg(nodeId, ep, available));
                    // Real attribute values — skip global attrs/clusters (>= 0xFFF8: AttributeList etc).
                    for (const k of Object.keys(attrs)) {
                        const m = k.match(/^(\d+)\/(\d+)\/(\d+)$/);
                        if (!m) continue;
                        const cluster = Number(m[2]), attribute = Number(m[3]);
                        if (cluster >= 0xFFF8 || attribute >= 0xFFF8) continue;
                        replay.push(attributeToMsg({ nodeId, endpoint: Number(m[1]), cluster, attribute, value: attrs[k] }));
                    }
                }
                node.status({
                    fill: 'blue', shape: 'dot',
                    text: `resync (${effectiveFilter || 'all'}) — ${replay.length} msgs`,
                });
                send([null, replay]);   // resync events on output 2 (keep them off the result output)
                done && done();
                return;
            }

            const ehId = resolveEventHandlerId(RED, effectiveEhConfig);

            const nodes = bridge.nodes;
            const templates = node.controller.getTemplates();
            const shapeIndex = node.controller.getShapeIndex();

            const ttIds = new Set();
            const output = [];
            const summary = [];
            const skipped = [];
            const rawNodes = [];

            for (const key of Object.keys(nodes)) {
                const matterNode = nodes[key];
                if (!matterNode) continue;
                // normalise — upstream MatterNode wraps `data` and exposes attributes getter
                const data = matterNode.data || matterNode;
                const matterNodeFlat = {
                    node_id: data.node_id,
                    attributes: data.attributes || matterNode.attributes || {},
                    available: data.available,
                    date_commissioned: data.date_commissioned,
                };
                if (typeof matterNodeFlat.node_id !== 'number') continue;
                if (effectiveFilter && String(matterNodeFlat.node_id) !== effectiveFilter) continue;

                const shape = computeShape(matterNodeFlat);
                const ident = extractIdentity(matterNodeFlat);
                const ttId = shapeIndex.get(shape);

                summary.push({
                    node_id: matterNodeFlat.node_id,
                    vendor: ident.vendorName,
                    product: ident.productName,
                    shape,
                    suggested_thingtype: ttId || null,
                });

                if (effectiveFormat === 'node') {
                    rawNodes.push({
                        node_id: matterNodeFlat.node_id,
                        vendor: ident.vendorName,
                        product: ident.productName,
                        firmware: ident.firmwareVersion,
                        hardware: ident.hardwareVersion,
                        serial: ident.serialNumber,
                        shape,
                        suggested_thingtype: ttId || null,
                        available: matterNodeFlat.available,
                        date_commissioned: matterNodeFlat.date_commissioned,
                        attributes: matterNodeFlat.attributes,
                    });
                    continue;
                }

                if (!ttId) {
                    skipped.push({ node_id: matterNodeFlat.node_id, shape, reason: 'no template matches shape' });
                    continue;
                }
                const template = templates.get(ttId);
                if (!template) {
                    skipped.push({ node_id: matterNodeFlat.node_id, shape, reason: 'template not loaded' });
                    continue;
                }

                if (effectiveFormat === 'hal2') {
                    if (!ttIds.has(ttId)) {
                        const libIdMap = new Map();
                        output.push(buildThingTypeNode(template, libIdMap));
                        ttIds.add(ttId);
                    }
                    output.push(buildThingNode(matterNodeFlat, template, ehId, shape));
                }
            }

            if (effectiveFormat === 'summary') {
                msg.payload = summary;
            } else if (effectiveFormat === 'node') {
                msg.payload = rawNodes;
                msg.summary = summary;
            } else {
                msg.payload = output;
                msg.summary = summary;
                msg.skipped = skipped;
            }

            // Status reflects filter resolution (esp. useful for "last")
            const filterDesc = picked.source === 'none'
                ? 'all'
                : (picked.raw === effectiveFilter || String(picked.raw) === effectiveFilter)
                    ? String(effectiveFilter)
                    : `${picked.raw} → ${effectiveFilter || '∅'}`;
            node.status({
                fill: 'green', shape: 'dot',
                text: `${effectiveFormat} (${filterDesc}) — ${summary.length} nodes, ${skipped.length} skipped`,
            });
            send(msg);
            done && done();
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsDiscover', matterjsDiscover);
};
