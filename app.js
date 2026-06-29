// ============================================================
    // BALANCE SHEET — DASHBOARD JAVASCRIPT
    // Backend: Google Apps Script
    // ============================================================

    // === CONFIGURACIÓN ===
    const CONFI = {
    // URL de tu Apps Script Web App (reemplazar con tu URL)
    API_URL: 'https://script.google.com/macros/s/AKfycbzObIy-f6tHL6PABCVDJ--iULCOLZz7jf4umWBqgNV9hOGPoOhDlRkyI5b59zD6DmD2dA/exec',
    CURRENCY: 'RD$',
    LOCALE: 'es-DO'
    };

    // === ESTADO ===
    let appData = null;
    let charts = {};

    // === MODAL DE DETALLE DE ACTIVO ===
    let assetDetailChart = null;

    const ASSET_COLORS = {
        'Débito Banreservas': '#3b82f6', 'Cash': '#22c55e', 'Débito Popular': '#8b5cf6',
        'Digital Banreservas': '#0ea5e9', 'Digital Popular': '#f59e0b', 'Digital BHD': '#ec4899',
        'BDI: Ahorro': '#6366f1', 'QIK: Ahorro': '#14b8a6', 'Ademi: Ahorro': '#f97316',
        'Cash US': '#84cc16', 'Airtm': '#06b6d4', 'Paypal USD': '#003087',
        'Etoro': '#00d4aa', 'Hapi': '#ff6b35', 'Alpha View': '#7c3aed',
        'UC United Capital': '#0ea5e9', 'Larimar': '#f59e0b', 'Cesar Iglesias': '#ec4899',
        'SIVEMBC263': '#22c55e', 'Certificado Banreserva': '#3b82f6',
        'Alcanza Inversiones': '#8b5cf6', 'Haina Investment 2034': '#ef4444',
        'Fondo de Fondos Altio': '#14b8a6', 'TradeStation': '#6366f1'
    };

// === LÍMITES DE CRÉDITO (ajustar si el banco cambia los límites) ===
// NOTA: Los valores USD asumen que la hoja ya convierte a DOP.
// Si la hoja guarda USD crudos, multiplicar por la tasa de cambio aquí.
// Límites en USD se multiplican por la tasa dinámica del backend
function getTasaUSD() {
    // Último valor de Moneda US del backend (tasa USD→DOP del mes actual)
    const usdHistory = appData?.monedas?.usd?.history || [];
    for (let i = usdHistory.length - 1; i >= 0; i--) {
        if (usdHistory[i].value > 0) return usdHistory[i].value;
    }
    return 59; // fallback si no hay data
}

function getCreditLimit(name) {
    const tasa = getTasaUSD();
    const limitsUSD = {
        'Crédito Caribe USD': 450,
        'Crédito Banreservas Gold USD': 500,
        'Crédito BHD Premia USD': 340
    };
    const limitsDOP = {
        'Crédito Banreservas': 8000,
        'Crédito Qik': 54000,
        'Crédito Popular Clásica': 80000,
        'Crédito Caribe DOP': 54000,
        'Crédito Banreservas Gold': 50000,
        'Crédito BHD Premia DOP': 41000,
        'Extra Limite Caribe': 40500,
        'Credimás Banreservas': 50000,
        'Prestamo Popular': 164000
    };
    if (limitsUSD[name]) return limitsUSD[name] * tasa;
    return limitsDOP[name] || 0;
}

// Constantes de nombres (los límites reales se calculan con getCreditLimit)
const CREDIT_LIMITS = {}; // legacy, no usar directamente

const TARJETAS_NOMBRES = [
    'Crédito Banreservas','Crédito Qik','Crédito Popular Clásica',
    'Crédito Caribe DOP','Crédito Caribe USD','Crédito Banreservas Gold',
    'Crédito Banreservas Gold USD','Crédito BHD Premia DOP','Crédito BHD Premia USD'
];

const LINEAS_NOMBRES = ['Extra Limite Caribe', 'Credimás Banreservas'];
const PRESTAMOS_NOMBRES = ['Prestamo Popular'];

function getDeuda(data) {
    // En la hoja: positivo = deuda (gastado), negativo = crédito a favor
    return data && data.current > 0 ? data.current : 0;
}
function getDisponible(name, data) {
    const limite = getCreditLimit(name);
    if (limite === 0) return 0;
    const deuda = getDeuda(data);
    const excedente = data && data.current < 0 ? Math.abs(data.current) : 0;
    return Math.max(0, limite - deuda + excedente);
}
function getUtilizacion(name, data) {
    const limite = getCreditLimit(name);
    if (limite === 0) return 0;
    return Math.min(100, (getDeuda(data) / limite) * 100);
}
function getDeudaRotativa() {
    // Suma deuda de tarjetas + líneas (NO préstamos)
    // positivo en hoja = deuda | negativo = crédito a favor
    let deuda = 0;
    for (const [name, data] of Object.entries(appData.creditos || {})) {
        if (TARJETAS_NOMBRES.includes(name) || LINEAS_NOMBRES.includes(name)) {
            deuda += getDeuda(data);
        }
    }
    return deuda;
}


    function openAssetModal(assetName, assetData, color) {
        const modal = document.getElementById('assetDetailModal');
        const title = document.getElementById('assetModalTitle');

        title.textContent = assetName;
        title.style.color = color;
        modal.classList.add('active');

        renderAssetDetailChart(assetName, assetData, color);
        renderAssetBreakdown(assetName, assetData, color);
    }

    function closeAssetModal() {
        document.getElementById('assetDetailModal').classList.remove('active');
        if (assetDetailChart) {
            assetDetailChart.destroy();
            assetDetailChart = null;
        }
    }

    // === MODAL DE DETALLE DE CRÉDITO ===
    function openCreditModal(creditName) {
        const modal = document.getElementById('creditDetailModal');
        const title = document.getElementById('creditModalTitle');
        const info = appData.creditoDB?.find(c => c.nombre === creditName);

        if (!info) {
            console.warn('No se encontró info de DB_CREDITO para:', creditName);
            return;
        }

        title.textContent = creditName;
        modal.classList.add('active');
        renderCreditDetail(info);
    }

    function closeCreditModal() {
        document.getElementById('creditDetailModal').classList.remove('active');
    }

    // Cerrar modal al hacer click fuera
    document.addEventListener('click', function(e) {
        const modal = document.getElementById('creditDetailModal');
        if (e.target === modal) closeCreditModal();
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeCreditModal();
    });

    function renderCreditDetail(info) {
        const container = document.getElementById('creditModalBody');
        const isOverdue = info.diasFaltaPago !== '' && Number(info.diasFaltaPago) < 0;
        const isClose = info.diasFaltaPago !== '' && Number(info.diasFaltaPago) >= 0 && Number(info.diasFaltaPago) <= 5;
        
        const statusColor = isOverdue ? '#ef4444' : isClose ? '#f59e0b' : '#22c55e';
        const statusText = isOverdue ? 'Vencido' : isClose ? 'Pronto' : 'Al día';
        const statusIcon = isOverdue ? '⚠️' : isClose ? '⏰' : '✅';

        const pctNum = parseFloat(info.pctUso)*100 || 0;
        const utilColor = pctNum > 90 ? '#ef4444' : pctNum > 70 ? '#f59e0b' : '#22c55e';

        container.innerHTML = `
            <div class="credit-detail-header">
                <div class="credit-detail-badge" style="background:${statusColor}20;color:${statusColor}">
                    ${statusIcon} ${statusText}
                </div>
                <div class="credit-detail-bank">${info.banco} · ${info.tipoTarjeta || 'Crédito'}</div>
            </div>

            <div class="credit-detail-grid">
                <div class="credit-detail-card">
                    <div class="credit-detail-label">Límite Total</div>
                    <div class="credit-detail-value">${fmtMoney(info.limiteTotal)}</div>
                </div>
                <div class="credit-detail-card">
                    <div class="credit-detail-label">Balance Actual</div>
                    <div class="credit-detail-value" style="color:${info.balanceActual > 0 ? '#f87171' : '#4ade80'}">
                        ${fmtMoney(info.balanceActual)}
                    </div>
                </div>
                <div class="credit-detail-card">
                    <div class="credit-detail-label">Disponible</div>
                    <div class="credit-detail-value" style="color:#3b82f6">${fmtMoney(info.disponible)}</div>
                </div>
                <div class="credit-detail-card">
                    <div class="credit-detail-label">Utilización</div>
                    <div class="credit-detail-value" style="color:${utilColor}">${(info.pctUso*100).toFixed(2)}%</div>
                    <div class="credit-detail-progress">
                        <div class="credit-detail-progress-fill" style="width:${Math.min(pctNum,100)}%;background:${utilColor}"></div>
                    </div>
                </div>
            </div>

            <div class="credit-detail-section">
                <div class="credit-detail-section-title">📅 Ciclo de Facturación</div>
                <div class="credit-detail-grid-3">
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Día de Corte</div>
                        <div class="credit-detail-item-value">${info.diaCorte || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Fecha Corte</div>
                        <div class="credit-detail-item-value">${info.fechaCorte || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Días de Gracia</div>
                        <div class="credit-detail-item-value">${info.diasGracia || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Fecha de Pago</div>
                        <div class="credit-detail-item-value" style="color:${isOverdue || isClose ? statusColor : ''}">
                            ${info.fechaPago || '—'}
                        </div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Días para Pagar</div>
                        <div class="credit-detail-item-value" style="color:${isOverdue ? '#ef4444' : isClose ? '#f59e0b' : '#4ade80'};font-weight:700">
                            ${info.diasFaltaPago !== '' ? info.diasFaltaPago + ' días' : '—'}
                        </div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Pago Recomendado</div>
                        <div class="credit-detail-item-value">${fmtMoney(info.pagoRecomendado)}</div>
                    </div>
                </div>
            </div>

            <div class="credit-detail-section">
                <div class="credit-detail-section-title">💰 Condiciones</div>
                <div class="credit-detail-grid-3">
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Tasa Interés Anual</div>
                        <div class="credit-detail-item-value">${info.tasaInteres || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Cashback</div>
                        <div class="credit-detail-item-value">${info.cashback || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Puntos</div>
                        <div class="credit-detail-item-value">${info.puntos || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Límite Saludable (30%)</div>
                        <div class="credit-detail-item-value">${fmtMoney(info.limiteSaludable)}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Último Aumento</div>
                        <div class="credit-detail-item-value">${info.ultimoAumento || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Tasa USD</div>
                        <div class="credit-detail-item-value">${info.dolar > 0 ? info.dolar.toFixed(2) : '—'}</div>
                    </div>
                </div>
            </div>

            ${info.notas ? `
            <div class="credit-detail-section">
                <div class="credit-detail-section-title">📝 Notas</div>
                <div class="credit-detail-notas">${info.notas}</div>
            </div>
            ` : ''}
        `;
    }

    // Cerrar modal al hacer click fuera
    document.addEventListener('click', function(e) {
        const modal = document.getElementById('assetDetailModal');
        if (e.target === modal) {
            closeAssetModal();
        }
    });

    // Cerrar con Escape
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeAssetModal();
        }
    });

    function renderAssetDetailChart(assetName, assetData, color) {
        const ctx = document.getElementById('assetDetailChart');
        if (!ctx) return;

        if (assetDetailChart) {
            assetDetailChart.destroy();
        }

        const history = (assetData.history || []).map(d => ({
            date: formatShortDate(d.date),
            value: d.value
        }));

        if (history.length === 0) {
            ctx.style.display = 'none';
            return;
        }
        ctx.style.display = 'block';

        assetDetailChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: history.map(d => d.date + '​'),
                datasets: [{
                    label: assetName,
                    data: history.map(d => d.value),
                    borderColor: color,
                    backgroundColor: color + '1A',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                    pointHoverRadius: 6,
                    pointBackgroundColor: color,
                    pointBorderColor: '#0f172a',
                    pointBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(15,23,42,0.95)',
                        titleColor: '#e2e8f0',
                        bodyColor: '#e2e8f0',
                        borderColor: 'rgba(51,65,85,0.5)',
                        borderWidth: 1,
                        callbacks: {
                            label: (ctx) => 'RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'category',
                        grid: { display: false, drawBorder: false },
                        ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 }
                    },
                    y: {
                        grid: { color: 'rgba(51,65,85,0.2)', drawBorder: false },
                        ticks: {
                            color: '#64748b',
                            font: { size: 10 },
                            callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K'
                        }
                    }
                }
            }
        });
    }

    function renderAssetBreakdown(assetName, assetData, color) {
        const breakdown = document.getElementById('assetModalBreakdown');

        const current = assetData.current || 0;
        const previous = assetData.previous || 0;
        const change = assetData.change || 0;
        const changePct = assetData.changePct || 0;

        const history = assetData.history || [];
        const maxVal = history.length > 0 ? Math.max(...history.map(h => h.value)) : current;
        const minVal = history.length > 0 ? Math.min(...history.map(h => h.value)) : current;
        const avgVal = history.length > 0 ? history.reduce((a, b) => a + b.value, 0) / history.length : current;

        let html = `
            <div class="breakdown-item">
                <div class="name">Valor Actual</div>
                <div class="value">${fmtMoney(current)}</div>
            </div>
            <div class="breakdown-item">
                <div class="name">Valor Anterior</div>
                <div class="value">${fmtMoney(previous)}</div>
            </div>
            <div class="breakdown-item">
                <div class="name">Cambio Mensual</div>
                <div class="value" style="color:${change >= 0 ? '#4ade80' : '#f87171'}">
                    ${change >= 0 ? '+' : ''}${fmtMoney(change)}
                </div>
            </div>
            <div class="breakdown-item">
                <div class="name">Variación %</div>
                <div class="value" style="color:${changePct >= 0 ? '#4ade80' : '#f87171'}">
                    ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%
                </div>
            </div>
            <div class="breakdown-item">
                <div class="name">Máximo Histórico</div>
                <div class="value" style="color:#4ade80">${fmtMoney(maxVal)}</div>
            </div>
            <div class="breakdown-item">
                <div class="name">Mínimo Histórico</div>
                <div class="value" style="color:#f87171">${fmtMoney(minVal)}</div>
            </div>
            <div class="breakdown-item">
                <div class="name">Promedio Histórico</div>
                <div class="value">${fmtMoney(avgVal)}</div>
            </div>
            <div class="breakdown-total">
                <div class="name">PERÍODOS REGISTRADOS</div>
                <div class="value">${history.length} meses</div>
            </div>
        `;

        breakdown.innerHTML = html;
    }


    // === INICIALIZACIÓN ===
    document.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadData();
        renderAll();
        document.getElementById('loading').classList.add('hidden');
    } catch (e) {
        console.error('Error inicializando:', e);
        document.querySelector('.loading-text').textContent = 'Error cargando datos';
    }
    });

    // === CARGA DE DATOS ===
    async function loadData() {
    // Desde localhost/file://, CORS bloquea fetch SIEMPRE con Apps Script.
    // Usamos JSONP directamente sin intentar fetch primero.
    const isLocal = location.hostname === 'localhost' || 
                    location.hostname === '127.0.0.1' || 
                    location.protocol === 'file:';

    if (!isLocal) {
        // En producción (mismo dominio o con proxy), intentar fetch
        try {
            const res = await fetch(CONFI.API_URL + '?action=getData');
            if (res.ok) {
                appData = await res.json();
                console.log('✅ Datos vía Fetch');
                // DEBUG: Ver todo el summary

                return;
            }
        } catch (e) {
            console.log('⚠️ Fetch falló:', e.message);
        }
    }

    // JSONP: funciona desde cualquier origen
    console.log('🌐 Intentando JSONP...');
    try {
        appData = await loadDataJSONP();
        console.log('✅ Datos vía JSONP');
        return;
    } catch (e) {
        console.log('⚠️ JSONP falló:', e.message);
    }

      // Fallback final
    console.log('❌ No hay datos disponibles');
    throw new Error('No se pudieron cargar los datos. Verifica la conexión con Google Apps Script.');
}

