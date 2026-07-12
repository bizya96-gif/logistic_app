const API_URL = 'https://script.google.com/macros/s/AKfycbzgSi0kCHjxUnuH1ccTEULctrOr9pDd0OKvJVkI5KNvI42Cbv3f_O-wO2eV2RmNfeMt/exec';
const POST_CONFIRM_DELAY_MS = 1500;
const TRIPS_CACHE_KEY = 'alexlogistic.trips.cache.v1';
const DEFAULT_NEW_TRIP_DRIVER = 'Бизюков';
const DEFAULT_NEW_TRIP_VEHICLE = 'ГАЗ 767';
let tripsData = [];
let currentTrips = [];
let currentSort = { column: 'id', direction: 'desc' }; 
let counters = {};
let latestTripsRequestId = 0;
let mutationVersion = 0;

let modalMode = 'create';
let editingTripId = null;

let loadingTimeout;

function showLoading() { 
    document.getElementById('loadingOverlay').classList.add('active'); 
    clearTimeout(loadingTimeout);
    loadingTimeout = setTimeout(() => {
        hideLoading();
        console.warn('⚠️ Loading overlay скрыт по таймауту (15 сек)');
    }, 15000);
}

function hideLoading() { 
    document.getElementById('loadingOverlay').classList.remove('active'); 
    clearTimeout(loadingTimeout);
}

async function withLoading(fn) {
    showLoading();
    try { return await fn(); }
    finally { hideLoading(); }
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `custom-toast ${type === 'error' ? 'error' : ''}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

function setRefreshDisabled(disabled) {
    const refreshBtn = document.getElementById('refreshBtn');
    if (!refreshBtn) return;
    refreshBtn.disabled = disabled;
    refreshBtn.textContent = '🔄';
    refreshBtn.title = disabled ? 'Обновление данных...' : 'Обновить данные из таблицы';
    refreshBtn.setAttribute('aria-label', refreshBtn.title);
}

function updateLastUpdatedStatus(text, isError = false) {
    const el = document.getElementById('last-updated');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('text-danger', isError);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function markDataMutation() {
    mutationVersion += 1;
}

function parseMoney(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    return parseInt(value.toString().replace(/[^\d]/g, '')) || 0;
}

function parseDate(dateValue) {
    if (!dateValue) return '';
    if (typeof dateValue === 'string') return dateValue;
    if (dateValue instanceof Date) {
        const day = String(dateValue.getDate()).padStart(2, '0');
        const month = String(dateValue.getMonth() + 1).padStart(2, '0');
        const year = dateValue.getFullYear();
        return `${day}.${month}.${year}`;
    }
    return dateValue.toString();
}

function parseDateForSort(dateStr) {
    if (!dateStr) return 0;
    const parts = dateStr.split('.');
    if (parts.length === 3) {
        return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
    }
    return 0;
}

function formatDateForSheet(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
}

function formatDateForInput(date) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${year}-${month}-${day}`;
}

