import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/* A panel on a trigger, for the cases a menu cannot take: a menu owns the
   keyboard (arrow keys move the highlight, letters run a typeahead), so a text
   field inside one fights it for every keystroke. Everything else is the
   dropdown's look, on purpose.

   `hideWhenDetached` is on unless a caller says otherwise. Most pages stay
   mounted while another tab is showing, hidden with `display: none`, and a
   panel whose trigger is hidden is placed against a box of no size at the
   window's top-left corner: that is where the Templates grid panel was drawn
   over the sidebar after its gear opened Settings. Closing the panel is not
   enough on its own, because it fades out for 100ms and spends the fade in that
   corner. Measured on 2026-09-13 with real clicks in Edge, recording every
   frame: closed on the same click, 5 frames in the corner; with this, none. */

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  hideWhenDetached = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        hideWhenDetached={hideWhenDetached}
        className={cn(
          "relative z-50 max-h-(--radix-popover-content-available-height) w-72 origin-(--radix-popover-content-transform-origin) overflow-y-auto rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
