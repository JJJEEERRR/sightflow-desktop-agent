/**
 * Minimal subset of the `@hurdlegroup/robotjs` API surface that this project
 * actually uses. The real types ship as `@types/robotjs` for the upstream
 * `robotjs`, but `@hurdlegroup/robotjs` is a fork with no dedicated typings,
 * so we declare only what we need here. Add methods to this interface as new
 * call sites appear (TypeScript will tell you which ones are missing).
 */
export type MouseButton = 'left' | 'right' | 'middle'
export type MouseState = 'down' | 'up'
export type KeyboardModifier = 'control' | 'command' | 'alt' | 'shift'
export type KeyState = 'down' | 'up'

export interface Robot {
  getMousePos(): { x: number; y: number }
  moveMouse(x: number, y: number): void
  mouseClick(button?: MouseButton, double?: boolean): void
  mouseToggle(state: MouseState, button?: MouseButton): void
  keyTap(key: string, modifiers?: KeyboardModifier | KeyboardModifier[]): void
  keyToggle(key: string, state: KeyState, modifiers?: KeyboardModifier | KeyboardModifier[]): void
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const randomDelay = (ms: number): Promise<void> => delay(ms + Math.random() * 20 - 10)

export const randomDelayIn = (min: number, max: number): Promise<void> =>
  delay(min + Math.random() * (max - min))

export function getRobot(): Robot | null {
  try {
    // We use runtime require to prevent Vite/Webpack from attempting to eagerly bundle
    // native C++ add-ons which can cause build failures or crash the main process on load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@hurdlegroup/robotjs') as Robot
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Failed to load @hurdlegroup/robotjs. Core RPA functions will not work.', message)
    return null
  }
}