function sheetDateToInput(value) {
    if (!value) return '';
    const str = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const parts = str.split('.');
    if (parts.length === 3) {
        const [day, month, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return '';
}

function inputDateToSheet(value) {
    if (!value) return '';
    const [year, month, day] = value.split('-');
    if (!year || !month || !day) return '';
    return `${day}.${month}.${year}`;
}

function normalizeDateForCompare(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [year, month, day] = value.split('-');
        return `${day}.${month}.${year}`;
    }
    return String(value).trim();
}

function findTripById(tripId) {
    const targetId = String(tripId || '').trim();
    return tripsData.find(t => String(t.id || '').trim() === targetId);
}

function tripMatchesFormData(trip, expected) {
    if (!trip) return false;

    return (
        normalizeDateForCompare(trip.date) === normalizeDateForCompare(expected.date) &&
        String(trip.driver || '').trim() === String(expected.driver || '').trim() &&
        String(trip.vehicle || '').trim() === String(expected.vehicle || '').trim() &&
        String(trip.contractor || '').trim() === String(expected.contractor || '').trim() &&
        String(trip.route || '').trim() === String(expected.route || '').trim() &&
        String(trip.docType || '').trim() === String(expected.docType || '').trim() &&
        String(trip.invoice || '').trim() === String(expected.invoice || '').trim() &&
        parseMoney(trip.income) === parseMoney(expected.income) &&
        parseMoney(trip.commission) === parseMoney(expected.commission) &&
        parseMoney(trip.fuel) === parseMoney(expected.fuel) &&
        parseMoney(trip.toll) === parseMoney(expected.toll)
    );
}

function getMatchingTripIds(expected) {
    return new Set(
        tripsData
            .filter(trip => tripMatchesFormData(trip, expected))
            .map(trip => String(trip.id || '').trim())
            .filter(id => id)
    );
}

function findNewMatchingTrip(expected, previousIds) {
    return tripsData.find(trip => {
        const tripId = String(trip.id || '').trim();
        return tripMatchesFormData(trip, expected) && tripId && !previousIds.has(tripId);
    });
}

function readTripsCache() {
    try {
        const cached = localStorage.getItem(TRIPS_CACHE_KEY);
        if (!cached) return null;
        const parsed = JSON.parse(cached);
        if (!parsed || !Array.isArray(parsed.data)) return null;
        return parsed;
    } catch (err) {
        console.warn('Не удалось прочитать локальный кэш рейсов:', err);
        return null;
    }
}

function writeTripsCache(data) {
    try {
        localStorage.setItem(TRIPS_CACHE_KEY, JSON.stringify({
            savedAt: Date.now(),
            data: data
        }));
    } catch (err) {
        console.warn('Не удалось сохранить локальный кэш рейсов:', err);
    }
}

function normalizeTripsData(data, options = {}) {
    const { trackCounters = true, archived = false } = options;
    if (trackCounters) counters = {};

    return data.map(row => {
        const id = row['№ рейса'] || '';
        const contractor = row['Контрагент'] || '';
        if (!id && !contractor) return null;

        if (trackCounters && id && /^[А-ЯA-Z]-\d+$/i.test(id)) {
            const match = id.match(/^([А-ЯA-Z])-(\d+)$/i);
            if (match) {
                const letter = match[1].toUpperCase();
                const num = parseInt(match[2]);
                if (!counters[letter] || num >= counters[letter]) {
                    counters[letter] = num;
                }
            }
        }

        const isPaid = row.__isPaid !== undefined
            ? !!row.__isPaid
            : !!(row['Дата оплаты'] && String(row['Дата оплаты']).trim() !== '');

        return {
            id: id,
            date: parseDate(row['Дата выезда']),
            driver: row['Водитель'] || '',
            vehicle: row['Автомобиль'] || '',
            contractor: contractor,
            route: row['Маршрут'] || '',
            docType: row['Тип документа'] || 'Заявка',
            cargoReceiver: row['Грузополучатель'] || '',
            cargo: row['Груз'] || '',
            invoice: row['№ счет'] || '',
            distance: parseMoney(row['Расстояние']),
            income: parseMoney(row['Цена договора']),
            standbyPrice: parseMoney(row['Цена простоя']),
            paymentType: row['Нал/Б.Н.'] || 'Б.Н.',
            paymentDate: parseDate(row['Дата оплаты']),
            commission: parseMoney(row['Комиссионные']),
            fuel: parseMoney(row['На топливо']),
            liters: parseFloat(row['литр']) || 0,
            toll: parseMoney(row['Платная дорога']),
            profit: parseMoney(row['Прибль по загрузке']),
            leshe: row['Леше'] || '',
            sum: row['Сумма'] || '',
            isPaid: isPaid,
            archived: archived,
            sourceYear: row['__sourceYear'] || null
        };
    }).filter(trip => trip !== null);
}

// ===== АРХИВНЫЕ ДАННЫЕ ПРОШЛЫХ ЛЕТ (статичные JSON, разово выгружены из Sheets) =====
let historyTripsData = [];
let historyLoadPromise = null;

async function loadHistoryData() {
    if (historyLoadPromise) return historyLoadPromise;

    historyLoadPromise = (async () => {
        const sources = ['data/history-2024.json', 'data/history-2025.json'];
        const results = await Promise.all(sources.map(async (url) => {
            try {
                const response = await fetch(url);
                if (!response.ok) return [];
                const data = await response.json();
                if (!Array.isArray(data)) return [];
                return normalizeTripsData(data, { trackCounters: false, archived: true });
            } catch (err) {
                console.warn('Не удалось загрузить архивные данные:', url, err);
                return [];
            }
        }));
        historyTripsData = results.flat();
        applyFilters();
        return historyTripsData;
    })();

    return historyLoadPromise;
}

function applyTripsData(data) {
    tripsData = normalizeTripsData(data);
    console.log('📊 Счётчики ID после загрузки:', counters);

    populateDatalists();
    populateFilters();
    applyFilters();
    return tripsData;
}

async function refreshAndConfirm(confirmFn, failureMessage) {
    await wait(POST_CONFIRM_DELAY_MS);
    const refreshedTrips = await loadTripsFromSheet({ showSuccessToast: false, skipCache: true });
    if (!refreshedTrips || !confirmFn()) {
        throw new Error(failureMessage);
    }
}

async function updatePaymentInSheet(trip, isPaid, checkbox, selectedPaymentDate = '') {
    if (!trip || !trip.id) return false;

    const previousPaid = trip.isPaid;
    const previousPaymentDate = trip.paymentDate;
    const paymentDate = isPaid ? selectedPaymentDate : '';

    markDataMutation();
    checkbox.disabled = true;
    checkbox.checked = isPaid;
    trip.isPaid = isPaid;
    trip.paymentDate = paymentDate;
    updatePaymentStats();

    try {
        await fetch(API_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'updatePayment',
                tripId: trip.id,
                paymentDate: paymentDate
            })
        });

        await refreshAndConfirm(
            () => {
                const confirmedTrip = findTripById(trip.id);
                return confirmedTrip &&
                    confirmedTrip.isPaid === isPaid &&
                    (!isPaid || normalizeDateForCompare(confirmedTrip.paymentDate) === normalizeDateForCompare(paymentDate));
            },
            'Оплата не подтвердилась после обновления данных'
        );
        showToast(isPaid ? `✅ Оплата записана на ${paymentDate}` : '✅ Оплата снята в таблице');
        return true;
    } catch (err) {
        console.error('Ошибка обновления оплаты:', err);
        trip.isPaid = previousPaid;
        trip.paymentDate = previousPaymentDate;
        checkbox.checked = previousPaid;
        updatePaymentStats();
        showToast('❌ Не удалось обновить оплату в таблице', 'error');
        return false;
    } finally {
        checkbox.disabled = false;
    }
}

