<template>
  <div class="page ssPage">
    <div class="pageHead">
      <button class="back" type="button" @click="back">← 返回</button>
      <span class="mapTitle">📊 学习统计</span>
      <span class="chip gray">专注按节点记 · 切出应用记暂离</span>
      <div class="spacer"></div>
      <button class="btn small" type="button" :disabled="loading" @click="shiftMonth(-1)">‹ 上月</button>
      <button class="btn small" type="button" @click="goToday">本月</button>
      <button class="btn small" type="button" :disabled="loading" @click="shiftMonth(1)">下月 ›</button>
    </div>

    <div class="ssSummary">
      <div class="ssStat"><span class="ssNum">{{ fmtDur(monthData.total_focus) }}</span><span class="ssLbl">本月专注</span></div>
      <div class="ssStat"><span class="ssNum">{{ fmtDur(monthData.total_rest) }}</span><span class="ssLbl">本月休息</span></div>
      <div class="ssStat"><span class="ssNum">{{ fmtDur(monthData.total_away) }}</span><span class="ssLbl">本月暂离</span></div>
      <div class="ssStat"><span class="ssNum">{{ monthData.active_days }}</span><span class="ssLbl">学习天数</span></div>
    </div>

    <div class="ssCal">
      <div class="ssMonthTitle">{{ monthLabel }}</div>
      <div class="ssGrid ssWeek"><div v-for="w in weeks" :key="w">{{ w }}</div></div>
      <div class="ssGrid">
        <template v-for="(c, i) in cells" :key="c.key || ('e' + i)">
          <div v-if="c.empty" class="ssCell empty"></div>
          <button v-else class="ssCell" type="button" :class="cellClass(c)" :disabled="c.future" :title="cellTitle(c)" @click="selectDay(c.key)">
            <span class="ssD">{{ c.day }}</span>
            <span v-if="c.focus || c.rest" class="ssT">
              <template v-if="c.focus">{{ fmtShort(c.focus) }}</template>
              <span v-if="c.focus && c.rest" class="ssRDot">·</span>
              <span v-if="c.rest" class="ssR">休{{ fmtShort(c.rest) }}</span>
            </span>
          </button>
        </template>
      </div>
    </div>

    <div class="ssDetail">
      <div v-if="error" class="ssEmpty"><div class="ebText">{{ error }}</div></div>
      <div class="ssDayHero">
        <div class="ssDayTop"><span class="ssDayDate">📅 {{ dayLabel }}</span><span v-if="live" class="ssLive">● 直播</span></div>
        <div class="ssDayTotal"><b>{{ fmtDur(dayData.totals.focus) }}</b><span>专注</span></div>
        <div class="ssDayPills">
          <span class="ssPill">☕ 休息 <b>{{ fmtDur(dayData.totals.rest) }}</b></span>
          <span class="ssPill">📵 暂离 <b>{{ fmtDur(dayData.totals.away) }}</b></span>
        </div>
      </div>

      <template v-if="timeline.length">
        <div class="ssSecTitle">⏱ 当天时间线</div>
        <div class="ssAxView">
          <span>排列：</span>
          <button class="ssViewBtn" :class="{ active: axesView === 'cols2' }" type="button" @click="setAxesView('cols2')">左右两列</button>
          <button class="ssViewBtn" :class="{ active: axesView === 'cols1' }" type="button" @click="setAxesView('cols1')">上下单列</button>
        </div>
        <div class="ssTl">
          <div class="ssDayAxes" :class="axesView">
            <div class="ssCol" v-for="(col, ci) in axisCols" :key="ci">
              <div class="ssAxis" v-for="i in col" :key="i">
                <div class="ssAxisHead">
                  <span>{{ axisRows[i].label }}</span>
                  <span class="ssAxisTot">
                    <span v-if="axisRows[i].focus > 0" class="ssAxF">{{ fmtShort(axisRows[i].focus) }}</span>
                    <span v-if="axisRows[i].focus > 0 && (axisRows[i].rest > 0 || axisRows[i].away > 0)" class="ssAxSep">·</span>
                    <span v-if="axisRows[i].rest > 0" class="ssAxR">休{{ fmtShort(axisRows[i].rest) }}</span>
                    <span v-if="axisRows[i].rest > 0 && axisRows[i].away > 0" class="ssAxSep">·</span>
                    <span v-if="axisRows[i].away > 0" class="ssAxA">离{{ fmtShort(axisRows[i].away) }}</span>
                  </span>
                </div>
                <div class="ssAxisTrack">
                  <div class="ssAxisGrid">
                    <span v-for="h in 5" :key="h" class="ssTick" :style="{ left: ((h - 1) * 25) + '%' }"><i>{{ pad(axisRows[i].startHour + h - 1) }}</i></span>
                  </div>
                  <div class="ssAxisSegs">
                    <span v-for="seg in axisRows[i].segs" :key="seg.id" class="ssSegB" :class="'k-' + seg.kind" :style="{ left: seg.left + '%', width: seg.width + '%' }" :title="seg.title"></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div class="ssLegend">
            <span v-for="k in legend" :key="k.id" class="ssLg" :class="{ off: !kindFilter[k.id] }" @click="toggleKind(k.id)">
              <i class="ssLgDot" :class="'k-' + k.id"></i>{{ k.label }}
            </span>
            <span class="muted">悬停看详情</span>
          </div>
        </div>
      </template>

      <template v-if="records.length">
        <div class="ssSecTitle">📖 按节点</div>
        <div class="ssRow" v-for="r in records" :key="r.node_id">
          <div class="ssRowTop">
            <span class="ssNode">{{ r.node_title }}<span v-if="r.node_gone" class="chip gray">节点已删</span></span>
            <span class="ssDur">{{ fmtDur(r.focus_sec) }}</span>
          </div>
          <div v-if="r.goal_title" class="ssRowSub"><a :href="'#/g/' + r.goal_id">{{ r.goal_title }}</a></div>
          <div class="ssBar"><div class="ssFill" :style="{ width: barWidth(r.focus_sec) + '%' }"></div></div>
        </div>
      </template>

      <div v-if="!timeline.length && !records.length" class="ssEmpty">
        <div class="ebText">这天还没记录。开着番茄钟、打开一篇教程专注，时间会自动记到对应节点上；切出应用的时间会记为暂离。</div>
      </div>
      <div class="ssFoot muted">暂离指本页面不可见的时段（切标签页/最小化/刷视频等），网页拿不到其它标签页地址，只能记到这个粒度。</div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const weeks = ['一', '二', '三', '四', '五', '六', '日'];
