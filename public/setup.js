const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll('section.card')) s.hidden = true;
  $(id).hidden = false;
  const order = ['step-broker', 'step-generate', 'step-test', 'step-finish'];
  document.querySelectorAll('#steps .dot').forEach((d, i) => d.classList.toggle('on', i <= order.indexOf(id)));
};
const appendLog = (el, msg) => {
  const lines = (el.textContent + msg + '\n').split('\n');
  el.textContent = lines.slice(-200).join('\n'); // 마지막 200줄만 유지 (메모리 폭증 방지)
  el.scrollTop = el.scrollHeight;
};

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 202 ? null : res.json();
}

$('btn-broker').onclick = async () => {
  $('btn-broker').disabled = true;
  try {
    await post('/api/setup/broker', {
      brokerName: $('brokerName').value.trim(), brokerId: $('brokerId').value.trim(),
      baseUrl: $('baseUrl').value.trim(),
      docsUrls: $('docsUrls').value.split('\n').map(s => s.trim()).filter(Boolean),
      apiKey: $('apiKey').value, apiSecret: $('apiSecret').value, accountNo: $('accountNo').value.trim(),
    });
    show('step-generate');
    let genDone = false;
    const es = new EventSource('/api/setup/progress');
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      appendLog($('gen-log'), d.message);
      if (d.done) { genDone = true; es.close(); d.ok ? show('step-test') : appendLog($('gen-log'), '❌ 생성 실패 — 문서 URL을 확인하고 새로고침 후 재시도하세요.'); }
    };
    es.onerror = () => { if (!genDone) appendLog($('gen-log'), '⚠️ 진행 상황 연결 끊김 — 재연결 시도 중…'); };
    await post('/api/setup/generate', {});
  } catch (err) {
    alert('등록 실패: ' + err.message);
    $('btn-broker').disabled = false;
  }
};

$('btn-test').onclick = async () => {
  $('test-log').textContent = '';
  try {
    const r = await post('/api/setup/test', { testSymbol: $('testSymbol').value.trim() });
    for (const s of r.steps) appendLog($('test-log'), `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
    if (r.ok) { appendLog($('test-log'), '연결 성공 — 마지막 단계로 이동합니다.'); setTimeout(() => show('step-finish'), 800); }
  } catch (err) { appendLog($('test-log'), '테스트 실패: ' + err.message); }
};

$('btn-finish').onclick = async () => {
  try {
    await post('/api/setup/finish', {
      mode: 'paper', agreed: $('agree').checked, guardrails: {},
    });
    const host = location.host || 'localhost:3000';
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const card = document.createElement('div');
    card.className = 'card';
    const h2 = document.createElement('h2');
    h2.textContent = '설정 완료';
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = `온보딩 완료. 터미널에서 \`npm run review\` 를 실행해 보유종목 분석을 시작하세요. (이 창은 닫으셔도 됩니다)`;
    card.append(h2, p);
    wrap.appendChild(card);
    document.body.textContent = '';
    document.body.appendChild(wrap);
  } catch (err) { alert(err.message); }
};

// 새로고침 시 진행 단계 복원
fetch('/api/setup/status').then(r => r.json()).then(s => {
  if (s.step === 'finish') show('step-finish');
  else if (s.step === 'generate') show('step-test');
}).catch(() => { /* 서버 미응답 — 1단계(broker) 유지 */ });