// ===== ЗАГРУЗКА ИЗ GOOGLE ТАБЛИЦЫ =====
async function loadTripsFromSheet(options = {}) {
    const { showSuccessToast = true, skipCache = false } = options;
    const cached = skipCache ? null : readTripsCache();
    const hasVisibleData = tripsData.length > 0;
    const requestId = ++latestTripsRequestId;
    const mutationVersionAtStart = mutationVersion;

    if (cached && !hasVisibleData) {
        applyTripsData(cached.data);
        const savedAt = cached.savedAt ? new Date(cached.savedAt).toLocaleString('ru-RU') : 'неизвестно';
        updateLastUpdatedStatus(`Показаны сохраненные данные от ${savedAt}. Обновляем...`);
    }

    setRefreshDisabled(true);
    try {
        const response = await fetch(skipCache ? `${API_URL}?noCache=1` : API_URL);
        const data = await response.json();
        
        if (data.error) {
            showToast(' Ошибка API: ' + data.error, 'error');
            updateLastUpdatedStatus('Ошибка обновления: ' + data.error, true);
            return null;
        }

        if (!Array.isArray(data)) {
            showToast(' API вернул неожиданный формат данных', 'error');
            updateLastUpdatedStatus('Ошибка обновления: неожиданный формат данных', true);
            return null;
        }

        if (requestId !== latestTripsRequestId || mutationVersionAtStart !== mutationVersion) {
            return tripsData;
        }

        writeTripsCache(data);
        applyTripsData(data);
        updateLastUpdatedStatus('Последнее обновление: ' + new Date().toLocaleString('ru-RU'));
        if (showSuccessToast) {
            showToast(cached ? `✅ Данные обновлены: ${tripsData.length} рейсов` : `✅ Загружено ${tripsData.length} рейсов`);
        }
        return tripsData;
    } catch (err) {
        console.error('Ошибка загрузки:', err);
        if (cached) {
            showToast('⚠️ Свежие данные не загрузились, показан локальный кэш', 'error');
            updateLastUpdatedStatus('Ошибка обновления: показаны сохраненные данные', true);
            return tripsData;
        }
        showToast(' Не удалось загрузить данные. Проверьте доступность Google Apps Script.', 'error');
        updateLastUpdatedStatus('Ошибка обновления: данные не загружены', true);
        return null;
    } finally {
        setRefreshDisabled(false);
    }
}

// ===== ЗАПОЛНЕНИЕ СПИСКОВ ДЛЯ РУЧНОГО ВВОДА =====
function populateDatalists() {
    const drivers = [...new Set(tripsData.map(t => t.driver).filter(d => d))].sort();
    const vehicles = [...new Set(tripsData.map(t => t.vehicle).filter(v => v))].sort();
    const contractors = [...new Set(tripsData.map(t => t.contractor).filter(c => c))].sort();
    
    const driverList = document.getElementById('driverList');
    driverList.innerHTML = '';
    drivers.forEach(d => { const o = document.createElement('option'); o.value = d; driverList.appendChild(o); });
    
    const vehicleList = document.getElementById('vehicleList');
    vehicleList.innerHTML = '';
    vehicles.forEach(v => { const o = document.createElement('option'); o.value = v; vehicleList.appendChild(o); });
    
    const contractorList = document.getElementById('contractorList');
    contractorList.innerHTML = '';
    contractors.forEach(c => { const o = document.createElement('option'); o.value = c; contractorList.appendChild(o); });
}

// ===== МОДАЛЬНОЕ ОКНО =====
let tripModal;
let paymentDateModal;
let tripDetailsModal;
let pendingPaymentTrip = null;
let pendingPaymentCheckbox = null;

document.addEventListener('DOMContentLoaded', function() {
    tripModal = new bootstrap.Modal(document.getElementById('createTripModal'));
    paymentDateModal = new bootstrap.Modal(document.getElementById('paymentDateModal'));
    tripDetailsModal = new bootstrap.Modal(document.getElementById('tripDetailsModal'));
    
    document.getElementById('createTripModal').addEventListener('show.bs.modal', function () {
        hideLoading();
    });

    document.getElementById('createTripModal').addEventListener('shown.bs.modal', function () {
        resetTripModalScroll();
    });

    document.getElementById('paymentDateModal').addEventListener('shown.bs.modal', function () {
        document.getElementById('paymentConfirmDate').focus();
    });

    document.getElementById('paymentDateModal').addEventListener('hidden.bs.modal', function () {
        if (pendingPaymentCheckbox && (!pendingPaymentTrip || !pendingPaymentTrip.isPaid)) {
            pendingPaymentCheckbox.checked = false;
        }
        pendingPaymentTrip = null;
        pendingPaymentCheckbox = null;
    });
});

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value || '—';
}

function resetTripModalScroll() {
    const modalBody = document.querySelector('#createTripModal .modal-body');
    if (modalBody) modalBody.scrollTop = 0;
}

function openTripDetailsModal(tripOrId) {
    const trip = (tripOrId && typeof tripOrId === 'object') ? tripOrId : findTripById(tripOrId);
    if (!trip) {
        showToast('❌ Рейс не найден', 'error');
        return;
    }

    const expense = (trip.commission || 0) + (trip.fuel || 0) + (trip.toll || 0);
    const profit = trip.income - expense;

    document.getElementById('tripDetailsModal').dataset.tripId = trip.id || '';
    setText('detailsTripTitle', `Рейс ${trip.id || '—'}`);
    setText('detailsTripSubtitle', `${trip.date || '—'} · ${trip.route || 'Маршрут не указан'}`);
    setText('detailsDate', trip.date);
    setText('detailsDriver', trip.driver);
    setText('detailsVehicle', trip.vehicle);
    setText('detailsContractor', trip.contractor);
    setText('detailsRoute', trip.route);
    setText('detailsIncome', `${trip.income.toLocaleString('ru-RU')} ₽`);
    setText('detailsExpense', `${expense.toLocaleString('ru-RU')} ₽`);
    setText('detailsProfit', `${profit.toLocaleString('ru-RU')} ₽`);
    setText('detailsInvoice', trip.invoice ? `№${trip.invoice}` : '—');
    setText('detailsPayment', trip.isPaid ? `Оплачено${trip.paymentDate ? ` · ${trip.paymentDate}` : ''}` : 'Не оплачено');
    setText('detailsCargo', trip.cargo);
    setText('detailsReceiver', trip.cargoReceiver);

    const editBtn = document.getElementById('detailsEditBtn');
    const deleteBtn = document.getElementById('detailsDeleteBtn');
    if (editBtn) editBtn.style.display = trip.archived ? 'none' : '';
    if (deleteBtn) deleteBtn.style.display = trip.archived ? 'none' : '';

    tripDetailsModal.show();
}

