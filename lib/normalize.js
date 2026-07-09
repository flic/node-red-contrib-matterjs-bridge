'use strict';

// Topic-schema helpers for matter:* events emitted into Node-RED flows.
// We do NOT touch values here — that's the responsibility of per-thingtype
// ingress functions in the consumer Thing. This module only deals with
// the canonical msg envelope: msg.topic + msg.payload + msg.matter.

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

module.exports = { attributeToMsg, nodeEventToMsg, aliveToMsg, topicMatches };
