import Papa from 'papaparse';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const csvPath = resolve(root, 'data/Transaktionsexport(2).csv');
const pdfTextPath = resolve(root, 'data/asset_overview_extracted.txt');
const outPath = resolve(root, 'public/data/portfolio-summary.json');

const parseNumber = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

const formatMonth = (date) => String(date || '').slice(0, 7);
const normalizeAsset = (asset) => asset || 'CASH';
const dividendTypes = new Set(['DIVIDEND', 'DISTRIBUTION', 'DIVIDEND_EQUIVALENT_PAYMENT', 'INTEREST_PAYMENT']);
const tradingTypes = new Set(['BUY', 'SELL', 'DIVIDEND', 'DISTRIBUTION', 'REDEMPTION', 'TILG', 'INTEREST_PAYMENT', 'DIVIDEND_EQUIVALENT_PAYMENT']);

const isinPattern = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;
const quantityPattern = /^\d+(?:[,.]\d+)?\s+Stk\.$/;
const amountPattern = /^\d{1,3}(?:\.\d{3})*,\d{2,6}(?:\s+(?:EUR|USD))?$|^\d+[,]\d+(?:\s+(?:EUR|USD))?$/i;
const sectionHeaderPattern = /^(ANZAHL POSITIONEN|AKTIEN|DERIVATE|ZINSPRODUKTE|CASH|Aufstellung|STK\. \/ NOMINALE|WERTPAPIERBEZEICHNUNG|KURS PRO STÜCK|KURSWERT IN EUR|PRODUKT|SALDO)/i;
const metadataPattern = /^(ISIN:|Lagerland:|Wertpapierrechnung|TRADE REPUBLIC BANK GMBH|30\.04\.2026)/i;
const derivativeIssuerPattern = /(GmbH|AG|Société Générale|HSBC|UBS|Morgan Stanley|J\.P\. Morgan|Goldman Sachs|Citigroup|BNP|Vontobel|UniCredit|DZ BANK|Deutsche Bank)/i;

