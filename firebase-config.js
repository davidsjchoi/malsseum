/* ============================================================================
   말씀함께 v0.7 — Firebase 연결 설정
   ----------------------------------------------------------------------------
   ★ 이 파일만 수정하면 됩니다 ★

   1) https://console.firebase.google.com 에서 프로젝트 만들기
   2) 프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → 웹앱(</>) 추가
   3) 화면에 나오는 firebaseConfig 안의 값들을 아래에 그대로 붙여넣기

   ※ 아래 값이 비어 있으면 앱은 기존처럼 "데모 모드"(기기 저장)로 작동합니다.
      → 설정 전에도 앱이 깨지지 않으니 안심하세요.
   ============================================================================ */

window.FIREBASE_CONFIG = {
  apiKey:            "여기에_붙여넣기",
  authDomain:        "여기에_붙여넣기",   // 예: malsseum.firebaseapp.com
  projectId:         "여기에_붙여넣기",   // 예: malsseum
  storageBucket:     "여기에_붙여넣기",
  messagingSenderId: "여기에_붙여넣기",
  appId:             "여기에_붙여넣기"
};

/* 카카오 로그인 사용 여부 — Firebase 콘솔에서 OIDC(카카오) 설정을 마친 뒤 true 로 */
window.MH_KAKAO_ENABLED = false;

/* 휴대폰 번호 로그인 사용 여부 — Firebase 요금제(Blaze) 전환 후 true 로 */
window.MH_PHONE_ENABLED = false;
