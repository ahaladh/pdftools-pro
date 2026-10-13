import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        secondary: 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50',
        ghost: 'text-slate-700 hover:bg-slate-100',
        danger: 'text-red-600 hover:bg-red-50',
      },
      size: { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...p }, ref) => (
  <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...p} />
));
Button.displayName = 'Button';
export const buttonClass = ({ className, ...o }: VariantProps<typeof button> & { className?: string } = {}) => cn(button(o), className);
