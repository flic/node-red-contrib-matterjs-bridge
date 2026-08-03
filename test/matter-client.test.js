'use strict';

// Opt out of the console.debug filter before the module installs it — tests must not
// mutate the shared console for the rest of the mocha process.
process.env.MATTERJS_WS_DEBUG = '1';

const assert = require('node:assert');
const { EventEmitter } = require('events');
const { tapWebSocket, dispatchTapped } = require('../lib/matter-client');

describe('lib/matter-client dispatchTapped', function () {
    function collect(event) {
        const emitter = new EventEmitter();
        const seen = [];
        emitter.on(event, (e) => seen.push(e));
        return { emitter, seen };
    }

    it('turns attribute_updated frames into attribute_changed with numeric path parts', function () {
        const { emitter, seen } = collect('attribute_changed');
        dispatchTapped({ event: 'attribute_updated', data: [29, '1/6/0', true] }, emitter);
        assert.deepStrictEqual(seen, [{ nodeId: 29, endpoint: 1, cluster: 6, attribute: 0, value: true }]);
    });

    it('ignores malformed attribute_updated frames', function () {
        const { emitter, seen } = collect('attribute_changed');
        dispatchTapped({ event: 'attribute_updated', data: [29, '1/6'] }, emitter);           // short data
        dispatchTapped({ event: 'attribute_updated', data: [29, 'not-a-path', 1] }, emitter); // short path
        dispatchTapped({ event: 'attribute_updated' }, emitter);                              // no data
        assert.deepStrictEqual(seen, []);
    });

    it('passes node_event and node lifecycle frames through', function () {
        const { emitter, seen } = collect('node_event');
        dispatchTapped({ event: 'node_event', data: { node_id: 4 } }, emitter);
        assert.deepStrictEqual(seen, [{ node_id: 4 }]);

        const removed = collect('node_removed');
        dispatchTapped({ event: 'node_removed', data: 4 }, removed.emitter);
        assert.deepStrictEqual(removed.seen, [4]);
    });

    it('emits unknown events as raw_event and skips command responses', function () {
        const { emitter, seen } = collect('raw_event');
        dispatchTapped({ event: 'something_new', data: 1 }, emitter);
        assert.strictEqual(seen.length, 1);
        dispatchTapped({ message_id: '5', result: {} }, emitter);   // command response: no event key
        dispatchTapped(null, emitter);
        assert.strictEqual(seen.length, 1);
    });
});

describe('lib/matter-client tapWebSocket', function () {
    // A WS double exposing only what the tap touches: addEventListener. The registered
    // listener is captured so frames can be fed through the wrapped path.
    function makeWs() {
        const listeners = {};
        return {
            listeners,
            addEventListener(type, listener) { listeners[type] = listener; },
        };
    }

    it('arms the tap flag and re-emits parsed frames before the original listener', function () {
        const emitter = new EventEmitter();
        const ws = tapWebSocket(makeWs(), emitter);
        const order = [];
        emitter.on('attribute_changed', () => order.push('tap'));
        assert.notStrictEqual(emitter._tapArmed, true, 'arming happens at listener registration');
        ws.addEventListener('message', () => order.push('upstream'));
        assert.strictEqual(emitter._tapArmed, true);
        ws.listeners['message']({ data: JSON.stringify({ event: 'attribute_updated', data: [1, '1/6/0', false] }) });
        assert.deepStrictEqual(order, ['tap', 'upstream'], 'side channel first, upstream handler always called');
    });

    it('does not arm on non-message listeners', function () {
        const emitter = new EventEmitter();
        const ws = tapWebSocket(makeWs(), emitter);
        ws.addEventListener('close', () => {});
        assert.notStrictEqual(emitter._tapArmed, true);
    });

    it('surfaces JSON parse failures as error events but still calls upstream', function () {
        const emitter = new EventEmitter();
        const ws = tapWebSocket(makeWs(), emitter);
        const errors = [];
        let upstream = 0;
        emitter.on('error', (e) => errors.push(e));
        ws.addEventListener('message', () => upstream++);
        ws.listeners['message']({ data: '{broken json' });
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(errors[0].source, 'ws_parse');
        assert.strictEqual(upstream, 1);
        // Non-JSON control frames are not errors.
        ws.listeners['message']({ data: 'ping' });
        assert.strictEqual(errors.length, 1);
        assert.strictEqual(upstream, 2);
    });
});
