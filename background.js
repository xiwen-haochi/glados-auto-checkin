/**
 * GLaDOS 自动签到 —— 后台服务（Manifest V3 Service Worker）
 *
 * 只做三件事：
 *  1. 用 chrome.alarms 在每天指定时间触发一次签到；
 *  2. 打开（或复用）签到页面标签页，把「执行签到」指令发给 content.js；
 *  3. 把结果写进 chrome.storage，并显示在扩展图标角标上，供 popup 展示。
 *
 * 为什么是"打开页面点按钮"而不是直接调接口：
 *   站点给签到接口加了人机校验（验证码 / 风控参数），脚本直接发请求过不去；
 *   在真实已登录的页面里点击真实按钮，浏览器会自动带上会话与风控数据，最稳。
 */

/** 闹钟名称（唯一，用于创建 / 清除 / 监听） */
const ALARM_NAME = 'glados-daily-checkin';

/** 签到页地址 */
const CHECKIN_URL = 'https://glados.rocks/console/checkin';

/**
 * 默认配置
 * enabled    : 是否开启每天定时签到
 * time       : 每天执行时间，24 小时制 "HH:mm"
 * foreground : true = 前台（活动）标签页打开，会抢窗口焦点，但若站点校验依赖可见页面则更稳
 */
const DEFAULT_CONFIG = { enabled: true, time: '09:00', foreground: false };

/** 是否有任务正在执行，防止定时任务和手动点击同时跑导致开两个标签页 */
let running = false;

/* ======================== 通用小工具 ======================== */

/** 等待指定毫秒（类似 Python 的 time.sleep，但不阻塞线程） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取"今天"的日期字符串，用于判断当天是否已签到（本地时区） */
function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** 设置扩展图标角标文字与底色（text 为空字符串即清除角标） */
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

/* ======================== 配置读写 ======================== */

/** 读取配置：storage 里没有的字段用默认值补齐 */
async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

/** 合并保存配置，返回保存后的完整配置 */
async function setConfig(patch) {
  const next = { ...(await getConfig()), ...(patch || {}) };
  await chrome.storage.local.set({ config: next });
  return next;
}

/* ======================== 定时调度 ======================== */

/**
 * 计算下一次 "HH:mm" 对应的时间戳。
 * 今天这个点还没到就用今天，已经过了就顺延到明天。
 */
function nextTimeOfDay(hhmm) {
  const [hour, minute] = (hhmm || DEFAULT_CONFIG.time).split(':').map(Number);
  const target = new Date();
  target.setHours(hour || 0, minute || 0, 0, 0);
  if (target.getTime() <= Date.now()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/**
 * 重新安排下一次闹钟（先清掉旧的，避免重复触发）。
 * 返回下一次执行的时间戳；配置未启用时返回 null。
 */
async function scheduleNextAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const config = await getConfig();
  if (!config.enabled) {
    setBadge('', '#888888');
    return null;
  }
  const when = nextTimeOfDay(config.time);
  await chrome.alarms.create(ALARM_NAME, { when });
  return when;
}

/**
 * 漏签补签：浏览器在设定时间点没开着时，闹钟不会触发。
 * 所以浏览器启动时检查一次——如果今天已过时间点、今天还没执行过、也没成功过，
 * 就安排 10 秒后补一次（每天最多补一次，避免反复弹标签页）。
 */
async function maybeCatchUp() {
  const config = await getConfig();
  if (!config.enabled) return;

  // 已有闹钟（可能是过期的，Chrome 启动后会立刻触发），不额外安排
  if (await chrome.alarms.get(ALARM_NAME)) return;

  // 今天的时间点还没到，等正常闹钟即可
  const [hour, minute] = config.time.split(':').map(Number);
  const todayPoint = new Date();
  todayPoint.setHours(hour || 0, minute || 0, 0, 0);
  if (Date.now() < todayPoint.getTime()) return;

  const { lastAttemptDate, lastSuccessDate } = await chrome.storage.local.get([
    'lastAttemptDate',
    'lastSuccessDate',
  ]);
  if (lastSuccessDate === todayKey() || lastAttemptDate === todayKey()) return;

  await chrome.alarms.create(ALARM_NAME, { when: Date.now() + 10000 });
}

/* ======================== 标签页操作 ======================== */

/** 向指定标签页的内容脚本发探活消息，确认 content.js 已注入 */
async function pingContent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return !!(res && res.ok);
  } catch (e) {
    return false; // 常见原因：标签页里没有内容脚本（扩展刚装、旧标签页）
  }
}

