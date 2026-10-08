// Formatting of prices and percentages (the rest, fmtInt, fmtTime… are in common.js).

export const fmtPrice = p => p == null ? '—' : p === 0 ? '0' : p >= 1e6 ? (p / 1e6).toFixed(2) + 'M'
  : p >= 100 ? p.toLocaleString(LOCALE, { maximumFractionDigits: 2 })
  : p.toLocaleString(LOCALE, { minimumFractionDigits: p >= 10 ? 2 : 4, maximumFractionDigits: p >= 10 ? 2 : 4 });

// Percentage in the language's format: +6,00 % (es), +6.00% (en)
export const fmtPct = (c, digits = 2) =>
  `${c >= 0 ? '+' : '−'}${Math.abs(c).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${LANG === 'en' ? '' : ' '}%`;
