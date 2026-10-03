import { createChatGPTInterpretRequest, validateChatGPTInterpretResponse, type ChatGPTInterpretRequest } from '../native/chatgpt';
import type { IntentProvider, Interpretation, ProviderRequest } from './types';

export type ChatGPTTransport = (request: ChatGPTInterpretRequest) => Promise<unknown>;
/** Credentials, account discovery and the authenticated stream remain in the native process. */
export class ChatGPTProvider implements IntentProvider {
  readonly name: string;
  constructor(private readonly model: string, private readonly transport: ChatGPTTransport) {
    if (!model.trim() || model.length > 200) throw new Error('Choose a model discovered for your signed-in ChatGPT account.');
    this.name = `ChatGPT (${model})`;
  }
  async interpret(input: ProviderRequest): Promise<Interpretation> {
    const request = createChatGPTInterpretRequest(this.model, input);
    return validateChatGPTInterpretResponse(request, await this.transport(request)).interpretation;
  }
}