// === JSONP LOADER (bypass CORS) ===
function loadDataJSONP() {
    return new Promise((resolve, reject) => {
        const callbackName = 'bsCallback_' + Date.now();
        const script = document.createElement('script');
        const timeout = setTimeout(() => {
            reject(new Error('Timeout JSONP después de 30s'));
            cleanup();
        }, 30000);

        function cleanup() {
            if (script.parentNode) script.parentNode.removeChild(script);
            delete window[callbackName];
            clearTimeout(timeout);
        }

        window[callbackName] = (data) => {
            if (data && data.error) {
                reject(new Error('Error del servidor: ' + data.message));
            } else {
                resolve(data);
            }
            cleanup();
        };

        script.onerror = () => {
            reject(new Error('Error de red al cargar script JSONP'));
            cleanup();
        };

        // URL con callback para JSONP
        const url = CONFI.API_URL + '?action=getData&callback=' + callbackName;
        console.log('📡 Cargando JSONP desde:', url.substring(0, 80) + '...');

        script.src = url;
        document.head.appendChild(script);
    });
}

// === TABS ===
    function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
    document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(tabId).classList.add('active');
    
    // Re-renderizar gráficos del tab activo
    setTimeout(() => {
        renderChartsForTab(tabId);
    }, 50);
    }

    // === FORMATO ===
    function fmtMoney(val) {
    if (val === null || val === undefined) return '—';
    return new Intl.NumberFormat(CONFI.LOCALE, {
        style: 'currency',
        currency: 'DOP',
        minimumFractionDigits: 2
    }).format(val).replace('DOP', 'RD$');
    }

    function fmtNumber(val) {
    if (val === null || val === undefined) return '—';
    return new Intl.NumberFormat(CONFI.LOCALE).format(val);
    }

    function fmtPct(val) {
    if (val === null || val === undefined) return '—';
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(2)}%`;
    }

    function getChangeBadge(val) {
    if (val > 0) return `<span class="stat-badge up">▲ ${fmtPct(val)}</span>`;
    if (val < 0) return `<span class="stat-badge down">▼ ${fmtPct(val)}</span>`;
    return `<span class="stat-badge neutral">— 0.00%</span>`;
    }

    function renderOverview() {
      const s = appData.summary;
      const totalAssets = s.activosTotales.current;
      const totalLiab = s.pasivosTotal.current;
      const netWorth = s.patrimonioNeto.current;
      const liquidity = s.liquidoTotal.current;
      const investments = s.inversionesTotal.current;
      
      // === NUEVAS MÉTRICAS ===
      const income = s.ingresosNetos.current;
      const expenses = s.gastosTotal.current;
      const savingsRate = income > 0 ? ((income - expenses) / income) * 100 : 0;
      const savingsAmount = income - expenses;
      
      // Score de salud financiera (0-100)
      const debtRatio = totalAssets > 0 ? (totalLiab / totalAssets) * 100 : 0;
      const liquidityRatio = totalLiab > 0 ? (liquidity / totalLiab) : 0;
      const investmentRatio = totalAssets > 0 ? (investments / totalAssets) * 100 : 0;
      const healthScore = Math.min(100, Math.round(
          (debtRatio < 20 ? 25 : debtRatio < 50 ? 15 : 5) +
          (liquidityRatio > 1 ? 25 : liquidityRatio > 0.5 ? 15 : 5) +
          (investmentRatio > 30 ? 25 : investmentRatio > 15 ? 15 : 5) +
          (savingsRate > 10 ? 25 : savingsRate > 0 ? 15 : 5)
      ));
      
      // Tendencia 12M
      const patrimonioHistory = s.patrimonioNeto.history;
      const val12mAgo = patrimonioHistory.length > 12 ? patrimonioHistory[patrimonioHistory.length - 13].value : patrimonioHistory[0].value;
      const trend12m = ((netWorth - val12mAgo) / Math.abs(val12mAgo)) * 100;
      
      const html = `
          <div class="stat-card">
              <div class="stat-header">
                  <span class="stat-label">Patrimonio Neto</span>
                  ${getChangeBadge(s.patrimonioNeto.changePct)}
              </div>
              <div class="stat-value">${fmtMoney(netWorth)}</div>
              <div class="stat-sub">vs mes anterior: <span class="highlight">${fmtMoney(s.patrimonioNeto.change)}</span></div>
          </div>
          <div class="stat-card">
              <div class="stat-header">
                  <span class="stat-label">Tasa de Ahorro</span>
                  <span class="stat-badge ${savingsRate >= 10 ? 'up' : savingsRate > 0 ? 'neutral' : 'down'}">${savingsRate.toFixed(1)}%</span>
              </div>
              <div class="stat-value" style="color:${savingsRate >= 10 ? '#4ade80' : savingsRate > 0 ? '#94a3b8' : '#f87171'}">${savingsRate.toFixed(1)}%</div>
              <div class="stat-sub">Ahorro: <span class="highlight">${fmtMoney(savingsAmount)}</span> / Ingreso: ${fmtMoney(income)}</div>
          </div>
          <div class="stat-card">
              <div class="stat-header">
                  <span class="stat-label">Score Salud Financiera</span>
                  <span class="stat-badge ${healthScore >= 70 ? 'up' : healthScore >= 40 ? 'neutral' : 'down'}">${healthScore}/100</span>
              </div>
              <div class="stat-value" style="color:${healthScore >= 70 ? '#4ade80' : healthScore >= 40 ? '#f59e0b' : '#f87171'}">${healthScore}</div>
              <div class="stat-sub">Deuda: ${debtRatio.toFixed(1)}% · Liquidez: ${liquidityRatio.toFixed(1)}x · Inv: ${investmentRatio.toFixed(1)}%</div>
          </div>
          <div class="stat-card">
              <div class="stat-header">
                  <span class="stat-label">Tendencia 12M</span>
                  ${getChangeBadge(trend12m)}
              </div>
              <div class="stat-value">${fmtPct(trend12m)}</div>
              <div class="stat-sub">Hace 12M: ${fmtMoney(val12mAgo)} · Ahora: ${fmtMoney(netWorth)}</div>
          </div>
      `;  
      document.getElementById('overviewStats').innerHTML = html;

      // === PODER ADQUISITIVO TOTAL ===
      // Límite total de crédito desde el último mes con datos
      const CREDIT_LIMIT_TOTAL = getCreditLimitTotal();
      const activosDisponibles = liquidity + investments;
      const creditoDisponible = Math.max(0, CREDIT_LIMIT_TOTAL - getDeudaRotativa());
      const poderAdquisitivo = activosDisponibles + creditoDisponible;

      const pctActivos = poderAdquisitivo > 0 ? (activosDisponibles / poderAdquisitivo) * 100 : 0;
      const pctCredito = poderAdquisitivo > 0 ? (creditoDisponible / poderAdquisitivo) * 100 : 0;
      const pctTotal = poderAdquisitivo > 0 ? 100 : 0;

      const poderHtml = `
          <div class="stat-card info" style="--bar-width: ${pctActivos.toFixed(1)}%">
              <div class="stat-header">
                  <span class="stat-label">Activos Disponibles</span>
              </div>
              <div class="stat-value">${fmtMoney(activosDisponibles)}</div>
              <div class="stat-sub">Líquido + Inversiones</div>
              <div class="stat-bar"></div>
          </div>
          <div class="stat-card warning" style="--bar-width: ${pctCredito.toFixed(1)}%">
              <div class="stat-header">
                  <span class="stat-label">+ Crédito Disponible</span>
              </div>
              <div class="stat-value">${fmtMoney(creditoDisponible)}</div>
              <div class="stat-sub">de ${fmtMoney(CREDIT_LIMIT_TOTAL)} límite total</div>
              <div class="stat-bar"></div>
          </div>
          <div class="stat-card success" style="--bar-width: ${pctTotal.toFixed(1)}%">
              <div class="stat-header">
                  <span class="stat-label">= Poder Adquisitivo Total</span>
              </div>
              <div class="stat-value">${fmtMoney(poderAdquisitivo)}</div>
              <div class="stat-sub">Activos + Líneas de crédito</div>
              <div class="stat-bar"></div>
          </div>
      `;
      document.getElementById('poderAdquisitivoStats').innerHTML = poderHtml;
    }
    function formatDateToString(dateValue) {
      if (!dateValue) return '';
      if (dateValue instanceof Date) {
          return (dateValue.getMonth() + 1) + '/1/' + dateValue.getFullYear();
      }
      return dateValue.toString();
    }

    // === RENDER ASSETS ===
    function renderAssets() {
    const s = appData.summary;
    const html = `
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Líquido Total</span></div>
        <div class="stat-value">${fmtMoney(s.liquidoTotal.current)}</div>
        <div class="stat-sub">${((s.liquidoTotal.current/s.activosTotales.current)*100).toFixed(1)}% de activos</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Inversiones</span></div>
        <div class="stat-value">${fmtMoney(s.inversionesTotal.current)}</div>
        <div class="stat-sub">${((s.inversionesTotal.current/s.activosTotales.current)*100).toFixed(1)}% de activos</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Otros Activos</span></div>
        <div class="stat-value">${fmtMoney(s.otrosActivos.current)}</div>
        <div class="stat-sub">Puntos, millas, recompensas</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Total Activos</span></div>
        <div class="stat-value">${fmtMoney(s.activosTotales.current)}</div>
        <div class="stat-sub">Patrimonio + Pasivos</div>
        </div>
    `;
    document.getElementById('assetsStats').innerHTML = html;

    // Lista de cuentas bancarias
    const bankTotal = Object.values(appData.cuentas).reduce((a, b) => a + b.current, 0);
    const bankItems = Object.entries(appData.cuentas)
        .sort((a, b) => b[1].current - a[1].current)
        .map(([name, data]) => {
        const pct = (data.current / bankTotal) * 100;
        const color = ASSET_COLORS[name] || '#64748b';
        return { name, data, pct, color };
        });

    const bankList = bankItems.map(item => `
        <div class="asset-item" data-asset-name="${item.name}" data-asset-color="${item.color}">
        <div class="asset-icon-wrap" style="background:${item.color}20;color:${item.color}">${item.name.charAt(0)}</div>
        <div class="asset-info">
            <div class="asset-name">${item.name}</div>
            <div class="asset-meta">${item.pct.toFixed(1)}% del líquido</div>
            <div class="asset-progress"><div class="asset-progress-fill" style="width:${item.pct}%;background:${item.color}"></div></div>
        </div>
        <div class="asset-value">
            <div class="asset-amount">${fmtMoney(item.data.current)}</div>
        </div>
        </div>
    `).join('');
    document.getElementById('bankAccountsList').innerHTML = `<div class="asset-list">${bankList}</div>`;

    // Attach click listeners to bank items
    bankItems.forEach(item => {
        const el = document.querySelector(`[data-asset-name="${item.name}"]`);
        if (el) {
            el.addEventListener('click', () => openAssetModal(item.name, item.data, item.color));
        }
    });

    // Lista de inversiones
    const invTotal = Object.values(appData.inversiones).reduce((a, b) => a + b.current, 0);
    const invItems = Object.entries(appData.inversiones)
        .sort((a, b) => b[1].current - a[1].current)
        .map(([name, data]) => {
        const pct = (data.current / invTotal) * 100;
        const color = ASSET_COLORS[name] || '#64748b';
        return { name, data, pct, color };
        });

    const invList = invItems.map(item => `
        <div class="asset-item" data-asset-name="${item.name}" data-asset-color="${item.color}">
        <div class="asset-icon-wrap" style="background:${item.color}20;color:${item.color}">${item.name.substring(0,2)}</div>
        <div class="asset-info">
            <div class="asset-name">${item.name}</div>
            <div class="asset-meta">${item.pct.toFixed(1)}% del portafolio</div>
            <div class="asset-progress"><div class="asset-progress-fill" style="width:${item.pct}%;background:${item.color}"></div></div>
        </div>
        <div class="asset-value">
            <div class="asset-amount">${fmtMoney(item.data.current)}</div>
        </div>
        </div>
    `).join('');
    document.getElementById('investmentsList').innerHTML = `<div class="asset-list">${invList}</div>`;

    // Attach click listeners to investment items
    invItems.forEach(item => {
        const el = document.querySelector(`[data-asset-name="${item.name}"]`);
        if (el) {
            el.addEventListener('click', () => openAssetModal(item.name, item.data, item.color));
        }
    });
    }

    function renderLiabilities() {
    const s = appData.summary;

    // ─── Separar créditos en 3 grupos ───
    // NOTA: extractSection en el backend filtra items con current === 0,
    // por eso las líneas y préstamos sin deuda no aparecen en appData.creditos.
    // Los forzamos desde las constantes de nombres.
    const tarjetas = [], lineas = [], prestamos = [];

    // 1. Tarjetas que SÍ llegan del backend
    for (const name of TARJETAS_NOMBRES) {
        const data = appData.creditos?.[name];
        if (data) {
            tarjetas.push({ name, data });
        } else {
            tarjetas.push({ 
                name, 
                data: { current: 0, previous: 0, change: 0, changePct: 0, history: [] } 
            });
        }
    }


    // 2. Líneas: buscar en backend, si no están crear con current=0
    for (const name of LINEAS_NOMBRES) {
        const data = appData.creditos?.[name];
        if (data) {
            lineas.push({ name, data });
        } else {
            // Forzar creación con historial vacío o desde datos crudos
            lineas.push({ 
                name, 
                data: { current: 0, previous: 0, change: 0, changePct: 0, history: [] } 
            });
        }
    }

    // 3. Préstamos: igual que líneas
    for (const name of PRESTAMOS_NOMBRES) {
        const data = appData.creditos?.[name];
        if (data) {
            prestamos.push({ name, data });
        } else {
            prestamos.push({ 
                name, 
                data: { current: 0, previous: 0, change: 0, changePct: 0, history: [] } 
            });
        }
    }

    // ─── Cálculos por grupo ───
    const deudaTarjetas = tarjetas.reduce((sum, t) => sum + getDeuda(t.data), 0);
    const deudaLineas   = lineas.reduce((sum, l) => sum + getDeuda(l.data), 0);
    const deudaPrestamos = prestamos.reduce((sum, p) => sum + getDeuda(p.data), 0);
    const totalPasivos = s.pasivosTotal.current; // oficial desde backend

    const limiteTarjetas = TARJETAS_NOMBRES.reduce((sum, n) => sum + getCreditLimit(n), 0);
    const limiteLineas   = LINEAS_NOMBRES.reduce((sum, n) => sum + getCreditLimit(n), 0);
    const limiteTotal    = limiteTarjetas + limiteLineas;

    const disponibleTotal = Math.max(0, limiteTotal - deudaTarjetas - deudaLineas);
    const utilizacionPct  = limiteTotal > 0 ? ((deudaTarjetas + deudaLineas) / limiteTotal) * 100 : 0;

    // ─── Stat Cards ───
    const html = `
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Total Pasivos</span></div>
            <div class="stat-value">${fmtMoney(totalPasivos)}</div>
            <div class="stat-sub">${tarjetas.length} tarjetas · ${lineas.length} líneas · ${prestamos.length} préstamos</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Utilización Crédito</span></div>
            <div class="stat-value">${utilizacionPct.toFixed(1)}%</div>
            <div class="stat-sub">de ${fmtMoney(limiteTotal)} límite · ${fmtMoney(disponibleTotal)} disponible</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Ratio Deuda/Patrimonio</span></div>
            <div class="stat-value">${((totalPasivos/s.patrimonioNeto.current)*100).toFixed(1)}%</div>
            <div class="stat-sub">${totalPasivos > s.patrimonioNeto.current * 0.5 ? '⚠️ Alto' : '✅ Saludable'} (&lt;50%)</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Líquido Cubre Deuda</span></div>
            <div class="stat-value">${s.liquidoTotal.current > 0 ? (s.liquidoTotal.current/totalPasivos).toFixed(1) : '0.0'}x</div>
            <div class="stat-sub">Cobertura inmediata</div>
        </div>
    `;
    document.getElementById('liabilitiesStats').innerHTML = html;

    // ─── Renderizar Tarjetas de Crédito ───
    const tarjetasHtml = tarjetas
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            const limite = getCreditLimit(name);
            const disponible = getDisponible(name, data);
            const util = getUtilizacion(name, data);
            const color = util > 90 ? '#ef4444' : util > 70 ? '#f59e0b' : '#22c55e';
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:${color}20;color:${color}">💳</div>
                    <div class="liability-info">
                        <div class="liability-name">${name}</div>
                        <div class="liability-meta">Límite: ${fmtMoney(limite)} · Usado: ${fmtMoney(deuda)} · ${util.toFixed(1)}%</div>
                        <div class="liability-progress-track">
                            <div class="liability-progress-fill" style="width:${util}%;background:${color}"></div>
                        </div>
                    </div>
                    <div class="liability-value">
                        <div class="liability-amount" style="color:${deuda > 0 ? '#f87171' : '#4ade80'}">${fmtMoney(deuda)}</div>
                        <div class="liability-sub">${fmtMoney(disponible)} disp.</div>
                    </div>
                </div>
            `;
        }).join('');
    document.getElementById('creditCardsList').innerHTML = tarjetasHtml ? 
        `<div class="liability-list">${tarjetasHtml}</div>` : 
        '<div style="color:#64748b;padding:20px;text-align:center;">No hay tarjetas registradas.</div>';

    const tarjetasDisp = tarjetas.reduce((sum, t) => sum + getDisponible(t.name, t.data), 0);
    const tarjetasUtil = limiteTarjetas > 0 ? (deudaTarjetas / limiteTarjetas) * 100 : 0;
    const tarjetasHeader = document.getElementById('tarjetasLimiteTotal');
    if (tarjetasHeader) tarjetasHeader.textContent = fmtMoney(limiteTarjetas);

    // ─── Renderizar Líneas de Crédito ───
    const lineasHtml = lineas
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            const limite = getCreditLimit(name);
            const disponible = getDisponible(name, data);
            const util = getUtilizacion(name, data);
            const color = util > 90 ? '#ef4444' : util > 70 ? '#f59e0b' : '#22c55e';
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:${color}20;color:${color}">📈</div>
                    <div class="liability-info">
                        <div class="liability-name">${name}</div>
                        <div class="liability-meta">Límite: ${fmtMoney(limite)} · Usado: ${fmtMoney(deuda)} · ${util.toFixed(1)}%</div>
                        <div class="liability-progress-track">
                            <div class="liability-progress-fill" style="width:${util}%;background:${color}"></div>
                        </div>
                    </div>
                    <div class="liability-value">
                        <div class="liability-amount" style="color:${deuda > 0 ? '#f87171' : '#4ade80'}">${fmtMoney(deuda)}</div>
                        <div class="liability-sub">${fmtMoney(disponible)} disp.</div>
                    </div>
                </div>
            `;
        }).join('');
    document.getElementById('lineasCreditoList').innerHTML = lineasHtml ? 
        `<div class="liability-list">${lineasHtml}</div>` : 
        '<div style="color:#64748b;padding:20px;text-align:center;">No hay líneas de crédito registradas.</div>';

    const lineasDisp = lineas.reduce((sum, l) => sum + getDisponible(l.name, l.data), 0);
    const lineasUtil = limiteLineas > 0 ? (deudaLineas / limiteLineas) * 100 : 0;
    const lineasHeader = document.getElementById('lineasLimiteTotal');
    if (lineasHeader) lineasHeader.textContent = fmtMoney(limiteLineas);

    // ─── Renderizar Préstamos ───
    const prestamosHtml = prestamos
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:#8b5cf620;color:#8b5cf6">🏦</div>
                    <div class="liability-info">
                        <div class="liability-name">${name}</div>
                        <div class="liability-meta">Préstamo personal · Saldo pendiente</div>
                    </div>
                    <div class="liability-value">
                        <div class="liability-amount" style="color:#f87171">${fmtMoney(deuda)}</div>
                    </div>
                </div>
            `;
        }).join('');
    document.getElementById('prestamosList').innerHTML = prestamosHtml ? 
        `<div class="liability-list">${prestamosHtml}</div>` : 
        '<div style="color:#64748b;padding:20px;text-align:center;">No hay préstamos registrados.</div>';
}

    // === RENDER INCOME ===
    function renderIncome() {
    const s = appData.summary;
    const presupuesto = appData.presupuesto || [];
    const categorias = appData.categorias || [];
    
    // IDs separados
    const activoIds = ['14.1', '14.2', '14.4', '15', '16.1', '16.2', '16.3', '16.4', '17', '18', '19', '20', '21', '22', '24'];
    const pasivoIds = ['23'];
    
    // Limpiar y filtrar
    const allIngresos = presupuesto.filter(p => p.tipo === 'Ingresos').map(p => ({
        ...p,
        cleanId: String(p.id).replace(/^P/i, '')
    }));
    
    const ingresosActivos = allIngresos.filter(p => activoIds.includes(p.cleanId));
    const ingresosPasivos = allIngresos.filter(p => pasivoIds.includes(p.cleanId));
    
    // Totales por grupo
    const totalPresupuestadoActivo = ingresosActivos.reduce((a, b) => a + (b.montoPresupuestado || 0), 0);
    const totalRealActivo = ingresosActivos.reduce((a, b) => a + (b.gastoReal || 0), 0);
    
    const totalPresupuestadoPasivo = ingresosPasivos.reduce((a, b) => a + (b.montoPresupuestado || 0), 0);
    const totalRealPasivo = ingresosPasivos.reduce((a, b) => a + (b.gastoReal || 0), 0);
    
    const totalReal = totalRealActivo + totalRealPasivo;
    const totalDiferencia = (totalPresupuestadoActivo + totalPresupuestadoPasivo) - totalReal;
    const pctIndependencia = totalReal > 0 ? (totalRealPasivo / totalReal) * 100 : 0;
    
    // Cards de resumen
    const html = `
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Ingreso Activo</span></div>
            <div class="stat-value" style="color:#3b82f6">${fmtMoney(totalRealActivo)}</div>
            <div class="stat-sub">${totalPresupuestadoActivo > 0 ? (totalRealActivo/totalPresupuestadoActivo*100).toFixed(1) : 0}% de meta</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Ingreso Pasivo</span></div>
            <div class="stat-value" style="color:#8b5cf6">${fmtMoney(totalRealPasivo)}</div>
            <div class="stat-sub">${totalPresupuestadoPasivo > 0 ? (totalRealPasivo/totalPresupuestadoPasivo*100).toFixed(1) : 0}% de meta</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Total Ingresos</span></div>
            <div class="stat-value" style="color:#4ade80">${fmtMoney(totalReal)}</div>
            <div class="stat-sub">${fmtMoney(totalDiferencia)} por recibir</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Independencia</span></div>
            <div class="stat-value" style="color:${pctIndependencia >= 50 ? '#4ade80' : pctIndependencia >= 20 ? '#f59e0b' : '#3b82f6'}">
                ${pctIndependencia.toFixed(1)}%
            </div>
            <div class="stat-sub">ingreso pasivo / total</div>
        </div>
    `;
    document.getElementById('incomeStats').innerHTML = html;
    
    // Función para renderizar un item
    const renderItem = (p, isPasivo, grupoTotal) => {
        const categoria = categorias.find(c => String(c.id).trim() === String(p.idCategoria).trim());
        const nombre = (categoria && categoria.nombre) ? categoria.nombre : 
                       (categoria && categoria.etiqueta) ? categoria.etiqueta : 
                       'Categoría ' + p.id;
        
        const presupuestoVal = p.montoPresupuestado || 0;
        const realVal = p.gastoReal || 0;
        const faltante = presupuestoVal - realVal;
        const pct = presupuestoVal > 0 ? (realVal / presupuestoVal) * 100 : 0;
        
        // % que representa esta categoría del total de su grupo
        const pctDelGrupo = grupoTotal > 0 ? (realVal / grupoTotal) * 100 : 0;
        
        const color = isPasivo ? '#8b5cf6' : (pct >= 100 ? '#10b981' : pct >= 80 ? '#3b82f6' : '#f59e0b');
        const icon = isPasivo ? '📈' : (pct >= 100 ? '✅' : pct >= 80 ? '💵' : '⏳');
        
        // Barra: lleno = % alcanzado, gris = % faltante
        const barWidth = Math.min(pct, 100);
        const remainingWidth = 100 - barWidth;
        
        // Texto de expectativa
        const expectativaText = faltante > 0 
            ? `Falta ${fmtMoney(faltante)} para meta` 
            : (faltante < 0 ? `Excedido en ${fmtMoney(Math.abs(faltante))}` : 'Meta alcanzada');
        
        const hasPartition = p.particion && ((p.gastoAnthony || 0) > 0 || (p.gastoEmely || 0) > 0 || (p.presupuestoAnthony || 0) > 0 || (p.presupuestoEmely || 0) > 0);
        
        return `
            <div class="income-card" style="border-left: 3px solid ${color}">
                <div class="income-icon" style="background:${color}20;color:${color}">${icon}</div>
                <div class="income-main">
                    <div class="income-header">
                        <div class="income-name">${nombre}</div>
                        <div style="text-align:right">
                            <div class="income-pct" style="color:${color}">${pct.toFixed(1)}%</div>
                            <div style="font-size:0.7rem;color:#64748b">${pctDelGrupo.toFixed(1)}% del ${isPasivo ? 'pasivo' : 'activo'}</div>
                        </div>
                    </div>
                    <div class="income-meta">
                        ${fmtMoney(realVal)} / ${fmtMoney(presupuestoVal)} · ${expectativaText} · ${p.diasRestantes || 0} días
                    </div>
                    <div class="income-bar-track">
                        <div style="width:${barWidth}%;height:100%;background:${color};transition:width 0.3s ease;"></div>
                        <div style="width:${remainingWidth}%;height:100%;background:rgba(51,65,85,0.3);"></div>
                    </div>
                </div>
            </div>
            ${hasPartition ? `
            <div class="income-partition">
                <div class="income-partition-col">
                    <div class="income-partition-label" style="color:#3b82f6">Anthony</div>
                    <div class="income-partition-value">${fmtMoney(p.gastoAnthony || 0)}</div>
                    <div class="income-partition-sub" style="color:${(p.restanteAnthony || 0) >= 0 ? '#3b82f6' : '#f87171'}">${fmtMoney(p.restanteAnthony || 0)} rest.</div>
                </div>
                <div class="income-partition-col center">
                    <div class="income-partition-label" style="color:#22c55e">Por Recibir</div>
                    <div class="income-partition-value">${fmtMoney(p.diferencia || 0)}</div>
                    <div class="income-partition-sub" style="color:${(p.diferencia || 0) >= 0 ? '#22c55e' : '#f87171'}">${(p.diferencia || 0) >= 0 ? 'Pendiente' : 'Excedido'}</div>
                </div>
                <div class="income-partition-col">
                    <div class="income-partition-label" style="color:#ec4899">Emely</div>
                    <div class="income-partition-value">${fmtMoney(p.gastoEmely || 0)}</div>
                    <div class="income-partition-sub" style="color:${(p.restanteEmely || 0) >= 0 ? '#ec4899' : '#f87171'}">${fmtMoney(p.restanteEmely || 0)} rest.</div>
                </div>
            </div>
            ` : ''}
        `;
    };
    
    // Renderizar activos
    const activosList = ingresosActivos
        .sort((a, b) => (b.gastoReal || 0) - (a.gastoReal || 0))
        .map(p => renderItem(p, false, totalRealActivo))
        .join('');
    
    // Renderizar pasivos
    const pasivosList = ingresosPasivos
        .sort((a, b) => (b.gastoReal || 0) - (a.gastoReal || 0))
        .map(p => renderItem(p, true, totalRealPasivo))
        .join('');
    
    const fullList = `
        ${activosList}
        ${pasivosList.length > 0 ? `
        <div style="padding:16px 8px 8px 8px;color:#8b5cf6;font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;display:flex;align-items:center;gap:8px;">
            <span style="width:24px;height:2px;background:#8b5cf6;border-radius:1px;"></span>
            Ingresos Pasivos · ${fmtMoney(totalRealPasivo)} total
        </div>
        ${pasivosList}
        ` : ''}
    `;
    
    document.getElementById('incomeCategoriesList').innerHTML = 
        fullList ? `<div class="asset-list">${fullList}</div>` : '<div style="color:#64748b;padding:20px;text-align:center;">No hay ingresos registrados.</div>';
}


    // === RENDER EXPENSES ===

    function renderExpenses() {
    const s = appData.summary;
    const presupuesto = appData.presupuesto || [];
    const categorias = appData.categorias || [];
    
    // Filtrar gastos del mes actual
    const mesActual = '6/1/2026';
    let gastosMostrar = presupuesto.filter(p => 
        p.tipo === 'Gastos' && formatDateToString(p.mesAno) === mesActual
    );
    if (gastosMostrar.length === 0) {
        gastosMostrar = presupuesto.filter(p => p.tipo === 'Gastos');
    }
    
    // Totales
    const totalPresupuestado = gastosMostrar.reduce((a, b) => a + b.montoPresupuestado, 0);
    const totalReal = gastosMostrar.reduce((a, b) => a + b.gastoReal, 0);
    const totalDiferencia = totalPresupuestado - totalReal;
    const pctConsumido = totalPresupuestado > 0 ? (totalReal / totalPresupuestado) * 100 : 0;
    const enRiesgo = gastosMostrar.filter(p => p.mensaje && p.mensaje.includes('Riesgo')).length;
    const excedidos = gastosMostrar.filter(p => p.mensaje && p.mensaje.includes('sobrepasado')).length;
    
    // Cards de resumen
    const html = `
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Presupuesto Total</span></div>
            <div class="stat-value">${fmtMoney(totalPresupuestado)}</div>
            <div class="stat-sub">${pctConsumido.toFixed(1)}% consumido</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Gasto Real</span></div>
            <div class="stat-value" style="color:${pctConsumido > 100 ? '#f87171' : pctConsumido > 80 ? '#f59e0b' : '#4ade80'}">${fmtMoney(totalReal)}</div>
            <div class="stat-sub">${fmtMoney(Math.abs(totalDiferencia))} ${totalDiferencia >= 0 ? 'restante' : 'excedido'}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">En Riesgo</span></div>
            <div class="stat-value" style="color:${enRiesgo > 0 ? '#f59e0b' : '#4ade80'}">${enRiesgo}</div>
            <div class="stat-sub">de ${gastosMostrar.length} categorías</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Excedidas</span></div>
            <div class="stat-value" style="color:${excedidos > 0 ? '#f87171' : '#4ade80'}">${excedidos}</div>
            <div class="stat-sub">categorías sobrepasadas</div>
        </div>
    `;
    document.getElementById('expensesStats').innerHTML = html;
    
    // Lista de categorías
    const expenseList = gastosMostrar
        .sort((a, b) => b.gastoReal - a.gastoReal)
        .map(p => {
            const categoria = categorias.find(c => c.id == p.idCategoria);
            const nombre = categoria ? categoria.etiqueta : 'Categoría ' + p.idCategoria;
            const pct = p.montoPresupuestado > 0 ? (p.gastoReal / p.montoPresupuestado) * 100 : 0;
            const color = pct > 100 ? '#ef4444' : pct > 80 ? '#f59e0b' : '#22c55e';
            const icon = pct > 100 ? '⚠️' : pct > 80 ? '⚡' : '✅';
            
            // Barras de proporción
            const anthonyPct = p.montoPresupuestado > 0 ? (p.gastoAnthony / p.montoPresupuestado) * 100 : 0;
            const emelyPct = p.montoPresupuestado > 0 ? (p.gastoEmely / p.montoPresupuestado) * 100 : 0;
            const remainingPct = Math.max(0, 100 - anthonyPct - emelyPct);
            
            return `
                <div class="expense-card" style="border-left: 3px solid ${color}">
                    <div class="expense-icon" style="background:${color}20;color:${color}">${icon}</div>
                    <div class="expense-main">
                        <div class="expense-header">
                            <div class="expense-name">${nombre}</div>
                            <div class="expense-pct" style="color:${color}">${pct.toFixed(1)}%</div>
                        </div>
                        <div class="expense-meta">
                            ${fmtMoney(p.gastoReal)} / ${fmtMoney(p.montoPresupuestado)} · ${p.diasRestantes} días restantes · ${fmtMoney(p.recomendacionDiaria)}/día
                        </div>
                        <div class="expense-bar-track">
                            <div class="expense-bar-anthony" style="width:${anthonyPct}%"></div>
                            <div class="expense-bar-emely" style="width:${emelyPct}%"></div>
                            <div class="expense-bar-remaining" style="width:${remainingPct}%"></div>
                        </div>
                    </div>
                </div>
                ${p.particion ? `
                <div class="expense-partition">
                    <div class="expense-partition-col">
                        <div class="expense-partition-label" style="color:#3b82f6">Anthony</div>
                        <div class="expense-partition-value">${fmtMoney(p.gastoAnthony)}</div>
                        <div class="expense-partition-sub" style="color:${p.restanteAnthony >= 0 ? '#3b82f6' : '#f87171'}">${fmtMoney(p.restanteAnthony)} rest.</div>
                    </div>
                    <div class="expense-partition-col center">
                        <div class="expense-partition-label" style="color:#22c55e">Restante</div>
                        <div class="expense-partition-value">${fmtMoney(p.diferencia)}</div>
                        <div class="expense-partition-sub" style="color:${p.diferencia >= 0 ? '#22c55e' : '#f87171'}">${p.diferencia >= 0 ? 'Disponible' : 'Excedido'}</div>
                    </div>
                    <div class="expense-partition-col">
                        <div class="expense-partition-label" style="color:#ec4899">Emely</div>
                        <div class="expense-partition-value">${fmtMoney(p.gastoEmely)}</div>
                        <div class="expense-partition-sub" style="color:${p.restanteEmely >= 0 ? '#ec4899' : '#f87171'}">${fmtMoney(p.restanteEmely)} rest.</div>
                    </div>
                </div>
                ` : ''}
            `;
        }).join('');
    
    document.getElementById('expenseCategoriesList').innerHTML = 
        `<div class="asset-list">${expenseList}</div>`;
}


    function renderAnalytics() {
      const s = appData.summary;
      const avgIncome = s.ingresosNetos.history.slice(-12).reduce((a, b) => a + b.value, 0) / 12;
      const avgExpense = s.gastosTotal.history.slice(-12).reduce((a, b) => a + b.value, 0) / 12;
      const avgSavings = avgIncome - avgExpense;
      const avgSavingsRate = avgIncome > 0 ? (avgSavings / avgIncome) * 100 : 0;
      
      // Contribución: trabajo vs inversiones
      const trabajoIncome = appData.ingresos['Trabajo']?.current || 0;
      const otherIncome = avgIncome - trabajoIncome;
      const workContribution = avgIncome > 0 ? (trabajoIncome / avgIncome) * 100 : 0;

      // CAGR dinámico desde el primer dato histórico disponible
      const patHist = s.patrimonioNeto.history;
      let cagrDisplay = '—';
      let cagrColor = '#f59e0b';
      if (patHist.length >= 2) {
          const firstVal = patHist[0].value;
          const lastVal  = patHist[patHist.length - 1].value;
          const years    = (patHist.length - 1) / 12;
          if (firstVal > 0 && years > 0) {
              const cagr = (Math.pow(lastVal / firstVal, 1 / years) - 1) * 100;
              cagrDisplay = cagr.toFixed(1) + '%';
              cagrColor   = cagr >= 10 ? '#4ade80' : '#f59e0b';
          }
      }
      const cagrSince = patHist.length > 0 ? patHist[0].date : 'inicio';

      const html = `
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Ingreso Promedio (12m)</span></div>
              <div class="stat-value">${fmtMoney(avgIncome)}</div>
              <div class="stat-sub">Media móvil anual</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Ahorro Promedio (12m)</span></div>
              <div class="stat-value" style="color:${avgSavingsRate >= 10 ? '#4ade80' : avgSavingsRate > 0 ? '#f59e0b' : '#f87171'}">${fmtMoney(avgSavings)}</div>
              <div class="stat-sub">${avgSavingsRate.toFixed(1)}% tasa de ahorro promedio</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Contribución Trabajo</span></div>
              <div class="stat-value">${workContribution.toFixed(0)}%</div>
              <div class="stat-sub">Ingresos pasivos: ${fmtMoney(otherIncome)}</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">CAGR Patrimonio</span></div>
              <div class="stat-value" style="color:${cagrColor}">${cagrDisplay}</div>
              <div class="stat-sub">Desde ${cagrSince} (nominal)</div>
          </div>
      `;
      document.getElementById('analyticsStats').innerHTML = html;
  }



