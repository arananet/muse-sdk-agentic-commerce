# muse-commerce-audit

Auditor que abre tu tienda en **Chromium headless real** (Playwright) y comprueba
si un agente de compra por IA como **Meta Muse** puede descubrir, entender y
actuar sobre la página — **sin Universal Commerce Protocol**, solo con estándares
web públicos. Opcionalmente pasa la evidencia a un agente **Muse Code real** vía
el SDK oficial [`@muse-code/sdk`](https://www.npmjs.com/package/@muse-code/sdk)
(developer preview) para que dé su valoración.

> Aviso honesto: Meta no ha publicado qué reglas aplica su agente de consumo
> Muse al navegar. Los checks son heurísticas basadas en estándares
> (robots.txt RFC 9309, schema.org, árbol de accesibilidad ARIA), no la lógica
> interna de Muse. El SDK público controla **Muse Code** (agente) por MSP; no
> expone el navegador del producto de consumo.

## Qué comprueba

| Check | Qué mira |
|---|---|
| `bot-wall`, `http-status` | 403/429/CAPTCHA/Cloudflare/DataDome ante Chromium headless |
| `robots-*` | Si robots.txt bloquea `meta-externalagent`, `meta-externalfetcher`, `facebookexternalhit`, `FacebookBot` |
| `product-schema`, `offer-*`, `product-*` | JSON-LD `Product`/`Offer`: nombre, precio, moneda, disponibilidad, imagen, sku/gtin |
| `price-mismatch` | Precio del JSON-LD visible en el texto renderizado |
| `no-js`, `no-js-text` | Datos de producto presentes en el HTML del servidor sin ejecutar JS |
| `purchase-control`, `unnamed-control` | Botón “Add to cart / Comprar” localizable por rol ARIA + nombre accesible |
| `open-graph` | Metadatos Open Graph |

## Uso

```sh
npm install
npm run build
node dist/src/cli.js https://tu-tienda.com/producto/123
node dist/src/cli.js --json https://tu-tienda.com/producto/123
node dist/src/cli.js --user-agent "meta-externalagent/1.1" https://...
```

Código de salida `1` si hay algún error (útil en CI).

### Mystery shopper (`--journey`)

Recorre la compra en Chromium **solo por rol ARIA y nombre accesible**, como un agente:
descarta overlays (cookies, popups) → elige variante → "Añadir al carrito" → comprueba
que hay feedback legible por máquina (URL, `aria-live`, `role=status`, diálogo) → va
al carrito/checkout → mide compra como invitado, cobertura `autocomplete` y deriva de
precio (ficha → total). **Se detiene en el botón de pagar y nunca lo pulsa; no escribe en formularios.**
Sí añade un producto a un carrito real.

```sh
node dist/src/cli.js --journey --trace trace.zip https://tu-tienda.com/producto/123
npx playwright show-trace trace.zip   # vídeo/DOM paso a paso
```

### Con Muse Code real: Muse navega con Chromium

Siguiendo la [docu del developer preview](https://meta-models.github.io/muse-code-sdk/)
(Extending Muse Code → MCP servers / Skills), el repo trae:

- `.mcp.json` → servidor MCP stdio `commerce_audit` (`dist/src/mcp-server.js`) con dos
  herramientas: `agent_view` y `audit_page` (solo lectura), `mystery_shop` (recorrido
  determinista) y `shop_open` / `shop_view` / `shop_click` / `shop_select` / `shop_close`
  para que **Muse conduzca la compra paso a paso** en una pestaña persistente;
  `shop_click` rechaza controles de pago.
- `.agents/skills/agentic-commerce-audit/SKILL.md` → skill que guía a Muse: ver la página,
  repetir con UA `meta-externalagent`, auditar y dar veredicto + arreglos.

Requisitos: CLI `muse` 1.3.x con sesión iniciada, `npm run build`, y confiar en el
workspace (los `.mcp.json` y skills de proyecto solo cargan en workspaces de confianza):

```sh
muse --trust-workspace      # o abre `muse` una vez aquí y elige "Trust and continue"
node dist/src/cli.js --muse https://tu-tienda.com/producto/123
```

`--muse` usa `@muse-code/sdk`: lanza `muse serve`, abre sesión con `workspaceRoot` en este
repo, comprueba `skill/list`, invoca la skill con una parte `skill`, **aprueba solo las
herramientas `mcp__commerce_audit__*`** (una vez) y deniega el resto, e imprime la respuesta.
También puedes usarlo en el TUI de Muse: `/agentic-commerce-audit https://...`.

## Tests

```sh
npm test
```

Levanta un servidor HTTP local con páginas fixture y las audita en Chromium real.
También prueba el servidor MCP por pipe stdio y la política de aprobaciones.
El modo `--muse` extremo a extremo no tiene test automático: necesita el binario `muse`.

## Estructura

- `src/collect.ts` — Chromium: navegación, robots.txt, JSON-LD, render sin JS, controles ARIA
- `src/checks.ts` — reglas y puntuación
- `src/robots.ts` — parser robots.txt
- `src/muse.ts` — integración `@muse-code/sdk`
- `src/mcp-server.ts` — servidor MCP stdio para Muse Code
- `src/shopper.ts` — mystery shopper
- `.openspec/specs/muse-commerce-auditor.spec.yaml` — spec
