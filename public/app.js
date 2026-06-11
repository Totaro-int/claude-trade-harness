const $ = (id) => document.getElementById(id);
const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const cls = (n) => (n >= 0 ? 'up' : 'down');
let chart;

function render(s) {
  // 헤더
  $('mode-badge').textContent = s.mode.toUpperCase();
  $('mode-badge').classList.toggle('live', s.mode === 'live');
  $('broker-badge').textContent = '● ' + (s.brokerName || 'mock') + ' 연결됨';
  $('status-line').textContent = `마지막 업데이트 ${new Date(s.updatedAt).toLocaleTimeString('ko-KR')} · 가드레일 정상`;
  $('warn-banner').hidden = !s.warning;
  if (s.warning) $('warn-text').textContent = s.warning;

  // 3카드
  const totalPnlPct = (s.equity / s.initialCash - 1) * 100;
  $('equity').textContent = won(s.equity);
  $('pnl').textContent = `${won(s.equity - s.initialCash).replace('-', '−')} (${pct(totalPnlPct)}) · 오늘 ${pct(s.dailyPnlPct)}`;
  $('pnl').className = cls(totalPnlPct);

  if (s.benchmark) {
    const benchPct = (s.benchmark / s.initialCash - 1) * 100;
    const diff = totalPnlPct - benchPct;
    $('bench-diff').textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%p';
    $('bench-diff').className = cls(diff);
    $('bench-abs').textContent = '벤치마크 ' + pct(benchPct);
  }

  $('orders-today').textContent = `${s.ordersToday}/${s.maxOrdersPerDay}건`;
  $('fees-today').textContent = `수수료·세금 누적 ${won(s.feesTotal ?? 0)}`;

  // 포지션
  $('positions-title').textContent = `보유 포지션 ${s.positions.length}`;
  const tbody = $('positions');
  tbody.textContent = '';
  for (const p of s.positions) {
    const cur = s.quotes?.[p.symbol]?.price ?? p.avgPrice;
    const pnlP = (cur / p.avgPrice - 1) * 100;
    const tr = document.createElement('tr');
    for (const [text, klass] of [
      [p.name, ''], [p.quantity + '주', 'num'], [won(p.avgPrice), 'num'],
      [won(cur), 'num'], [pct(pnlP), 'num ' + cls(pnlP)],
    ]) {
      const td = document.createElement('td');
      td.textContent = text; td.className = klass; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // 판단 로그 (textContent만 — XSS 방지)
  const box = $('decisions');
  box.textContent = '';
  for (const d of s.decisions) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:10px;background:var(--card-2);border-radius:10px;margin-bottom:8px';
    const head = document.createElement('div');
    head.className = 'sub';
    head.textContent = `${new Date(d.ts).toLocaleTimeString('ko-KR')} · ${d.action} ${d.name ?? ''} ${d.quantity ?? ''} · ${d.status}${d.rejectReason ? ' — ' + d.rejectReason : ''}`;
    const body = document.createElement('div');
    body.style.cssText = 'font-size:12.5px;margin-top:4px;line-height:1.55';
    let thesisSuffix = '';
    if (d.thesis) {
      try {
        const t = JSON.parse(d.thesis);
        thesisSuffix = ` [thesis: ${t.target} / ${t.stop}]`;
      } catch { /* malformed thesis — skip */ }
    }
    body.textContent = d.reasoning + thesisSuffix;
    item.append(head, body);
    box.appendChild(item);
  }

  // 차트: 내 자산 vs 벤치마크
  const xs = s.snapshots.map(r => new Date(r.ts).getTime() / 1000);
  const equitySeries = s.snapshots.map(r => r.equity);
  const benchSeries = s.snapshots.map(r => r.benchmark);
  const data = [xs, equitySeries, benchSeries];
  if (!chart) {
    chart = new uPlot({
      width: Math.min(720, document.body.clientWidth - 64), height: 200,
      series: [{}, { stroke: '#f04452', width: 2 }, { stroke: '#566070', width: 1.5, dash: [4, 4] }],
      axes: [{ stroke: '#8b95a1', grid: { stroke: '#26292f' } }, { stroke: '#8b95a1', grid: { stroke: '#26292f' } }],
      legend: { show: false },
    }, data, $('chart'));
  } else chart.setData(data);
}

async function load() {
  try { render(await (await fetch('/api/state')).json()); }
  catch { $('warn-banner').hidden = false; $('warn-text').textContent = '서버 응답 없음'; }
}
load();
const es = new EventSource('/events');
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch { /* 무시 */ } };
setInterval(() => {
  const m = $('status-line').textContent.match(/(\d+:\d+:\d+)/);
  if (!m) return;
}, 30000);