// === RENDER RATIOS & KPIs ===
function calculateRatios() {
    const s = appData.summary;
    const activos = s.activosTotales.current;
    const pasivos = s.pasivosTotal.current;
    const liquido = s.liquidoTotal.current;
    const inversiones = s.inversionesTotal.current;
    const patrimonio = s.patrimonioNeto.current;
    const ingresos = s.ingresosNetos.current;
    const otrosActivos = s.otrosActivos.current;

    // Historial para cálculos de tendencia
    const patHistory = s.patrimonioNeto.history;
    const last12 = patHistory.slice(-12);

    // Current Ratio (activos líquidos / pasivos — excluye activos ilíquidos a largo plazo)
    const currentRatio = pasivos > 0 ? liquido / pasivos : 0;

    // Quick Ratio (activos rápidamente convertibles / pasivos)
    const quickAssets = liquido + inversiones;
    const quickRatio = pasivos > 0 ? quickAssets / pasivos : 0;

    // Cash Ratio
    const cashRatio = pasivos > 0 ? liquido / pasivos : 0;

    // Working Capital
    const workingCapital = liquido - pasivos;

    // Deuda/Patrimonio
    const debtToEquity = patrimonio > 0 ? (pasivos / patrimonio) * 100 : 0;

    // Deuda/Activos
    const debtToAssets = activos > 0 ? (pasivos / activos) * 100 : 0;

    // Cobertura de Deuda (Líquido / Pasivos como %)
    const debtCoverage = pasivos > 0 ? (liquido / pasivos) * 100 : 0;

    // ROA (Return on Assets) - ingresos anualizados / activos totales
    // ingresos es mensual → multiplicar ×12 para comparar contra el stock de activos
    const ingresosAnualizados = ingresos * 12;
    const roa = activos > 0 ? (ingresosAnualizados / activos) * 100 : 0;

    // Tasa de Crecimiento YoY (Patrimonio)
    let yoyGrowth = 0;
    if (patHistory.length >= 13) {
        const val12mAgo = patHistory[patHistory.length - 13].value;
        if (val12mAgo !== 0) {
            yoyGrowth = ((patrimonio - val12mAgo) / Math.abs(val12mAgo)) * 100;
        }
    } else if (patHistory.length >= 2) {
        const firstVal = patHistory[0].value;
        const months = patHistory.length - 1;
        if (firstVal > 0 && months > 0) {
            const years = months / 12;
            yoyGrowth = (Math.pow(patrimonio / firstVal, 1 / years) - 1) * 100;
        }
    }

    // Velocidad de Acumulación (promedio mensual últimos 12 meses)
    let accumulationSpeed = 0;
    if (last12.length >= 2) {
        const first = last12[0].value;
        const last = last12[last12.length - 1].value;
        const months = last12.length - 1;
        accumulationSpeed = months > 0 ? (last - first) / months : 0;
    }

    // Ratio de Ahorro
    const savingsRate = ingresos > 0 ? ((ingresos - s.gastosTotal.current) / ingresos) * 100 : 0;

    // Independencia Financiera = Ingresos Pasivos / Gastos
    // Solo el ingreso pasivo (id '23' en presupuesto) refleja verdadera independencia
    const presupuesto = appData.presupuesto || [];
    const ingresoPasivo = presupuesto
        .filter(p => p.tipo === 'Ingresos' && String(p.id).replace(/^P/i, '') === '23')
        .reduce((a, b) => a + (b.gastoReal || 0), 0);
    const fiRatio = s.gastosTotal.current > 0 ? (ingresoPasivo / s.gastosTotal.current) * 100 : 0;

    return {
        liquidity: {
            currentRatio: { value: currentRatio, label: 'Current Ratio', format: 'x', threshold: 2 },
            quickRatio: { value: quickRatio, label: 'Quick Ratio', format: 'x', threshold: 1 },
            cashRatio: { value: cashRatio, label: 'Cash Ratio', format: 'x', threshold: 0.5 },
            workingCapital: { value: workingCapital, label: 'Working Capital', format: 'money', threshold: 0 }
        },
        solvency: {
            debtToEquity: { value: debtToEquity, label: 'Deuda / Patrimonio', format: 'pct', threshold: 50 },
            debtToAssets: { value: debtToAssets, label: 'Deuda / Activos', format: 'pct', threshold: 50 },
            debtCoverage: { value: debtCoverage, label: 'Cobertura de Deuda', format: 'pct', threshold: 100 },
            monthsCovered: { value: s.gastosTotal.current > 0 ? liquido / s.gastosTotal.current : 0, label: 'Meses de gastos cubiertos', format: 'x', threshold: 6 }
        },
        profitability: {
            roa: { value: roa, label: 'ROA (Return on Assets)', format: 'pct', threshold: 5 },
            yoyGrowth: { value: yoyGrowth, label: 'Crecimiento YoY', format: 'pct', threshold: 10 },
            accumulationSpeed: { value: accumulationSpeed, label: 'Vel. Acumulación', format: 'money', threshold: 0 },
            savingsRate: { value: savingsRate, label: 'Tasa de Ahorro', format: 'pct', threshold: 10 },
            fiRatio: { value: fiRatio, label: 'Independencia Financiera', format: 'pct', threshold: 100 }
        }
    };
}

