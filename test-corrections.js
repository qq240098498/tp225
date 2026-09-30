const assert = require('assert');
const store = require('./server/store');
const events = require('./server/events');
const corrections = require('./server/corrections');
const summary = require('./server/summary');

const data = store.load();
// 测试在内存里做，不落盘
const cloned = JSON.parse(JSON.stringify(data));

function expectThrow(fn, code, label) {
  try {
    fn();
  } catch (err) {
    assert.strictEqual(err.code, code, label + '：错误码应为 ' + code + '，实际 ' + err.code + ' / ' + err.message);
    console.log('OK  ' + label + '（拦下：' + err.message + '）');
    return err;
  }
  throw new Error(label + '：本应抛 ' + code + ' 却通过了');
}

const eq1 = cloned.events.find((e) => e.id === 'eq-0001');
console.log('起点：eq-0001 状态=' + eq1.status + '，发布记录震级=' + cloned.publishes.find((p) => p.eventId === 'eq-0001').magnitude);

// 1. 已发布事件不能直接 PATCH 位置
expectThrow(() => events.update(cloned, 'eq-0001', { lat: 40.5 }), 'PUBLISHED_EVENT_LOCKED', '已发布事件 PATCH 纬度被拦');
// 不碰口径字段的修改应放行（改备注）
events.update(cloned, 'eq-0001', { remark: '备注可以改' });
console.log('OK  已发布事件改备注放行');

// 2. 已发布事件不能借复核改震级/深度
expectThrow(() => events.addReview(cloned, 'eq-0001', { reviewer: '李工', action: '改震级', afterMagnitude: 4.9 }), 'PUBLISHED_EVENT_LOCKED', '已发布后复核改震级被拦');
events.addReview(cloned, 'eq-0001', { reviewer: '李工', action: '通过', comment: '确认' });
console.log('OK  已发布后登记不改值的复核放行');

// 3. 未发布事件不能更正
expectThrow(() => corrections.registerOne(cloned, 'eq-0004', { corrector: '王工', reason: 'x', magnitude: 3 }), 'VALIDATION_FAILED', '未发布事件更正被拦');

// 4. 缺更正人/依据
expectThrow(() => corrections.registerOne(cloned, 'eq-0001', { reason: 'x', magnitude: 4.5 }), 'VALIDATION_FAILED', '缺更正人被拦');
expectThrow(() => corrections.registerOne(cloned, 'eq-0001', { corrector: '王工', magnitude: 4.5 }), 'VALIDATION_FAILED', '缺依据被拦');
expectThrow(() => corrections.registerOne(cloned, 'eq-0001', { corrector: '王工', reason: 'x' }), 'VALIDATION_FAILED', '没有任何改动被拦');

// 5. 第一次单事件更正：震级 4.2→4.5、深度 12→15
let res = corrections.registerOne(cloned, 'eq-0001', {
  at: '2026-09-01 13:00:00', corrector: '王工', reason: '新增远台震相后重新标定',
  magnitude: 4.5, depth: 15, remark: '电话口径同步',
});
assert.strictEqual(res.affectedEvents.length, 1);
assert.deepStrictEqual(res.affectedEvents[0].changes.map((c) => c.field), ['magnitude', 'depth']);
const after1 = events.find(cloned, 'eq-0001');
assert.strictEqual(after1.officialMagnitude, 4.5, '当前对外震级应立刻变成 4.5');
assert.strictEqual(after1.depth, 15);
const pub1 = cloned.publishes.find((p) => p.eventId === 'eq-0001');
assert.strictEqual(pub1.magnitude, 4.2, '历史发布记录震级必须保持 4.2');
// 旧记录（功能上线前落的）没有位置快照字段，不强制；震级字段一直在，必须未动
let dec = events.decorate(cloned, after1);
assert.strictEqual(dec.magnitude, 4.5, 'decorate 对外震级 4.5');
assert.strictEqual(dec.correctionCount, 1);
console.log('OK  第一次更正：当前震级 4.2→4.5、深度 12→15，发布快照未动（仍 4.2 / 12）');

// 6. 第二次更正：震级 4.5→4.3，位置微调
res = corrections.registerOne(cloned, 'eq-0001', {
  at: '2026-09-01 14:00:00', corrector: '王工', reason: '二次定位', magnitude: 4.3, lat: 40.02, lon: 116.48,
});
const history = corrections.forEvent(cloned, 'eq-0001');
assert.strictEqual(history.length, 2);
assert.strictEqual(history[0].seq, 1);
assert.strictEqual(history[0].changes[0].before, 4.2);
assert.strictEqual(history[1].seq, 2);
assert.strictEqual(history[1].changes.find((c) => c.field === 'magnitude').before, 4.5);
assert.strictEqual(events.find(cloned, 'eq-0001').lat, 40.02);
console.log('OK  第二次更正：震级 4.5→4.3、位置更新；事件级历史能看出第1次(4.2→4.5)、第2次(4.5→4.3)');

