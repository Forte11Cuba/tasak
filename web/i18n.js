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
  'últimas 24h': 'last 24h',
  'Cambio respecto a las 24 horas anteriores': 'Change from the previous 24 hours',
  'Referencia Yadio': 'Yadio reference',
  'Tasa de referencia de Yadio, la que usa Mostro para las órdenes a precio de mercado': 'Yadio reference rate, used by Mostro for market-price orders',
  'Volumen total': 'Total volume',
  'Volumen · {range}': 'Volume · {range}',
  'Última orden': 'Last order',
  'Precio de la última orden completada': 'Price of the last completed order',
  'Moneda': 'Currency',
  'Nodo': 'Node',
  'Cuántos {f} cuesta 1 sat: {f} pagados ÷ sats de cada orden, sin conversión a USD': 'How many {f} 1 sat costs: {f} paid ÷ sats of each order, no USD conversion',
  'la moneda local': 'the local currency',
  'Información del nodo Mostro': 'Mostro node information',
  'Información del nodo Mostro: comisión, condiciones, comunidad y redes': 'Mostro node information: fee, terms, community and social links',
  'ⓘ Nodo Mostro': 'ⓘ Mostro node',
  'Preguntas frecuentes': 'Frequently asked questions',
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
  'Falta config.js: ejecuta "node build.mjs" o pasa ?mostro=…&relays=… en la URL': 'config.js is missing: run "node build.mjs" or pass ?mostro=…&relays=… in the URL',
  // Header figures
  '{n} orden': '{n} order',
  '{n} órdenes': '{n} orders',
  'cambio vs 24h anteriores': 'change vs previous 24h',
  'sin órdenes en las últimas 24h': 'no orders in the last 24h',
  'desde {d}': 'since {d}',
  'sobre Yadio': 'above Yadio',
  'bajo Yadio': 'below Yadio',
  'compra de BTC': 'BTC buy',
  'venta de BTC': 'BTC sell',
  '{n} nodos Mostro': '{n} Mostro nodes',
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
  'Evento': 'Event',
  'clic para ver el evento firmado': 'click to see the signed event',
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
  'Arrastra para cambiar el tamaño del order book y las órdenes ejecutadas': 'Drag to resize the order book and executed orders',
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
  'Precio de mercado + prima': 'Market price + premium',
  'Libro cruzado': 'Crossed book',
  '(hay compradores por encima de vendedores)': '(buyers above sellers)',
  'Nadie vendiendo BTC ahora': 'Nobody selling BTC right now',
  'Nadie comprando BTC ahora': 'Nobody buying BTC right now',
  // Nostr event
  'Evento Nostr de la orden': 'Nostr event of the order',
  'Cerrar': 'Close',
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
  'El nodo en Nostr': 'The node on Nostr',
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
  'Pubkey Lightning': 'Lightning pubkey',
  'Relays del nodo': 'Node relays',
  'Información publicada': 'Information published',
  'protocolo {v}': 'protocol {v}',
  'Órdenes completadas': 'Completed orders',
  '(lo que guardan los relays, ~15 días)': '(what relays keep, ~15 days)',
  'Volumen en {f}': 'Volume in {f}',
  'Órdenes abiertas ahora': 'Open orders now',
  '← Volver a la tasa': '← Back to the rate',
  'Cargando la información del nodo desde los relays…': 'Loading node information from relays…',
  'No hay nodos configurados: ejecuta «node build.mjs» o pasa ?mostro=… en la URL.': 'No nodes configured: run "node build.mjs" or pass ?mostro=… in the URL.',
  'Esta página no funciona abierta como archivo. Sírvela con un servidor web: en la carpeta del repositorio ejecuta «{cmd}» y abre {url}': 'This page does not work opened as a file. Serve it with a web server: in the repository folder run «{cmd}» and open {url}',
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
    el.innerHTML = LANGS.map(l =>
      `<button data-lang-btn="${l}" class="${l === LANG ? 'on' : ''}" title="${l === 'es' ? 'Español' : 'English'}">${l.toUpperCase()}</button>`).join('');
    el.onclick = e => {
      const b = e.target.closest('[data-lang-btn]');
      if (b && b.dataset.langBtn !== LANG) setLang(b.dataset.langBtn);
    };
  }
});
