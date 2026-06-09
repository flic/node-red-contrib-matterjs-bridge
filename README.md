# nodered-contrib-matterjs-bridge

Node-RED bridge mellan [matterjs-server](https://github.com/matter-js/matterjs-server) (en Matter-over-IP-controller byggd ovanpå [matter.js](https://github.com/project-chip/matter.js)) och Node-RED-flows. Bygger på officiella `@matter-server/ws-client`.

## Vad paketet ger dig

Fyra Node-RED-noder:

- **matterController** (config) — anslutning till matterjs-server WS-API, cache av noder, valfri attribut-polling.
- **matterIn** (runtime) — emittar attribute-uppdateringar och node-events från Matter-fabrics som vanliga Node-RED-msgs.
- **matterOut** (runtime) — tar emot kommandon (device_command, write_attribute) och dispatchar till matterjs-server.
- **matterDiscover** (runtime) — genererar en **importerbar JSON-snippet** för nya enheter du commissionerar. Du kör Import → Clipboard i Node-RED-editorn och Thingen är klar att deploya.

## Topic-schema

matterIn emittar på topic `matter/{nodeId}/{endpoint}/{cluster}/{attribute}` med payload = aktuellt värde. `msg.matter` innehåller strukturerad metadata `{ nodeId, endpoint, cluster, attribute, kind }`.

Exempel:
- `matter/29/1/6/0` payload `true` → On/Off-state (cluster 6 attr 0) på endpoint 1 av node 29
- `matter/41/1/1026/0` payload `1850` → Temperature 18.50 °C (cluster 1026 attr 0)

matterOut accepterar samma format på input via `msg.payload`:

```javascript
// Device command
msg.payload = { kind: 'device_command', nodeId: 29, endpoint: 1, cluster: 6, command: 'On' };

// Write attribute
msg.payload = { kind: 'write_attribute', nodeId: 4, endpoint: 1, cluster: 513, attribute: 17, value: 2300 };

// Array av kommandon — alla skickas i sekvens
msg.payload = [ {...}, {...} ];
```

## Installation

```bash
cd ~/.node-red
npm install nodered-contrib-matterjs-bridge
```

Restart Node-RED och leta efter "matter"-noderna i paletten.

Sätt env-variabeln `MATTER_WS_URL` (eller fyll i WS-URL direkt i matterController) för att peka mot din matterjs-server-instans, t.ex. `ws://matter.caddy:5580/ws`.

## Sync av nya enheter — paste-importflöde

1. Commissionera en ny enhet via matterjs-server-dashboarden.
2. I Node-RED: trigga en matterDiscover-nod (kopplad till en inject och en debug).
3. Debug-panelen visar en JSON-array.
4. Kopiera arrayen, öppna Node-RED-editorns Import-dialog (`Ctrl+I`), välj "Clipboard", klistra in, Import.
5. Nya `hal2Thing` + `hal2ThingType`-noderna dyker upp i flow-editorn. Granska, Deploy.

Inga side-effects, inget Admin-API-tricks, helt säkert att backa ur.

## Templates

Paketet bundlar templates för dessa device-typer i `templates/`:

- `matter_plug` — enkel On/Off-plugg
- `matter_metered_plug` — On/Off + power på separat metering-endpoint (1296)
- `matter_metered_plug_combined` — On/Off + power på *samma* endpoint som plug
- `matter_dual_metered_plug` — 2-kanals metered plug (t.ex. Shelly 2PM)
- `matter_metered_switch` — On/Off-relä med metering på root-endpoint
- `matter_dim_light` — On/Off + brightness
- `matter_metered_dim_light_inline` — dimmer med inline metering
- `matter_ct_light` — On/Off + brightness + color temperature
- `matter_thermostat` — temperatur, target temp, system mode
- `matter_temp_humidity_sensor` — temp + RH + battery (Eve Weather + standardsensorer)
- `matter_contact_sensor` — dörr/fönster med batteri
- `matter_water_leak_sensor` — vattenläcksensor med batteri
- `matter_air_quality_sensor` — full luftkvalitet (AQ, temp, RH, CO2, PM2.5)
- `matter_dual_button` — 2-knapps switch
- `matter_motion_light_sensor` — rörelse + ljus + batteri

### Egna templates

Konfigurera "Templates directory" i matterController-noden — peka på en katalog på disk. Alla `*.json`-filer i den katalogen läses in vid Controller-start och overridar/utökar de bundlade. Bra för att dela egna templates via git eller gist.

### Template-schema

Varje template-JSON-fil följer denna struktur:

```json
{
  "id": "matter_xxx_thingtype",
  "name": "Människovänligt namn",
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

`shape` är resultatet av `computeShape()` — strukturen av endpoint+device_type-par. matterDiscover använder den för att matcha en commissionerad nod mot rätt template.

Templates är helt självinneslutna — `functions.ingress[]` och `functions.egress[]` blir lokala på den genererade `hal2ThingType`-noden, inga ändringar i hal2EventHandler-bibban behövs.

## Auto-polling

Vissa Matter-enheter (t.ex. Mill-termostater) pushar inte spontant `attribute_updated` för alla attribut. matterController har en valfri polling-konfiguration: lista `(cluster, attribute, intervalSeconds)`-rader. Controllern läser dessa periodiskt via `read_attribute` och emittar resultaten som vanliga attribute-events.

Vanliga konfigurationer:
- Termostat-setpoint: cluster 513 attr 17 + 18, var 60:e sekund
- Plug-metering: cluster 144 attr 8 (power), var 30:e sekund

## Beroenden

- Node-RED >= 4.0.0
- Node.js >= 20.19.0
- `@matter-server/ws-client` ^1.0.0 (officiella matterjs-server-klienten)