// 详情应带发布+更正
const detail = events.detail(cloned, 'eq-0001');
assert.strictEqual(detail.publishes.length, 1);
assert.strictEqual(detail.corrections.length, 2);
console.log('OK  事件详情：发布 1 条 + 更正 2 条（带序号）');

// 7. 先把 eq-0002（已复核）人工发布，再批量更正两个事件
events.publish(cloned, 'eq-0002', { at: '2026-09-03 10:00:00', operator: '值班台', remark: '人工发布' });
const eq2BeforeMag = corrections.currentMagnitude(cloned, events.find(cloned, 'eq-0002'));
const batch = corrections.registerBatch(cloned, {
  at: '2026-09-03 15:00:00', corrector: '定标组', reason: '同一批台站重新定标后统一调整',
  remark: '统一批次',
  items: [
    { eventId: 'eq-0001', magnitude: 4.35 },
    { eventId: 'eq-0002', magnitude: Number((eq2BeforeMag + 0.2).toFixed(3)), depth: 10 },
  ],
});
assert.strictEqual(batch.correction.eventCount, 2);
assert.strictEqual(batch.affectedEvents.length, 2);
assert.strictEqual(batch.affectedEvents[0].eventCode, 'EQ-2026-0001');
assert.ok(batch.affectedEvents[1].changes.some((c) => c.field === 'magnitude'));
console.log('OK  批量更正 2 个事件一次落账，返回受影响清单与逐事件差异');
console.log('    ' + JSON.stringify(batch.affectedEvents.map((i) => ({ event: i.eventCode, changes: i.changes.map((c) => c.fieldName + ' ' + c.before + '→' + c.after) }))));

// 8. 批量整批失败：重复事件 / 无改动 / 未发布 / 不存在，且不能有任何东西落账或生效
const corrBefore = cloned.corrections.length;
const magBefore = events.find(cloned, 'eq-0001').officialMagnitude;
expectThrow(() => corrections.registerBatch(cloned, {
  corrector: '定标组', reason: '坏批次',
  items: [
    { eventId: 'eq-0001', magnitude: 4.6 },
    { eventId: 'eq-0001', magnitude: 4.7 },
  ],
}), 'VALIDATION_FAILED', '批量里同事件出现两次整批拒绝');
expectThrow(() => corrections.registerBatch(cloned, {
  corrector: '定标组', reason: '坏批次',
  items: [{ eventId: 'eq-0001', magnitude: 999 }],
}), 'VALIDATION_FAILED', '震级非法整批拒绝');
expectThrow(() => corrections.registerBatch(cloned, {
  corrector: '定标组', reason: '坏批次',
  items: [
    { eventId: 'eq-0001', magnitude: 4.6 },
    { eventId: 'eq-0004', magnitude: 3.0 },
  ],
}), 'VALIDATION_FAILED', '混入未发布事件整批拒绝');
expectThrow(() => corrections.registerBatch(cloned, {
  corrector: '定标组', reason: '坏批次',
  items: [{ eventId: 'eq-0001', magnitude: magBefore }],
}), 'VALIDATION_FAILED', '传了但没有实际改动整批拒绝');
assert.strictEqual(cloned.corrections.length, corrBefore, '失败批次不能落账');
assert.strictEqual(events.find(cloned, 'eq-0001').officialMagnitude, magBefore, '失败批次不能改当前值');
console.log('OK  整批校验失败时：不落账、不改任何事件当前值');

// 9. 台账查询与计数
const listAll = corrections.list(cloned, {});
assert.strictEqual(listAll.length, 3, '应有 3 个批次：2 次单个 + 1 次批量');
assert.strictEqual(listAll[0].id, cloned.corrections[cloned.corrections.length - 1].id, '台账按时刻倒序');
const onlyEq2 = corrections.list(cloned, { eventId: 'eq-0002' });
assert.ok(onlyEq2.every((r) => r.items.some((i) => i.eventId === 'eq-0002')));
assert.strictEqual(corrections.countForEvent(cloned, 'eq-0001'), 3, 'eq-0001 更正 3 次（2单个+1批量）');
assert.strictEqual(corrections.countForEvent(cloned, 'eq-0002'), 1);
console.log('OK  更正台账查询与事件计数正确');

// 10. 概览
const ov = summary.overview(cloned);
assert.strictEqual(ov.correctionCount, 3, '批次总数');
assert.strictEqual(ov.correctedEventCount, 2, '涉及事件 2 个');
console.log('OK  概览：更正批次 ' + ov.correctionCount + '、涉及事件 ' + ov.correctedEventCount);

// 11. 发布后台站测算变化不应改变对外口径
const dec2 = events.decorate(cloned, events.find(cloned, 'eq-0001'));
assert.strictEqual(dec2.magnitude, 4.35, '对外震级=最新更正值');
assert.ok(dec2.measuredMagnitude !== undefined, '测算值仍保留');
console.log('OK  对外口径 ' + dec2.magnitude + ' 与台站测算 ' + dec2.measuredMagnitude + ' 分开');

console.log('\n全部断言通过 ✔');
