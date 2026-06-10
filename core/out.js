'use strict';

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

        async function execOne(cmd) {
            const bridge = node.controller.getBridge();
            if (!bridge) throw new Error('matter bridge not ready');
            const kind = cmd.kind || 'device_command';

            if (kind === 'device_command') {
                const { nodeId, endpoint, cluster, command, args } = cmd;
                if (nodeId == null || endpoint == null || cluster == null || !command) {
                    throw new Error('device_command missing fields: ' + JSON.stringify(cmd));
                }
                return bridge.deviceCommand(Number(nodeId), Number(endpoint), Number(cluster), String(command), args);
            }

            if (kind === 'write_attribute') {
                const { nodeId, endpoint, cluster, attribute, value } = cmd;
                if (nodeId == null || endpoint == null || cluster == null || attribute == null) {
                    throw new Error('write_attribute missing fields: ' + JSON.stringify(cmd));
                }
                const result = await bridge.writeAttribute(Number(nodeId), Number(endpoint), Number(cluster), Number(attribute), value);
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
                return bridge.readAttribute(Number(nodeId), Number(endpoint), Number(cluster), Number(attribute));
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
            try {
                for (const cmd of cmds) {
                    const r = await execOne(cmd);
                    results.push(r);
                }
                msg.payload = results.length === 1 ? results[0] : results;
                node.status({ fill: 'green', shape: 'dot', text: 'ok' });
                if (node.errorOutput) send([msg, null]);
                else send(msg);
                done && done();
            } catch (e) {
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                if (node.errorOutput) {
                    const errMsg = {
                        topic: 'matter/_error',
                        payload: {
                            type: 'command_failed',
                            source: e.source || 'matterjsOut',
                            message: e.message,
                            ts: new Date().toISOString(),
                        },
                        originalPayload: payload,
                    };
                    send([null, errMsg]);
                    done && done();
                } else {
                    done && done(e);
                }
            }
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsOut', matterjsOut);
};
