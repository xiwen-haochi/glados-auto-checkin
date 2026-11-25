/**
 * GLaDOS 自动签到 —— 内容脚本
 *
 * 注入范围：https://glados.rocks/*（见 manifest.json 的 content_scripts）
 * 职责：接收后台指令，在当前页面上找到签到控件并真实点击，然后：
 *   - 识别"已签到"状态（按钮显示 Done for today，不含 checkin 字样）；
 *   - 点击后等状态变化，并读取顶部 POINTS 卡片，算出本次获得多少积分。
 *
 * 为什么用"点按钮"而不是直接调接口：
 *   站点给签到接口加了验证码 / 风控参数，脚本仿造请求会被拦；
 *   在真实已登录页面里点击真实按钮，浏览器自动带上会话与风控数据，成功率最高。
 */

/** 等待指定毫秒（类似 Python 的 time.sleep，但不阻塞线程） */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把元素文字压成单行，方便比较 / 正则匹配 */
function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/** 取元素"自身的直接文本"（只统计直接子文本节点，不含深层子元素里的整段文字） */
function directText(el) {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
  }
  return cleanText(text);
}

/**
 * 粗略判断元素是否可见。
 * 注意：这里不用 getBoundingClientRect 判断尺寸——后台标签页里尺寸可能是 0，
 * 会把真实按钮误判成不可见。只排除明确的 display:none / visibility:hidden。
 */
function isVisible(el) {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return !el.closest('[hidden]');
}

/* "未签到"按钮文案（Checkin! Got 10 Points）与"已签到"按钮文案（Done for today） */
const CHECKIN_TEXT = /check\s*-?\s*in/i;
const DONE_TEXT = /done\s+for\s+today|checkin!?\s+checked|^checked\s+in$/i;

/**
 * 在页面里找「Daily Punch」卡片上的签到控件，未签到 / 已签到两种状态都认。
 *
 * 两轮匹配，防止误命中图例里的 "Checked in points" 这种纯文字：
 *  第一轮：button / [role=button] / a —— 站点签到按钮通常是 <button>；
 *  第二轮：用 div/span 伪装、光标为手型的元素。
 *
 * @returns {{el: HTMLElement, text: string, done: boolean} | null}
 */
function findPunchControl() {
  // 第一轮：真正的按钮 / 链接
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    const text = cleanText(el.innerText);
    if (!text || text.length > 40) continue; // 过长说明不是按钮文案
    if (!CHECKIN_TEXT.test(text) && !DONE_TEXT.test(text)) continue;
    if (!isVisible(el)) continue;
    return { el, text, done: DONE_TEXT.test(text) };
  }

  // 第二轮：div/span 伪装成按钮（可点击光标）
  for (const el of document.querySelectorAll('div, span')) {
    const text = directText(el);
    if (!text || text.length > 40) continue;
    if (!CHECKIN_TEXT.test(text) && !DONE_TEXT.test(text)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;
    if (!isVisible(el)) continue;
    const full = cleanText(el.innerText) || text;
    return { el, text: full, done: DONE_TEXT.test(full) };
  }

  return null;
}

/** 判断当前是不是登录页（路径含 login，或页面上有密码输入框） */
function looksLikeLoginPage() {
  if (/login/i.test(location.pathname)) return true;
  return !!document.querySelector('input[type="password"]');
}

/**
 * 读取页面顶部「POINTS」卡片里的大号数字（当前总积分）。
 * 只认整段文字就是 Points 的小标题，避免命中侧边栏菜单或 "Points Trend"。
 * 读不到返回 null，调用方自行降级。
 */
function readTotalPoints() {
  for (const label of document.querySelectorAll('div, span, p')) {
    const labelText = directText(label) || cleanText(label.innerText);
    if (!/^points$/i.test(labelText)) continue;

    let box = label.parentElement;
    // 向上找 3 层容器：卡片结构一般是 容器 > (标题, 数字)
    for (let depth = 0; depth < 3 && box; depth++) {
      for (const num of box.querySelectorAll('div, span, p, b, strong')) {
        const text = cleanText(num.innerText);
        // 纯数字才算候选；"0" 多半是数字递增动画的初始帧，跳过
        if (!/^\d{1,7}$/.test(text) || text === '0') continue;
        const size = parseFloat(getComputedStyle(num).fontSize) || 0;
        if (size >= 18) return Number(text); // 大号数字才是指标值，排除小字说明
      }
      box = box.parentElement;
    }
  }
  return null;
}

/** 拼接总积分后缀；读不到总积分就只返回原文 */
function totalText(text, total) {
  return total === null || total === undefined ? text : `${text} · 总积分 ${total}`;
}

/**
 * 稳定读取总积分：连续两次（间隔 500 毫秒）读到相同值才可信。
 * 页面总积分有从 0 递增的动画，单次读数可能落在动画中间，
 * 会导致"本次获得积分"被算成一个巨大的数。4 次仍不稳定则返回 null（按未知处理）。
 */
