// ===== КОНФИГУРАЦИЯ =====
const SHEET_NAME = '2026 Загрузки';
const HEADERS_ROW = 2;
const DATA_START_ROW = 5;
const READ_LAST_COL = 26;
const TRIPS_CACHE_KEY = 'alexlogistic_trips_v1';
const TRIPS_CACHE_META_KEY = TRIPS_CACHE_KEY + ':meta';
const TRIPS_CACHE_TTL_SECONDS = 60;
const TRIPS_CACHE_CHUNK_SIZE = 30000;
const PATCH_PROTECTED_HEADERS = ['№ рейса'];

// ===== ЧТЕНИЕ ДАННЫХ (GET) =====
function doGet(e) {
  try {
    // Необязательный параметр ?sheet=... — для разовой выгрузки архивных листов
    // (напр. "2025 Загрузки", "2024 Загрузки"). По умолчанию — текущий SHEET_NAME.
    const requestedSheetName = (e && e.parameter && e.parameter.sheet) ? String(e.parameter.sheet).trim() : '';
    const targetSheetName = requestedSheetName || SHEET_NAME;
    const isArchiveRequest = requestedSheetName && requestedSheetName !== SHEET_NAME;

    const cache = CacheService.getScriptCache();
    const noCache = e && e.parameter && e.parameter.noCache === '1';
    const cached = (noCache || isArchiveRequest) ? null : getTripsCachePayload(cache);
    if (cached) return jsonTextResponse(cached);

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(targetSheetName);
    if (!sheet) {
      const availableNames = spreadsheet.getSheets().map(function (s) { return s.getName(); });
      return jsonError('Лист "' + targetSheetName + '" не найден! Доступные листы: ' + JSON.stringify(availableNames));
    }

    const lastRow = sheet.getLastRow();
    const lastCol = Math.min(sheet.getLastColumn(), READ_LAST_COL);

    if (lastRow < DATA_START_ROW) return jsonResponse([]);

    const rowsCount = lastRow - DATA_START_ROW + 1;
    const headers = sheet.getRange(HEADERS_ROW, 1, 1, lastCol).getValues()[0];
    const dataRange = sheet.getRange(DATA_START_ROW, 1, rowsCount, lastCol);
    const data = dataRange.getValues();
    const amountFontColors = sheet.getRange(DATA_START_ROW, 13, rowsCount, 1).getFontColors();

    const trips = [];

    data.forEach((row, rowIndex) => {
      const id = String(row[0] || '').trim();
      const date = row[1];
      const contractor = String(row[4] || '').trim();
      const profit = row[20];
      const paymentDate = row[15];
      const amountFontColor = amountFontColors[rowIndex] ? amountFontColors[rowIndex][0] : '';

      const hasId = id !== '';
      const hasDateAndContractor = date !== '' && contractor !== '';

      if (!hasId && !hasDateAndContractor) return;
      if (!hasId && !date && profit === 0) return;

      const obj = {};
      headers.forEach((h, i) => {
        let key = String(h || '').trim();
        if (key) {
          let val = row[i];
          if (val instanceof Date) {
            val = Utilities.formatDate(val, Session.getScriptTimeZone(), "dd.MM.yyyy");
          }
          obj[key] = val;
        }
      });
      obj.__isPaid = !!(paymentDate && String(paymentDate).trim() !== '') || isBlackFontColor(amountFontColor);
      trips.push(obj);
    });

    const payload = JSON.stringify(trips);
    if (!isArchiveRequest) {
      tryPutTripsCachePayload(cache, payload);
    }
    return jsonTextResponse(payload);
  } catch (err) {
    return jsonError('Ошибка: ' + err.toString());
  }
}

function isBlackFontColor(color) {
  const normalized = String(color || '').trim().toLowerCase().replace(/\s+/g, '');
  return normalized === '#000000' ||
    normalized === '#000' ||
    normalized === 'black' ||
    normalized === 'rgb(0,0,0)';
}

