// ============================================================
// WALLET BY BUDGETBAKERS — API INTEGRATION (v8)
// ============================================================

const WALLET_CONFIG = {
    TOKEN_KEY: 'wallet_api_token',
    BUDGET_MAP_KEY: 'wallet_budget_mapping'
};

class WalletAPI {
    constructor() {
        this.token = localStorage.getItem(WALLET_CONFIG.TOKEN_KEY) || '';
        this.budgetMap = JSON.parse(localStorage.getItem(WALLET_CONFIG.BUDGET_MAP_KEY) || '{}');
        this.budgets = [];
    }

    setToken(token) {
        this.token = token.trim();
        localStorage.setItem(WALLET_CONFIG.TOKEN_KEY, this.token);
    }

    getToken() { return this.token; }
    isConfigured() { return !!this.token; }

    async request(endpoint, options = {}) {
        if (!this.token) throw new Error('Wallet API Token no configurado');

        const method = (options.method || 'GET').toUpperCase();
        const body = options.body || null;

        let proxyUrl = CONFI.API_URL +
            '?action=walletProxy' +
            '&walletMethod=' + encodeURIComponent(method) +
            '&walletEndpoint=' + encodeURIComponent(endpoint) +
            '&token=' + encodeURIComponent(this.token);

        if (body) proxyUrl += '&body=' + encodeURIComponent(body);

        const res = await fetch(proxyUrl);
        const result = await res.json();

        if (result.error) {
            const errMsg = result.message || `Error ${result.status}`;
            const detail = result.body ? ` | Respuesta: ${result.body.substring(0, 400)}` : '';
            throw new Error(errMsg + detail);
        }

        return result.data;
    }

    async loadBudgets() {
        const allBudgets = [];
        const limit = 20;           // ⚠️ Wallet tope duro
        let offset = 0;
        let page = 0;
        const MAX_PAGES = 50;       // safety: 1000 presupuestos máx

        while (page < MAX_PAGES) {
            const data = await this.request(`/budgets?limit=${limit}&offset=${offset}`);

            // Diagnóstico primera página
            if (page === 0) {
                console.log('🔍 /budgets respuesta cruda (pág 0):', data);
            }

            // Wallet devuelve { budgets: [...] } o { items: [...] } o array directo
            const batch =
                (Array.isArray(data)          ? data :
                Array.isArray(data?.budgets) ? data.budgets :
                Array.isArray(data?.items)   ? data.items :
                Array.isArray(data?.data)    ? data.data :
                []);

            console.log(`📄 Página ${page}: ${batch.length} items (offset=${offset})`);

            if (batch.length === 0) break;

            allBudgets.push(...batch);

            // Si devolvió menos del límite, ya no hay más
            if (batch.length < limit) break;

            offset += limit;
            page++;
        }

        // Deduplicar por id (por si el backend repite con solapamiento)
        const seen = new Set();
        this.budgets = allBudgets.filter(b => {
            const id = b?.id ?? b?.budgetId;
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });

        console.log(`✅ Cargados ${this.budgets.length} presupuestos únicos (${allBudgets.length} filas crudas, ${page + 1} páginas)`);
        console.log('📋 Nombres:', this.budgets.map(b => b.name));

        return this.budgets;
}

    setBudgetMapping(localName, budgetId) {
        this.budgetMap[localName] = budgetId;
        localStorage.setItem(WALLET_CONFIG.BUDGET_MAP_KEY, JSON.stringify(this.budgetMap));
    }

    getBudgetMapping(localName) {
        return this.budgetMap[localName] || null;
    }

    getAllBudgetMappings() {
        return { ...this.budgetMap };
    }

    // === Helpers de formato de periodo ===
    getPeriodForBudget(budget) {
        const type = budget.type || 'BUDGET_INTERVAL_MONTH';
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        if (type === 'BUDGET_INTERVAL_YEAR') {
            return `${year}`;
        }
        if (type === 'BUDGET_INTERVAL_WEEK') {
            // ISO week: YYYY-Www
            const week = this.getISOWeek(now);
            return `${year}-W${String(week).padStart(2, '0')}`;
        }
        // Default: monthly
        return `${year}-${month}`;
    }

    getISOWeek(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    // === SYNC: Bulk PATCH /budgets ===
    async syncBudgets(localBudgetData) {
        if (!this.budgets.length) await this.loadBudgets();

        const results = { updated: [], skipped: [], errors: [] };
        const updates = [];
        const metaMap = new Map(); // budgetId → { name, budgetName }

        for (const item of localBudgetData.gastos.items) {
            const budgetId = this.getBudgetMapping(item.nombre);
            if (!budgetId) {
                results.skipped.push({ name: item.nombre, reason: 'Sin mapeo de budget' });
                continue;
            }

            const budget = this.budgets.find(b => b.id === budgetId);
            if (!budget) {
                results.skipped.push({ name: item.nombre, reason: 'Budget no encontrado en Wallet' });
                continue;
            }

            const period = this.getPeriodForBudget(budget);
            const newLimit = Math.max(0.01, parseFloat(item.nuevoMonto.toFixed(2)));

            updates.push({
                id: budgetId,
                limitOverrides: [{ limit: newLimit, period: period }]
            });

            metaMap.set(budgetId, {
                name: item.nombre,
                budgetName: budget.name,
                limit: newLimit,
                period: period,
                type: budget.type
            });
        }

        if (updates.length === 0) return results;

        try {
            const patchBody = JSON.stringify(updates);
            console.log('📡 PATCH /budgets bulk:', patchBody.substring(0, 600));

            const response = await this.request('/budgets', {
                method: 'PATCH',
                body: patchBody
            });

            // ✅ Parsear respuesta batch (200 o 207)
            const batchResults = response.results || [];
            const summary = response.summary || {};

            console.log('📡 Batch summary:', summary);

            batchResults.forEach(r => {
                const meta = metaMap.get(r.id) || { name: r.id, budgetName: '?' };
                if (r.success) {
                    results.updated.push({
                        name: meta.name,
                        budgetName: meta.budgetName,
                        limit: meta.limit,
                        period: meta.period,
                        type: meta.type
                    });
                } else {
                    results.errors.push({
                        name: meta.name,
                        error: r.error || 'Error desconocido',
                        errorType: r.errorType || 'unknown'
                    });
                }
            });

        } catch (err) {
            // Error de red/proxy (no de la API batch)
            metaMap.forEach((meta, id) => {
                results.errors.push({ name: meta.name, error: err.message });
            });
        }

        return results;
    }
}

const walletAPI = new WalletAPI();