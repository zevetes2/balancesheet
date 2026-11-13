// ============================================
// CONFIGURACIÓN
// ============================================

// URL base de tu proyecto (sin /rest/v1/... al final)
const SUPABASE_URL = 'https://cvuuevtkjspbedimmkmb.supabase.co';

// Endpoint completo de la tabla
const SUPABASE_ENDPOINT = SUPABASE_URL + '/rest/v1/transacciones';

// Clave secreta (service_role / secret)
const SUPABASE_KEY = 'sb_secret_54UeWbhj6U0UGnUgdTerAg_7g09i_fR';

const BATCH_SIZE = 200;
const NOMBRE_HOJA = 'REGISTROS';


// ============================================
// FUNCIÓN PRINCIPAL
// ============================================
function transferirDatosASupabase() {
  const hoja = NOMBRE_HOJA 
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOMBRE_HOJA)
    : SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  
  const datos = hoja.getDataRange().getValues();
  const encabezados = datos[0];
  
  // Mapeo de columnas según tu estructura real
  const indice = {
    account:               encabezados.indexOf('account'),
    category:              encabezados.indexOf('category'),
    currency:              encabezados.indexOf('currency'),
    amount:                encabezados.indexOf('amount'),
    ref_currency_amount:   encabezados.indexOf('ref_currency_amount'),
    type:                  encabezados.indexOf('type'),
    payment_type:          encabezados.indexOf('payment_type'),
    payment_type_local:    encabezados.indexOf('payment_type_local'),
    note:                  encabezados.indexOf('note'),
    date:                  encabezados.indexOf('date'),
    gps_latitude:          encabezados.indexOf('gps_latitude'),
    gps_longitude:         encabezados.indexOf('gps_longitude'),
    gps_accuracy_in_meters:encabezados.indexOf('gps_accuracy_in_meters'),
    warranty_in_month:     encabezados.indexOf('warranty_in_month'),
    transfer:              encabezados.indexOf('transfer'),
    payee:                 encabezados.indexOf('payee'),
    labels:                encabezados.indexOf('labels'),
    envelope_id:           encabezados.indexOf('envelope_id')
  };
  
  Logger.log('Índices detectados: ' + JSON.stringify(indice));
  
    // Procesar filas
  const registros = [];
  const errores = [];
  const clavesVistas = new Set(); // Para evitar duplicados internos
  
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    
    if (esFilaVaciaOEncabezado(fila, indice)) continue;
    
    const registro = construirRegistro(fila, indice, i, errores);
    if (!registro) continue;
    
    // Crear clave compuesta para detectar duplicados internos
    const clave = [
      registro.account || '',
      registro.category || '',
      registro.amount,
      registro.date || '',
      registro.note || ''
    ].join('|||');
    
    if (clavesVistas.has(clave)) {
      errores.push({ fila: i + 1, motivo: 'duplicado interno omitido' });
      continue;
    }
    
    clavesVistas.add(clave);
    registros.push(registro);
  }
  
  Logger.log(`Filas leídas: ${datos.length - 1}`);
  Logger.log(`Registros válidos a enviar: ${registros.length}`);
  Logger.log(`Filas omitidas: ${errores.length}`);
  
  if (errores.length > 0) {
    Logger.log('Primeras 10 omisiones: ' + JSON.stringify(errores.slice(0, 10)));
  }
  
  // Enviar en lotes
  let exitosos = 0;
  let fallidos = 0;
  
  for (let i = 0; i < registros.length; i += BATCH_SIZE) {
    const lote = registros.slice(i, i + BATCH_SIZE);
    const resultado = enviarLoteASupabase(lote, i / BATCH_SIZE + 1);
    
    if (resultado.ok) {
      exitosos += lote.length;
    } else {
      fallidos += lote.length;
    }
    
    Utilities.sleep(150); // Pequeña pausa entre lotes
  }
  
  const resumen = `✅ Enviados: ${exitosos}\n❌ Fallidos: ${fallidos}`;
  Logger.log(resumen);
  SpreadsheetApp.getUi().alert('Transferencia completada', resumen, SpreadsheetApp.getUi().ButtonSet.OK);
}

// ============================================
// VALIDAR SI LA FILA DEBE OMITIRSE
// ============================================
function esFilaVaciaOEncabezado(fila, idx) {
  // Fila completamente vacía
  if (fila.every(c => c === '' || c === null || c === undefined)) return true;
  
  // Encabezado de mes (ej: "ENERO 2022", "2024", "DICIEMBRE 2025")
  // Se detecta porque SOLO la columna category tiene valor y no hay amount
  const amountVacio = fila[idx.amount] === '' || fila[idx.amount] === null;
  const categoria = String(fila[idx.category] || '').trim();
  
  if (amountVacio && categoria.length > 0) {
    // Es un separador tipo "ENERO 2022" o "2024"
    const esSeparador = /^(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE|\d{4})/i.test(categoria);
    if (esSeparador) return true;
  }
  
  // Sin fecha y sin monto -> no es transacción
  const fechaVacia = !fila[idx.date] || fila[idx.date] === '';
  if (fechaVacia && amountVacio) return true;
  
  return false;
}