const buildIsinNameMap = () => {
  if (!existsSync(pdfTextPath)) return new Map();
  const lines = readFileSync(pdfTextPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const map = new Map();

  lines.forEach((line, index) => {
    const match = line.match(isinPattern);
    if (!match) return;
    const isin = match[0];
    const nameLines = [];
    for (let cursor = index - 1; cursor >= 0 && nameLines.length < 4; cursor -= 1) {
      const candidate = lines[cursor];
      if (
        isinPattern.test(candidate) ||
        quantityPattern.test(candidate) ||
        amountPattern.test(candidate) ||
        metadataPattern.test(candidate) ||
        sectionHeaderPattern.test(candidate)
      ) {
        break;
      }
      nameLines.unshift(candidate);
    }
    if (!nameLines.length) return;

    const [first, ...rest] = nameLines;
    const isDerivative = derivativeIssuerPattern.test(first) && rest.length > 0;
    const displayName = isDerivative ? `${rest.join(' ')} · ${first}` : nameLines.join(' · ');
    map.set(isin, {
      isin,
      displayName,
      pdfName: nameLines.join(' · '),
      issuer: isDerivative ? first : '',
      instrument: isDerivative ? rest.join(' ') : nameLines[0],
    });
  });

  return map;
};

const isinNameMap = buildIsinNameMap();

const extractIssuerFromDescription = (row) => {
  const description = row.description || '';
  if (!row.symbol || !description.includes(row.symbol)) return '';
  const match = description.match(new RegExp(`${row.symbol}\\s+(.+?)(?:,\\s*quantity|$)`, 'i'));
  return match?.[1]?.trim() || '';
};

const buildDisplayName = (row, pdfInfo) => {
  const csvName = row.name || row.description || row.symbol || 'Unknown';
  const issuerFromCsv = extractIssuerFromDescription(row) || (row.symbol ? issuerBySymbol.get(row.symbol) : '');
  if (row.asset_class === 'BOND' && issuerFromCsv) {
    return `${issuerFromCsv} · ${csvName}`;
  }
  return pdfInfo?.displayName || csvName;
};

const csv = readFileSync(csvPath, 'utf8');
const { data: rows, errors } = Papa.parse(csv, {
  header: true,
  skipEmptyLines: true,
  dynamicTyping: false,
});

if (errors.length) {
  console.warn('CSV parse warnings:', errors.slice(0, 5));
}

const issuerBySymbol = new Map();
for (const row of rows) {
  if (!row.symbol) continue;
  const issuer = extractIssuerFromDescription(row);
  if (issuer && !issuerBySymbol.has(row.symbol)) {
    issuerBySymbol.set(row.symbol, issuer);
  }
}

const bySymbol = new Map();
const monthly = new Map();
const dividendMonthly = new Map();
const dividendBySymbol = new Map();
const dividendRecords = [];
const assetTotals = new Map();
let totalDeposits = 0;
let totalWithdrawals = 0;
let tradingCashflow = 0;
let realizedPnl = 0;
let income = 0;
let fees = 0;
let taxes = 0;

const ensurePosition = (row) => {
  const symbol = row.symbol || `${row.name || 'Unknown'}-${row.asset_class || 'CASH'}`;
  if (!bySymbol.has(symbol)) {
    const pdfInfo = isinNameMap.get(symbol);
    const issuerFromCsv = extractIssuerFromDescription(row);
    bySymbol.set(symbol, {
      symbol,
      name: row.name || 'Unknown',
      displayName: buildDisplayName(row, pdfInfo),
      pdfName: pdfInfo?.pdfName || '',
      issuer: issuerFromCsv || pdfInfo?.issuer || '',
      instrument: pdfInfo?.instrument || '',
      assetClass: normalizeAsset(row.asset_class),
      quantity: 0,
      costBasis: 0,
      realizedPnl: 0,
      income: 0,
      fees: 0,
      taxes: 0,
      lastPrice: 0,
      lastTradeDate: row.date,
      buys: 0,
      sells: 0,
    });
  }
  const position = bySymbol.get(symbol);
  const pdfInfo = isinNameMap.get(symbol);
  const issuerFromCsv = extractIssuerFromDescription(row);
  position.name = row.name || position.name;
  position.displayName = buildDisplayName(row, pdfInfo) || position.displayName || position.name;
  position.pdfName = pdfInfo?.pdfName || position.pdfName;
  position.issuer = issuerFromCsv || pdfInfo?.issuer || position.issuer;
  position.instrument = pdfInfo?.instrument || position.instrument;
  position.assetClass = normalizeAsset(row.asset_class) || position.assetClass;
  position.lastTradeDate = row.date || position.lastTradeDate;
  return position;
};

const addMonthly = (row, bucket, amount) => {
  const month = formatMonth(row.date);
  if (!month) return;
  if (!monthly.has(month)) {
    monthly.set(month, { month, deposits: 0, withdrawals: 0, buys: 0, sells: 0, income: 0, fees: 0, taxes: 0 });
  }
  monthly.get(month)[bucket] += amount;
};

const addDividendRecord = (row, amount, tax) => {
  const month = formatMonth(row.date);
  const symbol = row.symbol || row.name || 'Unknown';
  const pdfInfo = row.symbol ? isinNameMap.get(row.symbol) : null;
  const name = row.name || row.description || symbol;
  const displayName = buildDisplayName(row, pdfInfo);
  const assetClass = normalizeAsset(row.asset_class);
  const netAmount = amount + tax;

  const record = {
    id: row.transaction_id || `${row.date}-${row.type}-${symbol}-${dividendRecords.length}`,
    date: row.date,
    month,
    year: String(row.date || '').slice(0, 4),
    type: row.type,
    assetClass,
    name,
    displayName,
    pdfName: pdfInfo?.pdfName || '',
    issuer: extractIssuerFromDescription(row) || (row.symbol ? issuerBySymbol.get(row.symbol) : '') || pdfInfo?.issuer || '',
    symbol,
    grossAmount: amount,
    tax,
    netAmount,
    currency: row.currency || 'EUR',
  };
  dividendRecords.push(record);

  if (!dividendMonthly.has(month)) {
    dividendMonthly.set(month, { month, grossAmount: 0, tax: 0, netAmount: 0, count: 0 });
  }
  const monthBucket = dividendMonthly.get(month);
  monthBucket.grossAmount += amount;
  monthBucket.tax += tax;
  monthBucket.netAmount += netAmount;
  monthBucket.count += 1;

  if (!dividendBySymbol.has(symbol)) {
    dividendBySymbol.set(symbol, { symbol, name, displayName, assetClass, grossAmount: 0, tax: 0, netAmount: 0, count: 0, lastDate: row.date });
  }
  const symbolBucket = dividendBySymbol.get(symbol);
  symbolBucket.name = name || symbolBucket.name;
  symbolBucket.displayName = displayName || symbolBucket.displayName || symbolBucket.name;
  symbolBucket.assetClass = assetClass || symbolBucket.assetClass;
  symbolBucket.grossAmount += amount;
  symbolBucket.tax += tax;
  symbolBucket.netAmount += netAmount;
  symbolBucket.count += 1;
  symbolBucket.lastDate = row.date || symbolBucket.lastDate;
};

for (const row of rows) {
  const amount = parseNumber(row.amount);
  const fee = parseNumber(row.fee);
  const tax = parseNumber(row.tax);
  const shares = parseNumber(row.shares);
  const price = parseNumber(row.price);
  const type = row.type;
  const category = row.category;

  fees += fee;
  taxes += tax;
  if (fee) addMonthly(row, 'fees', fee);
  if (tax) addMonthly(row, 'taxes', tax);

  if (dividendTypes.has(type)) {
    const netIncome = amount + tax;
    addDividendRecord(row, amount, tax);
    income += netIncome;
    if (row.symbol) ensurePosition(row).income += netIncome;
    addMonthly(row, 'income', netIncome);
    continue;
  }

  if (category === 'CASH') {
    if (amount > 0) {
      totalDeposits += amount;
      addMonthly(row, 'deposits', amount);
    } else if (amount < 0) {
      totalWithdrawals += amount;
      addMonthly(row, 'withdrawals', amount);
    }
    continue;
  }

  if (!row.symbol && !tradingTypes.has(type)) continue;

  const position = row.symbol ? ensurePosition(row) : null;

  if (type === 'BUY' && position) {
    const qty = Math.abs(shares);
    const cost = Math.max(0, -(amount + fee + tax));
    position.quantity += qty;
    position.costBasis += cost;
    position.fees += fee;
    position.taxes += tax;
    position.lastPrice = price || position.lastPrice;
    position.buys += 1;
    tradingCashflow += amount + fee + tax;
    addMonthly(row, 'buys', cost);
  } else if ((type === 'SELL' || type === 'REDEMPTION') && position) {
    const qty = Math.abs(shares);
    const avgCost = position.quantity > 0 ? position.costBasis / position.quantity : 0;
    const removedCost = Math.min(position.costBasis, avgCost * qty);
    const proceeds = amount + fee + tax;
    const pnl = proceeds - removedCost;
    position.quantity -= qty;
    if (Math.abs(position.quantity) < 1e-8) position.quantity = 0;
    position.costBasis = Math.max(0, position.costBasis - removedCost);
    position.realizedPnl += pnl;
    position.fees += fee;
    position.taxes += tax;
    position.lastPrice = price || position.lastPrice;
    position.sells += 1;
    realizedPnl += pnl;
    tradingCashflow += proceeds;
    addMonthly(row, 'sells', proceeds);
  } else if (['DIVIDEND', 'DISTRIBUTION', 'INTEREST_PAYMENT', 'TILG', 'DIVIDEND_EQUIVALENT_PAYMENT'].includes(type)) {
    income += amount + tax;
    if (position) position.income += amount + tax;
    addMonthly(row, 'income', amount + tax);
  } else if (shares && position) {
    position.quantity += shares;
    position.lastPrice = price || position.lastPrice;
  }
}

const positions = [...bySymbol.values()]
  .filter((p) => Math.abs(p.quantity) > 1e-6)
  .map((p) => {
    const marketValue = p.quantity * p.lastPrice;
    const unrealizedPnl = marketValue - p.costBasis;
    const unrealizedPct = p.costBasis > 0 ? (unrealizedPnl / p.costBasis) * 100 : 0;
    return { ...p, marketValue, unrealizedPnl, unrealizedPct };
  })
  .sort((a, b) => b.marketValue - a.marketValue);

for (const p of positions) {
  assetTotals.set(p.assetClass, (assetTotals.get(p.assetClass) || 0) + p.marketValue);
}

const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValue, 0);
const totalCostBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
const unrealizedPnl = totalMarketValue - totalCostBasis;
const winners = positions.filter((p) => p.unrealizedPnl > 0).length;
const losers = positions.filter((p) => p.unrealizedPnl < 0).length;

