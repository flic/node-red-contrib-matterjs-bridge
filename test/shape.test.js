'use strict';

const assert = require('node:assert');
const { computeShape, extractIdentity, extractNetwork, bytesToIpv6, bytesToIpv4 } = require('../lib/shape');

// Helper: a node whose endpoint carries the given device types (cluster 29 attr 0).
function dtAttr(types) {
    return types.map(t => ({ '0': t }));
}

describe('lib/shape computeShape', function () {
    // These mirror the worked examples in the file header — the shape string is the key
    // the whole template matching stands on, so each documented form gets pinned here.
    it('single-endpoint plug', function () {
        assert.strictEqual(computeShape({ attributes: { '1/29/0': dtAttr([266]) } }), '(1,266)');
    });

    it('plug with inline metering via cluster 144', function () {
        assert.strictEqual(
            computeShape({ attributes: { '1/29/0': dtAttr([266]), '1/144/0': {} } }),
            '(1,266+meter)');
    });

    it('collapses companion DT 1296 on the same endpoint into +meter', function () {
        assert.strictEqual(
            computeShape({ attributes: { '1/29/0': dtAttr([266, 1296]) } }),
            '(1,266+meter)');
    });

    it('keeps a separate electrical-sensor endpoint as its own component', function () {
        assert.strictEqual(
            computeShape({ attributes: { '1/29/0': dtAttr([266]), '2/29/0': dtAttr([1296]) } }),
            '(1,266),(2,1296)');
    });

    it('root-endpoint metering becomes (0,meter)', function () {
        assert.strictEqual(
            computeShape({ attributes: { '0/144/0': 5, '1/29/0': dtAttr([256]) } }),
            '(0,meter),(1,256)');
    });

    it('dual-channel metered plug (two endpoints)', function () {
        assert.strictEqual(
            computeShape({ attributes: {
                '1/29/0': dtAttr([266]), '1/144/0': {},
                '2/29/0': dtAttr([266]), '2/144/0': {},
            } }),
            '(1,266+meter),(2,266+meter)');
    });

    it('excludes auxiliary device types (power source, vendor placeholder)', function () {
        assert.strictEqual(
            computeShape({ attributes: { '1/29/0': dtAttr([266, 17]), '2/29/0': dtAttr([65535]) } }),
            '(1,266)');
    });

    it('sorts endpoints ascending', function () {
        assert.strictEqual(
            computeShape({ attributes: { '2/29/0': dtAttr([775]), '1/29/0': dtAttr([770]) } }),
            '(1,770),(2,775)');
    });

    it('ignores endpoint 0 device types and empty nodes', function () {
        assert.strictEqual(computeShape({ attributes: { '0/29/0': dtAttr([22]) } }), '');
        assert.strictEqual(computeShape({ attributes: {} }), '');
        assert.strictEqual(computeShape(null), '');
    });
});

describe('lib/shape extractIdentity', function () {
    it('reads BasicInformation off the root endpoint and trims strings', function () {
        const ident = extractIdentity({ attributes: {
            '0/40/1': ' Shelly ', '0/40/2': 4926, '0/40/3': 'Plug S Gen3', '0/40/4': 1,
            '0/40/10': 7, '0/40/12': ' S3PL-001 ', '0/40/15': 'abc123',
        } });
        assert.strictEqual(ident.vendorName, 'Shelly');
        assert.strictEqual(ident.vendorId, 4926);
        assert.strictEqual(ident.productName, 'Plug S Gen3');
        assert.strictEqual(ident.partNumber, 'S3PL-001');
        assert.strictEqual(ident.firmwareVersion, 7);
        assert.strictEqual(ident.serialNumber, 'abc123');
    });

    it('yields empty strings for a bare node', function () {
        assert.strictEqual(extractIdentity({ attributes: {} }).vendorName, '');
        assert.strictEqual(extractIdentity(null).productName, '');
    });
});

describe('lib/shape bytesToIpv6 / bytesToIpv4', function () {
    const V6_BYTES = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

    it('formats a byte array with :: compression of the longest zero run', function () {
        assert.strictEqual(bytesToIpv6(V6_BYTES), '2001:db8::1');
    });

    it('compresses an all-zero address to ::', function () {
        assert.strictEqual(bytesToIpv6(new Array(16).fill(0)), '::');
    });

    it('does not compress a single zero group', function () {
        const bytes = [0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
        assert.strictEqual(bytesToIpv6(bytes), '1:0:1:1:1:1:1:1');
    });

    it('accepts base64 (the matterjs-server wire format) and hex strings', function () {
        const b64 = Buffer.from(V6_BYTES).toString('base64');
        assert.strictEqual(bytesToIpv6(b64), '2001:db8::1');
        const hex = Buffer.from(V6_BYTES).toString('hex');
        assert.strictEqual(bytesToIpv6(hex), '2001:db8::1');
    });

    it('returns null for short or unusable input', function () {
        assert.strictEqual(bytesToIpv6([1, 2, 3]), null);
        assert.strictEqual(bytesToIpv6(null), null);
        assert.strictEqual(bytesToIpv6(''), null);
    });

    it('formats IPv4 from bytes and base64', function () {
        assert.strictEqual(bytesToIpv4([192, 168, 1, 10]), '192.168.1.10');
        assert.strictEqual(bytesToIpv4(Buffer.from([10, 0, 0, 7]).toString('base64')), '10.0.0.7');
        assert.strictEqual(bytesToIpv4([1, 2]), null);
    });
});

describe('lib/shape extractNetwork', function () {
    const V6 = Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]).toString('base64');
    const V4 = Buffer.from([192, 168, 1, 20]).toString('base64');

    it('reads addresses and transport from GeneralDiagnostics NetworkInterfaces', function () {
        const net = extractNetwork({ attributes: {
            '0/51/0': [{ '1': true, '5': [V4], '6': [V6], '7': 2 }],
        } });
        assert.deepStrictEqual(net.ipv6, ['2001:db8::1']);
        assert.deepStrictEqual(net.ipv4, ['192.168.1.20']);
        assert.strictEqual(net.transport, 'ethernet');
    });

    it('deduplicates addresses across interfaces', function () {
        const net = extractNetwork({ attributes: {
            '0/51/0': [{ '1': true, '6': [V6], '7': 1 }, { '1': false, '6': [V6] }],
        } });
        assert.deepStrictEqual(net.ipv6, ['2001:db8::1']);
        assert.strictEqual(net.transport, 'wifi');
    });

    it('falls back to diagnostic-cluster presence for transport', function () {
        assert.strictEqual(extractNetwork({ attributes: { '0/53/1': {} } }).transport, 'thread');
        assert.strictEqual(extractNetwork({ attributes: { '0/54/1': {} } }).transport, 'wifi');
        assert.strictEqual(extractNetwork({ attributes: {} }).transport, null);
    });
});
