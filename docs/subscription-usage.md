# Subscription usage

[Reading the limits](#reading-the-limits) · [Hosted companion](#hosted-companion)

## Reading the limits

**Weekly · All models** is shared. **Weekly · Fable** measures use of the Fable cap inside that shared allowance; it is not extra quota. The UI uses Claude’s reported share and reset, without assuming a fixed allowance. Missing Fable data is unknown, and failed checks retain labeled last-known data when available. Nothing on this screen spends a reset or enables usage credits.

## Hosted companion

`src/server/subscription-proxy.ts` adds Fable, Kimi and OpenCode Go data to the native owner-only usage route. Every request is authorized by Pocket before reading saved credentials. It reads current access tokens but never refreshes or writes them. Checks share a five-minute cache and honor provider cooldowns. A failed supplemental check preserves the native shared limits; a missing Claude configuration does not break Kimi or Go.

The existing hosted usage service runs separately from Pocket. Deploy its parser and proxy together; its short restart does not restart agents or workers. Future native builds that already report Fable skip the duplicate Claude check.

<details>
<summary>Companion launch and focused verification</summary>

```bash
node --test test/subscription-usage.test.ts test/subscription-proxy.test.ts test/subscription-usage-ui.test.ts
POCKET_USAGE_HOST=127.0.0.1 POCKET_USAGE_PORT=8795 node src/server/subscription-proxy.ts
```

The hosted launcher can import `startUsageProxy` from the copied TypeScript proxy. Keep `subscription-proxy.ts` and `subscription-usage.ts` beside it. The host’s existing authenticated gateway forwards only `/api/subscription-usage` to this companion. Its fixed native upstream is `127.0.0.1:8796`; credentials remain in the service’s private runtime home.

</details>
