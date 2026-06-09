'use strict';

const crypto = require('crypto');
const { computeShape, extractIdentity } = require('../lib/shape');

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

module.exports = function (RED) {
    function matterDiscover(config) {
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

        node.on('input', function (msg, send, done) {
            const bridge = node.controller.getBridge();
            if (!bridge || !bridge.nodes) {
                node.status({ fill: 'yellow', shape: 'ring', text: 'no nodes cache' });
                done && done(new Error('matter bridge not ready or empty'));
                return;
            }

            const nodes = bridge.nodes;
            const templates = node.controller.getTemplates();
            const shapeIndex = node.controller.getShapeIndex();

            const ttIds = new Set();
            const output = [];
            const summary = [];
            const skipped = [];

            for (const key of Object.keys(nodes)) {
                const matterNode = nodes[key];
                if (!matterNode) continue;
                // normalise — upstream MatterNode wraps `data` and exposes attributes getter
                const data = matterNode.data || matterNode;
                const matterNodeFlat = {
                    node_id: data.node_id,
                    attributes: data.attributes || matterNode.attributes || {},
                    available: data.available,
                };
                if (typeof matterNodeFlat.node_id !== 'number') continue;
                if (node.filter && String(matterNodeFlat.node_id) !== node.filter) continue;

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

                if (!ttId) {
                    skipped.push({ node_id: matterNodeFlat.node_id, shape, reason: 'no template matches shape' });
                    continue;
                }
                const template = templates.get(ttId);
                if (!template) {
                    skipped.push({ node_id: matterNodeFlat.node_id, shape, reason: 'template not loaded' });
                    continue;
                }

                if (node.format === 'hal2') {
                    if (!ttIds.has(ttId)) {
                        const libIdMap = new Map();
                        output.push(buildThingTypeNode(template, libIdMap));
                        ttIds.add(ttId);
                    }
                    output.push(buildThingNode(matterNodeFlat, template, node.eventHandlerId, shape));
                }
            }

            if (node.format === 'summary') {
                msg.payload = summary;
            } else {
                msg.payload = output;
                msg.summary = summary;
                msg.skipped = skipped;
            }

            node.status({ fill: 'green', shape: 'dot', text: `${summary.length} nodes, ${skipped.length} skipped` });
            send(msg);
            done && done();
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterDiscover', matterDiscover);
};
