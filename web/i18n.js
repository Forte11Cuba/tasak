// Page language (Spanish or English) and text translation.
//
// The original text is Spanish. t('Spanish text', { variables }) returns its translation in the
// chosen language. In the HTML:
//   data-i18n          the element's text is translated
//   data-i18n-title    the title attribute (and aria-label) is translated
//   data-lang="es|en"  long blocks written in both languages; only the chosen one is shown
//
// Language: ?lang= in the URL > choice saved in this browser > LANGUAGE in .env > browser.

const LANGS = ['es', 'en'];
const LANG = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try { const s = localStorage.getItem('tasak.lang'); if (LANGS.includes(s)) return s; } catch {}
  const c = window.TASAK_CONFIG?.language;
  if (LANGS.includes(c)) return c;
  return (navigator.language || 'es').toLowerCase().startsWith('es') ? 'es' : 'en';
})();
document.documentElement.lang = LANG;
const LOCALE = LANG === 'en' ? 'en-US' : 'es';

const EN = {
  // Header and bar
  'Cambio respecto a las 24 horas anteriores': 'Change from the previous 24 hours',
  'Referencia Yadio': 'Yadio reference',
  'Referencia del nodo': 'Node reference',
  'Referencia {s}': '{s} reference',
  'Fuentes del nodo (de todas sus monedas): {s}': "The node's sources (for all its currencies): {s}",
  'Fuente: {s}': 'Source: {s}',
  'Precio de referencia del nodo, el que usa para las órdenes a precio de mercado': "The node's reference price, which it uses for market-price orders",
  'Tasa de referencia de Yadio, la que usa Mostro para las órdenes a precio de mercado': 'Yadio reference rate, used by Mostro for market-price orders',
  'Volumen total': 'Total volume',
  'Volumen · {range}': 'Volume · {range}',
  'Última orden': 'Last order',
  'Precio de la última orden completada': 'Price of the last completed order',
  'Moneda': 'Currency',
  'Nodo': 'Node',
  'Cuántos {f} cuesta 1 sat: {f} pagados ÷ sats de cada orden, sin conversión a USD': 'How many {f} 1 sat costs: {f} paid ÷ sats of each order, no USD conversion',
  'la moneda local': 'the local currency',
  'Información del nodo Mostro: comisión, condiciones, comunidad y redes': 'Mostro node information: fee, terms, community and social links',
  'Preguntas frecuentes': 'Frequently asked questions',
  'Sin precio: el nodo no publica mostro-rates válidos y la API de Yadio no respondió': 'No price: the node publishes no valid mostro-rates and Yadio\'s API did not respond',
  'Consultada a la API de Yadio: el nodo no publica mostro-rates válidos': 'From Yadio\'s API: the node publishes no valid mostro-rates',
  'Publicada por el nodo {node} hace {m} min en un evento firmado (mostro-rates)': 'Published by the node {node} {m} min ago in a signed event (mostro-rates)',
  '? Ayuda': '? FAQ',
  'Idioma': 'Language',
  'Tema claro': 'Light theme',
  'Tema oscuro': 'Dark theme',
  // Status
  'Conectando…': 'Connecting…',
  'Conectando con los relays…': 'Connecting to relays…',
  'En vivo: {live} de {total} relays conectados': 'Live: {live} of {total} relays connected',
  '✓ firmas': '✓ signatures',
  'Firmas de los eventos verificadas en este navegador': 'Event signatures verified in this browser',
  '⚠ sin verificar': '⚠ unverified',
  'Firmas sin verificar: no cargó nostr-tools': 'Signatures not verified: nostr-tools did not load',
  '⚠ {n} rechazados': '⚠ {n} rejected',
  '{n} eventos rechazados por firma no válida': '{n} events rejected for invalid signature',
  '⚠ USD aprox.': '⚠ approx. USD',
  'USD aproximado: sin precio histórico de Coinbase, se usa el BTC/USD actual de Yadio': 'Approximate USD: no historical price from Coinbase, using the current Yadio BTC/USD',
  'Configuración sin nodos o sin relays válidos': 'Configuration has no valid nodes or relays',
  'Falta config.js: ejecuta «tasak build» o pasa ?mostro=…&relays=… en la URL': 'config.js is missing: run "tasak build" or pass ?mostro=…&relays=… in the URL',
  // Header figures
  '{n} orden': '{n} order',
  '{n} órdenes': '{n} orders',
  'cambio vs 24h anteriores': 'change vs previous 24h',
  'sin órdenes en las últimas 24h': 'no orders in the last 24h',
  'Tu selección': 'Your selection',
  'Elegir nodo Mostro': 'Choose Mostro node',
  'Pegar npub…': 'Paste npub…',
  'Ver': 'View',
  'npub de un nodo Mostro': 'npub of a Mostro node',
  'No es una npub ni una clave pública válida': 'Not a valid npub or public key',
  'Nodo que no es de este sitio: la {rate} se calcula en este navegador con sus órdenes de los relays, con todos los métodos de pago salvo las pruebas, y este sitio no la firma': 'A node not of this site: the {rate} is calculated in this browser from its orders on the relays, with every payment method except tests, and this site doesn\'t sign it',
  '{n} min': '{n} min',
  '⚠ faltan {n}': '⚠ {n} missing',
  'El servidor no tiene {n} órdenes completadas de los últimos días que sí están en los relays: se muestran igualmente': "The server lacks {n} completed orders of the last days that the relays have: they are shown anyway",
  '{n} h': '{n} h',
  '{n} días': '{n} days',
  'sin órdenes 24h · de hace {t}': 'no orders 24h · from {t} ago',
  'Sin órdenes completadas en las últimas 24 horas: es la última {rate}, la de las 24 horas anteriores a la última orden, de hace {t}': 'No orders completed in the last 24 hours: this is the last {rate}, that of the 24 hours before the last order, from {t} ago',
  'La {rate} firmada por el servidor ({s}) no coincide con la calculada en este navegador con los mismos datos ({l})': "The {rate} signed by the server ({s}) doesn't match the one computed in this browser with the same data ({l})",
  'Datos del servidor de hace {t}: órdenes completadas, precios y {rate} firmada; lo nuevo llega de los relays': "Server data from {t} ago: completed orders, prices and the signed {rate}; what's new comes from the relays",
  'Orden de la base de datos del nodo, sin firma: ver detalles': "Order from the node's database, unsigned: see details",
  'Sin firma: de la base de datos del nodo': "Unsigned: from the node's database",
  'sin firma: viene de la base de datos del nodo, porque su evento ya no está en los relays. Se confía en quien publica este sitio': "unsigned: it comes from the node's database, because its event is no longer on the relays. It relies on whoever publishes this site",
  '{p} frente a la {rate}': '{p} vs the {rate}',
  'Volver a los métodos de pago y nodos por defecto': 'Back to the default payment methods and nodes',
  'Precio ponderado de las órdenes completadas en las 24 horas hasta la última, con los métodos de pago y nodos que elegiste. La {rate} usa siempre los de por defecto.': 'Weighted price of the orders completed in the 24 hours up to the last one, with the payment methods and nodes you chose. The {rate} always uses the default ones.',
  'desde {d}': 'since {d}',
  'sobre la referencia': 'above the reference',
  'sobre {s}': 'above {s}',
  'bajo {s}': 'below {s}',
  'bajo la referencia': 'below the reference',
  'compra de BTC': 'BTC buy',
  'compra': 'buy',
  'Vista': 'View',
  'Qué se ve sobre la gráfica': 'What is shown over the chart',
  'Datos del punto': 'Point data',
  'Par de fondo': 'Pair in the background',
  'Mostrar solo el primero': 'Show only the first one',
  'venta': 'sell',
  'venta de BTC': 'BTC sell',
  '{rate}: precio ponderado de las órdenes completadas en las 24 horas hasta la última orden ({t})': '{rate}: weighted price of the orders completed in the 24 hours up to the last order ({t})',
  'Compras de BTC: {n}, media {p} {u}': 'BTC buys: {n}, average {p} {u}',
  'Ventas de BTC: {n}, media {p} {u}': 'BTC sells: {n}, average {p} {u}',
  '{n} a precio de mercado': '{n} at market price',
  'prima media {p}': 'average premium {p}',
  '{n} a precio fijo': '{n} at fixed price',
  '{n} sin saber (prima 0)': '{n} unknown (premium 0)',
  'Solo información: la {rate} pondera todas juntas': 'For information only: the {rate} weighs them all together',
  // Chart
  'Precio': 'Price',
  'Velas': 'Candles',
  'Ponderado': 'Weighted',
  'Precio ponderado por volumen de las 24 horas anteriores a cada punto: Σ(precio × monto) ÷ Σ monto': 'Volume-weighted price of the 24 hours before each point: Σ(price × amount) ÷ Σ amount',
  'Temporalidad': 'Timeframe',
  'Órdenes': 'Orders',
  'Cada orden': 'Each order',
  'Un punto por orden ejecutada': 'One point per executed order',
  'Horas': 'Hours',
  '1 hora': '1 hour',
  '4 horas': '4 hours',
  'Días': 'Days',
  '1 día': '1 day',
  'Semanas': 'Weeks',
  '1 semana': '1 week',
  'Meses': 'Months',
  '1 mes': '1 month',
  'Años': 'Years',
  '1 año': '1 year',
  'Orden': 'Order',
  'Método de pago': 'Payment method',
  'Pantalla completa': 'Full screen',
  'Salir de pantalla completa': 'Exit full screen',
  'Ocultar volumen': 'Hide volume',
  'Mostrar volumen': 'Show volume',
  'Cargando órdenes de los relays…': 'Loading orders from relays…',
  'No hay órdenes completadas con estos filtros': 'No completed orders with these filters',
  'semana del {d}': 'week of {d}',
  'sin órdenes': 'no orders',
  'sin órdenes en las 24h anteriores': 'no orders in the previous 24h',
  '{n} órdenes · {vol} en las 24h anteriores': '{n} orders · {vol} in the previous 24h',
  '{n} orden · {vol} en las 24h anteriores': '{n} order · {vol} in the previous 24h',
  'A': 'O', 'Máx': 'H', 'Mín': 'L', 'C': 'C',
  // Payment methods (names shown)
  'Saldo móvil': 'Mobile top-up',
  'Pruebas': 'Tests',
  'Otros': 'Other',
  'Efectivo': 'Cash',
  'Transferencia': 'Bank transfer',
  'Sin método': 'No method',
  '{d} completadas · {o} abiertas': '{d} completed · {o} open',
  // Order book and executed orders
  'intenciones abiertas': 'open intentions',
  'Monto': 'Amount',
  'Prima': 'Premium',
  'Método': 'Method',
  'Hora': 'Time',
  'Libro de órdenes': 'Order book',
  'Diferencial': 'Spread',
  'Arrastra para cambiar el tamaño del libro de órdenes y las órdenes ejecutadas': 'Drag to resize the order book and executed orders',
  'Órdenes ejecutadas': 'Executed orders',
  'atenuadas: más de 24h': 'dimmed: older than 24h',
  'la última hora': 'the last hour',
  'las últimas 4 horas': 'the last 4 hours',
  'las últimas 24 horas': 'the last 24 hours',
  'los últimos 7 días': 'the last 7 days',
  'los últimos 30 días': 'the last 30 days',
  'el último año': 'the last year',
  'Sin órdenes completadas': 'No completed orders',
  'Sin órdenes completadas en {range}': 'No completed orders in {range}',
  'Ver el evento Nostr de esta orden': 'See the Nostr event of this order',
  'Ver el evento Nostr de esta orden abierta': 'See the Nostr event of this open order',
  'Orden de compra de BTC': 'BTC buy order',
  'Orden de venta de BTC': 'BTC sell order',
  'precio fijo': 'fixed price',
  'precio de mercado, prima {p}%': 'market price, {p}% premium',
  'prima {p}%': '{p}% premium',
  'Precio fijo': 'Fixed price',
  'Precio de mercado del nodo + prima': "The node's market price + premium",
  'Precios del nodo sin actualizar: los sigue usando hasta 30 min': "The node's prices are not updated: it keeps using them for up to 30 min",
  'Precio estimado con Yadio + prima: el nodo no publica el suyo': "Estimated with Yadio + premium: the node doesn't publish its own",
  'El nodo usa: {s}': 'The node uses: {s}',
  'Sin precio: el nodo no publica el suyo y la API de Yadio no respondió': "No price: the node doesn't publish its own and Yadio's API didn't respond",
  'Libro cruzado': 'Crossed book',
  '(hay compradores por encima de vendedores)': '(buyers above sellers)',
  'Nadie vendiendo BTC ahora': 'Nobody selling BTC right now',
  'Nadie comprando BTC ahora': 'Nobody buying BTC right now',
  // Nostr event
  'Evento Nostr de la orden': 'Nostr event of the order',
  'Cerrar': 'Close',
  'Copiar la npub': 'Copy the npub',
  'Ver su último evento en Nostr Inspect ↗': 'See its latest event on Nostr Inspect ↗',
  'Copiar JSON': 'Copy JSON',
  'Copiado ✓': 'Copied ✓',
  'No se pudo copiar': 'Could not copy',
  'Verificar en Nostr Inspect ↗': 'Verify on Nostr Inspect ↗',
  'Estado': 'Status',
  'Fecha': 'Date',
  'Métodos de pago': 'Payment methods',
  'Caduca': 'Expires',
  'Id del evento': 'Event id',
  'Firma': 'Signature',
  'verificada en este navegador': 'verified in this browser',
  'sin verificar (no cargó nostr-tools)': 'not verified (nostr-tools did not load)',
  'abierta, esperando a que alguien la tome': 'open, waiting for someone to take it',
  'completada': 'completed',
  'cancelada': 'canceled',
  'caducada': 'expired',
  'precio fijo: {n} sats': 'fixed price: {n} sats',
  'precio de mercado (Yadio) {p} % de prima': 'market price (Yadio) {p}% premium',
  // Node information
  'Nodo Mostro': 'Mostro node',
  'Web del nodo': 'Node website',
  'Comunidad': 'Community',
  'Comunidad:': 'Community:',
  'Eventos del nodo en Nostr': 'The node\'s events on Nostr',
  'Nostr de la comunidad': 'Community on Nostr',
  'Condiciones': 'Terms',
  'Comisión del nodo': 'Node fee',
  '{p} del monto de cada orden': '{p} of each order amount',
  'Monto por orden': 'Amount per order',
  'Una orden publicada dura': 'A published order lasts',
  'Tiempo para seguir una orden tomada': 'Time to continue a taken order',
  '⚠ en mantenimiento': '⚠ under maintenance',
  '● operativo': '● operational',
  'El nodo aún no ha enviado su información (evento kind 38385).': 'The node has not published its information yet (kind 38385 event).',
  'Actividad': 'Activity',
  'Técnico': 'Technical',
  'Nodo Lightning': 'Lightning node',
  'Clave pública': 'Pubkey',
  'Clave pública del nodo Lightning': 'Lightning node pubkey',
  'Relays del nodo': 'Node relays',
  'Información publicada': 'Information published',
  'protocolo {v}': 'protocol {v}',
  'Órdenes completadas': 'Completed orders',
  '(lo que guardan los relays, ~15 días)': '(what relays keep, ~15 days)',
  'Volumen en {f}': 'Volume in {f}',
  'Órdenes abiertas ahora': 'Open orders now',
  '← Volver a la tasa': '← Back to the rate',
  'Cargando la información del nodo desde los relays…': 'Loading node information from relays…',
  'No hay nodos configurados: ejecuta «tasak build» o pasa ?mostro=… en la URL.': 'No nodes configured: run "tasak build" or pass ?mostro=… in the URL.',
  'Esta página no funciona abierta como archivo. Sírvela con un servidor web: en la carpeta del repositorio ejecuta «{cmd}» y abre {url}': 'This page does not work opened as a file. Serve it with a web server: in the repository folder run «{cmd}» and open {url}',
  // Other P2P platforms (kind 35353)
  'Cargando…': 'Loading…',
  'cargando…': 'loading…',
  'Plataforma': 'Platform',
  'Plataforma desconocida: {p}': 'Unknown platform: {p}',
  'Elegir plataforma': 'Choose a platform',
  'Cuenta': 'Account',
  'Cuenta de Nostr que firma las órdenes y operaciones de {p}': 'The Nostr account that signs the orders and trades of {p}',
  'Otra plataforma P2P, no un nodo Mostro: la {rate} de {p} se calcula en este navegador con sus operaciones firmadas de los relays, por activo, moneda y método de pago, y este sitio no la firma': "Another P2P platform, not a Mostro node: {p}'s {rate} is computed in this browser from its signed trades on the relays, per asset, currency and payment method, and this site doesn't sign it",
  '1 relay no acepta los eventos de otras plataformas (kind 35353)': "1 relay doesn't accept the events of other platforms (kind 35353)",
  '{n} relays no aceptan los eventos de otras plataformas (kind 35353)': "{n} relays don't accept the events of other platforms (kind 35353)",
  '{n} eventos ignorados por no seguir el formato del NIP': "{n} events ignored because they don't follow the NIP's format",
  'Compras de {a}: {n}, media {p} {u}': '{a} buys: {n}, average {p} {u}',
  'Ventas de {a}: {n}, media {p} {u}': '{a} sells: {n}, average {p} {u}',
  'Sin operaciones': 'No trades',
  '{rate} de {p} con {m}: precio ponderado de sus operaciones firmadas con ese método en las 24 horas hasta la última ({t}). Se calcula en este navegador; no es la {rate} oficial de este sitio.': "{p}'s {rate} with {m}: weighted price of its signed trades with that method in the 24 hours up to the last one ({t}). Computed in this browser; it is not this site's official {rate}.",
  'Operaciones y órdenes que guardan los relays, leídas en este navegador': 'Trades and orders the relays keep, read in this browser',
  '{rate} de las operaciones con {m}: cada método es un mercado con su propio precio': '{rate} of the trades with {m}: each method is a market with its own price',
  '{d} operaciones · {o} abiertas': '{d} trades · {o} open',
  'No se elige por defecto': "Not chosen by default",
  'compra de {a}': '{a} buy',
  'venta de {a}': '{a} sell',
  'Orden de compra de {a}': '{a} buy order',
  'Orden de venta de {a}': '{a} sell order',
  'de la propia plataforma': "the platform's own",
  'Precio fijo de la orden': "The order's fixed price",
  'Sin precio: prima sobre un precio de mercado de la plataforma, que no se publica': "No price: a premium over a market price of the platform's, which isn't published",
  'Nadie vendiendo {a} ahora': 'Nobody selling {a} now',
  'Nadie comprando {a} ahora': 'Nobody buying {a} now',
  'Activo': 'Asset',
  'Saldo en una cuenta de {p}, no en una cadena de bloques: solo vale dentro de la plataforma': 'A balance in a {p} account, not on a blockchain: it only has value inside the platform',
  'Activo en {l} ({n}){c}': 'Asset on {l} ({n}){c}',
  'Tipo': 'Type',
  'operación: ejecución de una orden': 'trade: the execution of an order',
  'orden abierta': 'open order',
  'publicada {d}': 'published {d}',
  'Publicada por': 'Published by',
  'la propia plataforma': 'the platform itself',
  'un usuario': 'a user',
  'un bot de un usuario': "a user's bot",
  'un creador de mercado': 'a market maker',
  'precio {p}': 'price {p}',
  'precio fijo {p}': 'fixed price {p}',
  'prima {p} % sobre un precio de mercado de la plataforma': "{p}% premium over a market price of the platform's",
};

// Translates a Spanish text and fills in {variables}
function t(s, vars) {
  let r = LANG === 'en' ? (EN[s] ?? s) : s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return r;
}
// «1 orden» / «3 órdenes»
const nOrders = n => t(n === 1 ? '{n} orden' : '{n} órdenes', { n });

// Translates the texts marked in the HTML
function applyI18n(root = document) {
  if (LANG === 'es') return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.textContent.trim());
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.title);
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
  }
}

// ES | EN switch: saves the choice and reloads the page in that language
function setLang(l) {
  try { localStorage.setItem('tasak.lang', l); } catch {}
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.href = u.toString();
}
document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  for (const el of document.querySelectorAll('.lang-switch')) {
    el.setAttribute('aria-label', t('Idioma'));
    el.innerHTML = LANGS.map(l =>
      `<button data-lang-btn="${l}" class="${l === LANG ? 'on' : ''}" title="${l === 'es' ? 'Español' : 'English'}">${l.toUpperCase()}</button>`).join('');
    el.onclick = e => {
      const b = e.target.closest('[data-lang-btn]');
      if (b && b.dataset.langBtn !== LANG) setLang(b.dataset.langBtn);
    };
  }
});
