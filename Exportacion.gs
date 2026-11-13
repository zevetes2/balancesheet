/**
 * ============================================================================
 * BALANCE SHEET — GOOGLE APPS SCRIPT BACKEND (v2.1 - JSONP + CORS)
 * ============================================================================
 * 
 * INSTRUCCIONES:
 * 1. Abre tu Google Sheet "BALANCE SHEET"
 * 2. Ve a Extensions → Apps Script
 * 3. Borra TODO el código por defecto y pega ESTE archivo completo
 * 4. Guarda (Ctrl+S) y dale nombre al proyecto
 * 5. Deploy → New deployment → Web app
 * 6. Configura:
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 7. Copia la URL y pégala en CONFIG.API_URL de tu index.html
 * ============================================================================
 */

const CONFI = {
  SHEET_NAME: 'BALANCE SHEET',
  DATA_START_ROW: 2,
  MONTHS_HEADER_ROW: 1,
};

// ============================================================================
// SUPABASE — CONEXIÓN DE LECTURA (para el dashboard)
// ============================================================================

// ⚠️ Mejor mover estos a Script Properties (ver sección 6)
const SUPABASE_URL2   = 'https://cvuuevtkjspbedimmkmb.supabase.co';
const SUPABASE_KEY2   = 'sb_secret_54UeWbhj6U0UGnUgdTerAg_7g09i_fR';
const SUPABASE_TABLE2 = 'transacciones';

// Mapeo del tipo en tu columna "type" de Supabase.
// Ajusta si tus valores reales son distintos (ej: 'Gasto', 'EXPENSE', etc.)
const SUPABASE_TIPO_MAP = {
  gastos:   'Gastos',    // ← antes 'Expense'
  ingresos: 'Ingresos'   // ← antes 'Income'
};

