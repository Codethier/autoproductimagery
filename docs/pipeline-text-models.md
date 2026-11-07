# Pipeline prompt-enhancement text models

Audited 2026-10-14. Prompt Enhancer has an explicit model selector and model-specific reasoning effort (called attention level in the UI). It uses Vercel AI SDK through AI Gateway. These models accept text and validated private image references and return bounded text; they are separate from image generators and do not output transparent images.

| Exact Gateway ID | Reasoning choices | Temperature | Integration |
| --- | --- | --- | --- |
| `zai/glm-5.3-flash` | Low, High, Max | 0–1 | Always-on thinking; native Z.AI serving provider only. Default Low, temperature 1, 4096 output tokens. |
| `openai/gpt-6-luna` | None, Low, Medium, High, Extra high, Max | 0–2 only with None | Native OpenAI serving provider only. Default Low and 4096 output tokens; omit unsupported sampling settings when reasoning is enabled. |
| `google/gemini-2.5-flash` | None, Low, Medium, High | 0–2 | Existing snapshots default to None and retain their old token/temperature settings. The optional budgets are 0, 512, 1024 and 2048 thinking tokens; enabled thinking uses Google serving only. |

The application caps optional reference images at 8 and their combined bytes at 100 MiB, returned text at 20,000 characters, and output tokens at 16,384 for the new models (4096 for legacy Gemini). Reasoning consumes the output cap and may increase cost and latency. A small cap may return no usable answer, in which case the attempt still retains any Gateway charge. The Gemini cap must leave room after the selected thinking budget.

Only Prompt Enhancer receives the new selectable models. Describe Image and LLM retain their existing Gemini behavior. New empty enhancer nodes also retain Gemini as their default; existing saved definitions remain valid. Changing the enhancer model synchronously resets its sampling, reasoning and token settings while preserving the user’s prompt and system instruction. The run snapshot and `pipelineTextConfig` preserve the exact model, normalized effort, tokens, temperature and image URLs for history/retry. This changes the TypeScript shape of an existing JSONB column without a database migration.

No arbitrary model IDs, tools, provider payloads, public media URLs, file/video/audio features, or model fallback are accepted. Existing bounded timeout, admission leases, pending-generation accounting, source revocation checks and confirmed-price publication apply to these text calls. Provider retries are disabled. Exact post-call Gateway records determine billing rather than rate estimates. Reasoning traces are not published as the enhanced prompt.

The installed AI SDK is v6. Native options are sent through `providerOptions`; the v7-only top-level `reasoning` shorthand is not used. Native provider routing restrictions avoid forwarding settings to a provider that ignores the namespace. Gateway catalog availability and native model controls were checked in official sources; automated tests mock the SDK’s actual outbound Gateway protocol and do not make paid requests.

## Official sources

- [Vercel GLM 5.3 Flash model](https://vercel.com/ai-gateway/models/glm-5.3-flash): exact ID and image/text input support.
- [Z.AI GLM 5.3 Flash guide](https://docs.z.ai/guides/vlm/glm-5.3-flash) and [Z.AI Chat Completion reference](https://docs.z.ai/api-reference/llm/chat-completion): enabled thinking, native low/high/max efforts and temperature range.
- [Z.AI-owned GLM 5.3 Flash model card](https://huggingface.co/zai-org/GLM-5.3-Flash): unsupported effort values fall back to Max, so the application rejects them.
- [Vercel GPT-6 Luna model](https://vercel.com/ai-gateway/models/gpt-6-luna) and [OpenAI GPT-6 Luna profile](https://developers.openai.com/api/docs/models/gpt-6-luna): exact ID, input support and six native effort levels.
- [OpenAI GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model): temperature is unsupported with reasoning effort other than None.
- [Vercel Gateway reasoning](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning): SDK v6 uses native provider options; v7 reasoning shorthand is unavailable here.
- [Vercel provider routing](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options): native option namespaces and serving-provider restrictions.
- [AI SDK compatible chat model options](https://ai-sdk.dev/providers/openai-compatible-providers#chat-model-options): native camel-case `reasoningEffort` under the named provider namespace, including provider-specific accepted values.
- [Google Gemini thinking guide](https://ai.google.dev/gemini-api/docs/thinking): Gemini 2.5 uses explicit thinking budgets.
- [Public Gateway catalog](https://ai-gateway.vercel.sh/v1/models): all three exact IDs, text/image modalities and native effort choices were present on the audit date.
