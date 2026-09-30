// 更正（发布之后的口径修订）
// 纪律：历史发布记录一条都不许改；每次更正在批次里留痕（时刻、更正人、依据、改前改后），
// 更正一旦落库当前对外口径立即更新。批量更正共用一个批次号，下面挂每个受影响事件的差异。
const { AppError } = require('./errors');
const store = require('./store');
const quakelib = require('./quakelib');

// 允许更正的字段：震级、位置（经纬度/深度）、发震时刻、区域、震级类型
const FIELD_LABELS = {
  magnitude: '震级',
  lat: '纬度',
  lon: '经度',
  depth: '深度',
  originTime: '发震时刻',
  regionName: '区域',
  magnitudeType: '震级类型',
};
const CORRECTABLE_FIELDS = Object.keys(FIELD_LABELS);

// 当前对外震级：更正值优先，没更正过就取台站中位震级（与事件页口径一致）
function currentMagnitude(data, event) {
  if (event && event.correctedMagnitude !== undefined && event.correctedMagnitude !== null && event.correctedMagnitude !== '') {
    return Number(event.correctedMagnitude);
  }
  return quakelib.eventMagnitude(data, event.id).magnitude;
}

// 某字段当前的对外口径值
function currentFieldValue(data, event, field) {
  if (field === 'magnitude') return currentMagnitude(data, event);
  return event[field];
}

// 更正前快照：发布/更正时点上的全部可更正字段
function snapshot(data, event) {
  return {
    magnitude: currentMagnitude(data, event),
    lat: Number(event.lat),
    lon: Number(event.lon),
    depth: Number(event.depth),
    originTime: String(event.originTime),
    regionName: String(event.regionName || ''),
    magnitudeType: String(event.magnitudeType || 'ML'),
  };
}

function toAfterValue(field, raw, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    errors[field] = FIELD_LABELS[field] + '的改后值不能为空';
    return undefined;
  }
  if (field === 'originTime') {
    const text = String(raw);
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
      errors[field] = '发震时刻格式要像 2026-09-01 12:00:00';
    }
    return text;
  }
  if (field === 'regionName' || field === 'magnitudeType') {
    return String(raw).trim();
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    errors[field] = FIELD_LABELS[field] + '的改后值得是数字';
    return undefined;
  }
  if (field === 'magnitude' && value <= 0) errors[field] = '震级得大于 0';
  if (field === 'lat' && (value < -90 || value > 90)) errors[field] = '纬度要在 -90 到 90 之间';
  if (field === 'lon' && (value < -180 || value > 180)) errors[field] = '经度要在 -180 到 180 之间';
  if (field === 'depth' && (value < 0 || value > 2000)) errors[field] = '震源深度要在 0 到 2000 公里之间';
  return field === 'magnitude' ? store.round(value, 3) : value;
}

function findEvent(data, eventId) {
  const event = data.events.find((e) => e.id === eventId);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', '这个事件不存在：' + String(eventId || ''));
  return event;
}

// 该事件此前已经更正过几次（决定这次是第几次更正）
function correctionSeqOf(data, eventId) {
  let seq = 0;
  for (const batch of data.corrections) {
    for (const item of batch.items || []) if (item.eventId === eventId) seq += 1;
  }
  return seq;
}

function decorateItem(data, item) {
  const event = data.events.find((e) => e.id === item.eventId);
  return Object.assign({}, item, { eventCode: event ? event.code : '' });
}

function decorateBatch(data, batch) {
  return Object.assign({}, batch, {
    items: (batch.items || []).map((item) => decorateItem(data, item)),
  });
}