function supabaseFetch(path) {
  const url = SUPABASE_URL2 + '/rest/v1/' + path;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'apikey':        SUPABASE_KEY2,
      'Authorization': 'Bearer ' + SUPABASE_KEY2,
      'Accept':        'application/json'
    },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('Supabase HTTP ' + code + ': ' + res.getContentText().substring(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/**
 * Trae las transacciones de un mes dado para un tipo (gastos|ingresos).
 */
function getSupabaseTransacciones(tipo, year, month) {
  const tipoValor = SUPABASE_TIPO_MAP[tipo];
  if (!tipoValor) throw new Error('Tipo inválido: ' + tipo);

  const yyyy = String(year);
  const mm   = String(month).padStart(2, '0');
  const desde = `${yyyy}-${mm}-01T00:00:00`;
  const ultimoDia = new Date(year, month, 0).getDate();
  const hasta = `${yyyy}-${mm}-${String(ultimoDia).padStart(2,'0')}T23:59:59`;

  const query =
  SUPABASE_TABLE2 +
  '?select=account,category,amount,ref_currency_amount,type,note,date,currency,payee' +
  '&type=eq.' + encodeURIComponent(tipoValor) +
  '&category=not.ilike.TRANSFER' +
  '&date=gte.' + encodeURIComponent(desde) +
  '&date=lte.' + encodeURIComponent(hasta) +
  '&order=date.asc';

  return supabaseFetch(query);
}

/**
 * Devuelve el resumen diario de gastos o ingresos de un mes.
 */
function getDailySupabaseResumen(tipo, year, month) {
  const rows = getSupabaseTransacciones(tipo, year, month);

  const porDia = {};
  const porCategoria = {};

  rows.forEach(r => {
    const cat = (r.category || '').trim().toUpperCase();
    if (cat === 'TRANSFER') return; // ← filtro defensivo

    const fechaISO = (r.date || '').substring(0, 10);
    if (!fechaISO) return;

    const raw = (r.ref_currency_amount !== null && r.ref_currency_amount !== undefined)
      ? r.ref_currency_amount
      : r.amount;
    const amt = Math.abs(Number(raw) || 0);

    if (!porDia[fechaISO]) {
      porDia[fechaISO] = { fecha: fechaISO, total: 0, count: 0, categorias: {} };
    }
    porDia[fechaISO].total += amt;
    porDia[fechaISO].count += 1;

    const catName = r.category || 'Sin categoría';
    porDia[fechaISO].categorias[catName] = (porDia[fechaISO].categorias[catName] || 0) + amt;
    porCategoria[catName] = (porCategoria[catName] || 0) + amt;
  });

  const dias = Object.values(porDia).sort((a, b) => a.fecha.localeCompare(b.fecha));
  const totalMes = dias.reduce((s, d) => s + d.total, 0);
  const diasConDatos = dias.length;

  const topCategorias = Object.entries(porCategoria)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  // NUEVO: estructura lista para stacked bar chart
  const categoriasStacked = topCategorias.map(c => ({
    name: c.name,
    total: c.total,
    // para cada día del mes, cuánto aportó esta categoría ese día
    dias: dias.map(d => ({
      fecha: d.fecha,
      monto: d.categorias[c.name] || 0
    }))
  }));

  // NUEVO: valores extremos para escalar el heatmap
  const maxDia = dias.length > 0 ? Math.max(...dias.map(d => d.total)) : 0;
  const minDia = dias.length > 0 ? Math.min(...dias.map(d => d.total)) : 0;

  return {
    tipo,
    year: String(year),
    month: String(month).padStart(2, '0'),
    totalMes,
    promedioDiario: diasConDatos > 0 ? totalMes / diasConDatos : 0,
    diasConDatos,
    totalTransacciones: rows.length,
    maxDia,
    minDia,
    dias,
    topCategorias,
    categoriasStacked
  };
}

function inspeccionarUnaTransaccion() {
  const rows = supabaseFetch(SUPABASE_TABLE2 + '?select=*&limit=1');
  Logger.log(JSON.stringify(rows[0], null, 2));
}


function testSupabaseDaily() {
  const r = getDailySupabaseResumen('gastos', 2026, 9);
  Logger.log(JSON.stringify(r, null, 2));
}

const CACHE = CacheService.getScriptCache();
const BACKEND_CACHE_TTL = 60; // segundos

function getCachedOrCompute(key, computeFn) {
    const cached = CACHE.get(key);
    if (cached) {
        Logger.log('⚡ Cache HIT: ' + key);
        return JSON.parse(cached);
    }
    const result = computeFn();
    try {
        CACHE.put(key, JSON.stringify(result), BACKEND_CACHE_TTL);
    } catch(e) {
        Logger.log('Cache PUT error: ' + e);
    }
    return result;
}

// ============================================================================
// WEB APP ENTRY POINTS
// ============================================================================

function doGet(e) {
    const action = e?.parameter?.action || 'getData';
    const callback = e?.parameter?.callback;

    try {
        let result;
        switch (action) {
            case 'getData':
                result = getCachedOrCompute('all_data', getAllData);
                break;
            case 'getSummary':
                result = getCachedOrCompute('summary', getSummaryData);
                break;
            case 'getHistory':
                result = getCachedOrCompute('history', getHistoricalData);
                break;
            case 'getGastos':
                result = getCachedOrCompute('gastos', getGastosData);
                break;
            case 'getModeco':
                result = getCachedOrCompute('modeco', getModecoData);
                break;
            case 'getJarras':
                result = getCachedOrCompute('jarras', getJarrasData);
                break;
            case 'updateBudget':
                // No cachear escrituras
                result = updateBudgetData(e);
                break;
            case 'walletProxy':
                result = walletProxy(e);
                break;

            case 'getDailyGastos':
                result = getCachedOrCompute(
                  'daily_gastos_' + (e.parameter.year || '') + '_' + (e.parameter.month || ''),
                  () => getDailySupabaseResumen(
                    'gastos',
                    parseInt(e.parameter.year, 10),
                    parseInt(e.parameter.month, 10)
                  )
                );
                break;

              case 'getDailyIngresos':
                result = getCachedOrCompute(
                  'daily_ingresos_' + (e.parameter.year || '') + '_' + (e.parameter.month || ''),
                  () => getDailySupabaseResumen(
                    'ingresos',
                    parseInt(e.parameter.year, 10),
                    parseInt(e.parameter.month, 10)
                  )
                );
                break;
            default:
                result = getCachedOrCompute('all_data', getAllData);
        }

        const jsonString = JSON.stringify(result);
        if (callback) {
            return ContentService.createTextOutput(callback + '(' + jsonString + ');')
                .setMimeType(ContentService.MimeType.JAVASCRIPT);
        }
        return ContentService.createTextOutput(jsonString)
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        const errorObj = { error: true, message: error.toString(), stack: error.stack };
        const errorJson = JSON.stringify(errorObj);
        if (callback) {
            return ContentService.createTextOutput(callback + '(' + errorJson + ');')
                .setMimeType(ContentService.MimeType.JAVASCRIPT);
        }
        return ContentService.createTextOutput(errorJson)
            .setMimeType(ContentService.MimeType.JSON);
    }
}


// Preflight para CORS (aunque GAS no lo soporta bien, lo dejamos por si acaso)
function doOptions(e) {
  return ContentService.createTextOutput('')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ============================================================================
// CORE DATA EXTRACTION
// ============================================================================

function getAllData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFI.SHEET_NAME);

  if (!sheet) {
    throw new Error('No se encontró la hoja "' + CONFI.SHEET_NAME + '"');
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  // Obtener TODOS los datos de una vez (más eficiente)
  const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // Extraer headers de meses (fila 2, índice 1)
  const monthsRow = allData[1];
  const months = [];
  for (let c = 1; c < monthsRow.length; c++) {
    if (monthsRow[c] && monthsRow[c].toString().trim()) {
      months.push({
        index: c,
        label: monthsRow[c].toString().trim(),
        isoDate: monthLabelToDate(monthsRow[c].toString().trim())
      });
    }
  }

  // Encontrar el último mes con datos reales
  const lastMonthWithData = findLastMonthWithData(allData, months);
  const activeMonths = months.filter(m => m.index <= lastMonthWithData.index);

  // Construir respuesta
  return {
    metadata: {
      lastUpdate: lastMonthWithData.label,
      totalMonths: activeMonths.length,
      currency: 'RD$',
      locale: 'es-DO',
      sheetName: CONFI.SHEET_NAME
    },
    summary: {
      patrimonioNeto: extractRowWithHistory(allData, 'Patrimonio Neto', activeMonths),
      activosTotales: extractRowWithHistory(allData, 'Activos Totales', activeMonths),
      pasivosTotal: extractRowWithHistory(allData, 'Pasivos Totales Gastados', activeMonths),
      liquidoTotal: extractRowWithHistory(allData, 'Líquido Total', activeMonths),
      inversionesTotal: extractRowWithHistory(allData, 'Inversiones Total', activeMonths),
      ingresosNetos: extractRowWithHistory(allData, 'Ing Neto Total', activeMonths),
      gastosTotal: extractRowWithHistory(allData, 'Total Gastado', activeMonths),
      presupuesto: extractRowWithHistory(allData, 'Presupuesto Mensual', activeMonths),
      otrosActivos: extractRowWithHistory(allData, 'Otros Activos Total', activeMonths),
      creditosTotal: extractRowWithHistory(allData, 'Cantidad de Creditos en Total', activeMonths)
    },
    cuentas: extractSection(allData, activeMonths, 
      ['Débito Banreservas', 'Cash', 'Débito Popular', 'Debito Popular', 
       'Débito Banreservas - Emely', 'Emely Cash', 'Digital Banreservas', 
       'Digital Popular', 'Digital Banreservas - Emely', 'Digital BHD',
       'BDI: Ahorro', 'QIK: Ahorro', 'Ademi: Ahorro', 'Cash US', 
       'Airtm', 'Paypal USD', 'Honeygain', 'Binance']),
    creditos: extractSection(allData, activeMonths,
      ['Crédito Banreservas', 'Crédito Qik', 'Crédito Popular Clásica',
       'Crédito Caribe DOP', 'Crédito Caribe USD', 'Crédito Banreservas Gold',
       'Crédito Banreservas Gold USD', 'Crédito BHD Premia DOP',
       'Crédito BHD Premia USD', 'Extra Limite Caribe', 'Prestamo Popular',
       'Credimás Banreservas', 'Prestamo Modeco', 'Crediclick BHD']),
    inversiones: extractSection(allData, activeMonths,
      ['Alpha View', 'UC United Capital', 'Larimar', 'Cesar Iglesias',
       'SIVEMBC263', 'Certificado Banreserva', 'Alcanza Inversiones',
       'Haina Investment 2034', 'Fondo de Fondos Altio', 'Etoro', 'Hapi',
       'TradeStation', 'SIVEM-164 HAINA', 'United Mancumunada',
       'Goarbit', 'Goarbit Rachel', 'BHD - Modeco', 'Cash - Modeco', 'Cash USD - Modeco']),
    ingresos: extractSection(allData, activeMonths,
      ['Trabajo', 'Clases de Música', 'Eventos', 'Iglesias', 'Developer',
       'Cheques, cupones', 'Regalos', 'Puntos', 'Intereses, dividendos',
       'Inversiones', 'Otros ingresos']),
    gastos: extractSection(allData, activeMonths,
      ['Comida', 'Compras', 'Transporte', 'Servicios', 'Gastos financieros',
       'Otros', 'Donativos', 'Educacion', 'Entretenimiento', 'Ahorros', 'Inversión']),
    puntos: extractSection(allData, activeMonths,
      ['Puntos Banreservas Crédito', 'Millas Popular Crédito', 
       'Puntos Caribe Crédito', 'Estrellas BHD']),
    tasas: {
      patrimonio: calculateGrowthRate(extractRowWithHistory(allData, 'Patrimonio Neto', activeMonths).history),
      inversiones: calculateGrowthRate(extractRowWithHistory(allData, 'Inversiones Total', activeMonths).history),
      liquido: calculateGrowthRate(extractRowWithHistory(allData, 'Líquido Total', activeMonths).history)
    },
    monedas: {
      usd: extractRowWithHistory(allData, 'Moneda US', activeMonths),
      col: extractRowWithHistory(allData, 'Moneda COL', activeMonths),
      mxn: extractRowWithHistory(allData, 'Moneda MX', activeMonths)
    },
    presupuesto: getPresupuestoData(),
    categorias: getCategoriasData(),
    creditoDB: getCreditoData()
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function findLastMonthWithData(allData, months) {
  const patrimonioRow = findRowIndex(allData, 'Patrimonio Neto');
  if (patrimonioRow === -1) return months[months.length - 1];

  for (let i = months.length - 1; i >= 0; i--) {
    const col = months[i].index;
    const val = allData[patrimonioRow][col];
    if (val !== '' && val !== null && val !== undefined && val !== '-') {
      const numVal = parseCurrency(val);
      if (!isNaN(numVal)) {
        return months[i];
      }
    }
  }
  return months[months.length - 1];
}

function findRowIndex(allData, rowName) {
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] && allData[i][0].toString().trim() === rowName) {
      return i;
    }
  }
  return -1;
}

function extractRowWithHistory(allData, rowName, months) {
  const rowIdx = findRowIndex(allData, rowName);
  if (rowIdx === -1) {
    return { current: 0, previous: 0, change: 0, changePct: 0, history: [] };
  }

  const row = allData[rowIdx];
  const history = [];

  for (const month of months) {
    const col = month.index;
    const rawVal = col < row.length ? row[col] : '';
    const val = parseCurrency(rawVal);
    history.push({
      date: month.label,
      isoDate: month.isoDate,
      value: val
    });
  }

  const current = history.length > 0 ? history[history.length - 1].value : 0;
  const previous = history.length > 1 ? history[history.length - 2].value : current;
  const change = current - previous;
  const changePct = previous !== 0 ? (change / Math.abs(previous)) * 100 : 0;

  return {
    current: current,
    previous: previous,
    change: change,
    changePct: parseFloat(changePct.toFixed(2)),
    history: history
  };
}



function extractSection(allData, months, rowNames) {
  const result = {};
  for (const name of rowNames) {
    const data = extractRowWithHistory(allData, name, months);
    if (data.current !== 0 || data.history.some(h => h.value !== 0)) {
      result[name] = data;
    }
  }
  return result;
}

function parseCurrency(value) {
  if (value === '' || value === null || value === undefined || value === '-') {
    return 0;
  }
  const str = value.toString().trim();
  if (str === '') return 0;

  const cleaned = str
    .replace(/RD\$/g, '')
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/\s/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function monthLabelToDate(label) {
  // Si necesitas formato ISO para cálculos, devuélvelo como string
  const monthMap = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  };

  try {
    const parts = label.split("'");
    if (parts.length === 2) {
      const month = monthMap[parts[0]] || '01';
      const year = '20' + parts[1];
      return year + '-' + month + '-01';  // ← String, no Date
    }
  } catch (e) {}
  
  return label;  // ← String original
}

function calculateGrowthRate(history) {
  const rates = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].value;
    const curr = history[i].value;
    if (prev !== 0) {
      const rate = ((curr - prev) / Math.abs(prev)) * 100;
      rates.push({
        date: history[i].date,
        isoDate: history[i].isoDate,
        value: parseFloat(rate.toFixed(2))
      });
    } else {
      rates.push({
        date: history[i].date,
        isoDate: history[i].isoDate,
        value: 0
      });
    }
  }
  return rates;
}

