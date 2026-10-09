# tasaK

[English](README.md) · **Español**

Tasa de cambio de una moneda local a partir de órdenes completadas en uno o varios nodos Mostro.
Sirve para cualquier nodo y moneda; el ejemplo de configuración es Kmbalache 🇨🇺 (CUP).

## Por qué tasaK

Muchas tasas de referencia se calculan a partir de **anuncios o intenciones** de compra y venta: lo que
alguien dice que pagaría, no lo que realmente se pagó. tasaK parte de lo contrario:

- **Solo órdenes completadas.** La tasa es el precio ponderado por volumen de las operaciones que de verdad
  se ejecutaron en las últimas 24 horas, no de ofertas publicadas.
- **Verificable por cualquiera.** Cada orden es un evento firmado por el nodo Mostro y publicado en Nostr.
  La página comprueba las firmas, y cualquier persona puede leer los mismos eventos de los relays y
  recalcular la misma tasa. Al hacer clic en una orden se ve su evento original.
- **Precio, volumen y órdenes a la vista.** Además de la tasa se ven el volumen negociado, cada orden
  ejecutada, el libro de órdenes con las órdenes abiertas y la referencia del mercado para comparar.
- **Sin intermediario.** Los datos salen directamente de los relays; la página no depende de un servidor
  propio ni de una base de datos a la que haya que creer.
- **De cualquier nodo.** Cualquier comunidad puede apuntarla a su propio nodo Mostro y su moneda.

## Configurar

Requisitos: Rust (`cargo`), para compilar `tasak`, el programa que lee el `.env`, genera
`web/config.js`, copia `shared/` en `web/shared/` y sirve el sitio.

```sh
cp .env.example .env            # pon tu nodo, relays, moneda y comunidad (el ejemplo es Kmbalache)
cargo install --path server --locked   # compila tasak y lo instala en ~/.cargo/bin (en el PATH con rustup)
tasak                           # desde la carpeta del repositorio (o --root CARPETA): genera y
                                # sirve web/ en http://localhost:8765/ (LISTEN para cambiarlo)
tasak build                     # solo genera web/config.js y web/shared/
```

Vuelve a ejecutar `cargo install` tras actualizar el repositorio. Sin instalarlo, `cargo build --release
--manifest-path server/Cargo.toml` deja el programa en `server/target/release/tasak`.

El sitio necesita un servidor web, también para probarlo en local: abierto como archivo (`file://`) los
navegadores no cargan sus módulos ES y la página muestra un aviso en su lugar. `tasak` genera los
archivos al arrancar: vuelve a ejecutarlo tras cambiar `.env` o `shared/`. Dos formas de publicarlo:

- **Con el servidor de tasaK:** deja `tasak` en marcha y pon delante un servidor web con HTTPS (nginx,
  Caddy…). Solo sirve archivos (GET y HEAD, nada que reciba datos) y escucha por defecto en
  `127.0.0.1:8765` (`LISTEN`). Más adelante también archivará los eventos del nodo y publicará la Tasa K.
- **Como sitio estático:** ejecuta `tasak build` y publica la carpeta `web/`, que contiene todo lo que
  necesita el sitio, con cualquier servidor web o alojamiento estático. En GitHub Pages, publica `web/`
  con un flujo de GitHub Actions que compile `tasak` y ejecute antes `tasak build`: Pages solo publica
  la raíz o `/docs` de una rama, y `web/config.js` no está en el repositorio.

Variables de `.env` (en inglés, para que sirvan a cualquier operador de nodo):