const recentTransactions = rows
  .slice(-20)
  .reverse()
  .map((r) => ({
    date: r.date,
    type: r.type,
    category: r.category,
    assetClass: normalizeAsset(r.asset_class),
    name: r.name || r.description || '—',
    symbol: r.symbol,
    amount: parseNumber(r.amount),
    fee: parseNumber(r.fee),
    tax: parseNumber(r.tax),
    currency: r.currency || 'EUR',
  }));

const dividendMonthlyRows = [...dividendMonthly.values()].sort((a, b) => a.month.localeCompare(b.month));
const dividendTopSymbols = [...dividendBySymbol.values()].sort((a, b) => b.netAmount - a.netAmount);
const dividendSummary = {
  records: dividendRecords.length,
  grossAmount: dividendRecords.reduce((sum, item) => sum + item.grossAmount, 0),
  tax: dividendRecords.reduce((sum, item) => sum + item.tax, 0),
  netAmount: dividendRecords.reduce((sum, item) => sum + item.netAmount, 0),
  symbols: dividendTopSymbols.length,
  firstDate: dividendRecords[0]?.date,
  lastDate: dividendRecords.at(-1)?.date,
};

const output = {
  generatedAt: new Date().toISOString(),
  source: {
    csv: 'data/Transaktionsexport(2).csv',
    pdf: 'data/Vermögensübersicht.pdf',
    pdfText: existsSync(pdfTextPath) ? 'data/asset_overview_extracted.txt' : null,
    isinNameMatches: isinNameMap.size,
    rows: rows.length,
    firstDate: rows[0]?.date,
    lastDate: rows.at(-1)?.date,
  },
  summary: {
    totalMarketValue,
    totalCostBasis,
    unrealizedPnl,
    unrealizedPct: totalCostBasis > 0 ? (unrealizedPnl / totalCostBasis) * 100 : 0,
    realizedPnl,
    income,
    fees,
    taxes,
    totalDeposits,
    totalWithdrawals,
    tradingCashflow,
    openPositions: positions.length,
    winners,
    losers,
  },
  allocation: [...assetTotals.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
  positions,
  monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
  dividend: {
    summary: dividendSummary,
    monthly: dividendMonthlyRows,
    topSymbols: dividendTopSymbols,
    records: dividendRecords.slice().reverse(),
  },
  recentTransactions,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Generated ${outPath}`);
console.log(`Open positions: ${positions.length}, estimated market value: €${totalMarketValue.toFixed(2)}`);