const legend = [
  { id: 'focus', label: '专注' },
  { id: 'rest', label: '休息' },
  { id: 'away', label: '暂离' }
];
const AXES = [[0, 4], [4, 8], [8, 12], [12, 16], [16, 20], [20, 24]];
const axisCols = [[0, 1, 2], [3, 4, 5]];
const kindFilter = ref(loadKindFilter());
const axesView = ref(loadAxesView());
const curMonth = ref(localDay(new Date()).slice(0, 7));
const selDay = ref(localDay(new Date()));
const monthData = ref({ days: {}, total_focus: 0, total_rest: 0, total_away: 0, active_days: 0 });
const dayData = ref({ totals: { focus: 0, rest: 0, away: 0 }, records: [], timeline: [] });
const loading = ref(false);
const error = ref('');
const live = ref(false);
let timer = null;

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(d) { const t = d || new Date(); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); }
function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  if (!h) return m + '分';
  return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}
function fmtShort(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}
function weekday(ds) {
  try { const [y, m, d] = ds.split('-').map(Number); return '周' + ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]; } catch (e) { return ''; }
}
function loadKindFilter() {
  try {
    const o = JSON.parse(localStorage.getItem('sierxing-stats-kinds') || 'null');
    if (o && typeof o === 'object') return { focus: o.focus !== false, rest: o.rest !== false, away: o.away !== false };
  } catch (e) {}
  return { focus: true, rest: true, away: true };
}
function saveKindFilter() { try { localStorage.setItem('sierxing-stats-kinds', JSON.stringify(kindFilter.value)); } catch (e) {} }
function loadAxesView() { try { return localStorage.getItem('sierxing-stats-axes') || 'cols2'; } catch (e) { return 'cols2'; } }
function setAxesView(v) { axesView.value = v; try { localStorage.setItem('sierxing-stats-axes', v); } catch (e) {} }
function toggleKind(id) {
  const next = Object.assign({}, kindFilter.value);
  next[id] = !next[id];
  if (!next.focus && !next.rest && !next.away) { next.focus = next.rest = next.away = true; }
  kindFilter.value = next;
  saveKindFilter();
}