/** 等待标签页加载完成（status === 'complete'），带超时兜底 */
function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let timer = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') cleanup();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    timer = setTimeout(cleanup, timeoutMs);

    // 兜底：如果调用时页面已经加载完了，上面的 updated 事件不会再触发
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') cleanup();
      })
      .catch(() => cleanup());
  });
}

/** 等标签页里的内容脚本就绪（最多 20 秒），就绪后返回；超时抛错 */
async function waitContentReady(tabId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await pingContent(tabId)) return;
    await sleep(500);
  }
  throw new Error('签到页脚本未就绪（页面可能没加载完）');
}

/**
 * 拿到一个"准备好了的"签到页标签，优先级：
 *  1. 已有签到页标签 → 直接复用，签到后不关闭；
 *  2. 有其它 glados 页面 → 借用它打开签到页，签到成功后导航回原页面（不关闭）；
 *  3. 都没有 → 新开一个标签页（active 由配置决定），签到成功后关闭。
 *
 * 返回 { tab, created, restoreUrl }：
 *  created   我们自己新开的（成功后关掉）
 *  restoreUrl 借用的标签页原来的地址（成功后导航回去）
 */
async function openCheckinTab(foreground) {
  const tabs = await chrome.tabs.query({ url: 'https://glados.rocks/*' });

  // 1) 已经打开着签到页：复用（脚本没注入就刷新一次）
  const checkinTab = tabs.find((t) => (t.url || '').startsWith(CHECKIN_URL));
  if (checkinTab) {
    if (!(await pingContent(checkinTab.id))) {
      await chrome.tabs.reload(checkinTab.id);
      await waitForTabComplete(checkinTab.id);
    }
    await waitContentReady(checkinTab.id);
    return { tab: checkinTab, created: false, restoreUrl: null };
  }

  // 2) 有其它 glados 页面：借用它（优先非激活标签，避免把用户正在看的页面切走）
  if (tabs.length) {
    const tab = tabs.find((t) => !t.active) || tabs[0];
    const restoreUrl = tab.url;
    await chrome.tabs.update(tab.id, { url: CHECKIN_URL });
    await waitForTabComplete(tab.id);
    await waitContentReady(tab.id);
    return { tab, created: false, restoreUrl };
  }

  // 3) 没有任何 glados 页面：新开一个
  const tab = await chrome.tabs.create({ url: CHECKIN_URL, active: !!foreground });
  await waitForTabComplete(tab.id);
  await waitContentReady(tab.id);
  return { tab, created: true, restoreUrl: null };
}

/** 把借用的标签页导航回它原来的地址（用户中途手动跳走就不动它了） */
async function restoreTab(tabId, url) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.startsWith(CHECKIN_URL)) return;
    await chrome.tabs.update(tabId, { url });
  } catch (e) {
    // 标签页可能已被用户关掉，忽略
  }
}

/**
 * 让内容脚本执行签到，并等待结果。
 * 外层 120 秒超时：内容脚本内部最长约 95 秒（20 秒等按钮 + 60 秒等状态 + 15 秒等积分刷新）。
 */
async function sendCheckinCommand(tabId) {
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'DO_CHECKIN' }),
      sleep(120000).then(() => ({ ok: false, message: '等待签到结果超时（120 秒）' })),
    ]);
    return result || { ok: false, message: '签到页没有返回结果' };
  } catch (e) {
    return { ok: false, message: `与签到页通信失败：${(e && e.message) || e}` };
  }
}

/* ======================== 签到记录（IndexedDB） ======================== */

