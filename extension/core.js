// 자동 생성 파일 — 수정은 core.mjs 에서 하고 ./build.sh 를 실행할 것
// 업무기록 계산 엔진 (순수 로직 — 브라우저/네트워크 사용 안 함)
// extension/core.js 로 변환돼 크롬 확장에서 쓰인다. 모든 시간은 "30분 몇 개"인 정수(half)로 다룬다.

const H = (n) => Math.round(n * 2);
const toH = (half) => half / 2;
const pad = (n) => String(n).padStart(2, "0");
// "09:00" + 9.5h → "18:30"
const addTime = (t, h) => {
  const [a, b] = t.split(":").map(Number), m = a * 60 + b + Math.round(h * 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

function build(cfg, { projects, expenses, summary, weekRows = {} }) {
  const { year, month } = cfg;
  const lastDay = new Date(year, month, 0).getDate();
  const holidays = expenses.holidays || {};
  const badges = expenses.dayBadges || {};
  const vacation = new Set(cfg["휴가일"] || []);
  // 반차: { "2026-10-23": "오전" | "오후" }  (예전 배열 형식이면 오전으로 본다)
  const halfRaw = cfg["반차일"] || {};
  const halfVacation = new Map(
    Array.isArray(halfRaw) ? halfRaw.map((d) => [d, "오전"]) : Object.entries(halfRaw)
  );
  const HALF_TIME = { 오전: ["14:00", "18:00"], 오후: ["09:00", "13:00"] };
  const maxProj = cfg["하루최대프로젝트"] || 2;
  const maxWbs = cfg["WBS최대라인"] || 2;

  // 기준일은 저장 범위만 정한다. 계획은 항상 월 전체로 세우고, 기준일 이후는 저장하지 않는다
  const cutoff = cfg["기준일"] || null; // "YYYY-MM-DD", 없으면 제한 없음
  // 잠금일: 기록을 그대로 둘 날 목록. 없으면 기존기록유지(전체 유지 여부)를 따른다
  const lockSet = cfg["잠금일"] ? new Set(cfg["잠금일"]) : null;
  // 지정시간: { "2026-11-12": { 출근: "09:00", 퇴근: "18:00" } } — 시스템에 등록된 그날 근무시간
  const designated = cfg["지정시간"] || {};

  const existing = {};
  for (const d of summary.days || []) {
    if (d.totalHours || d.dayGubun) existing[d.date] = { hours: d.totalHours || 0, gubun: d.dayGubun };
  }

  // ── 날짜 목록 ──
  const days = [];
  for (let dd = 1; dd <= lastDay; dd++) {
    const date = `${year}-${pad(month)}-${pad(dd)}`;
    const dow = new Date(year, month - 1, dd).getDay();
    if (dow === 0 || dow === 6) { days.push({ date, dow, skip: true, reason: "주말" }); continue; }
    if (holidays[date]) { days.push({ date, dow, skip: true, reason: holidays[date] }); continue; }
    // 잠긴 날은 패널에서 지정한 휴가·반차보다 우선한다 (시스템에 연차로 등록된 날은 잠그지 않는다)
    const ex = existing[date];
    const locked = !!(ex?.hours && ex.gubun !== "104" && (lockSet ? lockSet.has(date) : cfg["기존기록유지"]));
    // 휴가는 미리 등록하는 게 자연스러우므로 기준일 이후여도 등록한다
    if (vacation.has(date) && !locked) { days.push({ date, dow, skip: true, reason: "휴가", vacationOnly: true, gubun: "104" }); continue; }

    const cats = (badges[date] || []).map((b) => b.cat);
    const halfType = locked && ex.gubun !== "105" ? null : halfVacation.get(date) || null;
    // 시간지정: { "2026-11-12": "식대일" } 처럼 그날 시간 규칙을 직접 고른 값이 지출 자동 판별보다 우선한다
    let rule = cfg["시간지정"]?.[date] || (cats.includes("교통비") ? "교통비일" : cats.includes("야근식대비") ? "식대일" : "기본");
    let r = cfg["시간규칙"][rule];
    // 등록된 근무시간이 있으면 출근은 그 시각, 퇴근은 기본일엔 그 시각, 식대·교통비일엔 규칙과 등록 시각 중 늦은 쪽
    const dz = designated[date];
    if (dz) r = { ...r, 출근: dz.출근, 퇴근: rule === "기본" ? dz.퇴근 : r["퇴근"] > dz.퇴근 ? r["퇴근"] : dz.퇴근 };
    // 근무시간지정: { "2026-11-12": 9.5 } 처럼 그날 근무시간을 직접 고른 값. 출근은 그대로 두고 퇴근을 계산한다.
    // 점심 1h는 항상, 8h를 넘으면 저녁 1h도 공제한다 (식대일 09~21시 = 10h 와 같은 계산)
    const wh = cfg["근무시간지정"]?.[date];
    if (wh && !halfType) {
      const dinner = wh > 8;
      rule = "지정";
      r = { 출근: r["출근"], 퇴근: addTime(r["출근"], wh + 1 + (dinner ? 1 : 0)), 점심공제: true, 저녁공제: dinner };
    }
    if (halfType) {
      // 반차: 휴가 4h 고정, 업무 4h. 5시간 미만 근무라 식사시간 공제 없음
      const [ci, co] = HALF_TIME[halfType] || HALF_TIME["오전"];
      rule = "반차";
      r = { 출근: ci, 퇴근: co, 점심공제: false, 저녁공제: false };
      // 오전 반차는 퇴근을 뒤로 늘릴 수 있다. 4h를 넘으면 저녁 1h를 공제한다 (14:00 + 4.5h + 저녁 1h = 19:30)
      if (halfType === "오전" && wh > 4) r = { 출근: ci, 퇴근: addTime(ci, wh + 1), 점심공제: false, 저녁공제: true };
    }
    const [sh, sm] = r["출근"].split(":").map(Number);
    const [eh, em] = r["퇴근"].split(":").map(Number);
    let half = (eh * 60 + em - (sh * 60 + sm)) / 30;
    if (r["점심공제"]) half -= 2;
    if (r["저녁공제"]) half -= 2;
    if (locked) half = H(existing[date].hours);

    days.push({
      date, dow, half, rule, skip: false, locked, future: !!(cutoff && date > cutoff),
      gubun: halfType ? "105" : "101", halfType,
      출근: r["출근"], 퇴근: r["퇴근"], 점심: r["점심공제"], 저녁: r["저녁공제"],
      badges: cats, hasExisting: !!existing[date],
    });
  }

  const workdays = days.filter((d) => !d.skip);
  const totalHalf = workdays.reduce((s, d) => s + d.half, 0);

  // ── 프로젝트 목표 (MM 비율 × 총 근무시간), 30분 단위 정수로 최대잔여법 보정 ──
  const mi = month - 1;
  const projs = projects
    .map((p) => {
      const lines = (p.wbsLines || [])
        .map((w) => ({ procNm: w.procNm, itemNm: w.itemNm, taskNm: w.taskNm, mm: w.mm?.[mi] || 0 }))
        .filter((w) => w.mm > 0)
        .sort((a, b) => b.mm - a.mm);
      return {
        pjtCd: p.pjtCd, pjtNm: p.pjtNm,
        mm: lines.reduce((s, w) => s + w.mm, 0),
        wbsLines: lines.slice(0, maxWbs), // MM 큰 라인만 남겨 줄 수를 줄인다
      };
    })
    .filter((p) => p.mm > 0);

  const totalMM = projs.reduce((s, p) => s + p.mm, 0);
  // 총 근무시간 tot 기준 목표를 다시 잡고, 잠긴 날의 실적을 뺀다
  const setTargets = (tot) => {
    const raw = projs.map((p) => (tot * p.mm) / totalMM);
    const target = raw.map(Math.floor);
    const rest = tot - target.reduce((a, b) => a + b, 0);
    raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f)
       .forEach((o, k) => { if (k < rest) target[o.i]++; });
    projs.forEach((p, i) => { p.targetHalf = target[i]; p.remain = target[i]; p.mmHalf = target[i]; });
    for (const d of workdays.filter((x) => x.locked)) {
      for (const row of weekRows[d.date] || []) {
        const p = projs.find((x) => x.pjtCd === row.pjtCd);
        if (p) p.remain -= H(row.hours);
      }
    }
  };
  setTargets(totalHalf);

  const open = workdays.filter((d) => !d.locked);

  // ── 날짜 배정: 하루 최대 maxProj개 ──
  const allocDay = (d) => {
    let need = d.half;
    d.alloc = [];
    while (need > 0 && d.alloc.length < maxProj) {
      const last = d.alloc.length === maxProj - 1; // 마지막 슬롯이면 남은 시간을 모두 흡수
      // 통째로 감당 가능한 프로젝트 우선, 그중 잔여 최대
      let c = projs.filter((p) => p.remain >= need).sort((a, b) => b.remain - a.remain)[0]
           || projs.filter((p) => p.remain > 0).sort((a, b) => b.remain - a.remain)[0];
      if (!c) break;
      const take = last ? need : Math.min(need, c.remain);
      d.alloc.push({ pjtCd: c.pjtCd, pjtNm: c.pjtNm, half: take, wbsLines: c.wbsLines });
      c.remain -= take;
      need -= take;
    }
    if (need > 0) d.alloc.push({ pjtCd: "(미배정)", pjtNm: "하루 한도 초과", half: need });
  };

  // 식대·교통비·반차처럼 하루 시간이 다른 날을 먼저 배정해, 나머지 날이 같은 크기로 떨어지게 한다
  const freq = {};
  for (const d of open) freq[d.half] = (freq[d.half] || 0) + 1;
  const dayHalf = Number(Object.keys(freq).sort((a, b) => freq[b] - freq[a] || b - a)[0]) || 16;
  const special = open.filter((d) => d.half !== dayHalf).sort((a, b) => b.half - a.half);
  const base = open.filter((d) => d.half === dayHalf);
  const unit = Math.max(1, Math.floor(dayHalf / 2));
  const baseHalf = base.length * dayHalf;
  special.forEach(allocDay);

  // ── 끝수 연장: 반나절(4h) 단위로 안 떨어지는 끝수를 기본일의 연장근무로 붙여 MM 비율을 정확히 맞춘다 ──
  // 총 근무시간을 30분씩 늘려 가며, 각 프로젝트의 반나절 수 합이 기본일을 다 채우는 가장 작은 연장 e 를 찾는다
  const capHalf = H(cfg["하루최대연장"] ?? 2);
  const otDays = base.filter((d) => d.rule === "기본");
  let extra = null;
  if (cfg["끝수연장"] && base.length && baseHalf % unit === 0 && capHalf > 0) {
    const need = baseHalf / unit;
    for (let e = 0; e <= otDays.length * capHalf; e++) {
      setTargets(totalHalf + e);
      special.forEach(allocDay);
      const pos = projs.map((p) => Math.max(0, p.remain));
      if (pos.reduce((a, v) => a + Math.floor(v / unit), 0) < need) continue;
      const units = pos.map((v) => Math.floor(v / unit));
      // 넘치는 반나절은 남은 끝수가 큰 프로젝트부터 연장으로 돌린다
      for (let k = units.reduce((a, b) => a + b, 0) - need; k > 0; k--) {
        const i = units.map((u, i) => i).filter((i) => units[i] > 0).sort((a, b) => pos[b] - units[b] * unit - (pos[a] - units[a] * unit))[0];
        units[i]--;
      }
      const ot = pos.map((v, i) => v - units[i] * unit);
      // 연장은 기본일 하루에 capHalf 까지. 모두 들어가야 채택한다
      if (ot.reduce((a, b) => a + b, 0) > otDays.length * capHalf) break;
      extra = { units, ot };
      break;
    }
    if (!extra) { setTargets(totalHalf); special.forEach(allocDay); }
  }

  if (extra) {
    projs.forEach((p, i) => { p.remain = extra.units[i] * unit; });
    base.forEach(allocDay);
    // 연장을 붙인다: 그 프로젝트가 있는 날 → 프로젝트 칸이 남은 날 순으로, 연장이 적은 날부터
    const used = new Map(otDays.map((d) => [d, 0]));
    const order = projs.map((p, i) => i).sort((a, b) => extra.ot[b] - extra.ot[a]);
    for (const i of order) {
      let left = extra.ot[i];
      const cd = projs[i].pjtCd;
      while (left > 0) {
        const pick = (f) => otDays.filter((d) => used.get(d) < capHalf && f(d)).sort((a, b) => used.get(a) - used.get(b))[0];
        const d = pick((d) => d.alloc.some((a) => a.pjtCd === cd)) || pick((d) => d.alloc.length < maxProj);
        if (!d) break;
        const add = Math.min(left, capHalf - used.get(d));
        const a = d.alloc.find((x) => x.pjtCd === cd);
        if (a) a.half += add;
        else d.alloc.push({ pjtCd: cd, pjtNm: projs[i].pjtNm, half: add, wbsLines: projs[i].wbsLines });
        used.set(d, used.get(d) + add);
        left -= add;
      }
      if (left > 0) { // 못 붙인 끝수는 연장이 가장 적은 날에 미배정으로 남긴다
        const d = otDays.sort((a, b) => used.get(a) - used.get(b))[0];
        d.alloc.push({ pjtCd: "(미배정)", pjtNm: "연장 한도 초과", half: left });
        used.set(d, used.get(d) + left);
      }
    }
    // 연장한 날의 퇴근 시각: 출근 + 근무 + 점심 1h (+ 8h 초과면 저녁 1h)
    for (const [d, add] of used) {
      if (!add) continue;
      d.half += add;
      const wh = d.half / 2;
      d.rule = "연장"; d.저녁 = wh > 8; d.퇴근 = addTime(d.출근, wh + 1 + (d.저녁 ? 1 : 0));
    }
  } else {
    // 남은 시간을 반나절(8시간 근무면 4h) 단위로 맞춘다. 이렇게 하면 하루 통째 배정이 최대가 되고,
    // 맞지 않는 날만 반나절씩 두 프로젝트로 나뉜다. 대신 프로젝트별 시간이 MM 기준과 몇 시간 달라질 수 있다.
    const pos = projs.map((p) => Math.max(0, p.remain));
    const posSum = pos.reduce((a, b) => a + b, 0) || 1;
    const rawUnit = pos.map((v) => (v * baseHalf) / posSum / unit);
    const units = rawUnit.map(Math.floor);
    const spare = Math.floor(baseHalf / unit) - units.reduce((a, b) => a + b, 0);
    rawUnit.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || pos[b.i] - pos[a.i])
       .forEach((o, k) => { if (k < spare) units[o.i]++; });
    projs.forEach((p, i) => { p.remain = units[i] * unit; });
    const biggest = [...projs].sort((a, b) => b.remain - a.remain)[0]; // 반나절로 안 나눠지는 근무시간의 끝수
    if (biggest) biggest.remain += baseHalf - units.reduce((a, b) => a + b, 0) * unit;
    base.forEach(allocDay);
  }

  // ── 하루 안의 (프로젝트, WBS라인, 시간) 목록으로 평탄화 ──
  // 같은 프로젝트는 하루에 한 줄만 쓴다. WBS 라인을 하루 안에서 나누지 않고,
  // 그 라인이 MM 비율 대비 덜 받은 정도로 날마다 골라 월 전체로 WBS 비율을 맞춘다.
  const lineUsed = {}; // pjtCd → [half, half, ...]
  const pickLine = (a) => {
    const lines = a.wbsLines || [];
    if (!lines.length) return null;
    const used = (lineUsed[a.pjtCd] ||= lines.map(() => 0));
    const tot = lines.reduce((t, l) => t + l.mm, 0) || 1;
    // 덜 받은 순서: used / 비율 이 작은 라인 우선
    return lines
      .map((l, i) => ({ l, i, score: used[i] / (l.mm / tot) }))
      .sort((x, y) => x.score - y.score || y.l.mm - x.l.mm)[0];
  };
  for (const d of open) {
    d.items = d.alloc.map((a) => {
      if (a.pjtCd === "(미배정)") return { pjtCd: a.pjtCd, line: null, half: a.half };
      const c = pickLine(a);
      if (c) lineUsed[a.pjtCd][c.i] += a.half;
      return { pjtCd: a.pjtCd, line: c?.l, half: a.half };
    });
  }

  // 기준일 이후는 계획만 남기고 저장 대상에서 뺀다
  for (const d of workdays) if (d.future) { d.skip = true; d.reason = "미래"; }
  const saving = workdays.filter((d) => !d.future);
  return {
    days, workdays: saving, open: open.filter((d) => !d.future), projs,
    totalHalf: saving.reduce((s, d) => s + d.half, 0), totalMM, existing, cutoff,
  };
}