function getKpiStatus(value, threshold, format, lowerIsBetter) {
    if (format === 'money') {
        if (value >= threshold * 2) return { class: 'excellent', text: 'Excelente ✓' };
        if (value >= threshold) return { class: 'good', text: 'Muy Bueno' };
        if (value >= 0) return { class: 'neutral', text: 'Saludable' };
        return { class: 'warning', text: 'Atención' };
    }

    if (lowerIsBetter) {
        if (value <= threshold / 4) return { class: 'excellent', text: 'Excelente ✓' };
        if (value <= threshold / 2) return { class: 'good', text: 'Muy Bueno' };
        if (value <= threshold) return { class: 'neutral', text: 'Moderado' };
        return { class: 'warning', text: 'Alto Riesgo' };
    }

    if (value >= threshold * 3) return { class: 'excellent', text: 'Excelente ✓' };
    if (value >= threshold * 1.5) return { class: 'good', text: 'Muy Bueno' };
    if (value >= threshold) return { class: 'neutral', text: 'Adecuado' };
    if (value >= threshold * 0.5) return { class: 'warning', text: 'Atención' };
    return { class: 'danger', text: 'Crítico' };
}

function formatKpiValue(item) {
    if (item.format === 'money') return fmtMoney(item.value);
    if (item.format === 'pct') return item.value.toFixed(2) + '%';
    if (item.format === 'x') return item.value.toFixed(2) + 'x';
    return item.value.toFixed(2);
}