/** 打开签到记录数据库；首次调用会自动建库建表 */
function openRecordDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('glados-checkin', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        // 类似 Python 的 list，每条记录自增 id，另外建 at（时间戳）索引方便取最近几条
        const store = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        store.createIndex('at', 'at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 追加一条签到记录。
 * 写库失败只打日志，不影响签到主流程（记录是附属功能）。
 */
async function addRecord(record) {
  try {
    const db = await openRecordDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      tx.objectStore('records').add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[GLaDOS 签到] 写 IndexedDB 记录失败：', e);
  }
}

/* ======================== 主流程：执行一次签到 ======================== */

/**
 * 执行一次签到。
 * @param {'alarm'|'manual'} trigger 触发来源（定时 / 手动）
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function runCheckin(trigger) {
  if (running) return { ok: false, message: '已有签到任务正在执行' };
  running = true;
  setBadge('…', '#888888');

  // Service Worker 空闲约 30 秒会被浏览器回收，签到等待期间定时调一次轻量 API 保活
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);

  try {
    const config = await getConfig();
    const { tab, created, restoreUrl } = await openCheckinTab(config.foreground);

    const result = await sendCheckinCommand(tab.id);

    // 记录本次结果与执行日期（lastAttemptDate 用于漏签补签每天只补一次）
    const now = Date.now();
    await chrome.storage.local.set({
      lastResult: { ok: !!result.ok, message: result.message || '', at: now, trigger },
      lastAttemptDate: todayKey(),
      ...(result.ok ? { lastSuccessDate: todayKey() } : {}),
    });
    // 每次签到（无论成功失败）都落一条 IndexedDB 记录
    await addRecord({ at: now, ok: !!result.ok, message: result.message || '', trigger });

    setBadge(result.ok ? 'OK' : '!', result.ok ? '#2e9e4f' : '#d93025');

    // 自己新开的标签页：成功就收掉；失败则留着，方便看一眼卡在哪一步
    // 借用用户已有标签页的：成功后导航回它原来的页面，不关闭
    if (created && result.ok) {
      chrome.tabs.remove(tab.id).catch(() => {});
    } else if (restoreUrl && result.ok) {
      restoreTab(tab.id, restoreUrl);
    }
    return result;
  } catch (e) {
    const message = `执行异常：${(e && e.message) || e}`;
    const now = Date.now();
    await chrome.storage.local.set({
      lastResult: { ok: false, message, at: now, trigger },
      lastAttemptDate: todayKey(),
    });
    await addRecord({ at: now, ok: false, message, trigger });
    setBadge('!', '#d93025');
    return { ok: false, message };
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

/* ======================== 事件监听 ======================== */

/** 闹钟到点：先把下一天排上，再执行签到（中途 Worker 被回收也不影响明天的定时） */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await scheduleNextAlarm();
  await runCheckin('alarm');
});

/** 安装 / 更新扩展：按当前配置排下一次闹钟 */
chrome.runtime.onInstalled.addListener(async () => {
  await scheduleNextAlarm();
});

/** 浏览器启动：先看要不要补签，再保证有闹钟 */
chrome.runtime.onStartup.addListener(async () => {
  await maybeCatchUp();
  if (!(await chrome.alarms.get(ALARM_NAME))) await scheduleNextAlarm();
});

/** 处理 popup 发来的消息 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 查询状态：配置 / 下次执行时间 / 上次结果
  if (msg.type === 'GET_STATUS') {
    (async () => {
      const config = await getConfig();
      const alarm = await chrome.alarms.get(ALARM_NAME);
      const { lastResult } = await chrome.storage.local.get('lastResult');
      sendResponse({
        config,
        nextRunAt: alarm ? alarm.scheduledTime : null,
        lastResult: lastResult || null,
        running,
      });
    })();
    return true; // 返回 true 表示会异步调用 sendResponse
  }

  // 保存配置并重排闹钟
  if (msg.type === 'SAVE_CONFIG') {
    (async () => {
      const config = await setConfig(msg.config);
      const nextRunAt = await scheduleNextAlarm();
      sendResponse({ config, nextRunAt });
    })();
    return true;
  }

  // 手动立即签到（不影响定时设置）
  if (msg.type === 'RUN_NOW') {
    runCheckin('manual').then(sendResponse);
    return true;
  }

  return false;
});
