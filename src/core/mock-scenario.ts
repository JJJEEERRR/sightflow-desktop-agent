// src/core/mock-scenario.ts
// MockScenario — test fixture wrapping a `DesktopDevice` (typically
// `MockDevice`) with the production `WechatScenario` semantics.
//
// Existing engine tests used to construct an Engine with a MockDevice
// directly. Post-Phase-4 the Engine takes a `Scenario`; tests now pass
// `new MockScenario(device)`. The behaviour is identical to
// `WechatScenario` so we don't bifurcate test coverage — `WechatScenario`
// has its own dedicated unit tests under `src/core/scenarios/wechat/`.

import { WechatScenario } from './scenarios/wechat/scenario'

/**
 * Test-only re-export of `WechatScenario`. Defined as a named subclass
 * (not a re-export alias) so test imports clearly read "this is a test
 * scenario, not a production wechat one" — even though the runtime
 * behaviour is identical by design.
 */
export class MockScenario extends WechatScenario {}
