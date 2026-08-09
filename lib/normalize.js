'use strict';

// Topic-schema helpers for matter:* events emitted into Node-RED flows.
// We do NOT touch values here — that's the responsibility of per-thingtype
// ingress functions in the consumer Thing. This module only deals with
// the canonical msg envelope: msg.topic + msg.payload + msg.matter.

// The upstream client's node cache holds either flat node objects or MatterNode instances
// that wrap the same fields under `data` (with an `attributes` getter on the wrapper).
// This is THE place that knows about both shapes — every consumer goes through here, so
// the next upstream shape change is a one-line fix instead of a hunt across the nodes.
// `key` is the cache key, used as a node-id fallback when the object carries none.
// Returns null when no usable node id can be derived.
function unwrapNode(mn, key) {
    if (!mn) return null;
    const data = mn.data || mn;
    let nodeId = data.node_id;
    if (typeof nodeId !== 'number' && key !== undefined) {
        const n = Number(key);
        if (Number.isFinite(n)) nodeId = n;
    }
    if (typeof nodeId !== 'number' || !Number.isFinite(nodeId)) return null;
    return {
        node_id: nodeId,
        attributes: data.attributes || mn.attributes || {},
        available: data.available,
        date_commissioned: data.date_commissioned,
    };
}

// The ws-client addresses an attribute with one "endpoint/cluster/attribute" string:
//
//   readAttribute(nodeId, attributePath, timeout)
//   writeAttribute(nodeId, attributePath, value, timeout)
//
// The nodes take the three parts as separate message fields, which is the friendlier shape
// for a flow, so the joining happens here — next to attributeToMsg, which builds the topic
// from the very same three numbers.
function attributePath(endpoint, cluster, attribute) {
    return `${Number(endpoint)}/${Number(cluster)}/${Number(attribute)}`;
}

function attributeToMsg(ev) {
    const { nodeId, endpoint, cluster, attribute, value } = ev;
    return {
        topic: `matter/${nodeId}/${endpoint}/${cluster}/${attribute}`,
        payload: value,
        matter: {
            nodeId,
            endpoint,
            cluster,
            attribute,
            kind: 'attribute',
        },
    };
}

function nodeEventToMsg(ev) {
    const nodeId = Number(ev.node_id);
    const endpoint = Number(ev.endpoint_id);
    const cluster = Number(ev.cluster_id);
    const eventId = ev.event_id;
    return {
        topic: `matter/${nodeId}/${endpoint}/${cluster}/_event/${eventId}`,
        payload: {
            event_id: eventId,
            event_number: ev.event_number,
            timestamp: ev.timestamp,
            data: ev.data || {},
        },
        matter: {
            nodeId,
            endpoint,
            cluster,
            attribute: '_event',
            eventId,
            kind: 'event',
        },
    };
}

function aliveToMsg(nodeId, endpoint, available) {
    return {
        topic: `matter/${nodeId}/${endpoint}/_alive/0`,
        payload: !!available,
        matter: { nodeId, endpoint, cluster: '_alive', attribute: 0, kind: 'alive' },
    };
}

/**
 * Glob match against `matter/...` topics: supports MQTT-style wildcards `+` and `#`.
 * Returns true if topic matches the filter, or filter is empty/null.
 */
function topicMatches(topic, filter) {
    if (!filter) return true;
    if (filter === topic) return true;
    const fp = filter.split('/');
    const tp = topic.split('/');
    for (let i = 0; i < fp.length; i++) {
        // MQTT semantics: '#' is a multi-level wildcard only as the last segment;
        // elsewhere it's a literal.
        if (fp[i] === '#' && i === fp.length - 1) return true;
        if (i >= tp.length) return false;
        if (fp[i] === '+') continue;
        if (fp[i] !== tp[i]) return false;
    }
    return fp.length === tp.length;
}

module.exports = { unwrapNode, attributePath, attributeToMsg, nodeEventToMsg, aliveToMsg, topicMatches };
