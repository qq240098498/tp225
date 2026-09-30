const { AppError } = require('./errors');
const store = require('./store');
const quakelib = require('./quakelib');
const corrections = require('./corrections');

const STATUS_LIST = ['待复核', '已复核', '已发布', '已删除'];
const BURIED = 2000;

// 最新一条复核：按复核时刻取
function latestReviewOf(data, eventId) {
  const rows = data.reviews.filter((r) => r.eventId === eventId);
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function decorate(data, event) {
  const computed = quakelib.eventMagnitude(data, event.id);
  const rms = quakelib.eventRms(data, event.id);
  const arrivals = data.arrivals.filter((a) => a.eventId === event.id);
  const publishes = data.publishes.filter((p) => p.eventId === event.id);
  const latest = latestReviewOf(data, event.id);
  // 当前对外震级：更正过就用最近一次更正值，没更正过用台站中位震级
  const magnitude = corrections.currentMagnitude(data, event);
  const correctionCount = corrections.countOfEvent(data, event.id);
  return Object.assign({}, event, {
    magnitude,
    autoMagnitude: computed.magnitude,
    correctedMagnitude: event.correctedMagnitude !== undefined ? Number(event.correctedMagnitude) : null,
    magnitudeType: event.magnitudeType || 'ML',
    stationCount: computed.stationCount,
    stationCodes: quakelib.stationsOfEvent(data, event.id),
    arrivalCount: arrivals.length,
    rms,
    autoCheck: quakelib.autoPublishCheck(data, event),
    latestReview: latest
      ? { reviewer: latest.reviewer, at: latest.at, action: latest.action, mutation: latest.mutation || '', overTolerance: latest.overTolerance }
      : null,
    reviewCount: data.reviews.filter((r) => r.eventId === event.id).length,
    publishCount: publishes.length,
    lastPublishAt: publishes.length ? publishes[publishes.length - 1].at : '',
    correctionCount,
    correctedFields: corrections.correctedFieldsOfEvent(data, event.id),
    lastCorrectionAt: event.lastCorrectionAt || '',
    lastCorrector: event.lastCorrector || '',
  });
}

function list(data, query) {
  const q = query || {};
  let rows = data.events.slice();
  if (q.status) rows = rows.filter((e) => e.status === q.status);
  if (q.regionName) rows = rows.filter((e) => String(e.regionName || '').includes(q.regionName));
  if (q.from) rows = rows.filter((e) => e.originTime >= q.from);
  if (q.to) rows = rows.filter((e) => e.originTime <= q.to);
  const decorated = rows.map((e) => decorate(data, e));
  // 震级筛选要放在 decorate 之后：震级是算出来的，更正过的事件取当前口径震级
  const filtered = q.minMagnitude ? decorated.filter((e) => Number(e.magnitude) >= Number(q.minMagnitude)) : decorated;
  // 按发震时刻从近到远
  return filtered.sort((a, b) => (a.originTime < b.originTime ? 1 : -1));
}

function find(data, id) {
  const found = data.events.find((e) => e.id === id);
  if (!found) throw new AppError(404, 'EVENT_NOT_FOUND', '这个事件不存在');
  return found;
}

function detail(data, id) {
  const event = find(data, id);
  const arrivals = data.arrivals.filter((a) => a.eventId === id).sort((a, b) => (a.at < b.at ? -1 : 1));
  const enriched = arrivals.map((a) => {
    const station = quakelib.findStation(data, a.stationCode);
    const distance = station ? quakelib.distanceKm(station.lat, station.lon, event.lat, event.lon) : null;
    return Object.assign({}, a, {
      stationName: station ? station.name : '(台站台账里没有这个代码)',
      distanceKm: distance,
      stationMagnitude: station && a.amplitudeUm != null ? quakelib.stationMagnitude(a.amplitudeUm, distance) : null,
    });
  });
  return Object.assign({}, decorate(data, event), {
    arrivals: enriched,
    reviews: data.reviews.filter((r) => r.eventId === id).slice().sort((a, b) => (a.at < b.at ? -1 : 1)),
    publishes: data.publishes.filter((p) => p.eventId === id).slice().sort((a, b) => (a.at < b.at ? -1 : 1)),
    corrections: corrections.listEntries(data, { eventId: id }),
    timeline: timeline(data, id),
  });
}

// 对外口径时间线：发布与更正按时刻排在一起，每一步都能看到当时对外值
// 发布记录与更正条目都不删不改，所以这里能完整还原「第一次发多少、第几次改成多少」
function timeline(data, eventId) {
  const steps = [];
  for (const p of data.publishes.filter((x) => x.eventId === eventId)) {
    steps.push({
      kind: 'publish',
      at: p.at,
      seq: data.publishes.filter((x) => x.eventId === eventId && x.at <= p.at).length,
      operator: p.operator,
      type: p.type,
      channel: p.channel,
      values: {
        magnitude: p.magnitude,
        lat: p.lat,
        lon: p.lon,
        depth: p.depth,
        originTime: p.originTime,
        regionName: p.regionName,
        magnitudeType: p.magnitudeType,
      },
      remark: p.remark || '',
    });
  }
  for (const entry of corrections.listEntries(data, { eventId })) {
    const values = Object.assign({}, entry.before);
    for (const change of entry.fields) values[change.field] = change.after;
    steps.push({
      kind: 'correction',
      id: entry.batchId,
      at: entry.at,
      seq: entry.seq,
      corrector: entry.corrector,
      reason: entry.reason,
      changes: entry.fields,
      values,
      remark: entry.remark || '',
    });
  }
  return steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === 'publish' ? -1 : 1));
}

