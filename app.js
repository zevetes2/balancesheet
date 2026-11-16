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

    // ============================================================
    // CACHE DE DATOS DIARIOS (para proyecciones por categoría)
    // ============================================================
    const dailyCache = {}; // { 'gastos_2026_09': data, ... }
    let expensesSelectedMonthKey = '';
    let incomeSelectedMonthKey = '';

    function addMonths(year, month, delta) {
        const d = new Date(year, month - 1 + delta, 1);
        return { year: d.getFullYear(), month: d.getMonth() + 1 };
    }

    function getDaysInMonth(year, month) {
        return new Date(year, month, 0).getDate();
    }

    // Devuelve la categoría + todos sus descendientes (recursivo)
    function getAllCategoryVariants(parentName) {
        const names = new Set([parentName]);
        let changed = true;
        let iterations = 0;

        while (changed && iterations < 10) {
            changed = false;
            iterations++;
            for (const [name, meta] of Object.entries(CAT_DB)) {
                if (meta.padre && names.has(meta.padre) && !names.has(name)) {
                    names.add(name);
                    changed = true;
                }
            }
        }
        return names;
    }

    function extractDailyForCategory(monthData, catName, daysInMonth) {
        const arr = new Array(daysInMonth).fill(0);
        if (!monthData || !monthData.dias) return arr;

        // Set con la categoría padre + todas las subcategorías que le pertenecen
        const variants = getAllCategoryVariants(catName);

        monthData.dias.forEach(d => {
            const day = parseInt(d.fecha.substring(8, 10), 10);
            if (day < 1 || day > daysInMonth) return;
            if (!d.categorias) return;

            // Sumar todo lo que coincida con cualquiera de las variantes
            let total = 0;
            for (const [key, val] of Object.entries(d.categorias)) {
                if (variants.has(key)) total += (val || 0);
            }
            arr[day - 1] = total;
        });

        return arr;
    }

    function accumulate(arr) {
        const out = [];
        let sum = 0;
        for (const v of arr) { sum += v; out.push(sum); }
        return out;
    }

    // Construye todas las series necesarias para la proyección de una categoría
    function buildCategoryProjection(catName, currentBudget, monthKey = getExpenseMonthKey(new Date())) {
        const [yearPart, monthPart] = monthKey.split('-');
        const y = Number(yearPart);
        const m = Number(monthPart);
        const closed = monthKey < getExpenseMonthKey(new Date());
        const today = closed ? getDaysInMonth(y, m) : Math.min(new Date().getDate(), getDaysInMonth(y, m));
        const daysInMonth = getDaysInMonth(y, m);

        const prev1 = addMonths(y, m, -1);
        const prev2 = addMonths(y, m, -2);

        const curKey  = `gastos_${y}_${String(m).padStart(2, '0')}`;
        const p1Key   = `gastos_${prev1.year}_${String(prev1.month).padStart(2, '0')}`;
        const p2Key   = `gastos_${prev2.year}_${String(prev2.month).padStart(2, '0')}`;

        const curData  = dailyCache[curKey];
        const p1Data   = dailyCache[p1Key];
        const p2Data   = dailyCache[p2Key];

        if (!curData) return null;

        const dailyCur   = extractDailyForCategory(curData, catName, daysInMonth);
        const dailyPrev1 = extractDailyForCategory(p1Data, catName, daysInMonth);
        const dailyPrev2 = extractDailyForCategory(p2Data, catName, daysInMonth);

        const accCur   = accumulate(dailyCur);
        const accPrev1 = accumulate(dailyPrev1);
        const accPrev2 = accumulate(dailyPrev2);

        const todayTotal = accCur[today - 1] || 0;

        // Ritmo diario actual (promedio real hasta hoy)
        const avgDailyReal = today > 0 ? todayTotal / today : 0;

        // Ritmo diario de 3 meses
        const totalPrev1 = accPrev1[accPrev1.length - 1] || 0;
        const totalPrev2 = accPrev2[accPrev2.length - 1] || 0;
        const daysPrev1 = p1Data?.dias?.length ? getDaysInMonth(prev1.year, prev1.month) : 0;
        const daysPrev2 = p2Data?.dias?.length ? getDaysInMonth(prev2.year, prev2.month) : 0;

        const sum3m = todayTotal + totalPrev1 + totalPrev2;
        const days3m = today + daysPrev1 + daysPrev2;
        const avgDaily3m = days3m > 0 ? sum3m / days3m : 0;

        // Tasa usada para proyectar: preferir el ritmo real, si es 0 usar el de 3m
        const projectionRate = todayTotal > 0 ? avgDailyReal : avgDaily3m;

        // Proyección acumulada: hasta hoy real, después extrapolado
        const projected = [];
        for (let i = 0; i < daysInMonth; i++) {
            if (i < today) projected.push(accCur[i]);
            else projected.push(todayTotal + projectionRate * (i - today + 1));
        }

        // Promedio acumulado 3m por día (línea azul del ejemplo)
        const avg3mCumulative = [];
        for (let i = 0; i < daysInMonth; i++) {
            let sum = 0, count = 0;
            if (i < today) { sum += accCur[i]; count++; }
            if (p1Data?.dias?.length) { sum += accPrev1[i]; count++; }
            if (p2Data?.dias?.length) { sum += accPrev2[i]; count++; }
            avg3mCumulative.push(count > 0 ? sum / count : 0);
        }

        return {
            daysInMonth,
            today,
            labels: Array.from({ length: daysInMonth }, (_, i) => String(i + 1)),
            accumulated: accCur.map((v, i) => i < today ? v : null),
            projected: closed ? null : projected.map((v, i) => i >= today - 1 ? v : null),
            prev1: p1Data?.dias?.length ? accPrev1 : null,
            prev2: p2Data?.dias?.length ? accPrev2 : null,
            avg3mCumulative,
            budget: currentBudget || 0,
            todayTotal,
            avgDaily3m,
            projectionRate,
            hasPrev1: !!p1Data?.dias?.length,
            hasPrev2: !!p2Data?.dias?.length,
            closed
        };
    }

    // === MODECO: CLASIFICACIÓN Y COLORES ===
    const MODECO_GASTO_CLASIFICACION = {
        'Compras y Materia Prima - COGS': 'COGS',
        'Logística Directa de Entrega - COGS': 'COGS',
        'Mermas / Desperdicio - COGS': 'COGS',
        'Reparaciones mantenimiento - COGS': 'COGS',
        'Recursos Humanos - OPEX': 'OPEX',
        'Viajes y Representación - OPEX': 'OPEX',
        'Operaciones y Planta - OPEX': 'OPEX',
        'Desarrollo y Formacion - OPEX': 'OPEX',
        'Administracion y Legales - OPEX': 'OPEX',
        'Tecnología y Software - OPEX': 'OPEX',
        'Marketing y Comercializacion - OPEX': 'OPEX',
        'Maquinaria, Herramientas y Muebles - CAPEX': 'CAPEX',
        'Fondo Misiones - Modeco': 'Modeco',
        'Impuestos - Modeco': 'Modeco',
        'Intereses y Comisiones Bancarias - Modeco': 'Modeco',
        'Depreciacion de Activos - Modeco': 'Modeco',
        'Otros Gastos - Modeco': 'Modeco'
    };

    const MODECO_CLASIF_COLORS = {
        COGS: '#f97316',
        OPEX: '#3b82f6',
        CAPEX: '#8b5cf6',
        Modeco: '#f59e0b',
        Ingreso: '#22c55e'
    };

    let modecoData = null;
    let modecoLoadingPromise = null;
    let modecoSelectedMonthIndex = 0;

    // === CACHE LOCAL ===
    const BS_CACHE_KEY = 'bs_cache_v2';
    const BS_CACHE_TTL = 1000 * 60 * 30; // 30 minutos

    function saveCache(data) {
        try {
            localStorage.setItem(BS_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
        } catch (e) { console.warn('Cache no guardado:', e); }
    }

    function loadCache() {
        try {
            const raw = localStorage.getItem(BS_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (Date.now() - parsed.timestamp > BS_CACHE_TTL) {
                localStorage.removeItem(BS_CACHE_KEY);
                return null;
            }
            return parsed.data;
        } catch (e) { return null; }
    }


    // === MODAL DE DETALLE DE ACTIVO ===
    let assetDetailChart = null;

    const ASSET_COLORS = {
        'Débito Banreservas': '#0D47A1', 'Cash': '#0D47A1', 'Débito Popular': '#0D47A1',
        'Digital Banreservas': '#4DB6AC', 'Digital Popular': '#4DB6AC', 'Digital BHD': '#4DB6AC',
        'BDI: Ahorro': '#FBC02D', 'QIK: Ahorro': '#FBC02D', 'Ademi: Ahorro': '#4EA90A',
        'Cash US': '#4EA90A', 'Airtm': '#4EA90A', 'Paypal USD': '#4EA90A', 'Binance': '#4EA90A',
        'Etoro': '#FF6F00', 'Hapi': '#FF6F00', 'Alpha View': '#FF6F00',
        'UC United Capital': '#FF6F00', 'Larimar': '#FF6F00', 'Cesar Iglesias': '#FF6F00',
        'SIVEMBC263': '#FF6F00', 'Certificado Banreserva': '#FF6F00',
        'Alcanza Inversiones': '#FF6F00', 'Haina Investment 2034': '#FF6F00',
        'Fondo de Fondos Altio': '#FF6F00', 'TradeStation': '#FF6F00', 'BHD - Modeco': '#FF6F00', 'Cash - Modeco': '#FF6F00', 'Cash USD - Modeco': '#FF6F00',
    };


function fmtDate(dateStr) {
    if (!dateStr || dateStr === '—') return '—';
    
    // Si ya viene formateada como DD/MM/YYYY
    if (typeof dateStr === 'string' && dateStr.includes('/')) {
        const parts = dateStr.split('/');
        if (parts.length === 3) {
            const d = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            const y = parts[2];
            const meses = ['enero','febrero','marzo','abril','mayo','junio',
                           'julio','agosto','septiembre','octubre','noviembre','diciembre'];
            if (m >= 1 && m <= 12) {
                return `${d} de ${meses[m-1]}, ${y}`;
            }
        }
    }
    
    // Fallback por si llega en otro formato
    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
            const meses = ['enero','febrero','marzo','abril','mayo','junio',
                           'julio','agosto','septiembre','octubre','noviembre','diciembre'];
            return `${d.getDate()} de ${meses[d.getMonth()]}, ${d.getFullYear()}`;
        }
    } catch (e) {}
    
    return dateStr;
}



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
        'Crediclick BHD': 130000,
        'Prestamo Popular': 164000,
        'Prestamo Modeco': 230000,
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

const LINEAS_NOMBRES = ['Extra Limite Caribe', 'Credimás Banreservas', 'Crediclick BHD'];
const PRESTAMOS_NOMBRES = ['Prestamo Popular', 'Prestamo Modeco'];

