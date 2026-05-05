/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JSX } from 'react'

import { ErrorBoundary } from './ErrorBoundary'
import { setLocale } from '../i18n'

vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }))
vi.mock('../index.css', () => ({}))

beforeAll(() => {
  setLocale('en')
})

afterAll(() => {
  setLocale('zh')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Boom(): JSX.Element {
  throw new Error('kaboom: synthetic test error')
}

function Ok(): JSX.Element {
  return <span>Healthy child</span>
}

describe('ErrorBoundary', () => {
  it('renders children unchanged when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <Ok />
      </ErrorBoundary>
    )
    expect(screen.getByText('Healthy child')).toBeInTheDocument()
  })

  it('catches a thrown error and renders the fallback UI with the message', () => {
    // React 18 still logs the captured error to console.error in development;
    // silence it to keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )

    expect(screen.getByText('Renderer crashed')).toBeInTheDocument()
    // The pre-formatted error block should contain the original message.
    expect(screen.getByRole('alert').textContent).toContain('kaboom: synthetic test error')
    // Both action buttons render.
    expect(screen.getByRole('button', { name: 'Copy error' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('renders an actionable Copy button that does not throw when clicked', async () => {
    // jsdom's `navigator.clipboard` lives on a non-configurable Navigator
    // prototype getter and `document.execCommand('copy')` is not actually
    // implemented, so we don't try to assert the *content* of the clipboard
    // here — only that clicking Copy does not bubble an exception out of the
    // boundary (which would be a regression worth catching).
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )

    const copyBtn = screen.getByRole('button', { name: 'Copy error' })
    await expect(user.click(copyBtn)).resolves.not.toThrow()

    // Boundary should still be visible (not unmounted by an exception).
    expect(screen.getByText('Renderer crashed')).toBeInTheDocument()
  })
})
