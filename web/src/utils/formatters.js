export const currency = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

export const preciseCurrency = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

export const number = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 2,
});

export const percent = (value = 0) => `${value >= 0 ? '+' : ''}${number.format(value)}%`;

export const date = (value) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(value));
};

export const dateTime = (value) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  }).format(new Date(value));
};

export const relativeDuration = (target, base = new Date()) => {
  if (!target) return '—';
  const diffMs = new Date(target).getTime() - new Date(base).getTime();
  if (!Number.isFinite(diffMs)) return '—';
  if (diffMs <= 0) return '已到期';

  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天${hours > 0 ? `${hours}小时` : ''}后`;
  if (hours > 0) return `${hours}小时${minutes > 0 ? `${minutes}分` : ''}后`;
  return `${minutes}分钟后`;
};

export const compactCurrency = (value = 0) => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${value < 0 ? '-' : ''}€${number.format(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${value < 0 ? '-' : ''}€${number.format(abs / 1_000)}K`;
  return preciseCurrency.format(value);
};

export const pnlColor = (value, theme) => {
  if (value > 0) return theme.palette.success.main;
  if (value < 0) return theme.palette.error.main;
  return theme.palette.text.secondary;
};
