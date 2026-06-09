'use strict';

module.exports = function (RED) {
    function matterOut(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);

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
                done && done(new Error('matterOut: empty payload'));
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
                send(msg);
                done && done();
            } catch (e) {
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                done && done(e);
            }
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterOut', matterOut);
};
