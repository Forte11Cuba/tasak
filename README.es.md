# tasaK

[English](README.md) · **Español**

Tasa de cambio de una moneda local a partir de órdenes completadas en uno o varios nodos Mostro.
Sirve para cualquier nodo y moneda; el ejemplo de configuración es Kmbalache 🇨🇺 (CUP).

## Por qué tasaK

Muchas tasas de referencia se calculan a partir de **anuncios o intenciones** de compra y venta: lo que
alguien dice que pagaría, no lo que realmente se pagó. tasaK parte de lo contrario:

- **Solo órdenes completadas.** La tasa es el precio ponderado por volumen de las operaciones que de verdad
  se ejecutaron en las 24 horas hasta la última, no de ofertas publicadas.
- **Verificable por cualquiera.** Cada orden es un evento firmado por el nodo Mostro y publicado en Nostr.
  La página comprueba las firmas, y cualquier persona puede leer los mismos eventos de los relays y
  recalcular la misma tasa. Al hacer clic en una orden se ve su evento original.
- **Precio, volumen y órdenes a la vista.** Además de la tasa se ven el volumen negociado, cada orden
  ejecutada, el libro de órdenes con las órdenes abiertas y la referencia del mercado para comparar.
- **Con o sin servidor.** El servidor del sitio (opcional) la hace más rápida y guarda el historial que
  los relays borran, pero lo que manda se comprueba igual, y la página funciona sin él.
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
  `127.0.0.1:8765` (`LISTEN`). También archiva los eventos del nodo (ver [Archivo](#archivo)) y
  publica la Tasa K (ver [Tasa publicada](#tasa-publicada)).
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
| `ARCHIVE_DIR` | Carpeta de la base de datos del archivo (opcional; por defecto `data/`, relativa a la carpeta del repositorio; ver [Archivo](#archivo)) |
| `ARCHIVE` | `false` sirve el sitio sin archivar (opcional; por defecto `true`) |
| `LISTEN` | Dirección en la que escucha `tasak`, el servidor de tasaK (opcional; por defecto `127.0.0.1:8765`) |
| `SIGNING_KEY_FILE` | Archivo con la clave que firma la Tasa K publicada (opcional; ver [Tasa publicada](#tasa-publicada)) |
| `RATE_DECIMALS` | Decimales de la tasa publicada, de 0 a 8 (opcional; por defecto `2`) |

Los métodos de pago de cada moneda salen de la lista de la app de Mostro; lo que no está en ella se
agrupa como «Otros». En `HIDDEN_PAYMENT_METHODS` conviene añadir los que en tu mercado se negocian a
otra tasa o se usan por error (en el ejemplo de Cuba, «Saldo móvil» y «Tarjeta Clásica»), con su nombre
completo, como en la lista de la app.

La información del nodo (nombre, descripción, web, comisión, montos, versión, nodo Lightning, relays) se lee de sus propios eventos Nostr (kind 0, 38385 y 10002). Está en su propia página, `node.html`, a la que se llega con el botón «Nodo Mostro» o haciendo clic en el nombre del nodo en la barra de moneda (conserva los parámetros de la URL). La comunidad y las redes solo se muestran con los nodos del `.env`.

Cualquier visitante puede ver otro nodo sin desplegar nada, sobrescribiendo el `.env` desde la URL:

```
index.html?mostro=npub1…,npub1…&relays=wss://relay.mostro.network,wss://nos.lol&fiat=VES&lang=en
```

Si la URL cambia el nodo y no lleva `fiat`, la moneda del `.env` no se aplica: la página elige la más usada en ese nodo.

## Tasa K

Precio ponderado por volumen de las órdenes completadas en las 24 horas que terminan en la última orden
completada:

```
Tasa K = Σ(precio × monto) ÷ Σ monto
```

Ejemplo (en CUP): 3 órdenes a 785 CUP/USD que suman 3000 CUP y una a 750 de 5000 CUP →
(785×3000 + 750×5000) ÷ 8000 = **763,13**.

Así la Tasa K de la cabecera solo cambia cuando se completa una orden nueva: no se mueve sola con el paso
del tiempo (con una ventana que terminara «ahora», una orden antigua al salir de ella movería la tasa a
cualquier hora), y cada valor es «la Tasa K tras tal orden». Si la última orden es de hace más de 24
horas, la cabecera dice de cuándo es. Los puntos «Ponderado» de la gráfica por periodo son otra cosa: ver
más abajo.

### Qué mide

El precio al que de verdad se cambia la moneda en operaciones con bitcoin. En moneda/USD es una tasa
implícita: moneda pagada por cada BTC dividida por el BTC/USD. No es el precio del dólar en efectivo ni en
transferencias: si comprar o vender bitcoin con la moneda lleva un sobreprecio propio, también está en la
Tasa K. Moneda/BTC y moneda/sat no pasan por el dólar.

Casi todas las órdenes son a precio de mercado: el nodo fija los sats con su precio de referencia y la
prima de la orden, así que su precio es aproximadamente `referencia ÷ (1 − prima)`. Por eso la Tasa K
sigue a esa referencia, y lo que se separa de ella («sobre Yadio» en la cabecera) son sobre todo las primas
con las que se opera. Las órdenes a precio fijo no dependen de ella.

### Qué órdenes cuentan

La Tasa K sigue siempre las mismas reglas, para que todos los visitantes vean la misma cifra:

- **Cuentan** las órdenes completadas (`success`) en las 24 horas hasta la última, en la moneda elegida, de los
  nodos del `.env`: firmadas por el nodo (comprobadas en el navegador) o, cuando su evento ya no está en
  los relays, de la base de datos del nodo (`tasak import-mostro`), sin firma y marcadas con ◌, confiando
  en quien publica el sitio.
- **No cuentan** las que no llegaron a completarse (abiertas, tomadas, canceladas, caducadas, en
  disputa); las de un método de pago de `HIDDEN_PAYMENT_METHODS` (con «Otros», texto que no está en la
  lista de la app de Mostro, y «Pruebas», órdenes de prueba: «prueba», «test», «no tomar»); ni las que no
  tienen un monto en moneda y en sats mayor que cero.
- No se descarta ningún precio por atípico, y cuentan tanto las órdenes a precio de mercado como las de
  precio fijo.

Los visitantes pueden elegir otros métodos de pago o nodos: la gráfica y las tablas siguen su elección, y
**Tu selección** muestra su precio ponderado de las 24 horas hasta su última orden junto a los filtros. La Tasa K de la
cabecera no cambia.

### La referencia del nodo

Desde Mostro 0.19 cada nodo elige sus fuentes de precio (Yadio, CoinGecko, Blockchain.com, currency-api,
fuentes del mercado local u otros nodos por Nostr), las combina y publica el resultado, firmado, en su evento
`mostro-rates`, con las fuentes en la etiqueta `source`; con ese mismo valor calcula las órdenes a
mercado. La cabecera dice «Referencia Yadio» si el nodo usa solo Yadio y «Referencia del nodo» si no, con
las fuentes al pasar el ratón; con varios nodos, es la más reciente de los que tienen órdenes en la moneda
elegida (todos publican todas las monedas, cada uno con su propia referencia). En el libro de órdenes cada
orden a mercado se calcula con los precios de su propio nodo, que este sigue usando hasta 30 minutos si no
puede actualizarlos; sin ellos, el precio se
estima con la API de Yadio y lleva «≈», y si tampoco hay, la orden aparece sin precio («—»).

Las compras y las ventas de BTC se cierran a precios distintos, porque cada lado pone su prima; la Tasa K
las pondera todas juntas. Solo como información, sin cambiar la tasa, al pasar el ratón sobre la Tasa K y
en la FAQ se ven el precio ponderado de las compras y el de las ventas de la ventana de la Tasa K, y cuántas
órdenes fueron a precio de mercado (con su prima media) o a precio fijo. Mercado o fijo sale de la versión
`pending` de la orden o, sin ella, de una prima distinta de 0 (Mostro no admite prima con precio fijo); las
órdenes con prima 0 de las que no se vio la versión `pending` cuentan como «sin saber».

La gráfica tiene tres modos:

- **Precio**: un punto por orden ejecutada, o por periodo (1h, 4h, 1D, 1W, 1M, 1Y) con el precio ponderado del periodo.
- **Velas**: apertura, máximo, mínimo y cierre de cada periodo.
- **Ponderado**: en cada punto, el precio ponderado por volumen de las 24 horas anteriores, `Σ(precio × monto) ÷ Σ monto`. Con un punto por orden, las 24 horas hasta esa orden: la Tasa K tras ella. Por periodo, las 24 horas hasta el cierre del periodo (o hasta ahora, en el actual): ese sí se mueve con el tiempo, y difiere de la Tasa K cuando el periodo cerró sin órdenes.

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
| Coinbase | BTC/USD histórico por hora, para la moneda/USD (la hora en que se tomó cada orden o, si no se sabe, en que se completó) | se calcula con el BTC/USD actual (el del nodo o el de Yadio) y se avisa de que es aproximado |

## Archivo

Los relays guardan las órdenes unos 15 días y solo su última versión: cuando una orden se completa,
desaparecen la versión `pending` (precio de mercado o fijo) y la `in-progress` (cuándo se tomó). Los
`mostro-rates` del nodo (precio de BTC en cada moneda, de sus fuentes de precio) caducan a los 10 minutos. Para tener el
historial completo, el servidor de tasaK (`tasak`) se suscribe a los relays del `.env` y guarda todo lo
que publica el nodo, verificado (firma, autor y tipo), en una base de datos SQLite, `data/tasak.sqlite`
(`ARCHIVE_DIR` para cambiar la carpeta):

- `events`: cada evento firmado tal cual llegó: órdenes de todas las monedas y todas sus versiones, cada
  `mostro-rates` y los metadatos del nodo cuando cambian. Cualquiera puede volver a verificarlos.
- `event_relays`: qué relays enviaron cada evento y cuándo, para comprobar qué relay tenía qué.
- `yadio`: el BTC/USD de Yadio cada 5 minutos de las últimas 24 h, para rellenar los huecos cuando el
  archivo estuvo apagado.
- `orders`: las órdenes completadas, derivadas cada minuto de `events` y de `node_orders` (más abajo).
  Las abiertas se leen en vivo de los relays, y las canceladas o caducadas nunca cuentan. Cada una tiene
  su versión vigente, si fue a precio de mercado o fijo, cuándo se tomó y su BTC/USD de ese momento con
  su origen: el `mostro-rates` del nodo o, si no lo hay, Coinbase (velas de 1 minuto) o Yadio.
- `btc_prices`: los cierres de BTC/USD de 1 minuto de Coinbase, cada uno pedido una vez y guardado.

Debe estar siempre encendido: lo que pase mientras está apagado se pierde, salvo la última versión de
cada orden. Cada relay tiene una suscripción en vivo y, cada 5 minutos, una puesta al día de su historial
reciente que cubre las desconexiones. Ocupa alrededor de 1 MB al día. `ARCHIVE=false` sirve el sitio
sin archivar.

Para que arranque solo como servicio, ver `server/tasak.service`. Los archivos diarios del antiguo
archivador en JavaScript (líneas `{"relay", "recibido", "evento"}`) se pueden importar; importarlos dos
veces no cambia nada:

```sh
tasak import-jsonl indexer/data/eventos/*.jsonl indexer/data/yadio/*.jsonl
```

El historial anterior al archivo lo puede recuperar el operador del nodo desde la base de datos de
Mostro. Sobre una copia (`sqlite3 mostro.db ".backup mostro-copia.db"`):

```sh
tasak import-mostro mostro-copia.db       # añade la clave pública del nodo si el .env tiene varios
```

Lee la copia en solo lectura e importa sus órdenes completadas (`success`) a la tabla `node_orders` del
archivo. Solo datos públicos de la operación (moneda, montos, prima, métodos de pago, horas, precio de
mercado o fijo), nunca claves, facturas ni la tabla de usuarios. Se unen a `orders`: una orden que
también está archivada como evento firmado conserva los datos del evento y toma de la base de datos lo
que los relays ya no tenían (cuándo se tomó, precio de mercado o fijo); las demás quedan marcadas como
sin firma («datos del nodo»). La base de datos no guarda la hora de completada: en esas se usa la del
bloqueo del escrow. Importar otra vez no cambia nada.

## Tasa publicada

Con el archivo encendido, cada 5 minutos el servidor calcula la Tasa K oficial desde su tabla `orders`,
con las mismas reglas que la cabecera (los nodos y la moneda del `.env`, los métodos de pago que no
oculta, y también las órdenes que solo vienen de la base de datos del nodo, marcadas como sin firma), y
la publica:

- **`/api/tasa.json`**: la tasa en moneda/BTC, moneda/USD y moneda/sat, las 24 h anteriores, su volumen
  y sus órdenes, su ventana, cuándo se actualizó y el id del evento firmado. Para bots, hojas de cálculo
  y aplicaciones que no hablan Nostr.
- **Un evento Nostr firmado**, si hay `SIGNING_KEY_FILE`: kind 30078 con `d = tasak`, contenido
  `{"BTC": {"CUP": …}, "tasak": {…}}`. La parte `tasak` lleva todo lo necesario para recalcularla sin
  relays ni Coinbase: cada orden de la ventana con sus montos, su momento y su BTC/USD (y su origen), si
  está firmada, la versión de las reglas y los decimales. Caduca a los 10 minutos.

- **`/api/snapshot.json`**: lo que necesita el sitio para pintar al instante, sin esperar a los relays:
  los eventos firmados de las órdenes completadas (todas sus versiones), el último `mostro-rates` y la
  información del nodo, las órdenes sin firma de la base de datos del nodo, el BTC/USD de cada orden con
  su origen y la última tasa firmada. No lleva las órdenes abiertas: el libro de órdenes sale en vivo de
  los relays.

Si hay clave, su clave pública va en `config.js` (`ratePubkey`), para que el sitio compruebe quién firmó
la tasa.

El sitio servido por `tasak` carga primero el snapshot y pinta al instante; después los relays añaden lo
nuevo. Verifica los eventos del snapshot como los de los relays (autor, tipo, firma), muestra la Tasa K
firmada solo si la firmó `ratePubkey` (con un ⚠ si no coincide con la que calcula con los mismos datos),
marca las órdenes sin firma (◌) y dice la antigüedad de los datos del servidor. A los relays les pide
solo los últimos 7 días (más si las órdenes del nodo duran más) y avisa si el servidor no tiene alguna
orden completada que ellos sí. Sin el servidor, o si
falla, funciona como antes, solo con los relays.

Su ventana termina siempre en la última orden completada (`to`); `empty_since` dice desde cuándo no hay
órdenes en las últimas 24 horas. Los valores se
redondean a `RATE_DECIMALS` decimales, como `toFixed` de JavaScript.

La clave debe ser solo para esto (ni la del nodo Mostro ni una personal) y estar fuera del repositorio:
`tasak` rechaza una clave dentro de `web/` o de la carpeta del archivo, o que puedan leer otros usuarios.

```sh
tasak keygen ~/.config/tasak/nsec    # muestra su npub; después SIGNING_KEY_FILE=~/.config/tasak/nsec
```

La Tasa K dice a qué precio se está cambiando la moneda; no está pensada como fuente de precio de mercado
para Mostro (por eso `d = tasak` y no `mostro-rates`): un nodo que pusiera precio a sus órdenes con ella
se la devolvería a sí mismo a través de las primas.

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
| `shared/test/` | pruebas de `shared/` (`node --test 'shared/test/*.test.js'`, Node ≥ 22), datos reales fijos (`fixtures/`), los valores de referencia que el código debe reproducir (`expected.json`) y casos escritos a mano (`cases.json`): los vectores que también pasa la versión en Rust de esta lógica (`server/src/logic/`) |
| `server/` | el servidor de tasaK en Rust (`tasak`): lee el `.env`, genera `web/config.js`, sirve `web/` y archiva los eventos del nodo; su servicio de systemd es `server/tasak.service`. `src/logic/` es la lógica de `shared/` en Rust, comprobada con los mismos vectores (`server/tests/shared_vectors.rs`); `server/tests/config-cases.json` es el `web/config.js` que debe salir de cada `.env` (`cargo test`) |
| `tools/` | comprobaciones de desarrollo en Chrome headless (Node, sin dependencias); `node tools/reference.mjs` comprueba que `web/` calcula con datos fijos los valores de `shared/test/expected.json`, sin el servidor; `node tools/snapshot.mjs`, con el snapshot de un servidor y una tasa firmada |

## Idiomas

La página está en español e inglés. El idioma se elige, por este orden: `?lang=` en la URL,
el selector ES · EN (se recuerda en el navegador), `LANGUAGE` del `.env` y, si no, el idioma del navegador.
Los textos originales están en español; las traducciones están en `web/i18n.js` (`EN`). Para añadir
otro idioma basta con otro diccionario igual.

## Licencia

[MIT](LICENSE). El código de terceros en `web/vendor/` mantiene sus propias licencias (ver `web/vendor/README.md`).