| Variable | Qué es |
|---|---|
| `SITE_NAME` | Nombre del sitio: logo, pestaña e icono (por defecto `tasaK`; si termina en mayúsculas, esa parte va resaltada) |
| `RATE_NAME` | Nombre de la tasa en toda la página (por defecto `Tasa K`) |
| `LOGO` | Logo del sitio: archivo en `web/`, junto a `index.html` (svg, png, jpg, webp), o enlace https. Vacío = el nombre en texto |
| `LOGO_LIGHT` | Logo para el tema claro (opcional; si falta, se usa `LOGO`) |
| `THEME` | Tema por defecto, `light` o `dark` (vacío = el del sistema). Cada visitante puede cambiarlo con ☀ / ☾ |
| `LANGUAGE` | Idioma por defecto, `es` o `en` (vacío = el del navegador). Cada visitante puede cambiarlo con ES · EN |
| `MOSTRO_PUBKEYS` | Nodos a visualizar, en hex o npub, separados por coma (obligatorio) |
| `RELAYS` | Relays a los que conectarse, separados por coma (obligatorio; `wss://`) |
| `FIAT` | Moneda que se muestra al abrir (vacío = la más usada en el nodo) |
| `TIMEZONE` | Zona horaria de fechas y velas, p. ej. `America/Caracas` (vacío = la del navegador) |
| `HIDDEN_PAYMENT_METHODS` | Métodos de pago que no cuentan por defecto, separados por coma (por defecto `Pruebas,Otros`) |
| `COMMUNITY`, `COMMUNITY_URL` | Comunidad que opera el nodo (opcional) |
| `SOCIAL_LINKS` | Enlaces a sus redes, separados por coma (opcional; Telegram, X, YouTube, GitHub y Nostr se reconocen solos) |
| `ARCHIVE_DIR` | Carpeta de los datos del archivador (opcional; por defecto `indexer/data/`, ver [Archivador](#archivador)) |
| `LISTEN` | Dirección en la que escucha `tasak`, el servidor de tasaK (opcional; por defecto `127.0.0.1:8765`) |

Los métodos de pago de cada moneda salen de la lista de la app de Mostro; lo que no está en ella se
agrupa como «Otros». En `HIDDEN_PAYMENT_METHODS` conviene añadir los que en tu mercado se negocian a
otra tasa (en el ejemplo de Cuba, «Saldo móvil»).

La información del nodo (nombre, descripción, web, comisión, montos, versión, nodo Lightning, relays) se lee de sus propios eventos Nostr (kind 0, 38385 y 10002). Está en su propia página, `node.html`, a la que se llega con el botón «Nodo Mostro» o haciendo clic en el nombre del nodo en la barra de moneda (conserva los parámetros de la URL). La comunidad y las redes solo se muestran con los nodos del `.env`.

Cualquier visitante puede ver otro nodo sin desplegar nada, sobrescribiendo el `.env` desde la URL:

```
index.html?mostro=npub1…,npub1…&relays=wss://relay.mostro.network,wss://nos.lol&fiat=VES&lang=en
```

Si la URL cambia el nodo y no lleva `fiat`, la moneda del `.env` no se aplica: la página elige la más usada en ese nodo.

## Tasa K

Precio ponderado por volumen de las órdenes completadas en las últimas 24 horas:

```
Tasa K = Σ(precio × monto) ÷ Σ monto
```

Ejemplo (en CUP): 3 órdenes a 785 CUP/USD que suman 3000 CUP y una a 750 de 5000 CUP →
(785×3000 + 750×5000) ÷ 8000 = **763,13**.

### Qué mide

El precio al que de verdad se cambia la moneda en operaciones con bitcoin. En moneda/USD es una tasa
implícita: moneda pagada por cada BTC dividida por el BTC/USD. No es el precio del dólar en efectivo ni en
transferencias: si comprar o vender bitcoin con la moneda lleva un sobreprecio propio, también está en la
Tasa K. Moneda/BTC y moneda/sat no pasan por el dólar.

Casi todas las órdenes son a precio de mercado: el nodo fija los sats con su precio de referencia y la
prima de la orden, así que su precio es aproximadamente `referencia ÷ (1 − prima)`. Por eso la Tasa K
sigue a esa referencia, y lo que se separa de ella («sobre Yadio» en la cabecera) son sobre todo las primas
con las que se opera. Las órdenes a precio fijo no dependen de ella.

### La referencia del nodo

Desde Mostro 0.19 cada nodo elige sus fuentes de precio (Yadio, CoinGecko, Blockchain.com, currency-api,
fuentes del mercado local u otros nodos por Nostr), las combina y publica el resultado, firmado, en su evento
`mostro-rates`, con las fuentes en la etiqueta `source`; con ese mismo valor calcula las órdenes a
mercado. La cabecera dice «Referencia Yadio» si el nodo usa solo Yadio y «Referencia del nodo» si no, con
las fuentes al pasar el ratón. En el libro de órdenes cada orden a mercado se calcula con los precios de
su propio nodo, que este sigue usando hasta 30 minutos si no puede actualizarlos; sin ellos, el precio se
estima con la API de Yadio y lleva «≈», y si tampoco hay, la orden aparece sin precio («—»).

Las compras y las ventas de BTC se cierran a precios distintos, porque cada lado pone su prima; la Tasa K
las pondera todas juntas. Solo como información, sin cambiar la tasa, al pasar el ratón sobre la Tasa K y
en la FAQ se ven el precio ponderado de las compras y el de las ventas de las últimas 24 horas, y cuántas
órdenes fueron a precio de mercado (con su prima media) o a precio fijo. Mercado o fijo sale de la versión
`pending` de la orden o, sin ella, de una prima distinta de 0 (Mostro no admite prima con precio fijo); las
órdenes con prima 0 de las que no se vio la versión `pending` cuentan como «sin saber».

La gráfica tiene tres modos:

- **Precio**: un punto por orden ejecutada, o por periodo (1h, 4h, 1D, 1W, 1M, 1Y) con el precio ponderado del periodo.
- **Velas**: apertura, máximo, mínimo y cierre de cada periodo.
- **Ponderado**: en cada punto, el precio ponderado por volumen de las 24 horas anteriores, `Σ(precio × monto) ÷ Σ monto` (tras cada orden, o al cierre de cada periodo). Es la Tasa K vista a lo largo del tiempo.

El volumen va en la parte baja de la gráfica y, al pasar el ratón, la leyenda de arriba muestra los valores de ese punto. La gráfica se puede ampliar y desplazar (el zoom se mantiene aunque lleguen órdenes nuevas; doble clic para volver a verlo todo) y expandir a pantalla completa. El filtro por método de pago está en el menú «Método de pago».

Los métodos de `HIDDEN_PAYMENT_METHODS` quedan fuera por defecto; se pueden activar desde el menú.

## Funcionar aunque haya servicios bloqueados

Pensada para países o redes donde algunos servicios están bloqueados. La página no depende de ningún CDN: las librerías están copiadas en `web/vendor/`
(lightweight-charts 5.2.1 y nostr-tools 2.25.2), unos 105 KB comprimidos.

Servicios externos que usa y qué pasa si están bloqueados:

| Servicio | Para qué | Si está bloqueado |
|---|---|---|
| Relays Nostr | las órdenes, y los precios actuales que publica el nodo (`mostro-rates`: BTC/USD, referencia de la moneda frente al USD, libro de órdenes a precio de mercado) | sin ellos no hay datos (basta con que responda uno) |
| Yadio | solo si un nodo no publica `mostro-rates` válidos: una estimación de los precios actuales | la moneda/USD no se puede calcular; moneda/BTC y moneda/sat siguen funcionando |
| Coinbase | BTC/USD histórico por hora, para la moneda/USD | se calcula con el BTC/USD actual (el del nodo o el de Yadio) y se avisa de que es aproximado |

## Archivador

Los relays guardan las órdenes unos 15 días y solo su última versión: cuando una orden se completa,
desaparecen la versión `pending` (precio de mercado o fijo) y la `in-progress` (cuándo se tomó). Los
`mostro-rates` del nodo (precio de BTC en cada moneda, de sus fuentes de precio) caducan a los 10 minutos. Para tener el
historial completo, `indexer/archiver.mjs` se suscribe a los relays del `.env` y guarda todo lo que
publica el nodo, verificado (firma y autor), en archivos diarios:

- `indexer/data/eventos/AAAA-MM-DD.jsonl`: órdenes de todas las monedas (una línea por cada relay que la
  tenía, para comprobar qué relay tenía qué), cada `mostro-rates` una vez y los metadatos del nodo
  cuando cambian.
- `indexer/data/yadio/AAAA-MM-DD.jsonl`: el BTC/USD de Yadio cada 5 minutos de las últimas 24 h, para
  rellenar los huecos cuando el archivador estuvo apagado.

Necesita Node.js ≥ 22 (WebSocket nativo), sin dependencias, y debe estar siempre encendido: lo que pase
mientras está apagado se pierde, salvo la última versión de cada orden. Ocupa alrededor de 1 MB al día.

```sh
node indexer/archiver.mjs
```

Para que arranque solo como servicio, ver `indexer/tasak-archiver.service`. Dos archivadores en
máquinas distintas se pueden unir después (los eventos se deduplican por id). Estos archivos
alimentarán el futuro indexador.

El historial anterior al archivador lo puede recuperar el operador del nodo desde la base de datos de
Mostro. Sobre una copia (`sqlite3 mostro.db ".backup mostro-copia.db"`):

```sh
node indexer/export-mostro.mjs mostro-copia.db
```

Necesita Node.js ≥ 22.13 y escribe las órdenes ejecutadas en `indexer/data/mostro-db/`. Solo exporta
datos públicos de la operación (moneda, montos, prima, métodos de pago, horas, precio de mercado o
fijo), nunca claves, facturas ni la tabla de usuarios. Esas órdenes no van firmadas: una orden cuenta
como confirmada cuando su evento firmado de Nostr también está archivado.

## Archivos

| Archivo | Qué es |
|---|---|
| `web/` | el sitio, la carpeta que se publica |
| `web/index.html` | la tasa: gráfica, libro de órdenes y órdenes ejecutadas |
| `web/node.html` | información del nodo Mostro |
| `web/js/` | los módulos de las páginas: cliente de relays (`nostr-client.js`) y almacén de eventos (`event-store.js`), compartidos por las dos páginas, gráfica, paneles, precios y estado |
| `web/css/` | estilos de cada página |
| `web/i18n.js` | idioma (español / inglés): diccionario y traducción de textos |
| `web/common.js`, `web/common.css` | configuración, formato, colores y tarjeta del nodo, compartidos por las dos páginas |
| `web/vendor/` | librerías copiadas (sin depender de CDN) y la lista de métodos de pago por moneda de la app de Mostro (`mostro-payment-methods.js`) |
| `shared/` | lógica pura de la tasa (módulos ES: métodos de pago, órdenes, precios del nodo (`mostro-rates`), zonas horarias y periodos, unidades, Tasa K y velas), que usan las páginas (`tasak` la copia a `web/shared/`) |
| `shared/test/` | pruebas de `shared/` (`node --test 'shared/test/*.test.js'`, Node ≥ 22), datos reales fijos (`fixtures/`), los valores de referencia que el código debe reproducir (`expected.json`) y casos escritos a mano (`cases.json`) |
| `server/` | el servidor de tasaK en Rust (`tasak`): lee el `.env`, genera `web/config.js` y sirve `web/`; `server/tests/config-cases.json` es el `web/config.js` que debe salir de cada `.env` (`cargo test`) |
| `indexer/` | el archivador de eventos, su servicio de systemd y el exportador de la base de datos de Mostro |
| `tools/` | comprobaciones de desarrollo en Chrome headless (Node, sin dependencias); `node tools/reference.mjs` comprueba que `web/` calcula con datos fijos los valores de `shared/test/expected.json` |

## Idiomas

La página está en español e inglés. El idioma se elige, por este orden: `?lang=` en la URL,
el selector ES · EN (se recuerda en el navegador), `LANGUAGE` del `.env` y, si no, el idioma del navegador.
Los textos originales están en español; las traducciones están en `web/i18n.js` (`EN`). Para añadir
otro idioma basta con otro diccionario igual.

## Licencia

[MIT](LICENSE). El código de terceros en `web/vendor/` mantiene sus propias licencias (ver `web/vendor/README.md`).
