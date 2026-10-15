export interface OpenAiConfig {readonly model:string;readonly apiKey:string;readonly prompt:string;readonly maxOutputTokens?:number}
// No endpoint override or automatic provider/model fallback: credentials cannot follow redirects.
export const OPENAI_RESPONSES_URL='https://api.openai.com/v1/responses';