// ============================================================================
// ENDPOINTS ADICIONALES
// ============================================================================

function getSummaryData() {
  const allData = getAllData();
  return {
    metadata: allData.metadata,
    summary: allData.summary
  };
}

function getHistoricalData() {
  const allData = getAllData();
  return {
    metadata: allData.metadata,
    history: {
      patrimonioNeto: allData.summary.patrimonioNeto.history,
      activosTotales: allData.summary.activosTotales.history,
      pasivosTotal: allData.summary.pasivosTotal.history,
      liquidoTotal: allData.summary.liquidoTotal.history,
      inversionesTotal: allData.summary.inversionesTotal.history,
      ingresosNetos: allData.summary.ingresosNetos.history,
      gastosTotal: allData.summary.gastosTotal.history
    }
  };
}

// ============================================================================
// UTILIDADES PARA DEBUG
// ============================================================================

function testExtract() {
  const data = getAllData();
  Logger.log('=== METADATA ===');
  Logger.log(JSON.stringify(data.metadata, null, 2));

  Logger.log('\n=== PATRIMONIO NETO ===');
  Logger.log('Current: ' + data.summary.patrimonioNeto.current);
  Logger.log('Change: ' + data.summary.patrimonioNeto.changePct + '%');

  Logger.log('\n=== CUENTAS BANCARIAS ===');
  for (const [name, info] of Object.entries(data.cuentas)) {
    Logger.log(name + ': RD$' + info.current.toLocaleString('es-DO'));
  }

  Logger.log('\n=== INVERSIONES ===');
  for (const [name, info] of Object.entries(data.inversiones)) {
    Logger.log(name + ': RD$' + info.current.toLocaleString('es-DO'));
  }

  Logger.log('\n=== CRÉDITOS ===');
  for (const [name, info] of Object.entries(data.creditos)) {
    Logger.log(name + ': RD$' + info.current.toLocaleString('es-DO'));
  }

  return data;
}

function getSheetStructure() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFI.SHEET_NAME);
  const lastRow = sheet.getLastRow();

  const names = [];
  for (let i = 1; i <= lastRow; i++) {
    const val = sheet.getRange(i, 1).getValue();
    if (val && val.toString().trim()) {
      names.push({ row: i, name: val.toString().trim() });
    }
  }

  Logger.log(JSON.stringify(names, null, 2));
  return names;
}


// ============================================================================
// DB_PRESUPUESTO
// ============================================================================

function getPresupuestoData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_PRESUPUESTO');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    rows.push({
      id: row[0],
      idCategoria: row[1],
      mesAno: row[2] instanceof Date ? (row[2].getMonth() + 1) + '/1/' + row[2].getFullYear() : row[2].toString(),
      montoPresupuestado: parseCurrency(row[3]),
      gastoReal: parseCurrency(row[4]),
      diferencia: parseCurrency(row[5]),
      tipo: row[6],
      diasRestantes: row[7] || 0,
      presupuestoPct: parseFloat(row[8]) || 0,
      realPct: parseFloat(row[9]) || 0,
      recomendacionDiaria: parseCurrency(row[10]),
      promedioDiario: parseCurrency(row[11]),
      mensaje: row[12] || '',
      particion: row[13] || '',
      presupuestoAnthony: parseCurrency(row[14]),
      presupuestoEmely: parseCurrency(row[15]),
      gastoAnthony: parseCurrency(row[16]),
      gastoEmely: parseCurrency(row[17]),
      restanteAnthony: parseCurrency(row[18]),
      restanteEmely: parseCurrency(row[19])
    });
  }

  return rows;
}

// ============================================================================
// DB_CATEGORIAS
// ============================================================================

function getCategoriasData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_CATEGORIAS');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const categorias = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    categorias.push({
      id: row[0],
      nombre: row[1],
      tipo: row[2],
      padre: row[3] || null,
      etiqueta: row[4] || row[1]
    });
  }

  return categorias;
}

// ============================================================================
// UTILIDAD EXTRA
// ============================================================================

function formatDateToString(dateValue) {
  if (!dateValue) return '';
  
  // Zona horaria de tu hoja (ajústala si es diferente)
  const TIMEZONE = 'America/Santo_Domingo';
  
  let dateObj = null;
  
  if (dateValue instanceof Date) {
    dateObj = dateValue;
  } else if (typeof dateValue === 'number') {
    // Número serial de Excel/Sheets → convertir a Date
    // Base de Excel: 30 de diciembre de 1899
    const excelEpoch = new Date(1899, 11, 30);
    dateObj = new Date(excelEpoch.getTime() + dateValue * 24 * 60 * 60 * 1000);
  } else if (typeof dateValue === 'string') {
    // Si es texto, intentar parsear
    const parsed = new Date(dateValue);
    if (!isNaN(parsed.getTime())) dateObj = parsed;
  }
  
  if (dateObj) {
    return Utilities.formatDate(dateObj, TIMEZONE, 'dd/MM/yyyy');
  }
  
  return dateValue.toString().trim();
}

function testFindRow() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('BALANCE SHEET');
    const allData = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    
    const idx = findRowIndex(allData, 'Cantidad de Creditos en Total');
    Logger.log('Índice encontrado: ' + idx);
    
    if (idx !== -1) {
        Logger.log('Valor en última columna: ' + allData[idx][allData[idx].length - 1]);
        Logger.log(allData[idx][allData[idx].length - 1]);
    }
}

// ============================================================================
// DB_CREDITO
// ============================================================================

function getCreditoData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_CREDITO');
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;

    rows.push({
      nombre: row[0],
      banco: row[1] || '',
      tipoTarjeta: row[2] || '',
      moneda: row[3] || 'DOP',
      limiteTotal: parseCurrency(row[4]),
      balanceActual: parseCurrency(row[5]),
      pctUso: row[6] || '0%',
      limiteSaludable: parseCurrency(row[7]),
      disponible: parseCurrency(row[8]),
      diaCorte: row[9] || '',
      fechaCorte: row[10] ? formatDateToString(row[10]) : '',
      diasGracia: row[11] || '',
      fechaPago: row[12] ? formatDateToString(row[12]) : '',
      diasFaltaPago: row[13] || '',
      tasaInteres: row[14] || '',
      pagoRecomendado: parseCurrency(row[15]),
      cashback: row[16] || '',
      puntos: row[17] || '',
      notas: row[18] || '',
      ultimoAumento: row[19] ? formatDateToString(row[19]) : '',
      diasRestantes: row[20] || '',
      dolar: parseCurrency(row[21])
    });
  }

  return rows;
}

