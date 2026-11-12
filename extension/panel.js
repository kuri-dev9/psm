// 업무등록 도우미 — 업무기록 앱(hr-report) 안에 패널을 붙인다.
// 계산은 core.js(= core.mjs 변환본)의 build() 를 그대로 쓴다.
// 조회·저장은 앱이 쓰는 API를 같은 출처에서 호출한다 (로그인 쿠키 + X-Platform-Et).
(() => {
  if (window.__pmsPanel) return;
  window.__pmsPanel = true;

  // 앱이 주소를 바꿔도 따라가도록 한 번만 읽지 않고 sync()에서 계속 읽는다.
  // et 는 document_start 에서 먼저 잡아 두고, 주소에서 사라져도 마지막 값을 쓴다.
  let BASE = "", et = "";
  function readUrl() {
    const m = location.pathname.match(/\/r\/([0-9a-f-]{20,})/);
    const t = new URLSearchParams(location.search).get("et");
    if (t) et = t;
    if (m) BASE = `${location.origin}/r/${m[1]}/api/timesheet`;
    return !!(m && et);
  }
  const DOW = ["일", "월", "화", "수", "목", "금", "토"];
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const md = (dt) => `${Number(dt.slice(5, 7))}/${dt.slice(8, 10)}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ───────── API ─────────
  async function api(path, opt = {}) {
    const url = `${BASE}/${path}${path.includes("?") ? "&" : "?"}et=${et}`;
    const r = await fetch(url, {
      credentials: "include", ...opt,
      headers: { ...(opt.headers || {}), "X-Platform-Et": et },
    });
    let j;
    try { j = await r.json(); } catch (e) { throw new Error(`HTTP ${r.status}`); }
    if (!j.success) throw new Error(j.message || `API 실패: ${path}`);
    return j.data;
  }

  // 동시에 n개까지만 호출한다. 결과 순서는 list 순서와 같다
  async function mapLimit(list, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length) { const k = i++; out[k] = await fn(list[k]); }
    }));
    return out;
  }

  // ───────── 설정 저장소 (확장이면 chrome.storage, 아니면 localStorage) ─────────
  const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  const store = {
    async get(k, d) {
      if (hasChrome) { const o = await chrome.storage.local.get(k); return o[k] ?? d; }
      const v = localStorage.getItem("pms:" + k); return v ? JSON.parse(v) : d;
    },
    async set(k, v) {
      if (hasChrome) return chrome.storage.local.set({ [k]: v });
      localStorage.setItem("pms:" + k, JSON.stringify(v));
    },
  };
  const DEFAULTS = {
    시간규칙: {
      기본: { 출근: "09:00", 퇴근: "18:00", 점심공제: true, 저녁공제: false },
      식대일: { 출근: "09:00", 퇴근: "21:00", 점심공제: true, 저녁공제: true },
      교통비일: { 출근: "09:00", 퇴근: "24:00", 점심공제: true, 저녁공제: true },
    },
    하루최대프로젝트: 2,
    WBS최대라인: 2,
    끝수연장: true,    // 반나절로 안 떨어지는 끝수를 연장근무로 붙여 MM 비율을 정확히 맞춘다
    하루최대연장: 2,   // 연장은 하루 이 시간(h)까지
  };

  // ───────── 상태 ─────────
  const now = new Date();
  const S = {
    year: now.getFullYear(), month: now.getMonth() + 1,
    tab: "summary", busy: "", msg: "", err: "",
    settings: null, mset: null,   // 전역 설정 / 월별 설정(휴가·반차·범위·유지)
    data: null,                   // projects, expenses, summary, hoursBy, dayInfo, designated
    R: null, F: null, changes: null, saveLog: null, colors: {}, sysHalf: {},
  };
  const mkey = () => `month:${S.year}-${pad(S.month)}`;

  const pick = (o, t) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === t));
  function makeCfg(withCutoff = true) {
    const today = ymd(new Date());
    const ym = `${S.year}-${pad(S.month)}`;
    const curYm = today.slice(0, 7);
    let cutoff = null;
    if (withCutoff && S.mset.범위 !== "all") cutoff = ym === curYm ? today : ym > curYm ? today : null;
    return {
      year: S.year, month: S.month,
      휴가일: S.mset.휴가일, 반차일: S.mset.반차일,
      // 시간일: 숫자면 그날 근무시간(h), 문자열이면 예전 방식의 규칙 이름
      시간지정: pick(S.mset.시간일, "string"), 근무시간지정: pick(S.mset.시간일, "number"),
      기준일: cutoff, 잠금일: withCutoff ? lockDates() : [], 지정시간: S.data?.designated || {},
      시간규칙: S.settings.시간규칙,
      하루최대프로젝트: S.settings.하루최대프로젝트,
      WBS최대라인: S.settings.WBS최대라인,
      끝수연장: !!S.settings.끝수연장, 하루최대연장: S.settings.하루최대연장,
    };
  }

  // ───────── 데이터 읽기 ─────────
  async function load() {
    S.busy = "데이터를 읽는 중…"; S.err = ""; S.changes = null; S.saveLog = null; render();
    try {
      // 복사본을 써야 설정을 바꿔도 DEFAULTS 가 오염되지 않는다
      S.settings = JSON.parse(JSON.stringify({ ...DEFAULTS, ...(await store.get("settings", {})) }));
      const savedM = await store.get(mkey(), null);
      // 잠금: 직접 정한 날만 { 날짜: true|false }. pms기록: 패널이 저장한 날의 지문 { 날짜: 지문 }
      S.mset = { 휴가일: [], 반차일: {}, 범위: "today", 수동일: [], 가져온일: [], 시간일: {}, 잠금: {}, pms기록: {}, ...(savedM || {}) };
      const { year, month } = S;
      // 이 달에 걸친 주(1일 + 매주 월요일)까지 한 번에 읽는다
      const lastDay = new Date(year, month, 0).getDate();
      const weekDays = [], workDates = [];
      for (let dd = 1; dd <= lastDay; dd++) {
        const w = new Date(year, month - 1, dd).getDay();
        if (dd === 1 || w === 1) weekDays.push(dd);
        if (w !== 0 && w !== 6) workDates.push(`${year}-${pad(month)}-${pad(dd)}`);
      }
      const [projects, expenses, summary, weeks, validProcs, dayList, mwt] = await Promise.all([
        api(`projects?year=${year}&month=${month}`),
        api(`expenses?year=${year}&month=${month}`),
        api(`month-summary?year=${year}&month=${month}`),
        Promise.all(weekDays.map((dd) => api(`week?date=${year}-${pad(month)}-${pad(dd)}`))),
        api("process-codes").then((l) => new Set(l.map((c) => c.etcNm))).catch(() => null),
        // 평일마다 등록된 줄·출퇴근·지정 근무시간을 읽는다 (누가 입력했는지 판단과 출퇴근 동기화에 쓴다)
        mapLimit(workDates, 6, (dt) => api(`day?date=${dt}`)),
        api(`monthly-work-time?yyyymm=${year}${pad(month)}`).catch(() => null),
      ]);
      const dayInfo = Object.fromEntries(workDates.map((dt, k) => [dt, dayList[k]]));
      // 시스템 기본값이 아닌, 등록된 근무시간만 쓴다
      const designated = {};
      for (const [dt, d] of Object.entries(dayInfo)) {
        const z = d.designated;
        if (z && !z.isDefault && z.clockIn && z.clockOut) designated[dt] = { 출근: z.clockIn, 퇴근: z.clockOut };
      }
      await syncLeave(summary.days || [], dayInfo);
      // 프로젝트별 실적을 모은다
      const hoursBy = {}, seen = new Set();
      const names = Object.fromEntries(projects.map((p) => [p.pjtCd, p.pjtNm]));
      for (const wk of weeks) {
        if (seen.has(wk.monday)) continue;
        seen.add(wk.monday);
        for (const r of wk.rows || []) {
          names[r.pjtCd] ||= r.pjtNm;
          for (const [k, v] of Object.entries(r.hoursByDate || {})) {
            if (k.startsWith(`${year}-${pad(month)}`)) (hoursBy[r.pjtCd] ||= {})[k] = v;
          }
        }
      }
      const active = projects.filter((p) => (p.wbsLines || []).some((w) => w.mm?.[month - 1] > 0)).map((p) => p.pjtCd);
      await assignColors([...new Set([...active, ...Object.keys(hoursBy)])].sort());
      S.data = { projects, expenses, summary, hoursBy, validProcs, names, dayInfo, designated, mwt };
      recompute();
      if (S.tab === "plan") scheduleChanges();
    } catch (e) {
      S.err = `읽기 실패: ${e.message}`;
    }
    S.busy = ""; render();
  }

  // 시스템에 저장된 연차·반차를 읽을 때마다 달력에 맞춘다.
  // 패널에서 직접 바꾼 날(수동일)은 건드리지 않고, 시스템에서 지워진 휴가는 가져온 날만 뺀다.
  async function syncLeave(days, dayInfo = {}) {
    const m = S.mset, manual = new Set(m.수동일);
    const sys = new Map(days.filter((d) => d.dayGubun === "104" || d.dayGubun === "105").map((d) => [d.date, d.dayGubun]));
    for (const dt of m.가져온일) {
      if (sys.has(dt) || manual.has(dt)) continue;
      m.휴가일 = m.휴가일.filter((x) => x !== dt);
      delete m.반차일[dt];
    }
    m.가져온일 = [];
    S.sysHalf = {};
    for (const [dt, gubun] of sys) {
      if (gubun === "105") {
        const day = dayInfo[dt] || await api(`day?date=${dt}`);
        // 라벨이 없으면 출근 시각으로 본다: 오후에 출근했으면 오전 반차
        S.sysHalf[dt] = (day.leaveLabel || "").match(/오전|오후/)?.[0] || ((day.clockIn || "") >= "12:00" ? "오전" : "오후");
      }
      if (manual.has(dt)) continue;
      m.가져온일.push(dt);
      if (gubun === "104") {
        delete m.반차일[dt];
        if (!m.휴가일.includes(dt)) m.휴가일.push(dt);
      } else {
        m.휴가일 = m.휴가일.filter((x) => x !== dt);
        m.반차일[dt] = S.sysHalf[dt];
      }
    }
    m.휴가일.sort();
    await store.set(mkey(), m);
  }

  function recompute() {
    const { projects, expenses, summary, hoursBy } = S.data;
    const weekRows = {};
    for (const [cd, m] of Object.entries(hoursBy)) for (const [dt, h] of Object.entries(m)) (weekRows[dt] ||= []).push({ pjtCd: cd, hours: h });
    S.R = build(makeCfg(true), { projects, expenses, summary, weekRows });
    S.F = build(makeCfg(false), { projects, expenses, summary, weekRows: {} });
    // 기존 계획: 시스템에 있는 휴가만 반영한 계획. 패널에서 바꾼 휴가·근무시간이 없을 때의 모습이다
    const sys = (g) => (summary.days || []).filter((d) => d.dayGubun === g).map((d) => d.date);
    S.B = build({ ...makeCfg(true), 휴가일: sys("104"), 반차일: S.sysHalf, 시간지정: {}, 근무시간지정: {} }, { projects, expenses, summary, weekRows });
    S.changes = null; S.calc = false; calcSeq++;
  }

  // ───────── 잠금 (잠긴 날은 계획·저장에서 기록을 그대로 둔다) ─────────
  // 서버는 누가 입력했는지 알려주지 않으므로, 패널이 저장한 결과의 지문과 지금 기록이 같으면 PMS 입력으로 본다
  const fpOf = (day) => JSON.stringify([day.dayGubun || null, day.clockIn || null, day.clockOut || null,
    (day.items || []).map((x) => [x.actIdx, x.pjtCd, x.taskNm || "", Number(x.hours)].join("|")).sort()]);
  const sumDay = (dt) => (S.data.summary.days || []).find((x) => x.date === dt);
  const hoursOf = (dt) => sumDay(dt)?.totalHours || 0;
  const pmsMade = (dt) => { const d = S.data.dayInfo?.[dt]; return !!(d && S.mset.pms기록[dt] === fpOf(d)); };
  // 기록이 있는 날만 잠글 수 있다. 직접 정하지 않았으면 사용자가 입력한 날은 잠그고 PMS가 입력한 날은 연다
  // 시스템에 연차로 등록된 날은 잠그지 않는다
  const canLockDay = (dt) => hoursOf(dt) > 0 && sumDay(dt)?.dayGubun !== "104";
  const isLocked = (dt) => canLockDay(dt) && (dt in S.mset.잠금 ? S.mset.잠금[dt] : !pmsMade(dt));
  const lockDates = () => (S.data?.summary.days || []).map((x) => x.date).filter(isLocked);

  async function saveMonthSettings() {
    await store.set(mkey(), S.mset); recompute();
    if (S.tab === "plan") scheduleChanges();
    render();
  }

  // 달력을 연달아 눌러도 마지막 상태로 한 번만 계산한다. 계산 중에도 달력은 계속 누를 수 있고, 늦게 끝난 결과는 버린다
  let calcSeq = 0, calcTimer = null;
  function scheduleChanges() {
    S.calc = true;
    clearTimeout(calcTimer);
    calcTimer = setTimeout(() => (S.busy ? scheduleChanges() : computeChanges()), 250);
  }

  // ───────── 프로젝트 색상 (달이 바뀌어도 같은 프로젝트는 같은 색) ─────────
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  async function assignColors(codes) {
    const map = await store.get("colors", {});
    const used = new Set(codes.filter((c) => c in map).map((c) => map[c]));
    for (const c of codes) {
      if (c in map) continue;
      let i = 0;
      while (used.has(i)) i++;
      map[c] = i; used.add(i);
    }
    await store.set("colors", map);
    S.colors = map;
  }
  const pcolor = (cd) => PALETTE[S.colors[cd]] || "#9aa3b2"; // 8색을 넘거나 미배정이면 회색
  const pname = (cd) => (cd === "(미배정)" ? "미배정 (하루 한도 초과)" : S.data.names[cd] || cd);

  // 날짜별 프로젝트 시간: [{ cd, h }]
  const regOf = (dt) => Object.entries(S.data.hoursBy).filter(([, m]) => m[dt] > 0).map(([cd, m]) => ({ cd, h: m[dt] }));
  const sumH = (list) => list.reduce((t, x) => t + x.h, 0);
  function planOf(d) {
    const out = [];
    for (const i of d.items || []) {
      let g = out.find((x) => x.cd === i.pjtCd);
      if (!g) out.push((g = { cd: i.pjtCd, h: 0, tk: i.line?.taskNm }));
      g.h += toH(i.half);
    }
    return out;
  }
  // 달력 막대의 내용: 프로젝트는 { cd, h }, 휴가는 { lv, h }. 왼쪽이 오전이므로 오전 반차는 앞에 둔다
  const withHalf = (list, type) => (type === "오전" ? [{ lv: "반차", h: 4 }, ...list] : [...list, { lv: "반차", h: 4, pm: true }]);
  function existingOf(dt) {
    const s = (S.data.summary.days || []).find((x) => x.date === dt), reg = regOf(dt);
    if (s?.dayGubun === "104") return [{ lv: "연차", h: 8 }];
    return s?.dayGubun === "105" ? withHalf(reg, S.sysHalf[dt]) : reg;
  }
  // 기존 계획: 등록된 내용, 없으면 예상 계획
  function baseOf(dt) {
    const exist = existingOf(dt);
    if (exist.length) return exist;
    const d = S.B.days.find((x) => x.date === dt);
    return d?.items ? (d.halfType ? withHalf(planOf(d), d.halfType) : planOf(d)) : [];
  }
  // 저장했을 때의 모습. 저장 대상이 아닌 날(유지·본인 확인 완료·미래)은 null
  function targetOf(d) {
    if (!d || (S.data.summary.days || []).some((x) => x.date === d.date && x.confirmed)) return null;
    if (d.vacationOnly) return [{ lv: "연차", h: 8 }];
    if (!d.items || d.locked) return null;
    return d.halfType ? withHalf(planOf(d), d.halfType) : planOf(d);
  }
  // 변경 계획: 기존 계획과 달라질 때만 내용이 있다
  function pendingOf(d) {
    const want = targetOf(d);
    if (!want) return [];
    const key = (l) => `${l[0]?.lv || ""}|${l.map((x) => `${x.cd || x.lv}:${x.h}`).sort().join()}`;
    return key(want) === key(baseOf(d.date)) ? [] : want;
  }

  // ───────── 변경안 (기존 줄의 행 ID를 살려서 고친다) ─────────
  const effProc = (nm) => (!nm ? "" : !S.data.validProcs || S.data.validProcs.has(nm) ? nm : "");
  function buildBody(d, day) {
    if (d.vacationOnly) {
      return { body: { date: d.date, dayGubun: "104", clockIn: "09:00", clockOut: "18:00", leaveHours: 8, leaveLabel: "연차",
        lunch: true, dinner: false, deductHours: 0, items: [] }, ops: (day.items || []).map((x) => ({ op: "삭제", x })) };
    }
    const pjtInfo = Object.fromEntries(S.data.projects.map((p) => [p.pjtCd, p]));
    const pool = [...(day.items || [])];
    const take = (pred) => { const k = pool.findIndex(pred); return k < 0 ? null : pool.splice(k, 1)[0]; };
    const want = d.items.map((w) => ({ ...w, h: toH(w.half) }));
    const matched = new Map(), ops = [], items = [];
    for (const w of want) { const x = take((e) => e.pjtCd === w.pjtCd && e.taskNm === (w.line?.taskNm || "")); if (x) matched.set(w, x); }
    for (const w of want) { if (matched.has(w)) continue; const x = take((e) => e.pjtCd === w.pjtCd); if (x) matched.set(w, x); }
    for (const w of want) {
      const x = matched.get(w);
      const line = { procNm: w.line?.procNm || "", itemNm: w.line?.itemNm || "", taskNm: w.line?.taskNm || "" };
      if (x) {
        const same = x.taskNm === line.taskNm && Number(x.hours) === w.h && (x.procNm || "") === effProc(line.procNm);
        items.push({ ...x, ...line, workTy: x.taskNm === line.taskNm ? x.workTy : null, hours: w.h });
        ops.push({ op: same ? "유지" : "수정", x, w, line });
      } else {
        const p = pjtInfo[w.pjtCd] || {};
        items.push({ actIdx: null, pjtCd: w.pjtCd, pjtNm: p.pjtNm, pjtTy: p.pjtTy, workTy: null, ...line, workDetail: "", hours: w.h });
        ops.push({ op: "추가", w, line });
      }
    }
    for (const x of pool) ops.push({ op: "삭제", x });
    const body = { date: d.date, dayGubun: d.gubun, clockIn: d.출근, clockOut: d.퇴근, lunch: !!d.점심, dinner: !!d.저녁, deductHours: 0, items };
    if (d.gubun === "105") { body.leaveHours = 4; body.leaveLabel = `${d.halfType || "오전"} 반차`; }
    return { body, ops };
  }

  async function computeChanges() {
    const my = ++calcSeq;
    const same = S.calc && !S.changes && !S.err;
    S.calc = true; S.err = ""; S.changes = null;
    if (!same) render();
    try {
      const out = [];
      const targets = S.R.days.filter((d) => (!d.skip || d.vacationOnly) && !d.locked);
      // 기록이 있는 날만 줄 목록을 읽는다. 기록 여부는 계산할 때마다 새로 확인한다.
      // 읽기에 실패한 날을 빈 날로 치면 저장 때 기존 줄이 지워지므로 실패는 그대로 오류로 낸다.
      const { year, month } = S;
      const fresh = await api(`month-summary?year=${year}&month=${month}`);
      const recorded = new Set((fresh.days || []).filter((x) => x.totalHours || x.dayGubun).map((x) => x.date));
      const days = await mapLimit(targets, 6, (d) => (recorded.has(d.date) ? api(`day?date=${d.date}`) : { items: [] }));
      targets.forEach((d, k) => {
        const day = days[k];
        const { body, ops } = buildBody(d, day);
        const headerSame = day.dayGubun === body.dayGubun && (d.vacationOnly ||
          (day.clockIn === body.clockIn && day.clockOut === body.clockOut && !!day.dinner === body.dinner));
        if (headerSame && ops.every((o) => o.op === "유지")) return;
        // 본인 확인이 끝난 날은 바뀌어야 해도 건드리지 않는다
        out.push({ d, body, ops, locked: !!day.confirmed });
      });
      if (my !== calcSeq) return;
      S.changes = out;
    } catch (e) {
      if (my !== calcSeq) return;
      S.err = `변경안 계산 실패: ${e.message}`;
    }
    S.calc = false; render();
  }

  // ───────── 시스템의 월 기본 근무시간 ─────────
  // 저장 API를 쓰지 않고 업무기록 화면의 입력란을 바꿔 그 화면의 [저장]을 누른다
  function baseBar() {
    const label = [...document.querySelectorAll("body *")].find((e) => !e.children.length && e.textContent.includes("기본 근무시간"));
    let box = label;
    while (box && box.querySelectorAll("select").length < 2) box = box.parentElement;
    if (!box) return null;
    const [inSel, outSel] = box.querySelectorAll("select");
    const save = [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === "저장");
    return save ? { month: Number(label.textContent.match(/(\d+)월/)?.[1]), inSel, outSel, save } : null;
  }
  const optionOf = (sel, t) => [...sel.options].find((o) => o.value === t || o.textContent.trim() === t);
  const selText = (sel) => sel.selectedOptions[0]?.textContent.trim() || sel.value;
  // 화면이 이 달을 보여주고 있고 패널의 기본 시간과 다를 때만 값이 있다.
  // 시스템에 근무시간이 등록돼 있으면 그 값을 따르므로 덮어쓰지 않는다
  function baseDiff() {
    if (S.data?.mwt && !S.data.mwt.isDefault) return null;
    const b = baseBar(), t = S.settings?.시간규칙.기본;
    if (!b || !t || b.month !== S.month) return null;
    return selText(b.inSel) === t.출근 && selText(b.outSel) === t.퇴근 ? null : { from: `${selText(b.inSel)}~${selText(b.outSel)}`, to: `${t.출근}~${t.퇴근}` };
  }
  // React가 값 변경을 알아채도록 객체에 덮인 setter가 아니라 원래 setter로 넣는다
  function setSelect(sel, t) {
    const o = optionOf(sel, t);
    if (!o) throw new Error(`화면에 ${t} 선택지가 없습니다`);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, o.value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function waitFor(ok, ms) {
    for (let t = 0; t < ms; t += 100) {
      if (ok()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return ok();
  }
  async function applyBaseTime() {
    const t = S.settings.시간규칙.기본;
    let b = baseBar();
    setSelect(b.inSel, t.출근);
    await waitFor(() => selText(baseBar().inSel) === t.출근, 1000);
    b = baseBar();
    setSelect(b.outSel, t.퇴근);
    if (!await waitFor(() => !baseBar().save.disabled, 2000)) throw new Error("화면의 [저장] 버튼이 켜지지 않습니다");
    baseBar().save.click();
    // 저장이 끝나면 화면의 버튼이 다시 꺼진다
    if (!await waitFor(() => baseBar()?.save.disabled, 5000)) throw new Error("저장 완료를 확인하지 못했습니다. 화면을 확인해 주세요");
  }

  async function doSave() {
    const list = (S.changes || []).filter((c) => !c.locked);
    if (!list.length) return;
    const base = baseDiff();
    if (!confirm(`${list.length}일을 저장합니다.\n${base ? `시스템 기본 근무시간도 ${base.to}(으)로 바꿉니다.\n` : ""}기존 줄은 행 ID를 유지한 채 수정하고, 초기화는 하지 않습니다.\n'확인'(본인 확인) 처리는 하지 않습니다.\n\n계속할까요?`)) return;
    S.busy = "저장 중…"; render();
    let baseErr = "";
    if (base) { try { await applyBaseTime(); } catch (e) { baseErr = `기본 근무시간 변경 실패: ${e.message}`; } }
    const log = [];
    for (const c of list) {
      try {
        await api("save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.body) });
        const after = await api(`day?date=${c.d.date}`);
        const got = (after.items || []).reduce((t, x) => t + Number(x.hours), 0);
        const ids = new Set((after.items || []).map((x) => x.actIdx));
        const reused = c.ops.filter((o) => o.op === "유지" || o.op === "수정");
        const kept = reused.filter((o) => ids.has(o.x.actIdx)).length;
        const ok = c.d.vacationOnly ? after.dayGubun === "104" : got === toH(c.d.half);
        // 저장된 결과를 PMS 입력으로 기억한다. 직접 정한 잠금은 풀어서 기본값(PMS 입력 = 열림)으로 돌린다
        if (ok) { S.mset.pms기록[c.d.date] = fpOf(after); delete S.mset.잠금[c.d.date]; }
        log.push({ date: c.d.date, ok, text: c.d.vacationOnly ? "연차" : `${got}h`, kept, reused: reused.length });
      } catch (e) {
        log.push({ date: c.d.date, ok: false, text: e.message });
      }
      S.busy = `저장 중… ${log.length}/${list.length}`; render();
    }
    S.busy = "";
    const done = new Set(log.filter((l) => l.ok).map((l) => l.date));
    S.mset.수동일 = S.mset.수동일.filter((x) => !done.has(x));
    await store.set(mkey(), S.mset);
    await load();
    S.saveLog = log; S.err = baseErr; S.tab = "plan"; render();
  }

  // ───────── 화면 ─────────
  const host = document.createElement("div");
  host.id = "pms-helper-host";
  const root = host.attachShadow({ mode: "open" });
  let open = false;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; background: #1f3a6b; color: #fff;
    border: 0; border-radius: 22px; padding: 10px 16px; font-size: 13px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .panel { position: fixed; top: 0; right: 0; width: 460px; max-width: 100vw; height: 100vh; z-index: 2147483647;
    background: #fff; color: #1d2433; box-shadow: -6px 0 24px rgba(0,0,0,.18); display: flex; flex-direction: column; font-size: 13px; }
  .hd { background: #1f3a6b; color: #fff; padding: 12px 14px; display: flex; align-items: center; gap: 8px; }
  .hd b { font-size: 14px; flex: 1; }
  .hd button { background: rgba(255,255,255,.15); color: #fff; border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer; font-size: 13px; }
  .tabs { display: flex; border-bottom: 1px solid #e3e7ef; }
  .tabs button { flex: 1; padding: 9px 0; border: 0; background: none; cursor: pointer; font-size: 13px; color: #6b7487; border-bottom: 2px solid transparent; }
  .tabs button.on { color: #1f3a6b; font-weight: 700; border-bottom-color: #1f3a6b; }
  .body { flex: 1; overflow: auto; padding: 14px; }
  .sec { margin-bottom: 16px; }
  .sec h4 { margin: 0 0 7px; font-size: 13px; color: #1f3a6b; }
  .box { background: #f5f7fb; border-radius: 8px; padding: 10px 12px; line-height: 1.65; }
  .big { font-size: 20px; font-weight: 800; color: #1f3a6b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 4px; border-bottom: 1px solid #eef1f6; text-align: right; white-space: nowrap; }
  th { color: #6b7487; font-weight: 600; background: #fafbfd; }
  td:first-child, th:first-child { text-align: left; }
  .pjt { table-layout: fixed; }
  .pjt th:first-child { width: 30%; }
  .pjt .pn td { border-bottom: 0; padding-bottom: 0; }
  .pjt .pv td { padding-top: 2px; }
  .pj { display: flex; align-items: center; gap: 5px; min-width: 0; line-height: 1.5; }
  .pj .dot { flex: none; width: 9px; height: 9px; border-radius: 3px; }
  .pj .cd { flex: none; color: #8a92a3; font-size: 11px; }
  .pj .nm { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pj .tk { flex: 1 1 0; min-width: 40px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8a92a3; font-size: 11px; }
  .pj .hr { flex: none; margin-left: auto; padding-left: 6px; }
  .bar { height: 5px; background: #e8ecf3; border-radius: 3px; margin-top: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: #2f6fd6; }
  .pmini { margin-top: 10px; display: grid; gap: 3px; }
  .pmini .pm { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .pmini .dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
  .pmini .cd { color: #6b7385; width: 58px; flex: none; }
  .pmini .bar { flex: 1; margin-top: 0; height: 6px; }
  .pmini .bar { display: flex; }
  .pmini .bar i.est { opacity: .35; }
  .pmini .pc { width: 32px; text-align: right; font-weight: 600; flex: none; }
  .pmini .pe { width: 44px; text-align: right; color: #8a92a3; flex: none; }
  .over { color: #c0392b; } .ok { color: #1e8e5a; } .dim { color: #8a92a3; }
  .cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
  .cal .dw { text-align: center; font-size: 11px; color: #8a92a3; padding: 2px 0; }
  .cal .c { display: flex; flex-direction: column; min-width: 0; border: 1px solid #e3e7ef; border-radius: 6px; min-height: 46px; padding: 2px 3px; font-size: 11px; cursor: pointer; background: #fff; }
  .cal.ro .c { cursor: default; }
  .cal.ro .c[data-lock] { cursor: pointer; }
  .cal .top .lk { font-size: 9px; line-height: 1; }
  .cal .c.off { background: #f3f4f7; color: #b6bcc8; cursor: default; }
  .cal .c.hol { background: #fdeeee; color: #c0392b; cursor: default; }
  .cal .c.vac { background: #ede7fb; border-color: #b9a6ec; }
  .cal .c.half { background: #e6f1fd; border-color: #9cc3ef; }
  .cal .c.fut { opacity: .55; }
  .cal .c b { display: block; font-size: 12px; }
  .hb { display: flex; gap: 2px; height: 7px; margin-top: 3px; }
  .hb i { display: block; min-width: 3px; border-radius: 4px; }
  .hb.est i { opacity: .4; }
  .hb.chg i { opacity: .8; }
  .key i.gone { background: repeating-linear-gradient(135deg, #cfd3db 0 2px, #f0f1f4 2px 4px) !important; }
  .hb.gone i { opacity: .4; background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.75) 0 2px, rgba(255,255,255,.2) 2px 4px) !important; }
  .hb.r { justify-content: flex-end; }
  .cal .hb { height: 12px; margin-top: 2px; }
  .hb i { overflow: hidden; white-space: nowrap; }
  .cal .hb i.lv { color: #fff; font-size: 9px; font-weight: 600; font-style: normal; line-height: 12px; text-align: center; letter-spacing: -.3px;
    background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.15) 0 2px, transparent 2px 4px); text-shadow: 0 0 2px rgba(0,0,0,.35); }
  /* 바뀌는 날은 사라질 줄을 얇게 해서 칸 높이가 변하지 않게 한다 */
  .cal .hb.gone { height: 5px; }
  .cal .hb.gone i.lv { font-size: 0; }
  .hb i.lv { background-image: repeating-linear-gradient(135deg, rgba(255,255,255,.45) 0 2px, transparent 2px 4px); }
  .cal .top { display: flex; align-items: center; gap: 2px; min-height: 15px; }
  .cal .top .hrs { margin-left: auto; font-size: 10px; color: #8a92a3; }
  .cal .top select.hrs { appearance: none; -webkit-appearance: none; border: 1px solid transparent; background: transparent; font: inherit; font-size: 10px; color: #8a92a3;
    padding: 0 2px; border-radius: 3px; cursor: pointer; text-align: right; max-width: 34px; }
  .cal .top select.hrs:hover, .cal .top select.hrs:focus { background: #dfe5f0; color: #1f3a6b; border-color: #b8c4da; outline: none; }
  .cal .top select.hrs.set { color: #1f3a6b; font-weight: 600; }
  .exp { align-self: flex-start; margin-top: auto; width: 14px; height: 14px; line-height: 14px; border-radius: 50%; text-align: center;
    background: #5a6478; color: #fff; font-size: 9px; font-weight: 700; }
  .key { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 6px; font-size: 11px; color: #6b7487; }
  .key span { display: flex; align-items: center; gap: 4px; }
  .key i { display: block; width: 18px; height: 7px; border-radius: 2px; background: #2a78d6; }
  .key i.lt { opacity: .4; }
  .key i.ch { opacity: .8; }
  .key i.lv-key { background: repeating-linear-gradient(135deg, rgba(255,255,255,.45) 0 2px, transparent 2px 4px), #7a5bd6; }
  .key .exp { margin-top: 0; }
  .tag { display: inline-block; font-size: 10px; border-radius: 4px; padding: 0 4px; margin-top: 2px; white-space: nowrap; }
  .cal .tag { padding: 0 2px; text-align: center; overflow: hidden; text-overflow: ellipsis; }
  .cal .hn { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag.v { background: #7a5bd6; color: #fff; } .tag.h { background: #2f6fd6; color: #fff; } .tag.x { background: #f0a020; color: #fff; }
  .row { display: flex; align-items: center; gap: 8px; margin: 6px 0; flex-wrap: wrap; }
  .row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  select, input[type=number] { padding: 3px 5px; border: 1px solid #ccd3e0; border-radius: 5px; font-size: 12px; }
  .btn { border: 1px solid #ccd3e0; background: #fff; border-radius: 7px; padding: 7px 12px; cursor: pointer; font-size: 13px; }
  .btn.pri { background: #1f3a6b; color: #fff; border-color: #1f3a6b; font-weight: 700; }
  .btn:disabled { opacity: .45; cursor: default; }
  .ops { font-size: 12px; line-height: 1.7; }
  .ops .d { display: flex; align-items: center; gap: 5px; font-weight: 700; margin-top: 6px; }
  .ops .d .dim { margin-left: auto; font-weight: 400; font-size: 11px; }
  .ops .d .tag { margin-top: 0; font-weight: 400; }
  .ops .pj .sg { flex: none; width: 12px; text-align: center; color: #b26a00; font-weight: 700; }
  .ops .est, .ops .est .nm { color: #6b7487; }
  .ops .est .dot { opacity: .45; }
  .ops .chg, .ops .chg .nm { color: #b26a00; }
  .ops .fu { opacity: .55; }
  .ops .gone, .ops .gone .nm, .ops .gone .cd, .ops .gone .tk { color: #c3c7d0; }
  .ops .gone .dot { background: #dfe2e8 !important; }
  .ops .pj .nm { flex: 1 1 60px; }
  .ops .pj .tk { flex: 0 1 auto; min-width: 0; max-width: 40%; }
  .busy { padding: 8px 12px; background: #fff7e0; color: #8a6300; font-size: 12px; }
  .err { padding: 8px 12px; background: #fdeeee; color: #c0392b; font-size: 12px; }
  .note { font-size: 11px; color: #8a92a3; margin-top: 6px; line-height: 1.5; }
  .ft { border-top: 1px solid #e3e7ef; padding: 10px 14px; display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
  .ft .note { flex: 1; margin: 0; }
  .tip { position: fixed; z-index: 2147483647; max-width: 340px; padding: 6px 9px; border-radius: 6px; background: #1d2433; color: #fff;
    font-size: 12px; line-height: 1.5; white-space: pre-line; pointer-events: none; box-shadow: 0 3px 10px rgba(0,0,0,.25); }
  `;

  function render() {
    hideTip();
    const top = root.querySelector(".body")?.scrollTop || 0; // 다시 그려도 보던 위치를 유지한다
    if (!root.querySelector(".app")) root.innerHTML = `<style>${CSS}</style><div class="app"></div><div class="tip" hidden></div>`;
    root.querySelector(".app").innerHTML = open ? panelHtml() : `<button class="fab" data-a="open">업무등록 도우미</button>`;
    const body = root.querySelector(".body");
    if (body) body.scrollTop = top;
  }

  function panelHtml() {
    const tabs = [["summary", "요약"], ["plan", "계획·저장"], ["settings", "설정"]];
    let body = "";
    if (!S.data) body = `<div class="dim">${S.busy || "불러오는 중…"}</div>`;
    else if (S.tab === "summary") body = summaryHtml();
    else if (S.tab === "plan") body = planHtml();
    else body = settingsHtml();
    return `<div class="panel">
      <div class="hd"><button data-a="prev">‹</button><b>${S.year}년 ${S.month}월</b><button data-a="next">›</button>
        <button data-a="reload" title="다시 읽기">↻</button><button data-a="close">✕</button></div>
      <div class="tabs">${tabs.map(([k, t]) => `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}">${t}</button>`).join("")}</div>
      ${S.busy ? `<div class="busy">${esc(S.busy)}</div>` : ""}${S.err ? `<div class="err">${esc(S.err)}</div>` : ""}
      <div class="body">${body}</div>
      ${S.data ? (S.tab === "plan" ? planFooter() : S.tab === "settings" ? settingsFooter() : "") : ""}
    </div>`;
  }

  // ── 요약: 최종 근무시간 대비 프로젝트별 실적 ──
  function summaryHtml() {
    const { F, R } = S;
    const { hoursBy } = S.data;
    const finalH = toH(F.totalHalf);
    const vacN = F.days.filter((d) => d.vacationOnly).length;
    const halfN = F.workdays.filter((d) => d.gubun === "105").length;
    const bizN = F.workdays.length + vacN;
    const extraH = F.workdays.reduce((t, d) => t + (d.rule === "기본" ? 0 : toH(d.half) - (d.rule === "반차" ? 4 : 8)), 0);
    const tH = Object.values(hoursBy).flatMap((m) => Object.values(m)).reduce((a, b) => a + b, 0);
    const done = new Set(Object.values(hoursBy).flatMap((m) => Object.keys(m)));
    const left = F.workdays.filter((d) => !done.has(d.date));
    const exp = Object.entries(S.data.expenses.dayBadges || {});
    return `
      <div class="sec">${calHtml(false)}
        <div class="key"><span><i></i> 등록한 시간 (8h = 칸 전체, 왼쪽 오전 · 오른쪽 오후)</span><span><i class="lv-key"></i> 연차·반차</span><span><span class="exp">₩</span> 지출 있음</span><span>🔒 잠금 — 기록 있는 날을 눌러 잠금·해제</span></div>
        <div class="note">직접 입력한 날은 잠그고, PMS가 입력한 날은 풀어 둡니다. 잠긴 날은 저장할 때 그대로 둡니다.</div></div>
      <div class="sec"><h4>내 최종 근무시간</h4><div class="box">
        <span class="big">${finalH}h</span> <span class="dim">= ${F.totalMM.toFixed(3)} MM</span><br>
        영업일 ${bizN}일 × 8h${vacN ? ` − 연차 ${vacN}일 × 8h` : ""}${halfN ? ` − 반차 ${halfN}일 × 4h` : ""}${extraH > 0 ? ` + 추가근무 ${extraH}h` : extraH < 0 ? ` − 단축근무 ${-extraH}h` : ""}<br>
        현재 입력 <b>${tH}h</b> · 남은 <b>${finalH - tH}h</b>${left.length ? ` · 남은 근무일 ${left.length}일` : ""}
      </div></div>
      <div class="sec"><h4>프로젝트별 실적</h4>
        ${projTableHtml()}
        <div class="note">목표 = 최종 근무시간 × MM 비율 (30분 단위, 합계 일치). 남음의 '+'는 목표 초과분.</div>
      </div>
      <div class="sec"><h4>등록된 지출</h4><div class="box">${exp.length ? exp.map(([dt, l]) => `${md(dt)} ${l.map((b) => esc(b.cat)).join("·")}`).join("<br>") : '<span class="dim">없음</span>'}</div>
        <div class="note">야근식대비 날은 ${S.settings.시간규칙.식대일.퇴근}까지, 교통비 날은 ${S.settings.시간규칙.교통비일.퇴근}까지로 계획합니다.</div></div>`;
  }

  // ── 프로젝트별 실적 표 (요약 탭·계획 탭 공용) ──
  function projTableHtml() {
    const { F } = S;
    const { hoursBy } = S.data;
    const rows = [...F.projs].sort((a, b) => b.mm - a.mm).map((p) => {
      const t = toH(p.mmHalf);
      const h = Object.values(hoursBy[p.pjtCd] || {}).reduce((a, b) => a + b, 0);
      const rest = t - h, rate = t ? Math.round((h / t) * 100) : 0;
      return `<tr class="pn"><td colspan="6">${pjHtml(p.pjtCd)}</td></tr>
        <tr class="pv"><td><div class="bar"><i style="width:${Math.min(100, rate)}%;background:${pcolor(p.pjtCd)}"></i></div></td>
        <td>${p.mm.toFixed(3)}</td><td>${t}h</td><td>${h}h</td>
        <td class="${rest < 0 ? "over" : rest === 0 ? "ok" : ""}">${rest < 0 ? "+" + -rest : rest}h</td><td>${rate}%</td></tr>`;
    });
    return `<table class="pjt"><tr><th>프로젝트</th><th>배정MM</th><th>목표</th><th>실적</th><th>남음</th><th>달성</th></tr>${rows.join("")}</table>`;
  }

  // ── 계획 탭 달력 아래의 간단한 실적: 한 줄에 코드 · 달성 막대 · % (이름과 시간은 툴팁) ──
  function projMiniHtml() {
    const { hoursBy } = S.data;
    // 최종 예상: 계획대로 저장될 날(잠금·본인 확인 완료가 아닌 날)은 계획 시간, 나머지 날은 등록 시간
    const fin = {};
    const days = new Set([...S.R.days.map((d) => d.date), ...Object.values(hoursBy).flatMap((m) => Object.keys(m))]);
    for (const dt of days) {
      const want = targetOf(S.R.days.find((d) => d.date === dt));
      if (want) { for (const x of want) if (x.cd && x.cd !== "(미배정)") fin[x.cd] = (fin[x.cd] || 0) + x.h; }
      else for (const [cd, m] of Object.entries(hoursBy)) if (m[dt]) fin[cd] = (fin[cd] || 0) + m[dt];
    }
    // 목표는 이 계획(잠금·기준일 반영)이 맞추려는 값을 쓴다
    const rows = [...S.R.projs].sort((a, b) => b.mm - a.mm).map((p) => {
      const t = toH(p.mmHalf), h = Object.values(hoursBy[p.pjtCd] || {}).reduce((a, b) => a + b, 0), f = fin[p.pjtCd] || 0, e = f - h;
      const pct = (v) => (t ? Math.round((v / t) * 100) : 0);
      const rate = pct(h), all = pct(f);
      const w1 = Math.min(100, rate), w2 = Math.max(0, Math.min(100, all) - w1);
      const tip = `${pname(p.pjtCd)}\n배정 ${p.mm.toFixed(3)} MM · 목표 ${t}h\n등록 ${h}h (${rate}%) → 계획대로 저장하면 ${f}h (${all}%, ${e >= 0 ? "+" : ""}${e}h)`;
      return `<div class="pm" data-tip="${esc(tip)}"><span class="dot" style="background:${pcolor(p.pjtCd)}"></span><span class="cd">${esc(p.pjtCd)}</span>
        <div class="bar"><i style="width:${w1}%;background:${pcolor(p.pjtCd)}"></i><i class="est" style="width:${w2}%;background:${pcolor(p.pjtCd)}"></i></div>
        <span class="pc">${rate}%</span><span class="pe ${all > 100 ? "over" : all === 100 ? "ok" : ""}">→ ${all}%</span></div>`;
    });
    return `<div class="pmini">${rows.join("")}</div>`;
  }

  // ── 프로젝트 표시: 색상 + 코드 + 이름. 잘린 이름은 툴팁으로 전체를 보여준다 ──
  function pjHtml(cd, extra = "", lead = "") {
    const nm = pname(cd);
    return `<div class="pj">${lead}<span class="dot" style="background:${pcolor(cd)}"></span>${cd === "(미배정)" ? "" : `<span class="cd">${esc(cd)}</span>`}
      <span class="nm" data-tip="${esc(nm)}" data-cut>${esc(nm)}</span>${extra}</div>`;
  }

  // ── 달력 칸의 시간 막대: 8h가 칸 전체, 그보다 긴 날은 그날 시간이 칸 전체. 왼쪽이 오전, 오른쪽이 오후 ──
  const LEAVE = { 연차: "#7a5bd6", 반차: "#2f6fd6" };
  function barHtml(list, cls = "") {
    const scale = Math.max(8, sumH(list));
    return `<div class="hb ${cls} ${list.length === 1 && list[0].pm ? "r" : ""}">${list.map((x) => `<i ${x.lv ? `class="lv"` : ""} style="width:${(x.h / scale) * 100}%;background-color:${x.lv ? LEAVE[x.lv] : pcolor(x.cd)}">${x.lv === "반차" ? (x.pm ? "오후" : "오전") : x.lv || ""}</i>`).join("")}</div>`;
  }

  // ── 달력: 1줄 날짜·휴가·시간, 2줄 기존안, 3줄 변경안. edit=false(요약)는 3줄과 날짜 클릭이 없다 ──
  function calHtml(edit) {
    const { R, year, month } = S;
    const lastDay = new Date(year, month, 0).getDate();
    const first = new Date(year, month - 1, 1).getDay();
    const hol = S.data.expenses.holidays || {};
    const badges = S.data.expenses.dayBadges || {};
    const tipLine = (t, list) => (list.length ? [`${t}`, ...list.map((x) => `· ${x.lv || pname(x.cd)} ${x.h}h`)] : []);
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(`<div></div>`);
    for (let dd = 1; dd <= lastDay; dd++) {
      const dt = `${year}-${pad(month)}-${pad(dd)}`, w = new Date(year, month - 1, dd).getDay();
      const pd = R.days.find((x) => x.date === dt);
      const off = w === 0 || w === 6, h = hol[dt];
      // 기록이 있는 평일은 요약 달력에서 눌러 잠금·해제한다. 잠긴 날은 패널에서 지정한 휴가·반차보다 우선한다
      const canLock = !off && !h && canLockDay(dt), lk = canLock && isLocked(dt);
      const vac = !off && !h && !lk && S.mset.휴가일.includes(dt);
      const half = !off && !h && !(lk && sumDay(dt)?.dayGubun !== "105") && S.mset.반차일[dt];
      const exist = existingOf(dt), base = edit ? baseOf(dt) : exist, pend = edit ? pendingOf(pd) : [], exps = badges[dt] || [];
      const hours = sumH((pend.length ? pend : base).filter((x) => x.cd));
      const canOt = edit && !vac && (!half || half === "오전") && pd?.items && !pd.locked && targetOf(pd);
      const cats = exps.map((b) => b.cat);
      const rule = pd?.items ? pd.rule : cats.includes("교통비") ? "교통비일" : cats.includes("야근식대비") ? "식대일" : "";
      const otTag = edit && !off && !h ? { 식대일: "식대", 교통비일: "교통" }[rule] : "";
      const tip = [...(h ? [h] : []), ...(vac ? ["연차"] : half ? [`${half} 반차`] : []), ...tipLine(exist.length ? "등록" : "예상", base), ...tipLine("변경", pend),
        ...exps.map((b) => `지출: ${b.cat}${b.amt ? ` ${Number(b.amt).toLocaleString()}원` : ""}`)].join("\n");
      const cls = off ? "off" : h ? "hol" : vac ? "vac" : half ? "half" : "";
      const timeTip = edit && pd?.items && !pd.locked && !vac ? [`근무 ${pd.출근}~${pd.퇴근}`] : [];
      const lockTip = canLock ? [`${pmsMade(dt) ? "PMS 입력" : "직접 입력"} · ${lk ? "잠금 (저장 때 그대로 둠)" : "잠금 해제 (다시 계산함)"}`] : [];
      const tipAll = [tip, ...timeTip, ...lockTip].filter(Boolean).join("\n");
      const act = edit ? (!off && !h && !lk ? `data-day="${dt}"` : "") : canLock ? `data-lock="${dt}"` : "";
      cells.push(`<div class="c ${cls} ${edit && pd?.future ? "fut" : ""}" ${act} ${tipAll ? `data-tip="${esc(tipAll)}"` : ""}>
        <div class="top"><b>${dd}</b>${lk ? `<span class="lk">🔒</span>` : ""}${vac ? `<span class="tag v">연차</span>` : half ? (canOt ? hrsSel(pd) : hours ? `<span class="hrs">${hours}h</span>` : "") : hours ? (canOt ? hrsSel(pd) : `<span class="hrs">${hours}h</span>`) : ""}</div>
        ${h ? `<span class="hn">${esc(h)}</span>` : ""}
        ${base.length ? barHtml(base, pend.length ? "gone" : exist.length ? "" : "est") : ""}${pend.length ? barHtml(pend, "chg") : ""}
        ${otTag ? `<span class="tag x">${otTag}</span>` : ""}
        ${!edit && exps.length ? `<span class="exp">₩</span>` : ""}</div>`);
    }
    return `<div class="cal ${edit ? "" : "ro"}">${DOW.map((d) => `<div class="dw">${d}</div>`).join("")}${cells.join("")}</div>`;
  }

  // ── 그날 근무시간 콤보박스: 4h부터 퇴근이 24:00을 넘지 않는 데까지 30분 단위 ──
  // 퇴근 = 출근 + 근무 + 점심 1h (+ 8h 초과면 저녁 1h). 오전 반차는 14:00 출근, 점심 없이 4h 초과면 저녁 1h
  function hrsSel(pd) {
    const [ih, im] = pd.출근.split(":").map(Number);
    const cur = toH(pd.half), set = typeof S.mset.시간일[pd.date] === "number";
    const [baseH, lunch] = pd.halfType ? [4, 0] : [8, 1];
    const opts = [];
    for (let v = 4; ih * 60 + im + (v + lunch + (v > baseH ? 1 : 0)) * 60 <= 24 * 60; v += 0.5) opts.push(v);
    if (!opts.includes(cur)) opts.push(cur), opts.sort((a, b) => a - b);
    return `<select class="hrs ${set ? "set" : ""}" data-hrs="${pd.date}">${opts.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${v}h</option>`).join("")}</select>`;
  }

  // ── 계획: 휴가 달력 + [계획 | 변경안] 탭 ──
  function planHtml() {
    const { R } = S;
    const fut = R.days.filter((d) => d.future).length;
    const base = baseDiff();
    return `
      ${base ? `<div class="sec"><div class="box row" style="margin:0">
        <span style="flex:1">시스템 기본 근무시간 <b>${esc(base.from)}</b> → <b>${esc(base.to)}</b></span>
        <button class="btn" data-a="basetime">시스템에 적용</button></div></div>` : ""}
      <div class="sec"><h4>휴가 지정 <span class="dim" style="font-weight:400">— 날짜를 누를 때마다 근무 → 연차 → 오전 반차 → 오후 반차</span></h4>
        ${calHtml(true)}
        ${projMiniHtml()}
        <div class="row" style="margin-top:10px">
          <label><input type="checkbox" data-today ${S.mset.범위 !== "all" ? "checked" : ""}> 오늘까지만 입력</label>
          <span class="dim">잠금 ${lockDates().length}일은 그대로 둡니다 (요약 달력에서 변경)</span>
        </div></div>
      ${S.saveLog ? `<div class="sec"><h4>저장 결과</h4><div class="box">${S.saveLog.map((l) =>
        `<span class="${l.ok ? "ok" : "over"}">${l.ok ? "✓" : "✗"}</span> ${md(l.date)} ${esc(l.text)}${l.reused ? ` · 행ID 유지 ${l.kept}/${l.reused}` : ""}`).join("<br>")}</div>
        <div class="note">업무기록 화면의 달력에 반영하려면 <a href="#" data-a="pagereload">페이지를 새로고침</a>하세요.</div></div>` : ""}
      <div class="sec"><h4>계획 <span class="dim" style="font-weight:400">— ${S.F.workdays.length}일 ${toH(S.F.totalHalf)}h</span></h4>
        ${planListHtml()}
        ${fut ? `<div class="note">오늘 이후 ${fut}일은 계획만 보여주고 저장하지 않습니다.</div>` : ""}
      </div>`;
  }

  function segHtml(list, cls, lead = "") {
    return list.map((x) => `<div class="${cls}">${x.lv
      ? `<div class="pj">${lead}<span class="dot" style="background:${LEAVE[x.lv]}"></span><span class="nm">${x.lv}</span><span class="hr">${x.h}h</span></div>`
      : pjHtml(x.cd, `${x.tk ? `<span class="tk" data-tip="${esc(x.tk)}" data-cut>${esc(x.tk)}</span>` : ""}<span class="hr">${x.h}h</span>`, lead)}</div>`).join("");
  }

  // ── 날짜 아래 기존 계획, 달라질 때만 그 아래 변경 계획 ──
  function planListHtml() {
    const byDate = new Map((S.changes || []).map((c) => [c.d.date, c]));
    const rows = S.R.days.map((d) => {
      const base = baseOf(d.date), pend = pendingOf(d), c = byDate.get(d.date);
      if (!base.length && !pend.length) return "";
      const reg = existingOf(d.date).length > 0;
      const mark = d.rule === "식대일" || d.rule === "교통비일" ? `<span class="tag x">${d.rule}</span>` : "";
      // 프로젝트와 시간은 같고 WBS 작업·출퇴근만 다른 날은 저장 대상이므로 따로 알려준다
      const detail = !pend.length && reg && c && !c.locked
        ? c.ops.filter((o) => o.op === "수정" && o.x.taskNm !== o.line.taskNm).map((o) => `<div class="dim">→ 작업 변경: ${esc(o.x.taskNm || "-")} → ${esc(o.line.taskNm || "-")}</div>`).join("") || `<div class="dim">→ 근무 구분·출퇴근 시간 변경</div>`
        : "";
      return `<div class="${d.future ? "fu" : ""}"><div class="d">${md(d.date)}(${DOW[d.dow]})${mark}${c?.locked ? `<span class="over" style="font-weight:400">본인 확인 완료 — 건너뜀</span>` : ""}
          ${d.items && !d.locked ? `<span class="dim">${d.출근}~${d.퇴근}</span>` : ""}</div>
        ${segHtml(base, pend.length ? "gone" : reg ? "" : "est")}${segHtml(pend, "chg", `<span class="sg">→</span>`)}${detail}</div>`;
    }).join("");
    const n = (S.changes || []).filter((c) => !c.locked).length;
    const m = S.R.days.filter((d) => pendingOf(d).length).length;
    return `<div class="box"><b>변경 계획 ${m}일</b>${S.changes ? ` · 저장 대상 ${n}일` : S.calc ? " · 계산 중…" : ""}</div><div class="ops">${rows}</div>`;
  }

  function planFooter() {
    const n = (S.changes || []).filter((c) => !c.locked).length;
    // 패널에서 바꾼 휴가·반차·근무시간이 있을 때만 왼쪽 끝에 되돌리기 버튼을 둔다
    const reset = S.mset.수동일.length || Object.keys(S.mset.시간일).length
      ? `<button class="btn" data-a="resetmonth" style="margin-right:auto" ${S.busy ? "disabled" : ""}>원래대로</button>` : "";
    if (!S.changes) return `<div class="ft">${reset}<button class="btn pri" data-a="diff" ${S.calc || S.busy ? "disabled" : ""}>${S.calc ? "계산 중…" : "변경안 계산"}</button></div>`;
    return `<div class="ft">${reset}<button class="btn pri" data-a="save" ${!n || S.busy ? "disabled" : ""}>저장${n ? ` (${n}일)` : ""}</button></div>`;
  }

  // ── 설정 ──
  function settingsHtml() {
    const t = S.settings.시간규칙;
    const times = []; for (let h = 6; h <= 24; h++) { times.push(`${pad(h)}:00`); if (h < 24) times.push(`${pad(h)}:30`); }
    const sel = (k, f) => `<select data-time="${k}.${f}">${times.map((x) => `<option ${t[k][f] === x ? "selected" : ""}>${x}</option>`).join("")}</select>`;
    const num = (k, min, max, step = 1) => `<input type="number" min="${min}" max="${max}" step="${step}" value="${S.settings[k]}" data-num="${k}" style="width:56px">`;
    return `
      <div class="sec"><h4>시간 규칙</h4><table>
        <tr><th>구분</th><th>출근</th><th>퇴근</th><th>공제</th></tr>
        <tr><td>기본</td><td>${sel("기본", "출근")}</td><td>${sel("기본", "퇴근")}</td><td>점심</td></tr>
        <tr><td>야근식대비 등록일</td><td>${sel("식대일", "출근")}</td><td>${sel("식대일", "퇴근")}</td><td>점심·저녁</td></tr>
        <tr><td>교통비 등록일</td><td>${sel("교통비일", "출근")}</td><td>${sel("교통비일", "퇴근")}</td><td>점심·저녁</td></tr>
      </table>
      <div class="note">식대·교통비는 다른 시스템에서 등록하면 자동으로 감지합니다. 반차는 오전 14:00~18:00, 오후 09:00~13:00 (근무 4h, 식사 미공제).</div></div>
      <div class="sec"><h4>배분 규칙</h4>
        <div class="row">하루 최대 프로젝트 ${num("하루최대프로젝트", 1, 5)} 개</div>
        <div class="row">프로젝트당 WBS 최대 ${num("WBS최대라인", 1, 5)} 라인</div>
        <div class="row"><label><input type="checkbox" data-flag="끝수연장" ${S.settings.끝수연장 ? "checked" : ""}> 끝수를 연장근무로 맞춤</label> 하루 최대 ${num("하루최대연장", 0.5, 5, 0.5)} h</div>
        <div class="note">같은 프로젝트는 하루에 한 줄만 등록합니다. WBS 라인은 날짜별로 번갈아 써서 월 전체 비율을 맞춥니다.<br>
          끝수 연장: 4h 단위로 안 떨어지는 시간을 기본일의 연장근무(8.5h, 9h …)로 붙여 프로젝트별 시간을 MM 비율과 정확히 맞춥니다. 끄면 4h 단위로 맞추고 몇 시간 차이를 허용합니다.</div></div>`;
  }

  function settingsFooter() {
    return `<div class="ft"><div class="note">값을 바꾸면 바로 저장됩니다.</div><button class="btn" data-a="resetset">기본값으로 되돌리기</button></div>`;
  }

  // ───────── 툴팁 (브라우저 기본 title은 뜨는 데 1초 넘게 걸린다) ─────────
  let tipTimer = null, tipEl = null;
  function hideTip() {
    clearTimeout(tipTimer); tipEl = null;
    const t = root.querySelector(".tip");
    if (t) t.hidden = true;
  }
  function showTip(el) {
    const t = root.querySelector(".tip");
    if (!t || !el.isConnected) return;
    t.textContent = el.dataset.tip;
    t.hidden = false;
    const r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
    t.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    t.style.top = `${r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  }
  root.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el || el === tipEl) return;
    hideTip();
    if ("cut" in el.dataset && el.scrollWidth <= el.clientWidth) return; // 잘리지 않았으면 띄우지 않는다
    tipEl = el;
    tipTimer = setTimeout(() => showTip(el), 200);
  });
  root.addEventListener("mouseout", (e) => {
    if (tipEl && !tipEl.contains(e.relatedTarget)) hideTip();
  });

  // ───────── 이벤트 ─────────
  root.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-a],[data-tab],[data-hrs],[data-day],[data-lock]");
    if (!el || S.busy) return;
    if (el.dataset.hrs) return;
    const a = el.dataset.a;
    if (a === "open") { open = true; render(); return load(); } // 업무기록 화면에서 바뀐 내용을 열 때마다 읽는다
    if (a === "close") { open = false; render(); return; }
    if (a === "reload") return load();
    if (a === "prev" || a === "next") {
      S.month += a === "prev" ? -1 : 1;
      if (S.month < 1) { S.month = 12; S.year--; } if (S.month > 12) { S.month = 1; S.year++; }
      return load();
    }
    if (a === "diff") return computeChanges();
    if (a === "save") return doSave();
    if (a === "basetime") {
      S.busy = "기본 근무시간 변경 중…"; S.err = ""; render();
      try { await applyBaseTime(); } catch (e) { S.err = `기본 근무시간 변경 실패: ${e.message}`; }
      S.busy = ""; render(); return;
    }
    if (a === "pagereload") { e.preventDefault(); location.reload(); return; }
    if (a === "resetmonth") {
      // 이 달에 패널에서 바꾼 휴가·반차·근무시간을 버리고 시스템에 등록된 상태로 돌아간다. 잠금은 그대로 둔다
      if (!confirm("이 달에 패널에서 바꾼 휴가·반차·근무시간을 모두 지우고 시스템에 등록된 상태로 되돌립니다.\n잠금은 그대로 둡니다.\n\n계속할까요?")) return;
      const { 잠금, pms기록, 범위 } = S.mset;
      await store.set(mkey(), { 잠금, pms기록, 범위 });
      return load();
    }
    if (a === "resetset") { S.settings = JSON.parse(JSON.stringify(DEFAULTS)); await store.set("settings", S.settings); recompute(); render(); return; }
    if (el.dataset.tab) {
      S.tab = el.dataset.tab;
      if (S.tab === "plan" && !S.changes && !S.calc) scheduleChanges();
      render(); return;
    }
    if (el.dataset.lock) {
      // 기본값(직접 입력 = 잠금, PMS 입력 = 열림)과 같아지면 직접 정한 값을 지운다
      const dt = el.dataset.lock, want = !isLocked(dt);
      if (want === !pmsMade(dt)) delete S.mset.잠금[dt]; else S.mset.잠금[dt] = want;
      return saveMonthSettings();
    }
    if (el.dataset.day) {
      // 근무 → 연차 → 오전 반차 → 오후 반차 → 근무
      const dt = el.dataset.day;
      const vac = S.mset.휴가일.includes(dt), half = S.mset.반차일[dt];
      S.mset.휴가일 = S.mset.휴가일.filter((x) => x !== dt);
      delete S.mset.반차일[dt];
      if (!vac && !half) S.mset.휴가일.push(dt);
      else if (vac) S.mset.반차일[dt] = "오전";
      else if (half === "오전") S.mset.반차일[dt] = "오후";
      S.mset.휴가일.sort();
      delete S.mset.시간일[dt];
      if (!S.mset.수동일.includes(dt)) S.mset.수동일.push(dt);
      return saveMonthSettings();
    }
  });
  root.addEventListener("change", async (e) => {
    const el = e.target;
    if (el.dataset.hrs) { S.mset.시간일[el.dataset.hrs] = Number(el.value); return saveMonthSettings(); }
    if ("today" in el.dataset) { S.mset.범위 = el.checked ? "today" : "all"; return saveMonthSettings(); }
    if (el.dataset.time) { const [k, f] = el.dataset.time.split("."); S.settings.시간규칙[k][f] = el.value; }
    if (el.dataset.num) {
      const v = Number(el.value) || 1;
      S.settings[el.dataset.num] = el.dataset.num === "하루최대연장" ? Math.max(0.5, Math.round(v * 2) / 2) : Math.max(1, Math.round(v));
    }
    if (el.dataset.flag) S.settings[el.dataset.flag] = el.checked;
    if (el.dataset.time || el.dataset.num || el.dataset.flag) { await store.set("settings", S.settings); recompute(); render(); }
  });

  // ───────── 버튼 표시 ─────────
  // hr-report 의 다른 화면에도 스크립트가 들어오고, 앱이 화면을 다시 그리면 호스트가 떨어질 수 있다.
  // 그래서 "주소 + 업무기록 달력"을 계속 확인해 붙이고 숨긴다. 화면 전환 중 깜빡이지 않게 3번 연속 없을 때만 숨긴다.
  let miss = 0;
  function sync() {
    const here = readUrl() && !!document.querySelector(".cal-cell");
    miss = here ? 0 : miss + 1;
    if (here) {
      if (!host.isConnected) document.documentElement.appendChild(host);
      host.style.display = "";
    } else if (miss >= 3) host.style.display = "none";
  }

  render();
  sync();
  setInterval(sync, 1000);
})();
