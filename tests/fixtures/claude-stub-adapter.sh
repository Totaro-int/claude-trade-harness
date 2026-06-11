#!/bin/bash
# Ignore all args and stdin; output a valid adapter code block envelope
cat <<'EOF'
{"result":"생성했습니다.\n```typescript\nimport type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';\nexport function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter {\n  return {\n    id: 'stub',\n    async auth() {},\n    async getQuotes(symbols) { return symbols.map(s => ({ symbol: s, name: s, price: 1000, bid: 1000, ask: 1000, changeRate: 0, volume: 0 })); },\n    async getBalance() { return { cash: 0, positions: [] }; },\n    async isMarketOpen() { return true; },\n  };\n}\n```"}
EOF
