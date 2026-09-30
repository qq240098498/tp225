// 发布后的更正台账：一次更正是一个批次（单事件更正就是只有一条的批次）。
// 更正记录只追加、不修改、不删除；事件当前值在登记时就地更新，历史值靠发布记录与更正记录留存。
const store = require('./store');
const quakelib = require('./quakelib');
const { AppError } = require('./errors');

// 允许更正的项目：震级与位置（发震时刻一并留着，批量接口可传，页面上默认只放开前四项）
const FIELDS = {
  magnitude: { fieldName: '震级', numeric: true },
  lat: { fieldName: '纬度', numeric: true },
  lon: { fieldName: '经度', numeric: true },
  depth: { fieldName: '深度', numeric: true },
  originTime: { fieldName: '发震时刻', numeric: false },
};

function findEvent(data, eventId) {
  const event = data.events.find((e) => e.id === eventId);
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', '这个事件不存在：' + eventId);
  return event;
}

// 当前对外口径震级：最新更正值优先；其次最新发布记录的快照（兼容功能上线前已发布的老事件）；都没有才取台站中位数
function currentMagnitude(data, event) {
  if (event.officialMagnitude !== undefined && event.officialMagnitude !== null && event.officialMagnitude !== '') {
    return Number(event.officialMagnitude);
  }
  const publishes = data.publishes
    .filter((p) => p.eventId === event.id)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  if (publishes.length) return Number(publishes[publishes.length - 1].magnitude);
  return quakelib.eventMagnitude(data, event.id).magnitude;
}

function fieldBefore(data, event, field) {
  if (field === 'magnitude') return currentMagnitude(data, event);
  return event[field];
}

function validateAfter(field, value) {
  if (FIELDS[field].numeric) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '要填数字';
    if (field === 'magnitude' && (n < 0 || n > 12)) return '震级要在 0 到 12 之间';
    if (field === 'lat' && (n < -90 || n > 90)) return '纬度要在 -90 到 90 之间';
    if (field === 'lon' && (n < -180 || n > 180)) return '经度要在 -180 到 180 之间';
    if (field === 'depth' && (n < 0 || n > 2000)) return '震源深度要在 0 到 2000 公里之间';
    return '';
  }
  if (field === 'originTime' && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))) {
    return '发震时刻格式要像 2026-09-01 12:00:00';
  }
  return '';
}

// 由入参算出这个事件这次实际改了哪几项（没传的项不改，传了但没变的项也不算）
function buildChanges(data, event, input) {
  const changes = [];
  const problems = [];
  for (const field of Object.keys(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, field)) continue;
    const raw = input[field];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const problem = validateAfter(field, raw);
    if (problem) {
      problems.push(FIELDS[field].fieldName + problem);
      continue;
    }
    const after = FIELDS[field].numeric ? Number(raw) : String(raw).trim();
    const before = fieldBefore(data, event, field);
    if (Number(after) === Number(before) && String(after) === String(before)) continue;
    changes.push({ field, fieldName: FIELDS[field].fieldName, before, after });
  }
  return { changes, problems };
}

function applyChange(event, change) {
  if (change.field === 'magnitude') event.officialMagnitude = change.after;
  else event[change.field] = change.after;
}

// 批量登记：items 里一条对应一个受影响事件
function registerBatch(data, payload) {
  const body = payload || {};
  const errors = {};
  const corrector = String(body.corrector || '').trim();
  const reason = String(body.reason || '').trim();
  if (!corrector) errors.corrector = '更正人不能为空';
  if (!reason) errors.reason = '更正依据不能为空';
  if (!Array.isArray(body.items) || !body.items.length) errors.items = '至少要登记一个受影响事件';

  const items = [];
  if (!errors.items) {
    const seen = {};
    body.items.forEach((input, index) => {
      const label = '第 ' + (index + 1) + ' 行';
      if (!input || !input.eventId) {
        errors['items[' + index + ']'] = label + '：没指明事件';
        return;
      }
      if (seen[input.eventId]) {
        errors['items[' + index + ']'] = label + '：同一批里这个事件出现了两次（' + input.eventId + '）';
        return;
      }
      seen[input.eventId] = true;
      const event = findEvent(data, input.eventId);
      if (event.status !== '已发布' || !data.publishes.some((p) => p.eventId === event.id)) {
        errors['items[' + index + ']'] = label + '：事件 ' + event.code + ' 还没发布，发出去之后才能登记更正';
        return;
      }
      const built = buildChanges(data, event, input);
      if (built.problems.length) {
        errors['items[' + index + ']'] = label + '：事件 ' + event.code + ' ' + built.problems.join('、');
        return;
      }
      if (!built.changes.length) {
        errors['items[' + index + ']'] = label + '：事件 ' + event.code + ' 没有任何实际改动';
        return;
      }
      items.push({ event, changes: built.changes });
    });
  }

  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '更正没通过校验，请按提示补齐', errors);
  }

  const at = String(body.at || store.nowText());
  const id = store.nextId('cor', data.corrections);
  const record = {
    id,
    at,
    corrector,
    reason,
    remark: String(body.remark || ''),
    eventCount: items.length,
    items: items.map((entry) => ({
      eventId: entry.event.id,
      code: entry.event.code,
      changes: entry.changes,
    })),
  };

  // 全部校验通过后才一次性落账、生效
  items.forEach((entry) => entry.changes.forEach((change) => applyChange(entry.event, change)));
  data.corrections.push(record);
  return { correction: decorateBatch(record), affectedEvents: record.items.map((item) => itemView(item)) };
}

// 单事件更正：字段直接放在 payload 顶层，包成只有一条的批次
function registerOne(data, eventId, payload) {
  const body = payload || {};
  const fields = {};
  for (const field of Object.keys(FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(body, field)) fields[field] = body[field];
  }
  return registerBatch(data, {
    at: body.at,
    corrector: body.corrector,
    reason: body.reason,
    remark: body.remark,
    items: [Object.assign({ eventId }, fields)],
  });
}

function itemView(item) {
  return {
    eventId: item.eventId,
    eventCode: item.code,
    changes: item.changes,
  };
}

function decorateBatch(record) {
  return Object.assign({}, record, {
    items: record.items.map((item) => itemView(item)),
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.corrections.slice();
  if (q.corrector) rows = rows.filter((r) => r.corrector === q.corrector);
  if (q.eventId) rows = rows.filter((r) => r.items.some((item) => item.eventId === q.eventId));
  return rows
    .map(decorateBatch)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

// 摊平到单个事件：带上这是该事件第几次更正
function forEvent(data, eventId) {
  const flat = [];
  data.corrections.forEach((record) => {
    record.items.forEach((item) => {
      if (item.eventId !== eventId) return;
      flat.push({
        batchId: record.id,
        at: record.at,
        corrector: record.corrector,
        reason: record.reason,
        remark: record.remark,
        changes: item.changes,
      });
    });
  });
  flat.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.batchId < b.batchId ? -1 : 1));
  return flat.map((row, index) => Object.assign({ seq: index + 1 }, row));
}

function countForEvent(data, eventId) {
  return data.corrections.reduce(
    (acc, record) => acc + record.items.filter((item) => item.eventId === eventId).length,
    0
  );
}

function lastAtForEvent(data, eventId) {
  const rows = forEvent(data, eventId);
  return rows.length ? rows[rows.length - 1].at : '';
}

module.exports = {
  FIELDS,
  currentMagnitude,
  registerBatch,
  registerOne,
  list,
  forEvent,
  countForEvent,
  lastAtForEvent,
};