function getDeuda(data) {
    // En la hoja: positivo = deuda (gastado), negativo = crédito a favor
    return data && data.current > 0 ? data.current : 0;
}
function getLiabilityMonthChange(data) {
    if (!data || data.previous === null || data.previous === undefined || data.previous === '') {
        return { amount: null, label: 'Sin dato del mes anterior', color: '#64748b' };
    }
    const currentDebt = getDeuda(data);
    const previousDebt = getDeuda({ current: Number(data.previous) || 0 });
    const amount = currentDebt - previousDebt;
    if (Math.abs(amount) < 0.01) return { amount: 0, label: 'Sin cambio vs. mes anterior', color: '#94a3b8' };
    return amount > 0
        ? { amount, label: `Aumentó ${fmtMoney(amount)} vs. mes anterior`, color: '#f87171' }
        : { amount, label: `Bajó ${fmtMoney(Math.abs(amount))} vs. mes anterior`, color: '#4ade80' };
}
function formatCreditUtilization(debt, limit) {
    return limit > 0 ? `Utilización ${((debt / limit) * 100).toFixed(1)}%` : 'Sin límite configurado';
}
function getDisponible(name, data) {
    const limite = getCreditLimit(name);
    if (limite === 0) return 0;
    const deuda = getDeuda(data);
    const excedente = data && data.current < 0 ? Math.abs(data.current) : 0;
    return limite - deuda + excedente;
}
function getUtilizacion(name, data) {
    const limite = getCreditLimit(name);
    if (limite <= 0) return null;
    return (getDeuda(data) / limite) * 100;
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
                        <div class="credit-detail-item-label">Fecha de Corte</div>
                        <div class="credit-detail-item-value">${fmtDate(info.fechaCorte)}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Días de Gracia</div>
                        <div class="credit-detail-item-value">${info.diasGracia || '—'}</div>
                    </div>
                    <div class="credit-detail-item">
                        <div class="credit-detail-item-label">Fecha de Pago</div>
                        <div class="credit-detail-item-value" style="color:${isOverdue || isClose ? statusColor : ''}">
                            ${fmtDate(info.fechaPago) || '—'}
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


    async function loadData() {
    const isLocal = location.hostname === 'localhost' || 
                    location.hostname === '127.0.0.1' || 
                    location.protocol === 'file:';

    // 1. Mostrar cache inmediatamente (percepción de velocidad)
    const cached = loadCache();
    if (cached) {
        appData = cached;
        console.log('⚡ Dashboard desde cache local');
        renderAll();
        document.getElementById('loading').classList.add('hidden');
    }

    // 2. Cargar datos frescos en background
    let freshData = null;

    if (!isLocal) {
        try {
            const res = await fetch(CONFI.API_URL + '?action=getData');
            if (res.ok) {
                freshData = await res.json();
                console.log('✅ Datos vía Fetch');
            }
        } catch (e) {
            console.log('⚠️ Fetch falló:', e.message);
        }
    }

    if (!freshData) {
        try {
            freshData = await loadDataJSONP();
            console.log('✅ Datos vía JSONP');
        } catch (e) {
            console.log('⚠️ JSONP falló:', e.message);
            if (!cached) throw new Error('No se pudieron cargar los datos.');
            return; // Seguimos con cache
        }
    }

    // 3. Actualizar si hay datos nuevos
    if (freshData) {
        const hadCache = !!appData;
        appData = freshData;
        saveCache(appData);

        if (hadCache) {
            // Refrescar silenciosamente el tab activo
            invalidateRenderedTabs();
            const activeTab = document.querySelector('.section.active')?.id || 'overview';
            renderedTabs.add(activeTab);
            renderTabContent(activeTab);
            // Forzar re-creación de charts del tab activo
            if (activeTab === 'overview') {
                destroyAllCharts();
                renderChartsForTab('overview');
            }
        } else {
            renderAll();
            document.getElementById('loading').classList.add('hidden');
        }
    }
}



    

// === JSONP LOADER (bypass CORS) ===
function loadDataJSONP() {
    return new Promise((resolve, reject) => {
        const callbackName = 'bsCallback_' + Date.now();
        const script = document.createElement('script');
        const timeout = setTimeout(() => {
            reject(new Error('Timeout JSONP después de 2m'));
            cleanup();
        }, 120000);

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

    // === TABS OPTIMIZADOS ===
    function switchTab(tabId) {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
        document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
        document.getElementById(tabId).classList.add('active');
        
        // Lazy render: solo la primera vez que entras al tab
        if (!renderedTabs.has(tabId)) {
            renderedTabs.add(tabId);
            renderTabContent(tabId);
        }
        
        // Charts: solo si no existen (no destruir al cambiar de tab)
        setTimeout(() => {
            renderChartsForTab(tabId);
        }, 50);
    }

    // Hook de wallet/budget (simplificado)
    const originalSwitchTab = switchTab;
    switchTab = function(tabId) {
        originalSwitchTab(tabId);
    };


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
        
        const income = s.ingresosNetos.current;
        const expenses = s.gastosTotal.current;
        const savingsRate = income > 0 ? ((income - expenses) / income) * 100 : 0;
        const savingsAmount = income - expenses;
        
        const debtRatio = totalAssets > 0 ? (totalLiab / totalAssets) * 100 : 0;
        const liquidityRatio = totalLiab > 0 ? (liquidity / totalLiab) : 0;
        const investmentRatio = totalAssets > 0 ? (investments / totalAssets) * 100 : 0;
        const healthScore = Math.min(100, Math.round(
            (debtRatio < 20 ? 25 : debtRatio < 50 ? 15 : 5) +
            (liquidityRatio > 1 ? 25 : liquidityRatio > 0.5 ? 15 : 5) +
            (investmentRatio > 30 ? 25 : investmentRatio > 15 ? 15 : 5) +
            (savingsRate > 10 ? 25 : savingsRate > 0 ? 15 : 5)
        ));
        
        const patrimonioHistory = s.patrimonioNeto.history;
        const val12mAgo = patrimonioHistory.length > 12 ? patrimonioHistory[patrimonioHistory.length - 13].value : patrimonioHistory[0].value;
        const trend12m = ((netWorth - val12mAgo) / Math.abs(val12mAgo)) * 100;
        
        // === EXECUTIVE SUMMARY ===
    const now = new Date();
    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    document.getElementById('summaryDate').textContent = `Al ${now.getDate()} de ${meses[now.getMonth()]}, ${now.getFullYear()}`;

    // Cambios vs mes anterior para pasivos
    let creditoChange = 0;
    let prestamoChange = 0;
    for (const [name, data] of Object.entries(appData.creditos || {})) {
        if (TARJETAS_NOMBRES.includes(name) || LINEAS_NOMBRES.includes(name)) {
            creditoChange += (data.change || 0);
        }
        if (PRESTAMOS_NOMBRES.includes(name)) {
            prestamoChange += (data.change || 0);
        }
    }

    const totalCombined = totalAssets + totalLiab;
    const pctAssets = totalCombined > 0 ? (totalAssets / totalCombined) * 100 : 0;
    const pctLiab = totalCombined > 0 ? (totalLiab / totalCombined) * 100 : 0;

    const arrow = (val) => {
        if (val > 0) {
            return '↑';
        } else if(val < 0) {
            return '↓';
        }
        else{
            return '—';
        }
    };
    const arrowcred = (val) =>
    {
        if (val > 0) {
            return '↓';
        } else if(val < 0) {
            return '↑';
        }
        else{
            return '—';
        }
    }
        
    const arrowClass = (val) => val > 0 ? 'up' : 'down';
    const arrowClassCred = (val) => val > 0 ? 'down' : 'up';

    const summaryHtml = `
        <div class="patrimonial-col activos">
            <div class="patrimonial-pct">${pctAssets.toFixed(2)}%</div>
            <div class="patrimonial-label">ACTIVOS</div>
            <div class="patrimonial-total">${fmtMoney(totalAssets)}</div>
            <div class="patrimonial-items">
                <div class="patrimonial-item ${arrowClass(s.inversionesTotal.change)}">
                    <span class="amount">${fmtMoney(s.inversionesTotal.change)}</span>
                    <span class="name">Inversiones</span>
                    <span class="arrow">${arrow(s.inversionesTotal.change)}</span>
                </div>
                <div class="patrimonial-item ${arrowClass(s.liquidoTotal.change)}">
                    <span class="amount">${fmtMoney(s.liquidoTotal.change)}</span>
                    <span class="name">Líquido</span>
                    <span class="arrow">${arrow(s.liquidoTotal.change)}</span>
                </div>
                <div class="patrimonial-item ${arrowClass(s.otrosActivos.change)}">
                    <span class="amount">${fmtMoney(s.otrosActivos.change)}</span>
                    <span class="name">Otros</span>
                    <span class="arrow">${arrow(s.otrosActivos.change)}</span>
                </div>
            </div>
        </div>
        <div class="patrimonial-col patrimonio">
            <div class="patrimonial-label" style="margin-bottom:4px;">PATRIMONIO</div>
            <div class="patrimonial-total" style="margin-bottom:18px;">${fmtMoney(netWorth)}</div>
            <div class="patrimonial-items">
                <div class="patrimonial-item ${arrowClass(s.patrimonioNeto.change)}">
                    <span class="amount">${fmtMoney(s.patrimonioNeto.change)}</span>
                    <span class="name">Neto</span>
                    <span class="arrow">${arrow(s.patrimonioNeto.change)}</span>
                </div>
                <div class="patrimonial-item ${arrowClass(s.activosTotales.change)}">
                    <span class="amount">${fmtMoney(s.activosTotales.change)}</span>
                    <span class="name">Activos</span>
                    <span class="arrow">${arrow(s.activosTotales.change)}</span>
                </div>
                <div class="patrimonial-item ${arrowClassCred(s.pasivosTotal.change)}">
                    <span class="amount">${fmtMoney(s.pasivosTotal.change)}</span>
                    <span class="name">Pasivos</span>
                    <span class="arrow">${arrowcred(s.pasivosTotal.change)}</span>
                </div>
            </div>
        </div>
        <div class="patrimonial-col pasivos">
            <div class="patrimonial-pct">${pctLiab.toFixed(2)}%</div>
            <div class="patrimonial-label">PASIVOS</div>
            <div class="patrimonial-total">${fmtMoney(totalLiab)}</div>
            <div class="patrimonial-items">
                <div class="patrimonial-item ${arrowClassCred(creditoChange)}">
                    <span class="amount">${fmtMoney(creditoChange)}</span>
                    <span class="name">Crédito</span>
                    <span class="arrow">${arrowcred(creditoChange)}</span>
                </div>
                <div class="patrimonial-item ${arrowClassCred(prestamoChange)}">
                    <span class="amount">${fmtMoney(prestamoChange)}</span>
                    <span class="name">Préstamos</span>
                    <span class="arrow">${arrowcred(prestamoChange)}</span>
                </div>
            </div>
        </div>
    `;
    const summaryGrid = document.getElementById('summaryGrid');
    summaryGrid.className = 'patrimonial-grid';
    summaryGrid.innerHTML = summaryHtml;

        // === PODER ADQUISITIVO TOTAL ===
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

        // === STAT CARDS ORIGINALES (debajo del executive summary) ===
        const html = `
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
            <div class="stat-card">
                <div class="stat-header">
                    <span class="stat-label">Ratio Deuda/Activos</span>
                </div>
                <div class="stat-value" style="color:${debtRatio < 30 ? '#4ade80' : debtRatio < 50 ? '#f59e0b' : '#f87171'}">${debtRatio.toFixed(1)}%</div>
                <div class="stat-sub">${debtRatio < 30 ? '✅ Saludable' : debtRatio < 50 ? '⚠️ Moderado' : '🔴 Alto'} (&lt;30% ideal)</div>
            </div>
        `;
        document.getElementById('overviewStats').innerHTML = html;
    }


    function formatDateToString(dateValue) {
        if (!dateValue) return '';
        if (dateValue instanceof Date) {
            const d = dateValue.getDate();           // día real (1-31)
            const m = dateValue.getMonth() + 1;      // mes (1-12)
            const y = dateValue.getFullYear();       // año completo
            // Formato: DD/MM/YYYY (o el que prefieras)
            return String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
        }
        // Si es texto en Sheets, devolverlo limpio
        return dateValue.toString().trim();
        }

    // === RENDER ASSETS ===
    function renderAssets() {
    const s = appData.summary;
    const totalAssets = Number(s.activosTotales.current) || 0;
    const liquid = Number(s.liquidoTotal.current) || 0;
    const investments = Number(s.inversionesTotal.current) || 0;
    const otherAssets = Number(s.otrosActivos.current) || 0;
    const pctOfAssets = value => totalAssets > 0 ? (value / totalAssets) * 100 : 0;
    const assetHistory = (s.activosTotales.history || []).slice().sort((a, b) =>
        getExpenseMonthKey(b.isoDate || b.date).localeCompare(getExpenseMonthKey(a.isoDate || a.date))
    );
    const currentAssetMonth = assetHistory[0];
    const previousAssetMonth = assetHistory[1];
    const monthlyChange = currentAssetMonth && previousAssetMonth
        ? (Number(currentAssetMonth.value) || 0) - (Number(previousAssetMonth.value) || 0)
        : null;
    const monthlyChangePct = monthlyChange !== null && Number(previousAssetMonth.value) !== 0
        ? (monthlyChange / Math.abs(Number(previousAssetMonth.value))) * 100
        : null;
    let annualAssetMonth = null;
    if (currentAssetMonth) {
        const [assetYear, assetMonth] = getExpenseMonthKey(currentAssetMonth.isoDate || currentAssetMonth.date).split('-').map(Number);
        if (assetYear && assetMonth) {
            const priorYearMonth = addMonths(assetYear, assetMonth, -12);
            const priorYearKey = `${priorYearMonth.year}-${String(priorYearMonth.month).padStart(2, '0')}`;
            annualAssetMonth = assetHistory.find(item =>
                getExpenseMonthKey(item.isoDate || item.date) === priorYearKey
            ) || null;
        }
    }
    const annualChange = currentAssetMonth && annualAssetMonth
        ? (Number(currentAssetMonth.value) || 0) - (Number(annualAssetMonth.value) || 0)
        : null;
    const annualChangePct = annualChange !== null && Number(annualAssetMonth.value) !== 0
        ? (annualChange / Math.abs(Number(annualAssetMonth.value))) * 100
        : null;
    const currentMonthKey = getExpenseMonthKey(new Date());
    const closedExpenseMonths = (s.gastosTotal.history || []).filter(item =>
        getExpenseMonthKey(item.isoDate || item.date) < currentMonthKey
    ).sort((a, b) =>
        getExpenseMonthKey(b.isoDate || b.date).localeCompare(getExpenseMonthKey(a.isoDate || a.date))
    ).slice(0, 3);
    const averageClosedMonthlyExpense = closedExpenseMonths.length
        ? closedExpenseMonths.reduce((sum, item) => sum + (Number(item.value) || 0), 0) / closedExpenseMonths.length
        : 0;
    const liquidityCoverageMonths = averageClosedMonthlyExpense > 0 ? liquid / averageClosedMonthlyExpense : null;
    const allocationItems = [
        { name: 'Líquido disponible', value: liquid, color: '#3b82f6' },
        { name: 'Inversiones', value: investments, color: '#22c55e' },
        { name: 'Otros activos', value: otherAssets, color: '#f59e0b' }
    ];
    const categorizedAssets = allocationItems.reduce((sum, item) => sum + item.value, 0);
    const unclassifiedAssets = Math.max(0, totalAssets - categorizedAssets);
    if (unclassifiedAssets > 0.5) allocationItems.push({
        name: 'Activos sin desglose', value: unclassifiedAssets, color: '#64748b'
    });
    const allocationMismatch = categorizedAssets - totalAssets;

    const html = `
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Liquidez Disponible</span></div>
        <div class="stat-value">${fmtMoney(liquid)}</div>
        <div class="stat-sub">${pctOfAssets(liquid).toFixed(1)}% de activos · cuentas y efectivo${liquidityCoverageMonths === null ? (closedExpenseMonths.length ? ' · No se calcula cobertura: gasto promedio cero' : ' · Sin historial para calcular cobertura') : ` · Cubre ${liquidityCoverageMonths.toFixed(1)} meses al gasto promedio de ${closedExpenseMonths.length} meses cerrados`}</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Inversiones</span></div>
        <div class="stat-value">${fmtMoney(investments)}</div>
        <div class="stat-sub">${pctOfAssets(investments).toFixed(1)}% de activos</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Otros Activos</span></div>
        <div class="stat-value">${fmtMoney(otherAssets)}</div>
        <div class="stat-sub">${pctOfAssets(otherAssets).toFixed(1)}% de activos · puntos, millas y recompensas</div>
        </div>
        <div class="stat-card">
        <div class="stat-header"><span class="stat-label">Total Activos</span></div>
        <div class="stat-value">${fmtMoney(totalAssets)}</div>
        <div class="asset-change-summary">
            <span style="color:${monthlyChange === null ? '#64748b' : monthlyChange >= 0 ? '#4ade80' : '#f87171'}">Mensual: ${monthlyChange === null ? 'sin dato comparable' : `${monthlyChangePct === null ? '—' : `${monthlyChangePct >= 0 ? '+' : ''}${monthlyChangePct.toFixed(1)}%`} · ${monthlyChange >= 0 ? '+' : '−'}${fmtMoney(Math.abs(monthlyChange))} vs ${formatShortDate(previousAssetMonth.date)}`}</span>
            <span style="color:${annualChange === null ? '#64748b' : annualChange >= 0 ? '#4ade80' : '#f87171'}">Anual: ${annualChange === null ? 'sin dato comparable' : `${annualChangePct === null ? '—' : `${annualChangePct >= 0 ? '+' : ''}${annualChangePct.toFixed(1)}%`} · ${annualChange >= 0 ? '+' : '−'}${fmtMoney(Math.abs(annualChange))} vs ${formatShortDate(annualAssetMonth.date)}`}</span>
        </div>
        </div>
    `;
    document.getElementById('assetsStats').innerHTML = html;

    const allocationEl = document.getElementById('assetsDistribution');
    if (allocationEl) {
        allocationEl.innerHTML = `
            <div class="asset-allocation-list">${allocationItems.map(item => {
                const pct = pctOfAssets(item.value);
                return `<div class="asset-allocation-item">
                    <div class="asset-allocation-heading"><span><i style="background:${item.color}"></i>${item.name}</span><strong>${pct.toFixed(1)}%</strong></div>
                    <div class="asset-allocation-track"><div style="width:${Math.min(100, Math.max(0, pct))}%;background:${item.color}"></div></div>
                    <div class="asset-allocation-value">${fmtMoney(item.value)}</div>
                </div>`;
            }).join('')}</div>
            ${allocationMismatch > Math.max(1, totalAssets * 0.001) ? `<div class="asset-allocation-note">Las categorías detalladas exceden el total de activos por ${fmtMoney(allocationMismatch)}. Revisa posibles solapamientos en el origen de datos.</div>` : ''}
        `;
    }

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
    const totalPasivos = Number(s.pasivosTotal.current);
    const patrimonio = Number(s.patrimonioNeto.current);
    const activos = Number(s.activosTotales.current);
    const efectivo = Number(s.liquidoTotal.current);

    const limiteTarjetas = TARJETAS_NOMBRES.reduce((sum, n) => sum + getCreditLimit(n), 0);
    const limiteLineas   = LINEAS_NOMBRES.reduce((sum, n) => sum + getCreditLimit(n), 0);
    const limiteTotal    = limiteTarjetas + limiteLineas;

    const disponibleTotal = limiteTotal - deudaTarjetas - deudaLineas;
    const utilizacionPct  = limiteTotal > 0 ? ((deudaTarjetas + deudaLineas) / limiteTotal) * 100 : null;
    const deudaPatrimonio = patrimonio > 0 ? (totalPasivos / patrimonio) * 100 : null;
    const deudaActivos = activos > 0 ? (totalPasivos / activos) * 100 : null;
    const coberturaLiquida = totalPasivos > 0 ? efectivo / totalPasivos : null;
    const resumenTarjetas = document.getElementById('tarjetasResumen');
    const resumenLineas = document.getElementById('lineasResumen');
    const resumenPrestamos = document.getElementById('prestamosResumen');
    const fmtAvailable = value => value < 0 ? `Exceso ${fmtMoney(Math.abs(value))}` : `${fmtMoney(value)} disponible`;
    if (resumenTarjetas) resumenTarjetas.textContent = `Saldo ${fmtMoney(deudaTarjetas)} · ${formatCreditUtilization(deudaTarjetas, limiteTarjetas)} · ${fmtAvailable(limiteTarjetas - deudaTarjetas)}`;
    if (resumenLineas) resumenLineas.textContent = `Saldo ${fmtMoney(deudaLineas)} · ${formatCreditUtilization(deudaLineas, limiteLineas)} · ${fmtAvailable(limiteLineas - deudaLineas)}`;
    if (resumenPrestamos) resumenPrestamos.textContent = `Saldo pendiente total: ${fmtMoney(deudaPrestamos)}`;

    const liabilityAllocation = [
        { name: 'Tarjetas de crédito', value: deudaTarjetas, color: '#ef4444' },
        { name: 'Líneas de crédito', value: deudaLineas, color: '#f59e0b' },
        { name: 'Préstamos', value: deudaPrestamos, color: '#8b5cf6' }
    ];
    const detailedLiabilities = liabilityAllocation.reduce((sum, item) => sum + item.value, 0);
    const unclassifiedLiabilities = Math.max(0, totalPasivos - detailedLiabilities);
    if (unclassifiedLiabilities > 0.5) liabilityAllocation.push({
        name: 'Pasivos sin desglose', value: unclassifiedLiabilities, color: '#64748b'
    });
    const allocationEl = document.getElementById('liabilitiesDistribution');
    if (allocationEl) {
        allocationEl.innerHTML = `
            <div class="asset-allocation-list">${liabilityAllocation.map(item => {
                const pct = totalPasivos > 0 ? (item.value / totalPasivos) * 100 : 0;
                return `<div class="asset-allocation-item">
                    <div class="asset-allocation-heading"><span><i style="background:${item.color}"></i>${item.name}</span><strong>${pct.toFixed(1)}%</strong></div>
                    <div class="asset-allocation-track"><div style="width:${Math.min(100, Math.max(0, pct))}%;background:${item.color}"></div></div>
                    <div class="asset-allocation-value">${fmtMoney(item.value)}</div>
                </div>`;
            }).join('')}</div>
            ${detailedLiabilities - totalPasivos > Math.max(1, totalPasivos * 0.001) ? `<div class="asset-allocation-note">Las deudas detalladas exceden el total oficial de pasivos por ${fmtMoney(detailedLiabilities - totalPasivos)}. Revisa posibles solapamientos o cuentas duplicadas.</div>` : ''}
        `;
    }

    // ─── Stat Cards ───
    const html = `
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Total Pasivos</span></div>
            <div class="stat-value">${fmtMoney(totalPasivos)}</div>
            <div class="stat-sub">${tarjetas.length} tarjetas · ${lineas.length} líneas · ${prestamos.length} préstamos</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Utilización Crédito</span></div>
            <div class="stat-value">${utilizacionPct === null ? '—' : utilizacionPct.toFixed(1) + '%'}</div>
            <div class="stat-sub">${utilizacionPct === null ? 'No hay límites configurados' : `de ${fmtMoney(limiteTotal)} límite · ${disponibleTotal < 0 ? `exceso ${fmtMoney(Math.abs(disponibleTotal))}` : `${fmtMoney(disponibleTotal)} disponible`}`}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Ratio Deuda/Patrimonio</span></div>
            <div class="stat-value">${deudaPatrimonio === null ? '—' : deudaPatrimonio.toFixed(1) + '%'}</div>
            <div class="stat-sub">${patrimonio > 0 ? 'Pasivos ÷ patrimonio positivo' : patrimonio < 0 ? 'No interpretable: patrimonio negativo' : 'No interpretable: patrimonio cero'}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Líquido Cubre Deuda</span></div>
            <div class="stat-value">${coberturaLiquida === null ? '—' : coberturaLiquida.toFixed(1) + 'x'}</div>
            <div class="stat-sub">${totalPasivos > 0 ? 'Efectivo ÷ pasivos totales' : 'Sin pasivos; cobertura no aplica'}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Deuda / Activos</span></div>
            <div class="stat-value">${deudaActivos === null ? '—' : deudaActivos.toFixed(1) + '%'}</div>
            <div class="stat-sub">${activos > 0 ? 'Parte de los activos financiada con pasivos' : 'No interpretable: activos cero o negativos'}</div>
        </div>
    `;
    document.getElementById('liabilitiesStats').innerHTML = html;

    // ─── Renderizar Tarjetas de Crédito ───
    const tarjetasHtml = tarjetas
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            const change = getLiabilityMonthChange(data);
            const limite = getCreditLimit(name);
            const disponible = getDisponible(name, data);
            const util = getUtilizacion(name, data);
            const color = util > 90 ? '#ef4444' : util > 70 ? '#f59e0b' : '#22c55e';
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:${color}20;color:${color}">💳</div>
                    <div class="liability-info">
                    <div class="liability-name">${name}</div>
                    <div class="liability-meta" style="color:${change.color}">${change.label}</div>
                    <div class="liability-meta">Límite ${fmtMoney(limite)} · Utilizado ${util === null ? '—' : util.toFixed(1) + '%'}${util > 100 ? ' · Sobre el límite' : ''}</div>
                        <div class="liability-progress-track">
                            <div class="liability-progress-fill" style="width:${Math.min(100, Math.max(0, util || 0))}%;background:${color}"></div>
                        </div>
                    </div>
                    <div class="liability-value">
                    <div class="liability-amount" style="color:${deuda > 0 ? '#f87171' : '#4ade80'}">${fmtMoney(deuda)}</div>
                        <div class="liability-sub">${disponible < 0 ? `Exceso ${fmtMoney(Math.abs(disponible))}` : `${fmtMoney(disponible)} disp.`}</div>
                    </div>
                </div>
            `;
        }).join('');
    document.getElementById('creditCardsList').innerHTML = tarjetasHtml ? 
        `<div class="liability-list">${tarjetasHtml}</div>` : 
        '<div style="color:#64748b;padding:20px;text-align:center;">No hay tarjetas registradas.</div>';

    // ─── Renderizar Líneas de Crédito ───
    const lineasHtml = lineas
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            const change = getLiabilityMonthChange(data);
            const limite = getCreditLimit(name);
            const disponible = getDisponible(name, data);
            const util = getUtilizacion(name, data);
            const color = util > 90 ? '#ef4444' : util > 70 ? '#f59e0b' : '#22c55e';
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:${color}20;color:${color}">📈</div>
                    <div class="liability-info">
                    <div class="liability-name">${name}</div>
                    <div class="liability-meta" style="color:${change.color}">${change.label}</div>
                    <div class="liability-meta">Límite ${fmtMoney(limite)} · Utilizado ${util === null ? '—' : util.toFixed(1) + '%'}${util > 100 ? ' · Sobre el límite' : ''}</div>
                        <div class="liability-progress-track">
                            <div class="liability-progress-fill" style="width:${Math.min(100, Math.max(0, util || 0))}%;background:${color}"></div>
                        </div>
                    </div>
                    <div class="liability-value">
                        <div class="liability-amount" style="color:${deuda > 0 ? '#f87171' : '#4ade80'}">${fmtMoney(deuda)}</div>
                        <div class="liability-sub">${disponible < 0 ? `Exceso ${fmtMoney(Math.abs(disponible))}` : `${fmtMoney(disponible)} disp.`}</div>
                    </div>
                </div>
            `;
        }).join('');
    document.getElementById('lineasCreditoList').innerHTML = lineasHtml ? 
        `<div class="liability-list">${lineasHtml}</div>` : 
        '<div style="color:#64748b;padding:20px;text-align:center;">No hay líneas de crédito registradas.</div>';

    // ─── Renderizar Préstamos ───
    const prestamosHtml = prestamos
        .sort((a, b) => getDeuda(b.data) - getDeuda(a.data))
        .map(({name, data}) => {
            const deuda = getDeuda(data);
            const change = getLiabilityMonthChange(data);
            return `
                <div class="liability-item" onclick="openCreditModal('${name}')" style="cursor:pointer">
                    <div class="liability-icon-wrap" style="background:#8b5cf620;color:#8b5cf6">🏦</div>
                    <div class="liability-info">
                        <div class="liability-name">${name}</div>
                        <div class="liability-meta" style="color:${change.color}">${change.label}</div>
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

    populateLiabilityTrendSelector();
    renderLiabilityTrendChart();
}

function populateLiabilityTrendSelector() {
    const select = document.getElementById('liabilityTrendSelect');
    if (!select) return;
    const names = [...TARJETAS_NOMBRES, ...LINEAS_NOMBRES, ...PRESTAMOS_NOMBRES];
    const selected = select.value;
    const currentHighest = names.slice().sort((a, b) =>
        getDeuda(appData.creditos?.[b]) - getDeuda(appData.creditos?.[a])
    )[0];
    select.innerHTML = names.map(name => `<option value="${name}">${name}</option>`).join('');
    select.value = names.includes(selected) ? selected : currentHighest;
}

function renderLiabilityTrendChart() {
    const ctx = getCanvas('liabilityTrendChart');
    if (!ctx) return;
    if (charts.liabilityTrend) {
        charts.liabilityTrend.destroy();
        delete charts.liabilityTrend;
    }

    const select = document.getElementById('liabilityTrendSelect');
    const creditName = select?.value;
    if (!creditName) return;
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    const monthKeys = Array.from({ length: 6 }, (_, offset) => {
        const date = new Date(currentYear, currentMonth - (5 - offset), 1);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    });
    const credit = appData.creditos?.[creditName];
    const monthlyValues = new Map((credit?.history || []).map(item => [
        getExpenseMonthKey(item.isoDate || item.date), getDeuda({ current: Number(item.value) || 0 })
    ]).filter(([monthKey]) => monthKey));
    const observedValues = monthKeys.map(monthKey => monthlyValues.has(monthKey) ? monthlyValues.get(monthKey) : null);
    const available = observedValues.filter(value => value !== null);
    const average = available.length
        ? available.reduce((sum, value) => sum + value, 0) / available.length
        : null;
    const summary = document.getElementById('liabilityTrendSummary');
    if (summary) {
        summary.textContent = average === null
            ? `${creditName} · No hay saldos registrados en los últimos seis meses.`
            : `${creditName} · Promedio de saldo: ${fmtMoney(average)} (${available.length} de 6 meses con datos).`;
    }

    charts.liabilityTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: monthKeys.map(formatExpenseMonth),
            datasets: [
                {
                    label: 'Saldo al cierre del mes',
                    data: observedValues,
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239,68,68,0.12)',
                    fill: true,
                    tension: 0.25,
                    spanGaps: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Promedio de saldo (meses disponibles)',
                    data: average === null ? monthKeys.map(() => null) : monthKeys.map(() => average),
                    borderColor: '#f59e0b',
                    borderDash: [6, 4],
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { position: 'top', align: 'end', labels: { color: '#94a3b8', usePointStyle: true } },
                tooltip: {
                    callbacks: {
                        label: context => context.parsed.y === null ? null : `${context.dataset.label}: ${fmtMoney(context.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 0 } },
                y: { beginAtZero: true, grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', callback: value => fmtMoney(value) } }
            }
        }
    });
}

    // === RENDER INCOME ===
    function renderIncome() {
    populateIncomeMonthSelector();
    const selectedLabel = formatExpenseMonth(incomeSelectedMonthKey);
    if (!gastosData && !incomeDbGastosLoading) {
        incomeDbGastosLoading = true;
        loadGastosData().then(() => {
            incomeDbGastosLoading = false;
            populateIncomeMonthSelector();
            renderIncome();
            if (charts.income) { charts.income.destroy(); delete charts.income; }
            renderIncomeChart();
        }).catch(error => {
            incomeDbGastosLoading = false;
            console.warn('No se pudo cargar DB_GASTOS para ingresos:', error);
        });
    }

    const budgetGroups = getIncomeBudgetRowsByCategory(incomeSelectedMonthKey);
    const sourceMonth = getDbGastosMonthlyCategoryValues(incomeSelectedMonthKey, 'ingresos');
    const lineMap = new Map();
    budgetGroups.forEach(group => {
        const key = normalizeIncomeCategoryName(group.name);
        lineMap.set(key, {
            name: group.name,
            budget: group.total,
            actual: group.rows.reduce((sum, row) => sum + (Number(row.gastoReal) || 0), 0),
            row: group.representativeRow,
            hasBudget: true
        });
    });

    if (sourceMonth) {
        sourceMonth.categories.forEach(category => {
            const key = normalizeIncomeCategoryName(category.name);
            const line = lineMap.get(key) || { name: category.name, budget: null, actual: 0, row: null, hasBudget: false };
            line.actual = category.value;
            lineMap.set(key, line);
        });
    } else {
        Object.entries(appData.ingresos || {}).forEach(([name, series]) => {
            const value = getExpenseHistoryValue(series, incomeSelectedMonthKey);
            if (value === null) return;
            const key = normalizeIncomeCategoryName(name);
            const line = lineMap.get(key) || { name, budget: null, actual: 0, row: null, hasBudget: false };
            line.actual = value;
            lineMap.set(key, line);
        });
    }

    const passiveNames = new Set(['Inversiones', 'Intereses, dividendos', 'Otros ingresos'].map(normalizeIncomeCategoryName));
    const passiveIds = new Set(['23']);
    const incomeLines = [...lineMap.values()].map(line => ({
        ...line,
        isPassive: passiveNames.has(normalizeIncomeCategoryName(line.name)) ||
            passiveIds.has(String(line.row?.id || '').replace(/^P/i, ''))
    })).sort((a, b) => b.actual - a.actual);
    const totalReal = sourceMonth
        ? sourceMonth.total
        : (incomeLines.length ? incomeLines.reduce((sum, line) => sum + line.actual, 0) :
            (getExpenseHistoryValue(appData.summary.ingresosNetos, incomeSelectedMonthKey) ?? 0));
    const totalBudget = budgetGroups.reduce((sum, group) => sum + group.total, 0);
    const totalRealPassive = incomeLines.filter(line => line.isPassive).reduce((sum, line) => sum + line.actual, 0);
    const totalRealActive = Math.max(0, totalReal - totalRealPassive);
    const passivePct = totalReal > 0 ? (totalRealPassive / totalReal) * 100 : 0;

    document.getElementById('incomeStats').innerHTML = `
        <div class="stat-card"><div class="stat-header"><span class="stat-label">Ingreso Activo · ${selectedLabel}</span></div><div class="stat-value" style="color:#3b82f6">${fmtMoney(totalRealActive)}</div><div class="stat-sub">Fuentes laborales y operativas</div></div>
        <div class="stat-card"><div class="stat-header"><span class="stat-label">Ingreso Pasivo</span></div><div class="stat-value" style="color:#8b5cf6">${fmtMoney(totalRealPassive)}</div><div class="stat-sub">${passivePct.toFixed(1)}% del ingreso total</div></div>
        <div class="stat-card"><div class="stat-header"><span class="stat-label">Total Ingresos</span></div><div class="stat-value" style="color:#4ade80">${fmtMoney(totalReal)}</div><div class="stat-sub">${totalBudget > 0 ? `${fmtMoney(Math.max(0, totalBudget - totalReal))} por recibir de la meta` : sourceMonth ? 'Cierre mensual desde DB_GASTOS' : 'Sin meta presupuestaria para este mes'}</div></div>
        <div class="stat-card"><div class="stat-header"><span class="stat-label">Meta Mensual</span></div><div class="stat-value">${totalBudget > 0 ? fmtMoney(totalBudget) : '—'}</div><div class="stat-sub">${totalBudget > 0 ? `${(totalReal / totalBudget * 100).toFixed(1)}% alcanzado` : 'Sin presupuesto registrado'}</div></div>
    `;

    const html = incomeLines.map((line, index) => {
        const hasBudget = line.hasBudget && line.budget > 0;
        const pct = hasBudget ? (line.actual / line.budget) * 100 : null;
        const color = line.isPassive ? '#8b5cf6' : '#22c55e';
        const chartId = `incomeProjChart_${index}`;
        const detailId = `incomeCategoryDetail_${index}`;
        const safeName = escapeExpenseHtml(line.name);
        return `
            <div class="income-card expense-category-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="${detailId}"
                 onclick="toggleIncomeCategoryDetail(${index})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleIncomeCategoryDetail(${index})}"
                 style="border-left:3px solid ${color}">
                <div class="income-icon" style="background:${color}20;color:${color}">${line.isPassive ? '📈' : '💵'}</div>
                <div class="income-main">
                    <div class="income-header"><div class="income-name">${safeName}</div><div style="display:flex;align-items:center;gap:10px"><span class="expense-detail-hint">Ver detalle⌄</span><div class="income-pct" style="color:${color}">${pct === null ? '—' : `${pct.toFixed(1)}%`}</div></div></div>
                    <div class="income-meta">${hasBudget ? `${fmtMoney(line.actual)} / ${fmtMoney(line.budget)} · ${Math.max(0, line.budget - line.actual) > 0 ? `${fmtMoney(line.budget - line.actual)} para alcanzar la meta` : 'Meta alcanzada'}` : `${fmtMoney(line.actual)} · sin meta asignada`}</div>
                    ${hasBudget ? `<div class="income-bar-track"><div style="width:${Math.min(pct, 100)}%;height:100%;background:${color}"></div><div style="width:${Math.max(0, 100 - Math.min(pct, 100))}%;height:100%;background:rgba(51,65,85,0.3)"></div></div>` : ''}
                </div>
            </div>
            <div class="expense-category-detail" id="${detailId}" hidden></div>
            ${(line.actual > 0 || hasBudget) ? `<div class="expense-projection" data-proj-chart-id="${chartId}" style="display:none;padding:14px 16px;background:rgba(15,23,42,0.55);border:1px solid rgba(51,65,85,0.2);border-top:none;border-radius:0 0 12px 12px;margin-top:-10px;margin-bottom:10px;"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">📊 Comparación mensual · ${safeName}</div><div class="chart-container" id="${chartId}" style="height:240px;"></div></div>` : ''}
        `;
    }).join('');
    const container = document.getElementById('incomeCategoriesList');
    container.innerHTML = incomeLines.length
        ? `<div class="asset-list">${html}</div>`
        : '<div class="modeco-empty-state">No hay ingresos ni categorías para este mes.</div>';
    setTimeout(() => loadIncomeCategoryComparisons(incomeLines, incomeSelectedMonthKey), 50);
}


    // === RENDER EXPENSES ===

    function getExpenseMonthKey(value) {
        if (!value) return '';
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
        }

        const text = String(value).trim();
        let match = text.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
        if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}`;

        // DB_PRESUPUESTO serializa sus fechas como M/D/YYYY.
        match = text.match(/^(\d{1,2})\/\d{1,2}\/((?:19|20)\d{2})$/);
        if (match) return `${match[2]}-${String(Number(match[1])).padStart(2, '0')}`;

        // Los historiales también pueden venir como "Jun'26".
        match = text.match(/^([A-Za-z]{3})'?([0-9]{2}|[0-9]{4})$/);
        if (match) {
            const monthIndex = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]);
            if (monthIndex >= 0) {
                const year = match[2].length === 2 ? `20${match[2]}` : match[2];
                return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
            }
        }

        const parsed = new Date(text);
        if (!Number.isNaN(parsed.getTime())) {
            return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
        }
        return '';
    }

    function formatExpenseMonth(monthKey) {
        const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
        if (!match) return 'Período';
        const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
        const label = date.toLocaleDateString('es-DO', { month: 'long', year: 'numeric' });
        return label.charAt(0).toUpperCase() + label.slice(1);
    }

    function getExpenseHistoryValue(series, monthKey) {
        if (!series?.history) return null;
        const item = series.history.find(entry =>
            getExpenseMonthKey(entry.isoDate || entry.date) === monthKey
        );
        return item ? (Number(item.value) || 0) : null;
    }

    function normalizeExpenseCategoryName(value) {
        return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    const DB_GASTOS_PRIMARY_CATEGORIES = [
        'Comida', 'Compras', 'Transporte', 'Servicios', 'Gastos financieros',
        'Otros', 'Donativos', 'Educacion', 'Entretenimiento', 'Ahorros', 'Inversión'
    ];
    const DB_GASTOS_PRIMARY_INCOME_CATEGORIES = [
        'Trabajo', 'Clases de Música', 'Eventos', 'Iglesias', 'Developer',
        'Cheques, cupones', 'Regalos', 'Puntos', 'Intereses, dividendos', 'Inversiones', 'Otros ingresos'
    ];

    function normalizeIncomeCategoryName(value) {
        const key = normalizeExpenseCategoryName(value);
        if (key === 'investment') return normalizeExpenseCategoryName('Inversiones');
        const direct = DB_GASTOS_PRIMARY_INCOME_CATEGORIES.find(name => normalizeExpenseCategoryName(name) === key);
        if (direct) return normalizeExpenseCategoryName(direct);
        const mapped = normalizeExpenseCategoryName(getCatMeta(value).etiqueta);
        if (mapped === 'investment') return normalizeExpenseCategoryName('Inversiones');
        const byLabel = DB_GASTOS_PRIMARY_INCOME_CATEGORIES.find(name => normalizeExpenseCategoryName(name) === mapped);
        return normalizeExpenseCategoryName(byLabel || value);
    }

    function getIncomeBudgetRowsByCategory(monthKey) {
        const categoriesById = new Map((appData?.categorias || []).map(category => [
            String(category.id).trim(), category
        ]));
        const groups = new Map();
        (appData?.presupuesto || []).filter(row =>
            row.tipo === 'Ingresos' && getExpenseMonthKey(row.mesAno) === monthKey
        ).forEach(row => {
            const category = categoriesById.get(String(row.idCategoria).trim());
            const rawName = category?.etiqueta || category?.nombre || `Categoría ${row.idCategoria}`;
            const canonicalName = DB_GASTOS_PRIMARY_INCOME_CATEGORIES.find(name =>
                normalizeExpenseCategoryName(name) === normalizeIncomeCategoryName(rawName)
            ) || rawName;
            const key = normalizeIncomeCategoryName(canonicalName);
            if (!groups.has(key)) groups.set(key, { name: canonicalName, rows: [] });
            groups.get(key).rows.push({ row, category });
        });

        return [...groups.values()].map(group => {
            const primaryRows = group.rows.filter(item => !item.category?.padre);
            const keepAllRows = normalizeIncomeCategoryName(group.name) === normalizeIncomeCategoryName('Inversiones');
            const selectedRows = keepAllRows || primaryRows.length === 0
                ? group.rows
                : primaryRows;
            return {
                name: group.name,
                rows: selectedRows.map(item => item.row),
                total: selectedRows.reduce((sum, item) => sum + (Number(item.row.montoPresupuestado) || 0), 0),
                representativeRow: selectedRows[0]?.row || null
            };
        });
    }

    function getDbGastosMonthlyCategoryValues(monthKey, kind = 'gastos') {
        const monthData = (gastosData?.meses || []).find(month =>
            getExpenseMonthKey(month.isoDate || month.mes) === monthKey
        );
        if (!monthData?.valores) return null;
        const categoryNames = kind === 'ingresos'
            ? DB_GASTOS_PRIMARY_INCOME_CATEGORIES
            : DB_GASTOS_PRIMARY_CATEGORIES;
        const valuesByName = new Map(Object.entries(monthData.valores).map(([name, value]) => [
            normalizeExpenseCategoryName(name), Number(value) || 0
        ]));
        const categories = categoryNames.map(name => ({
            name,
            value: valuesByName.get(normalizeExpenseCategoryName(name)) ?? 0
        }));
        return { total: categories.reduce((sum, category) => sum + category.value, 0), categories };
    }

    function getDbGastosMonthlyTotals(monthKey) {
        return getDbGastosMonthlyCategoryValues(monthKey, 'gastos');
    }

    function getExpenseMonthKeys() {
        const keys = new Set();
        const add = value => {
            const key = getExpenseMonthKey(value);
            if (key) keys.add(key);
        };
        (appData?.presupuesto || []).filter(p => p.tipo === 'Gastos').forEach(p => add(p.mesAno));
        (appData?.summary?.gastosTotal?.history || []).forEach(item => add(item.isoDate || item.date));
        Object.values(appData?.gastos || {}).forEach(category =>
            (category.history || []).forEach(item => add(item.isoDate || item.date))
        );
        (gastosData?.meses || []).forEach(month => add(month.isoDate || month.mes));

        // Permitir consultar también meses recientes aunque aún no tengan presupuesto cargado.
        const now = new Date();
        for (let offset = 0; offset < 24; offset++) {
            const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
            keys.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
        }
        return [...keys].sort((a, b) => b.localeCompare(a));
    }

    function populateExpensesMonthSelector() {
        const select = document.getElementById('expensesMonthSelect');
        if (!select) return;
        const monthKeys = getExpenseMonthKeys();
        const now = new Date();
        const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (!monthKeys.includes(expensesSelectedMonthKey)) {
            expensesSelectedMonthKey = monthKeys.includes(currentKey) ? currentKey : (monthKeys[0] || '');
        }
        select.replaceChildren();
        monthKeys.forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = formatExpenseMonth(key);
            option.selected = key === expensesSelectedMonthKey;
            select.appendChild(option);
        });
    }

    function getIncomeMonthKeys() {
        const keys = new Set();
        const add = value => {
            const key = getExpenseMonthKey(value);
            if (key) keys.add(key);
        };
        (appData?.presupuesto || []).filter(row => row.tipo === 'Ingresos').forEach(row => add(row.mesAno));
        (appData?.summary?.ingresosNetos?.history || []).forEach(item => add(item.isoDate || item.date));
        Object.values(appData?.ingresos || {}).forEach(category =>
            (category.history || []).forEach(item => add(item.isoDate || item.date))
        );
        (gastosData?.meses || []).forEach(month => add(month.isoDate || month.mes));
        const now = new Date();
        for (let offset = 0; offset < 24; offset++) {
            const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
            keys.add(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
        }
        return [...keys].sort((a, b) => b.localeCompare(a));
    }

    function populateIncomeMonthSelector() {
        const select = document.getElementById('incomeMonthSelect');
        if (!select) return;
        const monthKeys = getIncomeMonthKeys();
        const currentKey = getExpenseMonthKey(new Date());
        if (!monthKeys.includes(incomeSelectedMonthKey)) {
            incomeSelectedMonthKey = monthKeys.includes(currentKey) ? currentKey : (monthKeys[0] || '');
        }
        select.replaceChildren();
        monthKeys.forEach(key => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = formatExpenseMonth(key);
            option.selected = key === incomeSelectedMonthKey;
            select.appendChild(option);
        });
    }

    function onIncomeMonthChange(monthKey) {
        if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
        incomeSelectedMonthKey = monthKey;
        renderIncome();
        renderDailySupabase('ingresos');
        if (charts.income) { charts.income.destroy(); delete charts.income; }
        renderIncomeChart();
    }

    function onExpensesMonthChange(monthKey) {
        if (!/^\d{4}-\d{2}$/.test(monthKey)) return;
        expensesSelectedMonthKey = monthKey;
        renderExpenses();
        renderDailySupabase('gastos');
        ['expenses', 'expensesPie'].forEach(key => {
            if (charts[key]) {
                charts[key].destroy();
                delete charts[key];
            }
        });
        renderExpensesChart();
        renderExpensesPieChart();
    }

    function clearExpenseProjectionCharts() {
        Object.keys(charts).filter(key => key.startsWith('expenseProjChart_')).forEach(key => {
            charts[key].destroy();
            delete charts[key];
        });
    }

    function renderExpenses() {
    populateExpensesMonthSelector();
    const presupuesto = appData.presupuesto || [];
    const categorias = appData.categorias || [];
    const selectedMonthLabel = formatExpenseMonth(expensesSelectedMonthKey);
    const selectedMonthIsCurrent = expensesSelectedMonthKey === getExpenseMonthKey(new Date());
    const isClosedMonth = expensesSelectedMonthKey < getExpenseMonthKey(new Date());

    if (!gastosData && !expenseDbGastosLoading) {
        expenseDbGastosLoading = true;
        loadGastosData().then(() => {
            expenseDbGastosLoading = false;
            if (expensesSelectedMonthKey) {
                populateExpensesMonthSelector();
                renderExpenses();
                renderExpensesPieChart();
            }
        }).catch(error => {
            expenseDbGastosLoading = false;
            console.warn('No se pudo cargar DB_GASTOS para el cierre mensual:', error);
        });
    }

    // Mostrar solo las líneas de presupuesto del mes elegido; nunca mezclar meses como respaldo.
    const gastosMostrar = presupuesto.filter(p =>
        p.tipo === 'Gastos' && getExpenseMonthKey(p.mesAno) === expensesSelectedMonthKey
    );
    const historicalBudget = getExpenseHistoryValue(appData.summary.presupuesto, expensesSelectedMonthKey);
    const historicalActual = getExpenseHistoryValue(appData.summary.gastosTotal, expensesSelectedMonthKey);
    const dbGastosTotals = getDbGastosMonthlyTotals(expensesSelectedMonthKey);
    const hasActualForMonth = (isClosedMonth && dbGastosTotals !== null) || gastosMostrar.length > 0 || historicalActual !== null;

    // Si DB_PRESUPUESTO no tiene filas históricas, usar las series mensuales del balance.
    const totalPresupuestado = gastosMostrar.length
        ? gastosMostrar.reduce((sum, row) => sum + (Number(row.montoPresupuestado) || 0), 0)
        : (historicalBudget ?? 0);
    const totalReal = gastosMostrar.length
        ? gastosMostrar.reduce((sum, row) => sum + (Number(row.gastoReal) || 0), 0)
        : (historicalActual ?? 0);
    const finalizedExpenseTotal = isClosedMonth && dbGastosTotals !== null
        ? dbGastosTotals.total
        : totalReal;
    const hasBudgetForMonth = isClosedMonth ? hasActualForMonth : (gastosMostrar.length > 0 || (historicalBudget !== null && historicalBudget > 0));
    const displayedActual = isClosedMonth ? finalizedExpenseTotal : totalReal;
    const budgetReference = isClosedMonth ? finalizedExpenseTotal : totalPresupuestado;
    const totalDiferencia = budgetReference - displayedActual;
    const pctConsumido = budgetReference > 0 ? (displayedActual / budgetReference) * 100 : 0;
    const enRiesgo = gastosMostrar.filter(p => p.mensaje && p.mensaje.includes('Riesgo')).length;
    const excedidos = gastosMostrar.filter(p => p.mensaje && p.mensaje.includes('sobrepasado')).length;
    
    // Cards de resumen
    const html = `
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">${isClosedMonth ? 'Gasto final ·' : 'Presupuesto ·'} ${selectedMonthLabel}</span></div>
            <div id="expensesBudgetValue" class="stat-value">${hasBudgetForMonth ? fmtMoney(budgetReference) : '—'}</div>
            <div id="expensesBudgetSub" class="stat-sub">${!hasBudgetForMonth ? (isClosedMonth ? 'Sin gasto registrado para este mes' : 'Sin presupuesto registrado para este mes') : isClosedMonth ? 'Mes cerrado · referencia igual al gasto final' : hasActualForMonth ? `${pctConsumido.toFixed(1)}% consumido` : 'Sin gastos registrados para este mes'}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Gasto Real · ${selectedMonthLabel}</span></div>
            <div id="expensesActualValue" class="stat-value" style="color:${hasBudgetForMonth && hasActualForMonth ? (pctConsumido > 100 ? '#f87171' : pctConsumido > 80 ? '#f59e0b' : '#4ade80') : hasActualForMonth ? '#e2e8f0' : '#94a3b8'}">${hasActualForMonth ? fmtMoney(displayedActual) : '—'}</div>
            <div id="expensesActualSub" class="stat-sub">${hasBudgetForMonth && hasActualForMonth ? (isClosedMonth ? 'Total final según DB_Gastos · 11 categorías principales' : `${fmtMoney(Math.abs(totalDiferencia))} ${totalDiferencia >= 0 ? 'restante' : 'excedido'}`) : (hasActualForMonth ? 'Gasto histórico del balance' : 'Esperando datos del mes seleccionado')}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">En Riesgo</span></div>
            <div class="stat-value" style="color:${enRiesgo > 0 ? '#f59e0b' : '#4ade80'}">${enRiesgo}</div>
        <div class="stat-sub">de ${gastosMostrar.length} categorías · ${selectedMonthLabel}</div>
        </div>
        <div class="stat-card">
            <div class="stat-header"><span class="stat-label">Excedidas</span></div>
            <div class="stat-value" style="color:${excedidos > 0 ? '#f87171' : '#4ade80'}">${excedidos}</div>
        <div class="stat-sub">categorías sobrepasadas · ${selectedMonthLabel}</div>
        </div>
    `;
    document.getElementById('expensesStats').innerHTML = html;
    
    // Lista de categorías
    clearExpenseProjectionCharts();
    const categoriaPorId = new Map(categorias.map(category => [String(category.id), category]));
    const linesByCategory = new Map();
    gastosMostrar.forEach(row => {
        const category = categoriaPorId.get(String(row.idCategoria));
        const name = category?.etiqueta || `Categoría ${row.idCategoria}`;
        const key = normalizeExpenseCategoryName(name);
        linesByCategory.set(key, { name, budgetRow: row, historyValue: null });
    });
    Object.entries(appData.gastos || {}).forEach(([name, series]) => {
        const value = getExpenseHistoryValue(series, expensesSelectedMonthKey);
        if (value === null || value === 0) return;
        const key = normalizeExpenseCategoryName(name);
        const existing = linesByCategory.get(key);
        if (existing) existing.historyValue = value;
        else linesByCategory.set(key, { name, budgetRow: null, historyValue: value });
    });
    if (isClosedMonth && dbGastosTotals) {
        dbGastosTotals.categories.forEach(category => {
            const key = normalizeExpenseCategoryName(category.name);
            const existing = linesByCategory.get(key);
            if (existing) existing.historyValue = category.value;
            else linesByCategory.set(key, { name: category.name, budgetRow: null, historyValue: category.value });
        });
    }

    const expenseLines = [...linesByCategory.values()].map(line => {
        const row = line.budgetRow;
        return {
            ...row,
            name: line.name,
            gastoReal: line.historyValue !== null ? line.historyValue : (Number(row?.gastoReal) || 0),
            hasCategoryBudget: isClosedMonth ? ((line.historyValue ?? Number(row?.gastoReal) ?? 0) > 0) : !!row,
            montoPresupuestado: isClosedMonth
                ? (line.historyValue !== null ? line.historyValue : (Number(row?.gastoReal) || 0))
                : (row ? (Number(row.montoPresupuestado) || 0) : null),
            gastoAnthony: Number(row?.gastoAnthony) || 0,
            gastoEmely: Number(row?.gastoEmely) || 0,
            particion: row?.particion || ''
        };
    }).sort((a, b) => b.gastoReal - a.gastoReal);

    const expenseList = expenseLines.map((p, idx) => {
        const hasCategoryBudget = p.hasCategoryBudget && p.montoPresupuestado > 0;
        const pct = hasCategoryBudget ? (p.gastoReal / p.montoPresupuestado) * 100 : 0;
        const color = !hasCategoryBudget ? '#64748b' : pct > 100 ? '#ef4444' : pct > 80 ? '#f59e0b' : '#22c55e';
        const icon = !hasCategoryBudget ? '•' : pct > 100 ? '⚠️' : pct > 80 ? '⚡' : '✅';

        const anthonyPct = hasCategoryBudget ? (p.gastoAnthony / p.montoPresupuestado) * 100 : 0;
        const emelyPct = hasCategoryBudget ? (p.gastoEmely / p.montoPresupuestado) * 100 : 0;
        const remainingPct = hasCategoryBudget ? Math.max(0, 100 - anthonyPct - emelyPct) : 0;

        const chartId = `expenseProjChart_${idx}`;
        const monthInfo = !hasCategoryBudget
          ? 'Sin presupuesto para esta categoría'
          : selectedMonthIsCurrent
            ? `${p.diasRestantes} días restantes · ${fmtMoney(p.recomendacionDiaria)}/día`
            : 'Mes cerrado · gasto final usado como referencia';

        return `
            <div class="expense-card expense-category-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="expenseCategoryDetail_${idx}"
                 onclick="toggleExpenseCategoryDetail(${idx})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleExpenseCategoryDetail(${idx})}"
                 style="border-left: 3px solid ${color}">
                <div class="expense-icon" style="background:${color}20;color:${color}">${icon}</div>
                <div class="expense-main">
                    <div class="expense-header">
                        <div class="expense-name">${p.name}</div>
                        <div style="display:flex;align-items:center;gap:10px"><span class="expense-detail-hint">Ver detalle⌄</span><div class="expense-pct" style="color:${color}">${hasCategoryBudget ? `${pct.toFixed(1)}%` : '—'}</div></div>
                    </div>
                    <div class="expense-meta">
                        ${hasCategoryBudget ? `${fmtMoney(p.gastoReal)} / ${fmtMoney(p.montoPresupuestado)}` : `${fmtMoney(p.gastoReal)} · sin presupuesto`} · ${monthInfo}
                    </div>
                    ${hasCategoryBudget ? `<div class="expense-bar-track">
                        <div class="expense-bar-anthony" style="width:${anthonyPct}%"></div>
                        <div class="expense-bar-emely" style="width:${emelyPct}%"></div>
                        <div class="expense-bar-remaining" style="width:${remainingPct}%"></div>
                    </div>` : ''}
                </div>
            </div>
            <div class="expense-category-detail" id="expenseCategoryDetail_${idx}" hidden></div>
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
            <!-- ← NUEVO: contenedor de proyección -->
            ${(selectedMonthIsCurrent && hasCategoryBudget || isClosedMonth && p.gastoReal > 0) ? `<div class="expense-projection" data-proj-chart-id="${chartId}"
                 style="display:none;padding:14px 16px;background:rgba(15,23,42,0.55);
                        border:1px solid rgba(51,65,85,0.2);border-top:none;
                        border-radius:0 0 12px 12px;margin-top:-10px;margin-bottom:10px;">
                <div style="font-size:11px;font-weight:700;color:#64748b;
                            text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">
                    📊 Comparación mensual · ${p.name}
                </div>
                <div class="chart-container" id="${chartId}" style="height:240px;"></div>
            </div>` : ''}
        `;
    }).join('');
    
    document.getElementById('expenseCategoriesList').innerHTML = expenseLines.length
        ? `<div class="asset-list">${expenseList}</div>`
        : '<div class="modeco-empty-state">No hay gastos ni categorías para este mes. El detalle diario muestra las transacciones disponibles cuando existan.</div>';
    // ← NUEVO: dispara la carga async de proyecciones
    if (expenseLines.length) {
        setTimeout(() => loadExpenseProjections(expenseLines, expensesSelectedMonthKey), 50);
    }
}


    function renderAnalytics() {
      const sourceStatus = document.getElementById('analyticsSourceStatus');
      if (!gastosData) {
          if (sourceStatus) sourceStatus.textContent = 'Cargando históricos mensuales de DB_GASTOS…';
          if (!analyticsDbGastosLoading) {
              analyticsDbGastosLoading = true;
              loadGastosData().then(() => {
                  analyticsDbGastosLoading = false;
                  renderAnalytics();
                  if (document.getElementById('analytics')?.classList.contains('active')) {
                      ['growthRate', 'invGrowthRate', 'incVsExp', 'projection'].forEach(key => {
                          if (charts[key]) { charts[key].destroy(); delete charts[key]; }
                      });
                      renderChartsForTab('analytics');
                  }
              }).catch(error => {
                  analyticsDbGastosLoading = false;
                  if (sourceStatus) sourceStatus.textContent = 'No se pudo cargar DB_GASTOS; el análisis histórico no está disponible.';
                  console.warn('No se pudo cargar el histórico para Análisis:', error);
              });
          }
      } else if (sourceStatus) {
          sourceStatus.textContent = 'Flujos mensuales desde DB_GASTOS · patrimonio desde el balance.';
      }

      const s = appData.summary;
      const currentMonthKey = getExpenseMonthKey(new Date());
      const closedMonths = (gastosData?.meses || []).map(month => ({
          monthKey: getExpenseMonthKey(month.isoDate || month.mes),
          totals: getDbGastosFinancialTotals(month),
          month: month
      })).filter(item => item.monthKey && item.monthKey < currentMonthKey &&
          Number.isFinite(item.totals?.income) && Number.isFinite(item.totals?.expenses))
        .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
        .slice(-12);
      const monthCount = closedMonths.length;
      const incomeTotal = closedMonths.reduce((sum, item) => sum + item.totals.income, 0);
      const expenseTotal = closedMonths.reduce((sum, item) => sum + item.totals.expenses, 0);
      const averageIncome = monthCount ? incomeTotal / monthCount : null;
      const averageSavings = monthCount ? (incomeTotal - expenseTotal) / monthCount : null;
      const savingsRate = incomeTotal > 0 ? ((incomeTotal - expenseTotal) / incomeTotal) * 100 : null;
      const workIncomeTotal = closedMonths.reduce((sum, item) => {
          const values = item.month.valores || {};
          const workKey = Object.keys(values).find(name => normalizeExpenseCategoryName(name) === normalizeExpenseCategoryName('Trabajo'));
          return sum + (workKey ? (Number(values[workKey]) || 0) : 0);
      }, 0);
      const workContribution = incomeTotal > 0 ? (workIncomeTotal / incomeTotal) * 100 : null;
      const otherIncome = incomeTotal - workIncomeTotal;

      const patrimonyHistory = (s.patrimonioNeto.history || []).map(item => ({
          monthKey: getExpenseMonthKey(item.isoDate || item.date),
          date: item.isoDate || item.date,
          value: Number(item.value)
      })).filter(item => item.monthKey && Number.isFinite(item.value)).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
      const positivePatrimony = patrimonyHistory.filter(item => item.value > 0);
      const firstPatrimony = positivePatrimony[0];
      const lastPatrimony = positivePatrimony[positivePatrimony.length - 1];
      let cagr = null;
      let elapsedMonths = 0;
      if (firstPatrimony && lastPatrimony && firstPatrimony.monthKey !== lastPatrimony.monthKey) {
          const firstDate = new Date(`${firstPatrimony.monthKey}-01T00:00:00`);
          const lastDate = new Date(`${lastPatrimony.monthKey}-01T00:00:00`);
          elapsedMonths = (lastDate.getFullYear() - firstDate.getFullYear()) * 12 + lastDate.getMonth() - firstDate.getMonth();
          if (elapsedMonths >= 12) cagr = (Math.pow(lastPatrimony.value / firstPatrimony.value, 12 / elapsedMonths) - 1) * 100;
      }
      const cagrDisplay = cagr === null ? '—' : `${cagr.toFixed(1)}%`;
      const cagrColor = cagr === null ? '#94a3b8' : cagr >= 10 ? '#4ade80' : cagr >= 0 ? '#f59e0b' : '#f87171';
      const cagrSince = firstPatrimony ? formatExpenseMonth(firstPatrimony.monthKey) : '—';

      document.getElementById('analyticsStats').innerHTML = `
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Ingreso mensual promedio</span></div>
              <div class="stat-value">${fmtMoney(averageIncome)}</div>
              <div class="stat-sub">${monthCount} meses cerrados · hasta 12</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Ahorro mensual promedio</span></div>
              <div class="stat-value" style="color:${savingsRate === null ? '#94a3b8' : savingsRate >= 10 ? '#4ade80' : savingsRate > 0 ? '#f59e0b' : '#f87171'}">${fmtMoney(averageSavings)}</div>
              <div class="stat-sub">Tasa del período: ${savingsRate === null ? '—' : savingsRate.toFixed(1) + '%'}</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">Ingresos de trabajo</span></div>
              <div class="stat-value">${workContribution === null ? '—' : workContribution.toFixed(1) + '%'}</div>
              <div class="stat-sub">Otras fuentes en ${monthCount} meses: ${fmtMoney(otherIncome)}</div>
          </div>
          <div class="stat-card">
              <div class="stat-header"><span class="stat-label">CAGR del patrimonio</span></div>
              <div class="stat-value" style="color:${cagrColor}">${cagrDisplay}</div>
              <div class="stat-sub">Desde ${cagrSince} · ${elapsedMonths >= 12 ? elapsedMonths + ' meses' : 'requiere al menos 12 meses'}</div>
          </div>
      `;
  }