function testCreditoDates() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_CREDITO');
  const data = sheet.getDataRange().getValues();
  
  // Lee la primera fila de datos (índice 1 = segunda fila de la hoja)
  const row = data[1];
  
  Logger.log('=== DEBUG DB_CREDITO ===');
  Logger.log('Col J (diaCorte): ' + row[9] + ' | tipo: ' + typeof row[9]);
  Logger.log('Col K (fechaCorte): ' + row[10] + ' | tipo: ' + typeof row[10]);
  Logger.log('Col L (diasGracia): ' + row[11] + ' | tipo: ' + typeof row[11]);
  Logger.log('Col M (fechaPago): ' + row[12] + ' | tipo: ' + typeof row[12]);
  
  // Probar la conversión
  Logger.log('fechaCorte formateada: ' + formatDateToString(row[10]));
  Logger.log('fechaPago formateada: ' + formatDateToString(row[12]));
}


// DB_GASTOS — ENDPOINT PARA GASTOS/INGRESOS DETALLADOS POR CATEGORÍA
// SOLO SUMA CATEGORÍAS PRINCIPALES (nivel 1, sin padre en DB_CATEGORIAS)
// ============================================================================

// Categorías principales (nivel 1, sin Padre en DB_CATEGORIAS)
// Estas son las ÚNICAS que se suman para los totales mensuales.
const CAT_PRINCIPALES = ["Comida","Compras","Transporte","Servicios","Gastos financieros","Otros","Donativos","Educacion","Entretenimiento","Ahorros","Inversión","Trabajo","Clases de Música","Eventos","Iglesias","Developer","Cheques, cupones","Regalos","Puntos","Intereses, dividendos","Inversiones","Otros ingresos"];

// Mapa de tipo por categoría principal
const CAT_TIPO = {
  "Comida":"Gastos","Compras":"Gastos","Transporte":"Gastos","Servicios":"Gastos",
  "Gastos financieros":"Gastos","Otros":"Gastos","Donativos":"Gastos","Educacion":"Gastos",
  "Entretenimiento":"Gastos","Ahorros":"Gastos","Inversión":"Gastos",
  "Trabajo":"Ingresos","Clases de Música":"Ingresos","Eventos":"Ingresos","Iglesias":"Ingresos",
  "Developer":"Ingresos","Cheques, cupones":"Ingresos","Regalos":"Ingresos","Puntos":"Ingresos",
  "Intereses, dividendos":"Ingresos", "Inversiones":"Ingresos", "Otros ingresos":"Ingresos"
};

// ============================================================================
// DB_MODECO — CLASIFICACIÓN FINANCIERA
// ============================================================================

const MODECO_CLASIFICACION = {
  // COGS — Costo de bienes vendidos
  "Compras y Materia Prima - COGS": "COGS",
  "Logística Directa de Entrega - COGS": "COGS",
  "Mermas / Desperdicio - COGS": "COGS",
  "Reparaciones mantenimiento - COGS": "COGS",

  // OPEX — Gastos operativos
  "Recursos Humanos - OPEX": "OPEX",
  "Viajes y Representación - OPEX": "OPEX",
  "Operaciones y Planta - OPEX": "OPEX",
  "Desarrollo y Formacion - OPEX": "OPEX",
  "Administracion y Legales - OPEX": "OPEX",
  "Tecnología y Software - OPEX": "OPEX",
  "Marketing y Comercializacion - OPEX": "OPEX",

  // CAPEX — Inversión en activos
  "Maquinaria, Herramientas y Muebles - CAPEX": "CAPEX",

  // Modeco — Otros gastos / financieros / impuestos
  "Fondo Misiones - Modeco": "Modeco",
  "Impuestos - Modeco": "Modeco",
  "Intereses y Comisiones Bancarias - Modeco": "Modeco",
  "Depreciacion de Activos - Modeco": "Modeco",
  "Otros Gastos - Modeco": "Modeco",

  // Ingresos
  "Modeco - Encargos": "Ingreso",
  "Modeco - Ventas": "Ingreso",
  "Modeco - Patrocinio": "Ingreso",
  "Modeco - Donaciones": "Ingreso",
  "Modeco - Otros Ingresos": "Ingreso"
};

// Son encabezados/grupos, no categorías de gasto. Se excluyen del cálculo
// para evitar sumar un subtotal junto con el detalle de sus subcategorías.
const MODECO_GROUP_HEADERS = new Set([
  'COGS - Costo Directo',
  'OPEX - Gastos Operativos',
  'CAPEX - Inversion en Activos Fijos',
  'CAPEX - Inversión en Activos Fijos',
  'Impuestos e Intereses - Modeco'
].map(name => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()));

