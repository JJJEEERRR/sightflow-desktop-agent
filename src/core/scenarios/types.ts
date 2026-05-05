// src/core/scenarios/types.ts
// Phase 4 — Scenario abstraction.
//
// Engine is scenario-agnostic; it owns the lifecycle / brain / policy / OCR
// loop. Everything app-specific (how to take a screenshot in *this* app,
// how to drive a "send a reply" decision against *this* app's UI, how to
// wait for the next chat) lives behind the Scenario interface so the
// project can grow to 飞书 / 钉钉 / Slack by adding new implementers
// without touching engine.ts.

import type { BrainDecision } from '../brain'
import type { AntiDetectionPolicy } from '../policy'
import type { AgentHooks } from '../hooks'
import type { AppType } from '../rpa/types'

/**
 * Scenario — the swappable per-app orchestration boundary. Implementers map
 * the engine's app-agnostic perception/action vocabulary onto the concrete
 * UI of a single chat application.
 */
export interface Scenario {
  /**
   * One-shot bring-up. Called from `Engine.start()` before the main loop. A
   * non-success result causes the engine to crash without entering the
   * loop. Return `{ success: false, error }` with a human-readable error.
   */
  measureLayout(): Promise<{ success: boolean; error?: string }>

  /**
   * Capture a screenshot for the brain to decide on. Returns whatever
   * shape the brain expects (today: a `data:image/png;base64,...` URL).
   * Errors propagate — the engine will catch and route to crash/retry.
   */
  screenshot(): Promise<string>

  /**
   * Establish a baseline so the scenario can later detect "did the chat
   * area change" — i.e. did a new message arrive in the currently-open
   * chat. Called by Engine after a reply is sent. Must succeed silently
   * even when there's no chat area to baseline (just no-op + return).
   */
  setChatBaseline(): Promise<void>

  /**
   * Drop the chat-area baseline. Called when switching chats and on
   * `Engine.stop()`.
   */
  clearChatBaseline(): void

  /**
   * Execute a single brain decision against the app. Today the only
   * non-trivial branch is `decision.type === 'reply'` (send the text);
   * `skip` is a no-op. The scenario is responsible for routing
   * Humanizer pre/post delays and breaker observation through the action
   * via the supplied `helpers.policy?.beforeAction` / `afterAction` calls.
   */
  execute(decision: BrainDecision, helpers: ScenarioHelpers): Promise<void>

  /**
   * Wait until there's a next chat to process — i.e. either:
   *   - an unread message appeared somewhere in the contact list, OR
   *   - the currently-open chat received a new message.
   *
   * Engine immediately re-enters `processCurrentChat()` once this returns.
   * If `running()` flips to false, this MUST exit promptly. Implementations
   * SHOULD honour `helpers.policy?.beforeAction` / `afterAction` for
   * polling clicks (red dot, contact selection) so the Humanizer's pacing
   * and the breaker's RPA-success observation kick in.
   */
  waitForNextChat(running: () => boolean, helpers: ScenarioHelpers): Promise<void>

  /**
   * Optional hot-swap of target app type (e.g. `weixin` → `wework`). Engine
   * calls this from its `setAppType` IPC handler. Optional because not
   * every scenario will care; `WechatScenario` forwards to
   * `device.setAppType`.
   */
  setAppType?(appType: AppType): void

  /**
   * Optional cleanup at `Engine.stop()`. Defensive — must be no-throw.
   */
  dispose?(): Promise<void>
}

/**
 * Plumbing the engine passes to every scenario call so the scenario can
 * emit logs, sleep, and route actions through the policy without holding
 * direct references to engine internals.
 */
export interface ScenarioHelpers {
  emitLog: (type: 'thinking' | 'reply' | 'skip' | 'error', content: string) => void
  /** Plain sleep (not cancellable). Use sparingly; prefer policy-driven delays. */
  sleep: (ms: number) => Promise<void>
  /** AntiDetectionPolicy if the engine has one; undefined for tests / when disabled. */
  policy?: AntiDetectionPolicy
  /** Lifecycle callbacks (onActionComplete / onError). Always defined; fields are optional. */
  hooks: AgentHooks
}
