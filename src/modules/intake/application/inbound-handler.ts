import type { InboundPayload } from '../domain/inbound-event.js';
import type { OutboundMessageDraft } from '../../delivery/domain/outbound-message.js';

export interface HandleInboundInput {
  readonly sequence: bigint;
  readonly payload: InboundPayload;
}

export type HandleInboundResult = FoundationInboundResult | TaskInboundResult;
export interface TaskInboundResult {
 readonly receiptType: 'task_commands_v1'; readonly receiptVersion:1; readonly taskReceiptId:string;
 readonly messages:readonly OutboundMessageDraft[];
}
export interface FoundationInboundResult {
  readonly receiptType: 'foundation_echo';
  readonly receiptVersion: 1;
  readonly messages: readonly OutboundMessageDraft[];
}

export interface InboundHandler {
  handle(input: HandleInboundInput): Promise<HandleInboundResult>;
}

export class FoundationInboundHandler implements InboundHandler {
  async handle(input: HandleInboundInput): Promise<HandleInboundResult> {
    let text: string | undefined;
    switch (input.payload.kind) {
      case 'text':
        text = `Получено сообщение №${input.sequence}.`;
        break;
      case 'voice':
        text = 'Голосовые сообщения пока недоступны. Поддержка появится на следующем этапе.';
        break;
      case 'button':
        text = 'Кнопка устарела или уже использована';
        break;
      case 'lifecycle':
        break;
    }

    return {
      receiptType: 'foundation_echo',
      receiptVersion: 1,
      messages: text === undefined ? [] : [{ version: 1, kind: 'text', text }],
    };
  }
}
