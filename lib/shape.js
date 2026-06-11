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
        productLabel: String(attrs['0/40/14'] || '').trim(),
        partNumber: String(attrs['0/40/12'] || '').trim(),
        firmwareVersion: attrs['0/40/10'],
        hardwareVersion: attrs['0/40/8'],
        serialNumber: attrs['0/40/15'],
    };
}

// --- Network address extraction (Matter GeneralDiagnostics, cluster 51) -------------------
// Octet-string attributes are serialised by matterjs-server as base64 strings (verified live on
// NetworkInterfaces 0/51/0, e.g. IPv6 "/VFxmscAAAAAAAD//gDYAA=="). We also accept hex strings,
// byte arrays and {n:byte} maps defensively so a server format change won't break parsing.

function toByteArray(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v.map(Number);
    if (typeof v === 'string') {
        const s = v.trim();
        if (s === '') return null;
        if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
            const out = [];
            for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
            return out;
        }
        try { return Array.from(Buffer.from(s, 'base64')); } catch (_) { return null; }
    }
    if (typeof v === 'object') {
        if (Array.isArray(v.data)) return v.data.map(Number);
        const keys = Object.keys(v);
        if (keys.length && keys.every(k => /^\d+$/.test(k))) {
            return keys.sort((a, b) => Number(a) - Number(b)).map(k => Number(v[k]));
        }
    }
    return null;
}

function bytesToIpv6(v) {
    const b = toByteArray(v);
    if (!b || b.length < 16) return null;
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
    // Compress the longest run (>1) of zero groups to "::".
    let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
    for (let g = 0; g < 8; g++) {
        if (groups[g] === '0') {
            if (curStart < 0) { curStart = g; curLen = 1; } else { curLen++; }
            if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
        } else { curStart = -1; curLen = 0; }
    }
    if (bestLen > 1) {
        const head = groups.slice(0, bestStart).join(':');
        const tail = groups.slice(bestStart + bestLen).join(':');
        return head + '::' + tail;
    }
    return groups.join(':');
}

function bytesToIpv4(v) {
    const b = toByteArray(v);
    if (!b || b.length < 4) return null;
    return b.slice(0, 4).join('.');
}

// Matter InterfaceTypeEnum (GeneralDiagnostics NetworkInterface field 7).
const INTERFACE_TYPE = { 1: 'wifi', 2: 'ethernet', 3: 'cellular', 4: 'thread' };

/**
 * Derive a node's network addresses + transport from GeneralDiagnostics NetworkInterfaces (0/51/0).
 * NetworkInterface struct fields: 1 = IsOperational, 5 = IPv4Addresses, 6 = IPv6Addresses, 7 = Type.
 * Transport falls back to diagnostic-cluster presence (0/53 = Thread, 0/54 = WiFi) when the
 * interface type is unspecified. Returns { ipv6, ipv4, transport } — empty/null when 0/51/0 is absent.
 */
function extractNetwork(matterNode) {
    const attrs = (matterNode && matterNode.attributes) || {};
    const ifaces = attrs['0/51/0'];
    const ipv6 = [], ipv4 = [];
    let transport = null;
    if (Array.isArray(ifaces)) {
        const op = ifaces.find(i => i && i['1'] === true) || ifaces[0];
        if (op && typeof op['7'] === 'number') transport = INTERFACE_TYPE[op['7']] || null;
        for (const iface of ifaces) {
            if (!iface || typeof iface !== 'object') continue;
            const v6 = iface['6'], v4 = iface['5'];
            if (Array.isArray(v6)) for (const a of v6) { const f = bytesToIpv6(a); if (f) ipv6.push(f); }
            if (Array.isArray(v4)) for (const a of v4) { const f = bytesToIpv4(a); if (f) ipv4.push(f); }
        }
    }
    if (!transport) {
        if (Object.keys(attrs).some(k => k.indexOf('0/53/') === 0)) transport = 'thread';
        else if (Object.keys(attrs).some(k => k.indexOf('0/54/') === 0)) transport = 'wifi';
    }
    return { ipv6: [...new Set(ipv6)], ipv4: [...new Set(ipv4)], transport };
}

module.exports = {
    computeShape,
    extractIdentity,
    extractNetwork,
    bytesToIpv6,
    bytesToIpv4,
    AUXILIARY_DEVICE_TYPES,
    METERABLE_DEVICE_TYPES,
};
