// BI-C1: the ONLY module that imports the real Claude Agent SDK. Everything
// else in the sessions feature talks to the injected `SessionSdk` interface
// (runner.ts), so the runner and routes are driven by a fake in tests — no
// network, no real repos. If the SDK's `canUseTool` / message shapes drift,
// this thin adapter is the only place that needs fixing.
import {
  query,
  type EffortLevel,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SessionPermissionResult,
  SessionSdk,
  SessionSdkMessage,
  SessionSdkQuery,
  SessionUserMessage,
} from './runner.js';

async function* toSdkPrompt(prompt: AsyncIterable<SessionUserMessage>): AsyncGenerator<SDKUserMessage> {
  for await (const msg of prompt) {
    yield { type: 'user', message: msg.message, parent_tool_use_id: null } as SDKUserMessage;
  }
}

export function createRealSdk(): SessionSdk {
  return ({ prompt, options }) => {
    const q = query({
      prompt: typeof prompt === 'string' ? prompt : toSdkPrompt(prompt),
      options: {
        cwd: options.cwd,
        canUseTool: async (toolName, input, opts): Promise<PermissionResult> => {
          const decision = await options.canUseTool(toolName, input, {
            requestId: opts.requestId,
            toolUseID: opts.toolUseID,
            signal: opts.signal,
          });
          return toPermissionResult(decision);
        },
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort as EffortLevel } : {}),
        ...(options.permissionMode !== undefined
          ? { permissionMode: options.permissionMode as 'default' | 'acceptEdits' }
          : {}),
        ...(options.abortController !== undefined ? { abortController: options.abortController } : {}),
      },
    });

    const adapted: SessionSdkQuery = {
      setPermissionMode(mode: string): Promise<void> {
        return q.setPermissionMode(mode as 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions');
      },
      setModel(model?: string): Promise<void> {
        return q.setModel(model);
      },
      interrupt(): Promise<unknown> {
        return q.interrupt();
      },
      async *[Symbol.asyncIterator](): AsyncIterator<SessionSdkMessage> {
        for await (const message of q) {
          yield toSessionMessage(message);
        }
      },
    };
    return adapted;
  };
}

function toPermissionResult(decision: SessionPermissionResult): PermissionResult {
  if (decision.behavior === 'allow') {
    return {
      behavior: 'allow',
      ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
    };
  }
  return { behavior: 'deny', message: decision.message ?? 'denied' };
}

function toSessionMessage(message: SDKMessage): SessionSdkMessage {
  if (message.type === 'assistant') {
    const content = message.message.content
      .map((block) => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input, id: block.id };
        return { type: block.type };
      });
    return { type: 'assistant', message: { content } };
  }
  if (message.type === 'result') {
    return {
      type: 'result',
      subtype: message.subtype,
      is_error: message.is_error,
      ...('result' in message && typeof message.result === 'string' ? { result: message.result } : {}),
    };
  }
  return { type: message.type };
}
