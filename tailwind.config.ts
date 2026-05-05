import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

/**
 * Tailwind v3 config for the renderer.
 *
 * Phase 5 PR4 introduced Tailwind + shadcn/ui to replace the 971-line
 * hand-written `index.css`. The token system follows shadcn/ui's HSL CSS
 * variable convention so the same `<Button>` / `<Card>` / etc. primitives
 * we copy in from `https://ui.shadcn.com` work without modification.
 *
 * `darkMode: ['class']` is wired even though the app currently runs dark
 * only — the dark palette lives on `:root` in `index.css` and the `.dark`
 * class is reserved as a future-proof toggle hook (see ADR-0015).
 *
 * `content` only globs the renderer subtree because the main / preload /
 * core processes are headless Node and never emit class names; including
 * them would slow the JIT pass for zero benefit.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        warning: 'hsl(var(--warning))'
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)'
      },
      fontFamily: {
        sans: [
          'Inter',
          'SF Pro Display',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace']
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' }
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        }
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'fade-in': 'fade-in 300ms ease forwards',
        'slide-up': 'slide-up 400ms cubic-bezier(0.16, 1, 0.3, 1) forwards'
      }
    }
  },
  plugins: [animate]
}

export default config
