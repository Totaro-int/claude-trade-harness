#!/bin/sh
# claude -p 대역: 인자를 무시하고 고정 판단 JSON을 envelope에 담아 출력
cat <<'EOF'
{"result": "분석 결과는 다음과 같습니다.\n{\"marketView\": \"테스트 시장\", \"decisions\": [{\"action\": \"BUY\", \"symbol\": \"005930\", \"quantity\": 5, \"orderType\": \"MARKET\", \"reasoning\": \"스텁 매수 근거\", \"thesis\": {\"why\": \"반도체 회복\", \"target\": \"+6%\", \"stop\": \"-3%\", \"exitCondition\": \"20일선 이탈\"}}]}}"}
EOF