function renderKpiCard(item, lowerIsBetter) {
    const status = getKpiStatus(item.value, item.threshold, item.format, lowerIsBetter);
    const formatted = formatKpiValue(item);

    // Gauge width (0-100%)
    // Para "lower is better": invertir el fill para que menor deuda = barra más llena
    let gaugeWidth = 0;
    if (lowerIsBetter) {
        const ref = item.format === 'pct' ? item.threshold * 2 : item.threshold * 3;
        gaugeWidth = Math.min(100, Math.max(0, (1 - item.value / ref) * 100));
    } else if (item.format === 'pct') {
        gaugeWidth = Math.min(100, Math.max(0, (item.value / (item.threshold * 2)) * 100));
    } else if (item.format === 'x') {
        gaugeWidth = Math.min(100, Math.max(0, (item.value / (item.threshold * 3)) * 100));
    } else if (item.format === 'money') {
        const maxRef = Math.max(Math.abs(item.value), Math.abs(item.threshold) * 2);
        gaugeWidth = maxRef > 0 ? Math.min(100, (Math.abs(item.value) / maxRef) * 100) : 0;
    }

    const gaugeColor = status.class === 'excellent' ? '#22c55e' : 
                       status.class === 'good' ? '#3b82f6' :
                       status.class === 'neutral' ? '#64748b' :
                       status.class === 'warning' ? '#f59e0b' : '#ef4444';

    return `
        <div class="kpi-card ${status.class}">
            <div class="kpi-header">
                <span class="kpi-label">${item.label}</span>
                <span class="kpi-badge ${status.class}">${status.text}</span>
            </div>
            <div class="kpi-value">${formatted}</div>
            <div class="kpi-sub">Meta: ${formatKpiValue({ ...item, value: item.threshold })}</div>
            <div class="kpi-gauge">
                <div class="kpi-gauge-track">
                    <div class="kpi-gauge-fill" style="width:${gaugeWidth}%;background:${gaugeColor}"></div>
                </div>
                <span class="kpi-gauge-label">${gaugeWidth.toFixed(0)}%</span>
            </div>
        </div>
    `;
}

