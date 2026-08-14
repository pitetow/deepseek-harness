# `@deepseek-ai/dsh-host-account-balance`

Web status-bar account balance: registers the exact `GET /api/balance` route on the dsh webserver, resolving the provider API key through the credential seam (the same `DEEPSEEK_API_KEY` reference the llm-deepseek route reads) and querying the DeepSeek platform balance endpoint. The conversation StatsLine refetches it after every completed turn.

## Config

None. The key reference is the provider's default (`DEEPSEEK_API_KEY`), so no separate configuration is needed beyond the API key the user already stores through the Web Models page or the launching environment.

## Response

```json
{ "isAvailable": true, "balance": 12.34, "currency": "CNY" }
```

A missing key and any platform failure both answer `{ "isAvailable": false }` so the client shows a single "balance unknown" state. The API key never appears in the response.
