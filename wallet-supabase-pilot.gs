/**
 * Wallet → Supabase sync pilot.
 *
 * Uses an isolated table (wallet_sync_pilot), never the production
 * "transacciones" table. Store credentials in Apps Script > Project Settings
 * > Script Properties:
 *   WALLET_API_TOKEN
 *   SUPABASE_URL              (for example https://<project-ref>.supabase.co)
 *   SUPABASE_SECRET_KEY       (sb_secret_... from the same Supabase project)
 *
 * Run walletPilotSyncNow() manually first. Once verified, an optional
 * 15-minute trigger can be installed with walletPilotInstallTrigger().
 */

const WALLET_PILOT_TABLE = 'wallet_sync_pilot';
const WALLET_PILOT_PAGE_SIZE = 200;
const WALLET_PILOT_API_BASE = 'https://rest.budgetbakers.com/wallet/v1/api';

function walletPilotProperties_() {
  const p = PropertiesService.getScriptProperties();
  const config = {
    walletToken: (p.getProperty('WALLET_API_TOKEN') || '').trim(),
    supabaseUrl: (p.getProperty('SUPABASE_URL') || '').trim().replace(/\/$/, ''),
    supabaseKey: (p.getProperty('SUPABASE_SECRET_KEY') || '').trim()
  };
  const missing = [];
  if (!config.walletToken) missing.push('WALLET_API_TOKEN');
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseKey) missing.push('SUPABASE_SECRET_KEY');
  if (missing.length) throw new Error('Configura estas Script Properties: ' + missing.join(', '));
  return config;
}

function walletPilotFetchWalletPage_(config, offset) {
  const url = WALLET_PILOT_API_BASE + '/records?limit=' + WALLET_PILOT_PAGE_SIZE + '&offset=' + offset;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + config.walletToken, Accept: 'application/json' },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('Wallet API HTTP ' + status + ' al leer registros. Verifica el token y el acceso REST.');
  }

  const data = JSON.parse(text);
  const records = Array.isArray(data) ? data
    : Array.isArray(data.records) ? data.records
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.data) ? data.data
    : null;
  if (!records) throw new Error('La respuesta de Wallet no contiene una lista reconocible de registros.');
  return { records: records, nextOffset: data && data.nextOffset };
}

function walletPilotFetchAllRecords_(config) {
  const all = [];
  let offset = 0;
  while (true) {
    const page = walletPilotFetchWalletPage_(config, offset);
    all.push.apply(all, page.records);
    if (page.nextOffset !== undefined && page.nextOffset !== null) {
      offset = Number(page.nextOffset);
      if (!Number.isFinite(offset)) throw new Error('Wallet devolvió un nextOffset inválido.');
      continue;
    }
    if (page.records.length < WALLET_PILOT_PAGE_SIZE) break;
    offset += WALLET_PILOT_PAGE_SIZE;
  }
  return all;
}

