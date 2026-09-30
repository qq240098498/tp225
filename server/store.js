const fs = require('fs');
const path = require('path');
const { AppError } = require('./errors');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULT_SETTINGS = {
  autoPublishMagnitude: 4.0,
  minStationCount: 4,
  rmsLimitSec: 3.0,
  shallowDepthLimitKm: 70,
  reviewToleranceMagnitude: 0.3,
  mergeWindowMinutes: 90,
  mergeDistanceKm: 30,
  residualLimitSec: 2.5,
  depthDefaultKm: 10,
};

function normalize(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  for (const key of ['stations', 'events', 'arrivals', 'reviews', 'publishes', 'corrections']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  // 旧数据的发布记录只快照了震级，补上发布时点的位置字段（用事件当前值兜底，
  // 仅为让老记录在时间线上字段齐全；新发布会在发布当时完整快照）
  for (const pub of data.publishes) {
    if (pub.lat === undefined) {
      const event = data.events.find((e) => e.id === pub.eventId);
      if (event) {
        pub.lat = event.lat;
        pub.lon = event.lon;
        pub.depth = event.depth;
        pub.originTime = event.originTime;
        pub.regionName = event.regionName || '';
        pub.magnitudeType = event.magnitudeType || 'ML';
      }
    }
  }
  return data;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(dataFile, 'utf8');
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件读不出来，请检查 data/db.json 是否还在');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AppError(500, 'DATA_UNREADABLE', '数据文件解析失败，请检查 data/db.json 的内容');
  }
  return normalize(raw);
}

function save(data) {
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(prefix, list) {
  let max = 0;
  for (const item of list || []) {
    const matched = String(item.id || '').match(/(\d+)$/);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return prefix + '-' + String(max + 1).padStart(4, '0');
}

function round(n, digits) {
  const d = digits == null ? 3 : digits;
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(v.toFixed(d));
}

function todayIso() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function nowText() {
  const now = new Date();
  return todayIso() + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
}

module.exports = { load, save, nextId, normalize, round, todayIso, nowText, DEFAULT_SETTINGS, dataFile };
