// <!--Therre is no batch for nano bana yet-->

// import type {GenerateOptions} from "~~/schemas/main.dto";
// import {
//     type batchRequest,
//     type Content,
//     type GenerateContentRequest,
//     inlineData,
//     type InputConfig,
//     type Part
// } from "~~/schemas/geminiTypes.dto";
//
// export function useGeminiBatch() {
//     const runtimeConfig = useRuntimeConfig()
//     const apiKey = runtimeConfig.GeminiApiKey
//     if (!apiKey) {
//         throw createError({statusCode: 500, statusMessage: 'Gemini API key is missing in runtimeConfig.GeminiApiKey'})
//     }
//     function generateParts(generateOptions: GenerateOptions): Part[] {
//         let parts = []
//         parts.push({
//             text: generateOptions.prompt
//         })
//         if (generateOptions.inputImages) {
//             if (generateOptions.inputImages.length > 0) {
//                 for (let i of generateOptions.inputImages) {
//                     let inlineData: inlineData = {
//                         mimeType: i.mimeType,
//                         data: i.dataBase64
//                     }
//                     parts.push({inlineData: inlineData})
//                 }
//             }
//         }
//         return parts
//     }
//
//     function generateContent(generateOptions: GenerateOptions): Content {
//         let parts = generateParts(generateOptions)
//         return {role: 'user', parts: parts}
//     }
//
//     function generateGenerateContentRequest(generateOptions: GenerateOptions): GenerateContentRequest {
//         // proly need to do the actual batching here
//         let model = generateOptions.model || runtimeConfig.public.GeminiModels.gemini25FlashIOImagePreview
//         return {model: `models/${model}`, contents: [generateContent(generateOptions)]}
//     }
//
//     function generateInputConfig(generateOptions: GenerateOptions,): InputConfig {
//         let request = generateGenerateContentRequest(generateOptions)
//         // https://ai.google.dev/gemini-api/docs/batch-mode#input-file
//         // CANT CHANGE THIS VARIABLE NAME!
//         let input_config: InputConfig = {
//                 requests: {
//                     requests: [{
//                         request: request,
//                     }]
//                 }
//         }
//         return input_config
//     }
//
//     function generateBatchRequestBody(generateOptions: GenerateOptions, name: string):batchRequest {
//         return {batch:{displayName:name, inputConfig: generateInputConfig(generateOptions)}}
//     }
//
//     function generateFetchRequest(generateOptions: GenerateOptions, name: string) {
//         let req = generateBatchRequestBody(generateOptions, name)
//         let model = generateOptions.model || runtimeConfig.public.GeminiModels.gemini25FlashIOImagePreview
//         return $fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${'batchGenerateContent'}`, {
//             method: 'POST',
//             body: req,
//             headers: {
//                 'Content-Type': 'application/json',
//                 'x-goog-api-key': apiKey,
//             },
//         })
//
//     }
//
//     return {generateFetchRequest}
// }