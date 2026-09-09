# Image model catalog audit

Checked September 9, 2026 against the [live Gateway catalog](https://ai-gateway.vercel.sh/v1/models), Gateway model pages, and official provider/AI SDK documentation. All providers are in scope. Eligibility requires text prompts plus uploaded image inputs and raster image output through the AI SDK/Gateway integration.

The catalog contained 38 image-output entries: 27 selectable profiles, one Gemini preview alias resolved to its existing GA profile, and 10 exclusions below. Catalog `architecture.input_modalities` is incomplete for native image models: it labels several documented editing models as text-input-only. Check the editing route and provider options before deciding eligibility.

## Selectable profiles

Reference limits below count the product image plus shared references **per generation job**. Each selected product creates a separate job. Native image models newly added here accept PNG/JPEG references in this app. OpenAI also accepts WebP; Gemini additionally accepts HEIC.

| Gateway model ID | References per job | Settings and input route |
| --- | ---: | --- |
| `google/gemini-3.1-flash-image` | 14 | Existing Gemini language-image route; 512/1K/2K/4K |
| `google/gemini-3-pro-image` | 14 | Existing Gemini route; 1K/2K/4K |
| `google/gemini-3.1-flash-lite-image` | 14 | Existing Gemini route; 1K |
| `google/gemini-2.5-flash-image` | 16 | Existing legacy Gemini route |
| `openai/gpt-image-2.5-sunburst` | 16 | Custom dimensions, quality through max, transparency, optional alpha mask |
| `openai/gpt-image-2.5-flare` | 16 | Custom dimensions, quality through max, transparency, optional alpha mask |
| `openai/gpt-image-2` | 16 | Custom dimensions, quality through high, opaque output, optional alpha mask |
| `openai/gpt-image-1.5` | 16 | Three fixed sizes, quality through high, transparency, optional alpha mask |
| `openai/gpt-image-1` | 16 | Three fixed sizes, quality through high, transparency, optional alpha mask |
| `openai/gpt-image-1-mini` | 16 | Three fixed sizes, quality through high, transparency, optional alpha mask |
| `bfl/flux-2-flex` | 8 | Image files; output size, PNG/JPEG, seed |
| `bfl/flux-2-klein-4b` | 4 | Image files; output size, PNG/JPEG, seed |
| `bfl/flux-2-klein-9b` | 4 | Image files; output size, PNG/JPEG, seed |
| `bfl/flux-2-max` | 8 | Image files; output size, PNG/JPEG, seed |
| `bfl/flux-2-pro` | 8 | Image files; output size, PNG/JPEG, seed |
| `bfl/flux-kontext-max` | 1 | Image files; aspect ratio, PNG/JPEG, seed |
| `bfl/flux-kontext-pro` | 1 | Image files; aspect ratio, PNG/JPEG, seed |
| `bfl/flux-pro-1.0-fill` | 1 | Requires a same-size PNG luminance mask: white replaces, black preserves |
| `bfl/flux-pro-1.1` | 1 | Base64 `blackForestLabs.imagePrompt` for visual conditioning; fixed size choices, PNG/JPEG, seed |
| `bfl/flux-pro-1.1-ultra` | 1 | Base64 `blackForestLabs.imagePrompt`; aspect ratio, reference influence, PNG/JPEG, seed |
| `bytedance/seedream-4.0` | 14 | Image files; 1K/2K/4K, JPEG, watermark |
| `bytedance/seedream-4.5` | 14 | Image files; 2K/4K, JPEG, watermark |
| `bytedance/seedream-5.0-lite` | 14 | Image files; 2K/3K/4K, PNG/JPEG, watermark |
| `bytedance/seedream-5.0-pro` | 10 | Image files; 1K/2K, PNG/JPEG, watermark |
| `meta/muse-image-1.0` | 4 | Image files; model-selected output dimensions/format |
| `spacexai/grok-imagine-image` | 3 | Image files; aspect ratio, up to ten outputs |
| `spacexai/grok-imagine-image-2.0` | 5 | Image files; aspect ratio, 1K/2K, up to ten outputs |

OpenAI and Grok allow 1–10 outputs per product, subject to the application's 50-output request cap. Other native profiles produce one output per product. Seedream sends its resolution tier as `providerOptions.bytedance.size`, with sequential generation disabled. Grok uses the `xai` provider-options namespace even though its Gateway ID starts with `spacexai/`. FLUX 1.1 uses visual conditioning; Kontext and FLUX.2 are more appropriate for targeted product edits. FLUX Fill's mask semantics differ from OpenAI's transparent-area mask, so changing between them clears the selected mask.

Sources: [OpenAI image guide](https://developers.openai.com/api/docs/guides/image-generation), [Google image generation](https://ai.google.dev/gemini-api/docs/image-generation), [AI SDK Black Forest Labs](https://ai-sdk.dev/providers/ai-sdk-providers/black-forest-labs), [BFL live OpenAPI schemas](https://api.bfl.ai/openapi.json), [FLUX.2 reference limits](https://docs.bfl.ai/flux_2/flux2_overview), [FLUX Ultra image prompting](https://docs.bfl.ai/flux_models/flux_1_1_pro_ultra_raw), [AI SDK ByteDance](https://ai-sdk.dev/providers/ai-sdk-providers/bytedance), [AI SDK xAI](https://ai-sdk.dev/providers/ai-sdk-providers/xai), [Grok multi-image editing](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing), and [Muse's Gateway reference-image controls](https://vercel.com/ai-gateway/models/muse-image-1.0).

## Aliases and exclusions

`google/gemini-3.1-flash-image-preview` is an existing alias for `google/gemini-3.1-flash-image`; it does not need a duplicate selector entry. Earlier 2.5 Flash and 3 Pro preview aliases remain supported for stored history as well.

| Catalog ID | Reason not selectable |
| --- | --- |
| `prodia/flux-fast-schnell` | Gateway documents text-to-image only, without image inputs. |
| `quiverai/arrow-1.1` | Produces SVG; the current product stores and validates decoded raster imagery. |
| `recraft/recraft-v2` | No verified uploaded-reference route through Gateway. Recheck when Gateway editing support is documented. |
| `recraft/recraft-v3` | No verified uploaded-reference route through Gateway. Recheck when Gateway editing support is documented. |
| `recraft/recraft-v4` | Gateway documents text-to-image; no verified uploaded-reference route. |
| `recraft/recraft-v4-pro` | No verified uploaded-reference route through Gateway. |
| `recraft/recraft-v4.1` | No verified uploaded-reference route through Gateway. |
| `recraft/recraft-v4.1-pro` | No verified uploaded-reference route through Gateway. |
| `recraft/recraft-v4.1-utility` | No verified uploaded-reference route through Gateway. |
| `recraft/recraft-v4.1-utility-pro` | No verified uploaded-reference route through Gateway. |

The Recraft exclusions describe the verified Gateway integration, not every capability of Recraft's own API or application. Do not silently discard product pictures to make a text-only call. Sources: [Prodia Schnell](https://vercel.com/ai-gateway/models/flux-fast-schnell), [Arrow generation and vectorization](https://vercel.com/ai-gateway/models/arrow-1.1), [Recraft V2/V3 on Gateway](https://vercel.com/changelog/recraft-image-models-now-on-ai-gateway), [Recraft V4 on Gateway](https://vercel.com/changelog/recraft-v4-on-ai-gateway), and [Recraft V4.1 Utility catalog](https://vercel.com/ai-gateway/models/recraft-v4.1-utility).

## Next refresh

“Add new models” means repeat this audit across the entire live catalog, update these decisions, and integrate each eligible missing model end to end. Profiles are in `schemas/image-generation.ts`; the additional native-provider schemas and controls are in `schemas/catalog-image-models.ts`. Use exact IDs and strict settings; never infer editing support from a model name or description. Do not enable a model with an unverified reference-image path. Routine verification uses mocked Gateway HTTP calls and never purchases generations.
