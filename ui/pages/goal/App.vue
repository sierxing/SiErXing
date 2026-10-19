<template>
  <div class="page">
    <div class="pageHead">
      <button class="back" type="button" @click="home">← 返回</button>
      <h2 class="title" style="margin-left:8px;">🎯 {{ goal.title }}</h2>
      <span class="chip" :class="statusClass">{{ statusText }}</span>
      <div class="spacer"></div>
    </div>
    <div class="goalBar favBar">
      <template v-for="it in visibleItems" :key="it.id">
        <a v-if="it.href" class="btn small" :class="it.cls" :href="it.href" :title="it.title || it.label" :draggable="true" :data-fav-id="it.id" @dragstart="favDragStart(it)" @dragover.prevent @drop.prevent="favDrop(it)">{{ it.label }}</a>
        <button v-else class="btn small" :class="it.cls" type="button" :title="it.title || it.label" :draggable="true" :data-fav-id="it.id" @dragstart="favDragStart(it)" @dragover.prevent @drop.prevent="favDrop(it)" @click="it.fn && it.fn()">{{ it.label }}</button>
        <button v-if="favEdit" class="favPin" type="button" title="从收藏栏隐藏这个按钮" @click.stop="favHide(it.id)">✕</button>
      </template>
      <button class="btn small favMore" type="button" @click="favMenu = !favMenu" :title="favEdit ? '完成编辑' : '收藏栏设置 / 显示隐藏按钮'">⋯</button>
      <div v-if="favMenu" class="favMenu" @click.stop>
        <div class="favMenuHead"><b>收藏栏</b><span class="spacer"></span><button class="btn tiny" type="button" @click="favEdit = !favEdit">{{ favEdit ? '完成' : '编辑' }}</button></div>
        <div v-if="hoverItems.length" class="favMenuSec">已隐藏（点「显示」放回收藏栏）<div v-for="it in hoverItems" :key="it.id" class="favMenuItem"><span class="favMenuLabel">{{ it.label }}</span><button class="btn tiny" type="button" @click="favShow(it.id)">显示</button></div></div>
        <div v-else class="muted" style="padding:4px 2px;font-size:12px;">没有隐藏的按钮</div>
        <div class="favMenuSec"><button class="btn tiny" type="button" @click="favAll(true)">全部显示</button><button class="btn tiny" type="button" @click="favReset">恢复默认</button></div>
        <p class="hint" style="margin:6px 0 0;font-size:11.5px;">拖动按钮可排序；设置只保存在本机。</p>
      </div>
    </div>
    <p class="hint" style="margin:-4px 0 12px;">目标概览：规划思路、进度、任务、阶段与教程资料。任务可勾选、目标可编辑，规划 / 拆分 / 教程 / 对话都在本页与对话页完成。</p>


    <div v-if="tutGen.busy" class="genBanner"><span class="spinner"></span><div><b>正在生成学习教程…</b><div class="muted">{{ tutGen.status }}</div></div></div>
    <div v-if="split.busy" class="genBanner"><span class="spinner"></span><div><b>正在深度拆分…</b><div class="muted">{{ split.status }}</div></div></div>
    <div v-if="planBusy" class="genBanner"><span class="spinner"></span><div><b>正在细化任务…</b><div class="muted">{{ planStatus }}</div></div></div>
    <div v-if="replan.busy" class="genBanner"><span class="spinner"></span><div><b>{{ replan.step === 'clarify' ? '正在生成骨架…' : '正在生成澄清问卷…' }}</b><div class="muted">{{ replan.status }}</div></div></div>

    <!-- 目标头（原版 goalHead，可折叠） -->
    <div class="goalHead">
      <div class="ghTop">
        <h2 class="ghTitle">{{ goal.title }}</h2>
        <span class="chip" :class="statusClass">{{ statusText }}</span>
        <button class="btn tiny cardFold" type="button" @click="toggleFold('head', true)">{{ isFoldClosed('head', true) ? '▸' : '▾' }}</button>
      </div>
      <div v-show="!isFoldClosed('head', true)">
        <div v-if="goal.summary" class="ghSummary">规划思路：{{ goal.summary }}</div>
        <div class="ghMeta">
          <div v-if="goal.profile" class="ghItem"><span class="ghLabel">现状</span>{{ goal.profile }}</div>
          <span v-if="goal.weekly_hours" class="chip gray">每周 {{ goal.weekly_hours }}</span>
          <span v-if="goal.deadline" class="chip gray">期限 {{ goal.deadline }}</span>
          <span class="chip gray">任务完成 {{ goal.tasks_done || 0 }}/{{ goal.tasks_total || 0 }}</span>
        </div>
        <div class="bar big"><div class="barFill" :style="{ width: pct + '%' }"></div></div>
        <div v-if="goal.error" class="goalError">⚠ {{ goal.error }}</div>
      </div>
    </div>

    <!-- 继续学习（原版 continueCard） -->
    <a v-if="lastTut" class="continueCard" :href="'#/t/' + lastTut.id" style="text-decoration:none;color:inherit;">
      <span class="ccIcon">📘</span>
      <div class="ccMain">
        <div class="ccLabel">继续学习 · 第 {{ lastAt }}/{{ lastTotal }} 节 · {{ lastPct }}%</div>
        <div class="ccTitle">{{ lastTut.title }}</div>
      </div>
      <span class="btn small primary">继续阅读 →</span>
    </a>

    <!-- 骨架待确认（原版 reportCard） -->
    <div v-if="goal.status === 'review'" class="reportCard">
      <div class="rcHead">
        <span>🧭</span><span>骨架待确认</span>
        <div class="spacer"></div>
        <span class="chip warn">review</span>
      </div>
      <div class="rcText">AI 已生成 <b>{{ stages.length }} 个阶段</b>，确认后才会逐阶段细化任务；有意见可以先写下来让 AI 调整骨架。</div>
      <div v-if="planAsk.length" class="qaRounds" style="margin-top:10px;">
        <div class="qaRound">
          <div class="qaRoundHead">AI 想先确认几个问题</div>
          <div v-for="q in planAsk" :key="q.id" class="qaItem">
            <div class="qaQ">{{ q.title }}</div>
            <div v-if="q.options && q.options.length" class="splitOpts">
              <label v-for="o in q.options" :key="o.v" class="splitOpt">
                <input type="radio" :value="o.v" v-model="planAnswers[q.id]">
                <span>{{ o.label }}</span>
              </label>
            </div>
            <input v-else v-model="planAnswers[q.id]" placeholder="你的回答">
          </div>
        </div>
      </div>
      <textarea v-model="planFeedback" rows="2" :disabled="planBusy" placeholder="对骨架的意见，如 第一阶段太长 / 我已有 XX 基础请跳过" style="width:100%;box-sizing:border-box;margin-top:10px;"></textarea>
      <div class="toolbarRow" style="margin-top:10px;flex-wrap:wrap;">
        <button class="btn primary" type="button" :disabled="planBusy" @click="confirmSkeleton">✓ 确认，开始细化任务</button>
        <button v-if="!planAsk.length" class="btn" type="button" :disabled="planBusy || !planFeedback.trim()" @click="adjustSkeleton">按我的意见调整骨架</button>
        <button v-else class="btn primary" type="button" :disabled="planBusy" @click="submitPlanAsk">提交回答并继续</button>
      </div>
    </div>

    <!-- 规划问卷（原版 reportCard） -->
    <div v-if="qaHistory.length" class="reportCard">
      <div class="rcHead">
        <span>📋</span><span>规划问卷（{{ qaHistory.length }} 轮 / {{ qaQuestionCount }} 题）</span>
        <div class="spacer"></div>
        <button class="btn tiny" type="button" @click="openReplan('replan')">继续 / 重新规划 →</button>
      </div>
      <div v-if="planStatusWarn" class="qaWarn">⚠ 当前状态：{{ planStatusWarn }}</div>
      <div class="qaRounds" style="margin-top:8px;">
        <div v-for="(round, ri) in qaHistory.slice(-3)" :key="ri" class="qaRound">
          <div class="qaRoundHead">第 {{ ri + 1 }} 轮 · {{ round.stage || '规划' }} · {{ (round.questions || []).length }} 题</div>
          <div v-for="q in (round.questions || []).slice(0, 6)" :key="q.id" class="qaItem">
            <div class="qaQ">{{ q.title }}</div>
            <div class="qaA">
              <span v-if="round.answers && round.answers[q.id] != null">答：{{ answerText(q, round.answers[q.id]) }}</span>
              <span v-else class="muted">未回答</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态（原版 emptyBox） -->
    <div v-if="!nodes.length" class="emptyBox" style="margin-top:8px;">
      <div class="ebIcon">🧭</div>
      <div class="ebTitle">还没有路径</div>
      <div class="ebText">点「开始 AI 规划」：AI 会先问你几个问题，再生成 阶段 → 小目标 → 任务 的路径。</div>
      <button class="btn primary" type="button" :disabled="replan.busy" @click="openReplan('initial')">开始 AI 规划</button>
    </div>

    <!-- 下一任务（原版 nextCard） -->
    <div v-if="nodes.length && goal.next_task" class="nextCard">
      <span class="ncLabel">下一步</span>
      <div class="ncBody">
        <div class="ncTitle">{{ goal.next_task }}</div>
      </div>
      <div class="ncOps"><a class="btn small primary" :href="'#/g/' + gid + '/map'">看路线图 →</a></div>
    </div>
    <div v-else-if="nodes.length" class="nextCard allDone">
      <span class="ncLabel">全部完成</span>
      <div class="ncBody"><div class="ncTitle">🎉 这条路径的任务已全部完成</div></div>
    </div>

    <!-- 阶段任务树（原版 taskListView，逐级折叠） -->
    <div v-if="stagesTree.length" class="taskListView" style="margin-bottom:14px;">
      <div v-for="(st, si) in stagesTree" :key="st.id" class="tlStage">
        <div class="tlStageHead" :class="st.status">
          <button class="btn tiny cardFold" type="button" @click="toggleFold('tl-s' + st.id, true)">{{ isFoldClosed('tl-s' + st.id, true) ? '▸' : '▾' }}</button>
          <span class="stageIdx">{{ String(si + 1).padStart(2, '0') }}</span>
          <span class="tlStageTitle">{{ st.title }}</span>
          <span class="mtProg">{{ st.done }}/{{ st.total }}</span>
        </div>
        <div v-show="!isFoldClosed('tl-s' + st.id, true)">
          <div v-for="sub in st.children" :key="sub.id" class="tlSub">
            <div class="tlSubHead" :class="sub.status">
              <button class="btn tiny cardFold" type="button" @click="toggleFold('tl-g' + sub.id, true)">{{ isFoldClosed('tl-g' + sub.id, true) ? '▸' : '▾' }}</button>
              <span class="tlSubTitle">{{ sub.title }}</span>
              <span class="mtProg">{{ sub.done }}/{{ sub.total }}</span>
            </div>
            <div v-show="!isFoldClosed('tl-g' + sub.id, true)">
              <label v-for="task in sub.tasks" :key="task.id" class="tlTask" :class="task.status">
                <input type="checkbox" :checked="task.status === 'done'" @change="toggleTask(task, $event)">
                <span class="tlTaskTitle">{{ task.title }}</span>
                <span v-if="task.hours" class="chip gray">{{ task.hours }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 规划约束（原版 consCard，可折叠） -->
    <div class="consCard">
      <div class="consHead">
        <button class="btn tiny cardFold" type="button" @click="toggleFold('constraints', true)">{{ isFoldClosed('constraints', true) ? '▸' : '▾' }}</button>
        <span>⛓ 规划约束</span>
        <span class="chip gray">{{ constraints.length }}</span>
        <span class="consHint">这些是硬性要求，AI 在规划 / 拆分 / 教程 / 对话中都会严格遵守</span>
        <div class="spacer"></div>
      </div>
      <div v-show="!isFoldClosed('constraints', true)" class="consBody">
        <div v-if="constraints.length" class="consList">
          <div v-for="(c, i) in constraints" :key="i" class="consItem">
            <span class="consText">{{ c.text }}</span>
            <div class="spacer"></div>
            <button class="btn tiny" type="button" @click="editCons(i)">改</button>
            <button class="btn tiny danger" type="button" @click="delCons(i)">×</button>
          </div>
        </div>
        <div v-else class="muted" style="font-size:12.5px;padding:4px 2px;">还没有约束。例如：只能周末学 / 预算 0 元只用免费资源</div>
        <div class="consAdd">
          <input v-model="newCons" placeholder="添加一条约束，例如：不要安排付费课程" @keydown.enter="addCons">
          <button class="btn small primary" type="button" :disabled="consBusy || !newCons.trim()" @click="addCons">添加约束</button>
        </div>
      </div>
    </div>

    <!-- 最近教程（原版 tutCard，可折叠） -->
    <div v-if="tutorials.length" class="reportCard tutCard">
      <div class="rcHead">
        <span>📘</span><span>最近教程（{{ tutorials.length }}）</span>
        <div class="spacer"></div>
        <button class="btn tiny" type="button" @click="toggleFold('tuts', false)">{{ isFoldClosed('tuts', false) ? '▸' : '▾' }}</button>
      </div>
      <div v-show="!isFoldClosed('tuts', false)" style="margin-top:8px;">
        <a v-for="t in tutorials.slice(0, 8)" :key="t.id" class="tutRow" :href="'#/t/' + t.id">
          <span class="chip gray">{{ t.format === 'html' ? 'HTML' : 'MD' }}</span>
          <span class="tutTitle">{{ t.title }}</span>
          <span class="muted">{{ fmt(t.created_at) }}</span>
        </a>
      </div>
    </div>

    <!-- 弹窗们（保留原有逻辑，只做格式统一） -->

    <div v-if="editing" class="modalMask" @click.self="editing = false">
      <div class="modalBox">
        <div class="modalHead"><b>编辑目标信息</b><div class="spacer"></div><button class="btn tiny" type="button" @click="editing = false">×</button></div>
        <label class="efRow">目标标题<input v-model="form.title" maxlength="120"></label>
        <label class="efRow">现状 / 背景<textarea v-model="form.profile" rows="3" maxlength="3000"></textarea></label>
        <label class="efRow">参考资料 / 材料<textarea v-model="form.materials" rows="2" maxlength="5000"></textarea></label>
        <div class="efGrid"><label class="efRow">每周可投入<input v-model="form.weekly_hours" maxlength="50" placeholder="如 10h"></label><label class="efRow">期限<input v-model="form.deadline" maxlength="50" placeholder="如 1个月"></label></div>
        <p class="hint" style="margin:6px 0 0;">保存后不会自动重规划；需要让新信息生效，请用工具条的「🧭 重新规划」。</p>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="saving" @click="saveEdit">{{ saving ? '保存中…' : '保存' }}</button><button class="btn" type="button" @click="editing = false">取消</button></div>
      </div>
    </div>

    <div v-if="shareOpen" class="modalMask" @click.self="shareOpen = false">
      <div class="modalBox">
        <div class="modalHead"><b>🔗 分享这份规划与资料库</b><div class="spacer"></div><button class="btn tiny" type="button" @click="shareOpen = false">×</button></div>
        <p class="hint" style="margin:2px 0 10px;">选择要分享的内容（取消勾选即可排除）；对方在首页点「⬆ 导入分享」即可完整还原。</p>
        <div class="shareMods"><label v-for="m in shareModules" :key="m.k" class="shareMod"><input v-model="shareMods[m.k]" type="checkbox"><span><b>{{ m.label }}</b><span v-if="m.privacy" class="chip warn" style="font-size:10px;margin-left:4px;">含隐私</span><br><span class="muted">{{ m.note }}</span></span></label></div>
        <label class="shareMod" style="margin-top:4px;"><input v-model="shareRedact" type="checkbox"><span><b>隐去个人隐私（推荐）</b><br><span class="muted">把学校 / 单位 / 年级 / 姓名 / 手机号 / 邮箱 / 证件号替换成「已隐去」</span></span></label>
        <div class="toolbarRow" style="margin-top:12px;flex-wrap:wrap;"><button class="btn primary" type="button" @click="doShare">导出分享文件</button><button class="btn tiny" type="button" @click="shareAll(true)">全选</button><button class="btn tiny" type="button" @click="shareAll(false)">全不选</button><button class="btn" type="button" @click="shareOpen = false">取消</button></div>
        <p class="hint" style="margin:8px 0 0;">分享文件包含勾选的模块；不会上传到任何服务器。</p>
      </div>
    </div>

    <div v-if="replan.open" class="modalMask" @click.self="closeReplan">
      <div class="modalBox">
        <div class="modalHead"><b>{{ replan.mode === 'initial' ? '🧭 开始 AI 规划' : '🧭 重新规划' }}</b><div class="spacer"></div><button class="btn tiny" type="button" @click="closeReplan">×</button></div>
        <div v-if="replan.step === 'start'">
          <p class="hint" style="margin:2px 0 10px;">AI 会先问几个澄清问题，再生成路径骨架（阶段 / 小目标），最后仍需你确认才会细化任务。</p>
          <div v-if="replan.mode !== 'initial'" class="replanWarn">⚠️ 生成新骨架会<b>替换当前全部阶段与小目标</b>（已细化的任务会被新骨架替代）。教程、资料、对话会保留；系统会先存版本快照，可到「版本管理」回看。</div>
        </div>
        <div v-else>
          <p class="hint" style="margin:2px 0 10px;">{{ replan.questions.length }} 个澄清问题：回答后生成新骨架（生成后仍需确认才会细化任务）。</p>
          <div class="qaRounds"><div class="qaRound"><div v-for="q in replan.questions" :key="q.id" class="qaItem"><div class="qaQ">{{ q.title }}<span v-if="q.desc" class="muted"> · {{ q.desc }}</span></div><div v-if="q.options && q.options.length" class="splitOpts"><label v-for="o in q.options" :key="o.v" class="splitOpt"><input type="radio" :name="'rq-' + q.id" :value="o.v" v-model="replan.answers[q.id]"><span>{{ o.label }}</span></label></div><input v-else v-model="replan.answers[q.id]" placeholder="你的回答"></div></div></div>
        </div>
        <div class="toolbarRow" style="margin-top:12px;flex-wrap:wrap;">
          <button v-if="replan.step === 'start'" class="btn primary" type="button" :disabled="replan.busy" @click="startClarify">{{ replan.mode === 'initial' ? '开始规划（先澄清问题）' : '开始澄清问卷' }}</button>
          <button v-else class="btn primary" type="button" :disabled="replan.busy" @click="submitReplan">提交回答并生成骨架</button>
          <button class="btn" type="button" @click="closeReplan">取消</button>
        </div>
      </div>
    </div>

    <div v-if="split.open" class="modalMask" @click.self="closeSplit">
      <div class="modalBox">
        <div class="modalHead"><b>✨ 深度拆分</b><div class="spacer"></div><button class="btn tiny" type="button" @click="closeSplit">×</button></div>
        <p class="hint" style="margin:2px 0 12px;">让 AI 把选中的阶段/小目标/任务拆成更细的子任务（每阶段 ≤10 个）。可先写调整意见；AI 若觉得信息不够，会先反问几个问题。</p>
        <label class="efRow">拆哪个节点<select v-model.number="split.nodeId" class="sxi-sel" :disabled="split.busy"><option v-for="t in splitCandidates" :key="t.id" :value="t.id">{{ '　'.repeat(t.depth || 0) }}{{ t.title }}</option></select></label>
        <label class="efRow">拆分要求 / 调整意见<textarea v-model="split.feedback" rows="3" :disabled="split.busy" placeholder="例如：这个阶段拆细一点，每项控制在 0.5h / 按「先理解再实践」拆 / 我已有基础，跳过基础项"></textarea></label>
        <div v-if="split.ask" class="qaRounds" style="margin-top:10px;">
          <div class="qaRound"><div class="qaRoundHead">AI 想先确认几个问题</div><div v-for="q in split.ask" :key="q.id" class="qaItem"><div class="qaQ">{{ q.title }}<span v-if="q.desc" class="muted"> · {{ q.desc }}</span></div><div v-if="q.options && q.options.length" class="splitOpts"><label v-for="o in q.options" :key="o.v" class="splitOpt"><input type="radio" :name="'sq-' + q.id" :value="o.v" v-model="splitAnswers[q.id]"><span>{{ o.label }}</span></label></div><input v-else v-model="splitAnswers[q.id]" placeholder="你的回答"></div></div>
        </div>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="split.busy || !split.nodeId || !split.feedback.trim()" @click="startSplit">{{ split.ask ? '提交回答并继续拆分' : '开始拆分' }}</button><button class="btn" type="button" @click="closeSplit">取消</button></div>
      </div>
    </div>

    <div v-if="tutGen.open" class="modalMask" @click.self="closeTutGen">
      <div class="modalBox">
        <div class="modalHead"><b>📘 生成学习教程</b><div class="spacer"></div><button class="btn tiny" type="button" @click="closeTutGen">×</button></div>
        <p class="hint" style="margin:2px 0 12px;">教程以“真正掌握知识点”为目标：讲原理 → 分步实践（含自检与排错）→ 练习 → 掌握自测清单。纯文字讲不清的地方 AI 会自己嵌可视化演示。约 1–3 分钟。</p>
        <label class="efRow">给哪个任务生成<select v-model.number="tutGen.nodeId" class="sxi-sel"><option v-for="t in allLeafTasks" :key="t.id" :value="t.id">{{ t.status === 'done' ? '✓ ' : '' }}{{ t.title }}</option></select></label>
        <label class="efRow">补充要求（可选）<textarea v-model="tutGen.note" rows="3" placeholder="例如：我完全零基础请讲慢一点 / 多给可复制的代码 / 侧重面试常问点"></textarea></label>
        <label class="tutGenRow"><input v-model="tutGen.withFolders" type="checkbox"><span>附带本节点挂载的文件夹源码一起讲（若有）</span></label>
        <div class="toolbarRow" style="margin-top:12px;"><button class="btn primary" type="button" :disabled="!tutGen.nodeId || tutGen.busy" @click="startTutGen">开始生成</button><button class="btn" type="button" @click="closeTutGen">取消</button></div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
const props = defineProps({ host: { type: Object, default: () => ({}) } });
const api = props.host.api;
const toast = (m) => { try { props.host.toast ? props.host.toast(m) : console.log(m); } catch (e) {} };
const gid = props.host.gid;
const goal = ref({});
const nodes = ref([]);
const tutorials = ref([]);
const sourceCount = ref(0);
const lastTut = ref(null);
function fmt(v) { try { return props.host.fmtDate ? props.host.fmtDate(v) : String(v || '').slice(0, 10); } catch (e) { return String(v || '').slice(0, 10); } }
const pct = computed(() => goal.value.tasks_total ? Math.round((goal.value.tasks_done || 0) / goal.value.tasks_total * 100) : 0);
const statusMap = { draft: ['待规划', 'warn'], review: ['骨架待确认', 'warn'], planned: ['已规划', 'ok'], failed: ['规划失败', 'danger'], planning: ['规划中', 'warn'] };
const statusText = computed(() => (statusMap[goal.value.status] || ['未知', 'gray'])[0]);
const statusClass = computed(() => (statusMap[goal.value.status] || ['', 'gray'])[1]);
const qaHistory = computed(() => { try { const raw = goal.value.qa; if (Array.isArray(raw)) return raw; const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } });
const qaQuestionCount = computed(() => qaHistory.value.reduce((n, r) => n + ((r && r.questions && r.questions.length) || 0), 0));
const planStatusWarn = computed(() => goal.value.status === 'review' ? '骨架待确认' : (goal.value.status === 'failed' ? '上次规划失败' : ''));
function answerText(q, val) { const opts = (q && q.options) || []; const hit = opts.find(o => String(o.v) === String(val)); return hit ? hit.label : String(val); }
const constraints = computed(() => { try { const c = goal.value.constraints; const a = Array.isArray(c) ? c : JSON.parse(c || '[]'); return a.filter(x => x && x.text); } catch (e) { return []; } });
/* ---- 折叠状态：与原版一致，按目标记在 localStorage（sierxing-goal-folds-<gid>） ---- */
const folds = ref({});
function loadFolds() {
  try { folds.value = JSON.parse(localStorage.getItem('sierxing-goal-folds-' + gid) || '{}') || {}; } catch (e) { folds.value = {}; }
}
function saveFolds() { try { localStorage.setItem('sierxing-goal-folds-' + gid, JSON.stringify(folds.value || {})); } catch (e) {} }
function isFoldClosed(key, defaultOpen) { const v = folds.value[key]; return v == null ? !defaultOpen : !!v; }
function toggleFold(key, defaultOpen) { folds.value = Object.assign({}, folds.value, { [key]: !isFoldClosed(key, defaultOpen) }); saveFolds(); }

/* ---- 阶段任务树（原版 taskListView 结构：阶段 → 小目标 → 任务） ---- */
const stagesTree = computed(() => {
  const byParent = {};
  nodes.value.forEach(n => { const p = n.parent_id == null ? 0 : Number(n.parent_id); (byParent[p] = byParent[p] || []).push(n); });
  Object.keys(byParent).forEach(k => byParent[k].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id));
  const kids = id => byParent[id] || [];
  const progress = n => { const leaves = []; const walk = x => { const c = kids(x.id); if (c.length) c.forEach(walk); else leaves.push(x); }; walk(n); return { done: leaves.filter(x => x.status === 'done').length, total: leaves.length }; };
  return kids(0).map(st => {
    const subs = kids(st.id).map(sub => {
      const tasks = kids(sub.id).map(t => ({ id: t.id, title: t.title, status: t.status, hours: t.hours, raw: t }));
      const p = progress(sub);
      return { id: sub.id, title: sub.title, status: sub.status, tasks, done: p.done, total: p.total };
    });
    const p = progress(st);
    return { id: st.id, title: st.title, status: st.status, children: subs, done: p.done, total: p.total };
  });
});
const stages = computed(() => {
  const roots = nodes.value.filter(n => n.parent_id == null).sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  return roots.map(r => { const kids = nodes.value.filter(n => Number(n.parent_id) === Number(r.id)); const total = kids.length; const done = kids.filter(n => n.status === 'done').length; return { id: r.id, title: r.title, total, done, pct: total ? Math.round(done / total * 100) : 0 }; });
});
const busyId = ref(0);
const replan = ref({ open: false, busy: false, status: '', step: 'start', questions: [], answers: {}, mode: 'replan' });
function openReplan(mode) { replan.value = { open: true, busy: false, status: '', step: 'start', questions: [], answers: {}, mode: mode === 'initial' ? 'initial' : 'replan' }; }
function closeReplan() { if (replan.value.busy) return; replan.value.open = false; }
async function runReplanSSE(url, body, onQuestions) {
  if (replan.value.busy) return;
  replan.value.busy = true; replan.value.status = '正在连接规划服务…';
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!resp.ok || !resp.body) throw new Error('无法连接规划服务');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let finished = false; let asked = null;
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop(); for (const part of parts) { const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; } if (d.status) replan.value.status = d.status; if (d.goal) planApplyGoal(d); if (d.done) { finished = true; if (d.goal) planApplyGoal(d); } if (d.questions) { finished = true; const data = d.questions; asked = Array.isArray(data) ? data : (data.questions || []); } if (d.error) { finished = true; toast(d.error); } } }
    if (asked && asked.length) onQuestions(asked);
    else if (!finished) toast('规划中断，可重试');
    return { done: finished, questions: asked };
  } catch (e) { toast('规划失败：' + e.message); return { done: false, questions: null }; } finally { replan.value.busy = false; replan.value.status = ''; }
}
async function startClarify() {
  const r = await runReplanSSE('/api/goals/' + gid + '/plan/clarify', {}, (qs) => { replan.value.step = 'clarify'; replan.value.questions = qs; replan.value.answers = {}; });
  if (r && r.done && !r.questions) {
    const qs = (goal.value && goal.value.clarify && Array.isArray(goal.value.clarify.questions)) ? goal.value.clarify.questions : [];
    if (qs.length) { replan.value.step = 'clarify'; replan.value.questions = qs; replan.value.answers = {}; toast('请回答澄清问题'); }
    else { replan.value.open = false; await refreshGoal(); toast('规划状态已更新，请查看规划问卷 / 骨架确认'); }
  }
}
async function submitReplan() {
  const answers = Object.assign({}, replan.value.answers);
  const r = await runReplanSSE('/api/goals/' + gid + '/plan', { answers }, (qs) => { replan.value.step = 'clarify'; replan.value.questions = qs; replan.value.answers = {}; });
  if (r && r.done && !r.questions) { replan.value.open = false; toast(replan.value.mode === 'initial' ? '骨架已生成，请确认或提意见' : '新骨架已生成，请确认或提意见'); }
}
const shareOpen = ref(false);
const shareModules = [
  { k: 'goal', label: '目标信息', note: '标题 / 每周投入 / 期限 / 总结' },
  { k: 'profile', label: '现状与背景', note: '可能含个人隐私（学校 / 专业 / 经历）', privacy: true },
  { k: 'materials', label: '参考资料', note: '目标里粘贴的 JD / 大纲等', privacy: true },
  { k: 'constraints', label: '规划约束', note: '硬性要求（时间 / 预算等）' },
  { k: 'nodes', label: '规划（阶段 / 小目标 / 任务）', note: '完整路线图与完成状态' },
  { k: 'sources', label: '资料库', note: '全部资料（含优质标记与正文）' },
  { k: 'digests', label: '提炼汇总 MD', note: 'AI 通读资料后的主题汇总' }
];
const shareMods = ref(Object.fromEntries(shareModules.map(m => [m.k, true])));
const shareRedact = ref(true);
function shareAll(on) { const next = {}; shareModules.forEach(m => { next[m.k] = !!on; }); shareMods.value = next; }
function doShare() {
  const mods = shareModules.filter(m => shareMods.value[m.k]).map(m => m.k);
  if (!mods.length) return toast('至少勾选一项要分享的内容');
  const a = document.createElement('a');
  a.href = '/api/goals/' + gid + '/share?parts=' + encodeURIComponent(mods.join(',')) + (shareRedact.value ? '' : '&redact=0');
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  shareOpen.value = false;
  toast(shareRedact.value ? '已导出分享文件（隐私已隐去）' : '已导出分享文件（原样，含个人现状）');
}
const planBusy = ref(false);
const planStatus = ref('');
const planFeedback = ref('');
const planAsk = ref([]);
const planAnswers = ref({});
const planMode = ref('tasks');
function planApplyGoal(d) { if (!d || !d.goal) return; goal.value = d.goal; nodes.value = d.goal.nodes || nodes.value; tutorials.value = d.goal.tutorials || tutorials.value; }
async function runPlanSSE(url, body, doneMsg) {
  if (planBusy.value) return;
  planBusy.value = true; planStatus.value = '正在连接规划服务…';
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!resp.ok || !resp.body) throw new Error('无法连接规划服务');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let finished = false; let questions = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop(); for (const part of parts) { const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; } if (d.status) planStatus.value = d.status; if (d.goal) planApplyGoal(d); if (d.questions) { finished = true; const data = d.questions; questions = Array.isArray(data) ? data : (data.questions || []); } if (d.done) { finished = true; planApplyGoal(d); toast(doneMsg || '完成'); } if (d.error) { finished = true; toast(d.error); } } }
    if (questions.length) { planAsk.value = questions; planAnswers.value = {}; toast('AI 想先确认几个问题，回答后继续'); }
    else { planAsk.value = []; if (!finished) toast('规划中断，可重试'); }
  } catch (e) { toast('规划失败：' + e.message); } finally { planBusy.value = false; planStatus.value = ''; }
}
function confirmSkeleton() {
  const fd = String(planFeedback.value || '').trim();
  if (fd && !window.confirm('写下的意见不会随「确认」提交。\n\n要直接开始细化任务吗？如需按意见调整，请点「按我的意见调整骨架」。')) return;
  planMode.value = 'tasks';
  planAsk.value = [];
  runPlanSSE('/api/goals/' + gid + '/plan/tasks', {}, '任务细化完成');
}
function adjustSkeleton() {
  const fd = String(planFeedback.value || '').trim();
  if (!fd) return toast('先写下要调整的意见');
  planMode.value = 'refine';
  planAsk.value = [];
  runPlanSSE('/api/goals/' + gid + '/plan/refine', { feedback: fd }, '骨架已按意见调整，请确认');
}
function submitPlanAsk() {
  if (!planAsk.value.length) return;
  const answers = Object.assign({}, planAnswers.value);
  const url = planMode.value === 'refine' ? '/api/goals/' + gid + '/plan/refine' : '/api/goals/' + gid + '/plan/tasks';
  const body = planMode.value === 'refine' ? { feedback: String(planFeedback.value || '').trim(), answers } : { answers };
  planAsk.value = [];
  runPlanSSE(url, body, planMode.value === 'refine' ? '骨架已按意见调整，请确认' : '任务细化完成');
}
const split = ref({ open: false, busy: false, status: '', nodeId: 0, feedback: '', ask: null });
const splitAnswers = ref({});
const splitCandidates = computed(() => { const out = []; const by = {}; nodes.value.forEach(n => { const p = n.parent_id == null ? 0 : Number(n.parent_id); (by[p] = by[p] || []).push(n); }); Object.keys(by).forEach(k => by[k].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id)); const walk = (pid, depth) => { (by[pid] || []).forEach(n => { out.push({ id: n.id, title: n.title, depth, level: n.level }); walk(n.id, depth + 1); }); }; walk(0, 0); return out; });
function openSplit(preId) { const first = Number(preId) ? (splitCandidates.value.find(n => Number(n.id) === Number(preId)) || {}) : (splitCandidates.value.find(n => !goal.value.nodes.find(x => Number(x.parent_id) === Number(n.id))) || splitCandidates.value[0] || {}); split.value = { open: true, busy: false, status: '', nodeId: first.id || 0, feedback: '', ask: null }; splitAnswers.value = {}; }
function closeSplit() { if (split.value.busy) return; split.value.open = false; }
async function startSplit() {
  if (split.value.busy || !split.value.nodeId) return;
  const feedback = String(split.value.feedback || '').trim();
  if (!feedback) return toast('先写一句拆分要求');
  const answers = split.value.ask ? Object.assign({}, splitAnswers.value) : null;
  split.value.busy = true; split.value.status = '正在连接拆分服务…';
  try {
    const resp = await fetch('/api/nodes/' + split.value.nodeId + '/expand', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback, answers }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接拆分服务');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let asked = null; let finished = false;
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop(); for (const part of parts) { const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; } if (d.status) split.value.status = d.status; if (d.questions) { finished = true; const data = d.questions; asked = Array.isArray(data) ? data : (data.questions || []); } if (d.done) { finished = true; if (d.goal) { goal.value = d.goal; nodes.value = d.goal.nodes || nodes.value; tutorials.value = d.goal.tutorials || tutorials.value; } toast('拆分完成：新增 ' + d.added + ' 个细任务'); split.value.open = false; } if (d.error) { finished = true; toast(d.error); } } }
    if (asked && asked.length) { split.value.ask = asked; splitAnswers.value = {}; toast('AI 想先确认几个问题，回答后继续拆分'); }
    else if (!finished) toast('拆分中断，可重试');
  } catch (e) { toast('拆分失败：' + e.message); } finally { split.value.busy = false; split.value.status = ''; }
}
const tutGen = ref({ open: false, busy: false, status: '', nodeId: 0, note: '', withFolders: true });
function openTutGen(preId) { const firstId = Number(preId) || ((pendingLeaves.value[0] || allLeafTasks.value[0] || {}).id || 0); tutGen.value = { open: true, busy: false, status: '', nodeId: firstId, note: '', withFolders: true }; }
function closeTutGen() { if (tutGen.value.busy) return; tutGen.value.open = false; }
async function startTutGen() { if (tutGen.value.busy || !tutGen.value.nodeId) return; tutGen.value.busy = true; tutGen.value.status = '正在连接教程服务…'; tutGen.value.open = false; try {
    const resp = await fetch('/api/nodes/' + tutGen.value.nodeId + '/tutorial', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'md', note: tutGen.value.note || '', codeFiles: [], withFolders: tutGen.value.withFolders !== false }) });
    if (!resp.ok || !resp.body) throw new Error('无法连接教程服务');
    const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = ''; let tut = null; let finished = false;
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop(); for (const part of parts) { const line = part.split('\n').find(l => l.startsWith('data: ')); if (!line) continue; let d; try { d = JSON.parse(line.slice(6)); } catch (e) { continue; } if (d.status) tutGen.value.status = d.status; if (d.done) { finished = true; tut = d.tutorial; if (d.goal) { goal.value = d.goal; nodes.value = d.goal.nodes || nodes.value; tutorials.value = d.goal.tutorials || tutorials.value; } } if (d.error) { finished = true; toast(d.error); } } }
    if (tut) { toast('教程已生成，正在打开…'); location.hash = '#/t/' + tut.id; return; } if (!finished) toast('教程生成中断，可重试');
  } catch (e) { toast('生成失败：' + e.message); } finally { tutGen.value.busy = false; tutGen.value.status = ''; } }
