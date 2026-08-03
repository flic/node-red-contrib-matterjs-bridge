'use strict';

const assert = require('node:assert');
const { buildInventory, formatModel } = require('../lib/inventory');

describe('lib/inventory formatModel', function () {
    it('drops the vendor when the product already leads with it', function () {
        assert.strictEqual(formatModel({ vendor: 'Shelly', product: 'Shelly Dimmer Gen4' }), 'Shelly Dimmer Gen4');
    });

    it('prefixes the vendor otherwise', function () {
        assert.strictEqual(formatModel({ vendor: 'IKEA of Sweden', product: 'TRADFRI bulb' }), 'IKEA of Sweden TRADFRI bulb');
    });

    it('appends the part number in parentheses', function () {
        assert.strictEqual(
            formatModel({ vendor: 'Shelly', product: 'Plug S', part_number: 'S3PL-001' }),
            'Shelly Plug S (S3PL-001)');
    });

    it('falls back to product label, vendor alone, then Matter <id>', function () {
        assert.strictEqual(formatModel({ vendor: '', product: '', product_label: 'Label' }), 'Label');
        assert.strictEqual(formatModel({ vendor: 'Aqara', product: '' }), 'Aqara');
        assert.strictEqual(formatModel({ vendor: '', product: '', node_id: 9 }), 'Matter 9');
    });
});

describe('lib/inventory buildInventory', function () {
    // A minimal controller double: live cache behind getBridge(), shape index for the
    // suggested_thingtype lookup. This is the same surface the real config node exposes.
    function makeController(nodes, opts = {}) {
        return {
            getBridge: () => ({ nodes, readAttribute: opts.readAttribute }),
            getShapeIndex: () => opts.shapeIndex || new Map(),
        };
    }

    const PLUG_ATTRS = {
        '0/40/1': 'Shelly', '0/40/3': 'Plug S', '0/40/10': 7,
        '1/29/0': [{ '0': 266 }],
    };

    it('builds one entry per node, sorted by node_id, with shape and template suggestion', async function () {
        const shapeIndex = new Map([['(1,266)', 'matter_plug']]);
        const inv = await buildInventory(makeController({
            '9': { data: { node_id: 9, attributes: PLUG_ATTRS, available: true } },
            '4': { node_id: 4, attributes: PLUG_ATTRS, available: false },
        }, { shapeIndex }));
        assert.strictEqual(inv.length, 2);
        assert.deepStrictEqual(inv.map(e => e.node_id), [4, 9]);
        assert.strictEqual(inv[1].vendor, 'Shelly');
        assert.strictEqual(inv[1].shape, '(1,266)');
        assert.strictEqual(inv[1].suggested_thingtype, 'matter_plug');
        assert.strictEqual(inv[0].available, false);
    });

    it('reads 0/51/0 on demand when asked and the cache lacks it', async function () {
        const v6 = Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).toString('base64');
        const reads = [];
        const controller = makeController(
            { '4': { node_id: 4, attributes: PLUG_ATTRS, available: true } },
            { readAttribute: async (nodeId, path) => {
                reads.push([nodeId, path]);
                return { '0/51/0': [{ '1': true, '6': [v6], '7': 2 }] };
            } });
        const inv = await buildInventory(controller, { readMissingNetwork: true });
        assert.deepStrictEqual(reads, [[4, '0/51/0']]);
        assert.deepStrictEqual(inv[0].ipv6, ['2001:db8::1']);
        assert.strictEqual(inv[0].transport, 'ethernet');
    });

    it('returns [] without a bridge and survives a failing on-demand read', async function () {
        assert.deepStrictEqual(await buildInventory({ getBridge: () => null }), []);
        const controller = makeController(
            { '4': { node_id: 4, attributes: PLUG_ATTRS, available: true } },
            { readAttribute: async () => { throw new Error('boom'); } });
        const inv = await buildInventory(controller, { readMissingNetwork: true });
        assert.strictEqual(inv.length, 1);
        assert.deepStrictEqual(inv[0].ipv6, []);
    });
});