// === RENDER RATIOS & KPIs ===
const PASSIVE_INCOME_ROOT_NAMES = ['Intereses, dividendos', 'Inversiones'];

function getDbGastosMonthData(monthKey) {
    return (gastosData?.meses || []).find(month =>
        getExpenseMonthKey(month.isoDate || month.mes) === monthKey
    ) || null;
}

function getDbGastosFinancialTotals(monthData) {
    if (!monthData) return null;
    const incomeFallback = getDbGastosMonthlyCategoryValues(
        getExpenseMonthKey(monthData.isoDate || monthData.mes), 'ingresos'
    )?.total;
    const expenseFallback = getDbGastosMonthlyCategoryValues(
        getExpenseMonthKey(monthData.isoDate || monthData.mes), 'gastos'
    )?.total;
    const income = Number(monthData.totalIngreso);
    const expenses = Number(monthData.totalGasto);
    return {
        income: Number.isFinite(income) ? income : (incomeFallback ?? null),
        expenses: Number.isFinite(expenses) ? expenses : (expenseFallback ?? null)
    };
}

function getPassiveIncomeForDbGastosMonth(monthData) {
    if (!monthData?.valores) return null;
    const categories = appData?.categorias || [];
    const passiveRoots = categories.filter(category =>
        String(category.tipo || '').trim().toLowerCase() === 'ingresos' &&
        !category.padre &&
        PASSIVE_INCOME_ROOT_NAMES.some(name =>
            normalizeExpenseCategoryName(category.nombre) === normalizeExpenseCategoryName(name)
        )
    );
    if (!passiveRoots.length) return null;

    const monthlyValues = new Map(Object.entries(monthData.valores).map(([name, value]) => [
        normalizeExpenseCategoryName(name), Number(value) || 0
    ]));
    const findValue = names => {
        for (const name of names) {
            const key = normalizeExpenseCategoryName(name);
            if (monthlyValues.has(key)) return { found: true, value: monthlyValues.get(key) };
        }
        return { found: false, value: 0 };
    };

    let total = 0;
    let foundAny = false;
    passiveRoots.forEach(root => {
        const rootValue = findValue([root.nombre, root.etiqueta]);
        const children = categories.filter(category =>
            String(category.tipo || '').trim().toLowerCase() === 'ingresos' &&
            String(category.padre || '').trim() === String(root.id).trim()
        );
        const childValues = children.map(child => findValue([child.nombre]));
        const childTotal = childValues.reduce((sum, item) => sum + item.value, 0);
        const childrenFound = childValues.some(item => item.found);

        // Inversiones is intentionally cumulative in this user's category
        // model: include direct root transactions and its individual sources.
        if (rootValue.found) total += rootValue.value;
        if (childrenFound) total += childTotal;
        if (rootValue.found || childrenFound) foundAny = true;
    });
    return foundAny ? total : null;
}

function calculateRatios() {
    const s = appData.summary;
    const activos = Number(s.activosTotales.current) || 0;
    const pasivos = Number(s.pasivosTotal.current) || 0;
    const liquido = Number(s.liquidoTotal.current) || 0;
    const inversiones = Number(s.inversionesTotal.current) || 0;
    const patrimonio = Number(s.patrimonioNeto.current) || 0;
    const currentMonthKey = getExpenseMonthKey(new Date());
    const currentDbMonth = getDbGastosMonthData(currentMonthKey);
    const currentDbTotals = getDbGastosFinancialTotals(currentDbMonth);
    const ingresos = currentDbTotals?.income ?? (Number(s.ingresosNetos.current) || 0);
    const gastos = currentDbTotals?.expenses ?? (Number(s.gastosTotal.current) || 0);

    // Historial para cálculos de tendencia
    const patHistory = s.patrimonioNeto.history || [];
    const last12 = patHistory.slice(-12);

    // These are total-liability coverage measures. Current liabilities are not
    // separated in the source data, so the app must not label them Current Ratio.
    const cashCoverage = pasivos > 0 ? liquido / pasivos : null;
    const liquidAssetsCoverage = pasivos > 0 ? (liquido + inversiones) / pasivos : null;
    const netLiquidAssets = liquido + inversiones - pasivos;
    const monthsCovered = gastos > 0 ? liquido / gastos : null;

    // Deuda/Patrimonio
    const debtToEquity = patrimonio > 0 ? (pasivos / patrimonio) * 100 : null;

    // Deuda/Activos
    const debtToAssets = activos > 0 ? (pasivos / activos) * 100 : null;
    const revolvingCreditLimit = getCreditLimitTotal();
    const creditUtilization = revolvingCreditLimit > 0
        ? (getDeudaRotativa() / revolvingCreditLimit) * 100
        : null;

    // Trailing-12-month net surplus divided by average assets, using only
    // months present in all three histories (income, expenses, and assets).
    const historyMap = series => new Map((series?.history || []).map(item => [
        getExpenseMonthKey(item.isoDate || item.date), Number(item.value)
    ]).filter(([month, value]) => month && Number.isFinite(value)));
    const assetsByMonth = historyMap(s.activosTotales);
    const dbMonthlyFinancials = new Map((gastosData?.meses || []).map(month => {
        const monthKey = getExpenseMonthKey(month.isoDate || month.mes);
        return [monthKey, getDbGastosFinancialTotals(month)];
    }).filter(([month, values]) => month && values && values.income !== null && values.expenses !== null));
    const completeMonths = [...dbMonthlyFinancials.keys()]
        .filter(month => month < currentMonthKey && assetsByMonth.has(month))
        .sort()
        .slice(-12);
    let roa = null;
    if (completeMonths.length === 12) {
        const netSurplus12m = completeMonths.reduce((sum, month) => {
            const totals = dbMonthlyFinancials.get(month);
            return sum + totals.income - totals.expenses;
        }, 0);
        const averageAssets12m = completeMonths.reduce((sum, month) => sum + assetsByMonth.get(month), 0) / 12;
        if (averageAssets12m > 0) roa = (netSurplus12m / averageAssets12m) * 100;
    }

    // Tasa de Crecimiento YoY (Patrimonio)
    let yoyGrowth = null;
    if (patHistory.length >= 13) {
        const val12mAgo = Number(patHistory[patHistory.length - 13].value);
        if (Number.isFinite(val12mAgo) && val12mAgo !== 0) {
            yoyGrowth = ((patrimonio - val12mAgo) / Math.abs(val12mAgo)) * 100;
        }
    }

    // Velocidad de Acumulación (promedio mensual últimos 12 meses)
    let accumulationSpeed = null;
    if (last12.length >= 2) {
        const first = last12[0].value;
        const last = last12[last12.length - 1].value;
        const months = last12.length - 1;
        accumulationSpeed = months > 0 ? (last - first) / months : 0;
    }

    // Ratio de Ahorro
    const savingsRate = ingresos > 0 ? ((ingresos - gastos) / ingresos) * 100 : null;

    // Independence uses actual historical values from DB_GASTOS, with its
    // category names resolved through DB_CATEGORIAS rather than DB_PRESUPUESTO.
    const ingresoPasivo = getPassiveIncomeForDbGastosMonth(currentDbMonth);
    const fiRatio = currentDbMonth && ingresoPasivo !== null && gastos > 0
        ? (ingresoPasivo / gastos) * 100
        : null;

    return {
        liquidity: {
            cashCoverage: { value: cashCoverage, label: 'Efectivo / pasivos totales', description: 'Efectivo disponible dividido entre todos los pasivos.', format: 'x', threshold: 0.5 },
            liquidAssetsCoverage: { value: liquidAssetsCoverage, label: 'Efectivo + inversiones / pasivos', description: 'Incluye inversiones además del efectivo; no es un Current Ratio.', format: 'x', threshold: 1 },
            netLiquidAssets: { value: netLiquidAssets, label: 'Activos líquidos netos', description: 'Efectivo + inversiones − pasivos totales.', format: 'money', threshold: 0 },
            monthsCovered: { value: monthsCovered, label: 'Meses de gastos cubiertos', description: 'Efectivo disponible ÷ gasto mensual actual.', format: 'x', threshold: 6 }
        },
        solvency: {
            debtToEquity: { value: debtToEquity, label: 'Deuda / Patrimonio', description: 'Pasivos totales como porcentaje del patrimonio neto.', format: 'pct', threshold: 50, lowerIsBetter: true },
            debtToAssets: { value: debtToAssets, label: 'Deuda / Activos', description: 'Porción de los activos financiada con pasivos.', format: 'pct', threshold: 50, lowerIsBetter: true },
            creditUtilization: { value: creditUtilization, label: 'Utilización de crédito', description: 'Deuda de tarjetas y líneas frente a sus límites.', format: 'pct', threshold: 30, lowerIsBetter: true }
        },
        profitability: {
            roa: { value: roa, label: 'Excedente neto / activos promedio', description: 'DB_GASTOS: ingresos menos gastos de los últimos 12 meses cerrados ÷ activos promedio.', format: 'pct', threshold: 5 },
            yoyGrowth: { value: yoyGrowth, label: 'Crecimiento YoY', description: 'Cambio del patrimonio frente a hace 12 meses.', format: 'pct', threshold: 10 },
            accumulationSpeed: { value: accumulationSpeed, label: 'Velocidad de acumulación', description: 'Aumento promedio mensual del patrimonio en los últimos 12 registros.', format: 'money', threshold: 0 },
            savingsRate: { value: savingsRate, label: 'Tasa de ahorro', description: '(Ingresos − gastos) ÷ ingresos del mes.', format: 'pct', threshold: 10 },
            fiRatio: { value: fiRatio, label: 'Cobertura con ingresos pasivos', description: 'Intereses/dividendos + Inversiones y sus subcategorías ÷ gastos reales de DB_GASTOS.', format: 'pct', threshold: 100 }
        }
    };
}

function getKpiStatus(value, threshold, format, lowerIsBetter) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        return { class: 'neutral', text: 'No disponible' };
    }

    if (format === 'money') {
        if (value > 0) return { class: 'good', text: 'Positivo' };
        if (value === 0) return { class: 'neutral', text: 'En equilibrio' };
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
    if (item.value === null || item.value === undefined || !Number.isFinite(Number(item.value))) return '—';
    if (item.format === 'money') return fmtMoney(item.value);
    if (item.format === 'pct') return item.value.toFixed(2) + '%';
    if (item.format === 'x') return item.value.toFixed(2) + 'x';
    return item.value.toFixed(2);
}

function renderKpiCard(item, lowerIsBetter) {
    const status = getKpiStatus(item.value, item.threshold, item.format, lowerIsBetter);
    const formatted = formatKpiValue(item);
    const hasValue = item.value !== null && item.value !== undefined && Number.isFinite(Number(item.value));

    // Gauge width (0-100%)
    // Para "lower is better": invertir el fill para que menor deuda = barra más llena
    let gaugeWidth = 0;
    if (hasValue && lowerIsBetter) {
        const ref = item.format === 'pct' ? item.threshold * 2 : item.threshold * 3;
        gaugeWidth = Math.min(100, Math.max(0, (1 - item.value / ref) * 100));
    } else if (hasValue && item.format === 'pct') {
        gaugeWidth = Math.min(100, Math.max(0, (item.value / (item.threshold * 2)) * 100));
    } else if (hasValue && item.format === 'x') {
        gaugeWidth = Math.min(100, Math.max(0, (item.value / (item.threshold * 3)) * 100));
    } else if (hasValue && item.format === 'money') {
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
            <div class="kpi-sub">${item.description || ''}</div>
            <div class="kpi-sub">Referencia: ${formatKpiValue({ ...item, value: item.threshold })}</div>
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
    const sourceStatus = document.getElementById('ratiosSourceStatus');
    if (!gastosData) {
        if (sourceStatus) sourceStatus.textContent = 'Cargando el histórico mensual de DB_GASTOS…';
        if (!ratiosDbGastosLoading) {
            ratiosDbGastosLoading = true;
            loadGastosData().then(() => {
                ratiosDbGastosLoading = false;
                if (sourceStatus) sourceStatus.textContent = 'Histórico mensual desde DB_GASTOS, relacionado con DB_CATEGORIAS.';
                renderRatios();
                if (document.getElementById('ratios')?.classList.contains('active')) {
                    if (charts.ratiosRadar) {
                        charts.ratiosRadar.destroy();
                        charts.ratiosRadar = null;
                    }
                    renderRatiosRadarChart();
                    renderRatiosTrendChart();
                }
            }).catch(error => {
                ratiosDbGastosLoading = false;
                if (sourceStatus) sourceStatus.textContent = 'No se pudo cargar DB_GASTOS; algunos indicadores aparecerán como no disponibles.';
                const trendStatus = document.getElementById('ratiosTrendStatus');
                const trendContainer = document.getElementById('ratiosTrendChart');
                if (trendStatus) trendStatus.textContent = 'No se pudo cargar DB_GASTOS para el gráfico mensual.';
                if (trendContainer) trendContainer.innerHTML = '<div class="modeco-empty-state">No se pudo cargar el historial mensual.</div>';
                console.warn('No se pudo cargar el histórico para Ratios:', error);
            });
        }
    } else if (sourceStatus) {
        sourceStatus.textContent = 'Histórico mensual desde DB_GASTOS, relacionado con DB_CATEGORIAS.';
    }

    const ratios = calculateRatios();

    // Liquidez
    const liquidityHtml = Object.values(ratios.liquidity)
        .map(item => renderKpiCard(item, false))
        .join('');
    document.getElementById('liquidityRatios').innerHTML = liquidityHtml;

    // Solvencia (lower is better para deuda)
    const solvencyHtml = Object.values(ratios.solvency)
        .map(item => renderKpiCard(item, item.lowerIsBetter))
        .join('');
    document.getElementById('solvencyRatios').innerHTML = solvencyHtml;

    // Rentabilidad
    const profitabilityHtml = Object.values(ratios.profitability)
        .map(item => renderKpiCard(item, false))
        .join('');
    document.getElementById('profitabilityRatios').innerHTML = profitabilityHtml;
}

function getRatioHistoryMap(series) {
    return new Map((series?.history || []).map(item => [
        getExpenseMonthKey(item.isoDate || item.date), Number(item.value)
    ]).filter(([month, value]) => month && Number.isFinite(value)));
}

function shiftRatioMonthKey(monthKey, delta) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getRatioTrendRows() {
    if (!gastosData?.meses || !appData?.summary) return [];

    const summary = appData.summary;
    const assets = getRatioHistoryMap(summary.activosTotales);
    const liabilities = getRatioHistoryMap(summary.pasivosTotal);
    const liquid = getRatioHistoryMap(summary.liquidoTotal);
    const investments = getRatioHistoryMap(summary.inversionesTotal);
    const netWorth = getRatioHistoryMap(summary.patrimonioNeto);
    const dbMonths = new Map();
    gastosData.meses.forEach(month => {
        const key = getExpenseMonthKey(month.isoDate || month.mes);
        if (key) dbMonths.set(key, { month, totals: getDbGastosFinancialTotals(month) });
    });
    const monthKeys = [...new Set([
        ...dbMonths.keys(), ...assets.keys(), ...liabilities.keys(), ...liquid.keys(),
        ...investments.keys(), ...netWorth.keys()
    ])].sort();
    const dbKeys = [...dbMonths.keys()].sort();
    const currentMonthKey = getExpenseMonthKey(new Date());

    function trailingRoa(monthKey) {
        if (monthKey >= currentMonthKey) return null;
        const window = dbKeys.filter(key => key <= monthKey).slice(-12);
        if (window.length !== 12 || window[11] !== monthKey) return null;
        if (window.some(key => {
            const totals = dbMonths.get(key)?.totals;
            return !totals || !Number.isFinite(totals.income) || !Number.isFinite(totals.expenses);
        })) return null;
        for (let i = 1; i < window.length; i++) {
            if (shiftRatioMonthKey(window[i - 1], 1) !== window[i]) return null;
        }
        if (window.some(key => !assets.has(key))) return null;
        const averageAssets = window.reduce((sum, key) => sum + assets.get(key), 0) / window.length;
        if (averageAssets <= 0) return null;
        const surplus = window.reduce((sum, key) => {
            const totals = dbMonths.get(key)?.totals;
            return sum + (totals ? totals.income - totals.expenses : 0);
        }, 0);
        return (surplus / averageAssets) * 100;
    }

    return monthKeys.map(monthKey => {
        const dbEntry = dbMonths.get(monthKey);
        const totals = dbEntry?.totals;
        const passive = dbEntry ? getPassiveIncomeForDbGastosMonth(dbEntry.month) : null;
        const assetValue = assets.get(monthKey);
        const liabilityValue = liabilities.get(monthKey);
        const liquidValue = liquid.get(monthKey);
        const investmentValue = investments.get(monthKey);
        const netWorthValue = netWorth.get(monthKey);
        const priorNetWorth = netWorth.get(shiftRatioMonthKey(monthKey, -12));

        return {
            monthKey,
            values: {
                savingsRate: totals?.income > 0 ? ((totals.income - totals.expenses) / totals.income) * 100 : null,
                passiveIncomeCoverage: passive !== null && totals?.expenses > 0 ? (passive / totals.expenses) * 100 : null,
                debtToAssets: assetValue > 0 && liabilities.has(monthKey) ? (liabilityValue / assetValue) * 100 : null,
                debtToEquity: netWorthValue > 0 && liabilities.has(monthKey) ? (liabilityValue / netWorthValue) * 100 : null,
                cashCoverage: liabilityValue > 0 && liabilities.has(monthKey) && liquid.has(monthKey) ? liquidValue / liabilityValue : null,
                liquidAssetsCoverage: liabilityValue > 0 && liabilities.has(monthKey) && liquid.has(monthKey) && investments.has(monthKey)
                    ? (liquidValue + investmentValue) / liabilityValue
                    : null,
                monthsCovered: totals?.expenses > 0 && liquid.has(monthKey) ? liquidValue / totals.expenses : null,
                roa: trailingRoa(monthKey),
                yoyGrowth: Number.isFinite(netWorthValue) && Number.isFinite(priorNetWorth) && priorNetWorth !== 0
                    ? ((netWorthValue - priorNetWorth) / Math.abs(priorNetWorth)) * 100
                    : null,
                netLiquidAssets: liquid.has(monthKey) && investments.has(monthKey) && liabilities.has(monthKey)
                    ? liquidValue + investmentValue - liabilityValue
                    : null
            }
        };
    });
}

function formatRatioTrendValue(value, format) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Sin datos';
    if (format === 'pct') return `${Number(value).toFixed(1)}%`;
    if (format === 'x') return `${Number(value).toFixed(2)}x`;
    return fmtMoney(Number(value));
}

function renderRatiosTrendChart() {
    if (charts.ratiosTrend) {
        charts.ratiosTrend.destroy();
        delete charts.ratiosTrend;
    }
    const container = document.getElementById('ratiosTrendChart');
    const status = document.getElementById('ratiosTrendStatus');
    const metricSelect = document.getElementById('ratiosTrendMetric');
    const periodSelect = document.getElementById('ratiosTrendPeriod');
    if (!container || !metricSelect || !periodSelect) return;
    if (!gastosData) {
        if (status) status.textContent = 'Cargando DB_GASTOS para construir el historial…';
        container.innerHTML = '';
        return;
    }

    const metrics = {
        savingsRate: { label: 'Tasa de ahorro', format: 'pct', color: '#22c55e' },
        passiveIncomeCoverage: { label: 'Cobertura con ingresos pasivos', format: 'pct', color: '#a78bfa' },
        debtToAssets: { label: 'Deuda / activos', format: 'pct', color: '#f87171' },
        debtToEquity: { label: 'Deuda / patrimonio', format: 'pct', color: '#fb923c' },
        cashCoverage: { label: 'Efectivo / pasivos', format: 'x', color: '#38bdf8' },
        liquidAssetsCoverage: { label: 'Efectivo + inversiones / pasivos', format: 'x', color: '#60a5fa' },
        monthsCovered: { label: 'Meses de gastos cubiertos', format: 'x', color: '#34d399' },
        roa: { label: 'Excedente neto / activos promedio (12m)', format: 'pct', color: '#fbbf24' },
        yoyGrowth: { label: 'Crecimiento patrimonial YoY', format: 'pct', color: '#e879f9' },
        netLiquidAssets: { label: 'Activos líquidos netos', format: 'money', color: '#facc15' }
    };
    const metric = metrics[metricSelect.value] || metrics.savingsRate;
    const allRows = getRatioTrendRows();
    const periodValue = periodSelect.value;
    const rows = periodValue === 'all' ? allRows : allRows.slice(-Number(periodValue));
    const hasData = rows.some(row => row.values[metricSelect.value] !== null && row.values[metricSelect.value] !== undefined);
    if (!hasData) {
        container.innerHTML = '<div class="modeco-empty-state">No hay datos suficientes para este ratio en el período seleccionado.</div>';
        if (status) status.textContent = 'Los meses sin datos o sin base de cálculo se dejan vacíos.';
        return;
    }

    if (status) status.textContent = `${rows.length} meses · los huecos indican que faltan datos para ese cálculo.`;
    container.innerHTML = '';
    const ctx = getCanvas('ratiosTrendChart');
    if (!ctx) return;
    charts.ratiosTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: rows.map(row => formatExpenseMonth(row.monthKey)),
            datasets: [{
                label: metric.label,
                data: rows.map(row => row.values[metricSelect.value]),
                borderColor: metric.color,
                backgroundColor: `${metric.color}22`,
                fill: true,
                tension: 0.25,
                spanGaps: false,
                pointRadius: 3,
                pointHoverRadius: 6,
                borderWidth: 2
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
                    callbacks: {
                        label: context => `${metric.label}: ${formatRatioTrendValue(context.parsed.y, metric.format)}`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#64748b', maxRotation: 0, autoSkip: true },
                    grid: { color: 'rgba(51,65,85,0.15)' }
                },
                y: {
                    ticks: { color: '#64748b', callback: value => formatRatioTrendValue(value, metric.format) },
                    grid: { color: 'rgba(51,65,85,0.2)' }
                }
            }
        }
    });
}