function isModecoGroupHeader_(name) {
  const normalized = String(name || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return MODECO_GROUP_HEADERS.has(normalized);
}

function getGastosData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('DB_GASTOS');

  if (!sheet) {
    return { error: true, message: 'No se encontró la hoja "DB_GASTOS"' };
  }

  const allData = sheet.getDataRange().getValues();
  if (allData.length < 2) {
    return { error: true, message: 'La hoja DB_GASTOS no tiene datos suficientes' };
  }

  // --- Headers de categorías (fila 1, índice 0) ---
  const headerRow = allData[0];
  const categories = [];
  for (let c = 1; c < headerRow.length; c++) {
    const name = headerRow[c] ? headerRow[c].toString().trim() : '';
    if (name) categories.push({ index: c, name: name });
  }

  // --- Identificar índices de categorías PRINCIPALES ---
  const idxPrincipales = [];
  const idxHojas = [];
  for (const cat of categories) {
    if (CAT_PRINCIPALES.indexOf(cat.name) >= 0) {
      idxPrincipales.push(cat);
    } else {
      idxHojas.push(cat);
    }
  }

  // --- Procesar filas de meses ---
  const meses = [];
  const categoriasSummary = {};

  for (const cat of categories) {
    categoriasSummary[cat.name] = {
      name: cat.name,
      total: 0,
      current: 0,
      previous: 0,
      change: 0,
      changePct: 0,
      history: []
    };
  }

  for (let r = 1; r < allData.length; r++) {
    const row = allData[r];
    const monthLabel = row[0] ? row[0].toString().trim() : '';
    if (!monthLabel) continue;

    const mesObj = {
      mes: monthLabel,
      isoDate: monthLabelToDate(monthLabel),
      totalMes: 0,
      totalGasto: 0,
      totalIngreso: 0,
      valores: {}
    };

    for (const cat of categories) {
      const rawVal = (cat.index < row.length) ? row[cat.index] : '';
      const val = parseCurrency(rawVal);

      mesObj.valores[cat.name] = val;

      // Solo sumar al total mensual si es categoría PRINCIPAL
      if (CAT_PRINCIPALES.indexOf(cat.name) >= 0) {
        mesObj.totalMes += val;
        const tipo = CAT_TIPO[cat.name] || 'Gastos';
        if (tipo === 'Gastos') mesObj.totalGasto += val;
        else mesObj.totalIngreso += val;
      }

      const summary = categoriasSummary[cat.name];
      summary.total += val;
      summary.history.push({
        mes: monthLabel,
        isoDate: mesObj.isoDate,
        value: val
      });
    }

    meses.push(mesObj);
  }

  // --- Calcular current / previous / change por categoría ---
  for (const cat of categories) {
    const s = categoriasSummary[cat.name];
    if (s.history.length > 0) {
      s.current = s.history[0].value;
      s.previous = s.history.length > 1 ? s.history[1].value : s.current;
      s.change = s.current - s.previous;
      s.changePct = s.previous !== 0
        ? parseFloat(((s.change / Math.abs(s.previous)) * 100).toFixed(2))
        : 0;
    }
  }

  // --- Totales por mes (SOLO principales) ---
  const totalPorMes = meses.map(m => ({
    mes: m.mes,
    isoDate: m.isoDate,
    total: m.totalMes,
    gasto: m.totalGasto,
    ingreso: m.totalIngreso
  }));

  // --- Top categorías del mes actual (solo principales con gasto > 0) ---
  const topCurrent = Object.values(categoriasSummary)
    .filter(c => CAT_PRINCIPALES.indexOf(c.name) >= 0 && c.current > 0)
    .sort((a, b) => b.current - a.current)
    .slice(0, 30);

  // --- Top categorías totales (histórico, solo principales) ---
  const topTotal = Object.values(categoriasSummary)
    .filter(c => CAT_PRINCIPALES.indexOf(c.name) >= 0 && c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  // --- Mes actual / anterior (solo principales) ---
  const mesActual = meses.length > 0 ? {
    mes: meses[0].mes,
    total: meses[0].totalMes,
    gasto: meses[0].totalGasto,
    ingreso: meses[0].totalIngreso
  } : null;

  const mesAnterior = meses.length > 1 ? {
    mes: meses[1].mes,
    total: meses[1].totalMes,
    gasto: meses[1].totalGasto,
    ingreso: meses[1].totalIngreso
  } : null;

  return {
    metadata: {
      lastUpdate: meses.length > 0 ? meses[0].mes : '',
      totalMonths: meses.length,
      totalCategories: categories.length,
      totalPrincipales: idxPrincipales.length,
      currency: 'RD$',
      locale: 'es-DO'
    },
    meses: meses,
    categorias: categoriasSummary,
    resumen: {
      totalPorMes: totalPorMes,
      topCurrent: topCurrent,
      topTotal: topTotal,
      mesActual: mesActual,
      mesAnterior: mesAnterior
    }
  };
}

// Test rápido (ejecutar desde el editor de Apps Script)
function testGetGastos() {
  const data = getGastosData();
  if (data.error) {
    Logger.log('ERROR: ' + data.message);
    return;
  }
  Logger.log('Meses: ' + data.metadata.totalMonths);
  Logger.log('Categorías: ' + data.metadata.totalCategories);
  Logger.log('Principales: ' + data.metadata.totalPrincipales);
  Logger.log('Último mes: ' + data.metadata.lastUpdate);
  Logger.log('Total mes actual (principales): ' + data.resumen.mesActual.total);
  Logger.log('Gasto mes actual: ' + data.resumen.mesActual.gasto);
  Logger.log('Ingreso mes actual: ' + data.resumen.mesActual.ingreso);
  Logger.log('Top 5 categorías actual:');
  data.resumen.topCurrent.slice(0, 22).forEach(c => {
    Logger.log('  ' + c.name + ': ' + c.current);
  });
}


// ============================================================================
// UPDATE BUDGET — Guardar presupuesto editado desde el frontend
// ============================================================================

function updateBudgetData(e) {
  try {
    const dataParam = e.parameter.data;
    if (!dataParam) {
      return { success: false, message: 'Falta parámetro data' };
    }

    const payload = JSON.parse(dataParam);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Editar Presupuesto');

    if (!sheet) {
      return { success: false, message: 'Hoja "Editar Presupuesto" no encontrada' };
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { success: false, message: 'Hoja vacía' };
    }

    // Leer toda la hoja
    const range = sheet.getRange(2, 1, lastRow - 1, 4); // A:Categoría, B:Monto, C:%, D:Ajuste
    const values = range.getValues();

    // ============================================
    // PASO 1: Actualizar INGRESOS (los que envió el frontend)
    // ============================================
    let ingresosTotal = 0;
    const ingresosMap = {};
    
    if (payload.ingresos && payload.ingresos.categorias) {
      payload.ingresos.categorias.forEach(c => {
        ingresosMap[c.nombre] = { monto: c.monto, pct: c.pct };
        ingresosTotal += c.monto;
      });
      
      for (let i = 0; i < values.length; i++) {
        const catName = values[i][0] ? values[i][0].toString().trim() : '';
        if (ingresosMap[catName]) {
          values[i][1] = ingresosMap[catName].monto;
          // Si la columna C tiene fórmulas, comenta la siguiente línea:
          values[i][2] = ingresosMap[catName].pct / 100;
        }
      }
    }

    // ============================================
    // PASO 2: Recalcular GASTOS proporcionalmente
    // ============================================
    // Leer los gastos actuales de la hoja para saber sus porcentajes
    const gastosRows = []; // { index, nombre, pctActual }
    let gastosTotalAnterior = 0;
    
    for (let i = 0; i < values.length; i++) {
      const catName = values[i][0] ? values[i][0].toString().trim() : '';
      const monto = parseFloat(values[i][1]) || 0;
      const pct = parseFloat(values[i][2]) || 0;
      
      // Identificar si es gasto (no está en ingresos y tiene monto > 0 o es categoría de gasto)
      // O si el frontend envió gastos específicos, usarlos
      if (!ingresosMap[catName] && monto > 0) {
        gastosRows.push({ index: i, nombre: catName, pctActual: pct, montoAnterior: monto });
        gastosTotalAnterior += monto;
      }
    }

    // Si el frontend envió gastos específicos, usarlos. Si no, recalcular proporcionalmente
    if (payload.gastos && payload.gastos.categorias && payload.gastos.categorias.length > 0) {
      // Frontend envió gastos ya calculados
      const gastosMap = {};
      payload.gastos.categorias.forEach(c => {
        gastosMap[c.nombre] = { monto: c.monto, pct: c.pct };
      });
      
      for (let i = 0; i < values.length; i++) {
        const catName = values[i][0] ? values[i][0].toString().trim() : '';
        if (gastosMap[catName]) {
          values[i][1] = gastosMap[catName].monto;
          values[i][2] = gastosMap[catName].pct / 100;
        }
      }
    } else {
      // ← RECÁLCULO AUTOMÁTICO: Gastos proporcional al nuevo total de ingresos
      if (gastosRows.length > 0 && ingresosTotal > 0) {
        gastosRows.forEach(gasto => {
          // Calcular nuevo monto manteniendo el mismo % del total anterior
          // O si tenía un % definido, usar ese % del nuevo total de ingresos
          const pctDelTotal = gastosTotalAnterior > 0 ? (gasto.montoAnterior / gastosTotalAnterior) : 0;
          const nuevoMonto = Math.round(ingresosTotal * pctDelTotal);
          
          values[gasto.index][1] = nuevoMonto;
          values[gasto.index][2] = pctDelTotal; // % como decimal
        });
      }
    }

    // Escribir todo de vuelta
    range.setValues(values);

    // Calcular totales finales
    let finalGastosTotal = 0;
    for (let i = 0; i < values.length; i++) {
      const catName = values[i][0] ? values[i][0].toString().trim() : '';
      if (!ingresosMap[catName]) {
        finalGastosTotal += parseFloat(values[i][1]) || 0;
      }
    }

    return {
      success: true,
      message: 'Presupuesto actualizado: Ingresos y Gastos recalculados',
      totalIngresos: ingresosTotal,
      totalGastos: finalGastosTotal,
      diferencia: ingresosTotal - finalGastosTotal
    };

  } catch (err) {
    return { success: false, message: err.toString() };
  }
}

function walletProxy(e) {
  const p = e.parameter;
  const token = p.token;
  const walletMethod = (p.walletMethod || 'GET').toUpperCase();
  const walletEndpoint = p.walletEndpoint || '';
  
  let bodyJson = null;
  if (e.postData && e.postData.contents) {
    bodyJson = e.postData.contents;
  } else if (p.body) {
    bodyJson = p.body;
  }
  
  if (!token) return { error: true, message: 'Falta token de Wallet' };
  if (!walletEndpoint) return { error: true, message: 'Falta walletEndpoint' };

  const baseUrl = 'https://rest.budgetbakers.com/wallet/v1/api';
  const fullUrl = baseUrl + walletEndpoint;

  const options = {
    method: walletMethod,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (bodyJson && ['POST', 'PATCH', 'PUT'].indexOf(walletMethod) >= 0) {
    options.contentType = 'application/json';
    options.payload = bodyJson;
  }

  try {
    const response = UrlFetchApp.fetch(fullUrl, options);
    const code = response.getResponseCode();
    const text = response.getContentText();

    if (code < 200 || code >= 300) {
      return { 
        error: true, 
        status: code, 
        message: 'Wallet API respondió ' + code, 
        body: text,
        debug: { proxyUrl: fullUrl, proxyMethod: walletMethod, proxyBody: bodyJson }
      };
    }

    let data;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    return { error: false, status: code, data: data };

  } catch (err) {
    return { 
      error: true, 
      message: err.toString(),
      debug: { proxyUrl: fullUrl, proxyMethod: walletMethod, proxyBody: bodyJson }
    };
  }
}

// ============================================================================
// JARRAS — ENDPOINT PARA EL MÉTODO DE LAS 6 JARRAS
// ============================================================================

function getJarrasData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('JARRAS');

    if (!sheet) {
      return { error: true, message: 'No se encontró la hoja "JARRAS"' };
    }

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    
    if (lastRow < 3) {
      return { error: true, message: 'La hoja JARRAS no tiene datos suficientes (mínimo 3 filas)' };
    }

    // Leer todo de una vez
    const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    
    // DEBUG: ver qué hay en la primera columna
    Logger.log('=== DEBUG JARRAS ===');
    Logger.log('Total filas: ' + allData.length);
    Logger.log('Fila 0 (headers): ' + JSON.stringify(allData[0]));
    Logger.log('Fila 1 (sub-headers): ' + JSON.stringify(allData[1]));
    Logger.log('Fila 2 (primer dato): ' + JSON.stringify(allData[2]));
    Logger.log('Tipo de A3: ' + typeof allData[2][0]);
    Logger.log('Valor de A3: ' + allData[2][0]);

    // Fila 1 (índice 0): nombres de jarras
    const jarraHeaders = allData[0];
    
    // Mapear jarras: cada una ocupa 2 columnas (Presupuesto, Gastado)
    // Col 0 = mes, Col 1-2 = Jarra1, Col 3-4 = Jarra2...
    const jarras = [];
    for (let c = 1; c < jarraHeaders.length; c += 2) {
      const nombre = jarraHeaders[c] ? String(jarraHeaders[c]).trim() : '';
      if (nombre) {
        jarras.push({
          nombre: nombre,
          colPresupuesto: c,
          colGastado: c + 1
        });
      }
    }

    if (jarras.length === 0) {
      return { error: true, message: 'No se encontraron jarras en la fila 1. Verifica que los nombres estén en columnas B, D, F...' };
    }

    Logger.log('Jarras detectadas: ' + jarras.map(j => j.nombre).join(', '));

    // Procesar filas de datos
    const meses = [];
    const resumenPorAno = {};

    for (let r = 2; r < allData.length; r++) {
      const row = allData[r];
      const rawMes = row[0];
      
      // DEBUG
      if (r < 6) {
        Logger.log('Fila ' + (r+1) + ' raw A: ' + rawMes + ' | tipo: ' + typeof rawMes);
      }
      
      const mesLabel = rawMes ? String(rawMes).trim() : '';
      if (!mesLabel || mesLabel === '') continue;

      const parsed = parseJarraMonth(rawMes); // Pasamos rawMes, no el string, para que maneje Date
      if (!parsed) {
        Logger.log('  → No se pudo parsear: ' + mesLabel);
        continue;
      }

      Logger.log('  → Parseado: ' + parsed.month + ' / ' + parsed.year);

      const year = parsed.year;
      const mesEntry = {
        label: mesLabel,
        year: year,
        month: parsed.month,
        isoDate: parsed.isoDate,
        jarras: {}
      };

      for (const jarra of jarras) {
        const pRaw = (jarra.colPresupuesto < row.length) ? row[jarra.colPresupuesto] : '';
        const gRaw = (jarra.colGastado < row.length) ? row[jarra.colGastado] : '';
        
        const presupuesto = parseCurrency(pRaw);
        const gastado = parseCurrency(gRaw);

        mesEntry.jarras[jarra.nombre] = {
          presupuesto: presupuesto,
          gastado: gastado,
          diferencia: presupuesto - gastado,
          pctUsado: presupuesto > 0 ? parseFloat(((gastado / presupuesto) * 100).toFixed(2)) : 0
        };

        if (!resumenPorAno[year]) resumenPorAno[year] = {};
        if (!resumenPorAno[year][jarra.nombre]) {
          resumenPorAno[year][jarra.nombre] = { presupuesto: 0, gastado: 0, meses: 0 };
        }
        resumenPorAno[year][jarra.nombre].presupuesto += presupuesto;
        resumenPorAno[year][jarra.nombre].gastado += gastado;
        resumenPorAno[year][jarra.nombre].meses += 1;
      }

      meses.push(mesEntry);
    }

    Logger.log('Total meses parseados: ' + meses.length);

    if (meses.length === 0) {
      return { error: true, message: 'No se pudieron parsear los meses. Verifica que la columna A tenga valores como Aug\'26 o fechas.' };
    }

    // Calcular % en resumen anual
    const years = [];
    for (const year in resumenPorAno) {
      years.push(year);
      for (const jarra in resumenPorAno[year]) {
        const r = resumenPorAno[year][jarra];
        r.pctUsado = r.presupuesto > 0 ? parseFloat(((r.gastado / r.presupuesto) * 100).toFixed(2)) : 0;
        r.diferencia = r.presupuesto - r.gastado;
      }
    }
    years.sort((a, b) => parseInt(b) - parseInt(a));

    return {
      metadata: {
        lastUpdate: meses[0].label,
        totalMonths: meses.length,
        totalJarras: jarras.length,
        years: years,
        currency: 'RD$',
        locale: 'es-DO'
      },
      jarras: jarras.map(j => j.nombre),
      resumenAnual: resumenPorAno,
      historialMensual: meses
    };

  } catch (err) {
    Logger.log('ERROR en getJarrasData: ' + err.toString());
    return { error: true, message: 'Error interno: ' + err.toString(), stack: err.stack };
  }
}

