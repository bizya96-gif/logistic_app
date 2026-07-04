// ===== КОНФИГУРАЦИЯ =====
const SHEET_NAME = '2026 Загрузки';
const HEADERS_ROW = 2;
const DATA_START_ROW = 5;

// ===== ЧТЕНИЕ ДАННЫХ (GET) =====
function doGet(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return jsonError('Лист "' + SHEET_NAME + '" не найден!');

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow < DATA_START_ROW) return jsonResponse([]);

    const headers = sheet.getRange(HEADERS_ROW, 1, 1, lastCol).getValues()[0];
    const dataRange = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, lastCol);
    const data = dataRange.getValues();
    const fontColors = dataRange.getFontColors();

    const trips = [];
    
    data.forEach((row, rowIndex) => {
      const id = String(row[0] || '').trim();
      const date = row[1];
      const contractor = String(row[4] || '').trim();
      const profit = row[20];
      const paymentDate = row[15];
      const amountFontColor = fontColors[rowIndex] ? fontColors[rowIndex][12] : '';

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

    return jsonResponse(trips);
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

      // Колонка P (16-я) = Дата оплаты
      sheet.getRange(rowIndex, 16).setValue(paymentDate);

      return jsonResponse({ success: true, message: 'Оплата обновлена' });
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
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