const editing = ref(false);
const saving = ref(false);
const newCons = ref('');
const consBusy = ref(false);
const form = ref({ title: '', profile: '', materials: '', weekly_hours: '', deadline: '' });
function openEdit() { form.value = { title: goal.value.title || '', profile: goal.value.profile || '', materials: goal.value.materials || '', weekly_hours: goal.value.weekly_hours || '', deadline: goal.value.deadline || '' }; editing.value = true; }
async function saveEdit() { if (saving.value) return; if (!String(form.value.title || '').trim()) return toast('标题不能为空'); saving.value = true; try { const r = await api('/api/goals/' + gid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form.value) }); goal.value = r.goal || goal.value; nodes.value = goal.value.nodes || nodes.value; tutorials.value = goal.value.tutorials || tutorials.value; editing.value = false; toast('已保存目标信息'); } catch (e) { toast('保存失败：' + e.message); } saving.value = false; }
async function addCons() { const text = String(newCons.value || '').trim(); if (!text || consBusy.value) return; consBusy.value = true; try { const r = await api('/api/goals/' + gid + '/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); goal.value = r.goal || goal.value; newCons.value = ''; toast('已添加约束'); } catch (e) { toast('添加失败：' + e.message); } consBusy.value = false; }
async function editCons(i) { const cur = constraints.value[i]; const text = window.prompt('修改约束', cur.text); if (text == null || !text.trim() || text.trim() === cur.text) return; if (consBusy.value) return; consBusy.value = true; try { const r = await api('/api/goals/' + gid + '/constraints', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: i, text: text.trim() }) }); goal.value = r.goal || goal.value; toast('已修改约束'); } catch (e) { toast('修改失败：' + e.message); } consBusy.value = false; }
async function delCons(i) { if (consBusy.value) return; if (!window.confirm('删除这条约束？\n\n' + constraints.value[i].text)) return; consBusy.value = true; try { const r = await api('/api/goals/' + gid + '/constraints/' + i, { method: 'DELETE' }); goal.value = r.goal || goal.value; toast('已删除约束'); } catch (e) { toast('删除失败：' + e.message); } consBusy.value = false; }
const orderedLeaves = computed(() => { const out = []; const by = {}; nodes.value.forEach(n => { const p = n.parent_id == null ? 0 : Number(n.parent_id); (by[p] = by[p] || []).push(n); }); Object.keys(by).forEach(k => by[k].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id)); const walk = (pid) => { (by[pid] || []).forEach(n => { if ((by[n.id] || []).length) walk(n.id); else out.push(n); }); }; walk(0); return out; });
const pendingLeaves = computed(() => orderedLeaves.value.filter(n => n.status !== 'done'));
const allLeafTasks = computed(() => orderedLeaves.value);
function openAi() { try { if (props.host.openChat) props.host.openChat(); else if (props.host.openAi) props.host.openAi(); else toast('对话页暂不可用'); } catch (e) { toast(e.message); } }
async function toggleTask(t, ev) { const want = ev.target.checked; const node = t.raw || t; if (busyId.value) return; busyId.value = node.id; try { const r = await api('/api/nodes/' + node.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: want ? 'done' : 'todo' }) }); const g = r.goal || r; goal.value = g; nodes.value = g.nodes || nodes.value; tutorials.value = g.tutorials || tutorials.value; toast(want ? '已完成 ✓' : '已取消完成'); } catch (e) { toast('保存失败：' + e.message); ev.target.checked = !want; } busyId.value = 0; }
const lastAt = computed(() => { if (!lastTut.value) return 0; const total = Number(lastTut.value.sections_total) || 0; return total ? Math.min(Number(lastTut.value.section_idx) + 1, total) : 0; });
const lastTotal = computed(() => Number(lastTut.value && lastTut.value.sections_total) || 0);
const lastPct = computed(() => lastTotal.value ? Math.min(100, Math.round(lastAt.value / lastTotal.value * 100)) : 0);
function home() { location.hash = '#/'; }
/* ---- Vue 原生目标收藏栏：拖拽排序 / 隐藏到 ⋯ / 本机持久化 ---- */
const FAV_KEY = 'sierxing-goalbar-vue-v1';
const favEdit = ref(false);
const favMenu = ref(false);
const favDragId = ref('');
const favCfg = ref({ order: [], hidden: [] });
function favLoad() {
  try { const raw = localStorage.getItem(FAV_KEY); if (raw) { const o = JSON.parse(raw); favCfg.value = { order: Array.isArray(o.order) ? o.order : [], hidden: Array.isArray(o.hidden) ? o.hidden : [] }; } } catch (e) {}
}
function favSave() { try { localStorage.setItem(FAV_KEY, JSON.stringify(favCfg.value)); } catch (e) {} }
function favHide(id) { if (!favCfg.value.hidden.includes(id)) favCfg.value.hidden.push(id); favSave(); }
function favShow(id) { favCfg.value.hidden = favCfg.value.hidden.filter(x => x !== id); favSave(); }
function favAll(on) { favCfg.value.hidden = on ? [] : favItems.value.map(i => i.id); favSave(); }
function favReset() { favCfg.value = { order: [], hidden: [] }; favSave(); toast('收藏栏已恢复默认'); }
function favDragStart(it) { favDragId.value = it.id; }
function favDrop(target) {
  const from = favDragId.value; favDragId.value = '';
  if (!from || from === target.id) return;
  const baseOrder = visibleItems.value.map(i => i.id).concat(hoverItems.value.map(i => i.id));
  const arr = baseOrder.slice();
  const i = arr.indexOf(from); if (i >= 0) arr.splice(i, 1);
  const j = arr.indexOf(target.id);
  arr.splice(j < 0 ? arr.length : j, 0, from);
  favCfg.value.order = arr; favSave();
}
const favItems = computed(() => {
  const out = [];
  out.push({ id: 'planBtn', label: '🧭 重新规划', title: '重新规划（会替换现骨架）', show: !!nodes.value.length, fn: () => openReplan('replan') });
  out.push({ id: 'editGoalBtn', label: '✎ 编辑目标', fn: openEdit });
  out.push({ id: 'shareGoalBtn', label: '🔗 分享', fn: () => { shareOpen.value = true; } });
  out.push({ id: 'chatBtn', label: '💬 对话', fn: openAi });
  out.push({ id: 'gMapBtn', label: '🗺 路线图', href: '#/g/' + gid + '/map' });
  out.push({ id: 'gSplitBtn', label: '✨ 深度拆分', fn: openSplit });
  out.push({ id: 'gTutBtn', label: '📘 生成教程', fn: openTutGen });
  for (const e of pluginEntries.value) out.push({ id: 'goalComp_' + e.id, label: (e.icon || '') + ' ' + e.label, href: e.hash(gid), title: e.label });
  out.push({ id: 'verBtn', label: '📜 版本对比', href: '#/g/' + gid + '/versions' });
  return out.filter(i => i.show !== false);
});
const favOrdered = computed(() => {
  const byId = {}; favItems.value.forEach(i => { byId[i.id] = i; });
  const seen = new Set(); const out = [];
  for (const id of favCfg.value.order) { const it = byId[id]; if (it && !seen.has(id)) { out.push(it); seen.add(id); } }
  for (const it of favItems.value) if (!seen.has(it.id)) out.push(it);
  return out;
});
const visibleItems = computed(() => favOrdered.value.filter(i => !favCfg.value.hidden.includes(i.id)));
const hoverItems = computed(() => favOrdered.value.filter(i => favCfg.value.hidden.includes(i.id)));
const pluginEntries = computed(() => {
  try {
    const es = (window.SiErXing && window.SiErXing.goalEntries) ? (window.SiErXing.goalEntries(goal.value) || []) : [];
    return es.filter(e => e && e.header !== false && typeof e.hash === 'function');
  } catch (e) { return []; }
});
async function refreshGoal() {
  try {
    const [r, s, lt] = await Promise.all([api('/api/goals/' + gid), api('/api/goals/' + gid + '/sources').catch(() => ({ sources: [] })), api('/api/goals/' + gid + '/last-tutorial').catch(() => ({}))]);
    const g = r.goal || r; goal.value = g; nodes.value = g.nodes || []; tutorials.value = g.tutorials || []; sourceCount.value = (s.sources || []).length; lastTut.value = lt.tutorial || null;
  } catch (e) { toast('目标加载失败：' + e.message); }
}
onMounted(async () => {
  favLoad();
  loadFolds();
  await refreshGoal();
  try {
    const act = String(props.host.openAction || '');
    if (act === 'tut') openTutGen(Number(props.host.openNode) || 0);
    else if (act === 'split') openSplit(Number(props.host.openNode) || 0);
  } catch (e) {}
});
</script>