function parseJarraMonth(rawValue) {
  if (!rawValue) return null;
  
  // === CASO 1: Es un objeto Date de Google Sheets ===
  if (rawValue instanceof Date) {
    const d = rawValue;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthName = months[d.getMonth()];
    const year = String(d.getFullYear());
    const monthNum = String(d.getMonth() + 1).padStart(2, '0');
    return {
      month: monthName,
      year: year,
      isoDate: year + '-' + monthNum + '-01'
    };
  }
  
  const str = String(rawValue).trim();
  
  // === CASO 2: Formato "Aug'26" o "Aug '26" ===
  const monthMap = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  };
  
  try {
    // Manejar tanto "Aug'26" como "Aug '26"
    const parts = str.split("'");
    if (parts.length >= 2) {
      const month = parts[0].trim();
      const yearShort = parts[1] ? parts[1].trim() : '';
      if (monthMap[month] && yearShort) {
        const year = '20' + yearShort;
        return {
          month: month,
          year: year,
          isoDate: year + '-' + monthMap[month] + '-01'
        };
      }
    }
  } catch (e) {}
  
  // === CASO 3: Intentar parsear como fecha genérica (MM/DD/YYYY, etc.) ===
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return {
        month: months[d.getMonth()],
        year: String(d.getFullYear()),
        isoDate: String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'
      };
    }
  } catch (e) {}
  
  // === CASO 4: Formato numérico de Excel (serial number) ===
  if (typeof rawValue === 'number') {
    try {
      // Excel epoch: 30 Dec 1899
      const excelEpoch = new Date(1899, 11, 30);
      const d = new Date(excelEpoch.getTime() + rawValue * 24 * 60 * 60 * 1000);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return {
          month: months[d.getMonth()],
          year: String(d.getFullYear()),
          isoDate: String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'
        };
      }
    } catch (e) {}
  }
  
  return null;
}

