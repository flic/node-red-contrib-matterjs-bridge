'use strict';

const assert = require('node:assert');
const { unwrapNode, attributeToMsg, nodeEventToMsg, aliveToMsg, topicMatches } = require('../lib/normalize');

describe('lib/normalize unwrapNode', function () {
    // The one place that knows the upstream cache holds either flat objects or
    // MatterNode instances wrapping the same fields under `data`.
    it('passes a flat node object through', function () {
        const flat = unwrapNode({ node_id: 5, attributes: { '1/6/0': true }, available: true, date_commissioned: 'd' });
        assert.deepStrictEqual(flat, { node_id: 5, attributes: { '1/6/0': true }, available: true, date_commissioned: 'd' });
    });

    it('unwraps a MatterNode-style object with fields under data', function () {
        const flat = unwrapNode({ data: { node_id: 7, attributes: { a: 1 }, available: false } });
        assert.strictEqual(flat.node_id, 7);
        assert.deepStrictEqual(flat.attributes, { a: 1 });
        assert.strictEqual(flat.available, false);
    });

    it('falls back to the wrapper attributes getter when data has none', function () {
        const flat = unwrapNode({ data: { node_id: 7, available: true }, attributes: { b: 2 } });
        assert.deepStrictEqual(flat.attributes, { b: 2 });
    });

    it('derives node_id from the cache key when the object carries none', function () {
        assert.strictEqual(unwrapNode({ attributes: {} }, '42').node_id, 42);
        assert.strictEqual(unwrapNode({ attributes: {} }, 42).node_id, 42);
    });

    it('returns null when no usable node id exists', function () {
        assert.strictEqual(unwrapNode(null), null);
        assert.strictEqual(unwrapNode(undefined, '5'), null);
        assert.strictEqual(unwrapNode({ attributes: {} }), null);
        assert.strictEqual(unwrapNode({ attributes: {} }, 'not-a-number'), null);
    });

    it('defaults attributes to an empty object', function () {
        assert.deepStrictEqual(unwrapNode({ node_id: 1 }).attributes, {});
    });
});

describe('lib/normalize message envelopes', function () {
    it('attributeToMsg builds the canonical topic and matter block', function () {
        const msg = attributeToMsg({ nodeId: 29, endpoint: 1, cluster: 6, attribute: 0, value: true });
        assert.strictEqual(msg.topic, 'matter/29/1/6/0');
        assert.strictEqual(msg.payload, true);
        assert.deepStrictEqual(msg.matter, { nodeId: 29, endpoint: 1, cluster: 6, attribute: 0, kind: 'attribute' });
    });

    it('nodeEventToMsg coerces ids to numbers and nests the event payload', function () {
        const msg = nodeEventToMsg({ node_id: '4', endpoint_id: '1', cluster_id: '59', event_id: 2, event_number: 9, timestamp: 't', data: { x: 1 } });
        assert.strictEqual(msg.topic, 'matter/4/1/59/_event/2');
        assert.strictEqual(msg.matter.kind, 'event');
        assert.deepStrictEqual(msg.payload.data, { x: 1 });
    });

    it('aliveToMsg coerces availability to a boolean', function () {
        assert.strictEqual(aliveToMsg(5, 1, undefined).payload, false);
        assert.strictEqual(aliveToMsg(5, 1, 1).payload, true);
        assert.strictEqual(aliveToMsg(5, 1, true).topic, 'matter/5/1/_alive/0');
    });
});

describe('lib/normalize topicMatches', function () {
    it('matches exactly and treats an empty filter as match-all', function () {
        assert.strictEqual(topicMatches('matter/1/1/6/0', 'matter/1/1/6/0'), true);
        assert.strictEqual(topicMatches('anything', ''), true);
        assert.strictEqual(topicMatches('anything', null), true);
    });

    it('+ matches exactly one level', function () {
        assert.strictEqual(topicMatches('matter/1/1/6/0', 'matter/+/1/6/0'), true);
        assert.strictEqual(topicMatches('matter/1/2/6/0', 'matter/+/1/6/0'), false);
        assert.strictEqual(topicMatches('matter/1/1/6', 'matter/+/1/6/0'), false, 'shorter topic must not match');
    });

    it('# is a multi-level wildcard only as the last segment', function () {
        assert.strictEqual(topicMatches('matter/1/1/6/0', 'matter/1/#'), true);
        assert.strictEqual(topicMatches('matter/1', 'matter/#'), true);
        // '#' mid-filter is a literal, per the documented semantics.
        assert.strictEqual(topicMatches('matter/1/1/6/0', 'matter/#/6/0'), false);
    });

    it('requires equal depth when no # is present', function () {
        assert.strictEqual(topicMatches('matter/1/1/6/0/extra', 'matter/1/1/6/0'), false);
    });
});
