import { chromium } from "playwright";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

function parseBlockedWindows(raw) {
  if (!raw?.trim()) return [];
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw new Error("BLOCKED_WINDOWS はJSON形式で設定してください");
  }
  if (!Array.isArray(entries)) throw new Error("BLOCKED_WINDOWS は配列で設定してください");
  return entries.map((entry, index) => {
    const date = String(entry?.date || "").replaceAll("-", "/");
    const start = String(entry?.start || "");
    const end = String(entry?.end || "");
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) {
      throw new Error(`BLOCKED_WINDOWS の${index + 1}件目が不正です`);
    }
    return { date, start, end, label: String(entry?.label || "予定あり") };
  });
}

const config = {
  startUrl: process.env.START_URL?.trim(),
  studentId: process.env.STUDENT_ID?.trim(),
  password: process.env.PASSWORD,
  ntfyTopic: process.env.NTFY_TOPIC?.trim(),
  autoBook: /^true$/i.test(process.env.AUTO_BOOK || "false"),
  autoBookNotBefore: process.env.AUTO_BOOK_NOT_BEFORE ? Date.parse(process.env.AUTO_BOOK_NOT_BEFORE) : 0,
  blockedWindows: parseBlockedWindows(process.env.BLOCKED_WINDOWS),
  pollMs: Math.max(60, Number(process.env.POLL_INTERVAL_SECONDS || 60)) * 1000,
  headless: !/^false$/i.test(process.env.HEADLESS || "true"),
  approvalMs: Math.max(2, Number(process.env.APPROVAL_MINUTES || 5)) * 60_000,
  renotifyMs: Math.max(5, Number(process.env.SAME_DAY_RENOTIFY_MINUTES || 10)) * 60_000,
  maintenanceRetryMs: Math.max(2, Number(process.env.MAINTENANCE_RETRY_MINUTES || 5)) * 60_000,
  port: Number(process.env.PORT || 10_000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, ""),
};

for (const [key, value] of Object.entries({ START_URL: config.startUrl, STUDENT_ID: config.studentId, PASSWORD: config.password, NTFY_TOPIC: config.ntfyTopic })) {
  if (!value) throw new Error(`${key} が設定されていません`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const log = (message) => console.log(`[${stamp()}] ${message}`);
const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();

let lastErrorNoticeAt = 0;
let currentTarget = "";
let browser;
const pendingApprovals = new Map();
const recentlyNotified = new Map();
const dryRunSeen = new Set();
const maintenancePattern = /メンテナンス|保守作業|利用時間外|サービス.{0,8}(停止|休止)|ただいま.{0,8}利用できません/i;

class MaintenanceError extends Error {
  constructor() {
    super("予約サイトはメンテナンス中です");
    this.name = "MaintenanceError";
  }
}

function tokyoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}/${value.month}/${value.day}`;
}

async function notify(title, message, priority = 3, tags = ["car"], actions = []) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: config.ntfyTopic, title, message, priority, tags, ...(actions.length ? { actions } : {}) }),
    });
    if (response.ok) return;
    if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`通知送信に失敗しました (${response.status})`);
    }
    const retryAfter = Math.min(15, Math.max(2, Number(response.headers.get("retry-after") || attempt * 3)));
    await sleep(retryAfter * 1000);
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function secureEqual(a, b) {
  const first = Buffer.from(a || "");
  const second = Buffer.from(b || "");
  return first.length === second.length && timingSafeEqual(first, second);
}

function findApproval(url) {
  const id = url.searchParams.get("id") || "";
  const token = url.searchParams.get("token") || "";
  const approval = pendingApprovals.get(id);
  if (!approval || !secureEqual(token, approval.token)) return { error: "無効な承認リンクです。" };
  if (approval.used) return { error: "この承認リンクは既に使用済みです。" };
  if (Date.now() > approval.expiresAt) return { error: "承認期限が切れています。空き枠を再確認します。" };
  return { approval };
}

function sendHtml(response, status, title, body) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;line-height:1.7}button{width:100%;padding:16px;font-size:18px;font-weight:700;background:#1769e0;color:white;border:0;border-radius:12px}.card{padding:18px;background:#f3f5f7;border-radius:12px;margin:20px 0}.warn{color:#b42318;font-weight:700}</style><h1>${escapeHtml(title)}</h1>${body}</html>`);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
    return;
  }
  if (url.pathname !== "/approve") {
    sendHtml(response, 404, "ページがありません", "<p>このページは利用できません。</p>");
    return;
  }
  const result = findApproval(url);
  if (result.error) {
    sendHtml(response, 410, "予約できません", `<p class="warn">${escapeHtml(result.error)}</p>`);
    return;
  }
  const { approval } = result;
  if (request.method === "GET") {
    sendHtml(response, 200, "当日予約の確認", `<p class="warn">この予約は当日分のため、キャンセル料が発生する可能性があります。</p><div class="card"><strong>${escapeHtml(approval.target)}</strong><br>${escapeHtml(approval.details)}</div><form method="post"><button type="submit">この当日予約を承認する</button></form><p>押さなければ予約されません。リンクは${Math.round(config.approvalMs / 60_000)}分で無効になります。</p>`);
    return;
  }
  if (request.method === "POST") {
    approval.approved = true;
    sendHtml(response, 200, "承認しました", "<p>空き枠がまだ残っているか再確認し、残っている場合だけ予約します。この画面は閉じて構いません。</p>");
    return;
  }
  response.writeHead(405, { Allow: "GET, POST" });
  response.end();
});

