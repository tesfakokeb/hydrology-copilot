/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A restrained scientific palette. Deep slate for structure, a single
        // instrument blue for interactive elements, and semantic status
        // colours that carry meaning rather than decoration.
        ink: {
          50: '#f6f8fa', 100: '#eceff3', 200: '#d8dee6', 300: '#b6c1ce',
          400: '#8b9aad', 500: '#697a90', 600: '#526176', 700: '#414d5f',
          800: '#2f3947', 900: '#1c242f', 950: '#111820',
        },
        hydro: {
          50: '#eef7fd', 100: '#d5ebfa', 200: '#aed8f5', 300: '#79bdec',
          400: '#3d9de0', 500: '#1a80c7', 600: '#0f6fb8', 700: '#0d5488',
          800: '#0f4870', 900: '#123c5e', 950: '#0c2740',
        },
        signal: {
          normal: '#1a7f4b',
          watch: '#b7791f',
          warning: '#c2620b',
          critical: '#b3261e',
          unknown: '#6b7280',
        },
      },
      fontFamily: {
        sans: ['"Inter var"', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(17, 24, 32, 0.05), 0 1px 3px rgba(17, 24, 32, 0.06)',
        panel: '0 4px 16px rgba(17, 24, 32, 0.08)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shimmer: { '0%': { backgroundPosition: '-800px 0' }, '100%': { backgroundPosition: '800px 0' } },
      },
      animation: {
        // Deliberately minimal: §37 asks for no excessive animation.
        'fade-in': 'fade-in 140ms ease-out',
        shimmer: 'shimmer 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};