function renderRatios() {
    const ratios = calculateRatios();

    // Liquidez
    const liquidityHtml = Object.values(ratios.liquidity)
        .map(item => renderKpiCard(item, false))
        .join('');
    document.getElementById('liquidityRatios').innerHTML = liquidityHtml;

    // Solvencia (lower is better para deuda)
    const solvencyHtml = Object.values(ratios.solvency)
        .map(item => renderKpiCard(item, item.label.includes('Deuda')))
        .join('');
    document.getElementById('solvencyRatios').innerHTML = solvencyHtml;

    // Rentabilidad
    const profitabilityHtml = Object.values(ratios.profitability)
        .map(item => renderKpiCard(item, false))
        .join('');
    document.getElementById('profitabilityRatios').innerHTML = profitabilityHtml;
}

function renderRatiosRadarChart() {
    if (charts.ratiosRadar) {
        charts.ratiosRadar.destroy();
        charts.ratiosRadar = null;
    }
    const ctx = getCanvas('ratiosRadarChart');
    if (!ctx) return;

    const r = calculateRatios();
    const s = appData.summary;

    // Normalizar métricas a escala 0-100 para el radar
    const norm = (val, max) => Math.min(100, Math.max(0, (val / max) * 100));

    const data = {
        labels: ['Liquidez', 'Solvencia', 'Rentabilidad', 'Ahorro', 'Crecimiento', 'Cobertura'],
        datasets: [{
            label: 'Tus Métricas',
            data: [
                norm(r.liquidity.currentRatio.value, 10),      // Current Ratio max 10x
                norm(100 - r.solvency.debtToEquity.value, 100),  // Invertir: menor deuda = mejor
                norm(r.profitability.roa.value, 20),             // ROA max 20%
                norm(Math.max(0, r.profitability.savingsRate.value), 30), // Ahorro max 30%
                norm(Math.max(0, r.profitability.yoyGrowth.value), 50),   // Crecimiento max 50%
                norm(r.solvency.debtCoverage.value, 200)         // Cobertura max 200%
            ],
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            pointBackgroundColor: '#3b82f6',
            pointBorderColor: '#0f172a',
            pointHoverBackgroundColor: '#60a5fa',
            pointHoverBorderColor: '#0f172a',
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6
        }, {
            label: 'Meta Ideal',
            data: [80, 90, 60, 70, 60, 80], // Metas ideales normalizadas
            borderColor: 'rgba(148, 163, 184, 0.4)',
            backgroundColor: 'rgba(148, 163, 184, 0.05)',
            pointBackgroundColor: 'transparent',
            pointBorderColor: 'transparent',
            borderWidth: 1,
            borderDash: [4, 4],
            pointRadius: 0
        }]
    };

    charts.ratiosRadar = new Chart(ctx, {
        type: 'radar',
        data: data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'top',
                    align: 'end',
                    labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true }
                },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1
                }
            },
            scales: {
                r: {
                    angleLines: { color: 'rgba(51,65,85,0.3)' },
                    grid: { color: 'rgba(51,65,85,0.2)' },
                    pointLabels: {
                        color: '#94a3b8',
                        font: { size: 11, weight: '600' }
                    },
                    ticks: {
                        color: '#64748b',
                        font: { size: 9 },
                        backdropColor: 'transparent',
                        stepSize: 20
                    },
                    suggestedMin: 0,
                    suggestedMax: 100
                }
            }
        }
    });
}

    // === CHARTS ===
    function renderChartsForTab(tab) {
    if (tab === 'overview') {
        renderPatrimonioChart();
        renderAssetsPieChart();
        renderAssetsVsLiabilitiesChart();
    } else if (tab === 'assets') {
        renderLiquidoChart();
        renderInversionesChart();
    } else if (tab === 'liabilities') {
        renderLiabilitiesChart();
    } else if (tab === 'income') {
        renderIncomeChart();
    } else if (tab === 'expenses') {
        renderExpensesChart();
        renderExpensesPieChart();
    } else if (tab === 'analytics') {
        renderGrowthRateChart();
        renderInvGrowthRateChart();
        renderIncomeVsExpenseChart();
        renderProjectionChart();  
    } else if (tab === 'ratios') {
        try {
            renderRatios();
        } catch (e) {
            console.error('Error renderizando ratios:', e);
        }
        setTimeout(() => {
            try {
                if (charts.ratiosRadar) {
                    charts.ratiosRadar.destroy();
                    charts.ratiosRadar = null;
                }
                renderRatiosRadarChart();
            } catch (e) {
                console.error('Error renderizando radar chart:', e);
            }
        }, 100);
    }
  }

  function formatShortDate(dateStr) {
    // Si ya está en formato corto, devolver tal cual
    if (typeof dateStr === 'string' && dateStr.includes("'")) {
        return dateStr;
    }
    
    // Si es fecha larga tipo "Sat Jan 01 2022..."
    try {
        const d = new Date(dateStr);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return months[d.getMonth()] + "'" + String(d.getFullYear()).slice(-2);
    } catch (e) {
        return dateStr;
    }
  }

  function renderPatrimonioChart() {
    const ctx = getCanvas('patrimonioChart');
    if (!ctx) return;
    const h = appData.summary.patrimonioNeto.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    charts.patrimonio = new Chart(ctx, {
        type: 'line',
        data: {
            labels: h.map(d => d.date + '\u200B'),  
            datasets: [{
                label: 'Patrimonio Neto',
                data: h.map(d => d.value),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => 'RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
                    }
                }
            },
            scales: {
                x: {
                    type: 'category',
                    grid: { display: false, drawBorder: false },
                    ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        maxTicksLimit: 8
                    },
                },
                y: {
                    grid: { color: 'rgba(51,65,85,0.2)', drawBorder: false },
                    ticks: {
                        color: '#64748b',
                        font: { size: 10 },
                        callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K'
                    }
                }
            }
        }
    });
}

    function renderAssetsPieChart() {
    const ctx = getCanvas('assetsPieChart');
    if (!ctx) return;
    const s = appData.summary;
    
    charts.assetsPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
        labels: ['Líquido', 'Inversiones', 'Otros Activos'],
        datasets: [{
            data: [s.liquidoTotal.current, s.inversionesTotal.current, s.otrosActivos.current],
            backgroundColor: ['#3b82f6', '#22c55e', '#f59e0b'],
            borderWidth: 0,
            hoverOffset: 8
        }]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
            legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { size: 11 }, padding: 16, usePointStyle: true }
            }
        }
        },
        plugins: [{
        id: 'centerText',
        beforeDraw: (chart) => {
            const { ctx, width, height } = chart;
            ctx.save();
            ctx.font = 'bold 18px Inter';
            ctx.fillStyle = '#f8fafc';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const total = s.activosTotales.current;
            ctx.fillText('RD$' + (total/1000000).toFixed(2) + 'M', width/2, height/2 - 8);
            ctx.font = '11px Inter';
            ctx.fillStyle = '#64748b';
            ctx.fillText('Total Activos', width/2, height/2 + 10);
            ctx.restore();
        }
        }]
    });
    }

    function renderAssetsVsLiabilitiesChart() {
    const ctx = getCanvas('assetsVsLiabilitiesChart');
    if (!ctx) return;
    //const a = appData.summary.activosTotales.history;
    const a = appData.summary.activosTotales.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    //const p = appData.summary.pasivosTotal.history;
    const p = appData.summary.pasivosTotal.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));

    charts.assetsVsLiab = new Chart(ctx, {
        type: 'line',
        data: {
        labels: a.map(d => d.date),
        datasets: [
            {
            label: 'Activos',
            data: a.map(d => d.value),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
            },
            {
            label: 'Pasivos',
            data: p.map((d, i) => ({ x: a[i]?.date, y: d.value })),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
            }
        ]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: {
            position: 'top',
            align: 'end',
            labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true }
            }
        },
        scales: {
            x: {
              type: 'category',
            grid: { display: false },
            ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 }
            },
            y: {
            grid: { color: 'rgba(51,65,85,0.2)' },
            ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' }
            }
        }
        }
    });
    }

    function renderLiquidoChart() {
    const ctx = getCanvas('liquidoChart');
    if (!ctx) return;
    const h = appData.summary.liquidoTotal.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    charts.liquido = new Chart(ctx, {
        type: 'line',
        data: {
          labels: h.map(d => {
            return String(d.date).replace(/'/g, "");
        }),
        datasets: [{
            label: 'Líquido Total',
            data: h.map(d => d.value),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
        }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {
            intersect: false, mode: 'index'
          },
          plugins: { 
            legend: { display: false },
            tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => 'RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
                    }
                } 
          },
          scales: {
              x: { 
                type: 'category',
                grid: {
                  display: false, drawBorder: false,
                }, 
                ticks: {
                  color: '#64748b', 
                  font: { size: 10 }, 
                  maxTicksLimit: 8 
                }, 
              },
              y: { 
                grid: {
                  color: 'rgba(51,65,85,0.2)' 
                }, 
                ticks: { 
                  color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' 
                } 
              }
          }
        }
    });
    }

    function renderInversionesChart() {
    const ctx = getCanvas('inversionesChart');
    if (!ctx) return;
    const h = appData.summary.inversionesTotal.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    charts.inversiones = new Chart(ctx, {
        type: 'line',
        data: {
        labels: h.map(d => {
            return String(d.date).replace(/'/g, "");
        }),
        datasets: [{
            label: 'Inversiones',
            data: h.map(d => d.value),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
        }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {intersect: false, mode: 'index'},
          plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => 'RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
                    }
                }
            },
          scales: {
              x: { 
                type: 'category',
                grid: {
                  display: false 
                }, 
                ticks: { 
                  color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 
                }
              },
              y: { 
                grid: {
                  color: 'rgba(51,65,85,0.2)' 
                }, 
                ticks: {
                  color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' 
                } 
              }
            }
          }
      });
    }

    function renderLiabilitiesChart() {
    const ctx = getCanvas('liabilitiesChart');
    if (!ctx) return;
    const h = appData.summary.pasivosTotal.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    charts.liabilities = new Chart(ctx, {
        type: 'bar',
        data: {
        labels: h.map(d => {
            return String(d.date).replace(/'/g, "");
        }),
        datasets: [{
            label: 'Balance Crédito',
            data: h.map(d => d.value),
            backgroundColor: '#ef4444',
            borderRadius: 4,
            barPercentage: 0.7
        }]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
        }
        }
    });
    }

    function renderIncomeChart() {
    const ctx = getCanvas('incomeChart');
    if (!ctx) return;
    const h = appData.summary.ingresosNetos.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    charts.income = new Chart(ctx, {
        type: 'bar',
        data: {
        labels: h.map(d => {
            return String(d.date).replace(/'/g, "");
        }),
        datasets: [{
            label: 'Ingresos Netos',
            data: h.map(d => d.value),
            backgroundColor: '#22c55e',
            borderRadius: 4,
            barPercentage: 0.7
        }]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
        }
        }
    });
    }

    function renderExpensesChart() {
    const ctx = getCanvas('expensesChart');
    if (!ctx) return;
    //const g = appData.summary.gastosTotal.history;
    const g = appData.summary.gastosTotal.history.map(d => ({
        date: formatShortDate(d.date),
        value: d.value
    }));
    //const p = appData.summary.presupuesto.history;
    const p = appData.summary.presupuesto.history.map(d => ({
      date: formatShortDate(d.date),
      value: d.value
    }));
    charts.expenses = new Chart(ctx, {
        type: 'bar',
        data: {
        labels: g.map(d => d.date),
        datasets: [
            {
            label: 'Gastos',
            data: g.map(d => d.value),
            backgroundColor: '#ef4444',
            borderRadius: 4,
            barPercentage: 0.6,
            categoryPercentage: 0.8
            },
            {
            label: 'Presupuesto',
            data: p.slice(0, g.length).map(d => d.value),
            backgroundColor: 'rgba(148,163,184,0.3)',
            borderRadius: 4,
            barPercentage: 0.6,
            categoryPercentage: 0.8
            }
        ]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
            position: 'top',
            align: 'end',
            labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true }
            }
        },
        scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
        }
        }
    });
    }

    function renderExpensesPieChart() {
    const ctx = getCanvas('expensesPieChart');
    if (!ctx) return;
    const entries = Object.entries(appData.gastos).sort((a, b) => b[1].current - a[1].current);
    
    charts.expensesPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
        labels: entries.map(e => e[0]),
        datasets: [{
            data: entries.map(e => e[1].current),
            backgroundColor: ['#f97316', '#8b5cf6', '#0ea5e9', '#22c55e', '#ef4444', '#64748b', '#ec4899', '#3b82f6', '#f59e0b', '#14b8a6'],
            borderWidth: 0,
            hoverOffset: 6
        }]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
            legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { size: 10 }, padding: 12, usePointStyle: true, boxWidth: 8 }
            }
        }
        }
    });
    }

    function renderGrowthRateChart() {
    const ctx = getCanvas('growthRateChart');
    if (!ctx) return;
    //const h = appData.tasas.patrimonio;
    const h = appData.tasas.patrimonio.map(d =>({
      date: formatShortDate(d.date),
      value: d.value
    }))
    charts.growthRate = new Chart(ctx, {
        type: 'line',
        data: {
          labels: h.map(d => d.date + '\u200B'),
          datasets: [{
            label: 'Tasa Crecimiento',
            data: h.map(d => d.value),
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139,92,246,0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: {intersect: false, mode: 'index'},
          plugins: { 
            legend: { display: false } },
          scales: {
              x: {
                type: 'category', 
                grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
              y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => v + '%' } }
          }
          }
      });
    }

    function renderInvGrowthRateChart() {
    const ctx = getCanvas('invGrowthRateChart');
    if (!ctx) return;
    //const h = appData.tasas.inversiones;
    const h = appData.tasas.inversiones.map(d =>({
      date: formatShortDate(d.date),
      value: d.value
    }))

    charts.invGrowthRate = new Chart(ctx, {
        type: 'line',
        data: {
          labels: h.map(d => d.date + '\u200B'),
          datasets: [{
              label: 'Tasa Inversiones',
              data: h.map(d => d.value),
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245,158,11,0.1)',
              fill: true,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 5
          }]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {intersect: false, mode: 'index'},
        plugins: { legend: { display: false } },
        scales: {
            x: { type: 'category', grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => v + '%' } }
        }
        }
    });
    }

    function renderIncomeVsExpenseChart() {
    const ctx = getCanvas('incomeVsExpenseChart');
    if (!ctx) return;
    //const inc = appData.summary.ingresosNetos.history;
    const inc = appData.summary.ingresosNetos.history.map(d =>({
      date: formatShortDate(d.date),
      value: d.value
    }))
    //const exp = appData.summary.gastosTotal.history;
    const exp = appData.summary.gastosTotal.history.map(d =>({
      date: formatShortDate(d.date),
      value: d.value
    }))
    charts.incVsExp = new Chart(ctx, {
        type: 'line',
        data: {
        labels: inc.map(d => d.date + '\u200B'),
        datasets: [
            {
            label: 'Ingresos',
            data: inc.map(d => d.value),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
            },
            {
            label: 'Gastos',
            data: exp.slice(0, inc.length).map(d => d.value),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
            }
        ]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {intersect: false, mode: 'index'},
        plugins: {
            legend: {
            position: 'top',
            align: 'end',
            labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true }
            }
        },
        scales: {
            x: {
              type: 'category', 
              grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 } },
            y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
        }
        }
    });
    }

    function renderProjectionChart() {
    const ctx = getCanvas('projectionChart');
    if (!ctx) return;

    const rawHistory = appData.summary.patrimonioNeto.history;
    
    // === VALIDACIÓN Y PREPARACIÓN DE DATOS ===
    if (!rawHistory || rawHistory.length < 2) {
        document.getElementById('projectionChart').innerHTML = 
            '<div style="color:#64748b;text-align:center;padding:40px;">Datos insuficientes para proyección</div>';
        return;
    }

    const history = rawHistory.map(d => ({
        date: formatShortDate(d.date),
        value: Number(d.value) || 0
    })).filter(d => d.value > 0); // Filtrar valores 0 o negativos para el CAGR

    if (history.length < 2) {
        document.getElementById('projectionChart').innerHTML = 
            '<div style="color:#64748b;text-align:center;padding:40px;">Se requieren al menos 2 puntos con valor > 0</div>';
        return;
    }

    const firstVal = history[0].value;
    const lastVal = history[history.length - 1].value;
    const months = history.length;
    
    // === CÁLCULO ROBUSTO DEL CAGR ===
    let cagr = 0;
    let useProjection = false;
    
    if (firstVal > 0 && lastVal > 0 && months >= 2) {
        const years = months / 12;
        if (years > 0) {
            cagr = Math.pow(lastVal / firstVal, 1 / years) - 1;
            // Limitar CAGR a un rango razonable (máx 50% anual)
            if (cagr > 0.50) cagr = 0.50;
            if (cagr < -0.50) cagr = -0.50;
            useProjection = true;
        }
    }

    // === PROYECCIÓN: 5 AÑOS (60 MESES) ===
    const projected = [];
    let currentVal = lastVal;
    
    // Parsear la última fecha del histórico
    const lastDate = history[history.length - 1].date;
    const monthsList = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    
    let monthIdx, year;
    
    if (lastDate && lastDate.includes("'")) {
        const [lastMonth, lastYear] = lastDate.split("'");
        monthIdx = monthsList.indexOf(lastMonth);
        year = parseInt('20' + lastYear);
    } else {
        // Fallback si el formato de fecha es inesperado
        const d = new Date();
        monthIdx = d.getMonth();
        year = d.getFullYear();
    }

    if (monthIdx === -1) monthIdx = 0;

    // Tasa efectiva mensual (no nominal) para evitar desbordamiento
    const monthlyRate = useProjection ? Math.pow(1 + cagr, 1/12) - 1 : 0;

    for (let i = 1; i <= 60; i++) {
        monthIdx++;
        if (monthIdx >= 12) { monthIdx = 0; year++; }
        
        if (useProjection) {
            currentVal = currentVal * (1 + monthlyRate);
        }
        
        projected.push({
            date: monthsList[monthIdx] + "'" + String(year).slice(-2),
            value: currentVal
        });
    }

    // === CONSTRUCCIÓN DE DATASETS PARA CHART.JS ===
    const allLabels = [...history.map(d => d.date), ...projected.map(d => d.date)];
    
    // Dataset histórico: valores reales + nulls para la proyección
    const historicalData = [...history.map(d => d.value), ...new Array(projected.length).fill(null)];
    
    // Dataset de proyección: nulls para el histórico excepto el último punto + valores proyectados
    const projectionData = new Array(history.length - 1).fill(null);
    projectionData.push(lastVal); // Punto de unión
    projectionData.push(...projected.map(d => d.value));

    // === DESTRUIR GRÁFICA ANTERIOR ===
    if (charts.projection) {
        charts.projection.destroy();
        charts.projection = null;
    }

    charts.projection = new Chart(ctx, {
        type: 'line',
        data: {
            labels: allLabels,
            datasets: [
                {
                    label: 'Histórico',
                    data: historicalData,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59,130,246,0.1)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHoverRadius: 5
                },
                {
                    label: 'Proyección',
                    data: projectionData,
                    borderColor: '#8b5cf6',
                    borderDash: [5, 5],
                    backgroundColor: 'rgba(139,92,246,0.05)',
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
                    pointHoverRadius: 5
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { 
                    position: 'top', 
                    align: 'end', 
                    labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true } 
                },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1,
                    callbacks: {
                        label: (ctx) => {
                            if (ctx.parsed.y === null) return null;
                            return ctx.dataset.label + ': RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2});
                        }
                    }
                }
            },
            scales: {
                x: { 
                    type: 'category', 
                    grid: { display: false }, 
                    ticks: { 
                        color: '#64748b', 
                        font: { size: 10 }, 
                        maxTicksLimit: 12,
                        maxRotation: 0
                    } 
                },
                y: { 
                    grid: { color: 'rgba(51,65,85,0.2)' }, 
                    ticks: { 
                        color: '#64748b', 
                        font: { size: 10 }, 
                        callback: (v) => {
                            if (v >= 1000000) return 'RD$' + (v/1000000).toFixed(1) + 'M';
                            return 'RD$' + (v/1000).toFixed(0) + 'K';
                        }
                    } 
                }
            }
        }
    });
}

    // === UTILS ===
    function getCanvas(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    return canvas.getContext('2d');
    }

    function renderAll() {
    renderOverview();
    renderAssets();
    renderLiabilities();
    renderIncome();
    renderExpenses();
    renderAnalytics();
    renderChartsForTab('overview');
    }

    // === ACTIONS ===
    async function refreshData() {
    document.getElementById('loading').classList.remove('hidden');
    await loadData();
    renderAll();
    document.getElementById('loading').classList.add('hidden');
    }

    function exportData() {
    const dataStr = JSON.stringify(appData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'balance-sheet-data.json';
    a.click();
    URL.revokeObjectURL(url);
    }
    // Helper para obtener el límite total de crédito desde los datos
    function getCreditLimitTotal() {
    // Suma límites de tarjetas + líneas de crédito (NO préstamos)
    let total = 0;
    for (const name of TARJETAS_NOMBRES) total += getCreditLimit(name);
    for (const name of LINEAS_NOMBRES)   total += getCreditLimit(name);
    return total;
}