// 登记一次更正（可含多个事件，即一批）
function createBatch(data, payload) {
  const body = payload || {};
  const errors = {};
  const corrector = String(body.corrector || '').trim();
  const reason = String(body.reason || '').trim();
  if (!corrector) errors.corrector = '更正人不能为空';
  if (!reason) errors.reason = '更正依据不能为空';
  const at = String(body.at || store.nowText());
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at)) errors.at = '更正时刻格式要像 2026-09-01 12:30:00';

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) errors.items = '至少要登记一个受影响事件';

  // 先把每个事件、每个字段的改后值与差异校验出来，任何一条不合法整批都不入库
  const planned = [];
  const seenEvent = {};
  rawItems.forEach((rawItem, index) => {
    const itemErrors = {};
    const eventId = String((rawItem && rawItem.eventId) || '');
    let event = null;
    try {
      event = data.events.find((e) => e.id === eventId);
      if (!event) itemErrors.eventId = '事件不存在';
    } catch (err) {
      itemErrors.eventId = err.message;
    }
    if (event && event.status === '已删除') itemErrors.eventId = '已删除的事件不能登记更正';
    if (event && event.status !== '已发布' && event.status !== '已删除') {
      itemErrors.eventId = '只有已发布的事件才走更正登记（当前状态：' + event.status + '）';
    }
    if (seenEvent[eventId]) itemErrors.eventId = '同一批里这个事件出现了两次';
    if (eventId) seenEvent[eventId] = true;

    const wanted = Array.isArray(rawItem && rawItem.fields)
      ? rawItem.fields.map((f) => String(f))
      : Object.keys((rawItem && rawItem.after) || {});
    const fields = wanted.filter((f, i) => CORRECTABLE_FIELDS.includes(f) && wanted.indexOf(f) === i);
    const unknown = wanted.filter((f) => !CORRECTABLE_FIELDS.includes(f));
    if (unknown.length) itemErrors.fields = '这些字段不能更正：' + unknown.join('、');
    if (!fields.length) itemErrors.fields = '至少要勾选一个更正项';

    const after = (rawItem && rawItem.after) || {};
    const changes = [];
    if (event && fields.length) {
      const beforeSnap = snapshot(data, event);
      for (const field of fields) {
        const fieldErrors = {};
        const afterValue = toAfterValue(field, after[field], fieldErrors);
        Object.assign(itemErrors, fieldErrors);
        if (fieldErrors[field] !== undefined) continue;
        const beforeValue = currentFieldValue(data, event, field);
        if (String(afterValue) === String(beforeValue)) {
          itemErrors[field] = FIELD_LABELS[field] + '改后值和当前口径一样，没有差异';
          continue;
        }
        changes.push({ field, label: FIELD_LABELS[field], before: beforeSnap[field], after: afterValue });
      }
    }

    if (Object.keys(itemErrors).length) {
      errors['第 ' + (index + 1) + ' 行（' + (eventId || '空') + '）'] = itemErrors;
    } else {
      planned.push({ event, eventId, changes, itemRemark: String((rawItem && rawItem.remark) || '') });
    }
  });

  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '更正登记没通过校验，整批没有入库', errors);
  }

  const batch = {
    id: store.nextId('cor', data.corrections),
    at,
    corrector,
    reason,
    remark: String(body.remark || ''),
    items: [],
  };

  // 校验通过后统一落库、统一改值：先写批次留痕，再动当前口径
  planned.forEach((plan) => {
    const beforeSnap = snapshot(data, plan.event);
    const seq = correctionSeqOf(data, plan.eventId) + 1;
    const item = {
      eventId: plan.eventId,
      code: plan.event.code,
      seq,
      fields: plan.changes.map((c) => Object.assign({}, c)),
      before: beforeSnap,
      remark: plan.itemRemark,
    };
    batch.items.push(item);
  });
  data.corrections.push(batch);

  batch.items.forEach((item) => {
    const event = findEvent(data, item.eventId);
    let resultingMagnitude = item.before.magnitude;
    for (const change of item.fields) {
      if (change.field === 'magnitude') {
        event.correctedMagnitude = change.after;
        resultingMagnitude = change.after;
      } else {
        event[change.field] = change.after;
      }
    }
    // 只改位置时中位震级会随经纬度隐式漂移；把震级口径显式冻结在更正后的值上，
    // 保证时间线上每一步的震级都与当前对外值对得上（震级再被更正时以新值覆盖）
    event.correctedMagnitude = resultingMagnitude;
    event.lastCorrectionAt = batch.at;
    event.lastCorrector = batch.corrector;
  });

  return decorateBatch(data, batch);
}

function listBatches(data, query) {
  const q = query || {};
  let rows = data.corrections.slice();
  if (q.eventId) rows = rows.filter((b) => (b.items || []).some((i) => i.eventId === q.eventId));
  if (q.corrector) rows = rows.filter((b) => b.corrector === q.corrector);
  return rows
    .map((b) => decorateBatch(data, b))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

// 摊平到「事件 × 更正条目」，给事件详情和台账用
function listEntries(data, query) {
  const q = query || {};
  const rows = [];
  for (const batch of listBatches(data, {})) {
    for (const item of batch.items) {
      if (q.eventId && item.eventId !== q.eventId) continue;
      rows.push({
        batchId: batch.id,
        at: batch.at,
        corrector: batch.corrector,
        reason: batch.reason,
        batchRemark: batch.remark,
        eventId: item.eventId,
        eventCode: item.eventCode,
        seq: item.seq,
        fields: item.fields,
        before: item.before,
        remark: item.remark,
      });
    }
  }
  return rows;
}

function countOfEvent(data, eventId) {
  let count = 0;
  for (const batch of data.corrections) {
    for (const item of batch.items || []) if (item.eventId === eventId) count += 1;
  }
  return count;
}

function correctedFieldsOfEvent(data, eventId) {
  const set = {};
  for (const batch of data.corrections) {
    for (const item of batch.items || []) {
      if (item.eventId !== eventId) continue;
      for (const change of item.fields || []) set[change.field] = change.label;
    }
  }
  return Object.keys(set).map((field) => ({ field, label: set[field] }));
}

module.exports = {
  FIELD_LABELS,
  CORRECTABLE_FIELDS,
  currentMagnitude,
  snapshot,
  createBatch,
  listBatches,
  listEntries,
  countOfEvent,
  correctedFieldsOfEvent,
};
