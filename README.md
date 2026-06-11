# node-red-contrib-matterjs-bridge

Node-RED bridge between [matterjs-server](https://github.com/matter-js/matterjs-server) (a Matter-over-IP controller built on top of [matter.js](https://github.com/project-chip/matter.js)) and Node-RED flows. Built on the official `@matter-server/ws-client`.

## What's in the box

Four Node-RED nodes:

- **matterjs controller** (config) — connection to the matterjs-server WS API, node cache, optional attribute polling.
- **matterjs in** (runtime) — emits attribute updates and node events from your Matter fabric as plain Node-RED messages. Can optionally publish per-device **metadata** (model, IPv6, …) into hal2 — see [Device inventory & IPv6](#device-inventory--ipv6).
- **matterjs out** (runtime) — receives commands (`device_command`, `write_attribute`, `read_attribute`) and dispatches them to matterjs-server.
- **matterjs discover** (runtime) — generates an **importable JSON snippet** for newly commissioned devices, a flat device **inventory**, or a **resync** that replays the current node cache (alive + attributes) to re-seed downstream Things (e.g. after a restart). Run Import → Clipboard in the Node-RED editor and the Thing is ready to deploy.

The **matterjs controller** also adds a **Matter Devices** sidebar tab to the Node-RED editor — a live table of every commissioned node (id, model, IPv6, firmware, online) for the selected controller.

## Topic schema

`matterjs in` emits messages on topic `matter/{nodeId}/{endpoint}/{cluster}/{attribute}` with payload = current value. `msg.matter` carries structured metadata `{ nodeId, endpoint, cluster, attribute, kind }`.

Examples:
- `matter/29/1/6/0` payload `true` → On/Off state (cluster 6 attr 0) on endpoint 1 of node 29
- `matter/41/1/1026/0` payload `1850` → Temperature 18.50 °C (cluster 1026 attr 0)

`matterjs out` accepts the same format on its input via `msg.payload`:

```javascript
// Device command
msg.payload = { kind: 'device_command', nodeId: 29, endpoint: 1, cluster: 6, command: 'On' };

// Write attribute
msg.payload = { kind: 'write_attribute', nodeId: 4, endpoint: 1, cluster: 513, attribute: 17, value: 2300 };

// Array of commands — sent sequentially
msg.payload = [ {...}, {...} ];
```

## Installation

```bash
cd ~/.node-red
npm install node-red-contrib-matterjs-bridge
```

Restart Node-RED and look for the "matterjs"-prefixed nodes in the palette under "Home Automation".

Set the `MATTER_WS_URL` env variable (or fill in the WS URL directly on the matterjs controller node) to point at your matterjs-server instance, e.g. `ws://matter.caddy:5580/ws`.

## Adding new devices — the paste-import flow

1. Commission a new device via the matterjs-server dashboard.
2. In Node-RED: trigger a matterjs discover node (wired to an inject and a debug).
3. The debug panel shows a JSON array.
4. Copy the array, open Node-RED's Import dialog (`Ctrl+I`), pick "Clipboard", paste, Import.
5. The new `hal2Thing` + `hal2ThingType` nodes appear in the editor. Review, Deploy.

## Device inventory & IPv6

Beyond per-device discovery, you can list **everything** at once with model and network details — no manual export.

**Inventory format.** Set `matterjs discover` to the **inventory** format (or send `msg.format = "inventory"`). It outputs a flat array, one entry per node:

```json
{ "node_id": 35, "vendor": "Shelly", "product": "Shelly Dimmer Gen4",
  "product_label": "", "part_number": "", "firmware": "1.3.0-s1", "hardware": "v4",
  "serial": "…", "transport": "wifi", "ipv6": ["fd90::…"], "ipv4": [], "available": true,
  "shape": "(1,257+meter)", "suggested_thingtype": "matter_metered_dim_light_thingtype" }
```

`transport` (`thread` / `wifi` / `ethernet`) and the IPv6/IPv4 addresses come from Matter **GeneralDiagnostics** `NetworkInterfaces` (`0/51/0`) — the interface `Type` field, with a fallback to ThreadNetworkDiagnostics (`0/53`) / WiFiNetworkDiagnostics (`0/54`) cluster presence. If a node's address isn't already cached, send `msg.readNetwork = true` to read it on demand.

**Editor sidebar.** The controller registers a **Matter Devices** sidebar tab with the same data as a live table. It's backed by an admin endpoint — `GET /matterjs-bridge/<controllerId>/inventory` (`?readNetwork=true` optional) — which you can also call directly.

**Push into hal2 metadata.** Enable **Emit metadata** on a `matterjs in` node and it publishes, per device, an object payload to the reserved hal2 topic `matter/<id>/_meta`:

```json
{ "source": "matter", "transport": "wifi", "model": "Shelly Dimmer Gen4",
  "vendor": "Shelly", "serial": "…", "firmware": "1.3.0-s1", "ipv6": "fd90::…" }
```

`source: "matter"` tags every device with its origin (handy later for filtering by integration), and `transport` records `thread` / `wifi` / `ethernet`.

[hal2](https://www.npmjs.com/package/node-red-contrib-hal2) stores this generically as read-only **metadata** on the matching Thing (visible in the Thing editor and via the hal2 MCP `get_all_states`). hal2 *merges* the object into the Thing's metadata; the bridge sends empty fields as `null` so stale keys are pruned on each (re)connect. Enable it on **one** `matterjs in` that feeds your Things, to avoid duplicate emissions. hal2 stays technology-neutral: it never parses these keys — all Matter/Thread/IPv6 specifics live here in the bridge.

## Templates

The package ships with templates for these device types in `templates/`:

- `matter_plug` — simple On/Off plug
- `matter_metered_plug` — On/Off + power on a separate metering endpoint (device type 1296)
- `matter_metered_plug_combined` — On/Off + power on the *same* endpoint as the plug
- `matter_dual_metered_plug` — 2-channel metered plug (e.g. Shelly 2PM)
- `matter_metered_switch` — On/Off relay with metering on the root endpoint
- `matter_dim_light` — On/Off + brightness
- `matter_metered_dim_light_inline` — dimmer with inline metering
- `matter_ct_light` — On/Off + brightness + color temperature
- `matter_thermostat` — temperature, target temp, system mode
- `matter_temp_humidity_sensor` — temp + RH + battery (Eve Weather + standard sensors)
- `matter_contact_sensor` — door/window with battery
- `matter_water_leak_sensor` — water leak sensor with battery
- `matter_air_quality_sensor` — full air quality (AQ, temp, RH, CO2, PM2.5)
- `matter_dual_button` — 2-button switch
- `matter_motion_light_sensor` — motion + illuminance + battery

### Custom templates

Configure "Templates directory" on the matterjs controller node — point it at a directory on disk. Every `*.json` file in that directory is loaded at controller start and overrides/extends the bundled templates. Convenient for sharing your own templates via git or gist.

### Template schema

Each template JSON file follows this structure:

```json
{
  "id": "matter_xxx_thingtype",
  "name": "Human-readable name",
  "shape": "(1,266)",
  "nodestatus": "🔌 %On% ⚡ %Power%W",
  "items": [
    {
      "name": "On",
      "id": "xxx_on",
      "endpoint": 1,
      "cluster": 6,
      "attr": 0,
      "haType": "switch",
      "ingress": "Pass-through",
      "egress": "Matter OnOff"
    }
  ],
  "functions": {
    "ingress": [ { "name": "Pass-through", "fn": "return msg.payload;" } ],
    "egress": [ { "name": "Matter OnOff", "fn": "..." } ]
  }
}
```

`shape` is the output of `computeShape()` — the structure of endpoint + device_type pairs. `matterjs discover` uses it to match a commissioned node to the right template.

Templates are fully self-contained: `functions.ingress[]` and `functions.egress[]` are emitted as local arrays on the generated `hal2ThingType` node — no changes to the `hal2EventHandler` library are required.

## Auto-polling

Some Matter devices (e.g. Mill thermostats) don't spontaneously push `attribute_updated` for every attribute. The matterjs controller has an optional polling config: a list of `(cluster, attribute, intervalSeconds)` rows. The controller reads each periodically via `read_attribute` and emits the results as regular attribute events.

Common configurations:
- Thermostat setpoint: cluster 513 attr 17 + 18, every 60 seconds
- Plug metering: cluster 144 attr 8 (power), every 30 seconds

## Error handling

- `matterjs out` and `matterjs discover` propagate failures via `done(err)`, which Node-RED's standard **catch** node picks up. The status turns red and the error msg is dispatched to the catch handler.
- `matterjs in` has no triggering input, so catch nodes can't be used to surface controller-side errors (connection lost, malformed WS payload, etc.). Enable the per-node **Error output** toggle to add a second output port that receives error msgs (`msg.payload = { type, source, message, ts }`).
- The controller auto-reconnects on disconnect with exponential backoff (2s → 4s → 8s → 16s → 32s → 60s, capped at 60s). Status text shows `reconnect in Ns`. Reset to base interval on successful reconnect.

## Requirements

- Node-RED >= 4.0.0
- Node.js >= 20.19.0
- `@matter-server/ws-client` ^1.0.0 (official matterjs-server client)