// ===== ЗАПИСЬ ДАННЫХ (POST) =====
function doPost(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return jsonError('Лист не найден');

    const body = JSON.parse(e.postData.contents);

    // ===== СОЗДАНИЕ НОВОГО РЕЙСА =====
    if (body.action === 'create') {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);

      try {
        const generatedTripId = getNextTripId(sheet, body.trip.vehicle);
        const insertRow = findInsertRow(sheet);

        const newRow = [
          generatedTripId,
          body.trip.date || '',
          body.trip.driver || '',
          body.trip.vehicle || '',
          body.trip.contractor || '',
          body.trip.route || '',
          body.trip.docType || '',
          body.trip.cargoReceiver || '',
          body.trip.cargo || '',
          body.trip.invoice || '',
          '', // Дата приезда
          body.trip.distance || 0,
          body.trip.income || 0,
          body.trip.standbyPrice || 0,
          body.trip.paymentType || 'Б.Н.',
          '', // Дата оплаты
          body.trip.commission || 0,
          body.trip.fuel || 0,
          body.trip.liters || 0,
          body.trip.toll || 0,
          body.trip.profit || 0,
          '', // Прибыль по компании
          '',
          body.trip.leshe || '',
          body.trip.sum || '',
          ''
        ];

        sheet.insertRowsAfter(insertRow - 1, 1);
        sheet.getRange(insertRow, 1, 1, newRow.length).setValues([newRow]);
        clearTripsCache();

        return jsonResponse({
          success: true,
          tripId: generatedTripId,
          message: 'Рейс ' + generatedTripId + ' добавлен на строку ' + insertRow
        });
      } finally {
        lock.releaseLock();
      }
    }

    // ===== РЕДАКТИРОВАНИЕ РЕЙСА =====
    if (body.action === 'update') {
      const tripId = body.tripId;
      const rowIndex = findTripRow(sheet, tripId);

      if (rowIndex === -1) {
        return jsonError('Рейс не найден: ' + tripId);
      }

      const lastCol = Math.max(sheet.getLastColumn(), 26);
      const updatedRow = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];

      updatedRow[0] = body.trip.id || '';
      updatedRow[1] = body.trip.date || '';
      updatedRow[2] = body.trip.driver || '';
      updatedRow[3] = body.trip.vehicle || '';
      updatedRow[4] = body.trip.contractor || '';
      updatedRow[5] = body.trip.route || '';
      updatedRow[6] = body.trip.docType || '';
      updatedRow[7] = body.trip.cargoReceiver || '';
      updatedRow[8] = body.trip.cargo || '';
      updatedRow[9] = body.trip.invoice || '';
      // K: Дата приезда сохраняется из существующей строки.
      updatedRow[11] = body.trip.distance || 0;
      updatedRow[12] = body.trip.income || 0;
      updatedRow[13] = body.trip.standbyPrice || 0;
      updatedRow[14] = body.trip.paymentType || 'Б.Н.';
      // P: Дата оплаты сохраняется из существующей строки.
      updatedRow[16] = body.trip.commission || 0;
      updatedRow[17] = body.trip.fuel || 0;
      updatedRow[18] = body.trip.liters || 0;
      updatedRow[19] = body.trip.toll || 0;
      updatedRow[20] = body.trip.profit || 0;
      // V, W, Z: служебные колонки сохраняются из существующей строки.
      updatedRow[23] = body.trip.leshe || '';
      updatedRow[24] = body.trip.sum || '';

      sheet.getRange(rowIndex, 1, 1, updatedRow.length).setValues([updatedRow]);
      clearTripsCache();

      return jsonResponse({ success: true, message: 'Рейс обновлен на строке ' + rowIndex });
    }

    // ===== УДАЛЕНИЕ РЕЙСА =====
    if (body.action === 'delete') {
      const tripId = body.tripId;
      const rowIndex = findTripRow(sheet, tripId);

      if (rowIndex === -1) {
        return jsonError('Рейс не найден: ' + tripId);
      }

      sheet.deleteRow(rowIndex);
      clearTripsCache();

      return jsonResponse({ success: true, message: 'Рейс удален' });
    }

    // ===== ОБНОВЛЕНИЕ ОПЛАТЫ =====
    if (body.action === 'updatePayment') {
      const tripId = body.tripId;
      const paymentDate = body.paymentDate;
      const rowIndex = findTripRow(sheet, tripId);

      if (rowIndex === -1) {
        return jsonError('Рейс не найден: ' + tripId);
      }

      // M (13-я) = сумма, P (16-я) = дата оплаты.
      sheet.getRange(rowIndex, 16).setValue(paymentDate);
      sheet.getRange(rowIndex, 13).setFontColor(paymentDate ? '#000000' : '#ff0000');
      clearTripsCache();

      return jsonResponse({ success: true, message: 'Оплата обновлена' });
    }

    // ===== УНИВЕРСАЛЬНОЕ ТОЧЕЧНОЕ ОБНОВЛЕНИЕ РЕЙСА =====
    if (body.action === 'patchTrip') {
      const result = patchTripRow(sheet, body);
      clearTripsCache();
      return jsonResponse(result);
    }

    return jsonError('Неизвестное действие: ' + body.action);
  } catch (err) {
    return jsonError(err.toString());
  }
}

