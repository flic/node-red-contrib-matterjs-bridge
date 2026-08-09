'use strict';

const { unwrapNode, attributePath } = require('../lib/normalize');

module.exports = function (RED) {
    function matterjsOut(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);
        node.errorOutput = !!config.errorOutput;

        if (!node.controller) {
            node.status({ fill: 'red', shape: 'ring', text: 'no controller' });
            return;
        }

        // Fail fast on commands to an offline/unknown node, with a descriptive error instead of the
        // matter layer's cryptic timeout. `available` comes from the controller cache, which is
        // seeded authoritatively by start_listening and kept live via node_updated — i.e. the same
        // value matterjs-server reports. Reads are left ungated (diagnostic).
        function assertReachable(bridge, nodeId) {
            const nodes = bridge.nodes || {};
            let flat = unwrapNode(nodes[nodeId] || nodes[String(nodeId)]);
            if (!flat) {
                for (const k of Object.keys(nodes)) {
                    const d = unwrapNode(nodes[k], k);
                    if (d && d.node_id === nodeId) { flat = d; break; }
                }
            }
            if (!flat) {
                const e = new Error(`Matter node ${nodeId} not found in controller cache — command not sent`);
                e.code = 'node_unknown'; e.source = 'matterjsOut'; throw e;
            }
            if (!flat.available) {
                const e = new Error(`Matter node ${nodeId} is offline (unreachable) — command not sent`);
                e.code = 'node_offline'; e.source = 'matterjsOut'; throw e;
            }
        }

        async function execOne(cmd) {
            const bridge = node.controller.getBridge();
            if (!bridge) throw new Error('matter bridge not ready');
            const kind = cmd.kind || 'device_command';

            if (kind === 'device_command') {
                const { nodeId, endpoint, cluster, command, args } = cmd;
                if (nodeId == null || endpoint == null || cluster == null || !command) {
                    throw new Error('device_command missing fields: ' + JSON.stringify(cmd));
                }
                assertReachable(bridge, Number(nodeId));
                return bridge.deviceCommand(Number(nodeId), Number(endpoint), Number(cluster), String(command), args);
            }

            if (kind === 'write_attribute') {
                const { nodeId, endpoint, cluster, attribute, value } = cmd;
                if (nodeId == null || endpoint == null || cluster == null || attribute == null) {
                    throw new Error('write_attribute missing fields: ' + JSON.stringify(cmd));
                }
                assertReachable(bridge, Number(nodeId));
                const result = await bridge.writeAttribute(Number(nodeId), attributePath(endpoint, cluster, attribute), value);
                // Optimistic state-emit so consumer Things react before the device's own push
                try {
                    node.controller.emit('matter:attribute', {
                        nodeId: Number(nodeId),
                        endpoint: Number(endpoint),
                        cluster: Number(cluster),
                        attribute: Number(attribute),
                        value,
                    });
                } catch (_) {}
                return result;
            }

            if (kind === 'read_attribute') {
                const { nodeId, endpoint, cluster, attribute } = cmd;
                if (nodeId == null || endpoint == null || cluster == null || attribute == null) {
                    throw new Error('read_attribute missing fields: ' + JSON.stringify(cmd));
                }
                return bridge.readAttribute(Number(nodeId), attributePath(endpoint, cluster, attribute));
            }

            throw new Error('Unknown kind: ' + kind);
        }

        node.on('input', async function (msg, send, done) {
            const payload = msg.payload;
            if (!payload) {
                const err = new Error('matterjsOut: empty payload');
                if (node.errorOutput) {
                    msg.payload = { type: 'invalid_input', source: 'matterjsOut', message: err.message, ts: new Date().toISOString() };
                    send([null, msg]);
                    done && done();
                    return;
                }
                done && done(err);
                return;
            }
            const cmds = Array.isArray(payload) ? payload : [payload];
            const results = [];
            let failedIndex = -1;
            try {
                for (let i = 0; i < cmds.length; i++) {
                    failedIndex = i;
                    const r = await execOne(cmds[i]);
                    results.push(r);
                }
                msg.payload = results.length === 1 ? results[0] : results;
                node.status({ fill: 'green', shape: 'dot', text: 'ok' });
                if (node.errorOutput) send([msg, null]);
                else send(msg);
                done && done();
            } catch (e) {
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                // Commands before the failing one have already been sent and cannot be
                // recalled — an array abort must say how far it got, or the caller re-sends
                // commands that already took effect.
                if (node.errorOutput) {
                    const errMsg = {
                        topic: 'matter/_error',
                        payload: {
                            type: e.code || 'command_failed',
                            source: e.source || 'matterjsOut',
                            message: e.message,
                            ts: new Date().toISOString(),
                            failed_index: failedIndex,
                            completed: results.length,
                            results,
                        },
                        originalPayload: payload,
                    };
                    send([null, errMsg]);
                    done && done();
                } else {
                    if (cmds.length > 1) {
                        e.message += ` (command ${failedIndex + 1} of ${cmds.length}; ${results.length} already sent)`;
                    }
                    done && done(e);
                }
            }
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsOut', matterjsOut);
};
