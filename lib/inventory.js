'use strict';

// Builds a flat, human-/machine-friendly inventory of every commissioned Matter node from the
// controller's live node cache. Shared by the matterjsDiscover "inventory" format, the
// controller's admin endpoint + sidebar, and the metadata emission into hal2.

const { computeShape, extractIdentity, extractNetwork } = require('./shape');

/**
 * @param {object} controller  the matterjsController config node (getBridge, getShapeIndex)
 * @param {object} [opts]
 * @param {boolean} [opts.readMissingNetwork]  if a node has no cached 0/51/0, read it on demand
 * @returns {Promise<Array>} per-node inventory entries, sorted by node_id
 */
async function buildInventory(controller, opts = {}) {
    const readMissingNetwork = !!opts.readMissingNetwork;
    const bridge = controller && controller.getBridge && controller.getBridge();
    if (!bridge || !bridge.nodes) return [];
    const shapeIndex = (controller.getShapeIndex && controller.getShapeIndex()) || new Map();
    const nodes = bridge.nodes;

    const out = [];
    for (const key of Object.keys(nodes)) {
        const mn = nodes[key];
        if (!mn) continue;
        // Upstream MatterNode wraps `data` and exposes attributes getter — normalise both shapes.
        const data = mn.data || mn;
        const flat = {
            node_id: data.node_id,
            attributes: data.attributes || mn.attributes || {},
            available: data.available,
            date_commissioned: data.date_commissioned,
        };
        if (typeof flat.node_id !== 'number') continue;

        let net = extractNetwork(flat);
        const hasNetCache = flat.attributes && flat.attributes['0/51/0'] !== undefined;
        if (readMissingNetwork && !hasNetCache && typeof bridge.readAttribute === 'function') {
            try {
                // readAttribute(nodeId, "ep/cluster/attr") -> { "ep/cluster/attr": value }
                const rec = await bridge.readAttribute(flat.node_id, '0/51/0');
                const v = rec && typeof rec === 'object' ? rec['0/51/0'] : rec;
                if (v !== undefined && v !== null) {
                    flat.attributes = Object.assign({}, flat.attributes, { '0/51/0': v });
                    net = extractNetwork(flat);
                }
            } catch (_) { /* per-node read failures are non-fatal */ }
        }

        const ident = extractIdentity(flat);
        const shape = computeShape(flat);
        out.push({
            node_id: flat.node_id,
            vendor: ident.vendorName,
            vendor_id: ident.vendorId,
            product: ident.productName,
            product_label: ident.productLabel,
            part_number: ident.partNumber,
            firmware: ident.firmwareVersion,
            hardware: ident.hardwareVersion,
            serial: ident.serialNumber,
            transport: net.transport,
            ipv6: net.ipv6,
            ipv4: net.ipv4,
            available: flat.available,
            date_commissioned: flat.date_commissioned,
            shape,
            suggested_thingtype: shapeIndex.get(shape) || null,
        });
    }
    out.sort((a, b) => a.node_id - b.node_id);
    return out;
}

/**
 * Human-friendly model string: "Vendor Product (PartNumber)", avoiding vendor/product duplication
 * (e.g. Shelly / "Shelly Dimmer Gen4" -> "Shelly Dimmer Gen4").
 */
function formatModel(entry) {
    const vendor = (entry.vendor || '').trim();
    const product = (entry.product || '').trim() || (entry.product_label || '').trim();
    let label;
    if (!product) label = vendor || `Matter ${entry.node_id}`;
    else if (!vendor) label = product;
    else {
        const firstVendorWord = vendor.split(/\s+/)[0].toLowerCase();
        label = product.toLowerCase().startsWith(firstVendorWord) ? product : `${vendor} ${product}`;
    }
    return entry.part_number ? `${label} (${entry.part_number})` : label;
}

module.exports = { buildInventory, formatModel };