// ===== ПОИСК СТРОКИ ПО ID РЕЙСА =====
function findTripRow(sheet, tripId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return -1;

  const data = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();

  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(tripId).trim()) {
      return DATA_START_ROW + i;
    }
  }

  return -1;
}

function getHeaderMap(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADERS_ROW, 1, 1, lastCol).getValues()[0];
  const map = {};

  headers.forEach((header, index) => {
    const key = String(header || '').trim();
    if (key) map[key] = index + 1;
  });

  return map;
}

function assertPatchableHeader(header, headerMap) {
  const key = String(header || '').trim();
  if (!key || !headerMap[key]) {
    throw new Error('Колонка не найдена: ' + key);
  }

  if (PATCH_PROTECTED_HEADERS.indexOf(key) !== -1) {
    throw new Error('Колонку нельзя менять через patchTrip: ' + key);
  }

  return key;
}

function patchTripRow(sheet, body) {
  const tripId = body.tripId;
  const rowIndex = findTripRow(sheet, tripId);

  if (rowIndex === -1) {
    throw new Error('Рейс не найден: ' + tripId);
  }

  const headerMap = getHeaderMap(sheet);
  const values = body.values || {};
  const formats = body.formats || {};
  let updatedValues = 0;
  let updatedFormats = 0;

  Object.keys(values).forEach(header => {
    const key = assertPatchableHeader(header, headerMap);
    sheet.getRange(rowIndex, headerMap[key]).setValue(values[header]);
    updatedValues++;
  });

  Object.keys(formats).forEach(header => {
    const key = assertPatchableHeader(header, headerMap);
    const format = formats[header] || {};
    const range = sheet.getRange(rowIndex, headerMap[key]);

    if (format.fontColor !== undefined) {
      range.setFontColor(format.fontColor);
      updatedFormats++;
    }

    if (format.background !== undefined) {
      range.setBackground(format.background);
      updatedFormats++;
    }

    if (format.fontWeight !== undefined) {
      range.setFontWeight(format.fontWeight);
      updatedFormats++;
    }
  });

  return {
    success: true,
    message: 'Рейс обновлен через patchTrip',
    updatedValues: updatedValues,
    updatedFormats: updatedFormats
  };
}