// ============================================
// CONSTRUIR OBJETO JSON DE UNA FILA
// ============================================
function construirRegistro(fila, idx, numeroFila, errores) {
  try {
    const registro = {
      account:            limpiarTexto(fila[idx.account]),
      category:           limpiarTexto(fila[idx.category]),
      currency:           limpiarTexto(fila[idx.currency]),
      amount:             limpiarNumero(fila[idx.amount]),
      ref_currency_amount:limpiarNumero(fila[idx.ref_currency_amount]),
      type:               limpiarTexto(fila[idx.type]),
      payment_type:       limpiarTexto(fila[idx.payment_type]),
      payment_type_local: limpiarTexto(fila[idx.payment_type_local]),
      note:               limpiarTexto(fila[idx.note]),
      date:               limpiarFecha(fila[idx.date]),
      gps_latitude:       limpiarNumero(fila[idx.gps_latitude]),
      gps_longitude:      limpiarNumero(fila[idx.gps_longitude]),
      gps_accuracy_in_meters: limpiarNumero(fila[idx.gps_accuracy_in_meters]),
      warranty_in_month:  limpiarNumero(fila[idx.warranty_in_month]),
      transfer:           limpiarBooleano(fila[idx.transfer]),
      payee:              limpiarTexto(fila[idx.payee]),
      labels:             limpiarTexto(fila[idx.labels]),
      envelope_id:        limpiarNumeroEntero(fila[idx.envelope_id])
    };
    
    // Validación mínima: debe tener amount y type
    if (registro.amount === null || !registro.type) {
      errores.push({ fila: numeroFila + 1, motivo: 'sin amount o type' });
      return null;
    }
    
    return registro;
  } catch (e) {
    errores.push({ fila: numeroFila + 1, motivo: e.message });
    return null;
  }
}

// ============================================
// LIMPIADORES
// ============================================
function limpiarTexto(valor) {
  if (valor === '' || valor === null || valor === undefined) return null;
  const s = String(valor).trim();
  return s === '' ? null : s;
}

function limpiarNumero(valor) {
  if (valor === '' || valor === null || valor === undefined) return null;
  if (typeof valor === 'number') return valor;
  const limpio = String(valor).replace(/,/g, '').trim();
  const n = parseFloat(limpio);
  return isNaN(n) ? null : n;
}

function limpiarNumeroEntero(valor) {
  const n = limpiarNumero(valor);
  return n === null ? null : Math.trunc(n);
}

function limpiarBooleano(valor) {
  if (valor === '' || valor === null || valor === undefined) return null;
  if (typeof valor === 'boolean') return valor;
  const s = String(valor).trim().toUpperCase();
  if (s === 'TRUE' || s === 'VERDADERO') return true;
  if (s === 'FALSE' || s === 'FALSO') return false;
  return null;
}

function limpiarFecha(valor) {
  if (valor === '' || valor === null || valor === undefined) return null;
  
  // Si es objeto Date (Google Sheets lo detecta así automáticamente)
  if (valor instanceof Date) {
    if (isNaN(valor.getTime())) return null;
    return valor.toISOString(); // Supabase acepta ISO 8601
  }
  
  // Si es string, intentar parsear
  const s = String(valor).trim();
  if (s === '') return null;
  
  const fecha = new Date(s);
  if (isNaN(fecha.getTime())) return null;
  
  return fecha.toISOString();
}

// ============================================
// ENVIAR LOTE A SUPABASE
// ============================================
function enviarLoteASupabase(registros, numeroLote) {
  const opciones = {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    payload: JSON.stringify(registros),
    muteHttpExceptions: true
  };
  
  try {
    const respuesta = UrlFetchApp.fetch(SUPABASE_ENDPOINT, opciones);
    const codigo = respuesta.getResponseCode();
    
    if (codigo === 201 || codigo === 200 || codigo === 204) {
      Logger.log(`✅ Lote ${numeroLote} OK (${registros.length} registros)`);
      return { ok: true };
    } else {
      Logger.log(`⚠️ Lote ${numeroLote} - HTTP ${codigo}: ${respuesta.getContentText().substring(0, 500)}`);
      return { ok: false, respuesta: respuesta.getContentText() };
    }
  } catch (e) {
    Logger.log(`❌ Lote ${numeroLote} - Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ============================================
// MENÚ EN LA HOJA DE CÁLCULO (opcional)
// ============================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📤 Supabase')
    .addItem('Transferir todos los datos', 'transferirDatosASupabase')
    .addItem('Probar con 5 filas', 'probarCon5Filas')
    .addToUi();
}

function probarCon5Filas() {
  // Prueba rápida para verificar que todo funciona
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const datos = hoja.getDataRange().getValues();
  const encabezados = datos[0];
  
  const idx = {};
  encabezados.forEach((h, i) => { if (h) idx[h] = i; });
  
  const registros = [];
  for (let i = 1; i < Math.min(datos.length, 20); i++) {
    const fila = datos[i];
    if (esFilaVaciaOEncabezado(fila, idx)) continue;
    const r = construirRegistro(fila, idx, i, []);
    if (r) registros.push(r);
    if (registros.length >= 5) break;
  }
  
  Logger.log('Payload de prueba:\n' + JSON.stringify(registros, null, 2));
  const res = enviarLoteASupabase(registros, 'PRUEBA');
  Logger.log('Resultado: ' + JSON.stringify(res));
}