function validate(data, payload, current) {
  const errors = {};
  const merged = Object.assign({}, current || {}, payload || {});
  if (!String(merged.code || '').trim()) errors.code = '事件编号不能为空';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(merged.originTime || ''))) errors.originTime = '发震时刻格式要像 2026-09-01 12:00:00';
  if (!STATUS_LIST.includes(merged.status)) errors.status = '状态只能是：' + STATUS_LIST.join('、');
  const lat = Number(merged.lat);
  const lon = Number(merged.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.lat = '纬度要在 -90 到 90 之间';
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) errors.lon = '经度要在 -180 到 180 之间';
  const depth = Number(merged.depth);
  if (!Number.isFinite(depth) || depth < 0 || depth > BURIED) errors.depth = '震源深度要在 0 到 2000 公里之间';
  if (Object.keys(errors).length) {
    throw new AppError(400, 'VALIDATION_FAILED', '事件没通过校验，请按提示补齐', errors);
  }
}

function create(data, payload) {
  validate(data, payload, null);
  const event = {
    id: store.nextId('eq', data.events),
    code: String(payload.code).trim(),
    originTime: String(payload.originTime),
    lat: Number(payload.lat),
    lon: Number(payload.lon),
    depth: Number(payload.depth),
    regionName: String(payload.regionName || '').trim(),
    magnitudeInit: Number(payload.magnitudeInit) || 0,
    magnitudeType: String(payload.magnitudeType || 'ML'),
    status: payload.status,
    source: String(payload.source || '自动编目').trim(),
    remark: String(payload.remark || ''),
  };
  data.events.push(event);
  return decorate(data, event);
}

function update(data, id, payload) {
  const event = find(data, id);
  validate(data, payload, event);
  // 已发布之后，口径字段只能走「更正」登记，不能在这直接抹掉
  if (event.status === '已发布') {
    const protectedFields = ['lat', 'lon', 'depth', 'originTime', 'regionName', 'magnitudeType', 'code'];
    const touched = protectedFields.filter((key) => payload[key] !== undefined && String(payload[key]) !== String(event[key]));
    if (touched.length) {
      throw new AppError(409, 'EVENT_PUBLISHED_LOCKED', '事件已经发布，' + touched.join('、') + ' 不能直接改，要走更正登记并留痕', { fields: touched });
    }
  }
  const merged = Object.assign({}, event, payload);
  Object.assign(event, {
    code: String(merged.code).trim(),
    originTime: String(merged.originTime),
    lat: Number(merged.lat),
    lon: Number(merged.lon),
    depth: Number(merged.depth),
    regionName: String(merged.regionName || '').trim(),
    magnitudeType: String(merged.magnitudeType || event.magnitudeType),
    status: merged.status,
    source: String(merged.source || event.source).trim(),
    remark: String(merged.remark || ''),
  });
  return decorate(data, event);
}

