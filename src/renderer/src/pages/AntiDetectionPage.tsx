import { JSX } from 'react'
import { useNavigate } from 'react-router-dom'
import { AntiDetectionSettings } from '../components/AntiDetectionSettings'
import { useToastStore } from '../stores/toast'

/**
 * `/anti-detection` route. Wraps the existing settings panel and forwards
 * its toast + navigation callbacks. The `view diagnostics` affordance on
 * the breaker banner now uses `useNavigate()` to push `/diagnostics` rather
 * than mutating a `<View>` enum in App.tsx.
 */
export function AntiDetectionPage(): JSX.Element {
  const navigate = useNavigate()
  const push = useToastStore((s) => s.push)
  return (
    <AntiDetectionSettings
      onToast={push}
      onNavigateDiagnostics={(): void => {
        void navigate('/diagnostics')
      }}
    />
  )
}
