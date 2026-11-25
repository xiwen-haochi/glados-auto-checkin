/**
 * GLaDOS 自动签到 —— 弹窗脚本
 *
 * 只负责：
 *  1. 从后台读取配置 / 上次结果 / 下次执行时间，并读取 IndexedDB 里的历史记录，渲染界面；
 *  2. 保存配置（交给后台写 storage 并重排闹钟）；
 *  3. 触发一次"立即签到"（测试用，不用等定时）。
 */

/** 按 id 取元素的简写 */
const $ = (id) => document.getElementById(id);

/** 时间戳 → "2026-11-25 09:00" 这种可读格式 */
function fmtTime(ts) {
  if (!ts) return '未安排';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ======================== 签到记录读取（IndexedDB） ======================== */

/**
 * 打开签到记录数据库。
 * 表结构由 background.js 写入时创建，这里只读不建表（弹窗先打开时库可能还不存在，
 * 此时 onupgradeneeded 也会走一遍，保证后续读取不报错）。
 */
function openRecordDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('glados-checkin', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        store.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 按 at（时间戳）倒序取最近 limit 条记录 */
async function listRecords(limit) {
  const db = await openRecordDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const index = tx.objectStore('records').index('at');
    const out = [];
    const req = index.openCursor(null, 'prev'); // 倒序游标，最新的先出
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** 渲染签到历史列表 */
async function loadHistory() {
  const box = $('history');
  try {
    const records = await listRecords(20);
    if (!records.length) {
      box.textContent = '暂无记录';
      return;
    }
    box.textContent = '';
    for (const r of records) {
      const item = document.createElement('div');
      item.className = 'rec ' + (r.ok ? 'ok' : 'fail');

      const head = document.createElement('div');
      head.className = 'rec-head';
      const source = r.trigger === 'manual' ? '手动' : '定时';
      head.textContent = `${fmtTime(r.at)} · ${source} · ${r.ok ? '成功' : '失败'}`;

      const msg = document.createElement('div');
      msg.className = 'rec-msg';
      msg.textContent = r.message || '';

      item.append(head, msg);
      box.append(item);
    }
  } catch (e) {
    box.textContent = `读取记录失败：${(e && e.message) || e}`;
  }
}

/* ======================== 顶部状态 ======================== */

/** 读后台状态并填表 */
async function loadStatus() {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  $('enabled').checked = !!status.config.enabled;
  $('time').value = status.config.time || '09:00';
  $('foreground').checked = !!status.config.foreground;
  renderStatus(status);
}

/** 渲染状态区：上次结果 + 下次执行时间 */
function renderStatus(status) {
  const lines = [];

  if (status.lastResult) {
    const r = status.lastResult;
    lines.push(`上次（${fmtTime(r.at)}）：${r.ok ? '成功' : '失败'} —— ${r.message}`);
  } else {
    lines.push('上次：还没有执行记录');
  }

  lines.push(`下次：${status.config.enabled ? fmtTime(status.nextRunAt) : '未启用定时'}`);
  if (status.running) lines.push('当前正在执行…');

  $('status').textContent = lines.join('\n');
}

/* ======================== 交互 ======================== */

/* 保存设置 */
$('save').onclick = async () => {
  $('save').disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'SAVE_CONFIG',
      config: {
        enabled: $('enabled').checked,
        time: $('time').value || '09:00',
        foreground: $('foreground').checked,
      },
    });
    // 保存后重新取一次完整状态，保证"下次执行时间"显示准确
    await loadStatus();
  } finally {
    $('save').disabled = false;
  }
};

/* 立即签到（测试用） */
$('run').onclick = async () => {
  $('run').disabled = true;
  $('run').textContent = '执行中…';
  $('status').textContent = '正在打开签到页并点击签到，读积分最多约 2 分钟…（弹窗可能会自动关闭）';
  try {
    await chrome.runtime.sendMessage({ type: 'RUN_NOW' });
  } catch (e) {
    // 前台标签页抢焦点导致弹窗关闭时这里会报错，属于正常情况
  }
  try {
    await loadStatus();
    await loadHistory(); // 刷新记录，能看到刚写入的这一条
  } catch (e) {
    // 弹窗已关闭则忽略
  }
  $('run').disabled = false;
  $('run').textContent = '立即签到';
};

/* 弹窗打开时加载状态与记录 */
document.addEventListener('DOMContentLoaded', () => {
  loadStatus();
  loadHistory();
});
