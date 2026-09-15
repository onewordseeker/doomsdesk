import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Dark theme
        'dark-bg': '#0F1117',
        'dark-surface': '#1A1F2E',
        'dark-border': '#2D3748',
        'dark-text': '#E2E8F0',
        'dark-muted': '#718096',
        // Light theme
        'light-bg': '#F8FAFC',
        'light-surface': '#FFFFFF',
        'light-border': '#E2E8F0',
        'light-text': '#1A202C',
        'light-muted': '#718096',
        // Accents
        accent: '#6366F1',
        'accent-hover': '#4F46E5',
        'accent-light': '#818CF8',
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-in': 'slideIn 0.25s ease-out',
        'pulse-dot': 'pulseDot 2s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      boxShadow: {
        'card-dark': '0 1px 3px rgba(0,0,0,0.4), 0 1px 2px rgba(0,0,0,0.3)',
        'card-light': '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
        glow: '0 0 20px rgba(99,102,241,0.25)',
      },
    },
  },
  plugins: [],
};

export default config;