function renderRatiosRadarChart() {
    if (charts.ratiosRadar) {
        charts.ratiosRadar.destroy();
        charts.ratiosRadar = null;
    }
    const ctx = getCanvas('ratiosRadarChart');
    if (!ctx) return;

    const r = calculateRatios();

    // Normalizar métricas a escala 0-100 para el radar
    const norm = (val, max) => Number.isFinite(val)
        ? Math.min(100, Math.max(0, (val / max) * 100))
        : null;
    const debtHealth = r.solvency.debtToAssets.value === null
        ? null
        : 100 - norm(r.solvency.debtToAssets.value, 100);

    const data = {
        labels: ['Liquidez ampliada', 'Solvencia', 'Excedente neto', 'Ahorro', 'Crecimiento', 'Meses cubiertos'],
        datasets: [{
            label: 'Tus Métricas',
            data: [
                norm(r.liquidity.liquidAssetsCoverage.value, 2),
                debtHealth,
                norm(r.profitability.roa.value, 20),
                norm(r.profitability.savingsRate.value === null ? null : Math.max(0, r.profitability.savingsRate.value), 30),
                norm(r.profitability.yoyGrowth.value === null ? null : Math.max(0, r.profitability.yoyGrowth.value), 50),
                norm(r.liquidity.monthsCovered.value, 12)
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

    // === RENDER CHARTS POR TAB (solo si no existen) ===
    function renderChartsForTab(tab) {
        if (tab === 'overview') {
            if (!charts.patrimonio) renderPatrimonioChart();
            if (!charts.assetsPie) renderAssetsPieChart();
            if (!charts.assetsVsLiab) renderAssetsVsLiabilitiesChart();
        } else if (tab === 'assets') {
            if (!charts.liquido) renderLiquidoChart();
            if (!charts.inversiones) renderInversionesChart();
            if (!charts.assetsYearlyChange) renderAssetsYearlyChangeChart();
            if (!charts.assetsCurrentYearChange) renderAssetsCurrentYearChangeChart();
        } else if (tab === 'liabilities') {
            if (!charts.liabilities) renderLiabilitiesChart();
        } else if (tab === 'income') {
            if (!charts.income) renderIncomeChart();
        } else if (tab === 'expenses') {
            if (!charts.expenses) renderExpensesChart();
            if (!charts.expensesPie) renderExpensesPieChart();
        } else if (tab === 'analytics') {
            if (!charts.growthRate) renderGrowthRateChart();
            if (!charts.invGrowthRate) renderInvGrowthRateChart();
            if (!charts.incVsExp) renderIncomeVsExpenseChart();
            if (!charts.projection) renderProjectionChart();
        } else if (tab === 'ratios') {
            try { renderRatios(); } catch (e) { console.error(e); }
            setTimeout(() => {
                try {
                    if (!charts.ratiosRadar) renderRatiosRadarChart();
                    if (!charts.ratiosTrend) renderRatiosTrendChart();
                }
                catch (e) { console.error(e); }
            }, 100);
        } else if (tab === 'db-gastos') {
            renderDBGastosTab();
        } else if (tab === 'jarras') {
            renderJarrasTab();
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

    function getAssetsChangeHistory() {
        return (appData.summary.activosTotales.history || []).map(item => ({
            monthKey: getExpenseMonthKey(item.isoDate || item.date),
            date: item.date,
            value: Number(item.value) || 0
        })).filter(item => item.monthKey).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
    }

    function buildAssetsChangePoints(currentEntries, previousEntryByKey) {
        return currentEntries.map(item => {
            const previous = previousEntryByKey(item.previousKey);
            if (!previous || Number(previous.value) === 0) {
                return { label: item.label, pct: null, delta: null, comparisonLabel: item.comparisonLabel };
            }
            const delta = item.value - Number(previous.value);
            return {
                label: item.label,
                pct: (delta / Math.abs(Number(previous.value))) * 100,
                delta,
                comparisonLabel: item.comparisonLabel
            };
        });
    }

    function renderAssetsChangeBarChart(containerId, points, seriesLabel, emptyMessage) {
        const container = document.getElementById(containerId);
        if (!container) return null;
        if (!points.length || points.every(point => point.pct === null)) {
            container.innerHTML = `<div class="modeco-empty-state">${emptyMessage}</div>`;
            return null;
        }
        const ctx = getCanvas(containerId);
        if (!ctx) return null;
        return new Chart(ctx, {
            type: 'bar',
            data: {
                labels: points.map(point => point.label),
                datasets: [{
                    label: seriesLabel,
                    data: points.map(point => point.pct),
                    backgroundColor: points.map(point => point.pct >= 0 ? '#22c55e' : '#ef4444'),
                    borderRadius: 5,
                    maxBarThickness: 42
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: item => {
                                const point = points[item.dataIndex];
                                const sign = point.pct >= 0 ? '+' : '−';
                                return [` ${seriesLabel}: ${sign}${Math.abs(point.pct).toFixed(1)}%`,
                                    ` Cambio: ${sign}${fmtMoney(Math.abs(point.delta))}`,
                                    point.comparisonLabel ? ` Comparado con: ${point.comparisonLabel}` : ''];
                            }
                        }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#64748b', maxRotation: 0 } },
                    y: {
                        grid: { color: 'rgba(51,65,85,0.2)' },
                        ticks: { color: '#64748b', callback: value => `${value}%` }
                    }
                }
            }
        });
    }

    function renderAssetsYearlyChangeChart() {
        const history = getAssetsChangeHistory();
        const snapshotsByYear = new Map();
        history.forEach(item => snapshotsByYear.set(item.monthKey.slice(0, 4), item));
        const byMonth = new Map(history.map(item => [item.monthKey, item]));
        const years = [...snapshotsByYear.keys()].sort();
        const points = buildAssetsChangePoints(years.map(year => {
            const current = snapshotsByYear.get(year);
            const [, month] = current.monthKey.split('-').map(Number);
            const previousMonth = addMonths(Number(year), month, -12);
            const previousKey = `${previousMonth.year}-${String(previousMonth.month).padStart(2, '0')}`;
            return {
                label: year,
                value: current.value,
                previousKey,
                comparisonLabel: byMonth.get(previousKey)?.date || formatExpenseMonth(previousKey)
            };
        }), monthKey => byMonth.get(monthKey));
        charts.assetsYearlyChange = renderAssetsChangeBarChart(
            'assetsYearlyChangeChart', points, 'Cambio anual', 'No hay dos años comparables de activos.'
        );
    }

    function renderAssetsCurrentYearChangeChart() {
        const year = new Date().getFullYear();
        const yearLabel = document.getElementById('assetsCurrentYearLabel');
        if (yearLabel) yearLabel.textContent = year;
        const history = getAssetsChangeHistory();
        const byMonth = new Map(history.map(item => [item.monthKey, item]));
        const currentYearEntries = history.filter(item => item.monthKey.startsWith(`${year}-`));
        const points = buildAssetsChangePoints(currentYearEntries.map(item => {
            const [, month] = item.monthKey.split('-').map(Number);
            const previousMonth = addMonths(year, month, -1);
            const previousKey = `${previousMonth.year}-${String(previousMonth.month).padStart(2, '0')}`;
            return {
                label: formatShortDate(item.date),
                value: item.value,
                previousKey,
                comparisonLabel: byMonth.get(previousKey)?.date || formatExpenseMonth(previousKey)
            };
        }), monthKey => byMonth.get(monthKey));
        charts.assetsCurrentYearChange = renderAssetsChangeBarChart(
            'assetsCurrentYearChangeChart', points, 'Cambio mensual', `No hay meses comparables de ${year}.`
        );
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
        monthKey: getExpenseMonthKey(d.isoDate || d.date),
        value: getDbGastosMonthlyCategoryValues(getExpenseMonthKey(d.isoDate || d.date), 'ingresos')?.total ?? d.value
    }));
    const incomeBudgetsByMonth = new Map();
    const incomeBudgetMonths = new Set((appData.presupuesto || [])
        .filter(row => row.tipo === 'Ingresos')
        .map(row => getExpenseMonthKey(row.mesAno))
        .filter(Boolean));
    incomeBudgetMonths.forEach(key => {
        incomeBudgetsByMonth.set(key, getIncomeBudgetRowsByCategory(key)
            .reduce((sum, group) => sum + group.total, 0));
    });
    charts.income = new Chart(ctx, {
        type: 'bar',
        data: {
        labels: h.map(d => {
            return String(d.date).replace(/'/g, "");
        }),
        datasets: [
            {
                label: 'Ingresos',
                data: h.map(d => d.value),
                backgroundColor: h.map(d => d.monthKey === incomeSelectedMonthKey ? '#16a34a' : '#22c55e'),
                borderRadius: 4,
                barPercentage: 0.7
            },
            {
                label: 'Meta mensual',
                data: h.map(d => incomeBudgetsByMonth.get(d.monthKey) ?? null),
                backgroundColor: 'rgba(148,163,184,0.35)',
                borderRadius: 4,
                barPercentage: 0.7
            }
        ]
        },
        options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'top', align: 'end', labels: { color: '#94a3b8', font: { size: 10 }, usePointStyle: true } } },
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
    const g = appData.summary.gastosTotal.history.map(d => ({
        date: formatShortDate(d.date),
        monthKey: getExpenseMonthKey(d.isoDate || d.date),
        value: d.value
    }));
    const budgetsByMonth = new Map((appData.summary.presupuesto.history || []).map(d => [
      getExpenseMonthKey(d.isoDate || d.date), d.value
    ]));
    const selectedMonthKey = expensesSelectedMonthKey;
    charts.expenses = new Chart(ctx, {
        type: 'bar',
        data: {
        labels: g.map(d => d.date),
        datasets: [
            {
            label: 'Gastos',
            data: g.map(d => d.value),
            backgroundColor: g.map(d => d.monthKey === selectedMonthKey ? '#b91c1c' : '#ef4444'),
            borderRadius: 4,
            barPercentage: 0.6,
            categoryPercentage: 0.8
            },
            {
            label: 'Presupuesto',
            data: g.map(d => budgetsByMonth.get(d.monthKey) ?? null),
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

    function renderExpensesPieChart(dailyCategories = null) {
    const container = document.getElementById('expensesPieChart');
    if (!container) return;
    const dbGastosTotals = dailyCategories ? null : getDbGastosMonthlyTotals(expensesSelectedMonthKey);
    let entries = dailyCategories
      ? dailyCategories.map(category => ({ name: category.name, value: Number(category.total) || 0 }))
      : dbGastosTotals
        ? dbGastosTotals.categories.map(category => ({ name: category.name, value: category.value }))
        : Object.entries(appData.gastos || {}).map(([name, category]) => {
          const value = getExpenseHistoryValue(category, expensesSelectedMonthKey);
          return { name, value: value ?? 0 };
        });
    if (!dailyCategories && !entries.some(item => item.value > 0)) {
      const categoryById = new Map((appData.categorias || []).map(category => [String(category.id), category]));
      entries = (appData.presupuesto || [])
        .filter(row => row.tipo === 'Gastos' && getExpenseMonthKey(row.mesAno) === expensesSelectedMonthKey)
        .map(row => ({
          name: categoryById.get(String(row.idCategoria))?.etiqueta || `Categoría ${row.idCategoria}`,
          value: Number(row.gastoReal) || 0
        }));
    }
    entries.sort((a, b) => b.value - a.value);
    const nonZeroEntries = entries.filter(item => item.value > 0);

    if (!nonZeroEntries.length) {
      if (charts.expensesPie) {
        charts.expensesPie.destroy();
        delete charts.expensesPie;
      }
      container.innerHTML = '<div class="modeco-empty-state">Sin distribución de gastos para el mes seleccionado</div>';
      charts.expensesPie = null;
      return;
    }

    if (charts.expensesPie) {
      charts.expensesPie.destroy();
      delete charts.expensesPie;
    }
    container.replaceChildren();
    const ctx = getCanvas('expensesPieChart');
    if (!ctx) return;
    
    charts.expensesPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
        labels: nonZeroEntries.map(e => e.name),
        datasets: [{
            data: nonZeroEntries.map(e => e.value),
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
    let monthly = (gastosData?.meses || []).map(month => {
      const monthKey = getExpenseMonthKey(month.isoDate || month.mes);
      const totals = getDbGastosFinancialTotals(month);
      return { monthKey, income: totals?.income, expenses: totals?.expenses };
    }).filter(item => item.monthKey && Number.isFinite(item.income) && Number.isFinite(item.expenses))
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey)).slice(-24);
    if (!monthly.length) {
      const incomeByMonth = new Map((appData.summary.ingresosNetos.history || []).map(item => [
        getExpenseMonthKey(item.isoDate || item.date), Number(item.value)
      ]));
      const expenseByMonth = new Map((appData.summary.gastosTotal.history || []).map(item => [
        getExpenseMonthKey(item.isoDate || item.date), Number(item.value)
      ]));
      monthly = [...new Set([...incomeByMonth.keys(), ...expenseByMonth.keys()])].filter(Boolean)
        .sort().map(monthKey => ({ monthKey, income: incomeByMonth.get(monthKey), expenses: expenseByMonth.get(monthKey) }))
        .filter(item => Number.isFinite(item.income) || Number.isFinite(item.expenses)).slice(-24);
    }
    const labels = monthly.map(item => formatExpenseMonth(item.monthKey));
    charts.incVsExp = new Chart(ctx, {
        type: 'line',
        data: {
        labels: labels,
        datasets: [
            {
            label: 'Ingresos',
            data: monthly.map(d => d.income ?? null),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34,197,94,0.08)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5
            },
            {
            label: 'Gastos',
            data: monthly.map(d => d.expenses ?? null),
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
        monthKey: getExpenseMonthKey(d.isoDate || d.date),
        value: Number(d.value) || 0
    })).filter(d => d.value > 0 && d.monthKey)
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

    if (history.length < 2) {
        document.getElementById('projectionChart').innerHTML = 
            '<div style="color:#64748b;text-align:center;padding:40px;">Se requieren al menos 2 puntos con valor > 0</div>';
        return;
    }

    const firstVal = history[0].value;
    const lastVal = history[history.length - 1].value;
    const firstDateForSpan = new Date(`${history[0].monthKey}-01T00:00:00`);
    const lastDateForSpan = new Date(`${history[history.length - 1].monthKey}-01T00:00:00`);
    const months = (lastDateForSpan.getFullYear() - firstDateForSpan.getFullYear()) * 12 +
        lastDateForSpan.getMonth() - firstDateForSpan.getMonth();
    
    // === CÁLCULO ROBUSTO DEL CAGR ===
    let cagr = 0;
    let useProjection = false;
    
    if (firstVal > 0 && lastVal > 0 && months >= 12) {
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

    for (let i = 1; i <= (useProjection ? 60 : 0); i++) {
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

    const projectionStatus = document.getElementById('projectionStatus');
    if (projectionStatus) projectionStatus.textContent = useProjection
        ? `Escenario base a 5 años · CAGR calculado con ${months} meses reales`
        : `Se necesitan al menos 12 meses entre el primer y último dato; hay ${Math.max(0, months)} meses.`;

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

    // === CANVAS REUTILIZABLE (no destruye al cambiar de tab) ===
    function getCanvas(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    
    // Reutilizar canvas existente
    let canvas = container.querySelector('canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        container.appendChild(canvas);
    }
    
    // DESTRUIR chart anterior si existe (Chart.js API nativa)
    const existingChart = Chart.getChart ? Chart.getChart(canvas) : null;
    if (existingChart) {
        existingChart.destroy();
    }
    
    return canvas.getContext('2d');
}

    // === DESTRUIR TODOS LOS CHARTS (solo para refreshData) ===
    function destroyAllCharts() {
        Object.keys(charts).forEach(key => {
            if (charts[key] && typeof charts[key].destroy === 'function') {
                charts[key].destroy();
                delete charts[key];
            }
        });
        // Limpiar contenedores
        const chartIds = [
            'patrimonioChart','assetsPieChart','assetsVsLiabilitiesChart',
            'liquidoChart','inversionesChart','liabilitiesChart','liabilityTrendChart',
            'incomeChart','expensesChart','expensesPieChart',
            'growthRateChart','invGrowthRateChart','incomeVsExpenseChart',
            'projectionChart','ratiosRadarChart','ratiosTrendChart',
            'jarrasBarChart','jarrasMonthlyChart',
            'modecoIngresosChart','modecoGastosClasificacionChart',
            'modecoIngresosVsGastosChart','modecoWaterfallChart',
            'modecoBalanceChart','modecoBalanceEvolutionChart',
            'dbGastosTotalChart','dbGastosTopCurrentChart','budgetPreviewChart'
        ];
        chartIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
    }

    // === LAZY RENDER ===
    let renderedTabs = new Set();

    function invalidateRenderedTabs() {
        renderedTabs.clear();
    }

    function renderTabContent(tabId) {
        switch(tabId) {
            case 'overview': renderOverview(); break;
            case 'assets': renderAssets(); break;
            case 'liabilities': renderLiabilities(); break;
            case 'income': renderIncome(); renderDailySupabase('ingresos'); break;
            case 'expenses': renderExpenses(); renderDailySupabase('gastos'); break;
            case 'analytics': renderAnalytics(); break;
            case 'ratios': break; // Los ratios se manejan en renderChartsForTab
            case 'db-gastos': renderDBGastosTab(); break;
            case 'jarras': renderJarrasTab(); break;
            case 'modeco': renderModecoTab(); break;
            case 'budget': setTimeout(initBudgetEditor, 100); break;

        }
    }

    function renderAll() {
        // Solo overview al inicio. El resto se renderiza bajo demanda.
        renderOverview();
        const activeTab = document.querySelector('.section.active')?.id || 'overview';
        renderedTabs.add(activeTab);
        if (activeTab === 'overview') {
            renderChartsForTab('overview');
        }
    }


    async function refreshData() {
        document.getElementById('loading').classList.remove('hidden');
        destroyAllCharts();
        invalidateRenderedTabs();
        // Limpiar cache forzando carga fresca
        localStorage.removeItem(BS_CACHE_KEY);
        modecoData = null;
        modecoLoadingPromise = null;
        await loadData();
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

// ============================================================================
// DB_GASTOS — TAB DE GASTOS/INGRESOS DETALLADOS POR CATEGORÍA (con jerarquía)
// Backend V2: solo suma categorías principales (nivel 1)
// ============================================================================

let gastosData = null;
let analyticsDbGastosLoading = false;
let ratiosDbGastosLoading = false;
let expenseDbGastosLoading = false;
let incomeDbGastosLoading = false;
let gastosDataLoadingPromise = null;
let gastoDetailChart = null;
let dbGastosFilter = 'gastos'; // 'gastos' | 'ingresos' | 'todos'

// === MAPA DE CATEGORÍAS (desde DB_CATEGORIAS) ===
const CAT_DB = {
  'AFI Reservas +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Abuela': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Accesorios': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Alcanza +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Accesorios (cargadores, auriculares)': {padre:'Tecnología y electrónica',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Accesorios de Viaje': {padre:'Viajes y ocio',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Acciones': {padre:'Inversiones financieras',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Actividades al aire libre': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:false},
  'Actividades de ocio': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Actividades extracurriculares': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:false},
  'Ahorro a corto plazo': {padre:'Ahorros',etiqueta:'Ahorros',tipo:'Gastos',nivel:2,esHoja:true},
  'Ahorro a largo plazo': {padre:'Ahorros',etiqueta:'Ahorros',tipo:'Gastos',nivel:2,esHoja:true},
  'Ahorro para eventos': {padre:'Ahorros',etiqueta:'Ahorros',tipo:'Gastos',nivel:2,esHoja:true},
  'Ahorro para grandes compras': {padre:'Ahorros',etiqueta:'Ahorros',tipo:'Gastos',nivel:2,esHoja:true},
  'Ahorros': {padre:'',etiqueta:'Ahorros',tipo:'Gastos',nivel:1,esHoja:false},
  'Alpha +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Alquiler de renta': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Amigos': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:true},
  'Aporte': {padre:'Iglesia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Articulo de oficina': {padre:'Otras compras',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Articulo para eventos': {padre:'Otras compras',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Ayuda': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:false},
  'Ayuda Individual': {padre:'Ayuda',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Bancos +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Bebidas': {padre:'Snacks y antojos',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Belleza': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Blanco y textiles': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Bodas': {padre:'Eventos',etiqueta:'Eventos',tipo:'Ingresos',nivel:2,esHoja:true},
  'Boliche': {padre:'Actividades al aire libre',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Bonos': {padre:'Inversiones financieras',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Calzado': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Carnes y pescados': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Casa Raquel RD': {padre:'Trabajo',etiqueta:'Trabajo',tipo:'Ingresos',nivel:2,esHoja:true},
  'Casa Raquel RD -': {padre:'Otroo',etiqueta:'Otros',tipo:'Gastos',nivel:3,esHoja:true},
  'Cereales y granos': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Certificaciones y diplomados': {padre:'Cursos y talleres',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Certificado Banreserva +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Cesar Iglesias +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Cheques, cupones': {padre:'',etiqueta:'Cheques, cupones',tipo:'Ingresos',nivel:1,esHoja:true},
  'Cine': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Clases de Música': {padre:'',etiqueta:'Clases de Música',tipo:'Ingresos',nivel:1,esHoja:false},
  'Clases de música, danza o arte': {padre:'Mon Amour',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Clases recreativas': {padre:'Hobbies y pasatiempos',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Cocina y mesa': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Colmado': {padre:'Comida fuera',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Comida': {padre:'',etiqueta:'Comida',tipo:'Gastos',nivel:1,esHoja:false},
  'Comida casual (cafes, bistros, etc)': {padre:'Comida fuera',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Comida especial': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Comida fuera': {padre:'Comida',etiqueta:'Comida',tipo:'Gastos',nivel:2,esHoja:false},
  'Comida para llevar': {padre:'Comida fuera',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Comida rápida': {padre:'Comida fuera',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Comisiones': {padre:'Otroo',etiqueta:'Otros',tipo:'Gastos',nivel:3,esHoja:true},
  'Comisiones bancarias': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Comisiones de corretaje': {padre:'Inversiones financiera',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Componentes (memorias, disco duros)': {padre:'Tecnología y electrónica',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Compras': {padre:'',etiqueta:'Compras',tipo:'Gastos',nivel:1,esHoja:false},
  'Compras especiales': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:true},
  'Compras mensuales': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:true},
  'Concho': {padre:'Transporte público',etiqueta:'Transporte',tipo:'Gastos',nivel:3,esHoja:true},
  'Conciertos': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Cruceros': {padre:'Viajes de entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Cryptomonedas': {padre:'Inversiones financieras',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Cuadernos y papelería': {padre:'Materiales educativos',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Cumpleaños': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Cuotas de tarjetas de crédito': {padre:'Deudas y créditos',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Cursos': {padre:'Matrícula y colegiaturas',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Cursos en línea': {padre:'Cursos y talleres',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Cursos presenciales': {padre:'Cursos y talleres',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Cursos y talleres': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:false},
  'Decoracion': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Deudas y créditos': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Developer': {padre:'',etiqueta:'Developer',tipo:'Ingresos',nivel:1,esHoja:true},
  'Dinero Prestado': {padre:'Intereses',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Dispositivos (moviles, laptops, tablets)': {padre:'Tecnología y electrónica',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Donativos': {padre:'',etiqueta:'Donativos',tipo:'Gastos',nivel:1,esHoja:false},
  'Dulces y postres': {padre:'Snacks y antojos',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'ETFs': {padre:'Inversiones financieras',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Educacion': {padre:'',etiqueta:'Educacion',tipo:'Gastos',nivel:1,esHoja:false},
  'Electrodomesticos': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Emely': {padre:'Trabajo',etiqueta:'Trabajo',tipo:'Ingresos',nivel:2,esHoja:true},
  'Enlatados y conservas': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Ensayos': {padre:'Eventos',etiqueta:'Eventos',tipo:'Ingresos',nivel:2,esHoja:true},
  'Entretenimiento': {padre:'',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:1,esHoja:false},
  'Envío Carro': {padre:'Otros servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Envío Motor': {padre:'Otros servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Equipaje': {padre:'Viajes y ocio',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Equipos y herramientas para negocio': {padre:'Negocios',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Escapadas de fin de semana': {padre:'Viajes de entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Escuelas': {padre:'Matrícula y colegiaturas',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Eventos': {padre:'',etiqueta:'Eventos',tipo:'Ingresos',nivel:1,esHoja:false},
  'Eventos Cristianos': {padre:'Eventos',etiqueta:'Eventos',tipo:'Ingresos',nivel:2,esHoja:true},
  'Eventos en casa': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:false},
  'Excursiones y campamentos': {padre:'Actividades extracurriculares',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Expansión de operaciones': {padre:'Negocios',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Familia': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:false},
  'Fondo de Fondos Altio +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Fondo de emergencia': {padre:'Ahorros',etiqueta:'Ahorros',tipo:'Gastos',nivel:2,esHoja:true},
  'Fondos mutuos': {padre:'Inversiones financieras',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Frutas y verduras': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Gas': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Gastos': {padre:'',etiqueta:'Gastos',tipo:'Gastos',nivel:1,esHoja:true},
  'Gastos financieros': {padre:'',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:1,esHoja:false},
  'Gym': {padre:'Salud y bienestar',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Haina Investment 2034 +': {padre:'Inversiones',etiqueta:'Investment',tipo:'Ingresos',nivel:2,esHoja:true},
  'Herramientas': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Hipotecas': {padre:'Intereses',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Hobbies': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Hobbies y pasatiempos': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:false},
  'Hogar': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Hogar servicios': {padre:'Servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:2,esHoja:false},
  'Horas extras': {padre:'Trabajo',etiqueta:'Trabajo',tipo:'Ingresos',nivel:2,esHoja:true},
  'Iglesia': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:false},
  'Iglesias': {padre:'',etiqueta:'Iglesias',tipo:'Ingresos',nivel:1,esHoja:true},
  'Impuestos': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Impuestos otros': {padre:'Otroo',etiqueta:'Otros',tipo:'Gastos',nivel:3,esHoja:true},
  'Impuestos sobre la renta': {padre:'Impuestos',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Ingresos': {padre:'',etiqueta:'Ingresos',tipo:'Ingresos',nivel:1,esHoja:true},
  'Instalacion': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Instrumento Musical': {padre:'Hobbies',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Intereses': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Intereses, dividendos': {padre:'',etiqueta:'Intereses, dividendos',tipo:'Ingresos',nivel:1,esHoja:true},
  'Internet': {padre:'Tecnología y comunicaciones',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Inversión': {padre:'',etiqueta:'Inversión',tipo:'Gastos',nivel:1,esHoja:true},
  'Inversiones': {padre:'',etiqueta:'Investment',tipo:'Ingresos',nivel:1,esHoja:false},
  'Inversiones financiera': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Inversiones financieras': {padre:'Inversiones',etiqueta:'Inversión',tipo:'Gastos',nivel:2,esHoja:false},
  'JRFPFFAA': {padre:'Trabajo',etiqueta:'Trabajo',tipo:'Ingresos',nivel:2,esHoja:true},
  'Jardín y exteriores': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Juegos': {padre:'Actividades al aire libre',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Juegos de mesa o karaoke': {padre:'Eventos en casa',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Junior y Johanny': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Larga distancia': {padre:'Transporte',etiqueta:'Transporte',tipo:'Gastos',nivel:2,esHoja:true},
  'Libros y manuales': {padre:'Materiales educativos',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Limpieza': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Luz': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Lácteos y huevos': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Mami': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Mantenimiento': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Mantenimiento de cuentas': {padre:'Comisiones bancarias',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Maquillaje': {padre:'Belleza',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Material de arte': {padre:'Otras compras',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Materiales de arte y diseño': {padre:'Materiales educativos',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Materiales educativos': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:false},
  'Matrícula y colegiaturas': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:false},
  'Medicamentos': {padre:'Salud',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Memorial': {padre:'Eventos',etiqueta:'Eventos',tipo:'Ingresos',nivel:2,esHoja:true},
  'Metro': {padre:'Transporte público',etiqueta:'Transporte',tipo:'Gastos',nivel:3,esHoja:true},
  'Misiones': {padre:'Iglesia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Mon Amour': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:false},
  'Motor': {padre:'Transporte privado',etiqueta:'Transporte',tipo:'Gastos',nivel:3,esHoja:true},
  'Muebles': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Multas y recargos': {padre:'Impuestos',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Music Class': {padre:'Clases de Música',etiqueta:'Clases de Música',tipo:'Ingresos',nivel:2,esHoja:true},
  'Negocios': {padre:'Inversiones',etiqueta:'Inversión',tipo:'Gastos',nivel:2,esHoja:false},
  'Ofrenda': {padre:'Iglesia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Omsa': {padre:'Transporte público',etiqueta:'Transporte',tipo:'Gastos',nivel:3,esHoja:true},
  'Organización y almacenamiento': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Otras compras': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Otro Familiar': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Otroo': {padre:'Otros',etiqueta:'Otros',tipo:'Gastos',nivel:2,esHoja:false},
  'Otros': {padre:'',etiqueta:'Otros',tipo:'Gastos',nivel:1,esHoja:false},
  'Otros antojos': {padre:'Snacks y antojos',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Otros gastos relacionados': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:false},
  'Otros ingresos': {padre:'',etiqueta:'Otros Ingresos',tipo:'Ingresos',nivel:1,esHoja:true},
  'Otros productos': {padre:'Supermercado',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Otros servicios': {padre:'Servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:2,esHoja:false},
  'Pagos de capital de préstamos': {padre:'Deudas y créditos',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Papelería': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:true},
  'Papi': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Parques temáticos o de atracciones': {padre:'Salidas sociales',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Peluqueria y salon': {padre:'Salud y bienestar',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Prendas casuales': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Productos de cuidado personal': {padre:'Belleza',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Productos de higiene': {padre:'Salud',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Productos de limpieza': {padre:'Hogar',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Propina': {padre:'Ayuda',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Préstamos personales': {padre:'Intereses',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Publicidad y marketing': {padre:'Negocios',etiqueta:'Inversión',tipo:'Gastos',nivel:3,esHoja:true},
  'Puntos': {padre:'',etiqueta:'Puntos',tipo:'Ingresos',nivel:1,esHoja:true},
  'Pérdidas en inversiones': {padre:'Inversiones financiera',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Rachel': {padre:'Familia',etiqueta:'Donativos',tipo:'Gastos',nivel:3,esHoja:true},
  'Refinanciamientos': {padre:'Deudas y créditos',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Regalo': {padre:'Donativos',etiqueta:'Donativos',tipo:'Gastos',nivel:2,esHoja:true},
  'Regalos': {padre:'',etiqueta:'Regalos',tipo:'Ingresos',nivel:1,esHoja:true},
  'Reparaciones': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Restaurantes y cafés': {padre:'Salidas sociales',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Retiro en cajeros': {padre:'Comisiones bancarias',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Reuniones con amigos o familiares': {padre:'Eventos en casa',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Ropa de hombre': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Ropa de mujer': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Ropa formal': {padre:'Ropa y calzado',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Ropa y calzado': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Salidas sociales': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:false},
  'Salud': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Salud y bienestar': {padre:'Servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:2,esHoja:false},
  'Seguros': {padre:'Gastos financieros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:2,esHoja:false},
  'Seguros de préstamos': {padre:'Seguros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Seguros de tarjeta': {padre:'Seguros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Seguros de vida': {padre:'Seguros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Seguros médicos': {padre:'Salud y bienestar',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Seguros para inversiones': {padre:'Seguros',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Servicios': {padre:'',etiqueta:'Servicios',tipo:'Gastos',nivel:1,esHoja:false},
  'Servicios de mudanza': {padre:'Hogar servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Servicios financieros': {padre:'Otros servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Servicios legales': {padre:'Otros servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Servicios tecnologicos': {padre:'Tecnología y comunicaciones',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Snacks salados': {padre:'Snacks y antojos',etiqueta:'Comida',tipo:'Gastos',nivel:3,esHoja:true},
  'Snacks y antojos': {padre:'Comida',etiqueta:'Comida',tipo:'Gastos',nivel:2,esHoja:false},
  'Software educativo': {padre:'Materiales educativos',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Summer Work': {padre:'Otroo',etiqueta:'Otros',tipo:'Gastos',nivel:3,esHoja:true},
  'Supermercado': {padre:'Comida',etiqueta:'Comida',tipo:'Gastos',nivel:2,esHoja:false},
  'Suplementos': {padre:'Salud',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
  'Suscripciones a plataformas de inversión': {padre:'Inversiones financiera',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Suscripciones o recursos educativos en línea': {padre:'Otros gastos relacionados',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Tarjetas de crédito': {padre:'Intereses',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Taxi': {padre:'Transporte privado',etiqueta:'Transporte',tipo:'Gastos',nivel:3,esHoja:true},
  'Teatro': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:true},
  'Tecnología y comunicaciones': {padre:'Servicios',etiqueta:'Servicios',tipo:'Gastos',nivel:2,esHoja:false},
  'Tecnología y electrónica': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Telefonía': {padre:'Tecnología y comunicaciones',etiqueta:'Servicios',tipo:'Gastos',nivel:3,esHoja:true},
  'Tours turísticos': {padre:'Viajes de entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:3,esHoja:true},
  'Trabajo': {padre:'',etiqueta:'Trabajo',tipo:'Ingresos',nivel:1,esHoja:false},
  'Transferencia': {padre:'Otroo',etiqueta:'Otros',tipo:'Gastos',nivel:3,esHoja:true},
  'Transferencias internacionales': {padre:'Comisiones bancarias',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Transferencias nacionales': {padre:'Comisiones bancarias',etiqueta:'Gastos financieros',tipo:'Gastos',nivel:3,esHoja:true},
  'Transporte': {padre:'',etiqueta:'Transporte',tipo:'Gastos',nivel:1,esHoja:false},
  'Transporte privado': {padre:'Transporte',etiqueta:'Transporte',tipo:'Gastos',nivel:2,esHoja:false},
  'Transporte público': {padre:'Transporte',etiqueta:'Transporte',tipo:'Gastos',nivel:2,esHoja:false},
  'Tutorías': {padre:'Otros gastos relacionados',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Universidad': {padre:'Educacion',etiqueta:'Educacion',tipo:'Gastos',nivel:2,esHoja:true},
  'Universidades': {padre:'Matrícula y colegiaturas',etiqueta:'Educacion',tipo:'Gastos',nivel:3,esHoja:true},
  'Vehículos, propiedades': {padre:'Inversiones',etiqueta:'Inversión',tipo:'Gastos',nivel:2,esHoja:true},
  'Viajes': {padre:'Transporte',etiqueta:'Transporte',tipo:'Gastos',nivel:2,esHoja:true},
  'Viajes de entretenimiento': {padre:'Entretenimiento',etiqueta:'Entretenimiento',tipo:'Gastos',nivel:2,esHoja:false},
  'Viajes y ocio': {padre:'Compras',etiqueta:'Compras',tipo:'Gastos',nivel:2,esHoja:false},
  'Vitaminas': {padre:'Salud',etiqueta:'Compras',tipo:'Gastos',nivel:3,esHoja:true},
};

// Colores por Etiqueta Principal (categoría raíz visual)
const ETIQUETA_COLORS = {
  'Comida': '#f44336',
  'Compras': '#4fc3f7',
  'Transporte': '#78909c',
  'Servicios': '#536dfe',
  'Gastos financieros': '#00bfa5',
  'Otros': '#ff9900',
  'Donativos': '#ec407a',
  'Educacion': '#2e7d32',
  'Entretenimiento': '#4db6ac',
  'Ahorros': '#64dd17',
  'Inversión': '#ff1744',
  'Trabajo': '#fbc02d',
  'Clases de Música': '#fbc02d',
  'Eventos': '#fbc02d',
  'Iglesias': '#fbc02d8',
  'Developer': '#fbc02d',
  'Cheques, cupones': '#fbc02d',
  'Regalos': '#fbc02d',
  'Puntos': '#fbc02d',
  'Intereses, dividendos': '#fbc02d',
  'Investment': '#fbc02d',
  'Otros Ingresos': '#fbc02d'
};

function getCatMeta(nombre) {
  return CAT_DB[nombre] || { padre: '', etiqueta: 'General', tipo: 'Gastos', nivel: 1, esHoja: true };
}

function getEtiquetaColor(etiqueta) {
  return ETIQUETA_COLORS[etiqueta] || '#ff1744';
}

// === HELPERS DE FILTRADO ===
function filterCatsByTipo(catsEntries, tipo) {
  if (tipo === 'todos') return catsEntries;
  return catsEntries.filter(([name, data]) => {
    const catTipo = (getCatMeta(name).tipo || '').toLowerCase();
    return catTipo === tipo;
  });
}

function getTipoLabel(t) {
  return t === 'gastos' ? 'Gastos' : t === 'ingresos' ? 'Ingresos' : 'Todas';
}

function getTipoColor(t) {
  return t === 'gastos' ? '#ef4444' : t === 'ingresos' ? '#22c55e' : '#3b82f6';
}

// === CARGA LAZY DE DATOS ===
function loadGastosData() {
  if (gastosData) return Promise.resolve(gastosData);
  if (gastosDataLoadingPromise) return gastosDataLoadingPromise;
  gastosDataLoadingPromise = new Promise((resolve, reject) => {
    const callbackName = 'gastosCallback_' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      gastosDataLoadingPromise = null;
      reject(new Error('Timeout JSONP (getGastos)'));
      cleanup();
    }, 30000);

    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[callbackName];
      clearTimeout(timeout);
    }

    window[callbackName] = (data) => {
      if (data && data.error) {
        gastosDataLoadingPromise = null;
        reject(new Error(data.message));
      } else {
        gastosData = data;
        gastosDataLoadingPromise = null;
        resolve(data);
      }
      cleanup();
    };

    script.onerror = () => {
      gastosDataLoadingPromise = null;
      reject(new Error('Error de red JSONP (getGastos)'));
      cleanup();
    };

    const url = CONFI.API_URL + '?action=getGastos&callback=' + callbackName;
    script.src = url;
    document.head.appendChild(script);
  });
  return gastosDataLoadingPromise;
}

async function renderDBGastosTab() {
  if (!gastosData) {
    try {
      await loadGastosData();
    } catch (e) {
      console.error('Error cargando DB_GASTOS:', e);
      document.getElementById('dbGastosStats').innerHTML =
        '<div class="stat-card" style="grid-column:1/-1"><div class="stat-value" style="font-size:16px;color:#f87171">Error: ' + e.message + '</div></div>';
      return;
    }
  }
  renderDBGastos();
}

function renderDBGastos() {
  if (!gastosData) return;
  const meta = gastosData.metadata;
  document.getElementById('dbGastosMeta').textContent =
    `${meta.totalMonths} meses · ${meta.totalPrincipales} principales · ${meta.totalCategories} subcategorías · Actualizado: ${meta.lastUpdate}`;

  renderDBGastosStats();
  renderDBGastosTotalChart();
  renderDBGastosTopCurrentChart();
  renderDBGastosAllCategories();
}

// === STATS: usa gasto/ingreso separados del backend (solo principales) ===
function renderDBGastosStats() {
  const r = gastosData.resumen;
  const mAct = r.mesActual || { gasto: 0, ingreso: 0, total: 0, mes: '—' };
  const mAnt = r.mesAnterior || { gasto: 0, ingreso: 0, total: 0, mes: '—' };

  const cambioGasto = mAct.gasto - mAnt.gasto;
  const cambioGastoPct = mAnt.gasto > 0 ? (cambioGasto / mAnt.gasto) * 100 : 0;
  const balanceNeto = mAct.ingreso - mAct.gasto;

  // Promedios desde totalPorMes (ya solo principales)
  const tp = r.totalPorMes || [];
  const avgGasto = tp.length > 0 ? tp.reduce((a, b) => a + b.gasto, 0) / tp.length : 0;
  const avgIngreso = tp.length > 0 ? tp.reduce((a, b) => a + b.ingreso, 0) / tp.length : 0;

  // Categorías activas (principales con current > 0)
  const principales = Object.entries(gastosData.categorias).filter(([name]) => {
    const meta = getCatMeta(name);
    return !meta.padre; // nivel 1 = sin padre
  });
  const gastosActivos = principales.filter(([name, d]) => getCatMeta(name).tipo === 'Gastos' && (d.current || 0) > 0).length;
  const ingresosActivos = principales.filter(([name, d]) => getCatMeta(name).tipo === 'Ingresos' && (d.current || 0) > 0).length;

  const html = `
    <div class="stat-card" style="border-top:3px solid #ef4444">
      <div class="stat-header"><span class="stat-label">Gasto Mes Actual</span></div>
      <div class="stat-value" style="color:#f87171">${fmtMoney(mAct.gasto)}</div>
      <div class="stat-sub">${mAct.mes} · Solo categorías principales</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #22c55e">
      <div class="stat-header"><span class="stat-label">Ingreso Mes Actual</span></div>
      <div class="stat-value" style="color:#4ade80">${fmtMoney(mAct.ingreso)}</div>
      <div class="stat-sub">${mAct.mes} · Solo categorías principales</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #3b82f6">
      <div class="stat-header"><span class="stat-label">Balance Neto</span></div>
      <div class="stat-value" style="color:${balanceNeto >= 0 ? '#4ade80' : '#f87171'}">${fmtMoney(balanceNeto)}</div>
      <div class="stat-sub">Ingresos − Gastos (principales)</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #f59e0b">
      <div class="stat-header"><span class="stat-label">Variación Gasto MoM</span></div>
      <div class="stat-value" style="color:${cambioGasto > 0 ? '#f87171' : '#4ade80'}">${cambioGasto > 0 ? '+' : ''}${fmtMoney(cambioGasto)}</div>
      <div class="stat-sub">${cambioGastoPct > 0 ? '▲' : '▼'} ${Math.abs(cambioGastoPct).toFixed(1)}% vs ${mAnt.mes}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #8b5cf6">
      <div class="stat-header"><span class="stat-label">Promedio Mensual</span></div>
      <div class="stat-value">${fmtMoney(avgGasto)}</div>
      <div class="stat-sub">Gasto · ${fmtMoney(avgIngreso)} ingreso (principales)</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #0ea5e9">
      <div class="stat-header"><span class="stat-label">Categorías Activas</span></div>
      <div class="stat-value">${gastosActivos + ingresosActivos}</div>
      <div class="stat-sub">${gastosActivos} gastos · ${ingresosActivos} ingresos (principales)</div>
    </div>
  `;
  document.getElementById('dbGastosStats').innerHTML = html;
}

function renderDBGastosTotalChart() {
  const ctx = getCanvas('dbGastosTotalChart');
  if (!ctx) return;

  if (charts.dbGastosTotal) { charts.dbGastosTotal.destroy(); }
    
    const data = (gastosData.resumen.totalPorMes || []).map(d => ({
        date: formatShortDate(d.isoDate || d.mes),
        gasto: d.gasto || 0,
        ingreso: d.ingreso || 0
    }));

    charts.dbGastosTotal = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.date),
      datasets: [
        {
          label: 'Gastos',
          data: data.map(d => d.gasto),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5
        },
        {
          label: 'Ingresos',
          data: data.map(d => d.ingreso),
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.08)',
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
          titleColor: '#e2e8f0', bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)', borderWidth: 1,
          callbacks: {
            label: (ctx) => ctx.dataset.label + ': RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
          }
        }
      },
      scales: {
        x: { type: 'category', grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 10 } },
        y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
      }
    }
  });
}

function renderDBGastosTopCurrentChart() {
  const ctx = getCanvas('dbGastosTopCurrentChart');
  if (!ctx) return;

  if (charts.dbGastosTop) { charts.dbGastosTop.destroy(); }

    const topGastos = Object.entries(gastosData.categorias)
        .filter(([name, data]) => {
            const meta = getCatMeta(name);
            return !meta.padre && meta.tipo === 'Gastos' && data.current > 0;
        })
        .sort((a, b) => b[1].current - a[1].current)
        .slice(0, 15);

  document.getElementById('dbGastosTopCurrentSub').textContent =
    (gastosData.resumen.mesActual?.mes || '') + ' · Categorías Principales';

  // Ajustar altura según cantidad de items y si es mobile
  const isMobile = window.innerWidth <= 640;
  const chartHeight = isMobile ? Math.max(320, topGastos.length * 32) : 300;
  const chartContainer = document.getElementById('dbGastosTopCurrentChart');
  if (chartContainer) {
    chartContainer.style.height = chartHeight + 'px';
  }

  charts.dbGastosTop = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: topGastos.map(([name]) => name),
      datasets: [{
        label: 'Gasto Actual',
        data: topGastos.map(([, d]) => d.current),
        backgroundColor: topGastos.map(([name]) => {
          const meta = getCatMeta(name);
          return getEtiquetaColor(meta.etiqueta);
        }),
        borderRadius: 6,
        barPercentage: 0.7,
        categoryPercentage: 0.8
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          left: 0,
          right: isMobile ? 60 : 80, // espacio para el valor al final de la barra
          top: 10,
          bottom: 10
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0', bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)', borderWidth: 1,
          callbacks: {
            label: (ctx) => 'RD$ ' + ctx.parsed.x.toLocaleString('es-DO', {minimumFractionDigits: 2})
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(51,65,85,0.2)' },
          ticks: {
            color: '#64748b',
            font: { size: isMobile ? 9 : 10 },
            callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K',
            maxRotation: 0
          },
          border: { display: false }
        },
        y: {
          grid: { display: false },
          ticks: {
            color: '#94a3b8',
            font: { size: isMobile ? 11 : 12, weight: '600' },
            // Truncar labels largos en mobile
            callback: function(value, index, values) {
              const label = this.getLabelForValue(value);
              if (!label) return '';
              if (isMobile && label.length > 14) {
                return label.substring(0, 12) + '…';
              }
              return label;
            }
          },
          border: { display: false }
        }
      }
    }
  });
}


// ============================================================================
// DB_GASTOS — LISTA COMPLETA CON TODAS LAS SUBCATEGORÍAS
// ============================================================================

function renderDBGastosAllCategories() {
  const container = document.getElementById('dbGastosAllCategories');
  // TODAS las categorías (principales + subcategorías)
  const allCats = Object.entries(gastosData.categorias).sort((a, b) => b[1].current - a[1].current);
  const maxVal = Math.max(...allCats.map(([, c]) => c.current), 1);

  const tipoColor = getTipoColor(dbGastosFilter);
  const filterHtml = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      <button onclick="setDBGastosFilter('gastos')" class="db-filter-btn ${dbGastosFilter === 'gastos' ? 'active' : ''}" data-filter="gastos">🔴 Gastos</button>
      <button onclick="setDBGastosFilter('ingresos')" class="db-filter-btn ${dbGastosFilter === 'ingresos' ? 'active' : ''}" data-filter="ingresos">🟢 Ingresos</button>
      <button onclick="setDBGastosFilter('todos')" class="db-filter-btn ${dbGastosFilter === 'todos' ? 'active' : ''}" data-filter="todos">🔵 Todos</button>
      <span style="margin-left:auto;font-size:12px;color:#64748b;font-weight:600;align-self:center;">
        Mostrando: <span style="color:${tipoColor}">${getTipoLabel(dbGastosFilter)}</span> · Todas las categorías
      </span>
    </div>
  `;

  function buildList(filterText = '') {
    const fLower = filterText.toLowerCase();
    let filtered = filterCatsByTipo(allCats, dbGastosFilter).filter(([name, data]) => {
      const meta = getCatMeta(name);
      return name.toLowerCase().includes(fLower) ||
             (meta.etiqueta && meta.etiqueta.toLowerCase().includes(fLower)) ||
             (meta.padre && meta.padre.toLowerCase().includes(fLower));
    });

    if (filtered.length === 0) {
      return '<div style="color:#64748b;text-align:center;padding:24px;">Sin resultados</div>';
    }

    // Agrupar por etiqueta principal
    const grupos = {};
    filtered.forEach(([name, data]) => {
      const meta = getCatMeta(name);
      const key = meta.etiqueta || 'General';
      if (!grupos[key]) grupos[key] = [];
      grupos[key].push({ name, data, meta });
    });

    // Ordenar grupos por total del grupo
    const grupoEntries = Object.entries(grupos).sort((a, b) => {
      const sumA = a[1].reduce((s, c) => s + c.data.current, 0);
      const sumB = b[1].reduce((s, c) => s + c.data.current, 0);
      return sumB - sumA;
    });

    let html = '';
    grupoEntries.forEach(([etiqueta, items]) => {
      const color = getEtiquetaColor(etiqueta);
      const grupoTotal = items.reduce((s, c) => s + c.data.current, 0);

      // Separar principales y subcategorías
      const principales = items.filter(c => !c.meta.padre);
      const subcats = items.filter(c => c.meta.padre);

      html += `
        <div style="margin-bottom:4px;padding:10px 12px;background:rgba(15,23,42,0.6);border-radius:10px 10px 0 0;border-left:3px solid ${color};margin-top:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:12px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.08em;">${etiqueta}</span>
            <span style="font-size:11px;color:#64748b;font-weight:600;">${items.length} cat · ${fmtMoney(grupoTotal)}</span>
          </div>
        </div>
      `;

      html += `<div class="asset-list" style="margin-bottom:12px;">`;

      // Primero las principales (sin padre)
      principales.forEach(({name, data, meta}) => {
        const pct = (data.current / maxVal) * 100;
        const isGasto = meta.tipo === 'Gastos';
        const changeColor = data.change > 0 ? (isGasto ? '#f87171' : '#4ade80') : (isGasto ? '#4ade80' : '#f87171');
        const changeIcon = data.change > 0 ? '▲' : data.change < 0 ? '▼' : '—';
        const tipoBadge = meta.tipo === 'Ingresos' ? `<span style="display:inline-block;padding:1px 6px;background:rgba(34,197,94,0.15);border-radius:4px;font-size:10px;color:#4ade80;margin-left:6px;">IN</span>` : '';
        const principalBadge = `<span style="display:inline-block;padding:1px 6px;background:${color}30;border-radius:4px;font-size:10px;color:${color};margin-left:6px;font-weight:700;">PRINCIPAL</span>`;

        html += `
          <div class="asset-item" style="cursor:pointer;border-radius:0;background:rgba(30,41,59,0.7);" onclick="openGastoModal('${name.replace(/'/g, "\\'")}')">
            <div class="asset-icon-wrap" style="background:${color}25;color:${color};font-size:14px;width:44px;height:44px;">●</div>
            <div class="asset-info">
              <div class="asset-name">${name}${principalBadge}${tipoBadge}</div>
              <div class="asset-meta">
                Total hist: ${fmtMoney(data.total)} · 
                <span style="color:${changeColor}">${changeIcon} ${Math.abs(data.changePct).toFixed(1)}%</span> vs ant.
              </div>
              <div class="asset-progress">
                <div class="asset-progress-fill" style="width:${pct}%;background:${color}"></div>
              </div>
            </div>
            <div class="asset-value">
              <div class="asset-amount">${fmtMoney(data.current)}</div>
              <div class="asset-pct" style="color:${changeColor};font-size:11px">
                ${data.previous > 0 ? ((data.current/data.previous)*100).toFixed(0) + '% del ant.' : '—'}
              </div>
            </div>
          </div>
        `;
      });

      // Luego las subcategorías (con padre)
      subcats.forEach(({name, data, meta}) => {
        const pct = (data.current / maxVal) * 100;
        const isGasto = meta.tipo === 'Gastos';
        const changeColor = data.change > 0 ? (isGasto ? '#f87171' : '#4ade80') : (isGasto ? '#4ade80' : '#f87171');
        const changeIcon = data.change > 0 ? '▲' : data.change < 0 ? '▼' : '—';
        const tipoBadge = meta.tipo === 'Ingresos' ? `<span style="display:inline-block;padding:1px 6px;background:rgba(34,197,94,0.15);border-radius:4px;font-size:10px;color:#4ade80;margin-left:6px;">IN</span>` : '';
        const padreTag = meta.padre ? `<span style="display:inline-block;padding:1px 6px;background:rgba(51,65,85,0.4);border-radius:4px;font-size:10px;color:#94a3b8;margin-left:6px;">${meta.padre}</span>` : '';

        html += `
          <div class="asset-item" style="cursor:pointer;border-radius:0;padding-left:28px;" onclick="openGastoModal('${name.replace(/'/g, "\\'")}')">
            <div class="asset-icon-wrap" style="background:${color}15;color:${color}90;font-size:12px;width:36px;height:36px;">└</div>
            <div class="asset-info">
              <div class="asset-name">${name}${padreTag}${tipoBadge}</div>
              <div class="asset-meta">
                Total hist: ${fmtMoney(data.total)} · 
                <span style="color:${changeColor}">${changeIcon} ${Math.abs(data.changePct).toFixed(1)}%</span> vs ant.
              </div>
              <div class="asset-progress">
                <div class="asset-progress-fill" style="width:${pct}%;background:${color}80"></div>
              </div>
            </div>
            <div class="asset-value">
              <div class="asset-amount" style="font-size:14px;">${fmtMoney(data.current)}</div>
              <div class="asset-pct" style="color:${changeColor};font-size:10px">
                ${data.previous > 0 ? ((data.current/data.previous)*100).toFixed(0) + '% del ant.' : '—'}
              </div>
            </div>
          </div>
        `;
      });

      html += `</div>`;
    });
    return html;
  }

  container.innerHTML = filterHtml + buildList();

  const search = document.getElementById('dbGastosSearch');
  if (search) {
    search.addEventListener('input', (e) => {
      const btns = container.querySelector('.db-filter-btn')?.parentElement?.outerHTML || filterHtml;
      container.innerHTML = btns + buildList(e.target.value);
    });
  }
}


function setDBGastosFilter(tipo) {
  dbGastosFilter = tipo;
  renderDBGastosAllCategories();
}

// === MODAL DETALLE CATEGORÍA ===
function openGastoModal(name) {
  const modal = document.getElementById('gastoDetailModal');
  const title = document.getElementById('gastoModalTitle');
  const cat = gastosData.categorias[name];
  if (!cat) return;

  const meta = getCatMeta(name);
  const tipoBadge = meta.tipo === 'Ingresos'
    ? '<span style="display:inline-block;padding:2px 8px;background:rgba(34,197,94,0.15);border-radius:4px;font-size:11px;color:#4ade80;margin-left:8px;">INGRESO</span>'
    : '<span style="display:inline-block;padding:2px 8px;background:rgba(239,68,68,0.15);border-radius:4px;font-size:11px;color:#f87171;margin-left:8px;">GASTO</span>';

  const breadcrumb = `<span style="font-size:12px;color:#64748b;font-weight:500;">${meta.etiqueta} › </span><span style="font-size:14px;color:#f8fafc;font-weight:700;">${name}</span>${tipoBadge}`;

  title.innerHTML = breadcrumb;
  modal.classList.add('active');
  renderGastoDetailChart(name, cat, meta);
  renderGastoBreakdown(name, cat, meta);
}

function closeGastoModal() {
  document.getElementById('gastoDetailModal').classList.remove('active');
  if (gastoDetailChart) {
    gastoDetailChart.destroy();
    gastoDetailChart = null;
  }
}

function renderGastoDetailChart(name, cat, meta) {
  const ctx = document.getElementById('gastoDetailChart');
  if (!ctx) return;
  if (gastoDetailChart) gastoDetailChart.destroy();

  const history = (cat.history || []).map(d => ({
    date: formatShortDate(d.isoDate || d.mes),
    value: d.value
  }));

  if (history.length === 0) { ctx.style.display = 'none'; return; }
  ctx.style.display = 'block';

  const color = meta.tipo === 'Ingresos' ? '#22c55e' : getEtiquetaColor(meta.etiqueta);

  gastoDetailChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: history.map(d => d.date),
      datasets: [{
        label: name,
        data: history.map(d => d.value),
        borderColor: color,
        backgroundColor: color + '14',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0', bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)', borderWidth: 1,
          callbacks: {
            label: (ctx) => 'RD$ ' + ctx.parsed.y.toLocaleString('es-DO', {minimumFractionDigits: 2})
          }
        }
      },
      scales: {
        x: { type: 'category', grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 10 } },
        y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
      }
    }
  });
}

function renderGastoBreakdown(name, cat, meta) {
  const container = document.getElementById('gastoModalBreakdown');
  const current = cat.current || 0;
  const previous = cat.previous || 0;
  const change = cat.change || 0;
  const changePct = cat.changePct || 0;
  const total = cat.total || 0;
  const history = cat.history || [];
  const maxVal = history.length > 0 ? Math.max(...history.map(h => h.value)) : current;
  const minVal = history.length > 0 ? Math.min(...history.map(h => h.value)) : current;
  const avgVal = history.length > 0 ? history.reduce((a, b) => a + b.value, 0) / history.length : current;

  const isGasto = meta.tipo === 'Gastos';
  const changeColor = change > 0 ? (isGasto ? '#f87171' : '#4ade80') : (isGasto ? '#4ade80' : '#f87171');

  const jerarquia = `<div style="margin-bottom:14px;padding:8px 12px;background:rgba(51,65,85,0.2);border-radius:8px;font-size:12px;color:#94a3b8;">📂 ${meta.etiqueta} › <strong style="color:#f8fafc;">${name}</strong></div>`;

  container.innerHTML = jerarquia + `
    <div class="breakdown-item"><div class="name">Monto Actual</div><div class="value">${fmtMoney(current)}</div></div>
    <div class="breakdown-item"><div class="name">Monto Anterior</div><div class="value">${fmtMoney(previous)}</div></div>
    <div class="breakdown-item"><div class="name">Cambio Mensual</div><div class="value" style="color:${changeColor}">${change > 0 ? '+' : ''}${fmtMoney(change)}</div></div>
    <div class="breakdown-item"><div class="name">Variación %</div><div class="value" style="color:${changeColor}">${change > 0 ? '+' : ''}${changePct.toFixed(2)}%</div></div>
    <div class="breakdown-item"><div class="name">Máximo Histórico</div><div class="value" style="color:#f87171">${fmtMoney(maxVal)}</div></div>
    <div class="breakdown-item"><div class="name">Mínimo Histórico</div><div class="value" style="color:#4ade80">${fmtMoney(minVal)}</div></div>
    <div class="breakdown-item"><div class="name">Promedio Histórico</div><div class="value">${fmtMoney(avgVal)}</div></div>
    <div class="breakdown-item"><div class="name">Total Acumulado</div><div class="value" style="color:#f8fafc;font-weight:800">${fmtMoney(total)}</div></div>
    <div class="breakdown-total"><div class="name">PERÍODOS REGISTRADOS</div><div class="value">${history.length} meses</div></div>
  `;
}

// Cerrar modal con click fuera o Escape
document.addEventListener('click', function(e) {
  const modal = document.getElementById('gastoDetailModal');
  if (e.target === modal) closeGastoModal();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeGastoModal();
});

// ============================================================================
// EDITOR DE PRESUPUESTO — Ingresos definen el total disponible para Gastos
// ============================================================================

const INGRESOS_ACTIVO_IDS = ['14.1', '14.2', '14.4', '15', '16.1', '16.2', '16.3', '16.4', '17', '18', '19', '20', '22', '24'];
const INGRESOS_EXCLUIR_IDS = ['14', '16','23','21'];
const GASTOS_EXCLUIR_IDS = ['1','2'];

let budgetEditorData = null;
let budgetWorkingData = null;
let budgetFilter = 'gastos';
let budgetPreviewChart = null;

function getPresupuestoTipo(p) {
    const cleanId = String(p.id).replace(/^P/i, '');
    if (GASTOS_EXCLUIR_IDS.includes(cleanId)) return 'excluir';
    if (INGRESOS_EXCLUIR_IDS.includes(cleanId)) return 'excluir';
    if (INGRESOS_ACTIVO_IDS.includes(cleanId)) return 'ingresos_activo';
    if (p.tipo === 'Ingresos') return 'ingresos_otro';
    return 'gastos';
}
// === INICIALIZACIÓN ===
function initBudgetEditor() {
    if (!appData || !appData.presupuesto) return;
    
    const categorias = appData.categorias || [];
    const presupuesto = appData.presupuesto || [];
    const mesActual = formatDateToString(new Date());
    
    function procesarTipo(tipoFiltro) {
        let cats = presupuesto.filter(p => {
            const pTipo = getPresupuestoTipo(p);
            if (pTipo === 'excluir') return false;
            if (tipoFiltro === 'gastos') return pTipo === 'gastos';
            return pTipo.startsWith('ingresos');
        }).filter(p => !p.mesAno || formatDateToString(p.mesAno) === mesActual);
        
        if (cats.length === 0) {
            cats = presupuesto.filter(p => {
                const pTipo = getPresupuestoTipo(p);
                if (pTipo === 'excluir') return false;
                if (tipoFiltro === 'gastos') return pTipo === 'gastos';
                return pTipo.startsWith('ingresos');
            });
        }
        
        const grouped = {};
        cats.forEach(p => {
            const cat = categorias.find(c => String(c.id).trim() === String(p.id).trim().replace(/^P/i, ''));
            const nombre = cat ? (cat.nombre || cat.etiqueta) : 
                           (categorias.find(c => String(c.id).trim() === String(p.idCategoria).trim())?.nombre || 
                            'Item ' + p.id);
            const meta = getCatMeta(nombre);
            const cleanId = String(p.id).replace(/^P/i, '');
            const key = tipoFiltro === 'ingresos' ? (nombre + '|' + cleanId) : nombre;
            
            if (!grouped[key]) {
                grouped[key] = { 
                    id: p.id,
                    idCategoria: p.idCategoria,
                    nombre, 
                    presupuestado: 0,
                    real: 0,
                    etiqueta: meta.etiqueta || 'General',
                    tipo: tipoFiltro,
                    ids: []
                };
            }
            grouped[key].presupuestado += (p.montoPresupuestado || 0);
            grouped[key].real += (p.gastoReal || 0);
            grouped[key].ids.push(p.id);
        });
        
        if (tipoFiltro === 'gastos' && appData.gastos) {
            Object.entries(appData.gastos).forEach(([nombre, data]) => {
                if (grouped[nombre]) grouped[nombre].real = data.current || grouped[nombre].real;
            });
        }
        
        const items = Object.values(grouped).sort((a, b) => b.presupuestado - a.presupuestado);
        const total = items.reduce((s, i) => s + i.presupuestado, 0);
        
        items.forEach(item => {
            item.pct = total > 0 ? (item.presupuestado / total) * 100 : 0;
            item.nuevoMonto = item.presupuestado;
            item.nuevoPct = item.pct;
        });
        
        return { items, total };
    }
    
    budgetEditorData = {
        gastos: procesarTipo('gastos'),
        ingresos: procesarTipo('ingresos')
    };
    
    // ← NUEVO: Sincronizar total de gastos con ingresos al inicio
    syncGastosTotalWithIngresos();
    
    budgetWorkingData = JSON.parse(JSON.stringify(budgetEditorData));
    
    renderBudgetStats();
    renderBudgetEditor();
    renderBudgetPreviewChart();
}

// ← NUEVO: Sincronizar total de gastos con suma de ingresos
function syncGastosTotalWithIngresos() {
    const totalIngresos = budgetEditorData.ingresos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    budgetEditorData.gastos.total = totalIngresos;
    
    // Recalcular % de gastos basado en nuevo total
    budgetEditorData.gastos.items.forEach(item => {
        item.pct = totalIngresos > 0 ? (item.presupuestado / totalIngresos) * 100 : 0;
        item.nuevoPct = item.pct;
    });
}

function getActiveBudgetGroup() {
    return budgetWorkingData[budgetFilter];
}

// ← NUEVO: Obtener total de ingresos del working data
function getTotalIngresos() {
    return budgetWorkingData.ingresos.items.reduce((s, i) => s + i.nuevoMonto, 0);
}

function renderBudgetStats() {
    const group = getActiveBudgetGroup();
    const isGasto = budgetFilter === 'gastos';
    const items = group.items;
    const totalAsignado = items.reduce((s, i) => s + i.nuevoMonto, 0);
    const totalOriginal = items.reduce((s, i) => s + i.presupuestado, 0);
    const totalReal = items.reduce((s, i) => s + (i.real || 0), 0);
    const totalIngresos = getTotalIngresos();
    
    let html;
    if (isGasto) {
        const diferencia = group.total - totalAsignado;
        html = `
            <div class="stat-card" style="border-top:3px solid #3b82f6">
                <div class="stat-header"><span class="stat-label">Total Presupuesto</span></div>
                <div class="stat-value">${fmtMoney(group.total)}</div>
                <div class="stat-sub">= Ingresos totales: ${fmtMoney(totalIngresos)}</div>
            </div>
            <div class="stat-card" style="border-top:3px solid ${diferencia >= 0 ? '#22c55e' : '#ef4444'}">
                <div class="stat-header"><span class="stat-label">Por Asignar</span></div>
                <div class="stat-value" style="color:${diferencia >= 0 ? '#4ade80' : '#f87171'}">${fmtMoney(Math.abs(diferencia))}</div>
                <div class="stat-sub">${diferencia >= 0 ? 'Disponible' : 'Excedido'} para gastos</div>
            </div>
            <div class="stat-card" style="border-top:3px solid #f59e0b">
                <div class="stat-header"><span class="stat-label">Gasto Real</span></div>
                <div class="stat-value" style="color:#fbbf24">${fmtMoney(totalReal)}</div>
                <div class="stat-sub">vs ${fmtMoney(totalOriginal)} presupuestado</div>
            </div>
            <div class="stat-card" style="border-top:3px solid #8b5cf6">
                <div class="stat-header"><span class="stat-label">Categorías</span></div>
                <div class="stat-value">${items.length}</div>
                <div class="stat-sub">Categorías de gasto</div>
            </div>
        `;
    } else {
        html = `
            <div class="stat-card" style="border-top:3px solid #22c55e">
                <div class="stat-header"><span class="stat-label">Ingreso Total</span></div>
                <div class="stat-value" style="color:#4ade80">${fmtMoney(totalAsignado)}</div>
                <div class="stat-sub">Define el presupuesto de gastos</div>
            </div>
            <div class="stat-card" style="border-top:3px solid #3b82f6">
                <div class="stat-header"><span class="stat-label">Ingreso Real</span></div>
                <div class="stat-value">${fmtMoney(totalReal)}</div>
                <div class="stat-sub">vs ${fmtMoney(totalOriginal)} presupuestado anterior</div>
            </div>
            <div class="stat-card" style="border-top:3px solid #f59e0b">
                <div class="stat-header"><span class="stat-label">Variación</span></div>
                <div class="stat-value" style="color:${totalAsignado >= totalOriginal ? '#4ade80' : '#f87171'}">
                    ${totalAsignado >= totalOriginal ? '+' : ''}${fmtMoney(totalAsignado - totalOriginal)}
                </div>
                <div class="stat-sub">Nuevo vs presupuesto anterior</div>
            </div>
            <div class="stat-card" style="border-top:3px solid #8b5cf6">
                <div class="stat-header"><span class="stat-label">Fuentes</span></div>
                <div class="stat-value">${items.length}</div>
                <div class="stat-sub">Fuentes de ingreso</div>
            </div>
        `;
    }
    
    document.getElementById('budgetStats').innerHTML = html;
    document.getElementById('budgetTotalDisplay').textContent = isGasto ? fmtMoney(group.total) : fmtMoney(totalAsignado);
    document.getElementById('budgetTotalInput').value = isGasto 
        ? fmtMoney(group.total).replace('RD$', '').trim()
        : fmtMoney(totalAsignado).replace('RD$', '').trim();
}

function renderBudgetEditor() {
    const container = document.getElementById('budgetCategoriesList');
    const group = getActiveBudgetGroup();
    const isGasto = budgetFilter === 'gastos';
    const maxVal = Math.max(...group.items.map(i => Math.max(i.nuevoMonto, i.real || 0)), 1);
    
    const filterHtml = `
        <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
            <button onclick="setBudgetFilter('gastos')" class="db-filter-btn ${budgetFilter === 'gastos' ? 'active' : ''}" data-filter="gastos">🔴 Gastos</button>
            <button onclick="setBudgetFilter('ingresos')" class="db-filter-btn ${budgetFilter === 'ingresos' ? 'active' : ''}" data-filter="ingresos">🟢 Ingresos</button>
            <span style="margin-left:auto;font-size:12px;color:#64748b;font-weight:600;align-self:center;">
                Editando: <span style="color:${isGasto ? '#f87171' : '#4ade80'}">${isGasto ? 'Gastos' : 'Ingresos'}</span>
            </span>
        </div>
    `;
    
    const validationHtml = isGasto ? `
        <div class="budget-validation" id="budgetValidation">
            <span id="budgetValidationText">Suma: 100%</span>
            <div class="budget-validation-bar">
                <div class="budget-validation-fill" id="budgetValidationFill" style="width:100%"></div>
            </div>
        </div>
    ` : `
        <div class="budget-validation" id="budgetValidation" style="background:rgba(34,197,94,0.1);border-color:rgba(34,197,94,0.2);">
            <span id="budgetValidationText" style="color:#4ade80;">✅ Ingresos — El total define el presupuesto de gastos</span>
        </div>
    `;
    
    let html = filterHtml + validationHtml;
    
    group.items.forEach((item, idx) => {
        const color = getEtiquetaColor(item.etiqueta);
        const pct = isGasto && group.total > 0 ? (item.nuevoMonto / group.total) * 100 : 0;
        const diff = item.nuevoMonto - item.presupuestado;
        const diffColor = isGasto
            ? (diff > 0 ? '#f87171' : diff < 0 ? '#4ade80' : '#94a3b8')
            : (diff > 0 ? '#4ade80' : diff < 0 ? '#f87171' : '#94a3b8');
        const diffIcon = diff > 0 ? '▲' : diff < 0 ? '▼' : '—';
        
        const real = item.real || 0;
        const vsReal = item.nuevoMonto - real;
        const vsRealColor = vsReal >= 0 ? '#4ade80' : '#f87171';
        const vsRealIcon = vsReal >= 0 ? '✓' : '⚠';
        const realLabel = isGasto ? '🧾 Gasto real' : '💵 Ingreso real';
        
        const sliderMax = isGasto ? group.total : Math.max(item.nuevoMonto * 2, 100000);
        
        html += `
        <div class="budget-row" data-idx="${idx}">
            <div class="budget-info">
                <div class="budget-color" style="background:${color}"></div>
                <div class="budget-name">${item.nombre}</div>
                <div class="budget-current">Actual: ${fmtMoney(item.presupuestado)}</div>
            </div>
            
            <div class="budget-controls">
                <div class="budget-slider-wrap">
                    <input type="range" class="budget-slider" min="0" max="${sliderMax}" step="100" 
                        value="${Math.round(item.nuevoMonto)}" 
                        oninput="onBudgetSlider(${idx}, this.value)"
                        style="--track-color:${color}40; --fill-color:${color}">
                    <div class="budget-slider-tooltip" id="tooltip-${idx}">${fmtMoney(item.nuevoMonto)}</div>
                </div>
                
                <div class="budget-compare-bar">
                    <div class="budget-compare-track">
                        <div class="budget-compare-real" style="width:${Math.min(100, (real / maxVal) * 100)}%;background:#64748b"></div>
                        <div class="budget-compare-new" style="width:${Math.min(100, (item.nuevoMonto / maxVal) * 100)}%;background:${color}"></div>
                    </div>
                    <div class="budget-compare-labels">
                        <span style="color:#64748b">${realLabel}: ${fmtMoney(real)}</span>
                        <span style="color:${vsRealColor};font-weight:700">${vsRealIcon} ${vsReal >= 0 ? '+' : ''}${fmtMoney(vsReal)} vs real</span>
                    </div>
                </div>
                
                <div class="budget-inputs">
                    <div class="budget-input-group">
                        <span class="budget-input-prefix">RD$</span>
                        <input type="number" class="budget-input" value="${Math.round(item.nuevoMonto)}" 
                            onchange="onBudgetAmount(${idx}, this.value)" step="100">
                    </div>
                    ${isGasto ? `
                    <div class="budget-input-group pct">
                        <input type="number" class="budget-input" value="${pct.toFixed(2)}" 
                            onchange="onBudgetPct(${idx}, this.value)" step="0.1" min="0" max="100">
                        <span class="budget-input-suffix">%</span>
                    </div>
                    ` : ''}
                </div>
            </div>
            
            <div class="budget-diff" style="color:${diffColor}">
                ${diffIcon} ${fmtMoney(Math.abs(diff))}
            </div>
        </div>
        `;
    });
    
    container.innerHTML = html;
    if (isGasto) updateBudgetValidation();
}

function setBudgetFilter(tipo) {
    budgetFilter = tipo;
    renderBudgetStats();
    renderBudgetEditor();
    renderBudgetPreviewChart();
}

function updateBudgetValidation() {
    const group = getActiveBudgetGroup();
    const total = group.total;
    const asignado = group.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const pct = total > 0 ? (asignado / total) * 100 : 0;
    const diff = total - asignado;
    
    const fill = document.getElementById('budgetValidationFill');
    const text = document.getElementById('budgetValidationText');
    
    if (!fill || !text) return;
    
    fill.style.width = Math.min(100, pct) + '%';
    fill.style.background = diff === 0 ? '#22c55e' : diff > 0 ? '#f59e0b' : '#ef4444';
    
    if (diff === 0) {
        text.innerHTML = `✅ Suma: <strong>${pct.toFixed(1)}%</strong> · Perfecto`;
        text.style.color = '#4ade80';
    } else if (diff > 0) {
        text.innerHTML = `⚠️ Suma: <strong>${pct.toFixed(1)}%</strong> · Faltan ${fmtMoney(diff)}`;
        text.style.color = '#fbbf24';
    } else {
        text.innerHTML = `🔴 Suma: <strong>${pct.toFixed(1)}%</strong> · Excedido en ${fmtMoney(Math.abs(diff))}`;
        text.style.color = '#f87171';
    }
}

// === HANDLERS ===

function onTotalChange(val) {
    const clean = parseFloat(val.replace(/[^\d.-]/g, ''));
    if (isNaN(clean) || clean < 0) return;
    
    const isGasto = budgetFilter === 'gastos';
    
    if (isGasto) {
        // Gastos: total viene de ingresos, no editable directamente
        // Solo recalcular proporcionalmente si cambian ingresos
    } else {
        // Ingresos: no hay total fijo
    }
    
    renderBudgetStats();
    renderBudgetEditor();
    renderBudgetPreviewChart();
}

function onBudgetSlider(idx, val) {
    const num = parseFloat(val) || 0;
    const group = getActiveBudgetGroup();
    const item = group.items[idx];
    const isGasto = budgetFilter === 'gastos';
    
    item.nuevoMonto = num;
    
    if (isGasto) {
        item.nuevoPct = group.total > 0 ? (num / group.total) * 100 : 0;
    } else {
        // Ingresos: recalcular % informativo
        const totalIngresos = group.items.reduce((s, i) => s + i.nuevoMonto, 0);
        item.nuevoPct = totalIngresos > 0 ? (num / totalIngresos) * 100 : 0;
    }
    
    const row = document.querySelector(`.budget-row[data-idx="${idx}"]`);
    row.querySelector('.budget-input').value = Math.round(num);
    
    const pctInput = row.querySelector('.budget-input-group.pct input');
    if (pctInput) pctInput.value = item.nuevoPct.toFixed(2);
    
    const tooltip = document.getElementById(`tooltip-${idx}`);
    if (tooltip) tooltip.textContent = fmtMoney(num);
    
    // Actualizar barra comparativa
    const real = item.real || 0;
    const maxVal = Math.max(...group.items.map(i => Math.max(i.nuevoMonto, i.real || 0)), 1);
    const vsReal = num - real;
    const vsRealColor = vsReal >= 0 ? '#4ade80' : '#f87171';
    const vsRealIcon = vsReal >= 0 ? '✓' : '⚠';
    const realLabel = isGasto ? '🧾 Gasto real' : '💵 Ingreso real';
    
    const compareLabels = row.querySelector('.budget-compare-labels');
    if (compareLabels) {
        compareLabels.innerHTML = `
            <span style="color:#64748b">${realLabel}: ${fmtMoney(real)}</span>
            <span style="color:${vsRealColor};font-weight:700">${vsRealIcon} ${vsReal >= 0 ? '+' : ''}${fmtMoney(vsReal)} vs real</span>
        `;
    }
    
    const compareNew = row.querySelector('.budget-compare-new');
    if (compareNew) compareNew.style.width = Math.min(100, (num / maxVal) * 100) + '%';
    
    updateBudgetDiff(idx);
    
    if (isGasto) {
        updateBudgetValidation();
    } else {
        // ← NUEVO: Al cambiar ingresos, sincronizar total de gastos
        syncWorkingGastosTotal();
        renderBudgetStats(); // Actualizar stats para mostrar nuevo total
    }
    
    updateBudgetPreviewChart();
}

// ← NUEVO: Sincronizar total de gastos con ingresos en tiempo real
function syncWorkingGastosTotal() {
    const totalIngresos = budgetWorkingData.ingresos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const oldTotal = budgetWorkingData.gastos.total;
    budgetWorkingData.gastos.total = totalIngresos;
    
    // Recalcular % de gastos basado en nuevo total (manteniendo montos absolutos)
    budgetWorkingData.gastos.items.forEach(item => {
        item.nuevoPct = totalIngresos > 0 ? (item.nuevoMonto / totalIngresos) * 100 : 0;
    });
    
    // Si estamos en la vista de gastos, actualizar validación visual
    if (budgetFilter === 'gastos') {
        updateBudgetValidation();
    }
}

function onBudgetAmount(idx, val) { onBudgetSlider(idx, val); }

function onBudgetPct(idx, val) {
    const pct = parseFloat(val) || 0;
    const group = getActiveBudgetGroup();
    const monto = (pct / 100) * group.total;
    onBudgetSlider(idx, monto);
}

function updateBudgetDiff(idx) {
    const item = getActiveBudgetGroup().items[idx];
    const isGasto = budgetFilter === 'gastos';
    const diff = item.nuevoMonto - item.presupuestado;
    
    const diffColor = isGasto
        ? (diff > 0 ? '#f87171' : diff < 0 ? '#4ade80' : '#94a3b8')
        : (diff > 0 ? '#4ade80' : diff < 0 ? '#f87171' : '#94a3b8');
    const diffIcon = diff > 0 ? '▲' : diff < 0 ? '▼' : '—';
    
    const row = document.querySelector(`.budget-row[data-idx="${idx}"]`);
    const diffEl = row.querySelector('.budget-diff');
    diffEl.style.color = diffColor;
    diffEl.textContent = `${diffIcon} ${fmtMoney(Math.abs(diff))}`;
}

function resetBudget() {
    budgetWorkingData = JSON.parse(JSON.stringify(budgetEditorData));
    renderBudgetStats();
    renderBudgetEditor();
    renderBudgetPreviewChart();
}

function balanceBudget() {
    const group = getActiveBudgetGroup();
    const isGasto = budgetFilter === 'gastos';
    
    if (!isGasto) return;
    
    const totalAsignado = group.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const restante = group.total - totalAsignado;
    if (restante <= 0) return;
    
    const factor = restante / totalAsignado;
    group.items.forEach(item => {
        item.nuevoMonto += item.nuevoMonto * factor;
        item.nuevoPct = (item.nuevoMonto / group.total) * 100;
    });
    renderBudgetEditor();
    renderBudgetPreviewChart();
}

// === CHART PREVIEW ===
function renderBudgetPreviewChart() {
    const ctx = getCanvas('budgetPreviewChart');
    if (!ctx) return;
    if (budgetPreviewChart) { budgetPreviewChart.destroy(); budgetPreviewChart = null; }
    
    const group = getActiveBudgetGroup();
    const labels = group.items.map(i => i.nombre);
    const presupuestadoOriginal = group.items.map(i => i.presupuestado);
    const nuevoPresupuesto = group.items.map(i => i.nuevoMonto);
    const real = group.items.map(i => i.real || 0);
    const isGasto = budgetFilter === 'gastos';
    
    const datasets = isGasto ? [
        { label: 'Gasto Real', data: real, backgroundColor: 'rgba(100,116,139,0.5)', borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 },
        { label: 'Presup. Actual', data: presupuestadoOriginal, backgroundColor: 'rgba(148,163,184,0.3)', borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 },
        { label: 'Nuevo Presup.', data: nuevoPresupuesto, backgroundColor: group.items.map(i => getEtiquetaColor(i.etiqueta)), borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 }
    ] : [
        { label: 'Ingreso Real', data: real, backgroundColor: 'rgba(100,116,139,0.5)', borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 },
        { label: 'Esperado Actual', data: presupuestadoOriginal, backgroundColor: 'rgba(148,163,184,0.3)', borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 },
        { label: 'Nuevo Esperado', data: nuevoPresupuesto, backgroundColor: group.items.map(i => getEtiquetaColor(i.etiqueta)), borderRadius: 4, barPercentage: 0.6, categoryPercentage: 0.8 }
    ];
    
    budgetPreviewChart = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', align: 'end', labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true } },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)', titleColor: '#e2e8f0', bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)', borderWidth: 1,
                    callbacks: { label: (c) => c.dataset.label + ': ' + fmtMoney(c.parsed.y) }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 45 } },
                y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v/1000).toFixed(0) + 'K' } }
            }
        }
    });
}

function updateBudgetPreviewChart() {
    if (!budgetPreviewChart) return;
    const group = getActiveBudgetGroup();
    budgetPreviewChart.data.datasets[2].data = group.items.map(i => i.nuevoMonto);
    budgetPreviewChart.update('none');
}

function saveBudget() {
    const totalIngresos = budgetWorkingData.ingresos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    
    // === PASO 1: Usar los nuevoMonto actuales de gastos (lo que el usuario editó) ===
    let totalGastos = budgetWorkingData.gastos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const diferencia = totalIngresos - totalGastos;
    
    // === PASO 2: Si hay diferencia, distribuir proporcionalmente entre gastos actuales ===
    if (Math.abs(diferencia) > 0 && totalGastos > 0) {
        budgetWorkingData.gastos.items.forEach(item => {
            const proporcion = item.nuevoMonto / totalGastos;
            const ajuste = Math.round(diferencia * proporcion);
            item.nuevoMonto += ajuste;
        });
    }
    
    // === PASO 3: Ajuste de redondeo final (±5 pesos de margen) ===
    const totalGastosFinal = budgetWorkingData.gastos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const diferenciaRedondeo = totalIngresos - totalGastosFinal;
    
    if (Math.abs(diferenciaRedondeo) > 0 && budgetWorkingData.gastos.items.length > 0) {
        // Añadir/quitar la diferencia al item con mayor monto (más estable que el último)
        const sorted = [...budgetWorkingData.gastos.items].sort((a, b) => b.nuevoMonto - a.nuevoMonto);
        const target = sorted[0];
        target.nuevoMonto += diferenciaRedondeo;
    }
    
    // === PASO 4: Recalcular % de cada gasto sobre el total de ingresos ===
    budgetWorkingData.gastos.items.forEach(item => {
        item.nuevoPct = totalIngresos > 0 ? (item.nuevoMonto / totalIngresos) * 100 : 0;
    });
    budgetWorkingData.gastos.total = totalIngresos;
    
    // === PASO 5: Validación final ===
    const totalGastosValidado = budgetWorkingData.gastos.items.reduce((s, i) => s + i.nuevoMonto, 0);
    const diferenciaFinal = Math.abs(totalGastosValidado - totalIngresos);
    
    if (diferenciaFinal > 5) {
        alert(`⚠️ Los gastos (${fmtMoney(totalGastosValidado)}) no cuadran con los ingresos (${fmtMoney(totalIngresos)}).\nDiferencia: ${fmtMoney(diferenciaFinal)}. Ajusta primero.`);
        return;
    }
    
    const btn = document.getElementById('saveBudgetBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '⏳ Guardando...';
    btn.disabled = true;
    
    const payload = {
        ingresos: {
            total: totalIngresos,
            categorias: budgetWorkingData.ingresos.items.map(i => ({
                id: i.id,
                nombre: i.nombre,
                monto: Math.round(i.nuevoMonto),
                pct: parseFloat(i.nuevoPct.toFixed(2))
            }))
        },
        gastos: {
            total: totalIngresos,
            categorias: budgetWorkingData.gastos.items.map(i => ({
                id: i.id,
                nombre: i.nombre,
                monto: Math.round(i.nuevoMonto),
                pct: parseFloat(i.nuevoPct.toFixed(2))
            }))
        }
    };
    
    const callbackName = 'budgetSaveCallback_' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
        alert('❌ Timeout guardando presupuesto');
        cleanup();
        btn.innerHTML = originalText;
        btn.disabled = false;
    }, 30000);
    
    function cleanup() {
        if (script.parentNode) script.parentNode.removeChild(script);
        delete window[callbackName];
        clearTimeout(timeout);
    }
    
    window[callbackName] = (res) => {
        cleanup();
        btn.innerHTML = originalText;
        btn.disabled = false;
        if (res && res.success) {
            alert(`✅ ${res.message}\nIngresos: ${fmtMoney(res.totalIngresos)}\nGastos: ${fmtMoney(res.totalGastos)}\nDiferencia: ${fmtMoney(res.diferencia || 0)}`);
            refreshData();
        } else {
            alert('❌ Error: ' + (res?.message || 'No se pudo guardar'));
        }
    };
    
    script.onerror = () => {
        cleanup();
        btn.innerHTML = originalText;
        btn.disabled = false;
        alert('❌ Error de red al guardar');
    };
    
    const jsonPayload = encodeURIComponent(JSON.stringify(payload));
    const url = CONFI.API_URL + '?action=updateBudget&data=' + jsonPayload + '&callback=' + callbackName;
    script.src = url;
    document.head.appendChild(script);
}


// ============================================================
// WALLET INTEGRATION — UI & SYNC (v3: Mapeo de Budgets)
// ====================================================

function openWalletConfig() {
    document.getElementById('walletConfigModal').classList.add('active');
    document.getElementById('walletTokenInput').value = walletAPI.getToken() || '';
    if (walletAPI.isConfigured()) renderWalletBudgetMapping();
}

function closeWalletConfig() {
    document.getElementById('walletConfigModal').classList.remove('active');
}

async function testWalletConnection() {
    const token = document.getElementById('walletTokenInput').value.trim();
    if (!token) { alert('Ingresa un token primero'); return; }
    
    walletAPI.setToken(token);
    const status = document.getElementById('walletTestStatus');
    status.textContent = '⏳ Conectando...';
    status.style.color = '#fbbf24';
    
    try {
        await walletAPI.loadBudgets();
        status.textContent = `✅ Conectado — ${walletAPI.budgets.length} presupuestos encontrados`;
        status.style.color = '#4ade80';
        renderWalletBudgetMapping();
    } catch (e) {
        status.textContent = `❌ ${e.message}`;
        status.style.color = '#f87171';
    }
}

function renderWalletBudgetMapping() {
    if (typeof walletAPI === 'undefined' || !walletAPI) return;

    const section = document.getElementById('walletCatMappingSection');
    const list = document.getElementById('walletCatMappingList');
    section.style.display = 'block';

    // Título y descripción
    section.querySelector('div:first-child').textContent = 'Mapeo de Presupuestos';
    section.querySelector('div:nth-child(2)').textContent =
        'Asocia cada categoría del Balance Sheet con un presupuesto de Wallet.';

    // Categorías de gasto del BS (nivel 1)
    const gastoCats = Object.entries(CAT_DB)
        .filter(([_, meta]) => meta.tipo === 'Gastos' && !meta.padre)
        .sort((a, b) => a[0].localeCompare(b[0]));

    // Presupuestos de Wallet
    const walletBudgets = walletAPI.budgets
        .filter(b => b.closed !== true)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Budgets ya mapeados (para detectar duplicados)
    const allMappings = walletAPI.getAllBudgetMappings();
    const mappedIds = new Set(Object.values(allMappings).filter(Boolean));

    // ── Sección 1: Categorías del Balance Sheet ──
    let html = `
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;
                    letter-spacing:0.05em;margin-bottom:8px;">
            Categorías del Balance Sheet (${gastoCats.length})
        </div>
    `;

    gastoCats.forEach(([localName, meta]) => {
        const currentMap = allMappings[localName] || '';
        const matchedBudget = currentMap
            ? walletAPI.budgets.find(b => b.id === currentMap)
            : null;

        // Sugerencia por nombre (case-insensitive, sin acentos)
        const normalize = s => (s || '').toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        const suggestion = !currentMap
            ? walletBudgets.find(b => normalize(b.name) === normalize(localName))
            : null;

        const borderColor = suggestion
            ? 'rgba(34,197,94,0.5)'   // verde: hay sugerencia
            : 'rgba(51,65,85,0.4)';

        html += `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 0;
                        border-bottom:1px solid rgba(51,65,85,0.2);">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:13px;font-weight:600;color:#f8fafc;">
                        ${localName}
                    </div>
                    <div style="font-size:11px;color:#64748b;">
                        ${meta.etiqueta}
                        ${matchedBudget ? ' · RD$' + (matchedBudget.limit || 0).toLocaleString('es-DO') : ''}
                        ${suggestion ? ' · <span style="color:#4ade80;">sugerido: ' + suggestion.name + '</span>' : ''}
                    </div>
                </div>
                <select onchange="onWalletMappingChange('${localName.replace(/'/g, "\\'")}', this.value)"
                        style="flex:1.2;min-width:180px;padding:8px 10px;border-radius:8px;
                               border:1px solid ${borderColor};background:rgba(15,23,42,0.6);
                               color:#e2e8f0;font-size:12px;">
                    <option value="">— Sin mapear —</option>
                    ${walletBudgets.map(b => {
                        const sel = currentMap === b.id ? 'selected' : '';
                        const usedElsewhere = mappedIds.has(b.id) && currentMap !== b.id;
                        const limitTxt = b.limit ? `RD$${b.limit.toLocaleString('es-DO')}` : 'Sin límite';
                        const tipo = b.type === 'BUDGET_INTERVAL_YEAR' ? '📅 Anual' : '📆 Mensual';
                        const warn = usedElsewhere ? ' ⚠️ ya usado' : '';
                        return `<option value="${b.id}" ${sel}>${b.name} · ${limitTxt} · ${tipo}${warn}</option>`;
                    }).join('')}
                </select>
            </div>
        `;
    });

    // ── Sección 2: Budgets de Wallet huérfanos ──
    const orphanBudgets = walletBudgets.filter(b => !mappedIds.has(b.id));

    if (orphanBudgets.length > 0) {
        html += `
            <div style="margin-top:24px;padding:14px;background:rgba(245,158,11,0.08);
                        border:1px solid rgba(245,158,11,0.25);border-radius:10px;">
                <div style="font-size:12px;font-weight:700;color:#fbbf24;
                            text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">
                    ⚠️ Presupuestos de Wallet sin mapear (${orphanBudgets.length})
                </div>
                <div style="font-size:11px;color:#94a3b8;margin-bottom:12px;line-height:1.5;">
                    Estos budgets existen en Wallet pero no están vinculados a ninguna
                    categoría del Balance Sheet. <strong>No se sincronizarán al guardar</strong>.
                    Opciones:
                    <br>• <em>Renombrar el budget en Wallet</em> para que coincida con una categoría del BS, o
                    <br>• <em>Crear la categoría faltante</em> en tu hoja de cálculo (DB_CATEGORIAS) y agregarla a <code>CAT_DB</code>.
                </div>
                ${orphanBudgets.map(b => `
                    <div style="display:flex;justify-content:space-between;align-items:center;
                                padding:6px 0;border-bottom:1px solid rgba(51,65,85,0.15);">
                        <span style="font-size:12px;color:#e2e8f0;">${b.name}</span>
                        <span style="font-size:11px;color:#64748b;">
                            ${b.limit ? 'RD$' + b.limit.toLocaleString('es-DO') : 'Sin límite'} ·
                            ${b.type === 'BUDGET_INTERVAL_YEAR' ? 'Anual' : 'Mensual'}
                        </span>
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        html += `
            <div style="margin-top:20px;padding:12px;background:rgba(34,197,94,0.08);
                        border:1px solid rgba(34,197,94,0.25);border-radius:10px;
                        font-size:12px;color:#4ade80;">
                ✅ Todos los presupuestos de Wallet están mapeados.
            </div>
        `;
    }

    list.innerHTML = html;
}

// Handler: guarda + re-renderiza para actualizar huérfanos y advertencias
function onWalletMappingChange(localName, budgetId) {
    walletAPI.setBudgetMapping(localName, budgetId || null);
    renderWalletBudgetMapping();
}


// Hook: Sincronizar con Wallet al guardar presupuesto
const originalSaveBudget = saveBudget;
saveBudget = async function() {
    // Primero ejecutar el guardado original en Sheets
    await originalSaveBudget();
    
    // Luego sincronizar con Wallet si está configurado
    if (!walletAPI.isConfigured()) {
        console.log('ℹ️ Wallet API no configurado — saltando sync');
        return;
    }
    
    const btn = document.getElementById('saveBudgetBtn');
    const originalHTML = btn.innerHTML;
    
    // Verificar que hay mapeos de budgets
    const mappings = walletAPI.getAllBudgetMappings();
    const hasMappings = Object.values(mappings).some(v => !!v);
    if (!hasMappings) {
        console.log('ℹ️ No hay presupuestos mapeados a Wallet — saltando sync');
        return;
    }
    
    btn.innerHTML = '⏳ Sync Wallet...';
    btn.disabled = true;
    
    try {
        const result = await walletAPI.syncBudgets(budgetWorkingData);
        const msg = [
            `✅ Wallet sincronizado:`,
            `Actualizados: ${result.updated.length}`,
            `Omitidos: ${result.skipped.length}`,
            `Errores: ${result.errors.length}`
        ].join('\n');
        
        if (result.errors.length > 0) {
            console.error('Errores Wallet:', result.errors);
            alert(msg + '\n\nErrores:\n' + result.errors.map(e => `- ${e.name}: ${e.error}`).join('\n'));
        } else {
            console.log('Wallet sync:', result);
            alert(msg);
        }
    } catch (e) {
        console.error('Error sync Wallet:', e);
        alert('❌ Error sincronizando con Wallet:\n' + e.message);
    } finally {
        btn.innerHTML = originalHTML;
        btn.disabled = false;
    }
};

// Cerrar modal con click fuera o Escape
document.addEventListener('click', function(e) {
    const modal = document.getElementById('walletConfigModal');
    if (e.target === modal) closeWalletConfig();
});
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeWalletConfig();
});

// ============================================================
// JARRAS — MÉTODO DE LAS 6 JARRAS
// ============================================================

let jarrasData = null;
let jarrasYear = null;
let jarrasCharts = {};

const JARRA_COLORS = {
  'Neceisdades Básicas': '#3b82f6',
  'Donativos': '#ec4899',
  'Educacion': '#2e7d32',
  'Entretenimiento': '#4db6ac',
  'Ahorros': '#64dd17',
  'Inversión': '#ff1744'
};

const JARRA_ICONS = {
  'Neceisdades Básicas': '🏠',
  'Donativos': '🤝',
  'Educacion': '📚',
  'Entretenimiento': '🎉',
  'Ahorros': '💎',
  'Inversión': '📈'
};

function loadJarrasData() {
  return new Promise((resolve, reject) => {
    if (jarrasData) { resolve(jarrasData); return; }
    
    const callbackName = 'jarrasCallback_' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      reject(new Error('Timeout JSONP (getJarras)'));
      cleanup();
    }, 30000);

    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[callbackName];
      clearTimeout(timeout);
    }

    window[callbackName] = (data) => {
      console.log('📡 Respuesta JARRAS:', data); // DEBUG
      if (!data) {
        reject(new Error('Respuesta vacía del servidor'));
        cleanup();
        return;
      }
      if (data.error) {
        reject(new Error(data.message || 'Error del servidor'));
        cleanup();
        return;
      }
      if (!data.metadata || !data.metadata.years || data.metadata.years.length === 0) {
        reject(new Error('Datos incompletos: no se encontraron años'));
        cleanup();
        return;
      }
      jarrasData = data;
      jarrasYear = data.metadata.years[0];
      resolve(data);
      cleanup();
    };

    script.onerror = () => {
      reject(new Error('Error de red JSONP (getJarras)'));
      cleanup();
    };

    const url = CONFI.API_URL + '?action=getJarras&callback=' + callbackName;
    console.log('📡 Cargando JARRAS desde:', url.substring(0, 80) + '...');
    script.src = url;
    document.head.appendChild(script);
  });
}

async function renderJarrasTab() {
  const statsEl = document.getElementById('jarrasStats');
  const cardsEl = document.getElementById('jarrasCards');
  
  if (statsEl) statsEl.innerHTML = '<div class="stat-card" style="grid-column:1/-1"><div class="stat-value" style="font-size:14px;color:#64748b">⏳ Cargando jarras...</div></div>';
  
  try {
    if (!jarrasData) await loadJarrasData();
    renderJarras();
  } catch (e) {
    console.error('Error cargando JARRAS:', e);
    if (statsEl) {
      statsEl.innerHTML = '<div class="stat-card" style="grid-column:1/-1"><div class="stat-value" style="font-size:16px;color:#f87171">❌ ' + e.message + '</div><div class="stat-sub">Revisa la consola (F12) y verifica que la hoja \"JARRAS\" exista en Sheets</div></div>';
    }
    if (cardsEl) cardsEl.innerHTML = '';
  }
}

function renderJarras() {
  if (!jarrasData) return;
  
  const year = jarrasYear || (jarrasData.metadata && jarrasData.metadata.years[0]);
  if (!year) {
    console.error('No hay año seleccionado ni disponible');
    return;
  }
  
  const resumen = jarrasData.resumenAnual[year];
  const historial = (jarrasData.historialMensual || []).filter(m => m.year === year);
  
  if (!resumen) {
    document.getElementById('jarrasStats').innerHTML = '<div class="stat-card" style="grid-column:1/-1"><div class="stat-value" style="font-size:16px;color:#f87171">No hay datos para ' + year + '</div></div>';
    return;
  }

  // Selector de año
  const yearSelect = document.getElementById('jarrasYearSelect');
  if (yearSelect && jarrasData.metadata && jarrasData.metadata.years) {
    yearSelect.innerHTML = jarrasData.metadata.years.map(y => 
      `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`
    ).join('');
  }

  // Stats
  const totalPresupuesto = Object.values(resumen).reduce((s, j) => s + (j.presupuesto || 0), 0);
  const totalGastado = Object.values(resumen).reduce((s, j) => s + (j.gastado || 0), 0);
  const totalDiff = totalPresupuesto - totalGastado;
  const pctGlobal = totalPresupuesto > 0 ? (totalGastado / totalPresupuesto) * 100 : 0;

  const statsHtml = `
    <div class="stat-card" style="border-top:3px solid #3b82f6">
      <div class="stat-header"><span class="stat-label">Presupuesto Anual</span></div>
      <div class="stat-value">${fmtMoney(totalPresupuesto)}</div>
      <div class="stat-sub">${year} · 6 jarras</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #ef4444">
      <div class="stat-header"><span class="stat-label">Total Gastado</span></div>
      <div class="stat-value" style="color:#f87171">${fmtMoney(totalGastado)}</div>
      <div class="stat-sub">${pctGlobal.toFixed(1)}% del presupuesto</div>
    </div>
    <div class="stat-card" style="border-top:3px solid ${totalDiff >= 0 ? '#22c55e' : '#ef4444'}">
      <div class="stat-header"><span class="stat-label">${totalDiff >= 0 ? 'Superávit' : 'Déficit'}</span></div>
      <div class="stat-value" style="color:${totalDiff >= 0 ? '#4ade80' : '#f87171'}">${fmtMoney(Math.abs(totalDiff))}</div>
      <div class="stat-sub">${totalDiff >= 0 ? '✅ Bajo presupuesto' : '🔴 Excedido'}</div>
    </div>
    <div class="stat-card" style="border-top:3px solid #8b5cf6">
      <div class="stat-header"><span class="stat-label">Meses Registrados</span></div>
      <div class="stat-value">${historial.length}</div>
      <div class="stat-sub">en ${year}</div>
    </div>
  `;
  document.getElementById('jarrasStats').innerHTML = statsHtml;

  // Cards
  const cardsContainer = document.getElementById('jarrasCards');
  let cardsHtml = '';
  
  for (const [name, vals] of Object.entries(resumen)) {
    const color = JARRA_COLORS[name] || '#64748b';
    const icon = JARRA_ICONS[name] || '💰';
    const pct = vals.pctUsado || 0;
    const diff = vals.diferencia || 0;
    const diffText = diff >= 0 ? `+${fmtMoney(diff)} libre` : `${fmtMoney(Math.abs(diff))} excedido`;
    const diffColor = diff >= 0 ? '#4ade80' : '#f87171';
    const pctClass = pct <= 85 ? 'up' : pct <= 100 ? 'neutral' : 'down';
    
    cardsHtml += `
      <div class="jarra-card" style="border-left: 3px solid ${color}">
        <div class="jarra-header">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:40px;height:40px;border-radius:10px;background:${color}20;color:${color};display:flex;align-items:center;justify-content:center;font-size:20px;">${icon}</div>
            <div>
              <div style="font-size:14px;font-weight:700;color:#f8fafc;">${name}</div>
              <div style="font-size:11px;color:#64748b;">${vals.meses || 0} meses registrados</div>
            </div>
          </div>
          <span class="stat-badge ${pctClass}" style="font-size:14px;">${pct.toFixed(1)}%</span>
        </div>
        <div style="margin:12px 0;">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#94a3b8;margin-bottom:6px;">
            <span>Presup: ${fmtMoney(vals.presupuesto || 0)}</span>
            <span style="color:${diffColor};font-weight:600;">${diffText}</span>
            <span>Gast: ${fmtMoney(vals.gastado || 0)}</span>
          </div>
          <div style="height:10px;background:rgba(51,65,85,0.4);border-radius:5px;overflow:hidden;">
            <div style="width:${Math.min(pct, 100)}%;height:100%;background:${color};border-radius:5px;transition:width 0.6s ease;"></div>
          </div>
        </div>
        <div style="display:flex;gap:16px;font-size:11px;color:#64748b;">
          <span style="display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${color}40;"></span> Meta</span>
          <span style="display:flex;align-items:center;gap:4px;"><span style="width:8px;height:8px;border-radius:50%;background:${color};"></span> Real</span>
        </div>
      </div>
    `;
  }
  cardsContainer.innerHTML = cardsHtml;

  // Charts
  renderJarrasBarChart(year, resumen);
  renderJarrasMonthlyChart(year, historial);
  renderJarrasMonthlyDetail(year);
}

function onJarrasYearChange(el) {
  jarrasYear = el.value;
  renderJarras();
}

function renderJarrasBarChart(year, resumen) {
  const ctx = getCanvas('jarrasBarChart');
  if (!ctx) return;
  if (jarrasCharts.bar) { jarrasCharts.bar.destroy(); jarrasCharts.bar = null; }

  const labels = Object.keys(resumen);
  const presupuestado = labels.map(n => resumen[n].presupuesto || 0);
  const gastado = labels.map(n => resumen[n].gastado || 0);
  const colors = labels.map(n => JARRA_COLORS[n] || '#64748b');

  jarrasCharts.bar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Presupuesto',
          data: presupuestado,
          backgroundColor: colors.map(c => c + '60'),
          borderColor: colors,
          borderWidth: 1,
          borderRadius: 6,
          barPercentage: 0.7,
          categoryPercentage: 0.8
        },
        {
          label: 'Gastado',
          data: gastado,
          backgroundColor: colors,
          borderRadius: 6,
          barPercentage: 0.7,
          categoryPercentage: 0.8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { color: '#94a3b8', font: { size: 11 }, usePointStyle: true } },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0', bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)', borderWidth: 1,
          callbacks: { label: (ctx) => ctx.dataset.label + ': ' + fmtMoney(ctx.parsed.y) }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11, weight: '600' } } },
        y: { grid: { color: 'rgba(51,65,85,0.2)' }, ticks: { color: '#64748b', font: { size: 10 }, callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K' } }
      }
    }
  });
}

function renderJarrasMonthlyChart(year, historial) {
  const ctx = getCanvas('jarrasMonthlyChart');
  if (!ctx) return;
  if (jarrasCharts.monthly) { jarrasCharts.monthly.destroy(); jarrasCharts.monthly = null; }

  const sorted = [...historial].reverse();
  
  // === FORMATEAR LABELS A CORTO: "Ago '26" ===
  const mesesEs = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const mesesEn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  
  const labels = sorted.map(m => {
    const lbl = m.label || '';
    
    // Caso 1: Ya es "Aug'26" → traducir mes a español
    if (typeof lbl === 'string' && lbl.includes("'")) {
      const [mon, yr] = lbl.split("'");
      const idx = mesesEn.indexOf(mon);
      if (idx >= 0) return mesesEs[idx] + "'" + yr;
      return lbl;
    }
    
    // Caso 2: Es fecha larga (Date string) → parsear a corto
    const d = new Date(lbl);
    if (!isNaN(d.getTime())) {
      return mesesEs[d.getMonth()] + "'" + String(d.getFullYear()).slice(-2);
    }
    
    return lbl;
  });

  const datasets = (jarrasData.jarras || []).map((nombre) => {
    const color = JARRA_COLORS[nombre] || '#64748b';
    return {
      label: nombre,
      data: sorted.map(m => (m.jarras && m.jarras[nombre]) ? m.jarras[nombre].gastado : 0),
      borderColor: color,
      backgroundColor: color + '10',
      fill: false,
      tension: 0.3,
      pointRadius: 3,
      pointHoverRadius: 6,
      borderWidth: 2
    };
  });

  jarrasCharts.monthly = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { 
          position: 'top', 
          align: 'end', 
          labels: { color: '#94a3b8', font: { size: 10 }, usePointStyle: true, boxWidth: 8 } 
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0', 
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)', 
          borderWidth: 1,
          callbacks: {
            // ← SOBRESCRIBIR TÍTULO: muestra la label limpia, no la fecha parseada
            title: (items) => items[0]?.label || '',
            label: (ctx) => ctx.dataset.label + ': ' + fmtMoney(ctx.parsed.y)
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
            maxRotation: 0,      // ← Sin rotación
            autoSkip: true       // ← Salta labels si hay muchos
          } 
        },
        y: { 
          grid: { color: 'rgba(51,65,85,0.2)' }, 
          ticks: { 
            color: '#64748b', 
            font: { size: 10 }, 
            callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K' 
          } 
        }
      }
    }
  });
}

function renderJarrasMonthlyDetail(year) {
    const container = document.getElementById('jarrasMonthlyDetail');
    const label = document.getElementById('jarrasMonthYearLabel');
    if (label) label.textContent = year;
    if (!container) return;

    const historial = (jarrasData.historialMensual || []).filter(m => m.year === year);
    // Ordenar cronológicamente (el CSV viene más reciente primero)
    const sorted = [...historial].reverse();

    if (sorted.length === 0) {
        container.innerHTML = '<div style="color:#64748b;text-align:center;padding:24px;">Sin datos mensuales para ' + year + '</div>';
        return;
    }

    const mesesNombres = {
        'Jan': 'Enero', 'Feb': 'Febrero', 'Mar': 'Marzo', 'Apr': 'Abril',
        'May': 'Mayo', 'Jun': 'Junio', 'Jul': 'Julio', 'Aug': 'Agosto',
        'Sep': 'Septiembre', 'Oct': 'Octubre', 'Nov': 'Noviembre', 'Dec': 'Diciembre'
    };

    let html = '';

    sorted.forEach(mes => {
        const mesNombre = mesesNombres[mes.month] || mes.month;
        const displayName = mesNombre + " '" + mes.year.slice(2);

        // Totales del mes
        let totalP = 0, totalG = 0;
        Object.values(mes.jarras || {}).forEach(j => {
            totalP += j.presupuesto || 0;
            totalG += j.gastado || 0;
        });
        const pctGlobal = totalP > 0 ? (totalG / totalP * 100) : 0;

        html += `
            <div class="jarra-month-card">
                <div class="jarra-month-header">
                    <div class="jarra-month-name">${displayName}</div>
                    <div class="jarra-month-totals">
                        <div class="jarra-month-total-p">Presup: ${fmtMoney(totalP)}</div>
                        <div class="jarra-month-total-g">Gast: ${fmtMoney(totalG)} · ${pctGlobal.toFixed(0)}%</div>
                    </div>
                </div>
        `;

        // Las 6 jarras
        (jarrasData.jarras || []).forEach(nombre => {
            const j = mes.jarras[nombre] || { presupuesto: 0, gastado: 0, pctUsado: 0 };
            const color = JARRA_COLORS[nombre] || '#64748b';
            const icon = JARRA_ICONS[nombre] || '💰';
            const pct = j.pctUsado || 0;
            const pctClass = pct <= 85 ? 'good' : pct <= 100 ? 'warn' : 'danger';

            html += `
                <div class="jarra-month-item">
                    <div class="jarra-month-icon" style="background:${color}20;color:${color};">${icon}</div>
                    <div class="jarra-month-info">
                        <div class="jarra-month-name-sm">${nombre}</div>
                        <div class="jarra-month-bar-bg">
                            <div class="jarra-month-bar-fill" style="width:${Math.min(pct, 100)}%;background:${color};"></div>
                        </div>
                    </div>
                    <div class="jarra-month-values">
                        <div class="jarra-month-pct ${pctClass}">${pct.toFixed(0)}%</div>
                        <div class="jarra-month-amount">${fmtMoney(j.gastado)} / ${fmtMoney(j.presupuesto)}</div>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
    });

    container.innerHTML = html;
}

// ============================================================================
// MODECO — ESTADO DE RESULTADOS Y BALANCE
// ============================================================================

function loadModecoData() {
  if (modecoData) return Promise.resolve(modecoData);
  if (modecoLoadingPromise) return modecoLoadingPromise;

  modecoLoadingPromise = new Promise((resolve, reject) => {
    const callbackName = 'modecoCallback_' + Date.now();
    const script = document.createElement('script');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout JSONP (getModeco)'));
    }, 30000);

    function cleanup() {
      if (script.parentNode) script.parentNode.removeChild(script);
      delete window[callbackName];
      clearTimeout(timeout);
      modecoLoadingPromise = null;
    }

    window[callbackName] = (data) => {
      if (!data) {
        cleanup();
        reject(new Error('Respuesta vacía del servidor'));
        return;
      }
      if (data.error) {
        cleanup();
        reject(new Error(data.message || 'Error del servidor'));
        return;
      }
      modecoData = data;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error('Error de red JSONP (getModeco)'));
    };

    script.src = CONFI.API_URL + '?action=getModeco&callback=' + callbackName;
    document.head.appendChild(script);
  });

  return modecoLoadingPromise;
}

async function renderModecoTab() {
  const statsEl = document.getElementById('modecoStats');
  if (!statsEl) return;

  statsEl.innerHTML = `
    <div class="stat-card" style="grid-column:1/-1">
      <div class="stat-value" style="font-size:14px;color:#64748b">⏳ Cargando Modeco...</div>
    </div>
  `;

  try {
    if (!modecoData) await loadModecoData();

    resetModecoSelectedCharts();
    renderModecoMonthSelector();
    renderModecoStats();
    renderModecoIngresosChart();
    renderModecoGastosPorClasifChart();
    renderModecoIngresosVsGastosChart();
    renderModecoWaterfallChart();
    renderModecoBalanceChart();
    renderModecoCategoriasList();
  } catch (e) {
    console.error('Error cargando MODECO:', e);
    statsEl.innerHTML = `
      <div class="stat-card" style="grid-column:1/-1">
        <div class="stat-value" style="font-size:16px;color:#f87171">❌ ${e.message}</div>
        <div class="stat-sub">Verifica que el backend tenga el case getModeco y la hoja DB_MODECO</div>
      </div>
    `;
  }
}

function getModecoMesActual() {
  const meses = modecoData?.meses || [];
  return meses[modecoSelectedMonthIndex] || modecoData?.resumen?.mesActual || meses[0] || null;
}

function getModecoMesAnterior() {
  const meses = modecoData?.meses || [];
  return meses[modecoSelectedMonthIndex + 1] || null;
}

function formatModecoPeriodLabel(value) {
  if (!value) return '—';
  const monthNames = {
    Jan: 'Ene', Feb: 'Feb', Mar: 'Mar', Apr: 'Abr', May: 'May', Jun: 'Jun',
    Jul: 'Jul', Aug: 'Ago', Sep: 'Sep', Oct: 'Oct', Nov: 'Nov', Dec: 'Dic'
  };
  const label = String(value).trim();

  // ISO date: take year/month directly to avoid timezone shifts around Jan 1.
  const isoMatch = label.match(/^(\d{4})-(\d{2})(?:-\d{2})?/);
  if (isoMatch) {
    const month = Number(isoMatch[2]);
    const names = Object.values(monthNames);
    return month >= 1 && month <= 12 ? `${names[month - 1]} ${isoMatch[1]}` : label;
  }

  // Existing labels such as Aug'26 or Oct 2026.
  const shortMatch = label.match(/^([A-Za-z]{3})[' ]?(\d{2,4})$/);
  if (shortMatch && monthNames[shortMatch[1]]) {
    const year = shortMatch[2].length === 2 ? `20${shortMatch[2]}` : shortMatch[2];
    return `${monthNames[shortMatch[1]]} ${year}`;
  }

  // Date strings such as "Thu Oct 01 2026 00:00:00 GMT-0400 ...".
  const date = new Date(label);
  if (!Number.isNaN(date.getTime())) {
    const names = Object.values(monthNames);
    return `${names[date.getMonth()]} ${date.getFullYear()}`;
  }
  return label;
}

function renderModecoMonthSelector() {
  const select = document.getElementById('modecoMonthSelect');
  if (!select) return;
  const meses = modecoData?.meses || [];
  if (!meses.length) {
    select.innerHTML = '<option value="0">Sin períodos disponibles</option>';
    select.disabled = true;
    return;
  }
  modecoSelectedMonthIndex = Math.min(modecoSelectedMonthIndex, meses.length - 1);
  select.disabled = false;
  select.innerHTML = meses.map((mes, index) =>
    `<option value="${index}" ${index === modecoSelectedMonthIndex ? 'selected' : ''}>${formatModecoPeriodLabel(mes.mes) || `Período ${index + 1}`}</option>`
  ).join('');
  const hint = document.getElementById('modecoPeriodHint');
  if (hint) hint.textContent = 'Indicadores, gráficos y categorías corresponden al período seleccionado. El balance refleja el último saldo disponible.';
}

function getModecoCategoryValue(category) {
  const historyValue = category?.history?.[modecoSelectedMonthIndex]?.value;
  const monthValue = getModecoMesActual()?.valores?.[category?.name];
  return Number(historyValue ?? monthValue ?? (modecoSelectedMonthIndex === 0 ? category?.current : 0)) || 0;
}

function renderModecoEmptyChart(container, chartKey, message) {
  resetModecoChart(chartKey, container);
  const emptyState = document.createElement('div');
  emptyState.className = 'modeco-empty-state';
  emptyState.textContent = message;
  container.replaceChildren(emptyState);
  container.classList.add('is-empty');
}

function resetModecoChart(chartKey, container) {
  if (charts[chartKey]) {
    charts[chartKey].destroy();
    delete charts[chartKey];
  }
  container.querySelectorAll('canvas').forEach(canvas => {
    const registeredChart = Chart.getChart ? Chart.getChart(canvas) : null;
    if (registeredChart) registeredChart.destroy();
    canvas.remove();
  });
  container.classList.remove('is-empty');
  container.replaceChildren();
}

function resetModecoSelectedCharts() {
  [
    ['modecoIngresos', 'modecoIngresosChart'],
    ['modecoGastosClasif', 'modecoGastosClasificacionChart'],
    ['modecoIngVsGas', 'modecoIngresosVsGastosChart'],
    ['modecoWaterfall', 'modecoWaterfallChart']
  ].forEach(([key, id]) => {
    const container = document.getElementById(id);
    if (container) resetModecoChart(key, container);
  });
}

function setModecoMonth(value) {
  const index = Number.parseInt(value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= (modecoData?.meses?.length || 0)) return;
  modecoSelectedMonthIndex = index;
  renderModecoMonthSelector();
  resetModecoSelectedCharts();
  renderModecoStats();
  renderModecoIngresosChart();
  renderModecoGastosPorClasifChart();
  renderModecoIngresosVsGastosChart();
  renderModecoWaterfallChart();
  renderModecoCategoriasList();
}

function getModecoBalanceActual() {
  const b = modecoData?.balance || {};
  const activos =
    (b.bhdModeco?.current || 0) +
    (b.cashModeco?.current || 0) +
    (b.cashUsdModeco?.current || 0);
  const prestamo = b.prestamoModeco?.current || 0;

  return {
    activos,
    prestamo,
    patrimonio: activos - prestamo
  };
}

function getModecoBalanceAnterior() {
  const b = modecoData?.balance || {};
  const activos =
    (b.bhdModeco?.previous || 0) +
    (b.cashModeco?.previous || 0) +
    (b.cashUsdModeco?.previous || 0);
  const prestamo = b.prestamoModeco?.previous || 0;

  return {
    activos,
    prestamo,
    patrimonio: activos - prestamo
  };
}

function getModecoClasificacion(nombre) {
  if (MODECO_GASTO_CLASIFICACION[nombre]) return MODECO_GASTO_CLASIFICACION[nombre];
  if (nombre.includes('- COGS')) return 'COGS';
  if (nombre.includes('- OPEX')) return 'OPEX';
  if (nombre.includes('- CAPEX')) return 'CAPEX';
  if (nombre.startsWith('Modeco - ')) return 'Ingreso';
  return 'Modeco';
}

function renderModecoStats() {
  const mes = getModecoMesActual();
  const mesAnterior = getModecoMesAnterior();
  const balance = getModecoBalanceActual();
  const balanceAnterior = getModecoBalanceAnterior();

  if (!mes) {
    const insightsEl = document.getElementById('modecoInsights');
    if (insightsEl) insightsEl.innerHTML = '';
    document.getElementById('modecoStats').innerHTML = `
      <div class="stat-card" style="grid-column:1/-1">
        <div class="stat-value" style="font-size:16px;color:#94a3b8">Sin datos mensuales de Modeco</div>
      </div>
    `;
    return;
  }

  const utilidad = mes.utilidadNeta || 0;
  const margen = mes.margenNeto || 0;
  const utilidadAnterior = mesAnterior?.utilidadNeta || 0;
  const utilidadChangePct = utilidadAnterior !== 0
    ? ((utilidad - utilidadAnterior) / Math.abs(utilidadAnterior)) * 100
    : 0;
  const patrimonioChange = balance.patrimonio - balanceAnterior.patrimonio;
  const patrimonioChangePct = balanceAnterior.patrimonio !== 0
    ? (patrimonioChange / Math.abs(balanceAnterior.patrimonio)) * 100
    : 0;

  document.getElementById('modecoMeta').textContent =
    `${formatModecoPeriodLabel(mes.mes)} seleccionado · ${modecoData.metadata?.totalMonths || modecoData.meses?.length || 0} períodos disponibles`;

  renderModecoInsights(mes, mesAnterior);

  document.getElementById('modecoStats').innerHTML = `
    <div class="stat-card success">
      <div class="stat-header">
        <span class="stat-label">Ingresos</span>
        ${mesAnterior ? getChangeBadge(mesAnterior.ingresos !== 0 ? ((mes.ingresos - mesAnterior.ingresos) / Math.abs(mesAnterior.ingresos)) * 100 : 0) : ''}
      </div>
      <div class="stat-value">${fmtMoney(mes.ingresos || 0)}</div>
      <div class="stat-sub">${formatModecoPeriodLabel(mes.mes)}</div>
      <div class="stat-bar" style="--bar-width:100%"></div>
    </div>

    <div class="stat-card warning">
      <div class="stat-header">
        <span class="stat-label">Gastos</span>
        ${mesAnterior ? getChangeBadge(mesAnterior.gastos !== 0 ? ((mes.gastos - mesAnterior.gastos) / Math.abs(mesAnterior.gastos)) * 100 : 0) : ''}
      </div>
      <div class="stat-value" style="color:#f87171">${fmtMoney(mes.gastos || 0)}</div>
      <div class="stat-sub">COGS ${fmtMoney(mes.clasificaciones?.COGS || 0)} · OPEX ${fmtMoney(mes.clasificaciones?.OPEX || 0)} · CAPEX ${fmtMoney(mes.clasificaciones?.CAPEX || 0)} · Modeco ${fmtMoney(mes.clasificaciones?.Modeco || 0)}</div>
      <div class="stat-bar" style="--bar-width:${mes.ingresos > 0 ? Math.min((mes.gastos / mes.ingresos) * 100, 100).toFixed(1) : 0}%"></div>
    </div>

    <div class="stat-card ${utilidad >= 0 ? 'success' : 'warning'}">
      <div class="stat-header">
        <span class="stat-label">Utilidad Neta</span>
        ${mesAnterior ? getChangeBadge(utilidadChangePct) : ''}
      </div>
      <div class="stat-value" style="color:${utilidad >= 0 ? '#4ade80' : '#f87171'}">${fmtMoney(utilidad)}</div>
      <div class="stat-sub">Antes de CAPEX · Flujo post-CAPEX: ${fmtMoney(mes.flujoDespuesCapex || 0)}</div>
      <div class="stat-bar" style="--bar-width:${Math.max(0, Math.min(margen, 100)).toFixed(1)}%"></div>
    </div>

    <div class="stat-card info">
      <div class="stat-header">
        <span class="stat-label">Margen Neto</span>
      </div>
      <div class="stat-value" style="color:${margen >= 15 ? '#4ade80' : margen >= 0 ? '#60a5fa' : '#f87171'}">${margen.toFixed(2)}%</div>
      <div class="stat-sub">Bruto: ${(mes.margenBruto || 0).toFixed(1)}% · Operativo: ${(mes.margenOperativo || 0).toFixed(1)}%</div>
      <div class="stat-bar" style="--bar-width:${Math.max(0, Math.min(margen, 100)).toFixed(1)}%"></div>
    </div>

    <div class="stat-card ${balance.patrimonio >= 0 ? 'success' : 'warning'}">
      <div class="stat-header">
        <span class="stat-label">Patrimonio Modeco</span>
        ${getChangeBadge(patrimonioChangePct)}
      </div>
      <div class="stat-value" style="color:${balance.patrimonio >= 0 ? '#4ade80' : '#f87171'}">${fmtMoney(balance.patrimonio)}</div>
      <div class="stat-sub">Activos ${fmtMoney(balance.activos)} − préstamo ${fmtMoney(balance.prestamo)}</div>
      <div class="stat-bar" style="--bar-width:${balance.activos > 0 ? Math.max(0, Math.min((balance.patrimonio / balance.activos) * 100, 100)).toFixed(1) : 0}%"></div>
    </div>
  `;
  renderModecoFormulaPanel(mes, balance);
}

function renderModecoInsights(mes, mesAnterior) {
  const container = document.getElementById('modecoInsights');
  if (!container) return;

  const ingresos = Number(mes.ingresos) || 0;
  const gastos = Number(mes.gastos) || 0;
  const utilidad = Number(mes.utilidadNeta) || 0;
  const flujo = Number(mes.flujoDespuesCapex) || 0;
  const categorias = Object.values(modecoData?.categorias || {}).map(cat => ({
    ...cat,
    valor: getModecoCategoryValue(cat)
  }));
  const topIngreso = categorias
    .filter(cat => cat.clasificacion === 'Ingreso' && cat.valor > 0)
    .sort((a, b) => b.valor - a.valor)[0];
  const topGasto = categorias
    .filter(cat => cat.clasificacion !== 'Ingreso' && cat.valor > 0)
    .sort((a, b) => b.valor - a.valor)[0];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const signedChange = (current, previous) => {
    const delta = (Number(current) || 0) - (Number(previous) || 0);
    const pct = previous ? (delta / Math.abs(previous)) * 100 : null;
    const direction = delta > 0 ? 'subió' : delta < 0 ? 'bajó' : 'se mantuvo';
    return `${direction} ${fmtMoney(Math.abs(delta))}${pct === null ? '' : ` (${Math.abs(pct).toFixed(1)}%)`}`;
  };

  const resultText = ingresos > 0
    ? `El período ${utilidad >= 0 ? `generó ${fmtMoney(utilidad)} de utilidad neta` : `cerró con una pérdida de ${fmtMoney(Math.abs(utilidad))}`} (margen ${((utilidad / ingresos) * 100).toFixed(2)}%). El flujo después de CAPEX fue ${fmtMoney(flujo)}.`
    : 'No hay ingresos registrados en este período; los márgenes no permiten evaluar rentabilidad.';
  const incomeText = topIngreso && ingresos > 0
    ? `${topIngreso.name} aporta ${fmtMoney(topIngreso.valor)} (${(topIngreso.valor / ingresos * 100).toFixed(1)}% de los ingresos).`
    : 'No hay una categoría de ingreso con monto positivo en este período.';
  const costText = topGasto && gastos > 0
    ? `${topGasto.name} es el mayor gasto: ${fmtMoney(topGasto.valor)} (${(topGasto.valor / gastos * 100).toFixed(1)}% del total).`
    : 'No hay gastos registrados en este período.';
  const comparisonText = mesAnterior
    ? `Ingresos ${signedChange(mes.ingresos, mesAnterior.ingresos)}; gastos ${signedChange(mes.gastos, mesAnterior.gastos)}; utilidad neta ${signedChange(mes.utilidadNeta, mesAnterior.utilidadNeta)} frente a ${formatModecoPeriodLabel(mesAnterior.mes)}.`
    : 'No hay un período anterior para comparar.';

  container.innerHTML = `
    <div class="modeco-insights-heading">
      <div><span class="modeco-insights-eyebrow">LECTURA EJECUTIVA</span><h3>${escape(formatModecoPeriodLabel(mes.mes))}</h3></div>
      <p>${resultText}</p>
    </div>
    <div class="modeco-insights-grid">
      <article class="modeco-insight-item"><span>Motor de ingresos</span><strong>${incomeText}</strong></article>
      <article class="modeco-insight-item"><span>Mayor costo</span><strong>${costText}</strong></article>
      <article class="modeco-insight-item"><span>Contra el mes anterior</span><strong>${comparisonText}</strong></article>
    </div>
    <p class="modeco-insights-note">La utilidad neta excluye CAPEX; el flujo después de CAPEX lo resta. La comparación es nominal y no ajusta estacionalidad.</p>
  `;
}

function renderModecoFormulaPanel(mes, balance) {
  const container = document.getElementById('modecoFormulaPanel');
  if (!container) return;
  const groups = mes.clasificaciones || {};
  const money = value => fmtMoney(value || 0);
  const formula = (label, expression, result, note = '') => `
    <div class="modeco-formula-row">
      <span class="modeco-formula-name">${label}</span>
      <span class="modeco-formula-expression">${expression}</span>
      <strong>${money(result)}</strong>
      ${note ? `<small>${note}</small>` : ''}
    </div>`;
  const rate = (label, numerator, base, value) => `
    <div class="modeco-formula-row">
      <span class="modeco-formula-name">${label}</span>
      <span class="modeco-formula-expression">${base ? `${money(numerator)} ÷ ${money(base)} × 100` : 'Sin ingresos; el backend establece el margen en 0%'}</span>
      <strong>${(value || 0).toFixed(2)}%</strong>
    </div>`;

  container.innerHTML = `
    <div class="modeco-formula-grid">
      <section class="modeco-formula-group">
        <h3>Resultados del período</h3>
        <p class="modeco-formula-note">COGS: costos directos de venta/producción. OPEX: costos de operación. CAPEX: compra o mejora de activos. Modeco: impuestos, intereses, depreciación y otros gastos configurados.</p>
        ${formula('Ingresos', 'Suma de categorías clasificadas como Ingreso', mes.ingresos)}
        ${formula('Gastos totales', 'COGS + OPEX + CAPEX + Modeco', mes.gastos)}
        ${formula('Utilidad bruta', `${money(mes.ingresos)} − ${money(groups.COGS)}`, mes.utilidadBruta)}
        ${formula('Utilidad operativa', `${money(mes.utilidadBruta)} − ${money(groups.OPEX)}`, mes.utilidadOperativa)}
        ${formula('Utilidad neta', `${money(mes.utilidadOperativa)} − ${money(groups.Modeco)}`, mes.utilidadNeta, 'No resta CAPEX. El indicador porcentual junto a Ingresos, Gastos y Utilidad compara con el mes anterior.')}
        ${formula('Flujo después de CAPEX', `${money(mes.utilidadNeta)} − ${money(groups.CAPEX)}`, mes.flujoDespuesCapex, 'Utilidad neta menos CAPEX; no incluye otros movimientos de efectivo.')}
      </section>
      <section class="modeco-formula-group">
        <h3>Márgenes</h3>
        ${rate('Margen bruto', mes.utilidadBruta, mes.ingresos, mes.margenBruto)}
        ${rate('Margen operativo', mes.utilidadOperativa, mes.ingresos, mes.margenOperativo)}
        ${rate('Margen neto', mes.utilidadNeta, mes.ingresos, mes.margenNeto)}
        <p class="modeco-formula-note">Cada margen indica qué porcentaje de los ingresos queda después del nivel de costos correspondiente. Si los ingresos son cero, el backend devuelve 0%.</p>
      </section>
      <section class="modeco-formula-group">
        <h3>Posición de Modeco</h3>
        ${formula('Activos líquidos', 'BHD Modeco + efectivo Modeco + efectivo USD Modeco', balance.activos)}
        ${formula('Patrimonio Modeco', `${money(balance.activos)} − ${money(balance.prestamo)}`, balance.patrimonio, 'Usa el último saldo disponible; no cambia al elegir otro mes.')}
        <p class="modeco-formula-note">El porcentaje junto al patrimonio compara el saldo actual con el saldo del mes anterior.</p>
      </section>
    </div>`;
}

function renderModecoIngresosChart() {
  const container = document.getElementById('modecoIngresosChart');
  if (!container) return;

  const categorias = Object.values(modecoData?.categorias || {})
    .filter(c => (c.clasificacion || getModecoClasificacion(c.name)) === 'Ingreso')
    .map(c => ({ ...c, selectedValue: getModecoCategoryValue(c) }))
    .filter(c => c.selectedValue > 0)
    .sort((a, b) => b.selectedValue - a.selectedValue);

  if (categorias.length === 0) {
    renderModecoEmptyChart(container, 'modecoIngresos', 'Sin ingresos registrados en el período seleccionado');
    return;
  }

  container.classList.remove('is-empty');
  const ctx = getCanvas('modecoIngresosChart');
  if (!ctx) return;

  charts.modecoIngresos = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: categorias.map(c => c.name.replace('Modeco - ', '')),
      datasets: [{
        label: 'Ingresos',
        data: categorias.map(c => c.selectedValue),
        backgroundColor: categorias.map((_, i) => [
          '#22c55e', '#10b981', '#84cc16', '#14b8a6', '#4ade80'
        ][i % 5]),
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(51,65,85,0.5)',
          borderWidth: 1,
          callbacks: {
            label: (ctx) => fmtMoney(ctx.parsed.x)
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(51,65,85,0.2)' },
          ticks: {
            color: '#64748b',
            callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K'
          }
        },
        y: {
          grid: { display: false },
          ticks: { color: '#94a3b8', font: { size: 11 } }
        }
      }
    }
  });
}

function renderModecoGastosPorClasifChart() {
  const container = document.getElementById('modecoGastosClasificacionChart');
  if (!container) return;

  const mes = getModecoMesActual();
  const clasif = mes?.clasificaciones || {};
  const labels = ['COGS', 'OPEX', 'CAPEX', 'Modeco'];
  const values = labels.map(k => clasif[k] || 0);

  if (values.every(v => v === 0)) {
    renderModecoEmptyChart(container, 'modecoGastosClasif', 'Sin gastos registrados en el período seleccionado');
    return;
  }

  container.classList.remove('is-empty');
  const ctx = getCanvas('modecoGastosClasificacionChart');
  if (!ctx) return;

  charts.modecoGastosClasif = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map(k => MODECO_CLASIF_COLORS[k]),
        borderColor: '#0f172a',
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: '#94a3b8',
            usePointStyle: true,
            boxWidth: 8,
            padding: 16
          }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? (ctx.parsed / total) * 100 : 0;
              return `${ctx.label}: ${fmtMoney(ctx.parsed)} (${pct.toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });
}

function renderModecoIngresosVsGastosChart() {
  const container = document.getElementById('modecoIngresosVsGastosChart');
  if (!container) return;

  const meses = [...(modecoData?.meses || [])].reverse();
  if (meses.length === 0) {
    container.innerHTML = '<div style="color:#64748b;text-align:center;padding:60px 16px;">Sin historial mensual</div>';
    charts.modecoIngVsGas = null;
    return;
  }

  const ctx = getCanvas('modecoIngresosVsGastosChart');
  if (!ctx) return;

  charts.modecoIngVsGas = new Chart(ctx, {
    data: {
      labels: meses.map(m => formatModecoPeriodLabel(m.mes)),
      datasets: [
        {
          type: 'bar',
          label: 'Ingresos',
          data: meses.map(m => m.ingresos || 0),
          backgroundColor: 'rgba(34,197,94,0.75)',
          borderRadius: 6,
          borderSkipped: false
        },
        {
          type: 'bar',
          label: 'Gastos',
          data: meses.map(m => m.gastos || 0),
          backgroundColor: 'rgba(239,68,68,0.75)',
          borderRadius: 6,
          borderSkipped: false
        },
        {
          type: 'line',
          label: 'Utilidad Neta',
          data: meses.map(m => m.utilidadNeta || 0),
          borderColor: '#3b82f6',
          backgroundColor: '#3b82f6',
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { color: '#94a3b8', usePointStyle: true, boxWidth: 8 }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(51,65,85,0.2)' },
          ticks: {
            color: '#64748b',
            callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K'
          }
        }
      }
    }
  });
}

function renderModecoWaterfallChart() {
  const container = document.getElementById('modecoWaterfallChart');
  if (!container) return;

  const mes = getModecoMesActual();
  if (!mes) {
    container.innerHTML = '<div style="color:#64748b;text-align:center;padding:60px 16px;">Sin datos para la cascada</div>';
    charts.modecoWaterfall = null;
    return;
  }

  const ingresos = mes.ingresos || 0;
  const cogs = mes.clasificaciones?.COGS || 0;
  const opex = mes.clasificaciones?.OPEX || 0;
  const gastosModeco = mes.clasificaciones?.Modeco || 0;
  const despuesCogs = ingresos - cogs;
  const despuesOpex = despuesCogs - opex;
  const utilidadNeta = despuesOpex - gastosModeco;

  const labels = ['Ingresos', 'COGS', 'OPEX', 'Modeco', 'Utilidad Neta'];
  const ranges = [
    [0, ingresos],
    [despuesCogs, ingresos],
    [despuesOpex, despuesCogs],
    [utilidadNeta, despuesOpex],
    [Math.min(0, utilidadNeta), Math.max(0, utilidadNeta)]
  ];
  const colors = [
    '#22c55e',
    MODECO_CLASIF_COLORS.COGS,
    MODECO_CLASIF_COLORS.OPEX,
    MODECO_CLASIF_COLORS.Modeco,
    utilidadNeta >= 0 ? '#3b82f6' : '#ef4444'
  ];

  const ctx = getCanvas('modecoWaterfallChart');
  if (!ctx) return;

  charts.modecoWaterfall = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Cascada',
        data: ranges,
        backgroundColor: colors,
        borderRadius: 8,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          callbacks: {
            label: (ctx) => {
              const range = ctx.raw;
              const value = Math.abs(range[1] - range[0]);
              return `${ctx.label}: ${fmtMoney(value)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#94a3b8', font: { size: 11, weight: '600' } }
        },
        y: {
          grid: { color: 'rgba(51,65,85,0.2)' },
          ticks: {
            color: '#64748b',
            callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K'
          }
        }
      }
    }
  });
}

function renderModecoBalanceChart() {
  const container = document.getElementById('modecoBalanceChart');
  if (!container) return;

  const b = modecoData?.balance || {};
  const labels = ['BHD - Modeco', 'Cash - Modeco', 'Cash USD - Modeco', 'Préstamo Modeco'];
  const values = [
    b.bhdModeco?.current || 0,
    b.cashModeco?.current || 0,
    b.cashUsdModeco?.current || 0,
    b.prestamoModeco?.current || 0
  ];

  if (values.every(v => v === 0)) {
    container.innerHTML = '<div style="color:#64748b;text-align:center;padding:60px 16px;">Sin datos de balance</div>';
    charts.modecoBalance = null;
  } else {
    const ctx = getCanvas('modecoBalanceChart');
    if (ctx) {
      charts.modecoBalance = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: ['#3b82f6', '#22c55e', '#14b8a6', '#ef4444'],
            borderColor: '#0f172a',
            borderWidth: 3,
            hoverOffset: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { color: '#94a3b8', usePointStyle: true, boxWidth: 8 }
            },
            tooltip: {
              backgroundColor: 'rgba(15,23,42,0.95)',
              titleColor: '#e2e8f0',
              bodyColor: '#e2e8f0',
              callbacks: {
                label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed)}`
              }
            }
          }
        }
      });
    }
  }

  renderModecoBalanceEvolutionChart();
}

function renderModecoBalanceEvolutionChart() {
  const container = document.getElementById('modecoBalanceEvolutionChart');
  if (!container) return;

  const b = modecoData?.balance || {};
  const baseHistory = b.bhdModeco?.history || [];

  if (baseHistory.length === 0) {
    container.innerHTML = '<div style="color:#64748b;text-align:center;padding:60px 16px;">Sin evolución de balance</div>';
    charts.modecoBalanceEvolution = null;
    return;
  }

  const labels = baseHistory.map(h => formatShortDate(h.date));
  const activos = baseHistory.map((_, i) =>
    (b.bhdModeco?.history?.[i]?.value || 0) +
    (b.cashModeco?.history?.[i]?.value || 0) +
    (b.cashUsdModeco?.history?.[i]?.value || 0)
  );
  const prestamo = baseHistory.map((_, i) => b.prestamoModeco?.history?.[i]?.value || 0);
  const patrimonio = activos.map((v, i) => v - prestamo[i]);

  const ctx = getCanvas('modecoBalanceEvolutionChart');
  if (!ctx) return;

  charts.modecoBalanceEvolution = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Activos Modeco',
          data: activos,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2
        },
        {
          label: 'Préstamo',
          data: prestamo,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          fill: true,
          tension: 0.3,
          pointRadius: 2
        },
        {
          label: 'Patrimonio Modeco',
          data: patrimonio,
          borderColor: '#3b82f6',
          backgroundColor: '#3b82f6',
          tension: 0.3,
          pointRadius: 3
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { color: '#94a3b8', usePointStyle: true, boxWidth: 8 }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#e2e8f0',
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#64748b', maxTicksLimit: 10 }
        },
        y: {
          grid: { color: 'rgba(51,65,85,0.2)' },
          ticks: {
            color: '#64748b',
            callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K'
          }
        }
      }
    }
  });
}

function renderModecoCategoriasList() {
  const container = document.getElementById('modecoCategoriasList');
  if (!container) return;

  const sourceCategories = Object.values(modecoData?.categorias || {})
    .filter(category => (category.clasificacion || getModecoClasificacion(category.name)) !== 'Ingreso')
    .map(category => ({ ...category, selectedValue: getModecoCategoryValue(category) }));
  if (sourceCategories.length === 0) {
    container.innerHTML = '<div class="modeco-empty-state">Sin gastos registrados en el período seleccionado</div>';
    return;
  }

  const groups = [
    {
      title: 'COGS - Costo Directo', classification: 'COGS', categories: [
        'Compras y Materia Prima - COGS',
        'Logística Directa de Entrega - COGS',
        'Mermas / Desperdicio - COGS',
        'Reparaciones mantenimiento - COGS'
      ]
    },
    {
      title: 'OPEX - Gastos Operativos', classification: 'OPEX', categories: [
        'Recursos Humanos - OPEX',
        'Viajes y Representación - OPEX',
        'Operaciones y Planta - OPEX',
        'Desarrollo y Formacion - OPEX',
        'Administracion y Legales - OPEX',
        'Tecnología y Software - OPEX',
        'Marketing y Comercializacion - OPEX'
      ]
    },
    {
      title: 'CAPEX - Inversión en Activos Fijos', classification: 'CAPEX', categories: [
        'Maquinaria, Herramientas y Muebles - CAPEX'
      ]
    },
    {
      title: 'Impuestos e Intereses - Modeco', classification: 'Modeco', categories: [
        'Impuestos - Modeco',
        'Intereses y Comisiones Bancarias - Modeco'
      ]
    },
    { title: 'Fondo Misiones - Modeco', classification: 'Modeco', categories: ['Fondo Misiones - Modeco'], standalone: true },
    { title: 'Depreciación de Activos - Modeco', classification: 'Modeco', categories: ['Depreciacion de Activos - Modeco'], standalone: true },
    { title: 'Otros Gastos - Modeco', classification: 'Modeco', categories: ['Otros Gastos - Modeco'], standalone: true }
  ];

  const normalizeName = value => String(value ?? '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const sourceByName = new Map(sourceCategories.map(category => [normalizeName(category.name), category]));
  const configuredNames = new Set(groups.flatMap(group => group.categories).map(normalizeName));
  const parentHeadings = new Set([
    'COGS - Costo Directo',
    'OPEX - Gastos Operativos',
    'CAPEX - Inversion en Activos Fijos',
    'CAPEX - Inversión en Activos Fijos',
    'Impuestos e Intereses - Modeco'
  ].map(normalizeName));
  const unmapped = sourceCategories.filter(category =>
    !configuredNames.has(normalizeName(category.name)) && !parentHeadings.has(normalizeName(category.name)) && category.selectedValue !== 0
  );
  if (unmapped.length) {
    groups.push({ title: 'Sin clasificar', classification: 'Modeco', categories: unmapped.map(category => category.name) });
  }

  const groupRows = groups.map(group => ({
    ...group,
    rows: group.categories.map(name => ({
      ...(sourceByName.get(normalizeName(name)) || { name, selectedValue: 0, history: [] }),
      displayName: name
    }))
  }));
  const total = groupRows
    .flatMap(group => group.rows)
    .reduce((sum, category) => sum + Math.max(0, category.selectedValue), 0);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  container.innerHTML = `
    <p class="modeco-groups-note">Cada total principal se calcula con sus subcategorías. Los encabezados principales no se suman como gastos independientes.</p>
    <div class="modeco-expense-groups">
      ${groupRows.map(group => {
        const groupTotal = group.rows.reduce((sum, category) => sum + category.selectedValue, 0);
        const groupPct = total > 0 ? (groupTotal / total) * 100 : 0;
        const color = MODECO_CLASIF_COLORS[group.classification] || MODECO_CLASIF_COLORS.Modeco;
        const badgeClass = group.classification.toLowerCase();
        return `
          <section class="modeco-expense-group">
            <div class="modeco-expense-group-header">
              <div class="modeco-expense-group-title">
                <h3>${escapeHtml(group.title)}</h3>
                <span class="classif-badge ${badgeClass}">${group.classification}</span>
              </div>
              <div class="modeco-expense-group-total">
                <strong>${fmtMoney(groupTotal)}</strong>
                <span>${groupPct.toFixed(1)}% del gasto del período</span>
              </div>
            </div>
            <div class="modeco-expense-group-bar"><span style="width:${Math.max(0, Math.min(groupPct, 100))}%;background:${color}"></span></div>
            <div class="modeco-expense-children">
              ${group.standalone ? '' : group.rows.map(category => {
                const pct = total > 0 ? (category.selectedValue / total) * 100 : 0;
                const previousValue = Number(category.history?.[modecoSelectedMonthIndex + 1]?.value || 0);
                const changePct = previousValue ? ((category.selectedValue - previousValue) / Math.abs(previousValue)) * 100 : 0;
                return `
                  <div class="modeco-expense-child">
                    <div class="modeco-expense-child-name">${escapeHtml(category.displayName || category.name)}</div>
                    <div class="modeco-expense-child-share"><strong>${pct.toFixed(1)}%</strong><small>del total</small></div>
                    <div class="modeco-expense-child-amount">${fmtMoney(category.selectedValue)}</div>
                    <div class="modeco-expense-child-change ${category.selectedValue - previousValue >= 0 ? 'negative' : 'positive'}">${fmtPct(changePct)}</div>
                  </div>
                `;
              }).join('')}
            </div>
          </section>
        `;
      }).join('')}
    </div>
  `;
}

// ============================================================
// PROYECCIÓN POR CATEGORÍA — GRÁFICA
// ============================================================
function renderCategoryProjectionChart(containerId, projection, catName) {
    // ← getCanvas resuelve el <canvas> dentro del contenedor y destruye el anterior
    const ctx = getCanvas(containerId);
    if (!ctx) return;

    const labels = projection.labels;
    const today = projection.today;

    const datasets = [];

    // Presupuesto (línea horizontal roja punteada)
    if (projection.budget > 0) {
        datasets.push({
            label: projection.closed ? 'Gasto final del mes' : 'Presupuesto',
            data: labels.map(() => projection.budget),
            borderColor: '#ef4444',
            borderDash: [6, 6],
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
            tension: 0
        });
    }

    if (projection.prev2) {
        datasets.push({
            label: '-2 Gastos Acumulados',
            data: projection.prev2,
            borderColor: 'rgba(148,163,184,0.55)',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2
        });
    }

    if (projection.prev1) {
        datasets.push({
            label: '-1 Gastos Acumulados',
            data: projection.prev1,
            borderColor: '#f59e0b',
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
            tension: 0.2
        });
    }

    datasets.push({
        label: 'Gastos Prom 3m',
        data: projection.avg3mCumulative,
        borderColor: '#3b82f6',
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.2
    });

    datasets.push({
        label: 'Gastos Acumulados',
        data: projection.accumulated,
        borderColor: '#f8fafc',
        borderWidth: 2.5,
        pointRadius: 0,
        fill: false,
        tension: 0.2
    });

    if (projection.projected) datasets.push({
        label: 'Gastos Acumulado Proyectado',
        data: projection.projected,
        borderColor: '#f8fafc',
        borderDash: [5, 5],
        borderWidth: 2,
        pointRadius: 0,
        fill: false,
        tension: 0.2
    });

    if (!projection.closed) datasets.push({
        label: 'HOY',
        data: labels.map((_, i) => i === today - 1 ? projection.todayTotal : null),
        borderColor: '#fbbf24',
        backgroundColor: '#fbbf24',
        pointRadius: 8,
        pointStyle: 'crossRot',
        borderWidth: 3,
        showLine: false
    });

    new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        color: '#94a3b8',
                        font: { size: 10 },
                        usePointStyle: true,
                        boxWidth: 8,
                        padding: 10
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15,23,42,0.95)',
                    titleColor: '#e2e8f0',
                    bodyColor: '#e2e8f0',
                    borderColor: 'rgba(51,65,85,0.5)',
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => `Día ${items[0].label}`,
                        label: (ctx) => {
                            if (ctx.parsed.y === null || ctx.parsed.y === undefined) return null;
                            return ` ${ctx.dataset.label}: ${fmtMoney(ctx.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: '#64748b',
                        font: { size: 9 },
                        maxTicksLimit: 15,
                        maxRotation: 0
                    }
                },
                y: {
                    grid: { color: 'rgba(51,65,85,0.2)' },
                    ticks: {
                        color: '#64748b',
                        font: { size: 9 },
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

function renderExpenseCategoryMonthComparison(containerId, categoryName, selectedMonthKey, kind = 'gastos') {
    const sourceMonths = [...(gastosData?.meses || [])].sort((a, b) =>
        getExpenseMonthKey(b.isoDate || b.mes).localeCompare(getExpenseMonthKey(a.isoDate || a.mes))
    );
    const selectedIndex = sourceMonths.findIndex(month =>
        getExpenseMonthKey(month.isoDate || month.mes) === selectedMonthKey
    );
    if (selectedIndex < 0) return false;

    // La hoja está en orden del más reciente al más antiguo; tomamos el mes elegido y cinco previos.
    const monthWindow = sourceMonths.slice(selectedIndex, selectedIndex + 6).reverse();
    const categoryKey = normalizeExpenseCategoryName(
        [...DB_GASTOS_PRIMARY_CATEGORIES, ...DB_GASTOS_PRIMARY_INCOME_CATEGORIES].find(name => normalizeExpenseCategoryName(name) === normalizeExpenseCategoryName(categoryName))
        || getCatMeta(categoryName).etiqueta
        || categoryName
    );
    const values = monthWindow.map(month => {
        const rawValue = Object.entries(month.valores || {}).find(([name]) =>
            normalizeExpenseCategoryName(name) === categoryKey
        )?.[1];
        return Number(rawValue) || 0;
    });
    const previousValues = values.slice(0, -1);
    const priorAverage = previousValues.length
        ? previousValues.reduce((sum, value) => sum + value, 0) / previousValues.length
        : null;
    const selectedIsLast = monthWindow.at(-1) &&
        getExpenseMonthKey(monthWindow.at(-1).isoDate || monthWindow.at(-1).mes) === selectedMonthKey;
    if (!selectedIsLast) return false;

    const ctx = getCanvas(containerId);
    if (!ctx) return false;
    const selectedLabel = formatExpenseMonth(selectedMonthKey);
    const labels = monthWindow.map(month => formatExpenseMonth(
        getExpenseMonthKey(month.isoDate || month.mes)
    ));
    const colors = monthWindow.map((_, index) =>
        index === monthWindow.length - 1 ? '#f59e0b' : 'rgba(59,130,246,0.68)'
    );
    const comparisonCategoryKey = kind === 'ingresos' ? normalizeIncomeCategoryName(categoryName) : categoryKey;
    const budgetsByMonth = new Map();
    if (kind === 'ingresos') {
        monthWindow.forEach(month => {
            const key = getExpenseMonthKey(month.isoDate || month.mes);
            const group = getIncomeBudgetRowsByCategory(key).find(item =>
                normalizeIncomeCategoryName(item.name) === comparisonCategoryKey
            );
            if (group) budgetsByMonth.set(key, group.total);
        });
    } else {
        const categoryById = new Map((appData.categorias || []).map(category => [
            String(category.id).trim(), normalizeExpenseCategoryName(category.etiqueta || category.nombre)
        ]));
        (appData.presupuesto || []).forEach(row => {
            if (row.tipo !== 'Gastos') return;
            const key = getExpenseMonthKey(row.mesAno);
            const categoryKeyForRow = categoryById.get(String(row.idCategoria).trim());
            if (!key || categoryKeyForRow !== comparisonCategoryKey) return;
            budgetsByMonth.set(key, (budgetsByMonth.get(key) || 0) + (Number(row.montoPresupuestado) || 0));
        });
    }
    const isClosedMonth = selectedMonthKey < getExpenseMonthKey(new Date());
    const selectedCategoryBudget = kind === 'gastos' && isClosedMonth
        ? values.at(-1)
        : (budgetsByMonth.get(selectedMonthKey) ?? null);

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: kind === 'ingresos' ? 'Ingreso mensual' : 'Gasto mensual',
                    data: values,
                    backgroundColor: colors,
                    borderRadius: 5,
                    maxBarThickness: 38
                },
                ...(priorAverage === null ? [] : [{
                    type: 'line',
                    label: 'Promedio de meses anteriores',
                    data: labels.map(() => priorAverage),
                    borderColor: '#22c55e',
                    borderDash: [5, 4],
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: false
                }]),
                ...(selectedCategoryBudget === null ? [] : [{
                    type: 'line',
                    label: kind === 'ingresos' ? 'Meta de la categoría' : 'Presupuesto de la categoría',
                    data: labels.map(() => selectedCategoryBudget),
                    borderColor: '#f87171',
                    borderDash: [3, 3],
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#f87171',
                    spanGaps: false,
                    fill: false
                }])
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                title: {
                    display: true,
                    text: `Seleccionado: ${selectedLabel}`,
                    color: '#94a3b8',
                    align: 'start',
                    font: { size: 11, weight: '600' },
                    padding: { bottom: 8 }
                },
                legend: {
                    position: 'top',
                    labels: { color: '#94a3b8', font: { size: 10 }, usePointStyle: true, boxWidth: 8 }
                },
                tooltip: {
                    callbacks: {
                        label: item => ` ${item.dataset.label}: ${fmtMoney(item.parsed.y)}`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#94a3b8', maxRotation: 0 } },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(51,65,85,0.2)' },
                    ticks: { color: '#64748b', callback: value => formatCompactMoney(value) }
                }
            }
        }
    });
    return true;
}

function loadExpenseProjections(expenseLines, monthKey = expensesSelectedMonthKey) {
    if (expensesSelectedMonthKey !== monthKey || !gastosData) return;
    expenseLines.forEach((line, index) => {
        const chartId = `expenseProjChart_${index}`;
        const wrapper = document.querySelector(`[data-proj-chart-id="${chartId}"]`);
        if (!wrapper) return;
        wrapper.style.display = 'block';
        if (!renderExpenseCategoryMonthComparison(chartId, line.name, monthKey)) wrapper.style.display = 'none';
    });
}

function loadIncomeCategoryComparisons(incomeLines, monthKey = incomeSelectedMonthKey) {
    if (incomeSelectedMonthKey !== monthKey || !gastosData) return;
    incomeLines.forEach((line, index) => {
        const chartId = `incomeProjChart_${index}`;
        const wrapper = document.querySelector(`[data-proj-chart-id="${chartId}"]`);
        if (!wrapper) return;
        wrapper.style.display = 'block';
        if (!renderExpenseCategoryMonthComparison(chartId, line.name, monthKey, 'ingresos')) {
            wrapper.style.display = 'none';
        }
    });
}

function escapeExpenseHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

async function toggleExpenseCategoryDetail(index) {
    return toggleMonthlyCategoryDetail(index, 'gastos');
}

async function toggleIncomeCategoryDetail(index) {
    return toggleMonthlyCategoryDetail(index, 'ingresos');
}

async function toggleMonthlyCategoryDetail(index, kind) {
    const panelId = `${kind === 'ingresos' ? 'income' : 'expense'}CategoryDetail_${index}`;
    const panel = document.getElementById(panelId);
    const card = document.querySelector(`[aria-controls="${panelId}"]`);
    if (!panel || !card) return;
    if (!panel.hidden) {
        panel.hidden = true;
        card.setAttribute('aria-expanded', 'false');
        const hint = card.querySelector('.expense-detail-hint');
        if (hint) hint.textContent = 'Ver detalle⌄';
        return;
    }

    panel.hidden = false;
    card.setAttribute('aria-expanded', 'true');
    const hint = card.querySelector('.expense-detail-hint');
    if (hint) hint.textContent = 'Ocultar detalle⌃';
    const monthKey = kind === 'ingresos' ? incomeSelectedMonthKey : expensesSelectedMonthKey;
    if (panel.dataset.loadedMonth === monthKey) return;
    panel.innerHTML = '<div class="expense-detail-loading">Cargando movimientos del mes…</div>';
    const categoryName = card.querySelector('.expense-name, .income-name')?.textContent || '';
    const [year, month] = monthKey.split('-').map(Number);
    try {
        const data = await loadDailySupabase(kind, year, month);
        const currentMonthKey = kind === 'ingresos' ? incomeSelectedMonthKey : expensesSelectedMonthKey;
        if (currentMonthKey !== monthKey || panel.hidden) return;
        panel.innerHTML = renderExpenseCategoryDetail(data, categoryName, monthKey, kind);
        panel.dataset.loadedMonth = monthKey;
    } catch (error) {
        panel.innerHTML = '<div class="expense-detail-empty">No se pudieron cargar los movimientos de esta categoría.</div>';
        console.warn('Error cargando detalle de categoría:', error);
    }
}

function renderExpenseCategoryDetail(data, categoryName, monthKey) {
    const canonicalCategory = name => {
        const normalized = normalizeExpenseCategoryName(name);
        const mapped = normalizeExpenseCategoryName(getCatMeta(name).etiqueta);
        if (normalized === 'investment' || mapped === 'investment') return 'inversiones';
        return mapped && mapped !== 'general' ? mapped : normalized;
    };
    const target = canonicalCategory(categoryName);
    const rootFor = name => {
        return canonicalCategory(name);
    };
    const matchesCategory = name => canonicalCategory(name) === target || rootFor(name) === target;
    const movements = (data?.movimientos || []).filter(item => matchesCategory(item.categoria));
    const escape = escapeExpenseHtml;

    if (movements.length) {
        const total = movements.reduce((sum, item) => sum + (Number(item.monto) || 0), 0);
        const byDay = new Map();
        movements.forEach(item => byDay.set(item.fecha, (byDay.get(item.fecha) || 0) + (Number(item.monto) || 0)));
        const dailySummary = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
        const rows = movements.slice().sort((a, b) =>
            String(b.fecha).localeCompare(String(a.fecha)) || (Number(b.monto) || 0) - (Number(a.monto) || 0)
        );
        const dailyHtml = dailySummary.map(([date, amount]) => `
            <div class="expense-detail-day"><span>${escape(formatExpenseDay(date))}</span><strong>${fmtMoney(amount)}</strong></div>
        `).join('');
        const movementHtml = rows.map(item => `
            <tr>
                <td>${escape(formatExpenseDay(item.fecha))}</td>
                <td>${escape(item.categoria)}</td>
                <td>${escape(item.descripcion || item.nota || 'Sin descripción')}${item.cuenta ? `<small>${escape(item.cuenta)}</small>` : ''}</td>
                <td class="expense-detail-amount">${fmtMoney(Number(item.monto) || 0)}</td>
            </tr>
        `).join('');
        return `
            <div class="expense-detail-summary"><strong>${fmtMoney(total)}</strong><span>${rows.length} movimientos · ${dailySummary.length} días con actividad</span></div>
            <div class="expense-detail-days">${dailyHtml}</div>
            <div class="expense-detail-table-wrap"><table class="expense-detail-table"><thead><tr><th>Fecha</th><th>Subcategoría</th><th>Descripción / cuenta</th><th>Monto</th></tr></thead><tbody>${movementHtml}</tbody></table></div>
        `;
    }

    // Compatibilidad con respuestas antiguas del endpoint: mostrar al menos el gasto por día.
    const dailyRows = (data?.dias || []).map(day => {
        const amount = Object.entries(day.categorias || {}).reduce((sum, [name, value]) =>
            matchesCategory(name) ? sum + (Number(value) || 0) : sum, 0);
        return { date: day.fecha, amount };
    }).filter(day => day.amount > 0).sort((a, b) => b.date.localeCompare(a.date));
    if (!dailyRows.length) {
        if (!Array.isArray(data?.movimientos)) {
            return `<div class="expense-detail-empty">El resumen diario está disponible, pero el endpoint de Apps Script aún no entrega los movimientos individuales. Debe desplegarse la actualización de Exportacion.gs.</div>`;
        }
        if (data.movimientos.length === 0 && !(Number(data.totalTransacciones) > 0)) {
            return `<div class="expense-detail-empty">Wallet/Supabase no devolvió transacciones para ${escape(formatExpenseMonth(monthKey))}.</div>`;
        }
        return `<div class="expense-detail-empty">Se recibieron ${data.movimientos.length} movimientos del mes, pero ninguno coincide con la categoría “${escape(categoryName)}”.</div>`;
    }
    const total = dailyRows.reduce((sum, day) => sum + day.amount, 0);
    return `
        <div class="expense-detail-summary"><strong>${fmtMoney(total)}</strong><span>Detalle diario agregado · movimientos individuales no disponibles</span></div>
        <div class="expense-detail-days">${dailyRows.map(day => `
            <div class="expense-detail-day"><span>${escape(formatExpenseDay(day.date))}</span><strong>${fmtMoney(day.amount)}</strong></div>
        `).join('')}</div>
    `;
}

function formatExpenseDay(value) {
    const date = new Date(`${String(value || '').substring(0, 10)}T12:00:00`);
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleDateString('es-DO', {
        weekday: 'short', day: 'numeric', month: 'short'
    });
}

// ============================================================================
// SUPABASE DIARIO — GASTOS E INGRESOS
// ============================================================================

// Anti-colisión y dedup de requests JSONP en vuelo
const dailyInFlight = {};

function loadDailySupabase(tipo, year, month) {
    const key = `${tipo}_${year}_${String(month).padStart(2, '0')}`;

    // 1. Cache hit
    if (dailyCache[key]) return Promise.resolve(dailyCache[key]);

    // 2. Ya hay un request en vuelo para este mes → reusar
    if (dailyInFlight[key]) return dailyInFlight[key];

    // 3. Nuevo request
    dailyInFlight[key] = new Promise((resolve, reject) => {
        // Callback con sufijo aleatorio para evitar colisiones
        const cb = 'dailyCb_' + Date.now() + '_' +
                   Math.random().toString(36).slice(2, 8);

        const script = document.createElement('script');
        const timeout = setTimeout(() => {
            delete dailyInFlight[key];
            cleanup();
            reject(new Error(`Timeout cargando ${tipo} ${year}-${month}`));
        }, 45000);

        function cleanup() {
            if (script.parentNode) script.parentNode.removeChild(script);
            delete window[cb];
            clearTimeout(timeout);
        }

        window[cb] = (data) => {
            if (data && data.error) {
                delete dailyInFlight[key];
                cleanup();
                reject(new Error(data.message || 'Error del servidor'));
            } else {
                dailyCache[key] = data;
                delete dailyInFlight[key];
                cleanup();
                resolve(data);
            }
        };

        script.onerror = () => {
            delete dailyInFlight[key];
            cleanup();
            reject(new Error('Error de red JSONP'));
        };

        const action = tipo === 'gastos' ? 'getDailyGastos' : 'getDailyIngresos';
        const url = CONFI.API_URL + '?action=' + action +
                    '&year=' + year + '&month=' + month +
                    '&callback=' + cb;

        console.log(`📡 JSONP ${tipo} ${year}-${month}:`, url.substring(0, 100) + '...');
        script.src = url;
        document.head.appendChild(script);
    });

    return dailyInFlight[key];
}

let dailySupabaseChart = null;

// Registrar charts por tipo para poder destruirlos individualmente
let dailyCharts = { gastos: null, ingresos: null };

// Paleta estable por índice (los top reciben colores distintos garantizados)
const CATEGORY_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
  '#22c55e', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#64748b', '#78716c', '#a8a29e', '#94a3b8'
];

function formatCompactMoney(val) {
  if (val >= 1000000) return 'RD$' + (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000)    return 'RD$' + (val / 1000).toFixed(0) + 'K';
  return 'RD$' + Math.round(val);
}

function renderExpenseDailyFallback(data) {
  if (!data || expensesSelectedMonthKey !== `${data.year}-${String(data.month).padStart(2, '0')}`) return;

  const hasBudgetRows = (appData.presupuesto || []).some(row =>
    row.tipo === 'Gastos' && getExpenseMonthKey(row.mesAno) === expensesSelectedMonthKey
  );
  const balanceActual = getExpenseHistoryValue(appData.summary.gastosTotal, expensesSelectedMonthKey);
  const dbGastosTotals = getDbGastosMonthlyTotals(expensesSelectedMonthKey);
  if (!hasBudgetRows && balanceActual === null && dbGastosTotals === null) {
    const valueEl = document.getElementById('expensesActualValue');
    const subEl = document.getElementById('expensesActualSub');
    const isClosedMonth = expensesSelectedMonthKey < getExpenseMonthKey(new Date());
    const finalValue = Number(data.totalMes) || 0;
    if (valueEl) {
      valueEl.textContent = fmtMoney(finalValue);
      valueEl.style.color = '#e2e8f0';
    }
    if (subEl) subEl.textContent = isClosedMonth
      ? 'Cierre mensual según transacciones de Wallet / Supabase'
      : 'Total de transacciones en Wallet / Supabase';
    if (isClosedMonth) {
      const budgetValueEl = document.getElementById('expensesBudgetValue');
      const budgetSubEl = document.getElementById('expensesBudgetSub');
      if (budgetValueEl) budgetValueEl.textContent = fmtMoney(finalValue);
      if (budgetSubEl) budgetSubEl.textContent = 'Mes cerrado · referencia igual al gasto final';
    }
  }

  const hasHistoryByCategory = Object.values(appData.gastos || {}).some(category => {
    const amount = getExpenseHistoryValue(category, expensesSelectedMonthKey);
    return amount !== null && amount !== 0;
  });
  if (hasBudgetRows || hasHistoryByCategory || dbGastosTotals !== null) return;

  const categories = (data.topCategorias || []).filter(category => Number(category.total) > 0);
  const container = document.getElementById('expenseCategoriesList');
  if (!container) return;
  clearExpenseProjectionCharts();
  if (!categories.length) {
    container.innerHTML = '<div class="modeco-empty-state">Sin transacciones de gasto en el mes seleccionado.</div>';
  } else {
    const total = categories.reduce((sum, category) => sum + Number(category.total || 0), 0);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
    container.innerHTML = `<div class="asset-list">${categories.map((category, index) => {
      const share = total > 0 ? (category.total / total) * 100 : 0;
      const color = CATEGORY_PALETTE[index % CATEGORY_PALETTE.length];
      return `
        <div class="expense-card expense-category-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="expenseCategoryDetail_${index}"
             onclick="toggleExpenseCategoryDetail(${index})"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleExpenseCategoryDetail(${index})}"
             style="border-left:3px solid ${color}">
          <div class="expense-icon" style="background:${color}20;color:${color}">${index + 1}</div>
          <div class="expense-main">
            <div class="expense-header"><div class="expense-name">${escapeHtml(category.name)}</div><div style="display:flex;align-items:center;gap:10px"><span class="expense-detail-hint">Ver detalle⌄</span><div class="expense-pct" style="color:${color}">${expensesSelectedMonthKey < getExpenseMonthKey(new Date()) ? '100.0%' : `${share.toFixed(1)}%`}</div></div></div>
            <div class="expense-meta">${fmtMoney(category.total)}${expensesSelectedMonthKey < getExpenseMonthKey(new Date()) ? ` / ${fmtMoney(category.total)} · gasto final` : ' · sin presupuesto asignado'}</div>
            <div class="expense-bar-track"><div class="expense-bar-remaining" style="width:${expensesSelectedMonthKey < getExpenseMonthKey(new Date()) ? 100 : Math.min(share, 100)}%;background:${color}"></div></div>
          </div>
        </div>
        <div class="expense-category-detail" id="expenseCategoryDetail_${index}" hidden></div>
        <div class="expense-projection" data-proj-chart-id="expenseProjChart_${index}"
             style="display:block;padding:14px 16px;background:rgba(15,23,42,0.55);border:1px solid rgba(51,65,85,0.2);border-top:none;border-radius:0 0 12px 12px;margin-top:-10px;margin-bottom:10px;">
          <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">📈 Comparación con meses anteriores · ${escapeHtml(category.name)}</div>
          <div class="chart-container" id="expenseProjChart_${index}" style="height:240px;"></div>
        </div>`;
    }).join('')}</div>`;
  }
  if (categories.length) {
    setTimeout(() => loadExpenseProjections(categories.map(category => ({
      name: category.name,
      montoPresupuestado: Number(category.total) || 0
    })), expensesSelectedMonthKey), 50);
  }

  if (charts.expensesPie) {
    charts.expensesPie.destroy();
    delete charts.expensesPie;
  }
  renderExpensesPieChart(categories);
}

async function renderDailySupabase(tipo) {
  const isGasto   = tipo === 'gastos';
  const chartId   = isGasto ? 'dailyGastosChart'    : 'dailyIngresosChart';
  const statsId   = isGasto ? 'dailyGastosStats'    : 'dailyIngresosStats';
  const listId    = isGasto ? 'dailyGastosList'     : 'dailyIngresosList';
  const heatmapId = isGasto ? 'dailyGastosHeatmap'  : 'dailyIngresosHeatmap';
  const selectId  = isGasto ? 'expensesMonthSelect' : 'incomeMonthSelect';

  const statsEl = document.getElementById(statsId);
  const listEl  = document.getElementById(listId);
  if (!statsEl) return;

  statsEl.innerHTML = '<div class="stat-card" style="grid-column:1/-1">' +
    '<div class="stat-value" style="font-size:14px;color:#64748b">⏳ Cargando...</div></div>';

  // Ambas secciones comparten un selector único para resumen y detalle diario.
  const select = document.getElementById(selectId);
  const selValue = isGasto
    ? (expensesSelectedMonthKey || select?.value)
    : (incomeSelectedMonthKey || select?.value);
  const [yearStr, monthStr] = selValue.split('-');

  try {
    const data = await loadDailySupabase(tipo, yearStr, monthStr);
    const currentlySelected = isGasto ? expensesSelectedMonthKey : incomeSelectedMonthKey;
    if (currentlySelected && currentlySelected !== selValue) return;
    if (isGasto) renderExpenseDailyFallback(data);

    if (!data.dias || data.dias.length === 0) {
      statsEl.innerHTML = '<div class="stat-card" style="grid-column:1/-1">' +
        '<div class="stat-value" style="font-size:14px;color:#64748b">Sin transacciones este mes</div></div>';
      if (listEl) listEl.innerHTML = '';
      if (dailyCharts[tipo]) { dailyCharts[tipo].destroy(); dailyCharts[tipo] = null; }
      renderHeatmap(heatmapId, data, tipo);
      return;
    }

    const color = isGasto ? '#ef4444' : '#22c55e';

    // Categorías ordenadas por ranking (usado por chart Y lista)
    const MAX_STACK = 8;
    const allCats = data.categoriasStacked || [];
    const topCats = allCats.slice(0, MAX_STACK);
    const otrosCats = allCats.slice(MAX_STACK);

    // ---------- STATS ----------
    const diaMax = data.dias.reduce((a, b) => a.total > b.total ? a : b);
    statsEl.innerHTML = `
      <div class="stat-card" style="border-top:3px solid ${color}">
        <div class="stat-header"><span class="stat-label">Total del Mes</span></div>
        <div class="stat-value" style="color:${color}">${fmtMoney(data.totalMes)}</div>
        <div class="stat-sub">${data.totalTransacciones} transacciones</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #3b82f6">
        <div class="stat-header"><span class="stat-label">Promedio Diario</span></div>
        <div class="stat-value">${fmtMoney(data.promedioDiario)}</div>
        <div class="stat-sub">${data.diasConDatos} días con actividad</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #f59e0b">
        <div class="stat-header"><span class="stat-label">Día Más Alto</span></div>
        <div class="stat-value">${fmtMoney(diaMax.total)}</div>
        <div class="stat-sub">${diaMax.fecha}</div>
      </div>
      <div class="stat-card" style="border-top:3px solid #8b5cf6">
        <div class="stat-header"><span class="stat-label">Top Categoría</span></div>
        <div class="stat-value" style="font-size:16px">${data.topCategorias[0]?.name || '—'}</div>
        <div class="stat-sub">${fmtMoney(data.topCategorias[0]?.total || 0)}</div>
      </div>
    `;

    // ---------- STACKED BAR CHART ----------
    const ctx = getCanvas(chartId);
    if (ctx) {
      if (dailyCharts[tipo]) dailyCharts[tipo].destroy();

      const labels = data.dias.map(d => d.fecha.substring(8, 10)); // solo día "01".."31"

      const datasets = topCats.map((c, i) => ({
        label: c.name,
        data: c.dias.map(d => d.monto),
        backgroundColor: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
        borderColor: '#0f172a',
        borderWidth: 1,
        borderRadius: 3,
        stack: 'stack1'
      }));

      // Agrupar resto como "Otros"
      if (otrosCats.length > 0) {
        const otrosData = data.dias.map(d => {
          let sum = 0;
          otrosCats.forEach(c => { sum += (d.categorias && d.categorias[c.name]) || 0; });
          return sum;
        });
        const otrosTotal = otrosData.reduce((a, b) => a + b, 0);
        if (otrosTotal > 0) {
          datasets.push({
            label: 'Otros',
            data: otrosData,
            backgroundColor: '#475569',
            borderColor: '#0f172a',
            borderWidth: 1,
            borderRadius: 3,
            stack: 'stack1'
          });
        }
      }

      dailyCharts[tipo] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: {
              position: 'bottom',
              labels: {
                color: '#94a3b8',
                font: { size: 10 },
                usePointStyle: true,
                boxWidth: 8,
                padding: 10
              }
            },
            tooltip: {
              backgroundColor: 'rgba(15,23,42,0.95)',
              titleColor: '#e2e8f0',
              bodyColor: '#e2e8f0',
              borderColor: 'rgba(51,65,85,0.5)',
              borderWidth: 1,
              callbacks: {
                title: (items) => 'Día ' + items[0].label,
                label: (item) => {
                  if (!item.parsed.y) return null;
                  return ` ${item.dataset.label}: ${fmtMoney(item.parsed.y)}`;
                },
                footer: (items) => {
                  const total = items.reduce((s, i) => s + (i.parsed.y || 0), 0);
                  return 'Total: ' + fmtMoney(total);
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              grid: { display: false },
              ticks: { color: '#64748b', font: { size: 10 } }
            },
            y: {
              stacked: true,
              grid: { color: 'rgba(51,65,85,0.2)' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                callback: (v) => 'RD$' + (v / 1000).toFixed(0) + 'K'
              }
            }
          }
        }
      });
    }

    // ---------- LISTA DIARIA ----------
    if (listEl) {
      listEl.innerHTML = '<div class="asset-list">' + data.dias
        .slice()
        .sort((a, b) => b.total - a.total)
        .map(d => {
          const fecha = new Date(d.fecha + 'T12:00:00');
          const label = fecha.toLocaleDateString('es-DO', {
            weekday: 'short', day: 'numeric', month: 'short'
          });
          // mini badge con las top 2 categorías del día
          const topDia = Object.entries(d.categorias)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
          const badges = topDia.map(([name, amt]) => {
            const catIdx = allCats.findIndex(c => c.name === name);
            const bg = catIdx >= 0
              ? CATEGORY_PALETTE[catIdx % CATEGORY_PALETTE.length]
              : '#475569';
            return `<span style="display:inline-block;padding:1px 6px;background:${bg}30;border-radius:4px;font-size:9px;color:${bg};margin-right:4px;font-weight:700;">${name}</span>`;
          }).join('');

          return `
            <div class="asset-item">
              <div class="asset-icon-wrap" style="background:${color}20;color:${color}">${d.fecha.substring(8,10)}</div>
              <div class="asset-info">
                <div class="asset-name">${label}</div>
                <div class="asset-meta">${badges}<span style="color:#64748b">+${Math.max(0, Object.keys(d.categorias).length - 2)} más · ${d.count} tx</span></div>
              </div>
              <div class="asset-value">
                <div class="asset-amount" style="color:${color}">${fmtMoney(d.total)}</div>
              </div>
            </div>`;
        }).join('') + '</div>';
    }

    // ---------- HEATMAP ----------
    renderHeatmap(heatmapId, data, tipo);

  } catch (e) {
    const currentlySelected = isGasto
      ? expensesSelectedMonthKey
      : incomeSelectedMonthKey;
    if (currentlySelected && currentlySelected !== selValue) return;
    console.error('Error cargando ' + tipo + ' de Supabase:', e);
    statsEl.innerHTML = '<div class="stat-card" style="grid-column:1/-1">' +
      '<div class="stat-value" style="font-size:14px;color:#f87171">❌ ' + e.message + '</div></div>';
  }
}


// ============================================================
// HEATMAP CALENDAR
// ============================================================
function renderHeatmap(containerId, data, tipo) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!data.dias || data.dias.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#64748b;padding:24px;">Sin datos para este mes</div>';
    return;
  }

  const year  = parseInt(data.year, 10);
  const month = parseInt(data.month, 10) - 1; // 0-indexed
  const lastDay = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Dom..6=Sáb

  // Convertir a semana que empieza en lunes
  const startOffset = firstWeekday === 0 ? 6 : firstWeekday - 1;

  const weekdays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

  // Mapa fecha → entry
  const diasMap = {};
  data.dias.forEach(d => { diasMap[d.fecha] = d; });

  // Color según intensidad
  const maxVal = data.maxDia || 1;
  const colorLow  = tipo === 'gastos' ? [120, 30, 30]  : [20, 80, 40];
  const colorHigh = tipo === 'gastos' ? [239, 68, 68]  : [34, 197, 94];

  function intensityColor(val) {
    if (!val || val <= 0) return null;
    // Escala raíz cuadrada: valores pequeños siguen siendo visibles
    let t = Math.sqrt(val / maxVal);
    t = Math.max(0.2, Math.min(1, t));
    const r = Math.round(colorLow[0] + (colorHigh[0] - colorLow[0]) * t);
    const g = Math.round(colorLow[1] + (colorHigh[1] - colorLow[1]) * t);
    const b = Math.round(colorLow[2] + (colorHigh[2] - colorLow[2]) * t);
    return `rgb(${r},${g},${b})`;
  }

  let html = '';

  // Encabezados de días
  html += '<div class="heatmap-weekdays">';
  weekdays.forEach(w => { html += `<div class="heatmap-weekday">${w}</div>`; });
  html += '</div>';

  // Grid
  html += '<div class="heatmap-grid">';

  // Celdas vacías antes del día 1
  for (let i = 0; i < startOffset; i++) {
    html += '<div class="heatmap-cell empty"></div>';
  }

  // Días del mes
  for (let d = 1; d <= lastDay; d++) {
    const fechaISO = `${data.year}-${data.month}-${String(d).padStart(2, '0')}`;
    const entry = diasMap[fechaISO];

    if (entry && entry.total > 0) {
      const bg = intensityColor(entry.total);
      html += `
        <div class="heatmap-cell has-data"
             style="background:${bg};"
             title="${fechaISO} · ${fmtMoney(entry.total)} · ${entry.count} transacciones">
          <div class="heatmap-day-number">${d}</div>
          <div class="heatmap-day-amount">${formatCompactMoney(entry.total)}</div>
        </div>`;
    } else {
      html += `
        <div class="heatmap-cell no-data" title="${fechaISO} · Sin movimientos">
          <div class="heatmap-day-number">${d}</div>
        </div>`;
    }
  }

  html += '</div>';

  // Leyenda
  const steps = 5;
  let swatches = '';
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const sample = maxVal * t;
    const bg = intensityColor(sample) || 'rgba(30,41,59,0.3)';
    swatches += `<div class="heatmap-legend-swatch" style="background:${bg};"></div>`;
  }

  html += `
    <div class="heatmap-legend">
      <span>Menos</span>
      <div class="heatmap-legend-scale">${swatches}</div>
      <span>Más</span>
    </div>
  `;

  container.innerHTML = html;
}

function onDailyMonthChange(tipo) {
  renderDailySupabase(tipo);
}
