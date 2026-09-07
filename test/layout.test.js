/* paint() 布局算法单元测试：node test/layout.test.js
 * 1) 合成小数据：手工演算泳道结果逐项断言（分叉/汇合/复用空道）。
 * 2) 纯直线：单泳道。
 * 3) 真实任务 fixture（session 父子链）：不变量断言（全部任务有 lane、父必在子后）。 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { paint } = require("../overlay.js");

/* ---- 用例 1：合成数据（手工演算的期望泳道） ---- */
{
  const items = [
    { h: "c8", p: ["c6", "c5"] },
    { h: "c7", p: ["c6"] },
    { h: "c5", p: ["c3"] },
    { h: "c4", p: ["c3"] },
    { h: "c6", p: ["c3"] },
    { h: "c3", p: ["c2"] },
    { h: "c2", p: ["c1"] },
    { h: "c1", p: [] },
  ];
  const { laneOf, nLanes } = paint(items);
  assert.strictEqual(laneOf.c8, 0, "c8 在泳道 0");
  assert.strictEqual(laneOf.c7, 2, "c7 开新泳道 2");
  assert.strictEqual(laneOf.c5, 1, "c5 在泳道 1");
  assert.strictEqual(laneOf.c4, 3, "c4 开新泳道 3");
  assert.strictEqual(laneOf.c6, 0, "c6 汇合回泳道 0");
  ["c3", "c2", "c1"].forEach((h) => assert.strictEqual(laneOf[h], 0, h + " 应在泳道 0"));
  assert.ok(nLanes >= 4, "至少 4 条泳道，实际 " + nLanes);
  console.log("用例 1（合成数据：分叉/汇合/道复用）通过，泳道数 =", nLanes);
}

/* ---- 用例 2：纯直线 ---- */
{
  const items = [
    { h: "b", p: ["a"] },
    { h: "a", p: [] },
  ];
  const { laneOf, nLanes } = paint(items);
  assert.strictEqual(laneOf.a, 0);
  assert.strictEqual(laneOf.b, 0);
  assert.strictEqual(nLanes, 1, "无分叉应只有 1 条泳道");
  console.log("用例 2（直线：单泳道）通过");
}

/* ---- 用例 3：真实任务 fixture（parent_id 父子链）不变量 ---- */
{
  const f = path.join(__dirname, "..", "demo", "fixture.json");
  if (!fs.existsSync(f)) {
    console.log("用例 3 跳过：无 demo/fixture.json（先跑 python tools/gen_fixture.py）");
  } else {
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    const items = data.sessions.map((s) => ({ h: s.id, p: s.pid ? [s.pid] : [] }));
    const { laneOf, nLanes } = paint(items);
    const seen = new Set(items.map((it) => it.h));
    for (const it of items) {
      assert.ok(Number.isInteger(it.lane) && it.lane >= 0 && it.lane < nLanes, `lane 越界: ${it.h}`);
      assert.strictEqual(laneOf[it.h], it.lane, "laneOf 与 it.lane 不一致");
      for (const ph of it.p) {
        if (seen.has(ph)) {
          const t = items.find((x) => x.h === ph);
          assert.ok(t.idx > it.idx, `父 ${ph} 必须排在子之后（按 time_created 降序）`);
        }
      }
    }
    console.log(`用例 3（fixture：${items.length} 任务 / ${nLanes} 泳道）不变量全部通过`);
  }
}

console.log("全部测试通过 ✔");
