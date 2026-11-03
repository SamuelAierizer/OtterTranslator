# Provider checks — 2026-11-03

Public documentation was checked during v1 implementation. **No account dashboard, provider credentials, SMTP credentials or live translation was available**, so account entitlements and actual remaining allowances are unverified. Historical spike files are research snapshots, not guarantees.

| Provider | Current primary-source evidence | Required account check |
|---|---|---|
| Azure Translator | [Pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/translator/) lists F0 with 2 million characters/month. [Limits](https://learn.microsoft.com/azure/ai-services/translator/service-limits) list 50,000 characters/request and a sliding hourly rate. | Use a dedicated F0 resource; verify tier, region, remaining monthly allowance, subscription and other consumers. An S1 key does not become free because this app has a counter. |
| Google Cloud Basic | [Pricing](https://cloud.google.com/products/translate/pricing) lists 500,000 characters/month as a shared $10 credit across Basic/Advanced text translation. [Quotas](https://docs.cloud.google.com/translate/quotas) default daily character usage to unlimited. | Dedicated account/project and restricted API key; verify shared-credit consumption. Set provider quotas and billing controls. Alerts are not a hard spending cap. Leave fallback key empty until verified. |
| Cerebras review | [Pricing](https://www.cerebras.ai/pricing) advertises pay-as-you-go with a starting $5 credit. [Rate limits](https://inference-docs.cerebras.ai/support/rate-limits) are organization/model/tier dependent. | Do not rely on the old permanent-free-tier claim. Verify trial expiry, model access, card/billing behavior and hard account controls; otherwise leave the key unset. |
| Groq review | [Rate limits](https://console.groq.com/docs/rate-limits) list free-plan limits for `openai/gpt-oss-120b` (30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD at review time). | Check the account's actual plan/model limits and absence of paid auto-upgrade. Request pacing in code does not guarantee token/day eligibility. |

The Microsoft transport uses the documented [global v3 base URL](https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/reference), with the resource region in the subscription header. The earlier region-prefixed hostname was incorrect and has been fixed. A region header alone does not promise processing restricted to that region.

The service persists provider counters in SQLite: Microsoft 2,000,000 and Google 500,000 characters per UTC calendar month. Network attempts reserve characters atomically in SQLite before sending; failures/timeouts keep the reservation. This is an application budget, not a provider billing guarantee: provider windows, consumption outside this app, lost ledgers and uncertain network responses can differ. Use one server/worker and dedicated free-tier accounts. Reconcile provider usage before restoring old ledgers. Leave optional providers disabled when account-level spend controls are not established.

## Privacy

- [Microsoft Translator data privacy](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/translator/data-privacy-security) says text translation does not persist customer content.
- [Google Translation data usage](https://docs.cloud.google.com/translate/data-usage) limits processing to providing the service, excludes model training, and describes brief in-memory processing. Basic's global endpoint does not guarantee processing in one selected region.
- [Cerebras retention](https://support.cerebras.net/articles/1811589793-does-cerebras-retain-my-data) says inference content is not retained; usage/account metadata is retained. Confirm applicable contractual terms for the actual account.
- [Groq data controls](https://console.groq.com/docs/your-data) distinguish default inference behavior, reliability/abuse logs (up to 30 days), and Zero Data Retention controls. Enable ZDR and check the organization's settings before confidential review. No-training and no-retention are different properties.

These are published service statements, not account verification or a blanket regulatory guarantee. Server review is explicitly opt-in (`ENABLE_LLM_REVIEW=true`); translated text may include confidential content and should only be sent after the administrator checks the applicable provider settings. No accounts or paid services were created by this implementation.