function editTripFromDetails() {
    const tripId = document.getElementById('tripDetailsModal').dataset.tripId;
    if (!tripId) return;
    tripDetailsModal.hide();
    editTrip(tripId);
}

function deleteTripFromDetails() {
    const tripId = document.getElementById('tripDetailsModal').dataset.tripId;
    if (!tripId) return;
    tripDetailsModal.hide();
    deleteTrip(tripId);
}

function openPaymentDateModal(trip, checkbox) {
    pendingPaymentTrip = trip;
    pendingPaymentCheckbox = checkbox;

    const dateInput = document.getElementById('paymentConfirmDate');
    const errorEl = document.getElementById('paymentDateError');
    const tripLabel = document.getElementById('paymentTripLabel');

    dateInput.value = sheetDateToInput(trip.paymentDate) || formatDateForInput(new Date());
    errorEl.classList.add('d-none');
    tripLabel.textContent = `${trip.id || '—'} · ${trip.driver || 'Водитель не указан'} · ${trip.route || 'Маршрут не указан'}`;
    paymentDateModal.show();
}

async function confirmPaymentDate() {
    const dateInput = document.getElementById('paymentConfirmDate');
    const errorEl = document.getElementById('paymentDateError');
    const confirmBtn = document.getElementById('confirmPaymentDateBtn');
    const paymentDate = inputDateToSheet(dateInput.value);

    if (!paymentDate) {
        errorEl.classList.remove('d-none');
        dateInput.focus();
        return;
    }

    if (!pendingPaymentTrip || !pendingPaymentCheckbox) {
        paymentDateModal.hide();
        return;
    }

    errorEl.classList.add('d-none');
    confirmBtn.disabled = true;

    const trip = pendingPaymentTrip;
    const checkbox = pendingPaymentCheckbox;

    try {
        const saved = await updatePaymentInSheet(trip, true, checkbox, paymentDate);
        if (!saved) return;
        pendingPaymentTrip = null;
        pendingPaymentCheckbox = null;
        paymentDateModal.hide();
    } finally {
        confirmBtn.disabled = false;
    }
}

function openTripModal() {
    modalMode = 'create';
    editingTripId = null;
    document.getElementById('modalTitle').textContent = 'Создание рейса';
    document.getElementById('saveBtn').textContent = '💾 Сохранить план';
    document.getElementById('tripIdBadge').style.display = 'inline-block';
    document.getElementById('vehicle').removeAttribute('readonly');
    
    document.getElementById('tripForm').reset();
    document.getElementById('driver').value = DEFAULT_NEW_TRIP_DRIVER;
    document.getElementById('vehicle').value = DEFAULT_NEW_TRIP_VEHICLE;
    isProfitManual = false;
    document.getElementById('profit').classList.remove('manually-edited');
    updateTripId();
    recalcProfit();
    tripModal.show();
    resetTripModalScroll();
}

// ===== РЕДАКТИРОВАНИЕ РЕЙСА =====
function editTrip(tripId) {
    const trip = tripsData.find(t => t.id === tripId);
    if (!trip) {
        showToast('❌ Рейс не найден', 'error');
        return;
    }
    
    modalMode = 'edit';
    editingTripId = tripId;
    document.getElementById('modalTitle').textContent = 'Редактирование рейса';
    document.getElementById('saveBtn').textContent = '💾 Сохранить изменения';
    document.getElementById('tripIdBadge').textContent = tripId;
    document.getElementById('tripIdBadge').style.display = 'inline-block';
    document.getElementById('vehicle').setAttribute('readonly', 'readonly');
    
    document.getElementById('departureDate').value = trip.date ? trip.date.split('.').reverse().join('-') : '';
    document.getElementById('driver').value = trip.driver || '';
    document.getElementById('vehicle').value = trip.vehicle || '';
    document.getElementById('contractor').value = trip.contractor || '';
    document.getElementById('contractPrice').value = trip.income || '';
    document.getElementById('route').value = trip.route || '';
    document.getElementById('receiver').value = trip.cargoReceiver || '';
    document.getElementById('cargo').value = trip.cargo || '';
    document.getElementById('docType').value = trip.docType || 'Заявка';
    document.getElementById('invoiceNum').value = trip.invoice || '';
    document.getElementById('distance').value = trip.distance || '';
    document.getElementById('downtimePrice').value = trip.standbyPrice || '';
    document.getElementById('taxToggle').checked = trip.paymentType === 'Б.Н.';
    document.getElementById('paymentDate').value = trip.paymentDate ? trip.paymentDate.split('.').reverse().join('-') : '';
    document.getElementById('commission').value = trip.commission || '';
    document.getElementById('fuelCost').value = trip.fuel || '';
    document.getElementById('fuelLiters').value = trip.liters || '';
    document.getElementById('tollRoad').value = trip.toll || '';
    document.getElementById('profit').value = trip.profit || '';
    
    isProfitManual = true;
    document.getElementById('profit').classList.add('manually-edited');
    
    tripModal.show();
    resetTripModalScroll();
}