function testJarras() {
  const result = getJarrasData();
  Logger.log('=== RESULTADO ===');
  Logger.log(JSON.stringify(result, null, 2));
}


// ============================================================================
// DB_MODECO — ESTADO DE RESULTADOS + BALANCE MODECO
// ============================================================================

/**
 * Determina la clasificación de una categoría de Modeco.
 * Primero usa MODECO_CLASIFICACION; si la categoría no está registrada,
 * intenta inferirla desde el sufijo del nombre.
 */
function getModecoClasificacion(categoryName) {
  const name = categoryName ? categoryName.toString().trim() : '';

  if (MODECO_CLASIFICACION[name]) {
    return MODECO_CLASIFICACION[name];
  }

  if (name.indexOf('- COGS') >= 0) return 'COGS';
  if (name.indexOf('- OPEX') >= 0) return 'OPEX';
  if (name.indexOf('- CAPEX') >= 0) return 'CAPEX';
  if (name.indexOf('- Modeco') >= 0) {
    return name.indexOf('Modeco - ') === 0 ? 'Ingreso' : 'Modeco';
  }

  // Las categorías de ingreso de Modeco empiezan con "Modeco - "
  if (name.indexOf('Modeco - ') === 0) return 'Ingreso';

  return 'Modeco';
}

/**
 * Obtiene la hoja BALANCE SHEET y los meses activos usando el mismo patrón
 * de getAllData(), sin duplicar la extracción de las filas.
 */
function getBalanceSheetContext_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFI.SHEET_NAME);

  if (!sheet) {
    throw new Error('No se encontró la hoja "' + CONFI.SHEET_NAME + '"');
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const allData = sheet.getRange(1, 1, lastRow, lastCol).getValues();

  // Mantener el mismo comportamiento actual de getAllData():
  // la fila de meses está en allData[1].
  const monthsRow = allData[1] || [];
  const months = [];

  for (let c = 1; c < monthsRow.length; c++) {
    if (monthsRow[c] && monthsRow[c].toString().trim()) {
      const label = monthsRow[c].toString().trim();

      months.push({
        index: c,
        label: label,
        isoDate: monthLabelToDate(label)
      });
    }
  }

  const lastMonthWithData = findLastMonthWithData(allData, months);
  const activeMonths = months.filter(function(month) {
    return month.index <= lastMonthWithData.index;
  });

  return {
    sheet: sheet,
    allData: allData,
    months: months,
    activeMonths: activeMonths,
    lastMonthWithData: lastMonthWithData
  };
}

/**
 * Calcula un margen porcentual de forma segura.
 */
function calculateMargin_(value, revenue) {
  if (!revenue || revenue === 0) return 0;
  return parseFloat(((value / Math.abs(revenue)) * 100).toFixed(2));
}

/**
 * Endpoint principal de Modeco.
 *
 * Lee DB_MODECO, separa ingresos y gastos, agrupa los gastos por
 * COGS / OPEX / CAPEX / Modeco, calcula utilidades y márgenes,
 * y combina el resultado con las cuentas Modeco existentes en BALANCE SHEET.
 */
