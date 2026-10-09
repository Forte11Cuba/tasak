// Formatting of prices and percentages (the rest, fmtInt, fmtTime… are in common.js).

export const fmtPrice = p => p == null ? '—' : p === 0 ? '0' : p >= 1e6 ? (p / 1e6).toFixed(2) + 'M'
  : p >= 100 ? p.toLocaleString(LOCALE, { maximumFractionDigits: 2 })
  : p.toLocaleString(LOCALE, { minimumFractionDigits: p >= 10 ? 2 : 4, maximumFractionDigits: p >= 10 ? 2 : 4 });

// How long ago, roughly: 5 min, 3 h, 2 días
export const fmtAgo = s => s < 3600 ? t('{n} min', { n: Math.max(1, Math.round(s / 60)) })
  : s < 2 * 86400 ? t('{n} h', { n: Math.round(s / 3600) }) : t('{n} días', { n: Math.round(s / 86400) });

// Percentage in the language's format: +6,00 % (es), +6.00% (en)
export const fmtPct = (c, digits = 2) =>
  `${c >= 0 ? '+' : '−'}${Math.abs(c).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${LANG === 'en' ? '' : ' '}%`;
