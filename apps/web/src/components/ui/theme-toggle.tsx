import { MoonStar, SunMedium } from 'lucide-react';
import { Button } from './button';
import { useTheme } from '../../contexts/ThemeContext';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={toggleTheme}
      aria-label={isDark ? 'Activer le mode clair' : 'Activer le mode sombre'}
      title={isDark ? 'Activer le mode clair' : 'Activer le mode sombre'}
    >
      {isDark ? <SunMedium className="h-4 w-4" /> : <MoonStar className="h-4 w-4" />}
      {isDark ? 'Mode clair' : 'Mode sombre'}
    </Button>
  );
}