server.listen(config.port, "0.0.0.0", () => log(`承認用Web画面をポート${config.port}で開始`));

async function isMaintenancePage(page) {
  for (const frame of page.frames()) {
    const text = await frame.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (maintenancePattern.test(text)) return true;
  }
  return false;
}

async function getMenuFrame(page) {
  await page.locator("iframe#frameMenu").waitFor({ state: "attached", timeout: 30_000 });
  const handle = await page.$("iframe#frameMenu");
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("予約画面のフレームを取得できません");
  return frame;
}

async function waitForOne(frame, selectors, timeout = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const selector of selectors) if (await frame.locator(selector).first().isVisible().catch(() => false)) return selector;
    await sleep(300);
  }
  throw new Error(`画面遷移を確認できません: ${selectors.join(", ")}`);
}

async function loginAndOpenBooking(page) {
  await page.goto(config.startUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (await isMaintenancePage(page)) throw new MaintenanceError();
  let frame = await getMenuFrame(page);
  if (await frame.locator("#txtKyoushuuseiNO").isVisible().catch(() => false)) {
    await frame.locator("#txtKyoushuuseiNO").fill(config.studentId);
    await frame.locator("#txtPassword").fill(config.password);
    await frame.locator("#btnAuthentication").click();
    await waitForOne(frame, ["#ddlWeeks", 'input[name="ctl00$MessageUpper$btnMenu_Kyoushuuyoyaku"]']);
  }
  frame = await getMenuFrame(page);
  const bookingMenu = frame.locator('input[name="ctl00$MessageUpper$btnMenu_Kyoushuuyoyaku"]');
  if (await bookingMenu.isVisible().catch(() => false)) {
    await bookingMenu.click();
    await waitForOne(frame, ["#ddlWeeks"]);
  }
  frame = await getMenuFrame(page);
  if (!(await frame.locator("#ddlWeeks").isVisible().catch(() => false))) {
    const body = await frame.locator("body").innerText().catch(() => "");
    if (/ログイン/.test(body)) throw new Error("ログインできません。番号またはパスワードを確認してください");
    throw new Error("教習予約の時限選択画面を開けません");
  }
  return frame;
}

async function readTarget(frame) {
  const bodyText = await frame.locator("body").innerText();
  return bodyText.match(/予約対象\s*([^\n]+)/)?.[1]?.trim() || "教習";
}

async function announceTarget(target) {
  if (target === currentTarget) return;
  const previous = currentTarget;
  currentTarget = target;
  await notify(previous ? "次の教習へ監視を継続します" : "教習予約の監視を開始しました", previous ? `予約対象が「${previous}」から「${target}」に変わりました。` : `予約対象：「${target}」`, 3, ["white_check_mark", "car"]).catch((error) => log(error.message));
}

async function refreshWeek(frame, optionValue) {
  const select = frame.locator("#ddlWeeks");
  if ((await select.inputValue()) !== optionValue) {
    await select.selectOption(optionValue);
    await waitForOne(frame, ["#ddlWeeks"]);
  } else {
    const reload = frame.locator("#btnReload");
    if (await reload.isVisible().catch(() => false)) {
      await reload.click();
      await waitForOne(frame, ["#ddlWeeks"]);
    }
  }
  await sleep(700);
}

function parseWeekStart(label) {
  const match = String(label || "").match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dateForDayIndex(weekLabel, dayIndex) {
  const start = parseWeekStart(weekLabel);
  if (!start) return "";
  start.setUTCDate(start.getUTCDate() + dayIndex);
  return `${start.getUTCFullYear()}/${String(start.getUTCMonth() + 1).padStart(2, "0")}/${String(start.getUTCDate()).padStart(2, "0")}`;
}

function timeRanges(text) {
  return [...String(text || "").matchAll(/(\d{1,2}):(\d{2})\s*[～~〜\-–—]\s*(\d{1,2}):(\d{2})/g)].map((match) => ({
    start: `${match[1].padStart(2, "0")}:${match[2]}`,
    end: `${match[3].padStart(2, "0")}:${match[4]}`,
  }));
}

function blockedOverlap(date, text) {
  const ranges = timeRanges(text);
  for (const block of config.blockedWindows.filter((item) => item.date === date)) {
    if (ranges.some((range) => range.start < block.end && block.start < range.end)) return block;
  }
  return null;
}

async function findVacancies(frame, target, weekLabel) {
  const result = [];
  const containers = frame.locator('[id^="lstDetail_"][id$="_lc"]');
  for (let i = 0; i < (await containers.count()); i += 1) {
    const container = containers.nth(i);
    const containerId = await container.getAttribute("id");
    const dayIndex = Number(containerId?.match(/lstDetail_(\d+)_lc/)?.[1] ?? i);
    const date = dateForDayIndex(weekLabel, dayIndex);
    const items = container.locator(":scope > *");
    for (let itemIndex = 0; itemIndex < (await items.count()); itemIndex += 1) {
      const item = items.nth(itemIndex);
      const itemText = normalize(await item.innerText().catch(() => ""));
      if (!itemText) continue;
      const details = normalize(`${date} ${itemText}`);
      result.push({ containerId, dayIndex, itemIndex, date, details, fingerprint: `${target}|${date}|${itemText}` });
    }
  }
  return result;
}

async function clickVacancy(frame, vacancy) {
  const item = frame.locator(`#${vacancy.containerId}`).locator(":scope > *").nth(vacancy.itemIndex);
  const dayHeader = frame.locator(`#lst_ih_${vacancy.dayIndex} + div .blocks`);
  if (!(await item.isVisible().catch(() => false)) && await dayHeader.count()) {
    await dayHeader.click({ force: true });
    await sleep(350);
  }
  const clickable = item.locator('button, input[type="submit"], a, [onclick], [role="button"]');
  if (await clickable.count()) await clickable.first().click({ force: true });
  else await item.click({ force: true });
  await sleep(800);
}

async function visibleActionControls(frame) {
  const controls = frame.locator('button, input[type="submit"], input[type="button"], a');
  const result = [];
  for (let i = 0; i < (await controls.count()); i += 1) {
    const control = controls.nth(i);
    if (!(await control.isVisible().catch(() => false))) continue;
    const label = normalize((await control.getAttribute("value")) || (await control.innerText().catch(() => "")));
    result.push({ control, label });
  }
  return result;
}

async function finishBooking(frame, vacancy, target) {
  for (let step = 0; step < 3; step += 1) {
    const bodyText = await frame.locator("body").innerText();
    if (/予約(が)?(完了|成立)|予約しました|予約されました|予約を受け付け/.test(bodyText)) return true;
    if (/以下の内容で予約してもよろしいですか/.test(bodyText)) {
      if (!bodyText.includes(vacancy.date) || !bodyText.includes(target)) {
        throw new Error(`予約確認内容が検出した枠と一致しません（予定: ${target} ${vacancy.details}）`);
      }
      const block = blockedOverlap(vacancy.date, bodyText);
      if (block) {
        log(`禁止時間と重なるため予約しません: ${vacancy.date} ${block.start}-${block.end} ${block.label}`);
        return false;
      }
    }
    const actions = await visibleActionControls(frame);
    const finalAction = actions.find(({ label }) => /^(予約|予約する|予約確定|確定する|確定|はい)$/.test(label));
    if (!finalAction) throw new Error(`予約確認ボタンを安全に特定できません（表示: ${actions.map(({ label }) => label).filter(Boolean).join(" / ") || "なし"}）`);
    if (!config.autoBook || Date.now() < config.autoBookNotBefore) {
      if (!dryRunSeen.has(vacancy.fingerprint)) {
        const reason = config.autoBook && Date.now() < config.autoBookNotBefore ? "手持ち予約の上限解除待ちのため、まだ確定していません。" : "試運転中のため、予約確定はしていません。";
        await notify("空き枠を発見しました（待機中）", `${target}\n${vacancy.details}\n${reason}`, 4, ["eyes", "car"]);
        dryRunSeen.add(vacancy.fingerprint);
      }
      return false;
    }
    frame.page().once("dialog", async (dialog) => {
      if (/予約|確定/.test(dialog.message())) await dialog.accept();
      else await dialog.dismiss();
    });
    await finalAction.control.click();
    await sleep(1_000);
  }
  throw new Error("予約完了の表示を確認できませんでした");
}

async function requestSameDayApproval(vacancy, target) {
  if (!config.publicBaseUrl) throw new Error("当日予約の承認に必要な公開URLを取得できません");
  if (Date.now() - (recentlyNotified.get(vacancy.fingerprint) || 0) < config.renotifyMs) return;
  const id = randomBytes(12).toString("hex");
  const token = randomBytes(32).toString("base64url");
  const approval = { id, token, target, details: vacancy.details, fingerprint: vacancy.fingerprint, expiresAt: Date.now() + config.approvalMs, approved: false, used: false };
  pendingApprovals.set(id, approval);
  recentlyNotified.set(vacancy.fingerprint, Date.now());
  const url = `${config.publicBaseUrl}/approve?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  await notify("当日分の空きがあります―承認が必要です", `${target}\n${vacancy.details}\nキャンセル料が発生する可能性があります。承認しない限り予約しません。`, 5, ["warning", "car"], [{ action: "view", label: "内容を確認して承認", url, clear: true }]);
  log(`当日予約の承認待ち: ${vacancy.details}`);
}

function cleanApprovals() {
  for (const [id, approval] of pendingApprovals) if (approval.used || Date.now() > approval.expiresAt) pendingApprovals.delete(id);
}

async function processApproved(frame, target) {
  const approval = [...pendingApprovals.values()].find((item) => item.approved && !item.used && item.target === target && Date.now() <= item.expiresAt);
  if (!approval) return false;
  const options = await frame.locator("#ddlWeeks option").evaluateAll((els) => els.map((el) => ({
    value: el.value,
    label: (el.textContent || "").replace(/\s+/g, " ").trim(),
  })));
  for (const option of options) {
    await refreshWeek(frame, option.value);
    const vacancy = (await findVacancies(frame, target, option.label)).find((item) => item.fingerprint === approval.fingerprint);
    if (!vacancy) continue;
    approval.used = true;
    await clickVacancy(frame, vacancy);
    const booked = await finishBooking(frame, vacancy, target);
    if (!booked) return true;
    await notify("承認した当日予約が完了しました", `${target}\n${vacancy.details}\n予約一覧でも確認してください。`, 5, ["tada", "car"]);
    return true;
  }
  approval.used = true;
  await notify("当日枠を予約できませんでした", `${target}\n${approval.details}\n承認後の再確認時には空きがなくなっていました。`, 4, ["warning", "car"]);
  return true;
}

async function monitor(page) {
  let frame = await loginAndOpenBooking(page);
  while (true) {
    try {
      if (await isMaintenancePage(page)) throw new MaintenanceError();
      frame = await getMenuFrame(page);
      if (!(await frame.locator("#ddlWeeks").isVisible().catch(() => false))) frame = await loginAndOpenBooking(page);
      const target = await readTarget(frame);
      await announceTarget(target);
      cleanApprovals();
      if (await processApproved(frame, target)) {
        await sleep(8_000);
        frame = await loginAndOpenBooking(page);
        continue;
      }
      const options = await frame.locator("#ddlWeeks option").evaluateAll((els) => els.map((el) => ({
        value: el.value,
        label: (el.textContent || "").replace(/\s+/g, " ").trim(),
      })));
      let booked = false;
      for (const option of options) {
        await refreshWeek(frame, option.value);
        for (const vacancy of await findVacancies(frame, target, option.label)) {
          const block = blockedOverlap(vacancy.date, vacancy.details);
          if (block) {
            log(`禁止時間と重なる空き枠を除外: ${vacancy.details} (${block.label})`);
            continue;
          }
          if (vacancy.date === tokyoDate()) {
            await requestSameDayApproval(vacancy, target);
            continue;
          }
          log(`空き枠を検出: ${target} ${vacancy.details}`);
          await clickVacancy(frame, vacancy);
          const result = await finishBooking(frame, vacancy, target);
          if (!result) {
            frame = await loginAndOpenBooking(page);
            continue;
          }
          await notify("教習予約が完了しました", `${target}\n${vacancy.details}\n予約一覧でも確認してください。`, 5, ["tada", "car"]);
          booked = true;
          break;
        }
        if (booked) break;
      }
      if (booked) {
        await sleep(8_000);
        frame = await loginAndOpenBooking(page);
        continue;
      }
    } catch (error) {
      const maintenance = error instanceof MaintenanceError || (await isMaintenancePage(page));
      if (maintenance) {
        log(`メンテナンス表示を検知。予約操作を行わず${Math.round(config.maintenanceRetryMs / 60_000)}分待機します`);
        await sleep(config.maintenanceRetryMs);
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        continue;
      }
      log(`監視エラー: ${error.message}`);
      if (Date.now() - lastErrorNoticeAt > 30 * 60_000) {
        lastErrorNoticeAt = Date.now();
        await notify("教習予約の監視でエラー", error.message, 4, ["warning", "car"]).catch(() => {});
      }
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    }
    await sleep(config.pollMs + Math.floor(Math.random() * 10_000));
  }
}

browser = await chromium.launch({ headless: config.headless, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo", viewport: { width: 390, height: 844 } });
const page = await context.newPage();

process.on("SIGTERM", async () => {
  log("終了要求を受信しました");
  server.close();
  await browser.close();
  process.exit(0);
});

monitor(page).catch(async (error) => {
  console.error(error);
  await notify("教習予約プログラムが停止しました", error.message, 5, ["rotating_light", "car"]).catch(() => {});
  server.close();
  await browser.close();
  process.exit(1);
});