// 复核：登记改动，超过容差的要标出来
function addReview(data, id, payload) {
  const event = find(data, id);
  const beforeMagnitude = quakelib.eventMagnitude(data, event.id).magnitude;
  const afterMagnitude = payload.afterMagnitude === undefined || payload.afterMagnitude === '' ? beforeMagnitude : Number(payload.afterMagnitude);
  const beforeDepth = Number(event.depth);
  const afterDepth = payload.afterDepth === undefined || payload.afterDepth === '' ? beforeDepth : Number(payload.afterDepth);
  if (!String(payload.reviewer || '').trim()) {
    throw new AppError(400, 'VALIDATION_FAILED', '复核人要填', { reviewer: '复核人不能为空' });
  }
  if (payload.action && !['通过', '退回', '改震级', '改位置'].includes(payload.action)) {
    throw new AppError(400, 'VALIDATION_FAILED', '复核动作只能是：通过、退回、改震级、改位置', { action: '动作不对' });
  }
  // 已发布之后改震级/深度必须走更正登记，不能借复核把对外口径抹掉
  if (event.status === '已发布' && (Number(afterMagnitude) !== Number(beforeMagnitude) || Number(afterDepth) !== Number(beforeDepth))) {
    throw new AppError(409, 'EVENT_PUBLISHED_LOCKED', '事件已经发布，震级/深度的改动要走「更正登记」，会留下改前改后和依据', {});
  }
  const tolerance = quakelib.reviewOverTolerance(beforeMagnitude, afterMagnitude, data.settings);
  const review = {
    id: store.nextId('rev', data.reviews),
    eventId: event.id,
    at: String(payload.at || store.nowText()),
    reviewer: String(payload.reviewer).trim(),
    action: String(payload.action || '通过'),
    beforeMagnitude,
    afterMagnitude,
    beforeDepth,
    afterDepth,
    gap: tolerance.gap,
    tolerance: tolerance.tolerance,
    overTolerance: tolerance.over,
    comment: String(payload.comment || ''),
  };
  data.reviews.push(review);
  event.depth = afterDepth;
  event.reviewedMagnitude = afterMagnitude;
  event.status = event.status === '已发布' ? '已发布' : '已复核';
  event.reviewer = review.reviewer;
  event.reviewedAt = review.at;
  return { review, event: decorate(data, event) };
}

// 发布：写入发布记录并改状态
function publish(data, id, payload) {
  const event = find(data, id);
  if (event.status === '已删除') throw new AppError(409, 'EVENT_DELETED', '这个事件已经删除，不能再发布');
  const check = quakelib.autoPublishCheck(data, event);
  if (payload && payload.auto === true && !check.pass) {
    throw new AppError(409, 'NOT_AUTO_READY', '这个事件还不满足自动发布条件：' + check.failed.join('、'), { check });
  }
  const record = {
    id: store.nextId('pub', data.publishes),
    eventId: event.id,
    code: event.code,
    at: String((payload && payload.at) || store.nowText()),
    type: payload && payload.auto === true ? '自动' : '人工',
    operator: String((payload && payload.operator) || 'system').trim(),
    // 发布当时的对外口径整条快照，之后再更正也不改这条记录
    magnitude: corrections.currentMagnitude(data, event),
    lat: Number(event.lat),
    lon: Number(event.lon),
    depth: Number(event.depth),
    originTime: String(event.originTime),
    regionName: String(event.regionName || ''),
    magnitudeType: String(event.magnitudeType || 'ML'),
    channel: String((payload && payload.channel) || '速报').trim(),
    remark: String((payload && payload.remark) || ''),
  };
  data.publishes.push(record);
  event.status = '已发布';
  event.publishAt = record.at;
  return { publish: record, event: decorate(data, event) };
}

function remove(data, id, payload) {
  const event = find(data, id);
  if (event.status === '已发布' && !(payload && payload.force === true)) {
    throw new AppError(409, 'EVENT_PUBLISHED', '已发布的事件不能直接删除，要删除请先说明理由并确认', { code: event.code });
  }
  event.status = '已删除';
  event.deleteReason = String((payload && payload.reason) || '').trim();
  return decorate(data, event);
}

function reviews(data, query) {
  const q = query || {};
  let rows = data.reviews.slice();
  if (q.eventId) rows = rows.filter((r) => r.eventId === q.eventId);
  if (q.reviewer) rows = rows.filter((r) => r.reviewer === q.reviewer);
  if (q.overTolerance === 'true') rows = rows.filter((r) => r.overTolerance);
  return rows
    .map((r) => {
      const event = data.events.find((e) => e.id === r.eventId);
      return Object.assign({}, r, { eventCode: event ? event.code : '' });
    })
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function publishes(data, query) {
  const q = query || {};
  let rows = data.publishes.slice();
  if (q.eventId) rows = rows.filter((p) => p.eventId === q.eventId);
  if (q.type) rows = rows.filter((p) => p.type === q.type);
  return rows.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
}

module.exports = { list, find, detail, create, update, addReview, publish, remove, reviews, publishes, timeline, decorate, latestReviewOf, STATUS_LIST };
