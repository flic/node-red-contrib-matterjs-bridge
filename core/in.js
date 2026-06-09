'use strict';

const { attributeToMsg, nodeEventToMsg, topicMatches } = require('../lib/normalize');

module.exports = function (RED) {
    function matterIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);
        node.format = config.format || 'hal2';
        node.topicFilter = String(config.topicFilter || '').trim();
        node.nodeIdFilter = String(config.nodeIdFilter || '').trim();

        if (!node.controller) {
            node.status({ fill: 'red', shape: 'ring', text: 'no controller' });
            return;
        }

        function shouldEmit(envelope) {
            if (node.nodeIdFilter && String(envelope.matter.nodeId) !== node.nodeIdFilter) return false;
            if (node.topicFilter && !topicMatches(envelope.topic, node.topicFilter)) return false;
            return true;
        }

        const onAttribute = (ev) => {
            let msg;
            if (node.format === 'raw') {
                msg = { payload: ev };
            } else {
                msg = attributeToMsg(ev);
                if (!shouldEmit(msg)) return;
            }
            node.send(msg);
        };

        const onNodeEvent = (ev) => {
            let msg;
            if (node.format === 'raw') {
                msg = { payload: ev };
            } else {
                msg = nodeEventToMsg(ev);
                if (!shouldEmit(msg)) return;
            }
            node.send(msg);
        };

        const onStatus = (s) => {
            try { node.status(s); } catch (_) {}
        };

        node.controller.on('matter:attribute', onAttribute);
        node.controller.on('matter:nodeevent', onNodeEvent);
        node.controller.on('matter:status', onStatus);

        node.on('close', function () {
            node.controller.removeListener('matter:attribute', onAttribute);
            node.controller.removeListener('matter:nodeevent', onNodeEvent);
            node.controller.removeListener('matter:status', onStatus);
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterIn', matterIn);
};