function updateTripId() {
    if (modalMode === 'edit') return;
    
    const vehicleSelect = document.getElementById('vehicle');
    const badge = document.getElementById('tripIdBadge');
    
    if (vehicleSelect.value) {
        const letter = vehicleSelect.value.trim()[0].toUpperCase();
        const nextNumber = (counters[letter] || 0) + 1;
        badge.textContent = `${letter}-${nextNumber}`;
    } else {
        badge.textContent = '—';
    }
}

let isProfitManual = false;

function markManualProfit() {
    isProfitManual = true;
    document.getElementById('profit').classList.add('manually-edited');
}

function recalcProfit() {
    if (isProfitManual) return;

    const price = parseFloat(document.getElementById('contractPrice').value) || 0;
    const fuel = parseFloat(document.getElementById('fuelCost').value) || 0;
    const toll = parseFloat(document.getElementById('tollRoad').value) || 0;
    const commission = parseFloat(document.getElementById('commission').value) || 0;

    const profit = price - (fuel + toll + commission);
    
    const profitField = document.getElementById('profit');
    profitField.value = profit !== 0 ? profit : '';
    profitField.classList.remove('manually-edited');
}

document.getElementById('profit').addEventListener('blur', function() {
    if(this.value !== '') {
       isProfitManual = true;
       this.classList.add('manually-edited');
    } else {
       isProfitManual = false;
       this.classList.remove('manually-edited');
       recalcProfit();
    }
});

// ===== СОХРАНЕНИЕ (СОЗДАНИЕ ИЛИ РЕДАКТИРОВАНИЕ) =====
async function saveTrip() {
    const reqFields = ['departureDate', 'driver', 'vehicle', 'route'];
    let valid = true;
    reqFields.forEach(id => {
        const el = document.getElementById(id);
        if(!el.value) {
            el.style.borderColor = '#EF4444';
            valid = false;
        } else {
            el.style.borderColor = '';
        }
    });

    if(!valid) {
        showToast('❌ Заполните обязательные поля (отмечены *)', 'error');
        return;
    }

    const tripData = {
        id: modalMode === 'create' ? document.getElementById('tripIdBadge').textContent : editingTripId,
        date: document.getElementById('departureDate').value,
        driver: document.getElementById('driver').value,
        vehicle: document.getElementById('vehicle').value,
        contractor: document.getElementById('contractor').value,
        route: document.getElementById('route').value,
        docType: document.getElementById('docType').value,
        cargoReceiver: document.getElementById('receiver').value,
        cargo: document.getElementById('cargo').value,
        invoice: document.getElementById('invoiceNum').value,
        distance: document.getElementById('distance').value,
        income: document.getElementById('contractPrice').value,
        standbyPrice: document.getElementById('downtimePrice').value,
        paymentType: document.getElementById('taxToggle').checked ? 'Б.Н.' : 'Нал',
        paymentDate: document.getElementById('paymentDate').value,
        commission: document.getElementById('commission').value,
        fuel: document.getElementById('fuelCost').value,
        liters: document.getElementById('fuelLiters').value,
        toll: document.getElementById('tollRoad').value,
        profit: document.getElementById('profit').value,
        leshe: '',
        sum: ''
    };

    const saveBtn = document.getElementById('saveBtn');
    const originalSaveText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    tripModal.hide();
    
    const action = modalMode === 'create' ? 'create' : 'update';
    const body = modalMode === 'create' 
        ? { action: 'create', trip: tripData }
        : { action: 'update', tripId: editingTripId, trip: tripData };
    const matchingTripIdsBeforeCreate = modalMode === 'create' ? getMatchingTripIds(tripData) : null;
    
    try {
        await withLoading(async () => {
            markDataMutation();
            await fetch(API_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            await refreshAndConfirm(
                () => modalMode === 'create'
                    ? !!findNewMatchingTrip(tripData, matchingTripIdsBeforeCreate)
                    : tripMatchesFormData(findTripById(tripData.id), tripData),
                modalMode === 'create'
                    ? 'Созданный рейс не найден после обновления данных'
                    : 'Изменения рейса не подтвердились после обновления данных'
            );
        });
        showToast(modalMode === 'create' ? '✅ Рейс успешно создан!' : '✅ Рейс успешно обновлен!');
    } catch (err) {
        console.error('Ошибка сохранения:', err);
        showToast(' Ошибка при сохранении рейса: ' + err.message, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = originalSaveText;
    }
}

// ===== УДАЛЕНИЕ РЕЙСА =====
async function deleteTrip(tripId) {
    if (!confirm(`Вы уверены, что хотите удалить рейс ${tripId}?\n\nЭто действие нельзя отменить.`)) {
        return;
    }
    
    try {
        await withLoading(async () => {
            markDataMutation();
            await fetch(API_URL, {
                method: 'POST',
                mode: 'no-cors',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', tripId: tripId })
            });

            await refreshAndConfirm(
                () => !findTripById(tripId),
                'Рейс все еще найден после обновления данных'
            );
        });
        showToast('✅ Рейс удален');
    } catch (err) {
        console.error('Ошибка удаления:', err);
        showToast('❌ Ошибка при удалении рейса: ' + err.message, 'error');
    }
}

// ===== НАВИГАЦИЯ =====
document.querySelectorAll('.nav-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.section-view').forEach(s => s.classList.remove('active'));
        document.getElementById(btn.dataset.target).classList.add('active');
    });
});

