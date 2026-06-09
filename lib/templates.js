'use strict';

const fs = require('fs');
const path = require('path');

const BUNDLED_DIR = path.join(__dirname, '..', 'templates');

function loadFromDir(dir, target, source) {
    let stat;
    try { stat = fs.statSync(dir); } catch (_) { return; }
    if (!stat.isDirectory()) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
        const fp = path.join(dir, f);
        try {
            const tpl = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (!tpl.id) {
                throw new Error(`template ${fp}: missing required 'id' field`);
            }
            if (!tpl.shape) {
                throw new Error(`template ${fp}: missing required 'shape' field`);
            }
            target.set(tpl.id, { ...tpl, _source: source, _path: fp });
        } catch (e) {
            // Surface load errors via console (Node-RED captures it)
            console.warn(`[matter-bridge] failed to load template ${fp}: ${e.message}`);
        }
    }
}

/**
 * Returns a Map of templateId → template object.
 * Bundled templates are loaded first; templates in overrideDir take precedence
 * (override by same id wins).
 */
function loadTemplates(overrideDir) {
    const map = new Map();
    loadFromDir(BUNDLED_DIR, map, 'bundled');
    if (overrideDir) loadFromDir(overrideDir, map, 'override');
    return map;
}

/**
 * Build a shape → templateId lookup from a loaded Map.
 * If two templates declare the same shape, override (loaded later) wins.
 */
function buildShapeIndex(templatesMap) {
    const idx = new Map();
    for (const tpl of templatesMap.values()) {
        idx.set(tpl.shape, tpl.id);
    }
    return idx;
}

module.exports = { loadTemplates, buildShapeIndex, BUNDLED_DIR };
