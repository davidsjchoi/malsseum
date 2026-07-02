/* ============================================================================
   말씀함께 v0.7 — 클라우드 레이어 (사용자 앱)
   ----------------------------------------------------------------------------
   firebase-config.js 가 채워져 있으면:
     · 회원가입/로그인 (이메일 · 카카오 · 휴대폰)
     · 모든 기록을 Firestore(클라우드)에 저장 — 기기를 바꿔도 유지
     · 목장방/중보기도 실시간 공유, 관리자 콘텐츠 실시간 반영
   비어 있으면: 아무 것도 하지 않음 → 기존 데모 모드 그대로 작동
   ============================================================================ */
(function(){
'use strict';

var cfg = window.FIREBASE_CONFIG || null;
function configured(){
  return !!(cfg && cfg.apiKey && cfg.projectId &&
    cfg.apiKey.indexOf('붙여넣') === -1 && cfg.apiKey.indexOf('YOUR') === -1);
}
if(!configured()){
  console.info('[말씀함께] firebase-config.js 미설정 — 데모 모드로 실행됩니다.');
  return;
}

/* ── 전역 참조 (index.html 본문 스크립트의 전역들) ───────────────────── */
var KEYS = window.STORAGE_KEYS || STORAGE_KEYS;
var ORIG_WRITE = null;       // 패치 전 _write 원본 (미러 갱신용 — 서버 재전송 방지)
var auth = null, db = null;
var cloudUser = null;        // firebase.User
var unsubs = [];             // onSnapshot 해제 함수들
var postUnsubs = [];
var syncTimers = {};
var patched = false;

/* 서버와 동기화하는 "개인" 데이터 키 (값 전체를 JSON으로 미러링) */
var USER_SYNC = ['user','lectio','diary','prayed','columnState','prefs','prayerLog'];
var REV = {}; // storageKey → shortKey
USER_SYNC.forEach(function(k){ REV[KEYS[k]] = k; });

/* ════════════════════════════════════════════════════════════════════════
   1. 로그인 화면 (오버레이) — SDK 로드 전에 먼저 띄워 깜빡임 방지
   ════════════════════════════════════════════════════════════════════════ */
var css = ''+
'#mh-auth{position:fixed;inset:0;z-index:99999;background:linear-gradient(165deg,#f6f4ee 0%,#eef0e6 60%,#e6ebdd 100%);display:flex;align-items:center;justify-content:center;padding:22px;overflow-y:auto}'+
'#mh-auth.hide{display:none}'+
'#mh-auth .card{width:100%;max-width:360px;background:#fff;border-radius:22px;box-shadow:0 14px 44px rgba(90,105,80,.16);padding:30px 24px 26px;text-align:center}'+
'#mh-auth h1{font-size:25px;letter-spacing:-.5px;color:#4c5a44;margin:6px 0 4px;font-weight:800}'+
'#mh-auth .sub{font-size:13px;color:#8a937f;margin-bottom:20px;line-height:1.6}'+
'#mh-auth .leaf{font-size:30px}'+
'#mh-auth .btn-row{display:flex;flex-direction:column;gap:9px;margin:14px 0 6px}'+
'#mh-auth button{border:none;border-radius:12px;padding:13px 14px;font-size:14.5px;font-weight:700;cursor:pointer;width:100%;font-family:inherit;transition:filter .15s}'+
'#mh-auth button:active{filter:brightness(.94)}'+
'#mh-auth .b-kakao{background:#FEE500;color:#191919}'+
'#mh-auth .b-phone{background:#5c6f52;color:#fff}'+
'#mh-auth .b-email{background:#eef0e6;color:#4c5a44}'+
'#mh-auth .b-main{background:#5c6f52;color:#fff}'+
'#mh-auth .b-ghost{background:transparent;color:#8a937f;font-weight:600;font-size:13px;padding:8px}'+
'#mh-auth input{width:100%;box-sizing:border-box;border:1.5px solid #dde2d2;border-radius:11px;padding:12px 13px;font-size:15px;margin-bottom:9px;font-family:inherit;background:#fbfcf8}'+
'#mh-auth input:focus{outline:none;border-color:#5c6f52}'+
'#mh-auth .err{color:#b04a3a;font-size:12.5px;min-height:17px;margin:4px 0 2px;line-height:1.5}'+
'#mh-auth .note{font-size:11.5px;color:#a2ab97;margin-top:14px;line-height:1.65}'+
'#mh-auth .spin{display:inline-block;width:26px;height:26px;border:3px solid #dde2d2;border-top-color:#5c6f52;border-radius:50%;animation:mhspin .8s linear infinite;margin:10px 0}'+
'@keyframes mhspin{to{transform:rotate(360deg)}}'+
'#mh-recaptcha{display:flex;justify-content:center;margin:6px 0}';

var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

var ov = document.createElement('div');
ov.id = 'mh-auth';
document.documentElement.appendChild(ov);

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

function viewLoading(msg){
  ov.innerHTML = '<div class="card"><div class="leaf">🌿</div><h1>말씀함께</h1>'+
    '<div class="spin"></div><div class="sub">'+esc(msg||'연결하는 중입니다…')+'</div></div>';
}
function viewError(msg){
  ov.innerHTML = '<div class="card"><div class="leaf">🌿</div><h1>말씀함께</h1>'+
    '<div class="err" style="min-height:auto;margin:12px 0">'+esc(msg)+'</div>'+
    '<button class="b-main" onclick="location.reload()">다시 시도</button>'+
    '<div class="note">문제가 계속되면 관리자에게 알려 주세요.</div></div>';
}
function viewMain(err){
  var kakao = window.MH_KAKAO_ENABLED;
  var phone = window.MH_PHONE_ENABLED;
  ov.innerHTML = '<div class="card"><div class="leaf">🌿</div><h1>말씀함께</h1>'+
    '<div class="sub">매일 말씀과 기도로 함께하는<br/>우리 교회 묵상 앱</div>'+
    '<div class="btn-row">'+
    (kakao ? '<button class="b-kakao" id="mh-b-kakao">💬&nbsp; 카카오로 시작하기</button>' : '')+
    (phone ? '<button class="b-phone" id="mh-b-phone">📱&nbsp; 휴대폰 번호로 시작하기</button>' : '')+
    '<button class="b-email" id="mh-b-email">✉️&nbsp; 이메일로 시작하기</button>'+
    '</div>'+
    '<div class="err">'+esc(err||'')+'</div>'+
    '<div class="note">처음이신가요? 위 버튼으로 시작하면<br/>자동으로 가입됩니다. (무료)</div></div>';
  var bk = document.getElementById('mh-b-kakao'); if(bk) bk.onclick = doKakao;
  var bp = document.getElementById('mh-b-phone'); if(bp) bp.onclick = function(){ viewPhone(); };
  document.getElementById('mh-b-email').onclick = function(){ viewEmail(false); };
}
function viewEmail(isSignup, err){
  ov.innerHTML = '<div class="card"><div class="leaf">✉️</div><h1>'+(isSignup?'이메일로 가입':'이메일 로그인')+'</h1>'+
    '<div class="sub">'+(isSignup?'교회에서 쓰는 이름으로 가입해 주세요':'가입하신 이메일로 로그인하세요')+'</div>'+
    (isSignup ? '<input id="mh-name" placeholder="이름 (예: 김성도)" autocomplete="name"/>' : '')+
    '<input id="mh-email" type="email" placeholder="이메일 주소" autocomplete="email"/>'+
    '<input id="mh-pw" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="'+(isSignup?'new-password':'current-password')+'"/>'+
    '<div class="err">'+esc(err||'')+'</div>'+
    '<div class="btn-row">'+
    '<button class="b-main" id="mh-b-go">'+(isSignup?'가입하고 시작하기':'로그인')+'</button>'+
    '<button class="b-ghost" id="mh-b-sw">'+(isSignup?'이미 계정이 있어요 → 로그인':'처음이에요 → 가입하기')+'</button>'+
    (isSignup?'':'<button class="b-ghost" id="mh-b-reset">비밀번호를 잊었어요</button>')+
    '<button class="b-ghost" id="mh-b-back">← 다른 방법으로 시작</button>'+
    '</div></div>';
  document.getElementById('mh-b-go').onclick = function(){ doEmail(isSignup); };
  document.getElementById('mh-pw').onkeyup = function(e){ if(e.key==='Enter') doEmail(isSignup); };
  document.getElementById('mh-b-sw').onclick = function(){ viewEmail(!isSignup); };
  document.getElementById('mh-b-back').onclick = function(){ viewMain(); };
  var br = document.getElementById('mh-b-reset');
  if(br) br.onclick = doPwReset;
}
function viewPhone(err){
  ov.innerHTML = '<div class="card"><div class="leaf">📱</div><h1>휴대폰 번호 로그인</h1>'+
    '<div class="sub">문자로 인증번호를 보내드립니다</div>'+
    '<input id="mh-phone" type="tel" placeholder="010-1234-5678" autocomplete="tel"/>'+
    '<div id="mh-recaptcha"></div>'+
    '<div class="err">'+esc(err||'')+'</div>'+
    '<div class="btn-row">'+
    '<button class="b-main" id="mh-b-sms">인증번호 받기</button>'+
    '<button class="b-ghost" id="mh-b-back">← 다른 방법으로 시작</button>'+
    '</div></div>';
  document.getElementById('mh-b-sms').onclick = doSendSms;
  document.getElementById('mh-b-back').onclick = function(){ viewMain(); };
}
function viewSmsCode(err){
  ov.innerHTML = '<div class="card"><div class="leaf">📨</div><h1>인증번호 입력</h1>'+
    '<div class="sub">문자로 받은 6자리 숫자를 입력해 주세요</div>'+
    '<input id="mh-code" type="tel" inputmode="numeric" placeholder="인증번호 6자리" maxlength="6"/>'+
    '<div class="err">'+esc(err||'')+'</div>'+
    '<div class="btn-row">'+
    '<button class="b-main" id="mh-b-ok">확인</button>'+
    '<button class="b-ghost" id="mh-b-back">← 번호 다시 입력</button>'+
    '</div></div>';
  document.getElementById('mh-b-ok').onclick = doVerifySms;
  document.getElementById('mh-code').onkeyup = function(e){ if(e.key==='Enter') doVerifySms(); };
  document.getElementById('mh-b-back').onclick = function(){ viewPhone(); };
}

viewLoading('말씀함께를 준비하고 있습니다…');

/* ── 한국어 오류 메시지 ─────────────────────────────────────────────── */
function koErr(e){
  var c = (e && e.code) || '';
  var map = {
    'auth/invalid-email':'이메일 주소 형식이 올바르지 않습니다.',
    'auth/user-not-found':'가입된 계정이 없습니다. [처음이에요 → 가입하기]를 눌러 주세요.',
    'auth/wrong-password':'비밀번호가 올바르지 않습니다.',
    'auth/invalid-credential':'이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/email-already-in-use':'이미 가입된 이메일입니다. 로그인해 주세요.',
    'auth/weak-password':'비밀번호는 6자 이상으로 정해 주세요.',
    'auth/too-many-requests':'시도가 너무 많았습니다. 잠시 후 다시 해주세요.',
    'auth/network-request-failed':'인터넷 연결을 확인해 주세요.',
    'auth/popup-closed-by-user':'로그인 창이 닫혔습니다. 다시 시도해 주세요.',
    'auth/invalid-phone-number':'휴대폰 번호 형식이 올바르지 않습니다. (예: 010-1234-5678)',
    'auth/invalid-verification-code':'인증번호가 올바르지 않습니다.',
    'auth/code-expired':'인증번호 유효시간이 지났습니다. 다시 받아 주세요.',
    'auth/operation-not-allowed':'관리자가 아직 이 로그인 방법을 켜지 않았습니다.',
    'auth/unauthorized-domain':'이 주소(도메인)가 Firebase 승인 도메인에 등록되지 않았습니다. 가이드 4단계를 확인해 주세요.'
  };
  return map[c] || ('문제가 발생했습니다. ('+(c||(e&&e.message)||'알 수 없는 오류')+')');
}

/* ════════════════════════════════════════════════════════════════════════
   2. Firebase SDK 로드 → 초기화
   ════════════════════════════════════════════════════════════════════════ */
var V = '10.14.1';
function loadScript(src){
  return new Promise(function(res, rej){
    var s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = function(){ rej(new Error('load fail: '+src)); };
    document.head.appendChild(s);
  });
}
['firebase-app-compat.js','firebase-auth-compat.js','firebase-firestore-compat.js']
  .reduce(function(p, f){ return p.then(function(){ return loadScript('https://www.gstatic.com/firebasejs/'+V+'/'+f); }); }, Promise.resolve())
  .then(start)
  .catch(function(e){
    console.error('[말씀함께] SDK 로드 실패', e);
    viewError('인터넷 연결이 필요합니다. 연결 후 다시 열어 주세요.');
  });

function start(){
  firebase.initializeApp(cfg);
  auth = firebase.auth();
  db = firebase.firestore();
  try{ db.enablePersistence({ synchronizeTabs:true }).catch(function(){}); }catch(e){}
  auth.languageCode = 'ko';

  /* 카카오 리다이렉트 복귀 처리 */
  auth.getRedirectResult().catch(function(e){ viewMain(koErr(e)); });

  auth.onAuthStateChanged(function(u){
    if(u){ onSignedIn(u); }
    else { onSignedOut(); }
  });
}

/* ── 로그인 동작들 ──────────────────────────────────────────────────── */
function doEmail(isSignup){
  var email = (document.getElementById('mh-email').value||'').trim();
  var pw = document.getElementById('mh-pw').value||'';
  var name = isSignup ? (document.getElementById('mh-name').value||'').trim() : '';
  if(isSignup && !name) return viewEmail(true, '이름을 입력해 주세요.');
  if(!email) return viewEmail(isSignup, '이메일을 입력해 주세요.');
  if(pw.length < 6) return viewEmail(isSignup, '비밀번호는 6자 이상이어야 합니다.');
  viewLoading(isSignup?'가입하는 중입니다…':'로그인하는 중입니다…');
  var p = isSignup
    ? auth.createUserWithEmailAndPassword(email, pw).then(function(cred){
        window.__mhNewName = name;
        return cred.user.updateProfile({ displayName:name });
      })
    : auth.signInWithEmailAndPassword(email, pw);
  p.catch(function(e){ viewEmail(isSignup, koErr(e)); });
}
function doPwReset(){
  var email = (document.getElementById('mh-email').value||'').trim();
  if(!email) return viewEmail(false, '비밀번호를 재설정할 이메일을 먼저 입력해 주세요.');
  auth.sendPasswordResetEmail(email)
    .then(function(){ viewEmail(false, '재설정 메일을 보냈습니다. 메일함을 확인해 주세요.'); })
    .catch(function(e){ viewEmail(false, koErr(e)); });
}
function doKakao(){
  var provider = new firebase.auth.OAuthProvider(window.MH_KAKAO_PROVIDER_ID || 'oidc.kakao');
  viewLoading('카카오로 연결하는 중입니다…');
  auth.signInWithPopup(provider).catch(function(e){
    if(e && (e.code==='auth/popup-blocked' || e.code==='auth/operation-not-supported-in-this-environment' || e.code==='auth/cancelled-popup-request')){
      auth.signInWithRedirect(provider).catch(function(e2){ viewMain(koErr(e2)); });
    }else{
      viewMain(koErr(e));
    }
  });
}
var recaptcha = null, smsConfirm = null;
function doSendSms(){
  var raw = (document.getElementById('mh-phone').value||'').replace(/[^0-9]/g,'');
  if(!/^01[016789][0-9]{7,8}$/.test(raw)) return viewPhone('휴대폰 번호를 확인해 주세요. (예: 010-1234-5678)');
  var intl = '+82' + raw.slice(1);
  try{
    if(!recaptcha){
      recaptcha = new firebase.auth.RecaptchaVerifier('mh-recaptcha', { size:'normal' });
    }
    document.getElementById('mh-b-sms').disabled = true;
    auth.signInWithPhoneNumber(intl, recaptcha).then(function(conf){
      smsConfirm = conf; recaptcha = null;
      viewSmsCode();
    }).catch(function(e){ recaptcha = null; viewPhone(koErr(e)); });
  }catch(e){ recaptcha = null; viewPhone(koErr(e)); }
}
function doVerifySms(){
  var code = (document.getElementById('mh-code').value||'').trim();
  if(code.length !== 6) return viewSmsCode('6자리 인증번호를 입력해 주세요.');
  viewLoading('확인하는 중입니다…');
  smsConfirm.confirm(code).catch(function(e){ viewSmsCode(koErr(e)); });
}

/* ════════════════════════════════════════════════════════════════════════
   3. 로그인 완료 — 데이터 불러오기 · 동기화 · 실시간 연결
   ════════════════════════════════════════════════════════════════════════ */
function onSignedOut(){
  cloudUser = null;
  stopListeners();
  /* 공용 기기 보호 — 내 기록을 이 기기에서 지움 */
  try{ Object.keys(KEYS).forEach(function(k){ safeStore.removeItem(KEYS[k]); }); }catch(e){}
  ov.classList.remove('hide');
  viewMain();
}

function onSignedIn(u){
  cloudUser = u;
  viewLoading('내 기록을 불러오는 중입니다…');
  var uid = u.uid;
  var userRef = db.collection('users').doc(uid);

  Promise.all([ userRef.get(), userRef.collection('kv').get() ]).then(function(rs){
    var profSnap = rs[0], kvSnap = rs[1];

    /* 1) 서버의 개인 데이터 → 이 기기로 복원 */
    try{ Object.keys(KEYS).forEach(function(k){ safeStore.removeItem(KEYS[k]); }); }catch(e){}
    kvSnap.forEach(function(d){
      if(KEYS[d.id] && d.data() && typeof d.data().v === 'string'){
        safeStore.setItem(KEYS[d.id], d.data().v);
      }
    });

    /* 2) 로컬 user 객체 정비 (id=uid 고정) */
    var lu = _read(KEYS.user, null);
    if(!lu){
      var nm = window.__mhNewName || u.displayName || (u.phoneNumber ? '성도님' : '성도님');
      lu = { id:uid, name:nm, avatar:(nm||'성').charAt(0), joinedAt:Date.now() };
    }
    lu.id = uid; lu.loggedIn = true;
    if(u.email) lu.email = lu.email || u.email;
    if(u.phoneNumber) lu.phone = lu.phone || u.phoneNumber;
    _normalizeUser(lu);

    /* 3) 프로필 문서 생성/갱신 (관리자 통계·보안규칙용) */
    var first = !profSnap.exists;
    userRef.set({
      name: lu.nickname || lu.name || '성도님',
      email: u.email || null,
      phone: u.phoneNumber || null,
      provider: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || 'unknown',
      cell: lu.cell || null, district: lu.district || null,
      lastLoginAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge:true });
    if(first){
      userRef.set({ createdAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });
    }

    /* 4) 패치 적용 + 실시간 연결 */
    applyPatches();
    _write(KEYS.user, lu);   // 패치된 _write → 서버에도 저장
    startListeners(uid);

    /* 5) 화면 복귀 */
    ov.classList.add('hide');
    if(typeof state !== 'undefined'){
      api.getUser().then(function(uu){ state.user = uu; refreshUI(); });
    }
    if(first && typeof toast === 'function'){
      setTimeout(function(){ toast('환영합니다! 마이페이지에서 이름·목장을 등록해 주세요 🌿'); }, 1200);
    }
  }).catch(function(e){
    console.error('[말씀함께] 데이터 로드 실패', e);
    viewError('기록을 불러오지 못했습니다. 보안 규칙이 적용됐는지 확인해 주세요. ('+((e&&e.code)||'')+')');
  });
}

/* ── 개인 데이터: _write 패치 → 자동 서버 저장 (0.8초 디바운스) ──────── */
function applyPatches(){
  if(patched) return;
  patched = true;

  ORIG_WRITE = _write;
  _write = function(key, val){
    ORIG_WRITE(key, val);
    var sk = REV[key];
    if(sk && cloudUser) queueSync(sk, val);
  };

  /* 데모 시드 방 생성을 차단 — 클라우드의 방 목록만 사용 */
  ensureRooms = function(){ return _read(KEYS.rooms, []); };

  applyApiOverrides();
}

function queueSync(shortKey, val){
  clearTimeout(syncTimers[shortKey]);
  syncTimers[shortKey] = setTimeout(function(){
    if(!cloudUser) return;
    var uid = cloudUser.uid;
    try{ if(typeof showSync==='function') showSync(true); }catch(e){}
    db.collection('users').doc(uid).collection('kv').doc(shortKey).set({
      v: JSON.stringify(val),
      t: firebase.firestore.FieldValue.serverTimestamp()
    }).then(syncDone, function(e){ console.warn('[sync]', shortKey, e); syncDone(); });
    /* 프로필 변경은 users/{uid} 본문에도 반영 */
    if(shortKey === 'user' && val){
      db.collection('users').doc(uid).set({
        name: val.nickname || val.name || '성도님',
        cell: val.cell || null, district: val.district || null,
        grove: val.grove || null,
        committees: val.committees || [],
        subscribed: !!val.subscribed
      }, { merge:true }).catch(function(){});
    }
  }, 800);
}
function syncDone(){ try{ if(typeof showSync==='function') showSync(false); }catch(e){} }

/* ── 화면 새로고침 (입력 중에는 미루기) ─────────────────────────────── */
var refreshTimer = null;
function refreshUI(){
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function(){
    var ae = document.activeElement;
    if(ae && (ae.tagName==='INPUT' || ae.tagName==='TEXTAREA')){ refreshUI(); return; }
    try{ if(typeof render==='function') render(); }catch(e){}
  }, 350);
}

/* ════════════════════════════════════════════════════════════════════════
   4. 공유 데이터 실시간 미러 (중보기도 · 목장방 · 관리자 콘텐츠)
   ════════════════════════════════════════════════════════════════════════ */
function stopListeners(){
  unsubs.forEach(function(f){ try{ f(); }catch(e){} }); unsubs = [];
  postUnsubs.forEach(function(f){ try{ f(); }catch(e){} }); postUnsubs = [];
}

function startListeners(uid){
  stopListeners();
  var W = function(key, val){ (ORIG_WRITE||_write)(key, val); };

  /* 빈 미러로 초기화 (데모 시드가 보이지 않도록) */
  W(KEYS.prayers, []); W(KEYS.prayersHidden, []);
  W(KEYS.rooms, []); W(KEYS.roomPosts, []); W(KEYS.roomPostsHidden, []);
  W(KEYS.devotionalsCustom, {}); W(KEYS.columnsCustom, {});

  /* 중보기도 */
  unsubs.push(db.collection('prayers').orderBy('time','desc').limit(500).onSnapshot(function(snap){
    var arr = [], hidden = [];
    snap.forEach(function(d){
      var p = d.data(); p.id = d.id;
      if(p.hidden) hidden.push(d.id);
      arr.push(p);
    });
    W(KEYS.prayers, arr); W(KEYS.prayersHidden, hidden);
    refreshUI();
  }, function(e){ console.warn('[prayers]', e); }));

  /* 방 목록 → 내 방 변동 시 나눔 구독도 갱신 */
  var myName = function(){
    var u = _read(KEYS.user, {}) || {};
    return u.nickname || u.name || '나';
  };
  unsubs.push(db.collection('rooms').onSnapshot(function(snap){
    var rooms = [], myIds = [];
    snap.forEach(function(d){
      var r = d.data();
      var joined = (r.memberUids||[]).indexOf(uid) >= 0;
      if(joined) myIds.push(d.id);
      rooms.push({
        id: d.id, type: r.type||'group', name: r.name||'', emoji: r.emoji||'🕊️',
        desc: r.desc||'', code: r.code||'', owner: r.ownerName||'',
        members: r.memberNames||[], joined: joined, createdAt: r.createdAt||0
      });
    });
    rooms.sort(function(a,b){ return (a.type==='cell'?-1:0) - (b.type==='cell'?-1:0) || (b.createdAt-a.createdAt); });
    W(KEYS.rooms, rooms);
    subscribePosts(uid, myIds);
    refreshUI();
  }, function(e){ console.warn('[rooms]', e); }));

  /* 관리자 콘텐츠 — 묵상 본문 */
  unsubs.push(db.collection('devotionals').onSnapshot(function(snap){
    var map = {};
    snap.forEach(function(d){
      try{ map[d.id] = JSON.parse(d.data().v); }catch(e){}
    });
    W(KEYS.devotionalsCustom, map);
    refreshUI();
  }, function(e){ console.warn('[devotionals]', e); }));

  /* 관리자 콘텐츠 — 칼럼 */
  unsubs.push(db.collection('columns').onSnapshot(function(snap){
    var map = {};
    snap.forEach(function(d){
      try{ map[d.id] = JSON.parse(d.data().v); }catch(e){}
    });
    W(KEYS.columnsCustom, map);
    refreshUI();
  }, function(e){ console.warn('[columns]', e); }));

  /* 7만시간 기도운동 — 공동체 누적 */
  unsubs.push(db.collection('stats').doc('movement').onSnapshot(function(d){
    if(d.exists){
      var m = d.data();
      W(KEYS.movement, { totalMin: m.totalMin||0, byDate: m.byDate||{} });
      refreshUI();
    }
  }, function(e){ console.warn('[movement]', e); }));
}

/* 내가 속한 방의 나눔만 구독 (10개씩 묶음 — Firestore 'in' 제한) */
var postChunks = {};
function subscribePosts(uid, roomIds){
  postUnsubs.forEach(function(f){ try{ f(); }catch(e){} });
  postUnsubs = []; postChunks = {};
  if(!roomIds.length){
    (ORIG_WRITE||_write)(KEYS.roomPosts, []);
    (ORIG_WRITE||_write)(KEYS.roomPostsHidden, []);
    return;
  }
  var chunks = [];
  for(var i=0;i<roomIds.length;i+=10) chunks.push(roomIds.slice(i,i+10));
  chunks.forEach(function(chunk, ci){
    postUnsubs.push(
      db.collection('roomPosts').where('roomId','in',chunk).onSnapshot(function(snap){
        var arr = [];
        snap.forEach(function(d){
          var p = d.data();
          arr.push({
            id: d.id, roomId: p.roomId, kind: p.kind, who: p.who||'성도님',
            avatar: p.avatar || (p.who||'성').charAt(0), uid: p.uid||null,
            time: p.time||0, dateKey: p.dateKey||null,
            body: p.body||'', parts: p.parts||null,
            amens: (p.amenUids||[]).length,
            comments: p.comments||[],
            hidden: !!p.hidden,
            _mine: (p.amenUids||[]).indexOf(uid) >= 0
          });
        });
        postChunks[ci] = arr;
        var all = [], hidden = [], myAmens = [];
        Object.keys(postChunks).forEach(function(k){
          postChunks[k].forEach(function(p){
            if(p.hidden) hidden.push(p.id);
            if(p._mine) myAmens.push(p.id);
            all.push(p);
          });
        });
        all.sort(function(a,b){ return b.time - a.time; });
        (ORIG_WRITE||_write)(KEYS.roomPosts, all);
        (ORIG_WRITE||_write)(KEYS.roomPostsHidden, hidden);
        (ORIG_WRITE||_write)(KEYS.roomAmens, myAmens);
        refreshUI();
      }, function(e){ console.warn('[roomPosts]', e); })
    );
  });
}

/* ════════════════════════════════════════════════════════════════════════
   5. 쓰기 동작을 클라우드로 교체 (api 오버라이드)
   ════════════════════════════════════════════════════════════════════════ */
function applyApiOverrides(){
  var FV = firebase.firestore.FieldValue;
  var myInfo = function(){
    var u = _normalizeUser(_read(KEYS.user, null) || {});
    return { uid: cloudUser.uid, name: u.nickname || u.name || '성도님', u: u };
  };
  var origSaveProfile = api.saveProfile.bind(api);
  var origLogPrayer = api.logPrayer.bind(api);
  var origUnlogPrayer = api.unlogPrayer.bind(api);

  /* 로그인/로그아웃 — Firebase 인증으로 대체 */
  api.login = function(){ return api.getUser(); };
  api.logout = function(){
    return auth.signOut().then(function(){ return { ok:true }; });
  };
  api.resetDemo = function(){
    if(typeof toast === 'function') toast('클라우드 모드에서는 초기화할 수 없습니다');
    return Promise.resolve({ ok:false });
  };

  /* 프로필 저장 — 목장 등록 시 목장 방을 클라우드에 개설/합류 */
  api.saveProfile = function(patch){
    return origSaveProfile(patch).then(function(u){
      if(u && u.cell) ensureCellRoomCloud(u);
      return u;
    });
  };

  /* 중보기도 등록 */
  api.createPrayer = function(o){
    var me = myInfo();
    var doc = {
      scope: o.scope||'cell', who: me.name, uid: me.uid,
      body: o.body||'', urgent: !!o.urgent, committee: o.committee||null,
      district: me.u.district||null, cell: me.u.cell||null,
      time: Date.now(), hidden: false
    };
    try{ if(typeof showSync==='function') showSync(true); }catch(e){}
    return db.collection('prayers').add(doc).then(function(ref){
      syncDone();
      doc.id = ref.id;
      var arr = _read(KEYS.prayers, []); arr.unshift(doc);
      (ORIG_WRITE)(KEYS.prayers, arr);
      return doc;
    });
  };

  /* 소그룹 방 만들기 */
  api.createRoom = function(o){
    var me = myInfo();
    var room = {
      type:'group', name:o.name, emoji:o.emoji||'🕊️', desc:o.desc||'',
      code:_roomCode(), ownerUid:me.uid, ownerName:me.name,
      memberUids:[me.uid], memberNames:[me.name], createdAt:Date.now()
    };
    try{ if(typeof showSync==='function') showSync(true); }catch(e){}
    return db.collection('rooms').add(room).then(function(ref){
      syncDone();
      return { id:ref.id, type:'group', name:room.name, emoji:room.emoji, desc:room.desc,
               code:room.code, owner:me.name, members:[me.name], joined:true, createdAt:room.createdAt };
    });
  };

  /* 초대코드로 합류 */
  api.joinRoom = function(code){
    var me = myInfo();
    var c = (code||'').trim().toUpperCase();
    if(!c) return Promise.resolve({ ok:false, msg:'초대코드를 입력해 주세요.' });
    return db.collection('rooms').where('code','==',c).limit(1).get().then(function(snap){
      if(snap.empty) return { ok:false, msg:'초대코드와 일치하는 방이 없습니다.' };
      var d = snap.docs[0], r = d.data();
      if((r.memberUids||[]).indexOf(me.uid) >= 0) return { ok:false, msg:'이미 함께하고 있는 방입니다.' };
      return d.ref.update({
        memberUids: FV.arrayUnion(me.uid),
        memberNames: FV.arrayUnion(me.name)
      }).then(function(){
        return { ok:true, room:{ id:d.id, type:r.type||'group', name:r.name, emoji:r.emoji||'🕊️',
          desc:r.desc||'', code:r.code, owner:r.ownerName||'', members:(r.memberNames||[]).concat([me.name]),
          joined:true, createdAt:r.createdAt||0 } };
      });
    });
  };

  api.leaveRoom = function(id){
    var me = myInfo();
    return db.collection('rooms').doc(id).update({
      memberUids: FV.arrayRemove(me.uid),
      memberNames: FV.arrayRemove(me.name)
    }).then(function(){ return { ok:true }; }, function(){ return { ok:true }; });
  };

  /* 나눔 올리기 */
  api.createRoomPost = function(o){
    var me = myInfo();
    var post = {
      roomId:o.roomId, kind:o.kind, who:me.name, avatar:me.name.charAt(0), uid:me.uid,
      time:Date.now(), body:o.body||'', parts:o.parts||null, dateKey:o.dateKey||null,
      amenUids:[], comments:[], hidden:false
    };
    try{ if(typeof showSync==='function') showSync(true); }catch(e){}
    return db.collection('roomPosts').add(post).then(function(ref){
      syncDone();
      return { id:ref.id, roomId:post.roomId, kind:post.kind, who:post.who, avatar:post.avatar,
               time:post.time, body:post.body, parts:post.parts, dateKey:post.dateKey, amens:0, comments:[] };
    });
  };

  /* 아멘 */
  api.toggleAmen = function(postId){
    var me = myInfo();
    var ref = db.collection('roomPosts').doc(postId);
    return db.runTransaction(function(tx){
      return tx.get(ref).then(function(d){
        if(!d.exists) return { ok:false };
        var uids = d.data().amenUids || [];
        var on = uids.indexOf(me.uid) >= 0;
        tx.update(ref, { amenUids: on ? FV.arrayRemove(me.uid) : FV.arrayUnion(me.uid) });
        return { ok:true, amened:!on, amens: uids.length + (on?-1:1) };
      });
    });
  };

  /* 나눔 댓글 */
  api.addRoomComment = function(postId, text){
    var me = myInfo();
    return db.collection('roomPosts').doc(postId).update({
      comments: FV.arrayUnion({ name:me.name, uid:me.uid, text:text, time:Date.now() })
    }).then(function(){ return { ok:true }; }, function(){ return { ok:false }; });
  };

  /* 기도 시간 기록 — 공동체 누적(7만시간 운동)에 합산 */
  api.logPrayer = function(min){
    return origLogPrayer(min).then(function(r){
      bumpMovement(min); return r;
    });
  };
  api.unlogPrayer = function(min){
    return origUnlogPrayer(min).then(function(r){
      bumpMovement(-min); return r;
    });
  };
  function bumpMovement(min){
    var today = new Date(), k = today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
    var upd = { totalMin: FV.increment(min), byDate: {} };
    upd.byDate[k] = FV.increment(min);
    db.collection('stats').doc('movement').set(upd, { merge:true }).catch(function(){});
  }
}

/* 목장 방 개설/합류 (프로필에 목장 등록 시) */
function ensureCellRoomCloud(u){
  if(!cloudUser) return;
  var uid = cloudUser.uid;
  var name = u.nickname || u.name || '성도님';
  var id = 'cell_' + String(u.cell).replace(/[\/\.\#\$\[\]]/g,'_');
  var ref = db.collection('rooms').doc(id);
  ref.get().then(function(d){
    if(d.exists){
      if((d.data().memberUids||[]).indexOf(uid) < 0){
        ref.update({
          memberUids: firebase.firestore.FieldValue.arrayUnion(uid),
          memberNames: firebase.firestore.FieldValue.arrayUnion(name)
        }).catch(function(){});
      }
    }else{
      ref.set({
        type:'cell', name:u.cell, emoji:'🌿',
        desc:[u.district,u.grove].filter(Boolean).join(' · ')||'우리 목장',
        code:_roomCode(), ownerUid:uid, ownerName:name,
        memberUids:[uid], memberNames:[name], createdAt:Date.now()
      }).catch(function(){});
    }
  }).catch(function(){});
}

})();