// ===== ФИЛЬТРЫ =====
function populateFilters() {
    const contractors = [...new Set(tripsData.map(t => t.contractor).filter(c => c))].sort();
    const drivers = [...new Set(tripsData.map(t => t.driver).filter(d => d))].sort();
    
    const cSelect = document.getElementById('filter-contractor');
    const currentContractor = cSelect.value || 'all';
    cSelect.innerHTML = '<option value="all">Все контрагенты</option>';
    contractors.forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; cSelect.appendChild(o); });
    cSelect.value = contractors.includes(currentContractor) ? currentContractor : 'all';
    
    const dSelect = document.getElementById('filter-driver');
    const currentDriver = dSelect.value || 'all';
    dSelect.innerHTML = '<option value="all">Все водители</option>';
    drivers.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; dSelect.appendChild(o); });
    dSelect.value = drivers.includes(currentDriver) ? currentDriver : 'all';
}

// ===== УМНАЯ СОРТИРОВКА =====
function compareValues(a, b, column, direction) {
    const multiplier = direction === 'asc' ? 1 : -1;
    
    if (column === 'id') {
        return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' }) * multiplier;
    }
    
    if (column === 'date') {
        return (parseDateForSort(a.date) - parseDateForSort(b.date)) * multiplier;
    }
    
    if (column === 'income') {
        return (a.income - b.income) * multiplier;
    }
    
    if (column === 'expense') {
        const expA = (a.commission || 0) + (a.fuel || 0) + (a.toll || 0);
        const expB = (b.commission || 0) + (b.fuel || 0) + (b.toll || 0);
        return (expA - expB) * multiplier;
    }
    
    if (column === 'profit') {
        const expA = (a.commission || 0) + (a.fuel || 0) + (a.toll || 0);
        const expB = (b.commission || 0) + (b.fuel || 0) + (b.toll || 0);
        return ((a.income - expA) - (b.income - expB)) * multiplier;
    }
    
    const valA = String(a[column] || '').toLowerCase();
    const valB = String(b[column] || '').toLowerCase();
    return valA.localeCompare(valB) * multiplier;
}

// ===== ПРИМЕНЕНИЕ ВСЕХ ФИЛЬТРОВ =====
function applyFilters() {
    const year = document.getElementById('period-year').value;
    const month = document.getElementById('period-month').value;
    const contractor = document.getElementById('filter-contractor').value;
    const driver = document.getElementById('filter-driver').value;
    const payment = document.getElementById('filter-payment').value;
    const search = document.getElementById('search-input').value.toLowerCase();
    
    currentTrips = tripsData.concat(historyTripsData).filter(trip => {
        if (year !== 'all' || month !== 'all') {
            const parts = trip.date ? trip.date.split('.') : [];
            const hasExactDate = parts.length === 3;

            // Для архивных рейсов год определяем по листу-источнику (2024/2025 Загрузки),
            // а не по полю "Дата выезда": в архиве встречаются пустые и ошибочно
            // введённые даты (напр. опечатка года), а вкладка таблицы — надёжный признак.
            const tripYear = (trip.archived && trip.sourceYear) ? trip.sourceYear : (hasExactDate ? parts[2] : null);
            const tripMonth = hasExactDate ? parts[1] : null;

            if (year !== 'all' && tripYear !== year) return false;
            if (month !== 'all' && (!hasExactDate || tripMonth !== month)) return false;
        }

        const matchC = contractor === 'all' || trip.contractor === contractor;
        const matchD = driver === 'all' || trip.driver === driver;
        const matchP = payment === 'all' || (payment === 'paid' && trip.isPaid) || (payment === 'unpaid' && !trip.isPaid);
        const matchS = search === '' || 
                      (trip.id && trip.id.toLowerCase().includes(search)) || 
                      (trip.route && trip.route.toLowerCase().includes(search)) ||
                      (trip.contractor && trip.contractor.toLowerCase().includes(search));
                      
        return matchC && matchD && matchP && matchS;
    });

    if (currentSort.column) {
        currentTrips.sort((a, b) => compareValues(a, b, currentSort.column, currentSort.direction));
    }

    renderTable(currentTrips);
    updateTotals(currentTrips);
    updateTrends(year, month);
}

// ===== ТАБЛИЦА =====
function appendTextCell(row, text, className = '', label = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    if (label) cell.dataset.label = label;
    cell.textContent = text;
    row.appendChild(cell);
    return cell;
}

