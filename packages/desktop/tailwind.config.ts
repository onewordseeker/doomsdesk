import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/src/**/*.{ts,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#6366F1', hover: '#4F46E5', light: '#818CF8' },
        surface: {
          DEFAULT: '#1A1F2E',
          elevated: '#232838',
          border: '#2D3748',
        },
        bg: { DEFAULT: '#0F1117', secondary: '#131720' },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}

export default config