// ===== ПОИСК СТРОКИ ДЛЯ ВСТАВКИ НОВОГО РЕЙСА =====
function findInsertRow(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < DATA_START_ROW) return DATA_START_ROW;

  const data = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastCol).getValues();

  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const id = String(row[0] || '').trim();
    const date = row[1];
    const contractor = String(row[4] || '').trim();
    const income = row[12];

    const hasId = id !== '';
    const hasRealData = date !== '' && contractor !== '' && income !== 0 && income !== '0' && income !== '0 ₽';

    if (hasId || hasRealData) {
      return DATA_START_ROW + i + 1;
    }
  }

  return DATA_START_ROW;
}

// ===== ГЕНЕРАЦИЯ ID РЕЙСА =====
function getNextTripId(sheet, vehicle) {
  const vehicleName = String(vehicle || '').trim();
  if (!vehicleName) {
    throw new Error('Автомобиль обязателен для генерации ID рейса');
  }

  const letter = vehicleName[0].toUpperCase();
  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return letter + '-1';

  const ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  let maxNumber = 0;

  ids.forEach(row => {
    const id = String(row[0] || '').trim();
    const match = id.match(/^([А-ЯA-Z])-(\d+)$/i);
    if (!match || match[1].toUpperCase() !== letter) return;

    const num = parseInt(match[2], 10);
    if (!isNaN(num) && num > maxNumber) {
      maxNumber = num;
    }
  });

  return letter + '-' + (maxNumber + 1);
}

// ===== УТИЛИТЫ =====
function jsonResponse(data) {
  return jsonTextResponse(JSON.stringify(data));
}

function jsonTextResponse(payload) {
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getTripsCachePayload(cache) {
  const metaRaw = cache.get(TRIPS_CACHE_META_KEY);
  if (!metaRaw) return null;

  try {
    const meta = JSON.parse(metaRaw);
    const chunksCount = Number(meta.chunks || 0);
    if (!chunksCount) return null;

    const keys = [];
    for (let i = 0; i < chunksCount; i++) {
      keys.push(TRIPS_CACHE_KEY + ':' + i);
    }

    const cachedChunks = cache.getAll(keys);
    const chunks = [];
    for (let i = 0; i < keys.length; i++) {
      const chunk = cachedChunks[keys[i]];
      if (!chunk) return null;
      chunks.push(chunk);
    }

    return chunks.join('');
  } catch (err) {
    return null;
  }
}

function tryPutTripsCachePayload(cache, payload) {
  try {
    putTripsCachePayload(cache, payload);
  } catch (err) {
    console.warn('Не удалось сохранить кэш рейсов:', err);
  }
}

function putTripsCachePayload(cache, payload) {
  const chunksCount = Math.ceil(payload.length / TRIPS_CACHE_CHUNK_SIZE);
  const values = {};

  for (let i = 0; i < chunksCount; i++) {
    const start = i * TRIPS_CACHE_CHUNK_SIZE;
    values[TRIPS_CACHE_KEY + ':' + i] = payload.slice(start, start + TRIPS_CACHE_CHUNK_SIZE);
  }

  cache.putAll(values, TRIPS_CACHE_TTL_SECONDS);
  cache.put(TRIPS_CACHE_META_KEY, JSON.stringify({ chunks: chunksCount }), TRIPS_CACHE_TTL_SECONDS);
}

function clearTripsCache() {
  const cache = CacheService.getScriptCache();
  const metaRaw = cache.get(TRIPS_CACHE_META_KEY);
  const keys = [TRIPS_CACHE_META_KEY];

  if (metaRaw) {
    try {
      const meta = JSON.parse(metaRaw);
      const chunksCount = Number(meta.chunks || 0);
      for (let i = 0; i < chunksCount; i++) {
        keys.push(TRIPS_CACHE_KEY + ':' + i);
      }
    } catch (err) {
      // Если метаданные повреждены, ниже удалим типичный небольшой набор чанков.
    }
  }

  for (let i = 0; i < 10; i++) {
    keys.push(TRIPS_CACHE_KEY + ':' + i);
  }

  cache.removeAll(keys);
}