function createActionButton(label, title, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-sm btn-action ${className}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

function renderTable(trips) {
    const tbody = document.getElementById('trips-table-body');
    tbody.innerHTML = '';

    if (trips.length === 0) {
        const row = document.createElement('tr');
        row.className = 'empty-row';
        const cell = document.createElement('td');
        cell.colSpan = 11;
        cell.textContent = 'Нет рейсов по выбранным фильтрам';
        row.appendChild(cell);
        tbody.appendChild(row);
        updatePaymentStats();
        return;
    }
    
    trips.forEach((trip) => {
        const expense = (trip.commission || 0) + (trip.fuel || 0) + (trip.toll || 0);
        const profit = trip.income - expense;
        const isPaid = trip.isPaid || false;
        const isArchived = !!trip.archived;

        const row = document.createElement('tr');
        row.className = 'trip-row' + (isArchived ? ' trip-row-archived' : '');
        const idDateCell = document.createElement('td');
        idDateCell.className = 'ps-4';
        idDateCell.dataset.label = 'ID';
        const idValue = document.createElement('div');
        idValue.className = 'fw-mono fw-medium';
        idValue.textContent = trip.id || '—';
        const dateValue = document.createElement('small');
        dateValue.className = 'text-muted date-cell';
        dateValue.textContent = trip.date || '—';
        idDateCell.append(idValue, dateValue);
        row.appendChild(idDateCell);

        const driverCell = document.createElement('td');
        driverCell.dataset.label = 'Водитель';
        const driverName = document.createElement('div');
        driverName.className = 'fw-medium';
        driverName.textContent = trip.driver || '—';
        const vehicleName = document.createElement('small');
        vehicleName.className = 'text-muted';
        vehicleName.textContent = trip.vehicle || '—';
        driverCell.append(driverName, vehicleName);
        row.appendChild(driverCell);

        appendTextCell(row, trip.contractor || '—', '', 'Контрагент');
        appendTextCell(row, trip.route || '—', '', 'Маршрут');
        appendTextCell(row, `${trip.income.toLocaleString('ru-RU')} ₽`, 'fw-bold', 'Стоимость');

        const invoiceCell = document.createElement('td');
        invoiceCell.dataset.label = '№ счета';
        const invoiceValue = document.createElement('span');
        invoiceValue.className = 'text-muted';
        invoiceValue.textContent = `№${trip.invoice || '—'}`;
        invoiceCell.appendChild(invoiceValue);
        row.appendChild(invoiceCell);

        appendTextCell(row, trip.docType || '—', 'text-muted', 'Тип документа');

        const paymentCell = document.createElement('td');
        paymentCell.className = 'text-center';
        paymentCell.dataset.label = 'Оплата';
        const paymentCheckbox = document.createElement('input');
        paymentCheckbox.type = 'checkbox';
        paymentCheckbox.className = 'form-check-input payment-check';
        paymentCheckbox.checked = isPaid;
        paymentCheckbox.disabled = !trip.id || isArchived;
        paymentCheckbox.title = isArchived ? 'Архивный рейс — редактирование недоступно' : '';
        paymentCheckbox.dataset.tripId = trip.id || '';
        paymentCheckbox.addEventListener('change', function() {
            const tripId = this.dataset.tripId;
            if (!tripId) return;

            const sourceTrip = tripsData.find(t => t.id === tripId) || trip;
            if (this.checked) {
                this.checked = false;
                openPaymentDateModal(sourceTrip, this);
                return;
            }

            updatePaymentInSheet(sourceTrip, false, this);
        });
        paymentCell.appendChild(paymentCheckbox);
        row.appendChild(paymentCell);

        appendTextCell(row, `${expense.toLocaleString('ru-RU')} ₽`, 'expense-value', 'Расход');
        appendTextCell(row, `${profit.toLocaleString('ru-RU')} ₽`, `profit-value ${profit < 0 ? 'profit-negative' : ''}`.trim(), 'Прибыль');

        const actionsCell = document.createElement('td');
        actionsCell.className = 'pe-4 text-end';
        actionsCell.dataset.label = 'Действия';
        if (isArchived) {
            const archivedBadge = document.createElement('span');
            archivedBadge.className = 'badge text-muted bg-light border';
            archivedBadge.textContent = 'Архив';
            archivedBadge.title = 'Данные прошлых лет доступны только для просмотра';
            actionsCell.appendChild(archivedBadge);
        } else {
            actionsCell.append(
                createActionButton('✏️', 'Редактировать', 'btn-edit', () => editTrip(trip.id)),
                document.createTextNode(' '),
                createActionButton('🗑️', 'Удалить', 'btn-delete', () => deleteTrip(trip.id))
            );
        }
        row.appendChild(actionsCell);

        const detailsCell = document.createElement('td');
        detailsCell.className = 'mobile-details-cell';
        detailsCell.dataset.label = 'Подробнее';
        const detailsButton = document.createElement('button');
        detailsButton.type = 'button';
        detailsButton.className = 'btn btn-sm btn-outline-primary mobile-details-btn';
        detailsButton.textContent = 'Подробнее';
        detailsButton.setAttribute('aria-label', `Открыть детали рейса ${trip.id || ''}`.trim());
        detailsButton.addEventListener('click', () => openTripDetailsModal(trip));
        detailsCell.appendChild(detailsButton);
        row.appendChild(detailsCell);

        tbody.appendChild(row);
    });

    updatePaymentStats();
}

// ===== ИТОГИ (KPI) =====
function updateTotals(trips) {
    let totalIncome = 0, totalExpense = 0, totalProfit = 0;
    trips.forEach(trip => {
        const expense = (trip.commission || 0) + (trip.fuel || 0) + (trip.toll || 0);
        totalIncome += trip.income;
        totalExpense += expense;
        totalProfit += (trip.income - expense);
    });
    
    document.getElementById('stat-income').textContent = totalIncome.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('stat-expense').textContent = totalExpense.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('stat-profit').textContent = totalProfit.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('stat-trips').textContent = trips.length;
    
    document.getElementById('total-income').textContent = totalIncome.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('total-expense').textContent = totalExpense.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('total-profit').textContent = totalProfit.toLocaleString('ru-RU') + ' ₽';
}

// ===== ТРЕНДЫ KPI (только когда выбран конкретный месяц конкретного года) =====
const TREND_MONTH_NAMES = ['', 'янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function summarizeMonth(allTrips, year, month) {
    let income = 0, expense = 0, profit = 0, count = 0;
    allTrips.forEach(trip => {
        if (!trip.date) return;
        const parts = trip.date.split('.');
        if (parts.length !== 3) return;
        if (parts[2] !== year || parts[1] !== month) return;
        const exp = (trip.commission || 0) + (trip.fuel || 0) + (trip.toll || 0);
        income += trip.income || 0;
        expense += exp;
        profit += (trip.income || 0) - exp;
        count += 1;
    });
    return { income, expense, profit, count };
}

function shiftMonth(year, month, delta) {
    const total = parseInt(year, 10) * 12 + (parseInt(month, 10) - 1) + delta;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return { year: String(y), month: String(m).padStart(2, '0') };
}

function trendPercent(current, base) {
    if (!base) return null;
    return ((current - base) / Math.abs(base)) * 100;
}

function renderTrendBadge(elId, current, prev, prevLabel, yoy, yoyLabel) {
    const el = document.getElementById(elId);
    if (!el) return;

    const parts = [];
    const prevPct = trendPercent(current, prev);
    if (prevPct !== null) {
        const cls = prevPct >= 0 ? 'trend-up' : 'trend-down';
        const arrow = prevPct >= 0 ? '▲' : '▼';
        parts.push(`<span class="${cls}">${arrow} ${Math.abs(prevPct).toFixed(0)}%</span> к ${prevLabel}`);
    }
    const yoyPct = trendPercent(current, yoy);
    if (yoyPct !== null) {
        const cls = yoyPct >= 0 ? 'trend-up' : 'trend-down';
        const arrow = yoyPct >= 0 ? '▲' : '▼';
        parts.push(`<span class="${cls}">${arrow} ${Math.abs(yoyPct).toFixed(0)}%</span> к ${yoyLabel}`);
    }

    el.innerHTML = parts.length ? parts.join('<span class="trend-sep">·</span>') : '';
}

function updateTrends(year, month) {
    const trendIds = ['trend-income', 'trend-expense', 'trend-profit', 'trend-trips'];
    if (year === 'all' || month === 'all') {
        trendIds.forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
        return;
    }

    const allTrips = tripsData.concat(historyTripsData);
    const current = summarizeMonth(allTrips, year, month);

    const prev = shiftMonth(year, month, -1);
    const prevData = summarizeMonth(allTrips, prev.year, prev.month);
    const prevLabel = `${TREND_MONTH_NAMES[parseInt(prev.month, 10)]} ${prev.year}`;

    const yoyYear = String(parseInt(year, 10) - 1);
    const yoyData = summarizeMonth(allTrips, yoyYear, month);
    const yoyLabel = `${TREND_MONTH_NAMES[parseInt(month, 10)]} ${yoyYear}`;

    renderTrendBadge('trend-income', current.income, prevData.income, prevLabel, yoyData.income, yoyLabel);
    renderTrendBadge('trend-expense', current.expense, prevData.expense, prevLabel, yoyData.expense, yoyLabel);
    renderTrendBadge('trend-profit', current.profit, prevData.profit, prevLabel, yoyData.profit, yoyLabel);
    renderTrendBadge('trend-trips', current.count, prevData.count, prevLabel, yoyData.count, yoyLabel);
}

// ===== СТАТИСТИКА ОПЛАТЫ =====
function updatePaymentStats() {
    let paidCount = 0, unpaidCount = 0, paidSum = 0, unpaidSum = 0;
    
    currentTrips.forEach(trip => {
        if (trip.isPaid) {
            paidCount++;
            paidSum += trip.income;
        } else {
            unpaidCount++;
            unpaidSum += trip.income;
        }
    });
    
    document.getElementById('paid-count').textContent = paidCount;
    document.getElementById('unpaid-count').textContent = unpaidCount;
    document.getElementById('paid-sum').textContent = paidSum.toLocaleString('ru-RU') + ' ₽';
    document.getElementById('unpaid-sum').textContent = unpaidSum.toLocaleString('ru-RU') + ' ₽';
}

// ===== ПЕРИОД =====
function updatePeriodDisplay() {
    const year = document.getElementById('period-year').value;
    const month = document.getElementById('period-month').value;
    const display = document.getElementById('period-display');
    if (year === 'all') display.textContent = 'Все годы';
    else if (month === 'all') display.textContent = `${year} год`;
    else {
        const months = ['', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
        display.textContent = `${months[parseInt(month)]} ${year}`;
    }
}

// ===== ОБРАБОТЧИКИ СОБЫТИЙ =====
document.getElementById('period-year').addEventListener('change', () => { updatePeriodDisplay(); applyFilters(); });
document.getElementById('period-month').addEventListener('change', () => { updatePeriodDisplay(); applyFilters(); });
document.getElementById('filter-contractor').addEventListener('change', applyFilters);
document.getElementById('filter-driver').addEventListener('change', applyFilters);
document.getElementById('filter-payment').addEventListener('change', applyFilters);
document.getElementById('search-input').addEventListener('input', applyFilters);

document.querySelectorAll('.sortable').forEach(th => {
    th.addEventListener('click', function() {
        const column = this.dataset.sort;
        if (!column) return;
        
        if (currentSort.column === column) {
            currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
        } else {
            currentSort.column = column;
            currentSort.direction = 'asc';
        }
        
        document.querySelectorAll('.sortable').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
        this.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
        
        applyFilters();
    });
});

// ===== ИНИЦИАЛИЗАЦИЯ =====
updatePeriodDisplay();
withLoading(() => loadTripsFromSheet());
loadHistoryData();
