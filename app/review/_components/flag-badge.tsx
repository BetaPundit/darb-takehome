'use client';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * A short label with the plain-language explanation in a tooltip. The explanation is also in the DOM as visually
 * hidden text, and the badge is focusable, so it does not depend on hovering with a mouse.
 */
export function FlagBadge({ label, explanation }: { label: string; explanation: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" tabIndex={0} className="h-auto cursor-help whitespace-normal" />}>
        {label}
        <span className="sr-only">: {explanation}</span>
      </TooltipTrigger>
      <TooltipContent>{explanation}</TooltipContent>
    </Tooltip>
  );
}