async function readStablePoints() {
  let prev = null;
  for (let i = 0; i < 4; i++) {
    const value = readTotalPoints();
    if (value !== null && value === prev) return value;
    prev = value;
    await sleep(500);
  }
  return null;
}

/**
 * 执行签到：
 *  1) 等签到控件出现（最多 20 秒）
 *  2) 若按钮已是 "Done for today" 之类 → 直接提示今日已签到
 *  3) 记录点击前总积分 → 点击 → 等状态变化 / 积分上涨（最多 60 秒）
 *  4) 再等积分刷新（最多 15 秒），算出本次获得多少积分
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
async function doCheckin() {
  /* ---------- 1. 等签到控件出现 ---------- */
  const appearDeadline = Date.now() + 20000;
  let control = null;
  while (Date.now() < appearDeadline) {
    if (looksLikeLoginPage()) {
      return { ok: false, message: '当前未登录（或登录已过期），请先在这个浏览器里登录 glados.rocks' };
    }
    control = findPunchControl();
    if (control) break;
    await sleep(500);
  }
  if (!control) {
    return { ok: false, message: '页面上没找到签到按钮（页面结构可能已变化）' };
  }

  /* ---------- 2. 已签到：不点，直接给明确提示（能读到总积分就带上） ---------- */
  if (control.done) {
    const total = readTotalPoints();
    return { ok: true, message: totalText(`今日已签到（按钮显示：${control.text}），无需重复执行`, total) };
  }

  /* ---------- 3. 记录点击前总积分（必须读到稳定值，否则不参与计算） ---------- */
  // 页面上的总积分有从 0 递增的动画，只读一次可能拿到动画中的中间值，
  // 会把"本次获得"算成一个巨大的数（比如 451）。所以这里要读两次确认稳定。
  const beforePoints = await readStablePoints();
  const beforeText = control.text;
  control.el.scrollIntoView({ block: 'center' });
  await sleep(300);
  control.el.click();

  /* ---------- 4. 等状态变化（按钮变成已签到 / 文字变化 / 积分上涨） ---------- */
  let changed = false;
  let afterText = '';
  const doneDeadline = Date.now() + 60000;
  while (Date.now() < doneDeadline) {
    await sleep(1000);

    const now = findPunchControl();
    if (!now) {
      changed = true; // 控件消失（签到后 UI 换了形式）也算完成
      break;
    }
    if (now.done || now.text !== beforeText) {
      changed = true;
      afterText = now.text;
      break;
    }

    // 有时按钮文案刷得慢，但总积分已经涨了，也算成功（只在点击前读数可信时才用）
    if (beforePoints !== null) {
      const points = readTotalPoints();
      if (points !== null && points > beforePoints) {
        changed = true;
        break;
      }
    }

    // 有些情况下只在页面上弹提示
    const pageText = document.body.innerText || '';
    if (/already\s+checked/i.test(pageText)) {
      return { ok: true, message: totalText('今日已签到（页面提示 already checked），无需重复执行', readTotalPoints()) };
    }
    if (/check\s*-?\s*in\s*(success|successful)|successfully\s+check/i.test(pageText)) {
      changed = true;
      break;
    }
  }

  if (!changed) {
    return {
      ok: false,
      message: `已点击签到按钮，但 60 秒内没看到状态变化（可能需要人工过验证码）。点击前文案：${beforeText}`,
    };
  }

  /* ---------- 5. 等积分刷新并稳定（最多 15 秒） ---------- */
  let afterPoints = null;
  const pointsDeadline = Date.now() + 15000;
  while (Date.now() < pointsDeadline) {
    const stable = await readStablePoints();
    // 与点击前读数不同（或点击前根本没读到）才算拿到刷新后的总积分
    if (stable !== null && stable !== beforePoints) {
      afterPoints = stable;
      break;
    }
    await sleep(500);
  }

  /* ---------- 6. 组织结果文案：总积分一定带上，获得积分读不到就不写 ---------- */
  const total = afterPoints !== null ? afterPoints : readTotalPoints();
  const delta = beforePoints !== null && afterPoints !== null ? afterPoints - beforePoints : null;
  const gained = delta !== null && delta > 0 ? delta : null;

  if (gained !== null) {
    return { ok: true, message: totalText(`签到成功，获得 ${gained} 积分`, total) };
  }
  return { ok: true, message: totalText(`签到成功${afterText ? `（按钮变为：${afterText}）` : ''}`, total) };
}

/* ---------- 与后台通信 ---------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 探活：后台用它确认内容脚本已注入
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }
  // 执行签到（异步，需 return true 保持消息通道）
  if (msg.type === 'DO_CHECKIN') {
    doCheckin()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: `页面脚本异常：${(e && e.message) || e}` }));
    return true;
  }
  return false;
});
