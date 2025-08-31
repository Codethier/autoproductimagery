export interface batchRequest {
    batch: {
        displayName: string,
        inputConfig: InputConfig
    }
}

export type InputConfig =
    | { fileName: string } // name of a File resource with JSONL requests
    | { requests: InLinedRequests }; // inline requests variant

export interface InLinedRequests {
    requests: InlinedRequest[]
}

export interface InlinedRequest {
    request: GenerateContentRequest
}

export interface GenerateContentRequest {
    model: string,
    contents: Content[]
}

export interface Content {
    parts: Part[]
    role?: 'user' | 'model'
}

export type Part = { text: string } | { inlineData: inlineData };

export interface inlineData {
    mimeType: string,
    data: string
}