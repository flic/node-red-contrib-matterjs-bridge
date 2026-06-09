'use strict';

// Extracts a canonical "shape" string from a MatterNode's attributes map.
// Used by matterDiscover to match nodes against bundled device templates.
//
// Output examples:
//   "(1,266)"                    — single-endpoint plug
//   "(1,266+meter)"              — plug with metering (cluster 144) inline
//   "(1,266+meter),(2,266+meter)" — dual-channel metered plug (Shelly 2PM Gen3/Gen4)
//   "(1,257+meter)"              — dimmable light with inline metering
//   "(0,meter),(1,256)"          — OnOff light with metering on ROOT endpoint
//   "(1,266),(2,1296)"           — plug + separate electrical-sensor endpoint
//   "(1,770),(2,775)"            — temp + humidity sensor pair
//
// Convention: device types are emitted per endpoint, sorted (ep asc, label asc).
// `+meter` annotation is added when DT 257 or 266 share endpoint with cluster 144
// or DT 1296. The companion DT 1296 is then collapsed into the +meter annotation.

const AUXILIARY_DEVICE_TYPES = new Set([
    17,    // Power Source
    65535, // Vendor-vestigial placeholder (e.g. Sunricher MT-SL-ONOFF endpoint 2)
]);

const METERABLE_DEVICE_TYPES = new Set([
    257,   // Dimmable Light
    266,   // OnOff Plug-in Unit
]);

function computeShape(matterNode) {
    const attrs = (matterNode && matterNode.attributes) || {};

    // Collect non-auxiliary device types per endpoint (Set collapses duplicates)
    const epDts = new Map();
    for (const key of Object.keys(attrs)) {
        const m = key.match(/^(\d+)\/29\/0$/);
        if (!m) continue;
        const ep = Number(m[1]);
        if (ep === 0) continue;
        const dtList = attrs[key];
        if (!Array.isArray(dtList)) continue;
        if (!epDts.has(ep)) epDts.set(ep, new Set());
        for (const dt of dtList) {
            const t = dt && dt['0'];
            if (typeof t !== 'number') continue;
            if (AUXILIARY_DEVICE_TYPES.has(t)) continue;
            epDts.get(ep).add(t);
        }
    }

    const eps = [];
    for (const [ep, types] of epDts) {
        if (types.size === 0) continue;
        const has1296 = types.has(1296);
        const hasCluster144 = attrs[`${ep}/144/0`] !== undefined;
        const mainTypes = [...types].filter(t => t !== 1296);
        if (mainTypes.length === 0 && has1296) {
            // Endpoint endast 1296 (separat metering-endpoint, t.ex. matter_metered_plug)
            eps.push([ep, 1296]);
            continue;
        }
        for (const t of mainTypes) {
            const hasMeter = METERABLE_DEVICE_TYPES.has(t) && (has1296 || hasCluster144);
            eps.push([ep, hasMeter ? `${t}+meter` : t]);
        }
    }

    // Root-endpoint metering (cluster 144 på endpoint 0) blir egen komponent
    if (attrs['0/144/0'] !== undefined) eps.push([0, 'meter']);

    eps.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] - b[0];
        return String(a[1]).localeCompare(String(b[1]));
    });
    return eps.map(([ep, dt]) => `(${ep},${dt})`).join(',');
}

/**
 * Convenience: derive vendor + product from cluster 40 (BasicInformation) on root.
 */
function extractIdentity(matterNode) {
    const attrs = (matterNode && matterNode.attributes) || {};
    return {
        vendorName: String(attrs['0/40/1'] || '').trim(),
        vendorId: attrs['0/40/2'],
        productName: String(attrs['0/40/3'] || '').trim(),
        productId: attrs['0/40/4'],
        firmwareVersion: attrs['0/40/10'],
        hardwareVersion: attrs['0/40/8'],
        serialNumber: attrs['0/40/15'],
    };
}

module.exports = {
    computeShape,
    extractIdentity,
    AUXILIARY_DEVICE_TYPES,
    METERABLE_DEVICE_TYPES,
};
