import defaultTheme from 'tailwindcss/defaultTheme';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        'background-elevated': 'hsl(var(--background-elevated))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        'card-muted': 'hsl(var(--card-muted))',
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar))',
          foreground: 'hsl(var(--sidebar-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          border: 'hsl(var(--sidebar-border))',
        },
      },
      fontFamily: {
        sans: ['Montserrat', ...defaultTheme.fontFamily.sans],
        display: ['League Spartan', 'Montserrat', ...defaultTheme.fontFamily.sans],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        soft: '0 20px 45px -28px rgba(5, 10, 28, 0.65)',
        brand: '0 28px 60px -30px rgba(2, 185, 253, 0.34)',
        glow: '0 0 0 1px rgba(255, 255, 255, 0.04), 0 22px 60px -28px rgba(131, 45, 254, 0.42)',
      },
      backgroundImage: {
        'brand-gradient':
          'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--secondary)) 52%, hsl(var(--accent)) 100%)',
        'brand-gradient-soft':
          'linear-gradient(135deg, hsl(var(--primary) / 0.12) 0%, hsl(var(--secondary) / 0.14) 50%, hsl(var(--accent) / 0.16) 100%)',
        'sidebar-gradient':
          'linear-gradient(180deg, hsl(var(--sidebar)) 0%, hsl(var(--sidebar-accent)) 100%)',
      },
    },
  },
  plugins: [],
};