const monthLabel = computed(function () { const [y, m] = curMonth.value.split('-').map(Number); return y + ' 年 ' + m + ' 月'; });
const dayLabel = computed(function () { const [y, m, d] = selDay.value.split('-').map(Number); return m + '月' + d + '日 · ' + weekday(selDay.value); });
const todayStr = computed(function () { return localDay(new Date()); });
const cells = computed(function () {
  const [y, m] = curMonth.value.split('-').map(Number);
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const daysIn = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 0; i < offset; i++) out.push({ empty: true, key: 'empty' + i });
  for (let d = 1; d <= daysIn; d++) {
    const key = curMonth.value + '-' + pad(d);
    const dd = (monthData.value.days || {})[key] || { f: 0, r: 0, a: 0 };
    out.push({ key: key, day: d, focus: dd.f || 0, rest: dd.r || 0, away: dd.a || 0, future: key > todayStr.value, today: key === todayStr.value, selected: key === selDay.value });
  }
  return out;
});
function cellClass(c) {
  return { has: (c.focus || 0) > 0, today: c.today, sel: c.selected, future: c.future };
}
function cellTitle(c) {
  return '专注 ' + fmtDur(c.focus) + ' · 休息 ' + fmtDur(c.rest) + ' · 暂离 ' + fmtDur(c.away);
}
const dayLabelValue = computed(function () { return selDay.value; });
const timeline = computed(function () { return dayData.value.timeline || []; });
const records = computed(function () { return dayData.value.records || []; });
const maxFocus = computed(function () { return Math.max(1, ...records.value.map(function (r) { return r.focus_sec || 0; })); });
function barWidth(sec) { return Math.round((Math.max(0, Number(sec) || 0) / maxFocus.value) * 100); }

function segMin(t) { const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/); if (!m) return NaN; return Number(m[1]) * 60 + Number(m[2]); }
function kindMin(kind) { return kind === 'focus' ? 300 : (kind === 'rest' ? 60 : 120); }
const axisRows = computed(function () {
  return AXES.map(function (a) {
    const s0 = a[0] * 60, s1 = a[1] * 60;
    let focus = 0, rest = 0, away = 0;
    const segs = [];
    for (const s of timeline.value) {
      if (!kindFilter.value[s.kind]) continue;
      if ((s.seconds || 0) < kindMin(s.kind)) continue;
      const st = segMin(s.from), en = segMin(s.to);
      if (isNaN(st) || isNaN(en) || en <= s0 || st >= s1) continue;
      const st2 = Math.max(st, s0);
      const len = Math.max(Math.min(en, s1) - st2, 0);
      const cut = len * 60;
      if (s.kind === 'rest') rest += cut; else if (s.kind === 'away') away += cut; else focus += cut;
      segs.push({
        id: 'seg' + s.id + '-' + a[0],
        kind: s.kind,
        left: (st2 - s0) / 240 * 100,
        width: Math.max(len / 240 * 100, 1.2),
        title: s.from + ' – ' + s.to + ' · ' + fmtDur(s.seconds) + (s.node_title ? ' · ' + s.node_title : '')
      });
    }
    return { startHour: a[0], label: pad(a[0]) + ':00 – ' + pad(a[1]) + ':00', focus: focus, rest: rest, away: away, segs: segs };
  });
});

async function loadMonth() {
  try { monthData.value = await api('/api/study/month?month=' + encodeURIComponent(curMonth.value)); }
  catch (e) { monthData.value = { days: {}, total_focus: 0, total_rest: 0, total_away: 0, active_days: 0 }; }
}
async function loadDay() {
  try { dayData.value = await api('/api/study/day?day=' + encodeURIComponent(selDay.value)); }
  catch (e) { dayData.value = { totals: { focus: 0, rest: 0, away: 0 }, records: [], timeline: [] }; error.value = '当天数据加载失败：' + (e.message || e); }
}
async function refresh() {
  loading.value = true;
  error.value = '';
  await Promise.all([loadMonth(), loadDay()]);
  loading.value = false;
  updateLive();
}
function updateLive() {
  try { const p = window.Pomodoro && window.Pomodoro.state ? window.Pomodoro.state() : null; live.value = !!(p && p.running); } catch (e) { live.value = false; }
}
function selectDay(key) {
  if (key > todayStr.value) return;
  selDay.value = key;
  loadDay();
}
function shiftMonth(d) {
  const [y, m] = curMonth.value.split('-').map(Number);
  const t = new Date(y, m - 1 + d, 1);
  curMonth.value = t.getFullYear() + '-' + pad(t.getMonth() + 1);
  if (selDay.value.slice(0, 7) !== curMonth.value) {
    const today = localDay(new Date());
    selDay.value = today.slice(0, 7) === curMonth.value ? today : curMonth.value + '-01';
  }
  refresh();
}
function goToday() {
  curMonth.value = localDay(new Date()).slice(0, 7);
  selDay.value = localDay(new Date());
  refresh();
}
function back() { location.hash = '#/'; }

onMounted(function () {
  refresh();
  timer = setInterval(function () {
    updateLive();
    if (live.value) refresh();
  }, 30000);
});
onUnmounted(function () { if (timer) clearInterval(timer); });
</script>

<style scoped>
.ssPage { max-width: 1100px; }
.ssTl { margin-top: 8px; }
</style>
