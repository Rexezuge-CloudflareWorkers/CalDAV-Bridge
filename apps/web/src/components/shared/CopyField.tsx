import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Label } from '../ui/Input';
import { cn } from '../../lib/utils';
import { COPY_FEEDBACK_TIMEOUT_MS } from '../../lib/constants';

export function CopyField({ label, value }: { label: string; value?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
  };

  return (
    <div>
      <Label className="mb-1.5">{label}</Label>
      <div className="flex">
        <input
          readOnly
          value={value ?? ''}
          placeholder="Not Available Yet"
          className="min-w-0 px-3 py-2 bg-[var(--color-surface-base)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-sm flex-1 rounded-l-lg border-r-0"
        />
        <button
          type="button"
          onClick={handleCopy}
          disabled={!value}
          className={cn(
            'px-3 py-2 rounded-r-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150 disabled:opacity-50',
          )}
          title="Copy To Clipboard"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