function getModecoData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('DB_MODECO');

    if (!sheet) {
      return {
        error: true,
        message: 'No se encontró la hoja "DB_MODECO"'
      };
    }

    const allData = sheet.getDataRange().getValues();

    if (allData.length < 2) {
      return {
        error: true,
        message: 'La hoja DB_MODECO no tiene datos suficientes'
      };
    }

    // ========================================================================
    // Headers de categorías
    // ========================================================================
    const headerRow = allData[0];
    const categories = [];

    for (let c = 1; c < headerRow.length; c++) {
      const name = headerRow[c] ? headerRow[c].toString().trim() : '';

      if (name && !isModecoGroupHeader_(name)) {
        categories.push({
          index: c,
          name: name,
          clasificacion: getModecoClasificacion(name)
        });
      }
    }

    if (categories.length === 0) {
      return {
        error: true,
        message: 'No se encontraron categorías en DB_MODECO'
      };
    }

    // ========================================================================
    // Resumen por categoría
    // ========================================================================
    const categoriasSummary = {};

    categories.forEach(function(cat) {
      categoriasSummary[cat.name] = {
        name: cat.name,
        clasificacion: cat.clasificacion,
        total: 0,
        current: 0,
        previous: 0,
        change: 0,
        changePct: 0,
        history: []
      };
    });

    // ========================================================================
    // Procesar meses
    // ========================================================================
    const meses = [];

    for (let r = 1; r < allData.length; r++) {
      const row = allData[r];
      const monthLabel = row[0] ? row[0].toString().trim() : '';

      if (!monthLabel) continue;

      const mesObj = {
        mes: monthLabel,
        isoDate: monthLabelToDate(monthLabel),

        ingresos: 0,
        gastos: 0,

        clasificaciones: {
          COGS: 0,
          OPEX: 0,
          CAPEX: 0,
          Modeco: 0
        },

        utilidadBruta: 0,
        utilidadOperativa: 0,
        utilidadNeta: 0,
        flujoDespuesCapex: 0,

        margenBruto: 0,
        margenOperativo: 0,
        margenNeto: 0,

        valores: {}
      };

      categories.forEach(function(cat) {
        const rawVal = cat.index < row.length ? row[cat.index] : '';
        const val = parseCurrency(rawVal);

        mesObj.valores[cat.name] = val;

        if (cat.clasificacion === 'Ingreso') {
          mesObj.ingresos += val;
        } else {
          mesObj.gastos += val;
          mesObj.clasificaciones[cat.clasificacion] += val;
        }

        const summary = categoriasSummary[cat.name];
        summary.total += val;
        summary.history.push({
          mes: monthLabel,
          isoDate: mesObj.isoDate,
          value: val
        });
      });

      // ======================================================================
      // Utilidades
      //
      // utilidadBruta:
      //   Ingresos - COGS
      //
      // utilidadOperativa:
      //   Utilidad bruta - OPEX
      //
      // utilidadNeta:
      //   Ingresos - COGS - OPEX - gastos Modeco
      //
      // flujoDespuesCapex:
      //   Utilidad neta - CAPEX
      //
      // CAPEX se muestra como clasificación independiente porque contablemente
      // representa inversión en activos, no un gasto operativo del periodo.
      // ======================================================================
      mesObj.utilidadBruta =
        mesObj.ingresos - mesObj.clasificaciones.COGS;

      mesObj.utilidadOperativa =
        mesObj.utilidadBruta - mesObj.clasificaciones.OPEX;

      mesObj.utilidadNeta =
        mesObj.utilidadOperativa - mesObj.clasificaciones.Modeco;

      mesObj.flujoDespuesCapex =
        mesObj.utilidadNeta - mesObj.clasificaciones.CAPEX;

      // ======================================================================
      // Márgenes
      // ======================================================================
      mesObj.margenBruto =
        calculateMargin_(mesObj.utilidadBruta, mesObj.ingresos);

      mesObj.margenOperativo =
        calculateMargin_(mesObj.utilidadOperativa, mesObj.ingresos);

      mesObj.margenNeto =
        calculateMargin_(mesObj.utilidadNeta, mesObj.ingresos);

      meses.push(mesObj);
    }

    // ========================================================================
    // Current / previous / change por categoría
    // ========================================================================
    categories.forEach(function(cat) {
      const summary = categoriasSummary[cat.name];

      if (summary.history.length > 0) {
        summary.current = summary.history[0].value;
        summary.previous = summary.history.length > 1
          ? summary.history[1].value
          : summary.current;

        summary.change = summary.current - summary.previous;
        summary.changePct = summary.previous !== 0
          ? parseFloat(((summary.change / Math.abs(summary.previous)) * 100).toFixed(2))
          : 0;
      }
    });

    // ========================================================================
    // Series mensuales para gráficos
    // ========================================================================
    const totalPorMes = meses.map(function(m) {
      return {
        mes: m.mes,
        isoDate: m.isoDate,
        ingresos: m.ingresos,
        gastos: m.gastos,
        COGS: m.clasificaciones.COGS,
        OPEX: m.clasificaciones.OPEX,
        CAPEX: m.clasificaciones.CAPEX,
        Modeco: m.clasificaciones.Modeco,
        utilidadBruta: m.utilidadBruta,
        utilidadOperativa: m.utilidadOperativa,
        utilidadNeta: m.utilidadNeta,
        flujoDespuesCapex: m.flujoDespuesCapex,
        margenBruto: m.margenBruto,
        margenOperativo: m.margenOperativo,
        margenNeto: m.margenNeto
      };
    });

    // ========================================================================
    // Totales históricos por clasificación
    // ========================================================================
    const totales = {
      ingresos: 0,
      gastos: 0,
      COGS: 0,
      OPEX: 0,
      CAPEX: 0,
      Modeco: 0,
      utilidadBruta: 0,
      utilidadOperativa: 0,
      utilidadNeta: 0,
      flujoDespuesCapex: 0
    };

    meses.forEach(function(m) {
      totales.ingresos += m.ingresos;
      totales.gastos += m.gastos;
      totales.COGS += m.clasificaciones.COGS;
      totales.OPEX += m.clasificaciones.OPEX;
      totales.CAPEX += m.clasificaciones.CAPEX;
      totales.Modeco += m.clasificaciones.Modeco;
      totales.utilidadBruta += m.utilidadBruta;
      totales.utilidadOperativa += m.utilidadOperativa;
      totales.utilidadNeta += m.utilidadNeta;
      totales.flujoDespuesCapex += m.flujoDespuesCapex;
    });

    // ========================================================================
    // Mes actual y anterior
    // ========================================================================
    const mesActual = meses.length > 0 ? meses[0] : null;
    const mesAnterior = meses.length > 1 ? meses[1] : null;

    // ========================================================================
    // Top categorías
    // ========================================================================
    const topIngresosCurrent = Object.keys(categoriasSummary)
      .map(function(name) { return categoriasSummary[name]; })
      .filter(function(cat) {
        return cat.clasificacion === 'Ingreso' && cat.current > 0;
      })
      .sort(function(a, b) { return b.current - a.current; });

    const topGastosCurrent = Object.keys(categoriasSummary)
      .map(function(name) { return categoriasSummary[name]; })
      .filter(function(cat) {
        return cat.clasificacion !== 'Ingreso' && cat.current > 0;
      })
      .sort(function(a, b) { return b.current - a.current; });

    const topGastosTotal = Object.keys(categoriasSummary)
      .map(function(name) { return categoriasSummary[name]; })
      .filter(function(cat) {
        return cat.clasificacion !== 'Ingreso' && cat.total > 0;
      })
      .sort(function(a, b) { return b.total - a.total; });

    // ========================================================================
    // Reutilizar extractRowWithHistory() sobre BALANCE SHEET
    // ========================================================================
    const balanceContext = getBalanceSheetContext_();
    const balanceData = balanceContext.allData;
    const activeMonths = balanceContext.activeMonths;

    const balance = {
      bhdModeco: extractRowWithHistory(
        balanceData,
        'BHD - Modeco',
        activeMonths
      ),
      cashModeco: extractRowWithHistory(
        balanceData,
        'Cash - Modeco',
        activeMonths
      ),
      cashUsdModeco: extractRowWithHistory(
        balanceData,
        'Cash USD - Modeco',
        activeMonths
      ),
      prestamoModeco: extractRowWithHistory(
        balanceData,
        'Prestamo Modeco',
        activeMonths
      )
    };

    const liquidezModecoActual =
      balance.bhdModeco.current +
      balance.cashModeco.current +
      balance.cashUsdModeco.current;

    const liquidezModecoAnterior =
      balance.bhdModeco.previous +
      balance.cashModeco.previous +
      balance.cashUsdModeco.previous;

    const liquidezModecoChange =
      liquidezModecoActual - liquidezModecoAnterior;

    const liquidezModecoChangePct = liquidezModecoAnterior !== 0
      ? parseFloat(((liquidezModecoChange / Math.abs(liquidezModecoAnterior)) * 100).toFixed(2))
      : 0;

    // ========================================================================
    // Respuesta final
    // ========================================================================
    return {
      metadata: {
        lastUpdate: meses.length > 0 ? meses[0].mes : '',
        totalMonths: meses.length,
        totalCategories: categories.length,
        currency: 'RD$',
        locale: 'es-DO',
        sheetName: 'DB_MODECO',
        balanceSheetName: CONFI.SHEET_NAME
      },

      meses: meses,
      categorias: categoriasSummary,

      resumen: {
        totalPorMes: totalPorMes,
        totales: totales,

        mesActual: mesActual,
        mesAnterior: mesAnterior,

        topIngresosCurrent: topIngresosCurrent,
        topGastosCurrent: topGastosCurrent,
        topGastosTotal: topGastosTotal,

        liquidez: {
          current: liquidezModecoActual,
          previous: liquidezModecoAnterior,
          change: liquidezModecoChange,
          changePct: liquidezModecoChangePct
        }
      },

      balance: balance
    };
  } catch (err) {
    return {
      error: true,
      message: 'Error en getModecoData: ' + err.toString(),
      stack: err.stack
    };
  }
}

/**
 * Test rápido para ejecutar desde Apps Script.
 */
function testGetModeco() {
  const data = getModecoData();

  if (data.error) {
    Logger.log('ERROR: ' + data.message);
    if (data.stack) Logger.log(data.stack);
    return;
  }

  Logger.log('=== MODECO ===');
  Logger.log('Meses: ' + data.metadata.totalMonths);
  Logger.log('Categorías: ' + data.metadata.totalCategories);
  Logger.log('Último mes: ' + data.metadata.lastUpdate);

  if (data.resumen.mesActual) {
    Logger.log('Ingresos mes actual: ' + data.resumen.mesActual.ingresos);
    Logger.log('Gastos mes actual: ' + data.resumen.mesActual.gastos);
    Logger.log('COGS: ' + data.resumen.mesActual.clasificaciones.COGS);
    Logger.log('OPEX: ' + data.resumen.mesActual.clasificaciones.OPEX);
    Logger.log('CAPEX: ' + data.resumen.mesActual.clasificaciones.CAPEX);
    Logger.log('Modeco: ' + data.resumen.mesActual.clasificaciones.Modeco);
    Logger.log('Utilidad bruta: ' + data.resumen.mesActual.utilidadBruta);
    Logger.log('Utilidad operativa: ' + data.resumen.mesActual.utilidadOperativa);
    Logger.log('Utilidad neta: ' + data.resumen.mesActual.utilidadNeta);
    Logger.log('Flujo después de CAPEX: ' + data.resumen.mesActual.flujoDespuesCapex);
  }

  Logger.log('BHD Modeco: ' + data.balance.bhdModeco.current);
  Logger.log('Cash Modeco: ' + data.balance.cashModeco.current);
  Logger.log('Cash USD Modeco: ' + data.balance.cashUsdModeco.current);
  Logger.log('Préstamo Modeco: ' + data.balance.prestamoModeco.current);
}