function walletPilotRecordDate_(record) {
  const raw = record && (record.recordDate || record.date || record.datetime);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function walletPilotSupabaseRequest_(config, path, method, payload, prefer) {
  const options = {
    method: method.toLowerCase(),
    headers: {
      apikey: config.supabaseKey,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  // New sb_secret keys authenticate through apikey. Legacy service_role JWTs
  // also work with apikey, so do not duplicate the key in Authorization.
  if (payload !== undefined && payload !== null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  if (prefer) options.headers.Prefer = prefer;

  const response = UrlFetchApp.fetch(config.supabaseUrl + '/rest/v1/' + path, options);
  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    // Supabase's error body identifies auth/config/schema failures. Do not log
    // request headers, credentials, or financial payloads.
    const detail = (text || '').replace(/[\r\n]+/g, ' ').substring(0, 300);
    throw new Error('Supabase HTTP ' + status + ' en piloto (' + method + '). ' + detail);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}

/** Checks credentials and the pilot table without changing any data. */
function walletPilotCheckConnection() {
  const config = walletPilotProperties_();
  const page = walletPilotFetchWalletPage_(config, 0);
  walletPilotSupabaseRequest_(config, WALLET_PILOT_TABLE + '?select=wallet_record_id&limit=1', 'get');
  const result = { ok: true, walletRecordsOnFirstPage: page.records.length, supabaseTable: WALLET_PILOT_TABLE };
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * Reads the complete Wallet snapshot, upserts it by Wallet record ID, then
 * soft-deletes pilot rows absent from that complete snapshot. Safe to rerun.
 */
function walletPilotSyncNow() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Ya hay una sincronización piloto en curso.');
  try {
    const config = walletPilotProperties_();
    const records = walletPilotFetchAllRecords_(config);
    if (!records.length) {
      throw new Error('Wallet devolvió cero registros; se cancela para no marcar por error todo el piloto como eliminado.');
    }
    const runId = Utilities.getUuid();
    const syncedAt = new Date().toISOString();
    const seen = new Set();
    const rows = records.map(function(record) {
      const id = record && (record.id !== undefined ? record.id : record.recordId);
      if (id === undefined || id === null || id === '') {
        throw new Error('Wallet devolvió un registro sin id; se cancela antes de actualizar Supabase.');
      }
      const key = String(id);
      if (seen.has(key)) throw new Error('Wallet devolvió IDs duplicados; se cancela para evitar inconsistencias.');
      seen.add(key);
      return {
        wallet_record_id: key,
        record_date: walletPilotRecordDate_(record),
        wallet_record: record,
        sync_run_id: runId,
        is_deleted: false,
        synced_at: syncedAt
      };
    });

    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const query = WALLET_PILOT_TABLE + '?on_conflict=wallet_record_id';
      walletPilotSupabaseRequest_(config, query, 'post', batch, 'resolution=merge-duplicates,return=minimal');
    }

    // This only runs after every Wallet page and every upsert succeeded.
    // Missing records are preserved for audit, marked is_deleted=true.
    walletPilotSupabaseRequest_(
      config,
      WALLET_PILOT_TABLE + '?sync_run_id=neq.' + encodeURIComponent(runId) + '&is_deleted=eq.false',
      'patch',
      { is_deleted: true, synced_at: syncedAt },
      'return=minimal'
    );

    const result = { ok: true, walletRecordsRead: records.length, upserted: rows.length, runId: runId };
    Logger.log(JSON.stringify(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Reads pilot rows back from Supabase (active by default). */
function walletPilotReadFromSupabase(includeDeleted) {
  const config = walletPilotProperties_();
  let query = WALLET_PILOT_TABLE + '?select=wallet_record_id,record_date,wallet_record,is_deleted,synced_at&order=record_date.desc.nullslast,synced_at.desc&limit=100';
  if (!includeDeleted) query += '&is_deleted=eq.false';
  const rows = walletPilotSupabaseRequest_(config, query, 'get');
  Logger.log('Filas leídas desde Supabase: ' + (rows || []).length);
  return rows;
}

function walletPilotFetchWalletCollection_(config, endpoint) {
  const all = [];
  let offset = 0;
  while (true) {
    const url = WALLET_PILOT_API_BASE + '/' + endpoint + '?limit=' + WALLET_PILOT_PAGE_SIZE + '&offset=' + offset;
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + config.walletToken, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    const status = response.getResponseCode();
    if (status < 200 || status >= 300) throw new Error('Wallet API HTTP ' + status + ' al consultar ' + endpoint + '.');
    const data = JSON.parse(response.getContentText());
    const key = endpoint === 'accounts' ? 'accounts' : endpoint;
    const batch = Array.isArray(data) ? data
      : Array.isArray(data[key]) ? data[key]
      : Array.isArray(data.items) ? data.items
      : Array.isArray(data.data) ? data.data
      : null;
    if (!batch) throw new Error('Wallet no devolvió una lista válida para ' + endpoint + '.');
    all.push.apply(all, batch);
    if (data.nextOffset !== undefined && data.nextOffset !== null) {
      offset = Number(data.nextOffset);
      if (!Number.isFinite(offset)) throw new Error('Wallet devolvió nextOffset inválido en ' + endpoint + '.');
      continue;
    }
    if (batch.length < WALLET_PILOT_PAGE_SIZE) break;
    offset += WALLET_PILOT_PAGE_SIZE;
  }
  return all;
}

function walletPilotLabelsText_(labels) {
  if (!labels) return null;
  if (!Array.isArray(labels)) return String(labels);
  return labels.map(function(label) {
    return label && typeof label === 'object' ? (label.name || label.title || '') : String(label);
  }).filter(Boolean).join('|') || null;
}

function walletPilotMapToTransaction_(record, accountsById) {
  const recordId = record && (record.id || record.recordId);
  const rawDate = record && (record.recordDate || record.date);
  const amountObject = record && record.amount && typeof record.amount === 'object' ? record.amount : null;
  const amount = amountObject ? amountObject.value : record && record.amount;
  const rawType = record && (record.recordType || record.type);
  const normalizedType = walletPilotNormalizeType_(rawType);
  const isTransfer = normalizedType === 'transfer';
  if (!recordId || !rawDate || amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    throw new Error('Un movimiento del mes actual no tiene ID, fecha o monto válido. Se cancela la reposición.');
  }
  if (!['expense', 'income', 'transfer'].includes(normalizedType)) {
    throw new Error('Tipo de movimiento Wallet no reconocido: ' + normalizedType + '. Se cancela la reposición.');
  }
  const category = record.category && typeof record.category === 'object'
    ? (record.category.name || record.category.title || null)
    : (record.category || record.categoryName || null);
  const accountId = record.accountId || (record.account && typeof record.account === 'object' ? record.account.id : null);
  const accountName = (record.account && typeof record.account === 'object' && record.account.name)
    || record.accountName
    || (accountId && accountsById[String(accountId)])
    || accountId
    || (typeof record.account === 'string' ? record.account : null);
  const currency = (amountObject && amountObject.currencyCode) || record.currency || null;
  const refAmount = record.refCurrencyAmount || (amountObject && amountObject.refCurrencyAmount);
  const refAmountValue = refAmount && typeof refAmount === 'object' ? refAmount.value : refAmount;
  return {
    wallet_record_id: String(recordId),
    account: accountName ? String(accountName) : null,
    category: isTransfer ? 'TRANSFER' : category,
    currency: currency ? String(currency) : null,
    amount: Number(amount),
    ref_currency_amount: refAmountValue === undefined || refAmountValue === null || refAmountValue === '' ? null : Number(refAmountValue),
    type: normalizedType === 'expense' ? 'Gastos' : normalizedType === 'income' ? 'Ingresos' : 'Transferencias',
    payment_type: record.paymentType || null,
    payment_type_local: record.paymentTypeLocal || record.paymentType || null,
    note: record.note || null,
    // The target column is PostgreSQL timestamp without time zone. Store
    // Santo Domingo wall-clock time, not the UTC instant returned by Wallet.
    date: Utilities.formatDate(new Date(rawDate), 'America/Santo_Domingo', "yyyy-MM-dd'T'HH:mm:ss"),
    gps_latitude: record.gpsLatitude === undefined ? null : Number(record.gpsLatitude),
    gps_longitude: record.gpsLongitude === undefined ? null : Number(record.gpsLongitude),
    gps_accuracy_in_meters: record.gpsAccuracyInMeters === undefined ? null : Number(record.gpsAccuracyInMeters),
    warranty_in_month: record.warrantyInMonth === undefined ? null : Number(record.warrantyInMonth),
    transfer: isTransfer,
    payee: record.counterParty || record.payee || null,
    labels: walletPilotLabelsText_(record.labels),
    envelope_id: record.envelopeId === undefined || record.envelopeId === null ? null : Number(record.envelopeId)
  };
}

/**
 * Replace only the current Santo Domingo calendar month in transacciones.
 * The SQL RPC creates a one-time backup of the existing month and performs
 * delete + insert atomically. Run manually for the first production check.
 */
function walletPilotReplaceCurrentMonthInTransactions() {
  const config = walletPilotProperties_();
  const timezone = 'America/Santo_Domingo';
  const month = Utilities.formatDate(new Date(), timezone, 'yyyy-MM');
  const pilotRows = walletPilotFetchSupabasePages_(
    config,
    WALLET_PILOT_TABLE + '?select=wallet_record_id,wallet_record,record_date,is_deleted&is_deleted=eq.false&order=record_date.asc'
  );
  const monthRecords = pilotRows.map(function(row) { return row.wallet_record || {}; }).filter(function(record) {
    const rawDate = record.recordDate || record.date;
    if (!rawDate) return false;
    return Utilities.formatDate(new Date(rawDate), timezone, 'yyyy-MM') === month;
  });
  if (!monthRecords.length) throw new Error('Wallet no devolvió movimientos activos para ' + month + '; no se reemplazó nada.');

  const accounts = walletPilotFetchWalletCollection_(config, 'accounts');
  const accountsById = {};
  accounts.forEach(function(account) {
    if (account && account.id) accountsById[String(account.id)] = account.name || account.title || String(account.id);
  });
  const transactions = monthRecords.map(function(record) { return walletPilotMapToTransaction_(record, accountsById); });
  const uniqueIds = new Set(transactions.map(function(row) { return row.wallet_record_id; }));
  if (uniqueIds.size !== transactions.length) throw new Error('Wallet devolvió IDs duplicados para ' + month + '; no se reemplazó nada.');
  const sheetTarget = walletPilotGetRegistrosSyncTarget_();
  walletPilotApplyReferenceCurrencyAmounts_(transactions, sheetTarget.exchangeRate);

  const result = walletPilotSupabaseRequest_(
    config,
    'rpc/replace_current_month_wallet_transactions',
    'post',
    { p_month: month, p_rows: transactions },
    'return=representation'
  );
  // Keep the legacy REGISTROS sheet aligned with the same Wallet snapshot.
  // This runs only after the Supabase month replacement succeeded.
  const sheet = walletPilotReplaceCurrentMonthInSheet_(transactions, month, sheetTarget);
  const summary = { ok: true, month: month, walletRows: transactions.length, result: result, sheet: sheet };
  Logger.log(JSON.stringify(summary));
  return summary;
}

/** Validates the existing sheet layout before the Supabase month is changed. */
function walletPilotGetRegistrosSyncTarget_() {
  const sheetName = 'REGISTROS';
  const marker = 'FIN_MES_ANTERIOR';
  const outputColumns = 17; // A:Q. R and later may contain formulas or user-maintained values.
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName(sheetName);
  if (!sheet) throw new Error('No existe la hoja ' + sheetName + '; no se reemplazó el mes en Supabase.');

  const usedColumns = Math.max(sheet.getLastColumn(), 19);
  const allHeaders = sheet.getRange(1, 1, 1, usedColumns).getDisplayValues()[0]
    .map(function(value) { return String(value || '').trim(); });
  const headerIndexes = {};
  allHeaders.forEach(function(header, index) { if (header) headerIndexes[header] = index; });
  ['account', 'category', 'currency', 'amount', 'type', 'date'].forEach(function(header) {
    if (headerIndexes[header] === undefined || headerIndexes[header] >= outputColumns) {
      throw new Error('La columna ' + header + ' debe estar entre A y Q en REGISTROS; no se modificó la hoja.');
    }
  });

  const lastRow = sheet.getLastRow();
  if (lastRow < 1) throw new Error('REGISTROS está vacía; no se modificó la hoja.');
  const firstColumn = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  let markerRow = 0;
  for (let i = 0; i < firstColumn.length; i++) {
    if (String(firstColumn[i][0]).trim() === marker) { markerRow = i + 1; break; }
  }
  if (!markerRow) throw new Error('No se encontró ' + marker + ' en REGISTROS; no se modificó la hoja.');
  const startRow = markerRow + 2;
  const rawExchangeRate = sheet.getRange('V2').getValue();
  const exchangeRate = typeof rawExchangeRate === 'number'
    ? rawExchangeRate
    : Number(String(rawExchangeRate || '').trim().replace(',', '.'));
  return {
    sheet: sheet,
    sheetName: sheetName,
    outputColumns: outputColumns,
    headers: allHeaders.slice(0, outputColumns),
    startRow: startRow,
    exchangeRate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : null
  };
}

/** Computes DOP reference amounts from the currency, amount, and REGISTROS!V2 rate. */
function walletPilotApplyReferenceCurrencyAmounts_(transactions, exchangeRate) {
  transactions.forEach(function(transaction) {
    const currency = String(transaction.currency || '').trim().toUpperCase();
    if (!currency) throw new Error('La transacción ' + transaction.wallet_record_id + ' no tiene moneda; no se reemplazó el mes.');
    if (currency === 'DOP') {
      transaction.ref_currency_amount = Number(transaction.amount);
      return;
    }
    if (!exchangeRate) throw new Error('REGISTROS!V2 no contiene una tasa de cambio válida; no se reemplazó el mes.');
    transaction.ref_currency_amount = Math.round((Number(transaction.amount) * exchangeRate + Number.EPSILON) * 100) / 100;
  });
}

/** Replaces only columns A:Q in the current-month block; columns R onward are preserved. */
function walletPilotReplaceCurrentMonthInSheet_(transactions, month, target) {
  const timezone = 'America/Santo_Domingo';
  const sourceProperty = 'WALLET_REGISTROS_SOURCE_ACTIVE';
  const sheet = target.sheet;
  const sheetName = target.sheetName;
  const outputColumns = target.outputColumns;
  const headers = target.headers;
  const startRow = target.startRow;
  if (startRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), startRow - sheet.getMaxRows());

  const outputRows = transactions.map(function(transaction) {
    const transactionMonth = String(transaction.date || '').slice(0, 7);
    if (transactionMonth !== month) throw new Error('Hay una transacción fuera del mes ' + month + '; no se modificó REGISTROS.');
    return headers.map(function(header) {
      if (!header || transaction[header] === undefined || transaction[header] === null) return '';
      if (header === 'date') {
        return Utilities.parseDate(String(transaction.date), timezone, "yyyy-MM-dd'T'HH:mm:ss");
      }
      return transaction[header];
    });
  });

  const currentLastRow = sheet.getLastRow();
  const rowsToClear = Math.max(0, currentLastRow - startRow + 1);
  if (rowsToClear) sheet.getRange(startRow, 1, rowsToClear, outputColumns).clearContent();
  if (outputRows.length) {
    const requiredLastRow = startRow + outputRows.length - 1;
    if (requiredLastRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), requiredLastRow - sheet.getMaxRows());
    sheet.getRange(startRow, 1, outputRows.length, outputColumns).setValues(outputRows);
  }

  // Prevent the older CSV trigger from replacing the Wallet-sourced month.
  PropertiesService.getScriptProperties().setProperty(sourceProperty, 'true');
  return { sheet: sheetName, month: month, rowsWritten: outputRows.length };
}

/** Scheduled production flow: refresh the pilot snapshot, then the current month. */
function walletPilotSyncAndReplaceCurrentMonth() {
  const pilot = walletPilotSyncNow();
  const production = walletPilotReplaceCurrentMonthInTransactions();
  const summary = { ok: true, pilot: pilot, currentMonth: production };
  Logger.log(JSON.stringify(summary));
  return summary;
}

function walletPilotFetchSupabasePages_(config, baseQuery) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const separator = baseQuery.indexOf('?') >= 0 ? '&' : '?';
    const page = walletPilotSupabaseRequest_(
      config,
      baseQuery + separator + 'limit=' + pageSize + '&offset=' + offset,
      'get'
    ) || [];
    if (!Array.isArray(page)) throw new Error('Supabase devolvió una respuesta que no es una lista.');
    rows.push.apply(rows, page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function walletPilotNormalizeText_(value) {
  if (value && typeof value === 'object') value = value.name || value.title || value.id || '';
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
}

function walletPilotNormalizeType_(value) {
  const type = walletPilotNormalizeText_(value);
  if (['expense', 'expenses', 'gastos', 'gasto'].indexOf(type) >= 0) return 'expense';
  if (['income', 'incomes', 'ingresos', 'ingreso'].indexOf(type) >= 0) return 'income';
  if (['transfer', 'transfers', 'transferencia', 'transferencias'].indexOf(type) >= 0) return 'transfer';
  return type;
}

function walletPilotNormalizeDateMinute_(value) {
  if (!value) return '';
  const timezone = 'America/Santo_Domingo';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(value, timezone, "yyyy-MM-dd'T'HH:mm");
  }
  const raw = String(value).trim();
  // Supabase returns timestamp-without-time-zone values as wall-clock text.
  // Treat those as already-local; convert explicit UTC/offset timestamps.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    return raw.replace(' ', 'T').slice(0, 16);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : Utilities.formatDate(parsed, timezone, "yyyy-MM-dd'T'HH:mm");
}

function walletPilotNormalizeDateDay_(value) {
  if (!value) return '';
  const timezone = 'America/Santo_Domingo';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
  const raw = String(value).trim();
  const prefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (prefix && !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return prefix[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : Utilities.formatDate(parsed, timezone, 'yyyy-MM-dd');
}

function walletPilotNormalizeAmount_(value) {
  if (value && typeof value === 'object') value = value.value;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.abs(amount).toFixed(2) : '';
}

function walletPilotReconcileFields_(record, accountNames, isWallet) {
  const amountObject = record.amount && typeof record.amount === 'object' ? record.amount : null;
  let account = record.account || record.accountName || record.accountId || '';
  if (account && typeof account === 'object') account = account.name || account.id || '';
  if (isWallet && accountNames && accountNames[String(account)]) account = accountNames[String(account)];
  const category = record.category || record.categoryName || '';
  const rawDate = isWallet ? (record.recordDate || record.date) : record.date;
  const rawAmount = isWallet ? (amountObject ? amountObject.value : record.amount) : record.amount;
  const rawCurrency = isWallet
    ? ((amountObject && amountObject.currencyCode) || record.currency || '')
    : record.currency;
  const rawType = isWallet ? (record.recordType || record.type) : record.type;
  const rawPayee = isWallet ? (record.counterParty || record.payee || '') : record.payee;
  const note = record.note || '';
  const values = {
    id: isWallet ? String(record.id || record.recordId || '') : '',
    date: walletPilotNormalizeDateMinute_(rawDate),
    day: walletPilotNormalizeDateDay_(rawDate),
    type: walletPilotNormalizeType_(rawType),
    category: walletPilotNormalizeText_(category),
    amount: walletPilotNormalizeAmount_(rawAmount),
    currency: walletPilotNormalizeText_(rawCurrency),
    account: walletPilotNormalizeText_(account),
    payee: walletPilotNormalizeText_(rawPayee),
    note: walletPilotNormalizeText_(note),
    displayDate: rawDate || '',
    displayType: rawType || '',
    displayCategory: category && typeof category === 'object' ? (category.name || category.id || '') : category,
    displayAmount: rawAmount === undefined || rawAmount === null ? '' : rawAmount,
    displayCurrency: rawCurrency,
    displayAccount: account,
    displayPayee: rawPayee,
    displayNote: note
  };
  values.coreKey = JSON.stringify([values.date, values.type, values.category, values.amount, values.currency]);
  values.dayCoreKey = JSON.stringify([values.day, values.type, values.category, values.amount, values.currency]);
  values.exactKey = JSON.stringify([values.date, values.type, values.category, values.amount, values.currency, values.account, values.payee, values.note]);
  values.dayExactKey = JSON.stringify([values.day, values.type, values.category, values.amount, values.currency, values.account, values.payee, values.note]);
  values.dayTextKey = JSON.stringify([values.day, values.type, values.category, values.amount, values.currency, values.payee, values.note]);
  values.keys = {
    dateAmount: JSON.stringify([values.date, values.amount]),
    dateAmountType: JSON.stringify([values.date, values.amount, values.type]),
    dateAmountCategory: JSON.stringify([values.date, values.amount, values.category]),
    dateAmountCurrency: JSON.stringify([values.date, values.amount, values.currency]),
    dateCategoryType: JSON.stringify([values.date, values.category, values.type]),
    amountCategoryType: JSON.stringify([values.amount, values.category, values.type]),
    dayAmount: JSON.stringify([values.day, values.amount]),
    dayAmountType: JSON.stringify([values.day, values.amount, values.type]),
    dayAmountCategoryType: JSON.stringify([values.day, values.amount, values.category, values.type]),
    dayAmountCurrency: JSON.stringify([values.day, values.amount, values.currency])
  };
  values.matchable = !!(values.date && values.type && values.category && values.amount);
  return values;
}

/**
 * Read-only reconciliation report: compares active Wallet pilot records with
 * legacy transacciones and writes findings to a separate report sheet only.
 * It never inserts, updates, or deletes rows in Supabase.
 */
function walletPilotReconcileDryRun() {
  const config = walletPilotProperties_();
  const pilotRows = walletPilotFetchSupabasePages_(
    config,
    WALLET_PILOT_TABLE + '?select=wallet_record_id,wallet_record,record_date,is_deleted&is_deleted=eq.false&order=record_date.asc'
  );
  const dbRows = walletPilotFetchSupabasePages_(
    config,
    'transacciones?select=account,category,currency,amount,type,note,date,payee,payment_type,payment_type_local,transfer,labels'
  );
  const pilotRecords = pilotRows.map(function(row) {
    const record = row.wallet_record || {};
    if (!record.id && row.wallet_record_id) record.id = row.wallet_record_id;
    return { raw: record, fields: walletPilotReconcileFields_(record, null, true) };
  });
  const dbRecords = dbRows.map(function(row) {
    return { raw: row, fields: walletPilotReconcileFields_(row, null, false) };
  });

  const exactDb = new Map();
  const coreDb = new Map();
  const dayCoreDb = new Map();
  const dayExactDb = new Map();
  const dayTextDb = new Map();
  const partialDb = {
    dateAmount: new Set(),
    dateAmountType: new Set(),
    dateAmountCategory: new Set(),
    dateAmountCurrency: new Set(),
    dateCategoryType: new Set(),
    amountCategoryType: new Set(),
    dayAmount: new Set(),
    dayAmountType: new Set(),
    dayAmountCategoryType: new Set(),
    dayAmountCurrency: new Set()
  };
  const exactWalletCounts = new Map();
  const coreWalletCounts = new Map();
  const dayCoreWalletCounts = new Map();
  const dayExactWalletCounts = new Map();
  const dayTextWalletCounts = new Map();
  dbRecords.forEach(function(item, index) {
    if (!item.fields.matchable) return;
    if (!exactDb.has(item.fields.exactKey)) exactDb.set(item.fields.exactKey, []);
    exactDb.get(item.fields.exactKey).push(index);
    if (!coreDb.has(item.fields.coreKey)) coreDb.set(item.fields.coreKey, []);
    coreDb.get(item.fields.coreKey).push(index);
    if (!dayCoreDb.has(item.fields.dayCoreKey)) dayCoreDb.set(item.fields.dayCoreKey, []);
    dayCoreDb.get(item.fields.dayCoreKey).push(index);
    if (!dayExactDb.has(item.fields.dayExactKey)) dayExactDb.set(item.fields.dayExactKey, []);
    dayExactDb.get(item.fields.dayExactKey).push(index);
    if (!dayTextDb.has(item.fields.dayTextKey)) dayTextDb.set(item.fields.dayTextKey, []);
    dayTextDb.get(item.fields.dayTextKey).push(index);
    Object.keys(partialDb).forEach(function(key) { partialDb[key].add(item.fields.keys[key]); });
  });
  pilotRecords.forEach(function(item) {
    if (!item.fields.matchable) return;
    exactWalletCounts.set(item.fields.exactKey, (exactWalletCounts.get(item.fields.exactKey) || 0) + 1);
    coreWalletCounts.set(item.fields.coreKey, (coreWalletCounts.get(item.fields.coreKey) || 0) + 1);
    dayCoreWalletCounts.set(item.fields.dayCoreKey, (dayCoreWalletCounts.get(item.fields.dayCoreKey) || 0) + 1);
    dayExactWalletCounts.set(item.fields.dayExactKey, (dayExactWalletCounts.get(item.fields.dayExactKey) || 0) + 1);
    dayTextWalletCounts.set(item.fields.dayTextKey, (dayTextWalletCounts.get(item.fields.dayTextKey) || 0) + 1);
  });

  const statuses = { 'Coincidencia exacta': 0, 'Coincidencia probable': 0, 'Coincidencia por día con detalles': 0, 'Coincidencia por día, beneficiario y nota': 0, 'Coincidencia probable por día': 0, 'Falta en transacciones': 0, 'Ambigua': 0, 'Datos insuficientes': 0 };
  const partialCounts = {};
  Object.keys(partialDb).forEach(function(key) { partialCounts[key] = 0; });
  const fieldCoverage = {
    pilot: { date: 0, type: 0, category: 0, amount: 0, currency: 0 },
    transacciones: { date: 0, type: 0, category: 0, amount: 0, currency: 0 }
  };
  pilotRecords.forEach(function(item) {
    const f = item.fields;
    ['date', 'type', 'category', 'amount', 'currency'].forEach(function(key) {
      if (f[key]) fieldCoverage.pilot[key]++;
    });
    Object.keys(partialDb).forEach(function(key) {
      if (partialDb[key].has(f.keys[key])) partialCounts[key]++;
    });
  });
  dbRecords.forEach(function(item) {
    const f = item.fields;
    ['date', 'type', 'category', 'amount', 'currency'].forEach(function(key) {
      if (f[key]) fieldCoverage.transacciones[key]++;
    });
  });
  const report = [[
    'Resultado', 'ID Wallet', 'Fecha Wallet', 'Tipo Wallet', 'Categoría Wallet',
    'Monto', 'Moneda', 'Cuenta', 'Beneficiario', 'Nota', 'Filas candidatas en transacciones'
  ]];

  pilotRecords.forEach(function(item) {
    const f = item.fields;
    let status;
    let candidates = [];
    if (!f.matchable) {
      status = 'Datos insuficientes';
    } else {
      const exact = exactDb.get(f.exactKey) || [];
      const exactWalletCount = exactWalletCounts.get(f.exactKey) || 0;
      if (exact.length === 1 && exactWalletCount === 1) {
        status = 'Coincidencia exacta';
        candidates = exact;
      } else if (exact.length > 1 || exactWalletCount > 1) {
        status = 'Ambigua';
        candidates = exact;
      } else {
        const core = coreDb.get(f.coreKey) || [];
        const coreWalletCount = coreWalletCounts.get(f.coreKey) || 0;
        if (core.length === 1 && coreWalletCount === 1) {
          status = 'Coincidencia probable';
          candidates = core;
        } else if (core.length > 1 || coreWalletCount > 1) {
          status = 'Ambigua';
          candidates = core;
        } else {
          const dayExact = dayExactDb.get(f.dayExactKey) || [];
          const dayExactWalletCount = dayExactWalletCounts.get(f.dayExactKey) || 0;
          if (dayExact.length === 1 && dayExactWalletCount === 1) {
            status = 'Coincidencia por día con detalles';
            candidates = dayExact;
          } else if (dayExact.length > 1 || dayExactWalletCount > 1) {
            status = 'Ambigua';
            candidates = dayExact;
          } else {
            const dayText = dayTextDb.get(f.dayTextKey) || [];
            const dayTextWalletCount = dayTextWalletCounts.get(f.dayTextKey) || 0;
            if (dayText.length === 1 && dayTextWalletCount === 1) {
              status = 'Coincidencia por día, beneficiario y nota';
              candidates = dayText;
            } else if (dayText.length > 1 || dayTextWalletCount > 1) {
              status = 'Ambigua';
              candidates = dayText;
            } else {
              const dayCore = dayCoreDb.get(f.dayCoreKey) || [];
              const dayCoreWalletCount = dayCoreWalletCounts.get(f.dayCoreKey) || 0;
              if (dayCore.length === 1 && dayCoreWalletCount === 1) {
                status = 'Coincidencia probable por día';
                candidates = dayCore;
              } else if (dayCore.length > 1 || dayCoreWalletCount > 1) {
                status = 'Ambigua';
                candidates = dayCore;
              } else {
                status = 'Falta en transacciones';
              }
            }
          }
        }
      }
    }
    statuses[status]++;
    report.push([
      status, f.id, f.displayDate, f.displayType, f.displayCategory,
      f.displayAmount, f.displayCurrency, f.displayAccount, f.displayPayee,
      f.displayNote, candidates.length
    ]);
  });

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abre este proyecto desde el Google Sheet para crear el informe.');
  const sheetName = 'Conciliacion Wallet';
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  sheet.clearContents();
  sheet.getRange(1, 1, report.length, report[0].length).setValues(report);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, report[0].length).setFontWeight('bold');
  if (report.length > 1) sheet.getRange(2, 3, report.length - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.autoResizeColumns(1, report[0].length);

  const summary = {
    ok: true,
    mode: 'read-only',
    pilotActiveRows: pilotRows.length,
    transaccionesRows: dbRows.length,
    results: statuses,
    fieldCoverage: fieldCoverage,
    partialMatches: partialCounts,
    reportSheet: sheetName
  };
  Logger.log(JSON.stringify(summary));
  return summary;
}

/**
 * Read-only audit to evaluate a month-snapshot replacement strategy.
 * Compares transaction counts and absolute amounts by month, type, currency,
 * and category. It does not modify transacciones.
 */
function walletPilotMonthlyAudit() {
  const config = walletPilotProperties_();
  const pilotRows = walletPilotFetchSupabasePages_(
    config,
    WALLET_PILOT_TABLE + '?select=wallet_record_id,wallet_record,record_date,is_deleted&is_deleted=eq.false&order=record_date.asc'
  );
  const dbRows = walletPilotFetchSupabasePages_(
    config,
    'transacciones?select=account,category,currency,amount,type,note,date,payee,transfer'
  );
  const byMonthTypeCurrency = { wallet: new Map(), db: new Map() };
  const byCategory = { wallet: new Map(), db: new Map() };

  function addAggregate_(map, key, amount) {
    const current = map.get(key) || { count: 0, total: 0 };
    current.count++;
    current.total += Number.isFinite(amount) ? amount : 0;
    map.set(key, current);
  }

  pilotRows.forEach(function(row) {
    const record = row.wallet_record || {};
    if (!record.id && row.wallet_record_id) record.id = row.wallet_record_id;
    const f = walletPilotReconcileFields_(record, null, true);
    const month = f.day ? f.day.slice(0, 7) : '';
    if (!month || !f.type) return;
    const currency = f.currency || '(sin moneda)';
    const category = f.category || '(sin categoria)';
    const amount = Number(f.amount) || 0;
    const baseKey = JSON.stringify([month, f.type, currency]);
    const categoryKey = JSON.stringify([month, f.type, currency, category]);
    addAggregate_(byMonthTypeCurrency.wallet, baseKey, amount);
    addAggregate_(byCategory.wallet, categoryKey, amount);
  });

  dbRows.forEach(function(row) {
    const f = walletPilotReconcileFields_(row, null, false);
    const month = f.day ? f.day.slice(0, 7) : '';
    if (!month || !f.type) return;
    const currency = f.currency || '(sin moneda)';
    const category = f.category || '(sin categoria)';
    const amount = Number(f.amount) || 0;
    const baseKey = JSON.stringify([month, f.type, currency]);
    const categoryKey = JSON.stringify([month, f.type, currency, category]);
    addAggregate_(byMonthTypeCurrency.db, baseKey, amount);
    addAggregate_(byCategory.db, categoryKey, amount);
  });

  function makeRows_(walletMap, dbMap, categoryLevel) {
    const keys = new Set(Array.from(walletMap.keys()).concat(Array.from(dbMap.keys())));
    const rows = [];
    keys.forEach(function(key) {
      const parts = JSON.parse(key);
      const wallet = walletMap.get(key) || { count: 0, total: 0 };
      const db = dbMap.get(key) || { count: 0, total: 0 };
      const countMatches = wallet.count === db.count;
      const totalsMatch = Math.abs(wallet.total - db.total) < 0.01;
      let status = 'Difiere';
      if (!wallet.count) status = 'Solo en transacciones';
      else if (!db.count) status = 'Solo en Wallet';
      else if (countMatches && totalsMatch) status = 'Coincide en conteo y monto';
      rows.push(categoryLevel
        ? [parts[0], parts[1], parts[2], parts[3], wallet.count, db.count, wallet.total, db.total, db.total - wallet.total, status]
        : [parts[0], parts[1], parts[2], wallet.count, db.count, wallet.total, db.total, db.total - wallet.total, status]
      );
    });
    rows.sort(function(a, b) { return String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])); });
    return rows;
  }

  const monthRows = [['Mes', 'Tipo', 'Moneda', 'Filas Wallet', 'Filas transacciones', 'Monto Wallet', 'Monto transacciones', 'Diferencia (DB - Wallet)', 'Resultado']]
    .concat(makeRows_(byMonthTypeCurrency.wallet, byMonthTypeCurrency.db, false));
  const categoryRows = [['Mes', 'Tipo', 'Moneda', 'Categoria', 'Filas Wallet', 'Filas transacciones', 'Monto Wallet', 'Monto transacciones', 'Diferencia (DB - Wallet)', 'Resultado']]
    .concat(makeRows_(byCategory.wallet, byCategory.db, true));

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abre este proyecto desde el Google Sheet para crear el informe.');
  function writeAuditSheet_(name, values) {
    let sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    sheet.clearContents();
    sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, values[0].length).setFontWeight('bold');
    if (values.length > 1) sheet.getRange(2, values[0].length - 3, values.length - 1, 3).setNumberFormat('#,##0.00;[Red]-#,##0.00');
    sheet.autoResizeColumns(1, values[0].length);
  }
  writeAuditSheet_('Auditoria mensual Wallet', monthRows);
  writeAuditSheet_('Auditoria por categoria', categoryRows);

  const result = {
    ok: true,
    mode: 'read-only',
    pilotRows: pilotRows.length,
    transaccionesRows: dbRows.length,
    monthTypeCurrencyGroups: monthRows.length - 1,
    categoryGroups: categoryRows.length - 1,
    reportSheets: ['Auditoria mensual Wallet', 'Auditoria por categoria']
  };
  Logger.log(JSON.stringify(result));
  return result;
}

/** Optional: poll Wallet every 15 minutes after the manual pilot succeeds. */
function walletPilotInstallTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === 'walletPilotSyncNow';
  });
  if (!exists) ScriptApp.newTrigger('walletPilotSyncNow').timeBased().everyMinutes(15).create();
  Logger.log(exists ? 'El trigger piloto ya estaba instalado.' : 'Trigger piloto instalado: cada 15 minutos.');
}

/** Replaces the pilot-only trigger with the combined Wallet → Supabase flow. */
function walletPilotInstallProductionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const handler = trigger.getHandlerFunction();
    if (handler === 'walletPilotSyncNow' || handler === 'walletPilotSyncAndReplaceCurrentMonth') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('walletPilotSyncAndReplaceCurrentMonth').timeBased().everyMinutes(15).create();
  Logger.log('Flujo de producción instalado: Wallet → piloto → mes actual de transacciones, cada 15 minutos.');
}

/** Removes only this pilot's scheduled trigger. */
function walletPilotRemoveTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    const handler = trigger.getHandlerFunction();
    if (handler === 'walletPilotSyncNow' || handler === 'walletPilotSyncAndReplaceCurrentMonth') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  Logger.log('Trigger piloto eliminado si existía.');
}
