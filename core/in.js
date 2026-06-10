'use strict';

const { attributeToMsg, nodeEventToMsg, topicMatches } = require('../lib/normalize');

module.exports = function (RED) {
    function matterjsIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.controller = RED.nodes.getNode(config.controller);
        node.format = config.format || 'hal2';
        node.topicFilter = String(config.topicFilter || '').trim();
        node.nodeIdFilter = String(config.nodeIdFilter || '').trim();
        node.errorOutput = !!config.errorOutput;

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
            if (node.errorOutput) node.send([msg, null]);
            else node.send(msg);
        };

        const onNodeEvent = (ev) => {
            let msg;
            if (node.format === 'raw') {
                msg = { payload: ev };
            } else {
                msg = nodeEventToMsg(ev);
                if (!shouldEmit(msg)) return;
            }
            if (node.errorOutput) node.send([msg, null]);
            else node.send(msg);
        };

        const onStatus = (s) => {
            try { node.status(s); } catch (_) {}
        };

        const onError = (errPayload) => {
            if (!node.errorOutput) return;
            const errMsg = {
                topic: 'matter/_error',
                payload: errPayload,
            };
            try { node.send([null, errMsg]); } catch (_) {}
        };

        node.controller.on('matter:attribute', onAttribute);
        node.controller.on('matter:nodeevent', onNodeEvent);
        node.controller.on('matter:status', onStatus);
        node.controller.on('matter:error', onError);

        node.on('close', function () {
            node.controller.removeListener('matter:attribute', onAttribute);
            node.controller.removeListener('matter:nodeevent', onNodeEvent);
            node.controller.removeListener('matter:status', onStatus);
            node.controller.removeListener('matter:error', onError);
        });

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });
    }

    RED.nodes.registerType('matterjsIn', matterjsIn);
};
