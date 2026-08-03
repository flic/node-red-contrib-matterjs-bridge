'use strict';

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTemplates, buildShapeIndex } = require('../lib/templates');

describe('lib/templates loadTemplates', function () {
    it('loads every bundled template with the required fields', function () {
        const map = loadTemplates(null);
        assert.ok(map.size > 0, 'bundled templates must load');
        for (const [id, tpl] of map) {
            assert.strictEqual(tpl.id, id);
            assert.ok(tpl.shape, `template ${id} must declare a shape`);
            assert.strictEqual(tpl._source, 'bundled');
        }
    });

    it('lets an override directory win on id collision', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matter-tpl-'));
        try {
            const bundled = loadTemplates(null);
            const someId = bundled.keys().next().value;
            fs.writeFileSync(path.join(dir, 'override.json'),
                JSON.stringify({ id: someId, shape: '(1,999)', name: 'Overridden' }));
            const map = loadTemplates(dir);
            assert.strictEqual(map.get(someId).name, 'Overridden');
            assert.strictEqual(map.get(someId)._source, 'override');
            assert.strictEqual(map.size, bundled.size, 'override replaces, never adds a duplicate');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skips templates missing id or shape without aborting the load', function () {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matter-tpl-'));
        try {
            fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ name: 'no id' }));
            fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ id: 'x_good', shape: '(1,1)' }));
            const map = loadTemplates(dir);
            assert.ok(map.has('x_good'));
            assert.ok(![...map.values()].some(t => t.name === 'no id'));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('lib/templates buildShapeIndex', function () {
    it('maps every declared shape to its template, arrays included', function () {
        const map = new Map([
            ['a', { id: 'a', shape: '(1,266)' }],
            ['b', { id: 'b', shape: ['(1,269)', '(1,269),(2,17)'] }],
        ]);
        const idx = buildShapeIndex(map);
        assert.strictEqual(idx.get('(1,266)'), 'a');
        assert.strictEqual(idx.get('(1,269)'), 'b');
        assert.strictEqual(idx.get('(1,269),(2,17)'), 'b');
    });

    it('later templates win on shape collision (override semantics)', function () {
        const map = new Map([
            ['a', { id: 'a', shape: '(1,266)' }],
            ['b', { id: 'b', shape: '(1,266)' }],
        ]);
        assert.strictEqual(buildShapeIndex(map).get('(1,266)'), 'b');
    });

    it('covers every bundled shape exactly once', function () {
        // Two bundled templates claiming the same shape would silently shadow each other —
        // this pins the invariant so a new template cannot sneak in a collision.
        const templates = loadTemplates(null);
        const seen = new Map();
        for (const tpl of templates.values()) {
            const shapes = Array.isArray(tpl.shape) ? tpl.shape : [tpl.shape];
            for (const s of shapes) {
                assert.ok(!seen.has(s), `shape ${s} declared by both ${seen.get(s)} and ${tpl.id}`);
                seen.set(s, tpl.id);
            }
        }
    });
});
