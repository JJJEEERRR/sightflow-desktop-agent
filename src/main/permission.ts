import { systemPreferences, desktopCapturer } from 'electron'
import { getLogger } from '../core/observability'

const log = getLogger('permission')

export async function checkAndRequestPermissions(): Promise<void> {
  if (process.platform !== 'darwin') {
    return
  }

  try {
    const isAccessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false)
    if (!isAccessibilityGranted) {
      log.warn('Accessibility permission not granted, requesting…')
      // Passing `true` opens the macOS system prompt.
      systemPreferences.isTrustedAccessibilityClient(true)
    } else {
      log.info('Accessibility permission already granted')
    }

    const screenStatus = systemPreferences.getMediaAccessStatus('screen')
    if (screenStatus !== 'granted') {
      log.warn('Screen recording permission missing, triggering request', { status: screenStatus })
      try {
        // Race against a 5s timeout — some macOS versions deadlock the
        // permission API in obscure UI states.
        await Promise.race([
          desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('请求屏幕录制权限触发超时')), 5000)
          )
        ])
        log.info('Screen-recording permission request triggered')
      } catch (error) {
        log.warn('Screen-recording permission request failed or timed out', { err: error })
      }
    } else {
      log.info('Screen recording permission already granted')
    }
  } catch (error) {
    log.error('Permission check/request unexpected error', { err: error })
  }
}