<style scoped>
.page { max-width: 1280px; }
.goalBar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: -4px 0 12px; position: relative; }
.favBar .btn { position: relative; }
.favPin { position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; border-radius: 50%; border: 0; background: var(--danger); color: #fff; font-size: 10px; line-height: 1; cursor: pointer; z-index: 2; padding: 0; }
.favMore { margin-left: 2px; }
.favMenu { position: absolute; z-index: 40; top: calc(100% + 6px); right: 0; width: 260px; max-height: 60vh; overflow: auto; background: var(--card); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.18); padding: 10px; }
.favMenuHead { display: flex; align-items: center; margin-bottom: 8px; font-size: 13px; }
.favMenuSec { border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 8px; font-size: 12px; display: flex; flex-direction: column; gap: 5px; }
.favMenuItem { display: flex; align-items: center; gap: 8px; }
.favMenuLabel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--card); padding: 16px; margin-bottom: 14px; }
.cardHead { display: flex; align-items: center; font-weight: 700; font-size: 13.5px; margin-bottom: 10px; }
.summary { font-size: 13.5px; line-height: 1.85; margin: 0 0 10px; white-space: pre-wrap; }
.profile { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.7; margin-bottom: 10px; }
.profile b { flex: none; color: var(--muted); }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.bar { height: 8px; border-radius: 4px; background: var(--soft); overflow: hidden; }
.barFill { height: 100%; background: var(--accent); border-radius: 4px; }
.err { margin-top: 10px; color: var(--danger); font-size: 12.5px; }
.emptyCard { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; padding: 34px 16px; }
.nextTask { font-size: 14px; line-height: 1.7; }
.stageList { display: flex; flex-direction: column; gap: 2px; }
.stageRow { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-radius: 8px; text-decoration: none; color: var(--text); font-size: 13px; }
.stageRow:hover { background: var(--soft); }
.stageIco { flex: none; }
.stageTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stagePct { width: 38px; text-align: right; color: var(--muted); font-size: 12px; }
.miniBar { width: 70px; height: 6px; border-radius: 3px; background: var(--soft); overflow: hidden; }
.miniBar i { display: block; height: 100%; background: var(--accent); }
.tutList { display: flex; flex-direction: column; gap: 2px; }
.tutRow { display: flex; align-items: center; gap: 8px; padding: 7px 6px; border-radius: 8px; text-decoration: none; color: var(--text); font-size: 13px; }
.tutRow:hover { background: var(--soft); }
.tutTitle { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.consList { display: flex; flex-direction: column; gap: 8px; }
.consRow { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.7; }
.qaWarn { color: var(--warn); font-size: 12.5px; margin-bottom: 10px; }
.qaRounds { display: flex; flex-direction: column; gap: 10px; }
.qaRound { border: 1px solid var(--line); border-radius: 9px; padding: 10px; }
.qaRoundHead { font-size: 12.5px; font-weight: 600; margin-bottom: 6px; }
.qaItem { padding: 5px 0; border-top: 1px dashed var(--line); font-size: 12.5px; }
.qaQ { line-height: 1.65; }
</style>
